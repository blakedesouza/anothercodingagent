/**
 * Browser automation tools (Block 3, M7.4).
 *
 * 10 tools: navigate, click, type, press, snapshot, screenshot,
 * evaluate, extract, wait, close.
 *
 * All tools share a single BrowserManager instance (session-scoped).
 * Lazy initialization: first tool call → launch Chromium headless.
 *
 * Approval class: external-effect (browser actions are not reversible).
 * capabilityId: 'browser' — masked when browser is unavailable.
 */

import { join, resolve, sep } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation } from '../tools/tool-registry.js';
import type { NetworkPolicy } from '../permissions/network-policy.js';
import { evaluateBrowserNavigation } from '../permissions/network-policy.js';
import {
    BrowserManager,
    BrowserUnavailableError,
    BROWSER_CAPABILITY_ID,
} from './browser-manager.js';

// --- Constants ---

const SCREENSHOT_DIR = 'screenshots';
const WAIT_DEFAULT_TIMEOUT_MS = 30_000;
const EXTRACT_MAX_CHARS = 8_000;

// --- Tool specs ---

const baseBrowserSpec = {
    approvalClass: 'external-effect' as const,
    idempotent: false,
    timeoutCategory: 'web' as const,
    capabilityId: BROWSER_CAPABILITY_ID,
};

export const browserNavigateSpec: ToolSpec = {
    ...baseBrowserSpec,
    name: 'browser_navigate',
    description: 'Navigate the browser to a URL. Waits for network idle.',
    inputSchema: {
        type: 'object',
        properties: {
            url: { type: 'string', minLength: 1 },
        },
        required: ['url'],
        additionalProperties: false,
    },
};

export const browserClickSpec: ToolSpec = {
    ...baseBrowserSpec,
    name: 'browser_click',
    description: 'Click an element on the page by CSS selector.',
    inputSchema: {
        type: 'object',
        properties: {
            selector: { type: 'string', minLength: 1 },
        },
        required: ['selector'],
        additionalProperties: false,
    },
};

export const browserTypeSpec: ToolSpec = {
    ...baseBrowserSpec,
    name: 'browser_type',
    description: 'Type text into an input element identified by CSS selector.',
    inputSchema: {
        type: 'object',
        properties: {
            selector: { type: 'string', minLength: 1 },
            text: { type: 'string' },
        },
        required: ['selector', 'text'],
        additionalProperties: false,
    },
};

export const browserPressSpec: ToolSpec = {
    ...baseBrowserSpec,
    name: 'browser_press',
    description: 'Press a keyboard key (e.g., Enter, Escape, Tab).',
    inputSchema: {
        type: 'object',
        properties: {
            key: { type: 'string', minLength: 1 },
        },
        required: ['key'],
        additionalProperties: false,
    },
};

export const browserSnapshotSpec: ToolSpec = {
    ...baseBrowserSpec,
    name: 'browser_snapshot',
    description: 'Get a compact accessibility tree / structured text snapshot of the current page. More useful for reasoning than a screenshot.',
    inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
    },
    idempotent: true,
};

export const browserScreenshotSpec: ToolSpec = {
    ...baseBrowserSpec,
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page and save as PNG.',
    inputSchema: {
        type: 'object',
        properties: {
            filename: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
    },
};

export const browserEvaluateSpec: ToolSpec = {
    ...baseBrowserSpec,
    name: 'browser_evaluate',
    description: 'Evaluate a JavaScript expression on the page and return the result.',
    inputSchema: {
        type: 'object',
        properties: {
            expression: { type: 'string', minLength: 1 },
        },
        required: ['expression'],
        additionalProperties: false,
    },
};

export const browserExtractSpec: ToolSpec = {
    ...baseBrowserSpec,
    name: 'browser_extract',
    description: 'Extract text content from elements matching a CSS selector.',
    inputSchema: {
        type: 'object',
        properties: {
            selector: { type: 'string', minLength: 1 },
        },
        required: ['selector'],
        additionalProperties: false,
    },
    idempotent: true,
};

export const browserWaitSpec: ToolSpec = {
    ...baseBrowserSpec,
    name: 'browser_wait',
    description: 'Wait for an element matching a CSS selector to appear on the page.',
    inputSchema: {
        type: 'object',
        properties: {
            selector: { type: 'string', minLength: 1 },
            timeout: { type: 'integer', minimum: 100, maximum: 60000 },
        },
        required: ['selector'],
        additionalProperties: false,
    },
};

export const browserCloseSpec: ToolSpec = {
    ...baseBrowserSpec,
    name: 'browser_close',
    description: 'Close the browser context. Next browser tool call creates a fresh context.',
    inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
    },
};

