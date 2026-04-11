/**
 * web_search tool (Block 3, M7.5).
 *
 * Provider-abstracted web search. Start with Tavily, extensible to SearXNG/others.
 * Network policy enforcement on all requests.
 *
 * Approval class: external-effect (makes outbound HTTP requests).
 */

import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import type { NetworkPolicy, NetworkPolicyResult } from '../permissions/network-policy.js';
import { evaluateNetworkAccess } from '../permissions/network-policy.js';

// --- Constants ---

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const EXTRACTED_CONTENT_CAP = 8_000;

// --- Search provider abstraction ---

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    source: string;
}

export interface SearchOptions {
    domainFilter?: string[];
    recency?: 'day' | 'week' | 'month' | 'year';
    limit?: number;
}

export interface SearchProvider {
    readonly name: string;
    search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

// --- Tavily provider ---

interface TavilyResponse {
    results: Array<{
        title: string;
        url: string;
        content: string;
        score?: number;
    }>;
}

export class TavilySearchProvider implements SearchProvider {
    readonly name = 'tavily';
    private readonly apiKey: string;
    private readonly baseUrl: string;

    constructor(apiKey: string, baseUrl = 'https://api.tavily.com') {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
    }

    async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
        const body: Record<string, unknown> = {
            query,
            max_results: options?.limit ?? DEFAULT_LIMIT,
            search_depth: 'basic',
        };

        if (options?.domainFilter?.length) {
            body.include_domains = options.domainFilter;
        }

        if (options?.recency) {
            body.days = recencyToDays(options.recency);
        }

        const resp = await fetch(`${this.baseUrl}/search`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        });

        if (!resp.ok) {
            throw new Error(`Tavily API error: ${resp.status} ${resp.statusText}`);
        }

        const data = (await resp.json()) as TavilyResponse;

        return data.results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content.slice(0, EXTRACTED_CONTENT_CAP),
            source: this.name,
        }));
    }
}

function recencyToDays(recency: string): number {
    switch (recency) {
        case 'day': return 1;
        case 'week': return 7;
        case 'month': return 30;
        case 'year': return 365;
        default: return 30;
    }
}

// --- Tool spec ---

export const webSearchSpec: ToolSpec = {
    name: 'web_search',
    description:
        'Search the web for information. Returns ranked results with title, URL, and snippet.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', minLength: 1 },
            domain_filter: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
                maxItems: 10,
            },
            recency: {
                type: 'string',
                enum: ['day', 'week', 'month', 'year'],
            },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
    },
    approvalClass: 'external-effect',
    idempotent: true,
    timeoutCategory: 'network',
};

// --- Dependencies ---

export interface WebSearchDeps {
    searchProvider?: SearchProvider;
    networkPolicy?: NetworkPolicy;
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

/**
 * Check network policy for a URL. Returns a deny/confirm error ToolOutput or null if allowed.
 */
export async function checkNetworkPolicy(url: string, policy: NetworkPolicy | undefined): Promise<ToolOutput | null> {
    if (!policy) return null;

    const result: NetworkPolicyResult = await evaluateNetworkAccess(url, policy);
    if (result.decision === 'deny') {
        return errorOutput('network_denied', `Blocked: ${result.reason}`);
    }
    if (result.decision === 'confirm') {
        return errorOutput('network_confirm_required', `Domain requires approval: ${result.reason}`, true);
    }
    return null;
}

// --- Factory ---

export function createWebSearchImpl(deps: WebSearchDeps): ToolImplementation {
    const { searchProvider, networkPolicy } = deps;

    return async (args: Record<string, unknown>, _context: ToolContext): Promise<ToolOutput> => {
        if (!searchProvider) {
            return errorOutput(
                'search_not_configured',
                'No search provider configured. Set a Tavily API key in config to enable web search.',
            );
        }

        const query = args.query as string;
        const domainFilter = args.domain_filter as string[] | undefined;
        const recency = args.recency as string | undefined;
        const limit = Math.min((args.limit as number | undefined) ?? DEFAULT_LIMIT, MAX_LIMIT);

        // Network policy: check the search provider's API endpoint
        // For Tavily, the API domain is api.tavily.com — but search results link to arbitrary domains.
        // The policy check here validates the provider API is reachable.
        // Individual result URLs are NOT fetched by this tool (that's fetch_url's job).
        if (searchProvider instanceof TavilySearchProvider) {
            const blocked = await checkNetworkPolicy('https://api.tavily.com/search', networkPolicy);
            if (blocked !== null) return blocked;
        }

        try {
            const results = await searchProvider.search(query, {
                domainFilter,
                recency: recency as SearchOptions['recency'],
                limit,
            });

            const output = JSON.stringify({
                query,
                resultCount: results.length,
                results,
            });

            return successOutput(output);
        } catch (err) {
            return errorOutput('search_failed', (err as Error).message);
        }
    };
}
