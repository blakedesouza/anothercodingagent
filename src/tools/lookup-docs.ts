/**
 * lookup_docs tool (Block 3, M7.5).
 *
 * Looks up library documentation by searching the web for docs pages,
 * then fetching and extracting the most relevant result.
 *
 * Uses web_search + fetch_url internally. Requires a search provider.
 * Network policy enforced on all requests.
 *
 * Approval class: external-effect (makes outbound HTTP requests).
 */

import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import type { NetworkPolicy } from '../permissions/network-policy.js';
import type { SearchProvider } from './web-search.js';
import type { BrowserManager } from '../browser/browser-manager.js';
import { createFetchUrlImpl } from './fetch-url.js';

// --- Constants ---

const EXTRACTED_CONTENT_CAP = 8_000;
const DEFAULT_FETCH_LIMIT = 3;

// --- Tool spec ---

export const lookupDocsSpec: ToolSpec = {
    name: 'lookup_docs',
    description:
        'Look up documentation for a library or framework. Searches for relevant docs pages ' +
        'and extracts the content. Returns doc passages matching the query.',
    inputSchema: {
        type: 'object',
        properties: {
            library: { type: 'string', minLength: 1 },
            version: { type: 'string' },
            query: { type: 'string', minLength: 1 },
        },
        required: ['library', 'query'],
        additionalProperties: false,
    },
    approvalClass: 'external-effect',
    idempotent: true,
    timeoutCategory: 'network',
};

// --- Dependencies ---

export interface LookupDocsDeps {
    searchProvider?: SearchProvider;
    networkPolicy?: NetworkPolicy;
    browserManager?: BrowserManager;
    fetchFn?: typeof globalThis.fetch;
}

// --- Helpers ---

function successOutput(data: string): ToolOutput {
    return {
        status: 'success',
        data,
        truncated: false,
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

// --- Factory ---

export function createLookupDocsImpl(deps: LookupDocsDeps): ToolImplementation {
    const { searchProvider, networkPolicy, browserManager, fetchFn } = deps;

    // Create a fetch_url impl for fetching doc pages
    const fetchUrlImpl = createFetchUrlImpl({
        networkPolicy,
        browserManager,
        fetchFn,
    });

    return async (args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> => {
        if (!searchProvider) {
            return errorOutput(
                'search_not_configured',
                'No search provider configured. Set a Tavily API key in config to enable docs lookup.',
            );
        }

        // Network mode=off → all web tools disabled
        if (networkPolicy?.mode === 'off') {
            return errorOutput('network_denied', 'Network access is disabled (mode: off)');
        }

        const library = args.library as string;
        const version = args.version as string | undefined;
        const query = args.query as string;

        // Build a targeted docs search query
        const searchQuery = version
            ? `${library} ${version} documentation ${query}`
            : `${library} documentation ${query}`;

        // Search for docs pages
        let searchResults;
        try {
            searchResults = await searchProvider.search(searchQuery, {
                limit: DEFAULT_FETCH_LIMIT,
            });
        } catch (err) {
            return errorOutput('search_failed', `Docs search failed: ${(err as Error).message}`);
        }

        if (searchResults.length === 0) {
            return errorOutput('no_results', `No documentation found for "${library}" matching "${query}"`);
        }

        // Fetch the top result — fetchUrlImpl handles network policy internally.
        // If blocked, it returns an error and we fall back to search snippets.
        const topResult = searchResults[0];

        // Fetch and extract the doc page
        const fetchResult = await fetchUrlImpl(
            { url: topResult.url, tier: 'auto' },
            context,
        );

        if (fetchResult.status === 'error') {
            // If fetch failed, return search snippets as fallback
            const snippetContent = searchResults
                .map((r, i) => `## ${i + 1}. ${r.title}\n\n${r.snippet}\n\nSource: ${r.url}`)
                .join('\n\n---\n\n');

            const output = JSON.stringify({
                library,
                version: version ?? null,
                query,
                source: 'search_snippets',
                content: snippetContent.slice(0, EXTRACTED_CONTENT_CAP),
                resultCount: searchResults.length,
                note: 'Full page fetch failed, returning search snippets instead.',
            });

            return successOutput(output);
        }

        // Parse fetch result and compose output
        let fetchData: { title?: string; content?: string; url?: string };
        try {
            fetchData = JSON.parse(fetchResult.data);
        } catch {
            fetchData = { content: fetchResult.data };
        }

        const output = JSON.stringify({
            library,
            version: version ?? null,
            query,
            source: topResult.url,
            title: fetchData.title ?? topResult.title,
            content: (fetchData.content ?? '').slice(0, EXTRACTED_CONTENT_CAP),
            relatedResults: searchResults.slice(1).map(r => ({
                title: r.title,
                url: r.url,
                snippet: r.snippet,
            })),
        });

        return successOutput(output);
    };
}
