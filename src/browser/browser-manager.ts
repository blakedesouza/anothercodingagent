/**
 * Browser Manager — lazy Playwright lifecycle, crash recovery, session-scoped context.
 *
 * Responsibilities:
 * - Lazy initialization: first browser tool → launch Chromium headless
 * - Session-scoped BrowserContext: persists cookies/state across calls
 * - Single active page (v1)
 * - Crash recovery: restart once with 2s backoff → unavailable on second crash
 * - Process registry integration: PID, idle TTL (1h), hard max (4h)
 * - Security hardening: acceptDownloads: false, permissions: [], sandbox-first
 * - Health integration with CapabilityHealthMap
 *
 * Follows the same lazy lifecycle pattern as LspManager (M7.3).
 */

import type { Browser, BrowserContext, Page, LaunchOptions } from 'playwright-core';
import type { CapabilityHealthMap } from '../core/capability-health.js';
import type { NetworkPolicy } from '../permissions/network-policy.js';
import { evaluateBrowserNavigation } from '../permissions/network-policy.js';

// --- Constants ---

export const BROWSER_CAPABILITY_ID = 'browser';
const RESTART_BACKOFF_MS = 2_000;
const IDLE_TTL_MS = 60 * 60 * 1000;   // 1 hour
const HARD_MAX_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Hardened Chromium launch args per spec (Block 3). */
const HARDENED_ARGS = [
    '--disable-extensions',
    '--disable-plugins',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-gpu',
    '--disable-dev-shm-usage',
];

// --- Types ---

export type BrowserState = 'stopped' | 'starting' | 'ready' | 'crashed' | 'unavailable';

export interface BrowserManagerDeps {
    healthMap?: CapabilityHealthMap;
    /** Network policy for enforcing domain restrictions on ALL navigations (click, form submit, etc.). */
    networkPolicy?: NetworkPolicy;
    /** Override for testing — provides the chromium launcher. */
    launchFn?: (options: LaunchOptions) => Promise<Browser>;
    /** Override for testing — provide a custom clock. */
    nowFn?: () => number;
}

export interface BrowserSnapshot {
    /** Accessibility tree / structured text snapshot of the page. */
    content: string;
}

// --- Error types ---

export class BrowserUnavailableError extends Error {
    constructor(reason: string) {
        super(`Browser is unavailable: ${reason}`);
        this.name = 'BrowserUnavailableError';
    }
}

export class BrowserCrashedError extends Error {
    readonly restartable: boolean;
    constructor(restartable: boolean) {
        super(`Browser crashed${restartable ? ' — restarting' : ' — unavailable'}`);
        this.name = 'BrowserCrashedError';
        this.restartable = restartable;
    }
}

// --- Manager class ---

export class BrowserManager {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private _state: BrowserState = 'stopped';
    private crashCount = 0;
    private startTime = 0;
    private lastActivity = 0;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    private hardMaxTimer: ReturnType<typeof setTimeout> | null = null;
    private launchPromise: Promise<void> | null = null;

    private readonly healthMap?: CapabilityHealthMap;
    private readonly networkPolicy?: NetworkPolicy;
    private readonly launchFn?: (options: LaunchOptions) => Promise<Browser>;
    private readonly now: () => number;

    constructor(deps: BrowserManagerDeps = {}) {
        this.healthMap = deps.healthMap;
        this.networkPolicy = deps.networkPolicy;
        this.launchFn = deps.launchFn;
        this.now = deps.nowFn ?? Date.now;
    }

    get state(): BrowserState {
        return this._state;
    }

    get crashes(): number {
        return this.crashCount;
    }