/** All browser tool specs for bulk registration. */
export const BROWSER_TOOL_SPECS: ToolSpec[] = [
    browserNavigateSpec,
    browserClickSpec,
    browserTypeSpec,
    browserPressSpec,
    browserSnapshotSpec,
    browserScreenshotSpec,
    browserEvaluateSpec,
    browserExtractSpec,
    browserWaitSpec,
    browserCloseSpec,
];

// --- Helpers ---

function successOutput(data: string, mutation: ToolOutput['mutationState'] = 'indeterminate'): ToolOutput {
    return {
        status: 'success',
        data,
        truncated: false,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: mutation,
    };
}

function readOnlyOutput(data: string): ToolOutput {
    return {
        status: 'success',
        data,
        truncated: false,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    };
}

function errorOutput(code: string, message: string, retryable = false): ToolOutput {
    return {
        status: 'error',
        data: '',
        error: { code, message, retryable },
        truncated: false,
        bytesReturned: 0,
        bytesOmitted: 0,
        retryable,
        timedOut: false,
        mutationState: 'none',
    };
}

// --- Dependencies interface ---

export interface BrowserToolsDeps {
    manager: BrowserManager;
    networkPolicy?: NetworkPolicy;
}

// --- Factory ---

/**
 * Create all browser tool implementations with injected dependencies.
 * Returns a map of tool name → implementation.
 */
