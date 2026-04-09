/**
 * Provider-agnostic model catalog.
 *
 * Fetches model capabilities at runtime from provider APIs.
 * NanoGPT and OpenRouter get live implementations; Anthropic/OpenAI
 * (and offline fallback) use a static catalog backed by models.json.
 */

import { getModelCapabilities, getKnownModelIds } from './model-registry.js';

// --- Types ---

export interface ModelCatalogEntry {
    id: string;
    contextLength: number;
    maxOutputTokens: number;
    capabilities: {
        vision: boolean;
        toolCalling: boolean;
        reasoning: boolean;
        structuredOutput: boolean;
    };
    pricing?: {
        input: number;   // cost per million input tokens
        output: number;  // cost per million output tokens
    };
}

export interface ModelCatalog {
    /** Fetch model data from the provider API. Safe to call multiple times (deduped). */
    fetch(): Promise<void>;
    /** Get a model entry by ID. Returns null if not found or not yet loaded. */
    getModel(id: string): ModelCatalogEntry | null;
    /** Whether fetch() has completed (successfully or via fallback). */
    readonly isLoaded: boolean;
}

export class NanoGptCatalogError extends Error {
    readonly code: 'auth_error' | 'network_error' | 'malformed_response';
    readonly status?: number;

    constructor(
        code: 'auth_error' | 'network_error' | 'malformed_response',
        message: string,
        status?: number,
    ) {
        super(message);
        this.name = 'NanoGptCatalogError';
        this.code = code;
        this.status = status;
    }
}

// --- StaticCatalog ---

/**
 * Wraps the existing models.json registry as a ModelCatalog.
 * Used as offline fallback for live catalogs.
 */
export class StaticCatalog implements ModelCatalog {
    private readonly entries = new Map<string, ModelCatalogEntry>();

    constructor() {
        for (const id of getKnownModelIds()) {
            const caps = getModelCapabilities(id);
            if (!caps) continue;
            this.entries.set(id, {
                id,
                contextLength: caps.maxContext,
                maxOutputTokens: caps.maxOutput,
                capabilities: {
                    vision: caps.supportsVision,
                    toolCalling: caps.supportsTools !== 'none',
                    reasoning: caps.specialFeatures.includes('deepseek-reasoning') ||
                               caps.specialFeatures.includes('claude-extended-thinking') ||
                               caps.specialFeatures.includes('glm-reasoning'),
                    structuredOutput: caps.supportsTools === 'native',
                },
                pricing: caps.costPerMillion.input > 0 || caps.costPerMillion.output > 0
                    ? { input: caps.costPerMillion.input, output: caps.costPerMillion.output }
                    : undefined,
            });
        }
    }

    async fetch(): Promise<void> {
        // Static — nothing to fetch
    }

    getModel(id: string): ModelCatalogEntry | null {
        return this.entries.get(id) ?? null;
    }

    get isLoaded(): boolean {
        return true;
    }
}

// --- NanoGptCatalog ---

export interface NanoGptCatalogOptions {
    apiKey?: string;
    /**
     * Host root for NanoGPT (no endpoint suffix). Defaults to the same
     * nano-gpt.com/api family used by the subscription chat endpoint.
     * The catalog calls /subscription/v1/models?detailed=true so discovery matches
     * the subscription invocation path used by the NanoGPT driver.
     */
    baseUrl?: string;
    timeout?: number;
    fallback?: ModelCatalog;
    /** Injectable fetch for testing */
    fetchFn?: typeof globalThis.fetch;
}

/**
 * Live catalog for NanoGPT.
 * Calls GET <baseUrl>/subscription/v1/models?detailed=true with auth header.
 * Falls back to StaticCatalog on failure.
 *
 * Note: NanoGPT's general /v1/models and subscription endpoints can expose
 * different model sets. ACA deliberately uses the subscription endpoint here
 * so catalog discovery and invocation agree.
 */
export class NanoGptCatalog implements ModelCatalog {
    private readonly entries = new Map<string, ModelCatalogEntry>();
    private loaded = false;
    private fetchPromise: Promise<void> | null = null;
    private readonly apiKey: string | undefined;
    private readonly baseUrl: string;
    private readonly timeout: number;
    private readonly fallback: ModelCatalog | undefined;
    private readonly fetchFn: typeof globalThis.fetch;

    constructor(options: NanoGptCatalogOptions = {}) {
        this.apiKey = options.apiKey ?? process.env.NANOGPT_API_KEY;
        this.baseUrl = options.baseUrl ?? 'https://nano-gpt.com/api';
        this.timeout = options.timeout ?? 10_000;
        this.fallback = options.fallback;
        this.fetchFn = options.fetchFn ?? globalThis.fetch;
    }

