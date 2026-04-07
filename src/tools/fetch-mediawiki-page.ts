/**
 * fetch_mediawiki_page tool.
 *
 * Bounded MediaWiki Action API fetch for Fandom and other MediaWiki-backed
 * sites. This avoids browser automation for pages that expose api.php but put
 * normal HTML behind bot/security checks.
 */

import type { ToolOutput } from '../types/conversation.js';
import type { ToolImplementation, ToolSpec, ToolContext } from './tool-registry.js';
import type { NetworkPolicy } from '../permissions/network-policy.js';
import { checkNetworkPolicy } from './web-search.js';

const CONTENT_CAP = 12_000;
const REQUEST_TIMEOUT_MS = 20_000;

export const fetchMediaWikiPageSpec: ToolSpec = {
    name: 'fetch_mediawiki_page',
    description:
        'Fetch a page from a MediaWiki Action API, including Fandom api.php endpoints. ' +
        'Use this for Fandom/MediaWiki pages before browser automation. Returns bounded wikitext by default.',
    inputSchema: {
        type: 'object',
        properties: {
            api_url: {
                type: 'string',
                minLength: 1,
                description: 'Full MediaWiki api.php URL, e.g. https://oddtaxi.fandom.com/api.php',
            },
            page: { type: 'string', minLength: 1 },
            prop: {
                type: 'string',
                enum: ['wikitext', 'html'],
                default: 'wikitext',
            },
        },
        required: ['api_url', 'page'],
        additionalProperties: false,
    },
    approvalClass: 'external-effect',
    idempotent: true,
    timeoutCategory: 'network',
};

export const fetchMediaWikiCategorySpec: ToolSpec = {
    name: 'fetch_mediawiki_category',
    description:
        'Fetch members of a MediaWiki/Fandom category through api.php. ' +
        'Use this to discover character, group, location, or faction pages before fetching individual pages.',
    inputSchema: {
        type: 'object',
        properties: {
            api_url: {
                type: 'string',
                minLength: 1,
                description: 'Full MediaWiki api.php URL, e.g. https://oddtaxi.fandom.com/api.php',
            },
            category: {
                type: 'string',
                minLength: 1,
                description: 'Category title, with or without the Category: prefix, e.g. Characters or Category:Mystery Kiss',
            },
            limit: {
                type: 'number',
                minimum: 1,
                maximum: 200,
                default: 50,
            },
        },
        required: ['api_url', 'category'],
        additionalProperties: false,
    },
    approvalClass: 'external-effect',
    idempotent: true,
    timeoutCategory: 'network',
};

export interface FetchMediaWikiPageDeps {
    networkPolicy?: NetworkPolicy;
    fetchFn?: typeof globalThis.fetch;
}

interface MediaWikiParseResponse {
    parse?: {
        title?: string;
        pageid?: number;
        wikitext?: string;
        text?: string;
    };
    error?: {
        code?: string;
        info?: string;
    };
}

interface MediaWikiCategoryMembersResponse {
    query?: {
        categorymembers?: Array<{
            title?: string;
            pageid?: number;
            ns?: number;
        }>;
    };
    continue?: Record<string, unknown>;
    error?: {
        code?: string;
        info?: string;
    };
}

