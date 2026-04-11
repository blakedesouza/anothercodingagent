/**
 * fetch_url tool (Block 3, M7.5).
 *
 * Two-tier content extraction:
 * - Tier 1: HTTP fetch + jsdom (NO runScripts) + Readability → Markdown
 * - Tier 2: Playwright fallback for SPAs / JS-rendered content
 *
 * Security hardening:
 * - jsdom created WITHOUT runScripts (inline scripts NOT executed)
 * - 5 MB download size cap via Content-Length + streaming byte counter
 * - 30s request timeout
 * - 5 max redirects
 * - Tier 2 reuses M7.4 hardened BrowserContext
 * - Extracted content capped at 8K chars, truncated at paragraph boundary
 *
 * Approval class: external-effect (makes outbound HTTP requests).
 */

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import type { NetworkPolicy } from '../permissions/network-policy.js';
import { evaluateNetworkAccess } from '../permissions/network-policy.js';
import type { BrowserManager } from '../browser/browser-manager.js';
import { checkNetworkPolicy } from './web-search.js';

// --- Constants ---

const DOWNLOAD_SIZE_CAP = 5 * 1024 * 1024; // 5 MB
const EXTRACTED_CONTENT_CAP = 8_000;        // 8K chars
const REQUEST_TIMEOUT_MS = 30_000;          // 30s
const MAX_REDIRECTS = 5;
const TIER1_MIN_CONTENT_LENGTH = 100;       // Below this, try Tier 2

// --- Tool spec ---

export const fetchUrlSpec: ToolSpec = {
    name: 'fetch_url',
    description:
        'Fetch a URL and extract clean, readable content as Markdown. ' +
        'Uses lightweight HTTP extraction by default, falls back to browser rendering for JS-heavy pages.',
    inputSchema: {
        type: 'object',
        properties: {
            url: { type: 'string', minLength: 1 },
            tier: {
                type: 'string',
                enum: ['auto', 'lightweight', 'browser'],
                default: 'auto',
            },
        },
        required: ['url'],
        additionalProperties: false,
    },
    approvalClass: 'external-effect',
    idempotent: true,
    timeoutCategory: 'network',
};

// --- Result type ---

export interface FetchResult {
    url: string;
    title: string;
    content: string;
    excerpt: string;
    wordCount: number;
    estimatedTokens: number;
    tier: 'lightweight' | 'browser';
    truncated: boolean;
}

// --- Dependencies ---

export interface FetchUrlDeps {
    networkPolicy?: NetworkPolicy;
    browserManager?: BrowserManager;
    /** Override for testing — custom fetch function. */
    fetchFn?: typeof globalThis.fetch;
}

// --- Helpers ---