    async fetch(): Promise<void> {
        if (this.loaded) return;
        if (this.fetchPromise) return this.fetchPromise;
        this.fetchPromise = this.doFetch(true);
        return this.fetchPromise;
    }

    async probe(): Promise<void> {
        if (this.loaded) return;
        await this.doFetch(false);
    }

    getModel(id: string): ModelCatalogEntry | null {
        // Lazy init: trigger fetch if not started
        if (!this.loaded && !this.fetchPromise) {
            this.fetchPromise = this.doFetch(true);
        }
        return this.entries.get(id) ?? null;
    }

    get isLoaded(): boolean {
        return this.loaded;
    }

    private async doFetch(allowFallback: boolean): Promise<void> {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeout);

            try {
                const url = `${this.baseUrl}/subscription/v1/models?detailed=true`;
                const response = await this.fetchFn(url, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Accept': 'application/json',
                    },
                    signal: controller.signal,
                });

                if (!response.ok) {
                    const code = response.status === 401 || response.status === 403
                        ? 'auth_error'
                        : 'network_error';
                    throw new NanoGptCatalogError(
                        code,
                        `HTTP ${response.status}: ${response.statusText}`,
                        response.status,
                    );
                }

                const body = await response.json() as NanoGptModelsResponse;
                this.parseNanoGptResponse(body);
                // Guard against silently empty catalogs: if the response parsed
                // to zero usable entries, treat it as a fetch failure so we fall
                // back to StaticCatalog. This catches schema drift where the
                // endpoint starts returning a shape the parser doesn't recognize.
                if (this.entries.size === 0) {
                    throw new NanoGptCatalogError(
                        'malformed_response',
                        'parsed 0 usable model entries from response',
                    );
                }
                this.loaded = true;
                return;
            } finally {
                clearTimeout(timer);
            }
        } catch (err: unknown) {
            if (!allowFallback) {
                if (err instanceof NanoGptCatalogError) throw err;
                if (err instanceof Error && err.name === 'AbortError') {
                    throw new NanoGptCatalogError('network_error', 'catalog probe timed out');
                }
                throw new NanoGptCatalogError(
                    'network_error',
                    err instanceof Error ? err.message : String(err),
                );
            }
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[NanoGptCatalog] Failed to fetch models: ${msg}. Falling back to static catalog.`);
        }

        // Fallback
        if (this.fallback) {
            await this.fallback.fetch();
            for (const id of getKnownModelIds()) {
                const entry = this.fallback.getModel(id);
                if (entry) this.entries.set(id, entry);
            }
        }
        this.loaded = true;
    }

    private parseNanoGptResponse(body: NanoGptModelsResponse): void {
        const models = body.data ?? body.models ?? [];
        for (const m of models) {
            if (!m.id || typeof m.id !== 'string') continue;

            const contextLength = toPositiveInt(m.context_length);
            const maxOutputTokens = toPositiveInt(m.max_output_tokens);
            if (!contextLength || !maxOutputTokens) continue;

            const caps = m.capabilities ?? {};
            const pricing = m.pricing;
            // Explicit Number() — API may return strings like "0.25"
            const pricingInput = pricing ? Number(pricing.input) : 0;
            const pricingOutput = pricing ? Number(pricing.output) : 0;

            this.entries.set(m.id, {
                id: m.id,
                contextLength,
                maxOutputTokens,
                capabilities: {
                    vision: Boolean(caps.vision),
                    toolCalling: Boolean(caps.tool_calling),
                    reasoning: Boolean(caps.reasoning),
                    structuredOutput: Boolean(caps.structured_output),
                },
                pricing: Number.isFinite(pricingInput) && Number.isFinite(pricingOutput)
                    && (pricingInput > 0 || pricingOutput > 0)
                    ? { input: pricingInput, output: pricingOutput }
                    : undefined,
            });
        }
    }
}

// --- OpenRouterCatalog ---

export interface OpenRouterCatalogOptions {
    baseUrl?: string;
    timeout?: number;
    fallback?: ModelCatalog;
    fetchFn?: typeof globalThis.fetch;
}

/**
 * Live catalog for OpenRouter.
 * Calls GET <baseUrl>/models (no auth required for model listing).
 * Falls back to StaticCatalog on failure.
 */
export class OpenRouterCatalog implements ModelCatalog {
    private readonly entries = new Map<string, ModelCatalogEntry>();
    private loaded = false;
    private fetchPromise: Promise<void> | null = null;
    private readonly baseUrl: string;
    private readonly timeout: number;
    private readonly fallback: ModelCatalog | undefined;
    private readonly fetchFn: typeof globalThis.fetch;

    constructor(options: OpenRouterCatalogOptions = {}) {
        this.baseUrl = options.baseUrl ?? 'https://openrouter.ai/api/v1';
        this.timeout = options.timeout ?? 10_000;
        this.fallback = options.fallback;
        this.fetchFn = options.fetchFn ?? globalThis.fetch;
    }

    async fetch(): Promise<void> {
        if (this.loaded) return;
        if (this.fetchPromise) return this.fetchPromise;
        this.fetchPromise = this.doFetch();
        return this.fetchPromise;
    }

    getModel(id: string): ModelCatalogEntry | null {
        if (!this.loaded && !this.fetchPromise) {
            this.fetchPromise = this.doFetch();
        }
        return this.entries.get(id) ?? null;
    }

    get isLoaded(): boolean {
        return this.loaded;
    }

    private async doFetch(): Promise<void> {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeout);

            try {
                const url = `${this.baseUrl}/models`;
                const response = await this.fetchFn(url, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: controller.signal,
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const body = await response.json() as OpenRouterModelsResponse;
                this.parseOpenRouterResponse(body);
                this.loaded = true;
                return;
            } finally {
                clearTimeout(timer);
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[OpenRouterCatalog] Failed to fetch models: ${msg}. Falling back to static catalog.`);
        }

        if (this.fallback) {
            await this.fallback.fetch();
            for (const id of getKnownModelIds()) {
                const entry = this.fallback.getModel(id);
                if (entry) this.entries.set(id, entry);
            }
        }
        this.loaded = true;
    }

    private parseOpenRouterResponse(body: OpenRouterModelsResponse): void {
        const models = body.data ?? [];
        for (const m of models) {
            if (!m.id || typeof m.id !== 'string') continue;

            const contextLength = toPositiveInt(m.context_length);
            // OpenRouter: max_completion_tokens, or top_provider.max_completion_tokens
            const maxOutputTokens = toPositiveInt(m.max_completion_tokens)
                ?? toPositiveInt(m.top_provider?.max_completion_tokens);
            if (!contextLength || !maxOutputTokens) continue;

            const pricing = m.pricing;
            const promptPrice = pricing ? parseFloat(String(pricing.prompt)) : 0;
            const completionPrice = pricing ? parseFloat(String(pricing.completion)) : 0;

            // Guard against NaN from non-numeric strings like "free"
            const safePromptPrice = Number.isFinite(promptPrice) ? promptPrice : 0;
            const safeCompletionPrice = Number.isFinite(completionPrice) ? completionPrice : 0;

            this.entries.set(m.id, {
                id: m.id,
                contextLength,
                maxOutputTokens,
                capabilities: {
                    vision: Boolean(m.architecture?.modality?.includes('image')),
                    toolCalling: Boolean(m.supported_parameters?.includes('tools')),
                    reasoning: Boolean(m.architecture?.modality?.includes('reasoning')),
                    structuredOutput: Boolean(m.supported_parameters?.includes('response_format')),
                },
                // OpenRouter pricing is per-token; convert to per-million
                pricing: (safePromptPrice > 0 || safeCompletionPrice > 0)
                    ? { input: safePromptPrice * 1_000_000, output: safeCompletionPrice * 1_000_000 }
                    : undefined,
            });
        }
    }
}

// --- Internal types for API responses ---

interface NanoGptModelEntry {
    id: string;
    context_length?: number;
    max_output_tokens?: number;
    capabilities?: {
        vision?: boolean;
        tool_calling?: boolean;
        reasoning?: boolean;
        structured_output?: boolean;
    };
    pricing?: {
        input: number;
        output: number;
    };
}

interface NanoGptModelsResponse {
    data?: NanoGptModelEntry[];
    models?: NanoGptModelEntry[];
}

interface OpenRouterModelEntry {
    id: string;
    context_length?: number;
    max_completion_tokens?: number;
    top_provider?: {
        max_completion_tokens?: number;
    };
    pricing?: {
        prompt?: string | number;
        completion?: string | number;
    };
    architecture?: {
        modality?: string;
    };
    supported_parameters?: string[];
}

interface OpenRouterModelsResponse {
    data?: OpenRouterModelEntry[];
}

// --- Helpers ---

function toPositiveInt(value: unknown): number | null {
    // Coerce strings to numbers — some APIs return "65536" instead of 65536
    const num = typeof value === 'string' ? Number(value) : value;
    if (typeof num !== 'number' || !Number.isFinite(num) || num < 1) {
        return null;
    }
    return Math.floor(num);
}
