import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '../../src/tools/tool-registry.js';
import type { NetworkPolicy } from '../../src/permissions/network-policy.js';
import {
    fetchMediaWikiPageSpec,
    fetchMediaWikiCategorySpec,
    createFetchMediaWikiPageImpl,
    createFetchMediaWikiCategoryImpl,
    _buildMediaWikiApiUrl,
    _buildMediaWikiCategoryApiUrl,
    FETCH_MEDIAWIKI_CONTENT_CAP,
} from '../../src/tools/fetch-mediawiki-page.js';

function makeContext(): ToolContext {
    return {
        sessionId: 'test-session',
        workspaceRoot: '/tmp/test',
        signal: new AbortController().signal,
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('fetchMediaWikiPageSpec', () => {
    it('has the expected tool metadata', () => {
        expect(fetchMediaWikiPageSpec.name).toBe('fetch_mediawiki_page');
        expect(fetchMediaWikiPageSpec.approvalClass).toBe('external-effect');
        expect(fetchMediaWikiPageSpec.timeoutCategory).toBe('network');
    });

    it('requires api_url and page', () => {
        const required = fetchMediaWikiPageSpec.inputSchema.required as string[];
        expect(required).toEqual(['api_url', 'page']);
    });
});

describe('fetchMediaWikiCategorySpec', () => {
    it('has the expected tool metadata', () => {
        expect(fetchMediaWikiCategorySpec.name).toBe('fetch_mediawiki_category');
        expect(fetchMediaWikiCategorySpec.approvalClass).toBe('external-effect');
        expect(fetchMediaWikiCategorySpec.timeoutCategory).toBe('network');
    });

    it('requires api_url and category', () => {
        const required = fetchMediaWikiCategorySpec.inputSchema.required as string[];
        expect(required).toEqual(['api_url', 'category']);
    });
});

describe('_buildMediaWikiApiUrl', () => {
    it('builds a bounded parse URL using formatversion=2', () => {
        const url = _buildMediaWikiApiUrl('https://oddtaxi.fandom.com/api.php?old=1', 'Hiroshi Odokawa', 'wikitext');
        expect(url).toBe('https://oddtaxi.fandom.com/api.php?action=parse&page=Hiroshi+Odokawa&format=json&formatversion=2&prop=wikitext');
    });
});

describe('_buildMediaWikiCategoryApiUrl', () => {
    it('builds a categorymembers URL using formatversion=2', () => {
        const url = _buildMediaWikiCategoryApiUrl('https://oddtaxi.fandom.com/api.php?old=1', 'Mystery Kiss', 50);
        expect(url).toBe('https://oddtaxi.fandom.com/api.php?action=query&list=categorymembers&cmtitle=Category%3AMystery+Kiss&cmlimit=50&format=json&formatversion=2');
    });
});

describe('createFetchMediaWikiPageImpl', () => {
    it('fetches wikitext from a MediaWiki api.php endpoint', async () => {
        const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
            parse: {
                title: 'Hiroshi Odokawa',
                pageid: 123,
                wikitext: '{{Character}}\nOdokawa is a taxi driver.',
            },
        }));
        const impl = createFetchMediaWikiPageImpl({ fetchFn });

        const result = await impl({
            api_url: 'https://oddtaxi.fandom.com/api.php',
            page: 'Hiroshi_Odokawa',
        }, makeContext());

        expect(result.status).toBe('success');
        expect(fetchFn).toHaveBeenCalledOnce();
        const fetchedUrl = fetchFn.mock.calls[0][0] as string;
        expect(fetchedUrl).toContain('action=parse');
        expect(fetchedUrl).toContain('prop=wikitext');

        const data = JSON.parse(result.data) as { title: string; content: string; prop: string };
        expect(data.title).toBe('Hiroshi Odokawa');
        expect(data.prop).toBe('wikitext');
        expect(data.content).toContain('taxi driver');
    });

    it('can fetch html when requested', async () => {
        const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
            parse: { title: 'Page', text: '<p>Rendered HTML</p>' },
        }));
        const impl = createFetchMediaWikiPageImpl({ fetchFn });

        const result = await impl({
            api_url: 'https://example.fandom.com/api.php',
            page: 'Page',
            prop: 'html',
        }, makeContext());

        expect(result.status).toBe('success');
        const data = JSON.parse(result.data) as { content: string; prop: string };
        expect(data.prop).toBe('html');
        expect(data.content).toBe('<p>Rendered HTML</p>');
    });

    it('rejects non-api.php URLs', async () => {
        const impl = createFetchMediaWikiPageImpl({ fetchFn: vi.fn() });

        const result = await impl({
            api_url: 'https://oddtaxi.fandom.com/wiki/Hiroshi_Odokawa',
            page: 'Hiroshi_Odokawa',
        }, makeContext());

        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('invalid_api_url');
    });

    it('observes network policy before fetching', async () => {
        const policy: NetworkPolicy = {
            mode: 'approved-only',
            allowDomains: [],
            denyDomains: [],
            allowHttp: false,
        };
        const fetchFn = vi.fn<typeof fetch>();
        const impl = createFetchMediaWikiPageImpl({ networkPolicy: policy, fetchFn });

        const result = await impl({
            api_url: 'https://oddtaxi.fandom.com/api.php',
            page: 'Hiroshi_Odokawa',
        }, makeContext());

        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('network_confirm_required');
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('returns MediaWiki API errors cleanly', async () => {
        const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
            error: { code: 'missingtitle', info: 'The page you specified does not exist.' },
        }));
        const impl = createFetchMediaWikiPageImpl({ fetchFn });

        const result = await impl({
            api_url: 'https://oddtaxi.fandom.com/api.php',
            page: 'Nope',
        }, makeContext());

        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('mediawiki_error');
        expect(result.error?.message).toContain('does not exist');
    });

    it('caps returned content', async () => {
        const content = 'x'.repeat(FETCH_MEDIAWIKI_CONTENT_CAP + 100);
        const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
            parse: { title: 'Long', wikitext: content },
        }));
        const impl = createFetchMediaWikiPageImpl({ fetchFn });

        const result = await impl({
            api_url: 'https://oddtaxi.fandom.com/api.php',
            page: 'Long',
        }, makeContext());

        expect(result.status).toBe('success');
        expect(result.truncated).toBe(true);
        expect(result.bytesOmitted).toBeGreaterThan(0);
        const data = JSON.parse(result.data) as { content: string; truncated: boolean };
        expect(data.truncated).toBe(true);
        expect(data.content.length).toBe(FETCH_MEDIAWIKI_CONTENT_CAP);
    });
});