    get pid(): number | undefined {
        // playwright-core's Browser type doesn't expose process() in its public types,
        // but it's available at runtime on launched browsers. Use type assertion.
        try {
            const b = this.browser as { process?: () => { pid?: number } | null } | null;
            const proc = b?.process?.();
            return proc?.pid ?? undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Ensure the browser is running and return the active page.
     * Lazily starts on first call. Reuses existing context across calls.
     */
    async ensurePage(): Promise<Page> {
        this.touchActivity();

        if (this._state === 'unavailable') {
            throw new BrowserUnavailableError('browser crashed twice this session');
        }

        if (this._state === 'ready' && this.page && !this.page.isClosed()) {
            return this.page;
        }

        // Need to start or restart
        if (this._state === 'crashed') {
            return this.handleCrashAndRetry();
        }

        // Synchronize concurrent callers: if launch is already in progress, wait for it
        if (this._state === 'starting' && this.launchPromise) {
            await this.launchPromise;
            return this.page!;
        }

        await this.launch();
        return this.page!;
    }

    /**
     * Close the current context and page. Next ensurePage() creates a fresh context.
     * Does NOT kill the browser process — just resets the context.
     */
    async closeContext(): Promise<void> {
        if (this.context) {
            try {
                await this.context.close();
            } catch { /* context may already be closed */ }
            this.context = null;
            this.page = null;
        }
    }

    /**
     * Fully shut down the browser process and clean up all resources.
     * Called on session end or idle/hard-max timeout.
     */
    async dispose(): Promise<void> {
        this.clearTimers();
        this._state = 'stopped';

        if (this.context) {
            try { await this.context.close(); } catch { /* ignore */ }
            this.context = null;
            this.page = null;
        }

        if (this.browser) {
            try { await this.browser.close(); } catch { /* ignore */ }
            this.browser = null;
        }
    }

    /** Touch activity timestamp — resets idle timer. */
    touchActivity(): void {
        this.lastActivity = this.now();
        this.resetIdleTimer();
    }

    /** Get time since last activity in ms. */
    getIdleTime(): number {
        return this.now() - this.lastActivity;
    }

    /** Get time since browser started in ms. */
    getUptime(): number {
        if (this.startTime === 0) return 0;
        return this.now() - this.startTime;
    }

    // --- Private implementation ---

    private async launch(): Promise<void> {
        if (this._state === 'starting' && this.launchPromise) return this.launchPromise;
        this._state = 'starting';

        // Register capability for health tracking
        this.healthMap?.register(BROWSER_CAPABILITY_ID, 'local');

        this.launchPromise = this.doLaunchSequence();
        try {
            await this.launchPromise;
        } finally {
            this.launchPromise = null;
        }
    }

    private async doLaunchSequence(): Promise<void> {

        try {
            this.browser = await this.doLaunch();
        } catch (err) {
            this._state = 'stopped';
            this.healthMap?.reportNonRetryableFailure(
                BROWSER_CAPABILITY_ID,
                `launch failed: ${(err as Error).message}`,
            );
            throw new BrowserUnavailableError(`launch failed: ${(err as Error).message}`);
        }

        // Set up crash handler
        this.browser.on('disconnected', () => {
            if (this._state === 'ready') {
                this._state = 'crashed';
            }
        });

        await this.createContext();

        this._state = 'ready';
        this.startTime = this.now();
        this.lastActivity = this.now();
        this.startTimers();

        this.healthMap?.reportSuccess(BROWSER_CAPABILITY_ID);
    }

    /**
     * Attempt to launch Chromium with sandbox first, fall back to --no-sandbox.
     */
    private async doLaunch(): Promise<Browser> {
        const launcher = this.launchFn ?? (await this.getDefaultLauncher());

        // Try sandbox-first
        try {
            return await launcher({
                headless: true,
                args: [...HARDENED_ARGS, '--sandbox'],
            });
        } catch {
            // Sandbox failed — fall back to --no-sandbox with warning
            console.warn(
                'Browser running without OS-level sandbox. ' +
                'Consider configuring user namespaces for stronger isolation.',
            );
            return await launcher({
                headless: true,
                args: [...HARDENED_ARGS, '--no-sandbox'],
            });
        }
    }

    private async getDefaultLauncher(): Promise<(options: LaunchOptions) => Promise<Browser>> {
        const { chromium } = await import('playwright-core');
        return (options) => chromium.launch(options);
    }

    private async createContext(): Promise<void> {
        if (!this.browser) throw new Error('Browser not launched');

        this.context = await this.browser.newContext({
            acceptDownloads: false,
            permissions: [],
        });

        // Enforce network policy on ALL outbound requests from the browser context.
        // This catches navigations, fetch/XHR, WebSocket upgrades, and subresource loads.
        if (this.networkPolicy) {
            const policy = this.networkPolicy;
            await this.context.route('**/*', async (route) => {
                const request = route.request();
                const result = evaluateBrowserNavigation(request.url(), policy);
                if (result.decision !== 'allow') {
                    await route.abort('blockedbyclient');
                    return;
                }
                await route.continue();
            });
        }

        // Single active page (v1)
        this.page = await this.context.newPage();

        // Handle popups — make new page the active one
        this.context.on('page', (newPage: Page) => {
            this.page = newPage;
        });
    }

    private async handleCrashAndRetry(): Promise<Page> {
        this.crashCount++;

        if (this.crashCount >= 2) {
            this._state = 'unavailable';
            this.healthMap?.reportRetryableFailure(
                BROWSER_CAPABILITY_ID,
                'second crash — unavailable',
            );
            this.clearTimers();
            throw new BrowserUnavailableError('browser crashed twice this session');
        }

        this.healthMap?.reportRetryableFailure(
            BROWSER_CAPABILITY_ID,
            'crash — restarting',
        );

        // Clean up old browser
        if (this.browser) {
            try { await this.browser.close(); } catch { /* ignore */ }
            this.browser = null;
        }
        this.context = null;
        this.page = null;
        this.clearTimers();

        // Backoff before restart
        await sleep(RESTART_BACKOFF_MS);

        // Attempt restart
        try {
            await this.launch();
            return this.page!;
        } catch (err) {
            this.crashCount = 2; // Force unavailable
            this._state = 'unavailable';
            throw new BrowserUnavailableError(`restart failed: ${(err as Error).message}`);
        }
    }

    private startTimers(): void {
        this.clearTimers();

        // Idle TTL
        this.idleTimer = setTimeout(async () => {
            await this.dispose();
        }, IDLE_TTL_MS);

        // Hard max lifetime
        this.hardMaxTimer = setTimeout(async () => {
            await this.dispose();
        }, HARD_MAX_MS);
    }

    private resetIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = setTimeout(async () => {
                await this.dispose();
            }, IDLE_TTL_MS);
        }
    }

    private clearTimers(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (this.hardMaxTimer) {
            clearTimeout(this.hardMaxTimer);
            this.hardMaxTimer = null;
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export { RESTART_BACKOFF_MS, IDLE_TTL_MS, HARD_MAX_MS, HARDENED_ARGS };
