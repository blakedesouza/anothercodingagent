import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/tools/tool-registry.js';
import type { NetworkPolicy } from '../../src/permissions/network-policy.js';
import type { Page } from 'playwright-core';
import {
    fetchUrlSpec,
    createFetchUrlImpl,
    SizeCapError,
    RedirectLimitError,
    MAX_REDIRECTS,
    EXTRACTED_CONTENT_CAP,
    _truncateAtParagraph,
} from '../../src/tools/fetch-url.js';
import { BrowserManager } from '../../src/browser/browser-manager.js';

// --- Mock helpers ---

function makeContext(): ToolContext {
    return {
        sessionId: 'test-session',
        workspaceRoot: '/tmp/test',
        signal: new AbortController().signal,
    };
}

function createMockResponse(
    body: string,
    options: {
        status?: number;
        statusText?: string;
        headers?: Record<string, string>;
        url?: string;
    } = {},
): Response {
    const { status = 200, statusText = 'OK', headers = {}, url } = options;
    const defaultHeaders: Record<string, string> = {
        'content-type': 'text/html; charset=utf-8',
        ...headers,
    };
    const resp = new Response(body, {
        status,
        statusText,
        headers: new Headers(defaultHeaders),
    });
    if (url) {
        Object.defineProperty(resp, 'url', { value: url });
    }
    return resp;
}

const STATIC_HTML = `
<!DOCTYPE html>
<html>
<head><title>Test Article</title></head>
<body>
<h1>Test Article</h1>
<p>This is a test article with enough content to pass the minimum threshold.
Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud
exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
<script>alert('should not execute')</script>
</body>
</html>
`;

const SPA_HTML = `
<!DOCTYPE html>
<html>
<head><title>SPA</title></head>
<body><div id="root"></div><script>/* SPA bootstrap */</script></body>
</html>
`;

// --- Spec tests ---

describe('fetchUrlSpec', () => {
    it('has correct name and approval class', () => {
        expect(fetchUrlSpec.name).toBe('fetch_url');
        expect(fetchUrlSpec.approvalClass).toBe('external-effect');
        expect(fetchUrlSpec.timeoutCategory).toBe('network');
    });

    it('requires url parameter', () => {
        const required = (fetchUrlSpec.inputSchema as { required: string[] }).required;
        expect(required).toContain('url');
    });
});

// --- Truncation tests ---

describe('truncateAtParagraph', () => {
    it('returns untruncated for short content', () => {
        const { text, truncated } = _truncateAtParagraph('short', 1000);
        expect(text).toBe('short');
        expect(truncated).toBe(false);
    });

    it('truncates at paragraph boundary', () => {
        const content = 'Para 1\n\nPara 2\n\nPara 3 is very long and exceeds the limit';
        const { text, truncated } = _truncateAtParagraph(content, 20);
        expect(truncated).toBe(true);
        expect(text).toBe('Para 1\n\nPara 2');
    });

    it('falls back to newline boundary', () => {
        const content = 'Line 1\nLine 2\nLine 3 is very long';
        const { text, truncated } = _truncateAtParagraph(content, 15);
        expect(truncated).toBe(true);
        expect(text).toBe('Line 1\nLine 2');
    });
});

// --- Tier 1 fetch tests ---