describe('createFetchMediaWikiCategoryImpl', () => {
    it('fetches category members from a MediaWiki api.php endpoint', async () => {
        const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
            query: {
                categorymembers: [
                    { title: 'Rui Nikaido', pageid: 1, ns: 0 },
                    { title: 'Shiho Ichimura', pageid: 2, ns: 0 },
                ],
            },
        }));
        const impl = createFetchMediaWikiCategoryImpl({ fetchFn });

        const result = await impl({
            api_url: 'https://oddtaxi.fandom.com/api.php',
            category: 'Mystery Kiss',
        }, makeContext());

        expect(result.status).toBe('success');
        const fetchedUrl = fetchFn.mock.calls[0][0] as string;
        expect(fetchedUrl).toContain('action=query');
        expect(fetchedUrl).toContain('list=categorymembers');
        expect(fetchedUrl).toContain('cmtitle=Category%3AMystery+Kiss');

        const data = JSON.parse(result.data) as { category: string; members: Array<{ title: string }> };
        expect(data.category).toBe('Category:Mystery Kiss');
        expect(data.members.map(m => m.title)).toEqual(['Rui Nikaido', 'Shiho Ichimura']);
    });

    it('rejects non-api.php URLs', async () => {
        const impl = createFetchMediaWikiCategoryImpl({ fetchFn: vi.fn() });

        const result = await impl({
            api_url: 'https://oddtaxi.fandom.com/wiki/Category:Characters',
            category: 'Characters',
        }, makeContext());

        expect(result.status).toBe('error');
        expect(result.error?.code).toBe('invalid_api_url');
    });
});
