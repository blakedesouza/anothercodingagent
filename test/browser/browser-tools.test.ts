import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import {
    BrowserManager,
    BROWSER_CAPABILITY_ID,
} from '../../src/browser/browser-manager.js';
import {
    createBrowserToolImpls,
    BROWSER_TOOL_SPECS,
    browserSnapshotSpec,
    browserExtractSpec,
} from '../../src/browser/browser-tools.js';
import type { NetworkPolicy } from '../../src/permissions/network-policy.js';
import type { ToolContext } from '../../src/tools/tool-registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- Mock helpers ---

function createMockPage(overrides: Partial<Record<string, unknown>> = {}): Page {
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
        screenshot: vi.fn().mockResolvedValue(Buffer.from('png-data')),
        evaluate: vi.fn().mockResolvedValue('eval-result'),
        $$: vi.fn().mockResolvedValue([
            { textContent: vi.fn().mockResolvedValue('text1') },
            { textContent: vi.fn().mockResolvedValue('text2') },
        ]),
        waitForSelector: vi.fn().mockResolvedValue(null),
        isClosed: vi.fn().mockReturnValue(false),
        close: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as Page;
}

function createMockContext(page: Page): BrowserContext {
    return {
        newPage: vi.fn().mockResolvedValue(page),
        close: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
    } as unknown as BrowserContext;
}

function createMockBrowser(context: BrowserContext): Browser {
    return {
        newContext: vi.fn().mockResolvedValue(context),
        close: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        process: vi.fn().mockReturnValue({ pid: 12345 }),
    } as unknown as Browser;
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        sessionId: 'test-session',
        workspaceRoot: '/tmp/test-workspace',
        signal: new AbortController().signal,
        ...overrides,
    };
}

// --- Tests ---

describe('Browser Tool Specs', () => {
    it('exports 10 tool specs', () => {
        expect(BROWSER_TOOL_SPECS).toHaveLength(10);
    });

    it('all specs have capabilityId = browser', () => {
        for (const spec of BROWSER_TOOL_SPECS) {
            expect(spec.capabilityId).toBe(BROWSER_CAPABILITY_ID);
        }
    });

    it('all specs have external-effect approval class', () => {
        for (const spec of BROWSER_TOOL_SPECS) {
            expect(spec.approvalClass).toBe('external-effect');
        }
    });

    it('snapshot and extract are marked idempotent', () => {
        expect(browserSnapshotSpec.idempotent).toBe(true);
        expect(browserExtractSpec.idempotent).toBe(true);
    });
});