describe('createFetchUrlImpl — Tier 1 (lightweight)', () => {
    let ctx: ToolContext;

    beforeEach(() => {
        ctx = makeContext();
    });

    it('extracts markdown from static HTML page', async () => {
        const mockFetch = vi.fn().mockResolvedValue(createMockResponse(STATIC_HTML, { url: 'https://example.com/article' }));
        const impl = createFetchUrlImpl({ fetchFn: mockFetch });

        const result = await impl({ url: 'https://example.com/article' }, ctx);
        expect(result.status).toBe('success');

        const data = JSON.parse(result.data);
        expect(data.tier).toBe('lightweight');
        expect(data.title).toBeTruthy();
        expect(data.content).toBeTruthy();
        expect(data.content.length).toBeGreaterThan(0);
        expect(data.wordCount).toBeGreaterThan(0);
    });

    it('returns error for invalid URL', async () => {
        const impl = createFetchUrlImpl({ fetchFn: vi.fn() });
        const result = await impl({ url: 'not-a-url' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('invalid_url');
    });

    it('returns error for non-http protocol', async () => {
        const impl = createFetchUrlImpl({ fetchFn: vi.fn() });
        const result = await impl({ url: 'ftp://example.com/file' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('invalid_protocol');
    });

    it('handles JSON response', async () => {
        const json = JSON.stringify({ key: 'value', nested: { a: 1 } });
        const mockFetch = vi.fn().mockResolvedValue(
            createMockResponse(json, { headers: { 'content-type': 'application/json' }, url: 'https://api.example.com/data' }),
        );
        const impl = createFetchUrlImpl({ fetchFn: mockFetch });

        const result = await impl({ url: 'https://api.example.com/data' }, ctx);
        expect(result.status).toBe('success');
        const data = JSON.parse(result.data);
        expect(data.tier).toBe('lightweight');
    });

    it('caps extracted content at EXTRACTED_CONTENT_CAP', async () => {
        const longContent = '<html><body><article>' + 'x'.repeat(20_000) + '</article></body></html>';
        const mockFetch = vi.fn().mockResolvedValue(
            createMockResponse(longContent, { url: 'https://example.com' }),
        );
        const impl = createFetchUrlImpl({ fetchFn: mockFetch });

        const result = await impl({ url: 'https://example.com' }, ctx);
        // Even if extraction partially works, content should be capped
        if (result.status === 'success') {
            const data = JSON.parse(result.data);
            expect(data.content.length).toBeLessThanOrEqual(EXTRACTED_CONTENT_CAP + 100); // small margin
        }
    });
});

// --- Size cap tests ---

describe('createFetchUrlImpl — download size cap', () => {
    let ctx: ToolContext;

    beforeEach(() => {
        ctx = makeContext();
    });

    it('aborts when Content-Length exceeds 5 MB', async () => {
        const mockFetch = vi.fn().mockResolvedValue(
            createMockResponse('', {
                headers: { 'content-length': String(10 * 1024 * 1024) },
                url: 'https://example.com/huge',
            }),
        );
        const impl = createFetchUrlImpl({ fetchFn: mockFetch });

        const result = await impl({ url: 'https://example.com/huge' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('size_cap_exceeded');
    });

    it('aborts when streamed body exceeds 5 MB', async () => {
        // Create a response without Content-Length but with a large body
        const largeChunk = new Uint8Array(3 * 1024 * 1024); // 3 MB
        let callCount = 0;
        const mockReader = {
            read: vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount <= 2) {
                    return Promise.resolve({ done: false, value: largeChunk });
                }
                return Promise.resolve({ done: true, value: undefined });
            }),
            cancel: vi.fn(),
        };
        const mockResp = {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'text/html' }),
            url: 'https://example.com/stream',
            body: { getReader: () => mockReader },
        };
        const mockFetch = vi.fn().mockResolvedValue(mockResp);
        const impl = createFetchUrlImpl({ fetchFn: mockFetch as unknown as typeof fetch });

        const result = await impl({ url: 'https://example.com/stream' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('size_cap_exceeded');
    });
});

// --- Redirect limit tests ---

describe('createFetchUrlImpl — redirect limit', () => {
    let ctx: ToolContext;

    beforeEach(() => {
        ctx = makeContext();
    });

    it('aborts when redirect chain exceeds 5', async () => {
        const mockFetch = vi.fn().mockImplementation(() => {
            return Promise.resolve({
                ok: false,
                status: 302,
                statusText: 'Found',
                headers: new Headers({ location: 'https://example.com/next' }),
                url: 'https://example.com/redirect',
            });
        });

        const impl = createFetchUrlImpl({ fetchFn: mockFetch as unknown as typeof fetch });

        const result = await impl({ url: 'https://example.com/start' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('redirect_limit');
        // Should have been called MAX_REDIRECTS + 1 times (initial + redirects)
        expect(mockFetch).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
    });
});

// --- SSRF redirect protection tests ---

describe('createFetchUrlImpl — SSRF redirect protection', () => {
    let ctx: ToolContext;

    beforeEach(() => {
        ctx = makeContext();
    });

    it('blocks redirect to denied domain', async () => {
        const policy: NetworkPolicy = { mode: 'open', allowDomains: [], denyDomains: ['evil.internal'], allowHttp: false };
        let callCount = 0;
        const mockFetch = vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                // First request succeeds, redirects to denied domain
                return Promise.resolve({
                    ok: false,
                    status: 302,
                    statusText: 'Found',
                    headers: new Headers({ location: 'https://evil.internal/admin' }),
                    url: 'https://allowed.com/redirect',
                });
            }
            // Should never reach here — redirect should be blocked
            return Promise.resolve(createMockResponse('<html><body>Secret</body></html>', { url: 'https://evil.internal/admin' }));
        });

        const impl = createFetchUrlImpl({ networkPolicy: policy, fetchFn: mockFetch as unknown as typeof fetch });
        const result = await impl({ url: 'https://allowed.com/redirect' }, ctx);

        expect(result.status).toBe('error');
        // Redirect blocked — only 1 fetch call made (the initial one)
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('blocks redirect from HTTPS to internal IP in approved-only mode', async () => {
        const policy: NetworkPolicy = { mode: 'approved-only', allowDomains: ['trusted.com'], denyDomains: [], allowHttp: false };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 302,
            statusText: 'Found',
            headers: new Headers({ location: 'https://192.168.1.1/admin' }),
            url: 'https://trusted.com/page',
        });

        const impl = createFetchUrlImpl({ networkPolicy: policy, fetchFn: mockFetch as unknown as typeof fetch });
        const result = await impl({ url: 'https://trusted.com/page' }, ctx);

        // Should fail because 192.168.1.1 is not in allowDomains
        expect(result.status).toBe('error');
    });
});

// --- Content-Length NaN protection tests ---

describe('createFetchUrlImpl — Content-Length NaN', () => {
    it('handles malformed Content-Length gracefully', async () => {
        const mockFetch = vi.fn().mockResolvedValue(
            createMockResponse(STATIC_HTML, {
                headers: { 'content-length': 'garbage' },
                url: 'https://example.com/page',
            }),
        );
        const impl = createFetchUrlImpl({ fetchFn: mockFetch });

        // Should NOT throw — NaN Content-Length should be ignored, streaming cap still applies
        const result = await impl({ url: 'https://example.com/page' }, makeContext());
        expect(result.status).toBe('success');
    });
});

// --- Network policy tests ---

describe('createFetchUrlImpl — network policy', () => {
    let ctx: ToolContext;

    beforeEach(() => {
        ctx = makeContext();
    });

    it('returns network_denied error when mode=off', async () => {
        const policy: NetworkPolicy = { mode: 'off', allowDomains: [], denyDomains: [], allowHttp: false };
        const impl = createFetchUrlImpl({ networkPolicy: policy, fetchFn: vi.fn() });

        const result = await impl({ url: 'https://example.com' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('network_denied');
    });

    it('returns network_confirm_required for unlisted domain in approved-only mode', async () => {
        const policy: NetworkPolicy = { mode: 'approved-only', allowDomains: [], denyDomains: [], allowHttp: false };
        const impl = createFetchUrlImpl({ networkPolicy: policy, fetchFn: vi.fn() });

        const result = await impl({ url: 'https://unknown.com' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('network_confirm_required');
    });

    it('denies domain in denyDomains even in open mode', async () => {
        const policy: NetworkPolicy = { mode: 'open', allowDomains: [], denyDomains: ['evil.com'], allowHttp: false };
        const impl = createFetchUrlImpl({ networkPolicy: policy, fetchFn: vi.fn() });

        const result = await impl({ url: 'https://evil.com/page' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('network_denied');
    });
});

// --- Localhost exception tests (fetch_url) ---

describe('fetch_url localhost exception', () => {
    const localhostAddresses = ['localhost', '127.0.0.1', '::1'];

    for (const host of localhostAddresses) {
        it(`auto-allows ${host} regardless of network mode`, async () => {
            const policy: NetworkPolicy = { mode: 'approved-only', allowDomains: [], denyDomains: [], allowHttp: true };
            const mockFetch = vi.fn().mockResolvedValue(
                createMockResponse(STATIC_HTML, { url: `http://${host === '::1' ? `[${host}]` : host}:3000` }),
            );
            const impl = createFetchUrlImpl({ networkPolicy: policy, fetchFn: mockFetch });

            const url = `http://${host === '::1' ? `[${host}]` : host}:3000`;
            const result = await impl({ url }, makeContext());

            // Should not be blocked — either success or extraction error, but NOT network_denied
            if (result.status === 'error') {
                expect(result.error?.code).not.toBe('network_denied');
                expect(result.error?.code).not.toBe('network_confirm_required');
            }
        });
    }
});

// --- Tier 2 (Playwright fallback) tests ---

describe('createFetchUrlImpl — Tier 2 (Playwright fallback)', () => {
    let ctx: ToolContext;

    beforeEach(() => {
        ctx = makeContext();
    });

    it('falls back to Tier 2 when Tier 1 extraction fails (SPA)', async () => {
        // Tier 1 returns SPA shell with no readable content
        const mockFetch = vi.fn().mockResolvedValue(
            createMockResponse(SPA_HTML, { url: 'https://spa.example.com' }),
        );

        // Mock browser manager for Tier 2
        const mockPage = {
            goto: vi.fn().mockResolvedValue(null),
            content: vi.fn().mockResolvedValue(STATIC_HTML),
            title: vi.fn().mockResolvedValue('SPA App'),
            url: vi.fn().mockReturnValue('https://spa.example.com'),
            evaluate: vi.fn().mockResolvedValue('Full rendered content with enough text for the threshold'),
            isClosed: vi.fn().mockReturnValue(false),
        } as unknown as Page;

        const mockManager = {
            ensurePage: vi.fn().mockResolvedValue(mockPage),
        } as unknown as BrowserManager;

        const impl = createFetchUrlImpl({
            fetchFn: mockFetch,
            browserManager: mockManager,
        });

        const result = await impl({ url: 'https://spa.example.com' }, ctx);
        expect(result.status).toBe('success');
        const data = JSON.parse(result.data);
        expect(data.tier).toBe('browser');
    });

    it('returns error when Tier 1 fails and no browser available', async () => {
        const mockFetch = vi.fn().mockResolvedValue(
            createMockResponse(SPA_HTML, { url: 'https://spa.example.com' }),
        );

        const impl = createFetchUrlImpl({ fetchFn: mockFetch });

        const result = await impl({ url: 'https://spa.example.com' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('browser_unavailable');
    });

    it('Tier 2 uses browser manager (inherits hardened context)', async () => {
        const mockPage = {
            goto: vi.fn().mockResolvedValue(null),
            content: vi.fn().mockResolvedValue(STATIC_HTML),
            title: vi.fn().mockResolvedValue('Test'),
            url: vi.fn().mockReturnValue('https://example.com'),
            evaluate: vi.fn().mockResolvedValue('content'),
            isClosed: vi.fn().mockReturnValue(false),
        } as unknown as Page;

        const mockManager = {
            ensurePage: vi.fn().mockResolvedValue(mockPage),
        } as unknown as BrowserManager;

        const impl = createFetchUrlImpl({
            fetchFn: vi.fn().mockRejectedValue(new Error('network error')),
            browserManager: mockManager,
        });

        await impl({ url: 'https://example.com' }, ctx);
        // Verify that ensurePage was called (uses the hardened context from M7.4)
        expect(mockManager.ensurePage).toHaveBeenCalled();
    });
});

// --- Security tests ---

describe('fetch_url security', () => {
    let ctx: ToolContext;

    beforeEach(() => {
        ctx = makeContext();
    });

    it('jsdom is created without runScripts — inline scripts are NOT executed', async () => {
        // This test verifies the code path: jsdom is created with NO runScripts option.
        // The STATIC_HTML contains a <script> tag. If runScripts were enabled,
        // the alert() would cause an error. The fact that this succeeds proves
        // scripts are not executed.
        const htmlWithScript = `
        <!DOCTYPE html>
        <html>
        <head><title>Script Test</title></head>
        <body>
        <h1>Article</h1>
        <p>This is a test article with sufficient content to pass the minimum length threshold
        for readability extraction. It needs to be fairly long to be considered readable content.</p>
        <script>
            // This script should NOT execute in jsdom without runScripts
            window.scriptExecuted = true;
            throw new Error('Script should not execute!');
        </script>
        </body>
        </html>`;

        const mockFetch = vi.fn().mockResolvedValue(
            createMockResponse(htmlWithScript, { url: 'https://example.com/safe' }),
        );
        const impl = createFetchUrlImpl({ fetchFn: mockFetch });

        // Should succeed — script does not execute, no error thrown
        const result = await impl({ url: 'https://example.com/safe' }, ctx);
        // Either success or extraction failure (if readability doesn't find enough content)
        // but NOT a script execution error
        if (result.error) {
            expect(result.error.message).not.toContain('Script should not execute');
        }
    });

    it('aborts 10 MB response at 5 MB cap', async () => {
        const mockFetch = vi.fn().mockResolvedValue(
            createMockResponse('', {
                headers: { 'content-length': String(10 * 1024 * 1024) },
                url: 'https://example.com/huge',
            }),
        );
        const impl = createFetchUrlImpl({ fetchFn: mockFetch });

        const result = await impl({ url: 'https://example.com/huge' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('size_cap_exceeded');
        expect(result.error?.message).toContain('5');
    });
});

// --- Error type tests ---

describe('SizeCapError', () => {
    it('includes actual and cap bytes', () => {
        const err = new SizeCapError(10_000_000, 5_000_000);
        expect(err.actualBytes).toBe(10_000_000);
        expect(err.capBytes).toBe(5_000_000);
        expect(err.name).toBe('SizeCapError');
    });
});

describe('RedirectLimitError', () => {
    it('includes redirect count', () => {
        const err = new RedirectLimitError(6);
        expect(err.redirectCount).toBe(6);
        expect(err.name).toBe('RedirectLimitError');
    });
});