function successOutput(data: string, truncated: boolean, bytesOmitted: number): ToolOutput {
    return {
        status: 'success',
        data,
        truncated,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted,
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

function buildApiUrl(apiUrl: string, page: string, prop: 'wikitext' | 'html'): string {
    const url = new URL(apiUrl);
    url.search = '';
    url.searchParams.set('action', 'parse');
    url.searchParams.set('page', page);
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');
    url.searchParams.set('prop', prop === 'html' ? 'text' : 'wikitext');
    return url.toString();
}

function buildCategoryApiUrl(apiUrl: string, category: string, limit: number): string {
    const url = new URL(apiUrl);
    url.search = '';
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'categorymembers');
    url.searchParams.set('cmtitle', category.startsWith('Category:') ? category : `Category:${category}`);
    url.searchParams.set('cmlimit', String(Math.max(1, Math.min(200, Math.floor(limit)))));
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');
    return url.toString();
}

function truncateContent(content: string): { text: string; truncated: boolean; bytesOmitted: number } {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (content.length <= CONTENT_CAP) {
        return { text: content, truncated: false, bytesOmitted: 0 };
    }
    const text = content.slice(0, CONTENT_CAP);
    return {
        text,
        truncated: true,
        bytesOmitted: Math.max(0, bytes - Buffer.byteLength(text, 'utf8')),
    };
}

export function createFetchMediaWikiPageImpl(deps: FetchMediaWikiPageDeps): ToolImplementation {
    const { networkPolicy, fetchFn = globalThis.fetch } = deps;

    return async (args: Record<string, unknown>, _context: ToolContext): Promise<ToolOutput> => {
        const apiUrl = args.api_url as string;
        const page = args.page as string;
        const prop = ((args.prop as string | undefined) ?? 'wikitext') as 'wikitext' | 'html';

        let requestUrl: string;
        try {
            const parsedApiUrl = new URL(apiUrl);
            if (parsedApiUrl.protocol !== 'http:' && parsedApiUrl.protocol !== 'https:') {
                return errorOutput('invalid_protocol', `Protocol "${parsedApiUrl.protocol}" is not supported. Use http: or https:.`);
            }
            if (!parsedApiUrl.pathname.endsWith('/api.php')) {
                return errorOutput('invalid_api_url', 'api_url must point to a MediaWiki api.php endpoint');
            }
            requestUrl = buildApiUrl(apiUrl, page, prop);
        } catch {
            return errorOutput('invalid_url', `Invalid api_url: ${apiUrl}`);
        }

        const blocked = checkNetworkPolicy(requestUrl, networkPolicy);
        if (blocked) return blocked;

        try {
            const resp = await fetchFn(requestUrl, {
                headers: { 'accept': 'application/json' },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });

            if (!resp.ok) {
                return errorOutput('fetch_failed', `MediaWiki API returned ${resp.status} ${resp.statusText}`);
            }

            const data = await resp.json() as MediaWikiParseResponse;
            if (data.error) {
                return errorOutput('mediawiki_error', data.error.info ?? data.error.code ?? 'MediaWiki API error');
            }

            const content = prop === 'html'
                ? data.parse?.text
                : data.parse?.wikitext;
            if (!content) {
                return errorOutput('missing_content', `MediaWiki API response did not include ${prop}`);
            }

            const truncated = truncateContent(content);
            return successOutput(JSON.stringify({
                api_url: apiUrl,
                request_url: requestUrl,
                page,
                title: data.parse?.title ?? page,
                pageid: data.parse?.pageid,
                prop,
                content: truncated.text,
                truncated: truncated.truncated,
            }), truncated.truncated, truncated.bytesOmitted);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const retryable = message.includes('timeout') || message.includes('aborted');
            return errorOutput(retryable ? 'timeout' : 'fetch_failed', message, retryable);
        }
    };
}

export function createFetchMediaWikiCategoryImpl(deps: FetchMediaWikiPageDeps): ToolImplementation {
    const { networkPolicy, fetchFn = globalThis.fetch } = deps;

    return async (args: Record<string, unknown>, _context: ToolContext): Promise<ToolOutput> => {
        const apiUrl = args.api_url as string;
        const category = args.category as string;
        const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? args.limit
            : 50;

        let requestUrl: string;
        try {
            const parsedApiUrl = new URL(apiUrl);
            if (parsedApiUrl.protocol !== 'http:' && parsedApiUrl.protocol !== 'https:') {
                return errorOutput('invalid_protocol', `Protocol "${parsedApiUrl.protocol}" is not supported. Use http: or https:.`);
            }
            if (!parsedApiUrl.pathname.endsWith('/api.php')) {
                return errorOutput('invalid_api_url', 'api_url must point to a MediaWiki api.php endpoint');
            }
            requestUrl = buildCategoryApiUrl(apiUrl, category, limit);
        } catch {
            return errorOutput('invalid_url', `Invalid api_url: ${apiUrl}`);
        }

        const blocked = checkNetworkPolicy(requestUrl, networkPolicy);
        if (blocked) return blocked;

        try {
            const resp = await fetchFn(requestUrl, {
                headers: { 'accept': 'application/json' },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });

            if (!resp.ok) {
                return errorOutput('fetch_failed', `MediaWiki API returned ${resp.status} ${resp.statusText}`);
            }

            const data = await resp.json() as MediaWikiCategoryMembersResponse;
            if (data.error) {
                return errorOutput('mediawiki_error', data.error.info ?? data.error.code ?? 'MediaWiki API error');
            }

            const members = data.query?.categorymembers ?? [];
            return successOutput(JSON.stringify({
                api_url: apiUrl,
                request_url: requestUrl,
                category: category.startsWith('Category:') ? category : `Category:${category}`,
                members,
                truncated: Boolean(data.continue),
            }), Boolean(data.continue), 0);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const retryable = message.includes('timeout') || message.includes('aborted');
            return errorOutput(retryable ? 'timeout' : 'fetch_failed', message, retryable);
        }
    };
}

export {
    CONTENT_CAP as FETCH_MEDIAWIKI_CONTENT_CAP,
    buildApiUrl as _buildMediaWikiApiUrl,
    buildCategoryApiUrl as _buildMediaWikiCategoryApiUrl,
};
