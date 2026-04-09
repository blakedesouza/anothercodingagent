import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    StaticCatalog,
    NanoGptCatalog,
    OpenRouterCatalog,
} from '../../src/providers/model-catalog.js';

// --- StaticCatalog ---

describe('M11.1 — StaticCatalog', () => {
    it('isLoaded is true immediately', () => {
        const catalog = new StaticCatalog();
        expect(catalog.isLoaded).toBe(true);
    });

    it('fetch() is a no-op', async () => {
        const catalog = new StaticCatalog();
        await catalog.fetch(); // should not throw
        expect(catalog.isLoaded).toBe(true);
    });

    it('returns entries for known models from models.json', () => {
        const catalog = new StaticCatalog();
        const entry = catalog.getModel('claude-sonnet-4-20250514');
        expect(entry).not.toBeNull();
        expect(entry!.id).toBe('claude-sonnet-4-20250514');
        expect(entry!.contextLength).toBe(200_000);
        expect(entry!.maxOutputTokens).toBe(16_384);
        expect(entry!.capabilities.vision).toBe(true);
        expect(entry!.capabilities.toolCalling).toBe(true);
        expect(entry!.capabilities.structuredOutput).toBe(true);
    });

    it('returns null for unknown models', () => {
        const catalog = new StaticCatalog();
        expect(catalog.getModel('nonexistent-model')).toBeNull();
    });

    it('maps reasoning capability from specialFeatures', () => {
        const catalog = new StaticCatalog();
        // claude-opus has claude-extended-thinking
        const opus = catalog.getModel('claude-opus-4-20250514');
        expect(opus?.capabilities.reasoning).toBe(true);

        // deepseek-reasoner has deepseek-reasoning
        const dsr = catalog.getModel('deepseek-reasoner');
        expect(dsr?.capabilities.reasoning).toBe(true);

        // gpt-4o has no reasoning
        const gpt = catalog.getModel('gpt-4o');
        expect(gpt?.capabilities.reasoning).toBe(false);
    });

    it('includes glm-5 static fallback metadata', () => {
        const catalog = new StaticCatalog();
        const glm = catalog.getModel('zai-org/glm-5');
        expect(glm).not.toBeNull();
        expect(glm!.contextLength).toBe(200_000);
        expect(glm!.maxOutputTokens).toBe(128_000);
        expect(glm!.capabilities.toolCalling).toBe(true);
        expect(glm!.capabilities.reasoning).toBe(true);
        expect(glm!.capabilities.structuredOutput).toBe(true);
        expect(glm!.pricing).toEqual({ input: 0.3, output: 2.55 });
    });

    it('maps toolCalling=false for models with supportsTools=none', () => {
        const catalog = new StaticCatalog();
        const dsr = catalog.getModel('deepseek-reasoner');
        expect(dsr?.capabilities.toolCalling).toBe(false);
        expect(dsr?.capabilities.structuredOutput).toBe(false);
    });

    it('includes pricing when available', () => {
        const catalog = new StaticCatalog();
        const entry = catalog.getModel('gpt-4o');
        expect(entry?.pricing).toBeDefined();
        expect(entry!.pricing!.input).toBe(2.5);
        expect(entry!.pricing!.output).toBe(10.0);
    });
});

// --- NanoGptCatalog ---

function makeNanoGptResponse(models: Record<string, unknown>[]) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: models }),
    } as unknown as Response;
}

const NANOGPT_QWEN_ENTRY = {
    id: 'qwen/qwen3-coder',
    context_length: 262_144,
    max_output_tokens: 65_536,
    capabilities: {
        vision: false,
        tool_calling: true,
        reasoning: false,
        structured_output: true,
    },
    pricing: { input: 0.25, output: 1.0 },
};

const NANOGPT_MINIMAX_ENTRY = {
    id: 'minimax/minimax-m2.7',
    context_length: 204_800,
    max_output_tokens: 131_072,
    capabilities: {
        vision: false,
        tool_calling: true,
        reasoning: false,
        structured_output: false,
    },
};