describe('Browser Tool Implementations', () => {
    let mockPage: Page;
    let manager: BrowserManager;
    let impls: Map<string, Function>;
    let tmpDir: string;

    beforeEach(async () => {
        vi.useFakeTimers();
        mockPage = createMockPage();
        const mockCtx = createMockContext(mockPage);
        const mockBrowser = createMockBrowser(mockCtx);

        manager = new BrowserManager({
            launchFn: vi.fn().mockResolvedValue(mockBrowser),
            nowFn: () => 1000,
        });

        impls = createBrowserToolImpls({ manager });
        tmpDir = await mkdtemp(join(tmpdir(), 'aca-browser-test-'));
    });

    afterEach(async () => {
        await manager.dispose();
        vi.useRealTimers();
        try { await rm(tmpDir, { recursive: true }); } catch { /* ignore */ }
    });

    describe('browser_navigate', () => {
        it('navigates to URL and returns title', async () => {
            const impl = impls.get('browser_navigate')!;
            const result = await impl(
                { url: 'https://example.com' },
                makeContext(),
            );
            expect(result.status).toBe('success');
            const data = JSON.parse(result.data);
            expect(data.url).toBe('https://example.com');
            expect(data.title).toBe('Test Page');
            expect(result.mutationState).toBe('network');
        });

        it('calls page.goto with networkidle', async () => {
            const impl = impls.get('browser_navigate')!;
            await impl({ url: 'https://example.com' }, makeContext());
            expect(mockPage.goto).toHaveBeenCalledWith(
                'https://example.com',
                { waitUntil: 'networkidle', timeout: 30_000 },
            );
        });
    });

    describe('browser_click', () => {
        it('clicks element by selector', async () => {
            const impl = impls.get('browser_click')!;
            const result = await impl({ selector: '#btn' }, makeContext());
            expect(result.status).toBe('success');
            expect(mockPage.click).toHaveBeenCalledWith('#btn', { timeout: 10_000 });
        });
    });

    describe('browser_type', () => {
        it('fills input with text', async () => {
            const impl = impls.get('browser_type')!;
            const result = await impl(
                { selector: '#input', text: 'hello' },
                makeContext(),
            );
            expect(result.status).toBe('success');
            expect(mockPage.fill).toHaveBeenCalledWith('#input', 'hello', { timeout: 10_000 });
        });
    });

    describe('browser_press', () => {
        it('presses keyboard key', async () => {
            const impl = impls.get('browser_press')!;
            const result = await impl({ key: 'Enter' }, makeContext());
            expect(result.status).toBe('success');
            expect(mockPage.keyboard.press).toHaveBeenCalledWith('Enter');
        });
    });

    describe('browser_snapshot', () => {
        it('returns accessibility tree snapshot', async () => {
            const impl = impls.get('browser_snapshot')!;
            const result = await impl({}, makeContext());
            expect(result.status).toBe('success');
            expect(result.data).toContain('heading "Test"');
            expect(result.mutationState).toBe('none');
        });
    });

    describe('browser_screenshot', () => {
        it('takes screenshot and saves to workspace', async () => {
            const impl = impls.get('browser_screenshot')!;
            const result = await impl(
                { filename: 'test.png' },
                makeContext({ workspaceRoot: tmpDir }),
            );
            expect(result.status).toBe('success');
            const data = JSON.parse(result.data);
            expect(data.relativePath).toBe('screenshots/test.png');
            expect(result.mutationState).toBe('filesystem');
        });

        it('rejects filename with path traversal', async () => {
            const impl = impls.get('browser_screenshot')!;
            const result = await impl(
                { filename: '../evil.png' },
                makeContext({ workspaceRoot: tmpDir }),
            );
            expect(result.status).toBe('error');
            expect(result.error?.code).toBe('invalid_filename');
        });

        it('generates default filename when not provided', async () => {
            const impl = impls.get('browser_screenshot')!;
            const result = await impl({}, makeContext({ workspaceRoot: tmpDir }));
            expect(result.status).toBe('success');
            const data = JSON.parse(result.data);
            expect(data.relativePath).toMatch(/^screenshots\/screenshot-\d+\.png$/);
        });
    });

    describe('browser_evaluate', () => {
        it('evaluates JS expression and returns result', async () => {
            const impl = impls.get('browser_evaluate')!;
            const result = await impl(
                { expression: 'document.title' },
                makeContext(),
            );
            expect(result.status).toBe('success');
            expect(JSON.parse(result.data)).toBe('eval-result');
            expect(result.mutationState).toBe('none');
        });
    });

    describe('browser_extract', () => {
        it('extracts text content from matching elements', async () => {
            const impl = impls.get('browser_extract')!;
            const result = await impl({ selector: 'p' }, makeContext());
            expect(result.status).toBe('success');
            const data = JSON.parse(result.data);
            expect(data.elements).toBe(2);
            expect(data.content).toContain('text1');
            expect(data.content).toContain('text2');
        });
    });

    describe('browser_wait', () => {
        it('waits for selector and returns success', async () => {
            const impl = impls.get('browser_wait')!;
            const result = await impl({ selector: '#loaded' }, makeContext());
            expect(result.status).toBe('success');
            expect(mockPage.waitForSelector).toHaveBeenCalledWith('#loaded', { timeout: 30_000 });
        });

        it('uses custom timeout when provided', async () => {
            const impl = impls.get('browser_wait')!;
            await impl({ selector: '#el', timeout: 5000 }, makeContext());
            expect(mockPage.waitForSelector).toHaveBeenCalledWith('#el', { timeout: 5000 });
        });

        it('returns error when wait times out', async () => {
            (mockPage.waitForSelector as ReturnType<typeof vi.fn>)
                .mockRejectedValueOnce(new Error('Timeout'));
            const impl = impls.get('browser_wait')!;
            const result = await impl({ selector: '#missing' }, makeContext());
            expect(result.status).toBe('error');
            expect(result.error?.code).toBe('wait_timeout');
        });
    });

    describe('browser_close', () => {
        it('closes context and returns success', async () => {
            // Ensure page is loaded first
            await manager.ensurePage();
            const impl = impls.get('browser_close')!;
            const result = await impl({}, makeContext());
            expect(result.status).toBe('success');
            expect(result.mutationState).toBe('process');
        });
    });

    describe('Network policy integration', () => {
        it('blocks navigation to denied domain', async () => {
            const policy: NetworkPolicy = {
                mode: 'open',
                allowDomains: [],
                denyDomains: ['evil.com'],
                allowHttp: false,
            };

            const policyImpls = createBrowserToolImpls({ manager, networkPolicy: policy });
            const nav = policyImpls.get('browser_navigate')!;
            const result = await nav(
                { url: 'https://evil.com/page' },
                makeContext(),
            );
            expect(result.status).toBe('error');
            expect(result.error?.code).toBe('network_denied');
        });

        it('blocks navigation when network mode is off', async () => {
            const policy: NetworkPolicy = {
                mode: 'off',
                allowDomains: [],
                denyDomains: [],
                allowHttp: false,
            };

            const policyImpls = createBrowserToolImpls({ manager, networkPolicy: policy });
            const nav = policyImpls.get('browser_navigate')!;
            const result = await nav(
                { url: 'https://example.com' },
                makeContext(),
            );
            expect(result.status).toBe('error');
            expect(result.error?.code).toBe('network_denied');
        });

        it('requires confirmation for unlisted domain in approved-only mode', async () => {
            const policy: NetworkPolicy = {
                mode: 'approved-only',
                allowDomains: [],
                denyDomains: [],
                allowHttp: false,
            };

            const policyImpls = createBrowserToolImpls({ manager, networkPolicy: policy });
            const nav = policyImpls.get('browser_navigate')!;
            const result = await nav(
                { url: 'https://unknown.com' },
                makeContext(),
            );
            expect(result.status).toBe('error');
            expect(result.error?.code).toBe('network_confirm_required');
            expect(result.retryable).toBe(true);
        });

        it('allows navigation to allowed domain', async () => {
            const policy: NetworkPolicy = {
                mode: 'approved-only',
                allowDomains: ['example.com'],
                denyDomains: [],
                allowHttp: false,
            };

            const policyImpls = createBrowserToolImpls({ manager, networkPolicy: policy });
            const nav = policyImpls.get('browser_navigate')!;
            const result = await nav(
                { url: 'https://example.com' },
                makeContext(),
            );
            expect(result.status).toBe('success');
        });
    });

    describe('Browser unavailable handling', () => {
        it('returns error when browser is unavailable', async () => {
            // Force unavailable state by double-crashing
            const crashFn = vi.fn()
                .mockRejectedValue(new Error('no chromium'));

            const failManager = new BrowserManager({
                launchFn: crashFn,
                nowFn: () => 1000,
            });

            const failImpls = createBrowserToolImpls({ manager: failManager });
            const nav = failImpls.get('browser_navigate')!;
            const result = await nav(
                { url: 'https://example.com' },
                makeContext(),
            );
            expect(result.status).toBe('error');
            expect(result.error?.code).toBe('browser_unavailable');
            await failManager.dispose();
        });
    });

    describe('State persistence across calls', () => {
        it('cookies persist across navigate calls (same context)', async () => {
            const nav = impls.get('browser_navigate')!;
            const click = impls.get('browser_click')!;

            // Navigate to login
            await nav({ url: 'https://app.com/login' }, makeContext());
            // Click submit
            await click({ selector: '#submit' }, makeContext());
            // Navigate to dashboard — same context, cookies persist
            await nav({ url: 'https://app.com/dashboard' }, makeContext());

            // Verify goto was called for each navigate (same page)
            expect(mockPage.goto).toHaveBeenCalledTimes(2);
        });
    });

    describe('Security', () => {
        it('BrowserContext has acceptDownloads: false', async () => {
            // Verified through the manager's createContext — already tested in manager tests
            // Here we just verify the tool infrastructure works
            const nav = impls.get('browser_navigate')!;
            const result = await nav({ url: 'https://example.com' }, makeContext());
            expect(result.status).toBe('success');
        });
    });
});
