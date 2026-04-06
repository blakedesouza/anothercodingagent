import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../src/tools/tool-registry.js';
import type { NetworkPolicy } from '../../src/permissions/network-policy.js';
import {
    lookupDocsSpec,
    createLookupDocsImpl,
} from '../../src/tools/lookup-docs.js';
import type { SearchProvider, SearchResult } from '../../src/tools/web-search.js';

// --- Mock helpers ---

function makeContext(): ToolContext {
    return {
        sessionId: 'test-session',
        workspaceRoot: '/tmp/test',
        signal: new AbortController().signal,
    };
}

const DOCS_HTML = `
<!DOCTYPE html>
<html>
<head><title>React useEffect – React Docs</title></head>
<body>
<h1>useEffect</h1>
<p>useEffect is a React Hook that lets you synchronize a component with an external system.
It runs after the component renders. You can specify dependencies to control when it re-runs.
The cleanup function runs before re-execution and on unmount. This is useful for subscriptions,
event listeners, and other side effects that need cleanup.</p>
</body>
</html>
`;

function createMockProvider(results: SearchResult[] = []): SearchProvider {
    return {
        name: 'mock',
        search: vi.fn().mockResolvedValue(results),
    };
}

function createMockFetch(html: string = DOCS_HTML): typeof fetch {
    return vi.fn().mockResolvedValue(
        new Response(html, {
            status: 200,
            headers: { 'content-type': 'text/html' },
        }),
    ) as unknown as typeof fetch;
}

const sampleResults: SearchResult[] = [
    { title: 'useEffect – React', url: 'https://react.dev/reference/react/useEffect', snippet: 'Hook for side effects', source: 'mock' },
    { title: 'React Hooks FAQ', url: 'https://react.dev/learn/hooks-faq', snippet: 'FAQ about hooks', source: 'mock' },
];

// --- Spec tests ---

describe('lookupDocsSpec', () => {
    it('has correct name and approval class', () => {
        expect(lookupDocsSpec.name).toBe('lookup_docs');
        expect(lookupDocsSpec.approvalClass).toBe('external-effect');
        expect(lookupDocsSpec.timeoutCategory).toBe('network');
    });

    it('requires library and query parameters', () => {
        const required = (lookupDocsSpec.inputSchema as { required: string[] }).required;
        expect(required).toContain('library');
        expect(required).toContain('query');
    });
});

// --- Implementation tests ---