describe('M11.1 — NanoGptCatalog', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockFetch = vi.fn();
    });

    it('fetches and parses NanoGPT models response', async () => {
        mockFetch.mockResolvedValueOnce(
            makeNanoGptResponse([NANOGPT_QWEN_ENTRY, NANOGPT_MINIMAX_ENTRY]),
        );

        const catalog = new NanoGptCatalog({
            apiKey: 'test-key',
            baseUrl: 'https://api.example.com',
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        expect(catalog.isLoaded).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        const qwen = catalog.getModel('qwen/qwen3-coder');
        expect(qwen).not.toBeNull();
        expect(qwen!.contextLength).toBe(262_144);
        expect(qwen!.maxOutputTokens).toBe(65_536);
        expect(qwen!.capabilities.toolCalling).toBe(true);
        expect(qwen!.capabilities.vision).toBe(false);
        expect(qwen!.pricing).toEqual({ input: 0.25, output: 1.0 });

        const minimax = catalog.getModel('minimax/minimax-m2.7');
        expect(minimax).not.toBeNull();
        expect(minimax!.contextLength).toBe(204_800);
        expect(minimax!.maxOutputTokens).toBe(131_072);
        expect(minimax!.pricing).toBeUndefined();
    });

    it('sends correct URL and auth header', async () => {
        mockFetch.mockResolvedValueOnce(makeNanoGptResponse([]));

        const catalog = new NanoGptCatalog({
            apiKey: 'my-secret-key',
            baseUrl: 'https://api.example.com',
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        expect(mockFetch).toHaveBeenCalledWith(
            'https://api.example.com/subscription/v1/models?detailed=true',
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({
                    'Authorization': 'Bearer my-secret-key',
                }),
            }),
        );
    });

    it('defaults to the same endpoint family as subscription chat completions', async () => {
        mockFetch.mockResolvedValueOnce(makeNanoGptResponse([]));

        const catalog = new NanoGptCatalog({
            apiKey: 'my-secret-key',
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        expect(mockFetch).toHaveBeenCalledWith(
            'https://nano-gpt.com/api/subscription/v1/models?detailed=true',
            expect.any(Object),
        );
    });

    it('deduplicates concurrent fetch() calls', async () => {
        mockFetch.mockResolvedValueOnce(makeNanoGptResponse([NANOGPT_QWEN_ENTRY]));

        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fetchFn: mockFetch,
        });

        // Fire two concurrent fetches
        const p1 = catalog.fetch();
        const p2 = catalog.fetch();
        await Promise.all([p1, p2]);

        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not re-fetch after successful load', async () => {
        mockFetch.mockResolvedValue(makeNanoGptResponse([NANOGPT_QWEN_ENTRY]));

        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fetchFn: mockFetch,
        });

        await catalog.fetch();
        await catalog.fetch();

        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('falls back to StaticCatalog on HTTP error', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
        } as Response);

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const fallback = new StaticCatalog();
        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fallback,
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        expect(catalog.isLoaded).toBe(true);
        // Should have fallback data
        const sonnet = catalog.getModel('claude-sonnet-4-20250514');
        expect(sonnet).not.toBeNull();
        expect(sonnet!.contextLength).toBe(200_000);

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('Failed to fetch models'),
        );
        warnSpy.mockRestore();
    });

    it('falls back to StaticCatalog on network error', async () => {
        mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const fallback = new StaticCatalog();
        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fallback,
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        expect(catalog.isLoaded).toBe(true);
        expect(catalog.getModel('gpt-4o')).not.toBeNull();

        warnSpy.mockRestore();
    });

    it('falls back to StaticCatalog on timeout (abort)', async () => {
        // Simulate abort via DOMException
        mockFetch.mockRejectedValueOnce(new DOMException('signal is aborted', 'AbortError'));

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const fallback = new StaticCatalog();
        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            timeout: 1, // very short
            fallback,
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        expect(catalog.isLoaded).toBe(true);
        expect(catalog.getModel('gpt-4o')).not.toBeNull();

        warnSpy.mockRestore();
    });

    it('returns null when no fallback and fetch fails', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fetchFn: mockFetch,
            // no fallback
        });

        await catalog.fetch();

        expect(catalog.isLoaded).toBe(true);
        expect(catalog.getModel('qwen/qwen3-coder')).toBeNull();

        warnSpy.mockRestore();
    });

    // M10.1c: if the response parses to 0 usable entries (schema drift, all
    // entries invalid, whatever), treat it as a fetch failure so the fallback
    // catalog kicks in. Previously an empty parse silently left isLoaded=true
    // with an empty entries map — hiding the failure.
    it('zero valid entries → falls back to StaticCatalog (not silently empty)', async () => {
        // Response is technically valid JSON but every entry is unusable
        mockFetch.mockResolvedValueOnce(makeNanoGptResponse([
            { id: 'no-ctx', max_output_tokens: 500 },             // missing context_length
            { id: 'no-out', context_length: 1000 },                // missing max_output_tokens
            { id: '', context_length: 1000, max_output_tokens: 500 }, // empty id
        ]));

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const fallback = new StaticCatalog();
        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fallback,
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        expect(catalog.isLoaded).toBe(true);
        // Fallback's static models should be available
        expect(catalog.getModel('qwen/qwen3-coder')).not.toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('0 usable model entries'),
        );
        warnSpy.mockRestore();
    });

    it('skips entries with missing or invalid fields', async () => {
        mockFetch.mockResolvedValueOnce(makeNanoGptResponse([
            { id: 'valid', context_length: 1000, max_output_tokens: 500, capabilities: {} },
            { id: 'no-context', max_output_tokens: 500 },          // missing context_length
            { id: 'no-output', context_length: 1000 },              // missing max_output_tokens
            { id: 'zero-ctx', context_length: 0, max_output_tokens: 500 },  // zero context
            { id: 'neg-output', context_length: 1000, max_output_tokens: -1 },  // negative output
            { context_length: 1000, max_output_tokens: 500 },       // missing id
            { id: '', context_length: 1000, max_output_tokens: 500 }, // empty id
        ]));

        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        expect(catalog.getModel('valid')).not.toBeNull();
        expect(catalog.getModel('no-context')).toBeNull();
        expect(catalog.getModel('no-output')).toBeNull();
        expect(catalog.getModel('zero-ctx')).toBeNull();
        expect(catalog.getModel('neg-output')).toBeNull();
    });

    it('lazy-triggers fetch on getModel() if not yet started', async () => {
        mockFetch.mockResolvedValueOnce(makeNanoGptResponse([NANOGPT_QWEN_ENTRY]));

        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fetchFn: mockFetch,
        });

        // getModel triggers fetch but returns null synchronously
        const result = catalog.getModel('qwen/qwen3-coder');
        expect(result).toBeNull(); // not loaded yet

        // Wait for the lazy fetch to complete
        await catalog.fetch();
        expect(catalog.isLoaded).toBe(true);
        expect(catalog.getModel('qwen/qwen3-coder')).not.toBeNull();
    });

    it('handles string pricing values from NanoGPT API', async () => {
        mockFetch.mockResolvedValueOnce(makeNanoGptResponse([
            {
                id: 'string-priced',
                context_length: 8192,
                max_output_tokens: 4096,
                capabilities: {},
                pricing: { input: '0.25' as unknown as number, output: '1.0' as unknown as number },
            },
        ]));

        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        const entry = catalog.getModel('string-priced');
        expect(entry).not.toBeNull();
        expect(entry!.pricing).toBeDefined();
        expect(typeof entry!.pricing!.input).toBe('number');
        expect(entry!.pricing!.input).toBe(0.25);
        expect(typeof entry!.pricing!.output).toBe('number');
        expect(entry!.pricing!.output).toBe(1.0);
    });

    it('handles response with "models" key instead of "data"', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ models: [NANOGPT_QWEN_ENTRY] }),
        } as unknown as Response);

        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fetchFn: mockFetch,
        });

        await catalog.fetch();
        expect(catalog.getModel('qwen/qwen3-coder')).not.toBeNull();
    });
});

