import type {
    ProviderDriver,
    ProviderConfig,
    ModelCapabilities,
    ModelRequest,
    StreamEvent,
    StreamErrorEvent,
    Result,
    ConfigError,
    TokenUsage,
    ExtensionRequest,
} from '../types/provider.js';
import { getModelCapabilitiesOrDefaults } from './model-registry.js';
import type { ModelCatalog } from './model-catalog.js';
import { parseSSE } from './sse-parser.js';
import { injectToolsIntoRequest, wrapStreamWithToolEmulation } from './tool-emulation.js';
import { DEFAULT_API_TIMEOUT_MS } from '../config/schema.js';

export interface NanoGptDriverOptions {
    apiKey?: string;
    baseUrl?: string;
    timeout?: number;
    catalog?: ModelCatalog;
}

/**
 * NanoGPT is a meta-provider (proxies to Claude, GPT, DeepSeek, etc.).
 * It does not natively implement any provider-specific extension types,
 * so all extensions are treated as unsupported by this driver.
 */
const SUPPORTED_EXTENSIONS: readonly string[] = [];

/**
 * NanoGPT provider driver.
 * Uses an OpenAI-compatible chat completions API.
 * One driver exposes multiple underlying models (Claude, GPT, DeepSeek, etc.).
 */
export class NanoGptDriver implements ProviderDriver {
    private readonly apiKey: string | undefined;
    private readonly baseUrl: string;
    private readonly timeout: number;
    private readonly catalog: ModelCatalog | undefined;

    constructor(options: NanoGptDriverOptions = {}) {
        this.apiKey = options.apiKey ?? process.env.NANOGPT_API_KEY;
        // Subscription endpoint: model availability differs from the paid-compatible
        // api.nano-gpt.com/v1 endpoint. ACA keeps catalog discovery and invocation on
        // the same subscription API path so a listed model is actually invokable.
        this.baseUrl = options.baseUrl ?? 'https://nano-gpt.com/api/subscription/v1';
        // Most callers pass `config.apiTimeout` explicitly. The fallback exists so
        // direct constructor uses (e.g. tests) get the project-wide default rather than
        // the legacy 30s value that would prematurely abort slow-model streams.
        this.timeout = options.timeout ?? DEFAULT_API_TIMEOUT_MS;
        this.catalog = options.catalog;
    }

    validate(config: ProviderConfig): Result<void, ConfigError> {
        const key = this.apiKey;
        if (!key || key.trim() === '') {
            return {
                ok: false,
                error: {
                    code: 'config.missing_api_key',
                    message: 'NANOGPT_API_KEY environment variable is not set or empty',
                },
            };
        }

        try {
            new URL(config.baseUrl);
        } catch {
            return {
                ok: false,
                error: {
                    code: 'config.invalid_base_url',
                    message: `Invalid base URL: ${config.baseUrl}`,
                },
            };
        }

        return { ok: true, value: undefined };
    }

    capabilities(model: string): ModelCapabilities {
        if (this.catalog) {
            const entry = this.catalog.getModel(model);
            if (entry) {
                // Catalog provides runtime-discovered limits; static registry
                // fills in behavioral details (toolReliability, specialFeatures, etc.)
                const base = getModelCapabilitiesOrDefaults(model);
                return {
                    ...base,
                    maxContext: entry.contextLength,
                    maxOutput: entry.maxOutputTokens,
                    supportsVision: entry.capabilities.vision,
                    supportsTools: entry.capabilities.toolCalling
                        ? (base.supportsTools !== 'none' ? base.supportsTools : 'native')
                        : 'none',
                    costPerMillion: entry.pricing
                        ? { input: entry.pricing.input, output: entry.pricing.output }
                        : base.costPerMillion,
                };
            }
        }
        return getModelCapabilitiesOrDefaults(model);
    }

    async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
        // Check extensions — NanoGPT has no native extension support
        const extError = checkExtensions(
            request.extensions ?? [],
            SUPPORTED_EXTENSIONS,
            'NanoGPT',
        );
        if (extError) {
            yield extError;
            return;
        }