describe('createLookupDocsImpl', () => {
    let ctx: ToolContext;

    beforeEach(() => {
        ctx = makeContext();
    });

    it('returns error when no search provider configured', async () => {
        const impl = createLookupDocsImpl({});
        const result = await impl({ library: 'react', query: 'useEffect' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('search_not_configured');
    });

    it('searches with library + query combined', async () => {
        const provider = createMockProvider(sampleResults);
        const mockFetch = createMockFetch();
        const impl = createLookupDocsImpl({ searchProvider: provider, fetchFn: mockFetch });

        await impl({ library: 'react', query: 'useEffect cleanup' }, ctx);

        expect(provider.search).toHaveBeenCalledWith(
            expect.stringContaining('react'),
            expect.objectContaining({ limit: 3 }),
        );
        const searchQuery = (provider.search as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(searchQuery).toContain('documentation');
        expect(searchQuery).toContain('useEffect cleanup');
    });

    it('includes version in search query when provided', async () => {
        const provider = createMockProvider(sampleResults);
        const mockFetch = createMockFetch();
        const impl = createLookupDocsImpl({ searchProvider: provider, fetchFn: mockFetch });

        await impl({ library: 'react', version: '18', query: 'useEffect' }, ctx);

        const searchQuery = (provider.search as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(searchQuery).toContain('18');
    });

    it('returns fetched doc content with related results', async () => {
        const provider = createMockProvider(sampleResults);
        const mockFetch = createMockFetch();
        const impl = createLookupDocsImpl({ searchProvider: provider, fetchFn: mockFetch });

        const result = await impl({ library: 'react', query: 'useEffect' }, ctx);
        expect(result.status).toBe('success');

        const data = JSON.parse(result.data);
        expect(data.library).toBe('react');
        expect(data.source).toBe('https://react.dev/reference/react/useEffect');
        expect(data.relatedResults).toHaveLength(1); // Second result only (first was fetched)
    });

    it('returns search snippets when fetch fails', async () => {
        const provider = createMockProvider(sampleResults);
        // Fetch fails
        const failingFetch = vi.fn().mockRejectedValue(new Error('connection refused'));
        const impl = createLookupDocsImpl({
            searchProvider: provider,
            fetchFn: failingFetch as unknown as typeof fetch,
        });

        const result = await impl({ library: 'react', query: 'useEffect' }, ctx);
        expect(result.status).toBe('success');

        const data = JSON.parse(result.data);
        expect(data.source).toBe('search_snippets');
        expect(data.note).toContain('failed');
    });

    it('returns error when search finds no results', async () => {
        const provider = createMockProvider([]);
        const impl = createLookupDocsImpl({ searchProvider: provider });

        const result = await impl({ library: 'nonexistent-lib', query: 'anything' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('no_results');
    });

    it('handles search provider errors', async () => {
        const provider: SearchProvider = {
            name: 'failing',
            search: vi.fn().mockRejectedValue(new Error('API down')),
        };
        const impl = createLookupDocsImpl({ searchProvider: provider });

        const result = await impl({ library: 'react', query: 'hooks' }, ctx);
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('search_failed');
    });
});

// --- Network policy tests ---

describe('lookup_docs network policy', () => {
    let ctx: ToolContext;

    beforeEach(() => {
        ctx = makeContext();
    });

    it('returns network_denied when mode=off', async () => {
        const policy: NetworkPolicy = { mode: 'off', allowDomains: [], denyDomains: [], allowHttp: false };
        const provider = createMockProvider(sampleResults);
        const impl = createLookupDocsImpl({ searchProvider: provider, networkPolicy: policy });

        const result = await impl({ library: 'react', query: 'hooks' }, ctx);
        // The fetch_url call inside will be blocked by network policy
        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('network_denied');
    });

    it('returns network_confirm_required for unlisted domain in approved-only mode', async () => {
        const policy: NetworkPolicy = { mode: 'approved-only', allowDomains: [], denyDomains: [], allowHttp: false };
        const provider = createMockProvider(sampleResults);
        const impl = createLookupDocsImpl({ searchProvider: provider, networkPolicy: policy });

        const result = await impl({ library: 'react', query: 'hooks' }, ctx);
        // Network policy blocks the doc page fetch
        // But falls back to search snippets (which don't need fetching)
        expect(result.status).toBe('success');
        const data = JSON.parse(result.data);
        expect(data.source).toBe('search_snippets');
    });
});

// --- Localhost exception tests (lookup_docs) ---

describe('lookup_docs localhost exception', () => {
    const localhostAddresses = ['localhost', '127.0.0.1', '::1'];

    for (const host of localhostAddresses) {
        it(`auto-allows ${host} regardless of network mode`, async () => {
            const policy: NetworkPolicy = { mode: 'approved-only', allowDomains: [], denyDomains: [], allowHttp: true };
            const url = `http://${host === '::1' ? `[${host}]` : host}:8080/docs`;
            const provider = createMockProvider([
                { title: 'Local Docs', url, snippet: 'Local documentation', source: 'mock' },
            ]);
            const mockFetch = createMockFetch();
            const impl = createLookupDocsImpl({
                searchProvider: provider,
                networkPolicy: policy,
                fetchFn: mockFetch,
            });

            const result = await impl({ library: 'mylib', query: 'api' }, makeContext());
            // Should not be blocked by network policy
            if (result.status === 'error') {
                expect(result.error?.code).not.toBe('network_denied');
                expect(result.error?.code).not.toBe('network_confirm_required');
            }
        });
    }
});