// --- OpenRouterCatalog ---

function makeOpenRouterResponse(models: Record<string, unknown>[]) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: models }),
    } as unknown as Response;
}

const OPENROUTER_MODEL = {
    id: 'anthropic/claude-3.5-sonnet',
    context_length: 200_000,
    max_completion_tokens: 8192,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    architecture: { modality: 'text+image' },
    supported_parameters: ['tools', 'response_format', 'temperature'],
};

const OPENROUTER_MODEL_TOP_PROVIDER = {
    id: 'meta-llama/llama-3.3-70b',
    context_length: 131_072,
    top_provider: { max_completion_tokens: 16_384 },
    pricing: { prompt: '0.0000004', completion: '0.0000004' },
    architecture: { modality: 'text' },
    supported_parameters: ['tools'],
};

describe('M11.1 — OpenRouterCatalog', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockFetch = vi.fn();
    });

    it('fetches and parses OpenRouter models response', async () => {
        mockFetch.mockResolvedValueOnce(
            makeOpenRouterResponse([OPENROUTER_MODEL, OPENROUTER_MODEL_TOP_PROVIDER]),
        );

        const catalog = new OpenRouterCatalog({
            baseUrl: 'https://openrouter.example.com/api/v1',
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        expect(catalog.isLoaded).toBe(true);

        const claude = catalog.getModel('anthropic/claude-3.5-sonnet');
        expect(claude).not.toBeNull();
        expect(claude!.contextLength).toBe(200_000);
        expect(claude!.maxOutputTokens).toBe(8192);
        expect(claude!.capabilities.vision).toBe(true);
        expect(claude!.capabilities.toolCalling).toBe(true);
        expect(claude!.capabilities.structuredOutput).toBe(true);
        // pricing: 0.000003 * 1M = 3.0
        expect(claude!.pricing!.input).toBeCloseTo(3.0, 5);
        expect(claude!.pricing!.output).toBeCloseTo(15.0, 5);
    });

    it('uses top_provider.max_completion_tokens as fallback', async () => {
        mockFetch.mockResolvedValueOnce(
            makeOpenRouterResponse([OPENROUTER_MODEL_TOP_PROVIDER]),
        );

        const catalog = new OpenRouterCatalog({
            baseUrl: 'https://openrouter.example.com/api/v1',
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        const llama = catalog.getModel('meta-llama/llama-3.3-70b');
        expect(llama).not.toBeNull();
        expect(llama!.maxOutputTokens).toBe(16_384);
        expect(llama!.capabilities.vision).toBe(false);
    });

    it('sends correct URL (no auth header)', async () => {
        mockFetch.mockResolvedValueOnce(makeOpenRouterResponse([]));

        const catalog = new OpenRouterCatalog({
            baseUrl: 'https://openrouter.example.com/api/v1',
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        expect(mockFetch).toHaveBeenCalledWith(
            'https://openrouter.example.com/api/v1/models',
            expect.objectContaining({
                method: 'GET',
            }),
        );
    });

    it('deduplicates concurrent fetch() calls', async () => {
        mockFetch.mockResolvedValueOnce(makeOpenRouterResponse([OPENROUTER_MODEL]));

        const catalog = new OpenRouterCatalog({
            baseUrl: 'https://openrouter.example.com/api/v1',
            fetchFn: mockFetch,
        });

        await Promise.all([catalog.fetch(), catalog.fetch()]);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not re-fetch after successful load', async () => {
        mockFetch.mockResolvedValue(makeOpenRouterResponse([OPENROUTER_MODEL]));

        const catalog = new OpenRouterCatalog({
            baseUrl: 'https://openrouter.example.com/api/v1',
            fetchFn: mockFetch,
        });

        await catalog.fetch();
        await catalog.fetch();
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('falls back to StaticCatalog on HTTP error', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
        } as Response);

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const fallback = new StaticCatalog();
        const catalog = new OpenRouterCatalog({
            baseUrl: 'https://openrouter.example.com/api/v1',
            fallback,
            fetchFn: mockFetch,
        });

        await catalog.fetch();
        expect(catalog.isLoaded).toBe(true);
        expect(catalog.getModel('claude-sonnet-4-20250514')).not.toBeNull();

        warnSpy.mockRestore();
    });

    it('falls back to StaticCatalog on network error', async () => {
        mockFetch.mockRejectedValueOnce(new Error('ENOTFOUND'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const fallback = new StaticCatalog();
        const catalog = new OpenRouterCatalog({
            baseUrl: 'https://openrouter.example.com/api/v1',
            fallback,
            fetchFn: mockFetch,
        });

        await catalog.fetch();
        expect(catalog.isLoaded).toBe(true);
        expect(catalog.getModel('gpt-4o')).not.toBeNull();

        warnSpy.mockRestore();
    });

    it('returns null when no fallback and fetch fails', async () => {
        mockFetch.mockRejectedValueOnce(new Error('down'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const catalog = new OpenRouterCatalog({
            baseUrl: 'https://openrouter.example.com/api/v1',
            fetchFn: mockFetch,
        });

        await catalog.fetch();
        expect(catalog.getModel('anything')).toBeNull();

        warnSpy.mockRestore();
    });

    it('handles non-numeric pricing strings gracefully (NaN guard)', async () => {
        mockFetch.mockResolvedValueOnce(makeOpenRouterResponse([
            {
                id: 'free-model',
                context_length: 8192,
                max_completion_tokens: 4096,
                pricing: { prompt: 'free', completion: '0.000001' },
                architecture: { modality: 'text' },
                supported_parameters: [],
            },
            {
                id: 'both-free',
                context_length: 8192,
                max_completion_tokens: 4096,
                pricing: { prompt: 'free', completion: 'free' },
                architecture: { modality: 'text' },
                supported_parameters: [],
            },
        ]));

        const catalog = new OpenRouterCatalog({
            baseUrl: 'https://openrouter.example.com/api/v1',
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        // "free" prompt → 0, valid completion → should have pricing with input=0
        const freeModel = catalog.getModel('free-model');
        expect(freeModel).not.toBeNull();
        expect(freeModel!.pricing).toBeDefined();
        expect(freeModel!.pricing!.input).toBe(0);
        expect(Number.isFinite(freeModel!.pricing!.output)).toBe(true);
        expect(freeModel!.pricing!.output).toBeCloseTo(1.0, 5);

        // Both free → no pricing
        const bothFree = catalog.getModel('both-free');
        expect(bothFree).not.toBeNull();
        expect(bothFree!.pricing).toBeUndefined();
    });

    it('skips models without max output tokens', async () => {
        mockFetch.mockResolvedValueOnce(makeOpenRouterResponse([
            { id: 'no-output', context_length: 1000 },  // no max_completion_tokens or top_provider
        ]));

        const catalog = new OpenRouterCatalog({
            baseUrl: 'https://openrouter.example.com/api/v1',
            fetchFn: mockFetch,
        });

        await catalog.fetch();
        expect(catalog.getModel('no-output')).toBeNull();
    });

    it('lazy-triggers fetch on getModel() if not yet started', async () => {
        mockFetch.mockResolvedValueOnce(makeOpenRouterResponse([OPENROUTER_MODEL]));

        const catalog = new OpenRouterCatalog({
            baseUrl: 'https://openrouter.example.com/api/v1',
            fetchFn: mockFetch,
        });

        const result = catalog.getModel('anthropic/claude-3.5-sonnet');
        expect(result).toBeNull();

        await catalog.fetch();
        expect(catalog.getModel('anthropic/claude-3.5-sonnet')).not.toBeNull();
    });
});

// --- M11 Review: String coercion regression tests ---

describe('M11 Review — toPositiveInt string coercion', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockFetch = vi.fn();
    });

    it('NanoGptCatalog parses string context_length and max_output_tokens', async () => {
        mockFetch.mockResolvedValueOnce(makeNanoGptResponse([
            {
                id: 'string-limits-model',
                context_length: '131072',  // string instead of number
                max_output_tokens: '65536', // string instead of number
                capabilities: { tool_calling: true },
            },
        ]));

        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        const entry = catalog.getModel('string-limits-model');
        expect(entry).not.toBeNull();
        expect(entry!.contextLength).toBe(131_072);
        expect(entry!.maxOutputTokens).toBe(65_536);
    });

    it('OpenRouterCatalog parses string context_length and max_completion_tokens', async () => {
        mockFetch.mockResolvedValueOnce(makeOpenRouterResponse([
            {
                id: 'string-limits-or',
                context_length: '200000',
                max_completion_tokens: '8192',
                architecture: { modality: 'text' },
                supported_parameters: ['tools'],
            },
        ]));

        const catalog = new OpenRouterCatalog({
            baseUrl: 'https://openrouter.example.com/api/v1',
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        const entry = catalog.getModel('string-limits-or');
        expect(entry).not.toBeNull();
        expect(entry!.contextLength).toBe(200_000);
        expect(entry!.maxOutputTokens).toBe(8192);
    });

    it('rejects non-numeric strings gracefully', async () => {
        mockFetch.mockResolvedValueOnce(makeNanoGptResponse([
            {
                id: 'bad-strings-model',
                context_length: 'unlimited',
                max_output_tokens: 'N/A',
            },
        ]));

        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fetchFn: mockFetch,
        });

        await catalog.fetch();
        expect(catalog.getModel('bad-strings-model')).toBeNull();
    });

    it('rejects empty string and zero values', async () => {
        mockFetch.mockResolvedValueOnce(makeNanoGptResponse([
            { id: 'empty-string', context_length: '', max_output_tokens: 65536 },
            { id: 'zero-context', context_length: 0, max_output_tokens: 65536 },
            { id: 'zero-output', context_length: 65536, max_output_tokens: 0 },
        ]));

        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fetchFn: mockFetch,
        });

        await catalog.fetch();
        expect(catalog.getModel('empty-string')).toBeNull();
        expect(catalog.getModel('zero-context')).toBeNull();
        expect(catalog.getModel('zero-output')).toBeNull();
    });

    it('handles float strings by flooring to integer', async () => {
        mockFetch.mockResolvedValueOnce(makeNanoGptResponse([
            {
                id: 'float-strings',
                context_length: '131072.9',
                max_output_tokens: '65536.1',
                capabilities: {},
            },
        ]));

        const catalog = new NanoGptCatalog({
            apiKey: 'key',
            baseUrl: 'https://api.example.com',
            fetchFn: mockFetch,
        });

        await catalog.fetch();

        const entry = catalog.getModel('float-strings');
        expect(entry).not.toBeNull();
        expect(entry!.contextLength).toBe(131_072);
        expect(entry!.maxOutputTokens).toBe(65_536);
    });
});
