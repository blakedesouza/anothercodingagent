import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/tools/tool-registry.js';
import type { NetworkPolicy } from '../../src/permissions/network-policy.js';
import {
    webSearchSpec,
    createWebSearchImpl,
    checkNetworkPolicy,
    TavilySearchProvider,
} from '../../src/tools/web-search.js';
import type { SearchProvider, SearchResult } from '../../src/tools/web-search.js';

// --- Mock helpers ---

function makeContext(): ToolContext {
    return {
        sessionId: 'test-session',
        workspaceRoot: '/tmp/test',
        signal: new AbortController().signal,
    };
}

function createMockProvider(results: SearchResult[] = []): SearchProvider {
    return {
        name: 'mock',
        search: vi.fn().mockResolvedValue(results),
    };
}

const sampleResults: SearchResult[] = [
    { title: 'Result 1', url: 'https://example.com/1', snippet: 'First result', source: 'mock' },
    { title: 'Result 2', url: 'https://example.com/2', snippet: 'Second result', source: 'mock' },
];

// --- Spec tests ---

describe('webSearchSpec', () => {
    it('has correct name and approval class', () => {
        expect(webSearchSpec.name).toBe('web_search');
        expect(webSearchSpec.approvalClass).toBe('external-effect');
        expect(webSearchSpec.timeoutCategory).toBe('network');
    });

    it('requires query parameter', () => {
        const required = (webSearchSpec.inputSchema as { required: string[] }).required;
        expect(required).toContain('query');
    });
});

// --- Implementation tests ---

describe('createWebSearchImpl', () => {
    let ctx: ToolContext;

    beforeEach(() => {
        ctx = makeContext();
    });

    it('returns error when no search provider configured', async () => {
        const impl = createWebSearchImpl({});
        const result = await impl({ query: 'test' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('search_not_configured');
    });

    it('returns normalized results from mock provider', async () => {
        const provider = createMockProvider(sampleResults);
        const impl = createWebSearchImpl({ searchProvider: provider });

        const result = await impl({ query: 'test query' }, ctx);
        expect(result.status).toBe('success');

        const data = JSON.parse(result.data);
        expect(data.query).toBe('test query');
        expect(data.resultCount).toBe(2);
        expect(data.results).toHaveLength(2);
        expect(data.results[0]).toEqual({
            title: 'Result 1',
            url: 'https://example.com/1',
            snippet: 'First result',
            source: 'mock',
        });
    });

    it('passes domain filter, recency, and limit to provider', async () => {
        const provider = createMockProvider([]);
        const impl = createWebSearchImpl({ searchProvider: provider });

        await impl(
            {
                query: 'test',
                domain_filter: ['example.com'],
                recency: 'week',
                limit: 10,
            },
            ctx,
        );

        expect(provider.search).toHaveBeenCalledWith('test', {
            domainFilter: ['example.com'],
            recency: 'week',
            limit: 10,
        });
    });

    it('caps limit at MAX_LIMIT (20)', async () => {
        const provider = createMockProvider([]);
        const impl = createWebSearchImpl({ searchProvider: provider });

        await impl({ query: 'test', limit: 50 }, ctx);

        expect(provider.search).toHaveBeenCalledWith('test', expect.objectContaining({ limit: 20 }));
    });

    it('handles provider errors gracefully', async () => {
        const provider: SearchProvider = {
            name: 'failing',
            search: vi.fn().mockRejectedValue(new Error('API timeout')),
        };
        const impl = createWebSearchImpl({ searchProvider: provider });

        const result = await impl({ query: 'test' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('search_failed');
        expect(result.error?.message).toContain('API timeout');
    });
});

// --- Network policy tests ---

describe('checkNetworkPolicy', () => {
    it('returns null when no policy provided', () => {
        expect(checkNetworkPolicy('https://example.com', undefined)).toBeNull();
    });

    it('returns deny error for mode=off', () => {
        const policy: NetworkPolicy = { mode: 'off', allowDomains: [], denyDomains: [], allowHttp: false };
        const result = checkNetworkPolicy('https://example.com', policy);
        expect(result).not.toBeNull();
        expect(result!.error?.code).toBe('network_denied');
    });

    it('returns confirm error for unlisted domain in approved-only mode', () => {
        const policy: NetworkPolicy = { mode: 'approved-only', allowDomains: [], denyDomains: [], allowHttp: false };
        const result = checkNetworkPolicy('https://unknown.com', policy);
        expect(result).not.toBeNull();
        expect(result!.error?.code).toBe('network_confirm_required');
    });

    it('returns null for allowed domain in approved-only mode', () => {
        const policy: NetworkPolicy = { mode: 'approved-only', allowDomains: ['example.com'], denyDomains: [], allowHttp: false };
        const result = checkNetworkPolicy('https://example.com', policy);
        expect(result).toBeNull();
    });

    it('returns deny for denied domain even in open mode', () => {
        const policy: NetworkPolicy = { mode: 'open', allowDomains: [], denyDomains: ['evil.com'], allowHttp: false };
        const result = checkNetworkPolicy('https://evil.com', policy);
        expect(result).not.toBeNull();
        expect(result!.error?.code).toBe('network_denied');
    });

    it('returns null for open mode with non-denied domain', () => {
        const policy: NetworkPolicy = { mode: 'open', allowDomains: [], denyDomains: [], allowHttp: false };
        const result = checkNetworkPolicy('https://example.com', policy);
        expect(result).toBeNull();
    });
});

// --- Localhost exception tests (web_search) ---

describe('web_search localhost exception', () => {
    const localhostAddresses = ['localhost', '127.0.0.1', '::1'];

    for (const host of localhostAddresses) {
        it(`auto-allows ${host} regardless of network mode`, () => {
            const policy: NetworkPolicy = { mode: 'approved-only', allowDomains: [], denyDomains: [], allowHttp: true };
            const url = `http://${host === '::1' ? `[${host}]` : host}:8080/search`;
            const result = checkNetworkPolicy(url, policy);
            expect(result).toBeNull();
        });
    }
});

// --- TavilySearchProvider unit tests ---

describe('TavilySearchProvider', () => {
    it('sends correct request body', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ results: [] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const provider = new TavilySearchProvider('test-key');
        await provider.search('test query', { limit: 3 });

        expect(mockFetch).toHaveBeenCalledWith(
            'https://api.tavily.com/search',
            expect.objectContaining({
                method: 'POST',
            }),
        );

        // API key sent in Authorization header, not body
        const callArgs = mockFetch.mock.calls[0][1];
        expect(callArgs.headers.Authorization).toBe('Bearer test-key');

        const body = JSON.parse(callArgs.body);
        expect(body.query).toBe('test query');
        expect(body.max_results).toBe(3);
        expect(body.api_key).toBeUndefined();

        vi.unstubAllGlobals();
    });

    it('normalizes response to SearchResult format', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({
                results: [
                    { title: 'Page', url: 'https://example.com', content: 'Snippet text', score: 0.9 },
                ],
            }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const provider = new TavilySearchProvider('test-key');
        const results = await provider.search('test');

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
            title: 'Page',
            url: 'https://example.com',
            snippet: 'Snippet text',
            source: 'tavily',
        });

        vi.unstubAllGlobals();
    });

    it('throws on non-200 response', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
        });
        vi.stubGlobal('fetch', mockFetch);

        const provider = new TavilySearchProvider('bad-key');
        await expect(provider.search('test')).rejects.toThrow('Tavily API error: 401');

        vi.unstubAllGlobals();
    });
});