function successOutput(data: string, truncated: boolean): ToolOutput {
    return {
        status: 'success',
        data,
        truncated,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'network',
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

/**
 * Truncate content at a paragraph boundary near the cap.
 */
function truncateAtParagraph(content: string, cap: number): { text: string; truncated: boolean } {
    if (content.length <= cap) {
        return { text: content, truncated: false };
    }
    // Find the last double-newline (paragraph boundary) before the cap
    const cutPoint = content.lastIndexOf('\n\n', cap);
    if (cutPoint > cap * 0.5) {
        return { text: content.slice(0, cutPoint), truncated: true };
    }
    // Fall back to single newline
    const nlPoint = content.lastIndexOf('\n', cap);
    if (nlPoint > cap * 0.5) {
        return { text: content.slice(0, nlPoint), truncated: true };
    }
    // Hard cut
    return { text: content.slice(0, cap), truncated: true };
}

/**
 * Tier 1: HTTP fetch + jsdom + Readability → Markdown.
 * jsdom is created WITHOUT runScripts — inline scripts are NOT executed.
 */
async function tier1Fetch(
    url: string,
    fetchFn: typeof globalThis.fetch,
    networkPolicy?: NetworkPolicy,
): Promise<FetchResult | null> {
    // Fetch with timeout, size cap, redirect limit, and SSRF-safe redirect policy checks
    const { response: resp, finalUrl } = await fetchWithLimits(url, fetchFn, networkPolicy);

    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        // Non-HTML: return raw text if text-like
        if (contentType.includes('text/') || contentType.includes('application/json')) {
            const text = await resp.text();
            const { text: truncated, truncated: isTruncated } = truncateAtParagraph(text, EXTRACTED_CONTENT_CAP);
            return {
                url: finalUrl,
                title: '',
                content: truncated,
                excerpt: truncated.slice(0, 200),
                wordCount: truncated.split(/\s+/).length,
                estimatedTokens: Math.ceil(truncated.length / 4),
                tier: 'lightweight',
                truncated: isTruncated,
            };
        }
        return null; // Binary content — can't extract
    }

    const html = await resp.text();

    // jsdom WITHOUT runScripts — inline scripts are NOT executed (security hardening)
    const dom = new JSDOM(html, { url });
    try {
        const doc = dom.window.document;

        // Try Readability extraction
        const article = new Readability(doc).parse();
        if (!article || !article.textContent || article.textContent.trim().length < TIER1_MIN_CONTENT_LENGTH) {
            return null; // Extraction failed — signal Tier 2 fallback
        }

        // Convert article HTML to Markdown
        const markdown = NodeHtmlMarkdown.translate(article.content ?? '');
        const { text: content, truncated } = truncateAtParagraph(markdown, EXTRACTED_CONTENT_CAP);

        return {
            url: finalUrl,
            title: article.title ?? '',
            content,
            excerpt: article.excerpt ?? content.slice(0, 200),
            wordCount: content.split(/\s+/).length,
            estimatedTokens: Math.ceil(content.length / 4),
            tier: 'lightweight',
            truncated,
        };
    } finally {
        dom.window.close();
    }
}

/** Result from fetchWithLimits including the final URL after redirects. */
interface FetchWithLimitsResult {
    response: Response;
    /** The final URL after following all redirects. */
    finalUrl: string;
}

/**
 * HTTP fetch with size cap (5 MB), timeout (30s), and redirect limit (5).
 * Returns both the response body and the final URL (which may differ from
 * the input URL after redirects). The Response constructor does not preserve
 * the original URL, so we track it explicitly.
 */
async function fetchWithLimits(
    url: string,
    fetchFn: typeof globalThis.fetch,
    networkPolicy?: NetworkPolicy,
): Promise<FetchWithLimitsResult> {
    // Manual redirect following with network policy enforcement on each hop (SSRF protection).
    let currentUrl = url;
    let redirectCount = 0;

    while (true) {
        const resp = await fetchFn(currentUrl, {
            redirect: 'manual',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: {
                'User-Agent': 'ACA/1.0 (Another Coding Agent)',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        });

        // Check for redirect
        if (resp.status >= 300 && resp.status < 400) {
            const location = resp.headers.get('location');
            if (!location) {
                throw new Error(`Redirect ${resp.status} without Location header`);
            }
            redirectCount++;
            if (redirectCount > MAX_REDIRECTS) {
                throw new RedirectLimitError(redirectCount);
            }
            // Resolve relative URLs
            currentUrl = new URL(location, currentUrl).href;

            // SSRF protection: check network policy on each redirect target
            if (networkPolicy) {
                const result = await evaluateNetworkAccess(currentUrl, networkPolicy);
                if (result.decision === 'deny') {
                    throw new Error(`Redirect to ${currentUrl} blocked: ${result.reason}`);
                }
                if (result.decision === 'confirm') {
                    throw new Error(`Redirect to ${currentUrl} requires approval: ${result.reason}`);
                }
            }

            continue;
        }

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }

        // Check Content-Length before reading body
        const contentLength = resp.headers.get('content-length');
        if (contentLength) {
            const clBytes = parseInt(contentLength, 10);
            if (!Number.isNaN(clBytes) && clBytes > DOWNLOAD_SIZE_CAP) {
                throw new SizeCapError(clBytes, DOWNLOAD_SIZE_CAP);
            }
        }

        // Stream body with byte counter
        const reader = resp.body?.getReader();
        if (!reader) {
            throw new Error('Response body is not readable');
        }

        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalBytes += value.byteLength;
            if (totalBytes > DOWNLOAD_SIZE_CAP) {
                reader.cancel();
                throw new SizeCapError(totalBytes, DOWNLOAD_SIZE_CAP);
            }
            chunks.push(value);
        }

        // Reconstruct response with the read body.
        // Note: new Response() does not preserve the URL, so we return it separately.
        const body = new Blob(chunks as BlobPart[]);
        return {
            response: new Response(body, {
                status: resp.status,
                statusText: resp.statusText,
                headers: resp.headers,
            }),
            finalUrl: currentUrl,
        };
    }
}

/**
 * Tier 2: Playwright browser fallback for JS-rendered pages.
 * Reuses M7.4 hardened BrowserContext (acceptDownloads: false, permissions: []).
 */
