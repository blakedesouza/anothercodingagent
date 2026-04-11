import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Browser, BrowserContext, Page, LaunchOptions } from 'playwright-core';
import {
    BrowserManager,
    BrowserUnavailableError,
    BROWSER_CAPABILITY_ID,
    IDLE_TTL_MS,
    HARD_MAX_MS,
} from '../../src/browser/browser-manager.js';
import { CapabilityHealthMap } from '../../src/core/capability-health.js';

// --- Mock helpers ---

function createMockPage(overrides: Partial<Page> = {}): Page {
    return {
        goto: vi.fn().mockResolvedValue(null),
        title: vi.fn().mockResolvedValue('Test Page'),
        url: vi.fn().mockReturnValue('https://example.com'),
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        keyboard: { press: vi.fn().mockResolvedValue(undefined) },
        locator: vi.fn().mockReturnValue({
            ariaSnapshot: vi.fn().mockResolvedValue('- heading "Test"'),
        }),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
        evaluate: vi.fn().mockResolvedValue('result'),
        $$: vi.fn().mockResolvedValue([]),
        waitForSelector: vi.fn().mockResolvedValue(null),
        isClosed: vi.fn().mockReturnValue(false),
        close: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as Page;
}

function createMockContext(page: Page, overrides: Partial<BrowserContext> = {}): BrowserContext {
    const listeners = new Map<string, Function[]>();
    const routeHandlers: Array<{ pattern: string; handler: Function }> = [];
    return {
        newPage: vi.fn().mockResolvedValue(page),
        close: vi.fn().mockResolvedValue(undefined),
        route: vi.fn().mockImplementation((pattern: string, handler: Function) => {
            routeHandlers.push({ pattern, handler });
            return Promise.resolve();
        }),
        on: vi.fn().mockImplementation((event: string, handler: Function) => {
            const arr = listeners.get(event) ?? [];
            arr.push(handler);
            listeners.set(event, arr);
        }),
        _routeHandlers: routeHandlers,
        ...overrides,
    } as unknown as BrowserContext;
}

function createMockBrowser(context: BrowserContext): {
    browser: Browser;
    triggerDisconnect: () => void;
} {
    const listeners = new Map<string, Function[]>();
    const browser = {
        newContext: vi.fn().mockResolvedValue(context),
        close: vi.fn().mockResolvedValue(undefined),
        on: vi.fn().mockImplementation((event: string, handler: Function) => {
            const arr = listeners.get(event) ?? [];
            arr.push(handler);
            listeners.set(event, arr);
        }),
        process: vi.fn().mockReturnValue({ pid: 12345 }),
    } as unknown as Browser;

    const triggerDisconnect = () => {
        const handlers = listeners.get('disconnected') ?? [];
        handlers.forEach(h => h());
    };

    return { browser, triggerDisconnect };
}

// --- Tests ---

describe('BrowserManager', () => {
    let mockPage: Page;
    let mockContext: BrowserContext;
    let mockBrowser: Browser;
    let triggerDisconnect: () => void;
    let launchFn: ReturnType<typeof vi.fn>;
    let nowValue: number;
    let manager: BrowserManager;

    beforeEach(() => {
        vi.useFakeTimers();
        nowValue = 1000;
        mockPage = createMockPage();
        mockContext = createMockContext(mockPage);
        ({ browser: mockBrowser, triggerDisconnect } = createMockBrowser(mockContext));
        launchFn = vi.fn().mockResolvedValue(mockBrowser);
        manager = new BrowserManager({
            launchFn,
            nowFn: () => nowValue,
        });
    });

    afterEach(async () => {
        await manager.dispose();
        vi.useRealTimers();
    });

    describe('Lazy initialization', () => {
        it('does not launch browser until first ensurePage call', () => {
            expect(launchFn).not.toHaveBeenCalled();
            expect(manager.state).toBe('stopped');
        });

        it('launches Chromium on first ensurePage and returns a page', async () => {
            const page = await manager.ensurePage();
            expect(launchFn).toHaveBeenCalledTimes(1);
            expect(page).toBe(mockPage);
            expect(manager.state).toBe('ready');
        });

        it('reuses existing page on subsequent calls', async () => {
            const page1 = await manager.ensurePage();
            const page2 = await manager.ensurePage();
            expect(page1).toBe(page2);
            expect(launchFn).toHaveBeenCalledTimes(1);
        });
    });

    describe('Security hardening', () => {
        it('tries sandbox-first launch, then falls back to --no-sandbox', async () => {
            const sandboxFail = vi.fn()
                .mockRejectedValueOnce(new Error('sandbox failed'))
                .mockResolvedValueOnce(mockBrowser);

            const mgr = new BrowserManager({
                launchFn: sandboxFail,
                nowFn: () => nowValue,
            });

            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            await mgr.ensurePage();

            // First call with --sandbox, second with --no-sandbox
            expect(sandboxFail).toHaveBeenCalledTimes(2);
            const firstArgs = sandboxFail.mock.calls[0][0].args as string[];
            const secondArgs = sandboxFail.mock.calls[1][0].args as string[];
            expect(firstArgs).toContain('--sandbox');
            expect(secondArgs).toContain('--no-sandbox');
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('without OS-level sandbox'),
            );

            warnSpy.mockRestore();
            await mgr.dispose();
        });

        it('includes all hardened launch args', async () => {
            await manager.ensurePage();
            const launchOpts = launchFn.mock.calls[0][0] as LaunchOptions;
            const args = launchOpts.args ?? [];
            expect(args).toContain('--disable-extensions');
            expect(args).toContain('--disable-plugins');
            expect(args).toContain('--disable-background-networking');
            expect(args).toContain('--disable-sync');
            expect(args).toContain('--disable-gpu');
            expect(args).toContain('--disable-dev-shm-usage');
        });

        it('creates BrowserContext with acceptDownloads: false and permissions: []', async () => {
            await manager.ensurePage();
            expect(mockBrowser.newContext).toHaveBeenCalledWith({
                acceptDownloads: false,
                permissions: [],
            });
        });
    });

    describe('Session-scoped context', () => {
        it('persists context across multiple ensurePage calls', async () => {
            await manager.ensurePage();
            await manager.ensurePage();
            // newContext only called once
            expect(mockBrowser.newContext).toHaveBeenCalledTimes(1);
        });
    });

    describe('closeContext', () => {
        it('destroys context but allows fresh context on next ensurePage', async () => {
            await manager.ensurePage();
            await manager.closeContext();

            // Create fresh mocks for second context
            const newPage = createMockPage();
            const newCtx = createMockContext(newPage);
            (mockBrowser.newContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce(newCtx);

            const page = await manager.ensurePage();
            expect(page).toBe(newPage);
        });
    });

    describe('Crash recovery', () => {
        /** Helper: start ensurePage, advance fake timers past backoff, then await result. */
        async function ensurePageWithBackoff(mgr: BrowserManager): Promise<Page> {
            const promise = mgr.ensurePage();
            // Advance past the 2s restart backoff so the sleep() resolves
            await vi.advanceTimersByTimeAsync(3000);
            return promise;
        }

        it('restarts once on first crash with backoff', async () => {
            await manager.ensurePage();

            // Simulate crash
            triggerDisconnect();
            expect(manager.state).toBe('crashed');

            // Create fresh browser for restart
            const newPage = createMockPage();
            const newCtx = createMockContext(newPage);
            const { browser: newBrowser } = createMockBrowser(newCtx);
            launchFn.mockResolvedValueOnce(newBrowser);

            // ensurePage should trigger restart (needs timer advance for backoff)
            const page = await ensurePageWithBackoff(manager);
            expect(page).toBe(newPage);
            expect(manager.state).toBe('ready');
            expect(manager.crashes).toBe(1);
        });

        it('becomes unavailable on second crash', async () => {
            await manager.ensurePage();

            // First crash + restart
            triggerDisconnect();
            const newPage = createMockPage();
            const newCtx = createMockContext(newPage);
            const { browser: newBrowser, triggerDisconnect: trigger2 } = createMockBrowser(newCtx);
            launchFn.mockResolvedValueOnce(newBrowser);
            await ensurePageWithBackoff(manager); // restart succeeds

            // Second crash — rejects immediately (no backoff), so no timer advance needed
            trigger2();
            await expect(manager.ensurePage()).rejects.toThrow(BrowserUnavailableError);
            expect(manager.state).toBe('unavailable');
            expect(manager.crashes).toBe(2);
        });

        it('stays unavailable permanently after second crash', async () => {
            await manager.ensurePage();
            triggerDisconnect();

            const newPage = createMockPage();
            const newCtx = createMockContext(newPage);
            const { browser: newBrowser, triggerDisconnect: trigger2 } = createMockBrowser(newCtx);
            launchFn.mockResolvedValueOnce(newBrowser);
            await ensurePageWithBackoff(manager);

            // Second crash — immediate reject, no backoff
            trigger2();
            await expect(manager.ensurePage()).rejects.toThrow(BrowserUnavailableError);
            // Third attempt also fails immediately
            await expect(manager.ensurePage()).rejects.toThrow(BrowserUnavailableError);
        });
    });

    describe('Idle timeout', () => {
        it('disposes browser after idle TTL', async () => {
            await manager.ensurePage();
            expect(manager.state).toBe('ready');

            // Advance past idle TTL
            vi.advanceTimersByTime(IDLE_TTL_MS + 1);

            expect(manager.state).toBe('stopped');
        });
    });

    describe('Hard max lifetime', () => {
        it('disposes browser after hard max TTL', async () => {
            await manager.ensurePage();

            // Keep touching activity to prevent idle timeout
            for (let i = 0; i < 5; i++) {
                vi.advanceTimersByTime(IDLE_TTL_MS - 1000);
                manager.touchActivity();
            }

            // Now advance to hard max
            vi.advanceTimersByTime(HARD_MAX_MS);

            expect(manager.state).toBe('stopped');
        });
    });

    describe('Health integration', () => {
        it('registers capability and reports success on launch', async () => {
            const healthMap = new CapabilityHealthMap(() => nowValue);
            const mgr = new BrowserManager({
                launchFn,
                healthMap,
                nowFn: () => nowValue,
            });

            await mgr.ensurePage();

            expect(healthMap.getState(BROWSER_CAPABILITY_ID)).toBe('available');
            await mgr.dispose();
        });

        it('reports retryable failure on crash', async () => {
            const healthMap = new CapabilityHealthMap(() => nowValue);
            const mgr = new BrowserManager({
                launchFn,
                healthMap,
                nowFn: () => nowValue,
            });

            await mgr.ensurePage();
            triggerDisconnect();

            // Prepare restart
            const newPage = createMockPage();
            const newCtx = createMockContext(newPage);
            const { browser: newBrowser } = createMockBrowser(newCtx);
            launchFn.mockResolvedValueOnce(newBrowser);

            // Advance timers past backoff during ensurePage
            const p = mgr.ensurePage();
            await vi.advanceTimersByTimeAsync(3000);
            await p;
            // After restart, should be available again
            expect(healthMap.getState(BROWSER_CAPABILITY_ID)).toBe('available');
            await mgr.dispose();
        });

        it('reports non-retryable failure when launch fails', async () => {
            const healthMap = new CapabilityHealthMap(() => nowValue);
            const failLaunch = vi.fn().mockRejectedValue(new Error('no chromium'));
            const mgr = new BrowserManager({
                launchFn: failLaunch,
                healthMap,
                nowFn: () => nowValue,
            });

            await expect(mgr.ensurePage()).rejects.toThrow(BrowserUnavailableError);
            expect(healthMap.getState(BROWSER_CAPABILITY_ID)).toBe('unavailable');
            await mgr.dispose();
        });
    });

    describe('PID access', () => {
        it('returns undefined when not launched', () => {
            expect(manager.pid).toBeUndefined();
        });
    });

    describe('dispose', () => {
        it('cleans up browser and resets state', async () => {
            await manager.ensurePage();
            await manager.dispose();
            expect(manager.state).toBe('stopped');
            expect(mockBrowser.close).toHaveBeenCalled();
        });
    });

    describe('Launch synchronization (P1 fix)', () => {
        it('concurrent ensurePage calls share a single launch', async () => {
            // Both calls should resolve to the same page
            const [page1, page2] = await Promise.all([
                manager.ensurePage(),
                manager.ensurePage(),
            ]);
            expect(page1).toBe(page2);
            // Launch should only have been called once
            expect(launchFn).toHaveBeenCalledTimes(1);
        });
    });

    describe('Route interception (P0 fix)', () => {
        it('registers route handler when networkPolicy is provided', async () => {
            const mgr = new BrowserManager({
                launchFn,
                networkPolicy: { mode: 'open', allowDomains: [], denyDomains: ['evil.com'], allowHttp: false },
                nowFn: () => nowValue,
            });

            await mgr.ensurePage();

            // context.route should have been called
            expect(mockContext.route).toHaveBeenCalledWith('**/*', expect.any(Function));
            await mgr.dispose();
        });

        it('does not register route handler when no networkPolicy', async () => {
            await manager.ensurePage();
            // Default manager has no networkPolicy
            expect(mockContext.route).not.toHaveBeenCalled();
        });

        it('route handler aborts denied navigation requests', async () => {
            const mgr = new BrowserManager({
                launchFn,
                networkPolicy: { mode: 'off', allowDomains: [], denyDomains: [], allowHttp: false },
                nowFn: () => nowValue,
            });

            await mgr.ensurePage();

            // Get the route handler that was registered
            const routeCall = (mockContext.route as ReturnType<typeof vi.fn>).mock.calls[0];
            const routeHandler = routeCall[1] as Function;

            // Mock a navigation request
            const abortFn = vi.fn().mockResolvedValue(undefined);
            const continueFn = vi.fn().mockResolvedValue(undefined);
            const mockRoute = {
                request: () => ({
                    resourceType: () => 'document',
                    url: () => 'https://example.com',
                }),
                abort: abortFn,
                continue: continueFn,
            };

            await routeHandler(mockRoute);

            // Should abort (mode: off blocks all)
            expect(abortFn).toHaveBeenCalledWith('blockedbyclient');
            expect(continueFn).not.toHaveBeenCalled();
            await mgr.dispose();
        });

        it('route handler blocks non-document requests when policy denies', async () => {
            const mgr = new BrowserManager({
                launchFn,
                networkPolicy: { mode: 'off', allowDomains: [], denyDomains: [], allowHttp: false },
                nowFn: () => nowValue,
            });

            await mgr.ensurePage();

            const routeCall = (mockContext.route as ReturnType<typeof vi.fn>).mock.calls[0];
            const routeHandler = routeCall[1] as Function;

            const abortFn = vi.fn().mockResolvedValue(undefined);
            const continueFn = vi.fn().mockResolvedValue(undefined);
            const mockRoute = {
                request: () => ({
                    resourceType: () => 'image', // non-document resource
                    url: () => 'https://example.com/img.png',
                }),
                abort: abortFn,
                continue: continueFn,
            };

            await routeHandler(mockRoute);

            // Should abort — policy enforced on ALL resource types (P0 fix: prevents
            // fetch/XHR/WebSocket bypass of network policy)
            expect(abortFn).toHaveBeenCalledWith('blockedbyclient');
            expect(continueFn).not.toHaveBeenCalled();
            await mgr.dispose();
        });

        it('route handler aborts requests that require confirmation', async () => {
            const mgr = new BrowserManager({
                launchFn,
                networkPolicy: { mode: 'approved-only', allowDomains: [], denyDomains: [], allowHttp: false },
                nowFn: () => nowValue,
            });

            await mgr.ensurePage();

            const routeCall = (mockContext.route as ReturnType<typeof vi.fn>).mock.calls[0];
            const routeHandler = routeCall[1] as Function;

            const abortFn = vi.fn().mockResolvedValue(undefined);
            const continueFn = vi.fn().mockResolvedValue(undefined);
            const mockRoute = {
                request: () => ({
                    resourceType: () => 'xhr',
                    url: () => 'https://unapproved.example/api',
                }),
                abort: abortFn,
                continue: continueFn,
            };

            await routeHandler(mockRoute);

            expect(abortFn).toHaveBeenCalledWith('blockedbyclient');
            expect(continueFn).not.toHaveBeenCalled();
            await mgr.dispose();
        });
    });
});