        // Tool emulation: when the model doesn't support native tool calling,
        // inject tool schemas into the system prompt and post-process the response.
        let caps: ModelCapabilities | undefined;
        try {
            caps = this.capabilities(request.model);
        } catch {
            caps = undefined;
        }

        const needsEmulation =
            caps?.supportsTools === 'emulated' &&
            !!request.tools &&
            request.tools.length > 0;

        const effectiveRequest = needsEmulation ? injectToolsIntoRequest(request) : request;

        if (needsEmulation) {
            yield* wrapStreamWithToolEmulation(this.rawStream(effectiveRequest));
        } else {
            yield* this.rawStream(effectiveRequest);
        }
    }

    private async *rawStream(request: ModelRequest): AsyncGenerator<StreamEvent> {
        const body = this.buildRequestBody(request);

        const controller = new AbortController();
        // Idle timeout (not a hard deadline): the timer resets on each SSE event.
        // As long as the model keeps producing tokens, the stream stays alive
        // indefinitely. Only fires when the stream goes truly silent (no data
        // for `this.timeout` ms). This prevents killing slow-but-active streams
        // while still catching dead connections and stalled responses.
        let timer = setTimeout(() => controller.abort(), this.timeout);
        const resetIdleTimer = () => {
            clearTimeout(timer);
            timer = setTimeout(() => controller.abort(), this.timeout);
        };

        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (err: unknown) {
            clearTimeout(timer);
            if (isAbortError(err)) {
                yield errorEvent('llm.timeout', 'Request timed out');
                return;
            }
            yield errorEvent('llm.server_error', `Connection failed: ${String(err)}`);
            return;
        }

        if (!response.ok) {
            clearTimeout(timer);
            yield await this.mapHttpError(response);
            return;
        }

        // Connection established — reset idle timer for the streaming phase
        resetIdleTimer();

        // Parse SSE stream and normalize to StreamEvents
        let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
        let finishReason = 'stop';
        let streamError: StreamErrorEvent | null = null;

        try {
            for await (const sseEvent of parseSSE(response)) {
                resetIdleTimer();

                if (sseEvent.data === '[DONE]') {
                    break;
                }

                let parsed: Record<string, unknown>;
                try {
                    parsed = JSON.parse(sseEvent.data) as Record<string, unknown>;
                } catch {
                    streamError = errorEvent('llm.malformed_response', `Invalid JSON in SSE data: ${sseEvent.data.slice(0, 100)}`);
                    break;
                }

                const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
                const choice = choices?.[0];
                if (!choice) continue;

                if (choice.finish_reason) {
                    finishReason = String(choice.finish_reason);
                }

                const rawUsage = parsed.usage as Record<string, number> | undefined;
                if (rawUsage) {
                    usage = {
                        inputTokens: rawUsage.prompt_tokens ?? 0,
                        outputTokens: rawUsage.completion_tokens ?? 0,
                    };
                }

                const delta = choice.delta as Record<string, unknown> | undefined;
                if (!delta) continue;

                if (typeof delta.content === 'string' && delta.content.length > 0) {
                    yield { type: 'text_delta' as const, text: delta.content };
                }

                const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
                if (toolCalls) {
                    for (const tc of toolCalls) {
                        const fn = tc.function as Record<string, string> | undefined;
                        // Pass `id` through so the turn-engine accumulator can
                        // distinguish parallel tool calls that collide on `index`.
                        // See ToolCallDeltaEvent docs for the gemma backend story.
                        const tcId = typeof tc.id === 'string' ? tc.id : undefined;
                        yield {
                            type: 'tool_call_delta' as const,
                            index: (tc.index as number) ?? 0,
                            id: tcId,
                            name: fn?.name,
                            arguments: fn?.arguments,
                        };
                    }
                }
            }
        } catch (err: unknown) {
            if (isAbortError(err)) {
                streamError = errorEvent('llm.timeout', 'Stream timed out');
            } else {
                streamError = errorEvent('llm.server_error', `Stream interrupted: ${String(err)}`);
            }
        } finally {
            clearTimeout(timer);
            // Cancel response body to release TCP connection
            await response.body?.cancel().catch(() => {});
        }

        if (streamError) {
            yield streamError;
            return;
        }

        yield { type: 'done' as const, finishReason, usage };
    }

    private getMaxOutputForModel(model: string): number | undefined {
        if (!this.catalog) return undefined;
        const entry = this.catalog.getModel(model);
        return entry?.maxOutputTokens;
    }

    private buildRequestBody(request: ModelRequest): Record<string, unknown> {
        // Use the catalog's maxOutputTokens (actual model ceiling) when available,
        // otherwise fall back to whatever the caller specified
        const maxTokens = this.getMaxOutputForModel(request.model) ?? request.maxTokens;

        const body: Record<string, unknown> = {
            model: request.model,
            messages: request.messages.map(msg => {
                const out: Record<string, unknown> = {
                    role: msg.role,
                };
                if (typeof msg.content === 'string') {
                    out.content = msg.content;
                } else {
                    // Content parts — extract text and tool calls
                    const textParts = msg.content
                        .filter(p => p.type === 'text')
                        .map(p => p.text)
                        .join('');
                    if (textParts) out.content = textParts;

                    const toolCallParts = msg.content.filter(p => p.type === 'tool_call');
                    if (toolCallParts.length > 0) {
                        out.tool_calls = toolCallParts.map((p, i) => ({
                            id: p.toolCallId,
                            type: 'function',
                            index: i,
                            function: {
                                name: p.toolName,
                                arguments: JSON.stringify(p.arguments ?? {}),
                            },
                        }));
                    }
                }
                if (msg.toolCallId) {
                    out.tool_call_id = msg.toolCallId;
                }
                return out;
            }),
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: maxTokens,
            temperature: request.temperature,
        };
        if (request.topP !== undefined) {
            body.top_p = request.topP;
        }
        if (request.thinking !== undefined) {
            body.thinking = request.thinking;
        }

        if (request.tools && request.tools.length > 0) {
            body.tools = request.tools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                },
            }));
            body.tool_choice = 'auto';
        } else {
            body.tool_choice = 'none';
        }

        return body;
    }

    private async mapHttpError(response: Response): Promise<StreamErrorEvent> {
        let message: string;
        try {
            const body = await response.json() as Record<string, unknown>;
            const err = body.error as Record<string, string> | undefined;
            message = err?.message ?? response.statusText;
        } catch {
            message = response.statusText || `HTTP ${response.status}`;
        }

        const status = response.status;
        if (status === 400) {
            return errorEvent('llm.invalid_request', message);
        }
        if (status === 401 || status === 403) {
            return errorEvent('llm.auth_error', message);
        }
        if (status === 429) {
            return errorEvent('llm.rate_limited', message);
        }
        if (status >= 500) {
            return errorEvent('llm.server_error', message);
        }
        return errorEvent('llm.server_error', `HTTP ${status}: ${message}`);
    }
}

function checkExtensions(
    extensions: ExtensionRequest[],
    supportedTypes: readonly string[],
    driverName: string,
): StreamErrorEvent | null {
    for (const ext of extensions) {
        if (!supportedTypes.includes(ext.type)) {
            if (ext.required) {
                return errorEvent(
                    'llm.unsupported_feature',
                    `Extension '${ext.type}' is not supported by ${driverName} driver`,
                );
            } else {
                console.warn(`[${driverName}] Unsupported optional extension '${ext.type}' — ignoring`);
            }
        }
    }
    return null;
}

function errorEvent(code: string, message: string): StreamErrorEvent {
    return { type: 'error', error: { code, message } };
}

function isAbortError(err: unknown): boolean {
    if (err instanceof DOMException && err.name === 'AbortError') return true;
    if (err instanceof Error && err.name === 'AbortError') return true;
    return false;
}