async function tier2Fetch(
    url: string,
    browserManager: BrowserManager,
): Promise<FetchResult | null> {
    const page = await browserManager.ensurePage();

    await page.goto(url, { waitUntil: 'networkidle', timeout: REQUEST_TIMEOUT_MS });

    const html = await page.content();
    const title = await page.title();

    // Parse with jsdom (NO runScripts) + Readability
    const dom = new JSDOM(html, { url });
    try {
        const article = new Readability(dom.window.document).parse();

        if (!article || !article.textContent || article.textContent.trim().length < TIER1_MIN_CONTENT_LENGTH) {
            // Even browser rendering produced insufficient content
            // Fall back to raw text content
            const rawText = await page.evaluate(() => document.body.innerText);
            if (!rawText || rawText.trim().length < TIER1_MIN_CONTENT_LENGTH) {
                return null;
            }
            const { text: content, truncated } = truncateAtParagraph(rawText, EXTRACTED_CONTENT_CAP);
            return {
                url: page.url(),
                title,
                content,
                excerpt: content.slice(0, 200),
                wordCount: content.split(/\s+/).length,
                estimatedTokens: Math.ceil(content.length / 4),
                tier: 'browser',
                truncated,
            };
        }

        const markdown = NodeHtmlMarkdown.translate(article.content ?? '');
        const { text: content, truncated } = truncateAtParagraph(markdown, EXTRACTED_CONTENT_CAP);

        return {
            url: page.url(),
            title: article.title ?? '',
            content,
            excerpt: article.excerpt ?? content.slice(0, 200),
            wordCount: content.split(/\s+/).length,
            estimatedTokens: Math.ceil(content.length / 4),
            tier: 'browser',
            truncated,
        };
    } finally {
        dom.window.close();
    }
}

// --- Error types ---

export class SizeCapError extends Error {
    readonly actualBytes: number;
    readonly capBytes: number;
    constructor(actual: number, cap: number) {
        super(`Download size ${actual} bytes exceeds cap of ${cap} bytes`);
        this.name = 'SizeCapError';
        this.actualBytes = actual;
        this.capBytes = cap;
    }
}

export class RedirectLimitError extends Error {
    readonly redirectCount: number;
    constructor(count: number) {
        super(`Redirect chain exceeded limit of ${MAX_REDIRECTS} (followed ${count})`);
        this.name = 'RedirectLimitError';
        this.redirectCount = count;
    }
}

// --- Factory ---

export function createFetchUrlImpl(deps: FetchUrlDeps): ToolImplementation {
    const { networkPolicy, browserManager, fetchFn = globalThis.fetch } = deps;

    return async (args: Record<string, unknown>, _context: ToolContext): Promise<ToolOutput> => {
        const url = args.url as string;
        const tierPref = (args.tier as string | undefined) ?? 'auto';

        // Validate URL
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return errorOutput('invalid_url', `Invalid URL: ${url}`);
        }

        // Only allow http/https
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return errorOutput('invalid_protocol', `Protocol "${parsed.protocol}" is not supported. Use http: or https:.`);
        }

        // Network policy check
        const blocked = await checkNetworkPolicy(url, networkPolicy);
        if (blocked !== null) return blocked;

        // Tier 1: lightweight fetch
        if (tierPref === 'auto' || tierPref === 'lightweight') {
            try {
                const result = await tier1Fetch(url, fetchFn, networkPolicy);
                if (result) {
                    return successOutput(JSON.stringify(result), result.truncated);
                }
                // Tier 1 failed to extract — try Tier 2 if auto
                if (tierPref === 'lightweight') {
                    return errorOutput('extraction_failed', 'Lightweight extraction produced no usable content');
                }
            } catch (err) {
                if (err instanceof SizeCapError) {
                    return errorOutput('size_cap_exceeded', err.message);
                }
                if (err instanceof RedirectLimitError) {
                    return errorOutput('redirect_limit', err.message);
                }
                // For auto mode, Tier 1 HTTP errors → try Tier 2
                if (tierPref === 'lightweight') {
                    return errorOutput('fetch_failed', (err as Error).message);
                }
            }
        }

        // Tier 2: Playwright browser fallback
        if (!browserManager) {
            return errorOutput(
                'browser_unavailable',
                'Browser not available for Tier 2 fallback. Lightweight extraction failed.',
            );
        }

        try {
            const result = await tier2Fetch(url, browserManager);
            if (!result) {
                return errorOutput('extraction_failed', 'Both lightweight and browser extraction failed to produce usable content');
            }
            return successOutput(JSON.stringify(result), result.truncated);
        } catch (err) {
            return errorOutput('browser_fetch_failed', (err as Error).message);
        }
    };
}

// Export constants for testing
export {
    DOWNLOAD_SIZE_CAP,
    EXTRACTED_CONTENT_CAP,
    REQUEST_TIMEOUT_MS,
    MAX_REDIRECTS,
    TIER1_MIN_CONTENT_LENGTH,
};

// Export for testing
export { tier1Fetch as _tier1Fetch, fetchWithLimits as _fetchWithLimits, truncateAtParagraph as _truncateAtParagraph };