export function createBrowserToolImpls(
    deps: BrowserToolsDeps,
): Map<string, ToolImplementation> {
    const { manager, networkPolicy } = deps;
    const impls = new Map<string, ToolImplementation>();

    // --- navigate ---
    impls.set('browser_navigate', async (args, _context) => {
        const url = args.url as string;

        // Network policy check before navigation
        if (networkPolicy) {
            const policyResult = evaluateBrowserNavigation(url, networkPolicy);
            if (policyResult.decision === 'deny') {
                return errorOutput('network_denied', `Navigation blocked: ${policyResult.reason}`);
            }
            if (policyResult.decision === 'confirm') {
                return errorOutput(
                    'network_confirm_required',
                    `Domain requires approval: ${policyResult.reason}`,
                    true,
                );
            }
        }

        try {
            const page = await manager.ensurePage();
            await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
            const title = await page.title();
            return successOutput(JSON.stringify({ url: page.url(), title }), 'network');
        } catch (err) {
            if (err instanceof BrowserUnavailableError) {
                return errorOutput('browser_unavailable', err.message);
            }
            return errorOutput('navigation_failed', (err as Error).message);
        }
    });

    // --- click ---
    impls.set('browser_click', async (args) => {
        const selector = args.selector as string;
        try {
            const page = await manager.ensurePage();
            await page.click(selector, { timeout: 10_000 });
            return successOutput(JSON.stringify({ clicked: selector }));
        } catch (err) {
            if (err instanceof BrowserUnavailableError) {
                return errorOutput('browser_unavailable', err.message);
            }
            return errorOutput('click_failed', (err as Error).message);
        }
    });

    // --- type ---
    impls.set('browser_type', async (args) => {
        const selector = args.selector as string;
        const text = args.text as string;
        try {
            const page = await manager.ensurePage();
            await page.fill(selector, text, { timeout: 10_000 });
            return successOutput(JSON.stringify({ filled: selector, chars: text.length }));
        } catch (err) {
            if (err instanceof BrowserUnavailableError) {
                return errorOutput('browser_unavailable', err.message);
            }
            return errorOutput('type_failed', (err as Error).message);
        }
    });

    // --- press ---
    impls.set('browser_press', async (args) => {
        const key = args.key as string;
        try {
            const page = await manager.ensurePage();
            await page.keyboard.press(key);
            return successOutput(JSON.stringify({ pressed: key }));
        } catch (err) {
            if (err instanceof BrowserUnavailableError) {
                return errorOutput('browser_unavailable', err.message);
            }
            return errorOutput('press_failed', (err as Error).message);
        }
    });

    // --- snapshot ---
    impls.set('browser_snapshot', async () => {
        try {
            const page = await manager.ensurePage();
            // Use aria snapshot for structured accessibility tree (Playwright 1.49+)
            const content = await page.locator('body').ariaSnapshot();
            return readOnlyOutput(content || '(empty accessibility tree)');
        } catch (err) {
            if (err instanceof BrowserUnavailableError) {
                return errorOutput('browser_unavailable', err.message);
            }
            return errorOutput('snapshot_failed', (err as Error).message);
        }
    });

    // --- screenshot ---
    impls.set('browser_screenshot', async (args, context) => {
        const filename = (args.filename as string | undefined) ?? `screenshot-${Date.now()}.png`;
        // Validate filename — no path traversal
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return errorOutput('invalid_filename', 'Filename must not contain path separators or ".."');
        }

        try {
            const page = await manager.ensurePage();
            const dir = join(context.workspaceRoot, SCREENSHOT_DIR);
            await mkdir(dir, { recursive: true });
            const filePath = join(dir, filename);

            // Defense-in-depth: path traversal guard
            const resolvedPath = resolve(filePath);
            const resolvedRoot = resolve(context.workspaceRoot);
            if (!resolvedPath.startsWith(resolvedRoot + sep)) {
                return errorOutput('path_traversal', 'Screenshot path outside workspace');
            }

            await page.screenshot({ path: filePath, fullPage: true });
            return successOutput(JSON.stringify({
                path: filePath,
                relativePath: `${SCREENSHOT_DIR}/${filename}`,
            }), 'filesystem');
        } catch (err) {
            if (err instanceof BrowserUnavailableError) {
                return errorOutput('browser_unavailable', err.message);
            }
            return errorOutput('screenshot_failed', (err as Error).message);
        }
    });

    // --- evaluate ---
    impls.set('browser_evaluate', async (args) => {
        const expression = args.expression as string;
        try {
            const page = await manager.ensurePage();
            const result = await page.evaluate(expression);
            const serialized = JSON.stringify(result);
            return readOnlyOutput(serialized);
        } catch (err) {
            if (err instanceof BrowserUnavailableError) {
                return errorOutput('browser_unavailable', err.message);
            }
            return errorOutput('evaluate_failed', (err as Error).message);
        }
    });

    // --- extract ---
    impls.set('browser_extract', async (args) => {
        const selector = args.selector as string;
        try {
            const page = await manager.ensurePage();
            const elements = await page.$$(selector);
            const texts: string[] = [];
            for (const el of elements) {
                const text = await el.textContent();
                if (text) texts.push(text.trim());
            }

            let content = texts.join('\n');
            let truncated = false;
            if (content.length > EXTRACT_MAX_CHARS) {
                // Truncate at paragraph boundary
                const cutPoint = content.lastIndexOf('\n', EXTRACT_MAX_CHARS);
                content = content.slice(0, cutPoint > 0 ? cutPoint : EXTRACT_MAX_CHARS);
                truncated = true;
            }

            return {
                status: 'success' as const,
                data: JSON.stringify({ elements: texts.length, content }),
                truncated,
                bytesReturned: Buffer.byteLength(content, 'utf8'),
                bytesOmitted: truncated ? texts.join('\n').length - content.length : 0,
                retryable: false,
                timedOut: false,
                mutationState: 'none' as const,
            };
        } catch (err) {
            if (err instanceof BrowserUnavailableError) {
                return errorOutput('browser_unavailable', err.message);
            }
            return errorOutput('extract_failed', (err as Error).message);
        }
    });

    // --- wait ---
    impls.set('browser_wait', async (args) => {
        const selector = args.selector as string;
        const timeout = (args.timeout as number | undefined) ?? WAIT_DEFAULT_TIMEOUT_MS;
        try {
            const page = await manager.ensurePage();
            await page.waitForSelector(selector, { timeout });
            return successOutput(JSON.stringify({ found: selector }));
        } catch (err) {
            if (err instanceof BrowserUnavailableError) {
                return errorOutput('browser_unavailable', err.message);
            }
            return errorOutput('wait_timeout', `Selector "${selector}" not found within ${timeout}ms`);
        }
    });

    // --- close ---
    impls.set('browser_close', async () => {
        try {
            await manager.closeContext();
            return successOutput(JSON.stringify({ closed: true }), 'process');
        } catch (err) {
            return errorOutput('close_failed', (err as Error).message);
        }
    });

    return impls;
}
