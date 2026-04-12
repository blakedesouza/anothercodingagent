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
import { injectToolsIntoRequest, wrapStreamWithToolEmulation, wrapStreamWithPreambleStrip } from './tool-emulation.js';
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
                // fills in behavioral details (toolReliability, specialFeatures, etc.).
                // NanoGPT invocation intentionally forces ACA-managed tool
                // emulation for every tool-enabled model, even if the upstream
                // routed model advertises native tool calling.
                const base = getModelCapabilitiesOrDefaults(model);
                return {
                    ...base,
                    maxContext: entry.contextLength,
                    maxOutput: entry.maxOutputTokens,
                    supportsVision: entry.capabilities.vision,
                    supportsTools: entry.capabilities.toolCalling ? 'emulated' : 'none',
                    costPerMillion: entry.pricing
                        ? { input: entry.pricing.input, output: entry.pricing.output }
                        : base.costPerMillion,
                };
            }
        }
        const base = getModelCapabilitiesOrDefaults(model);
        return {
            ...base,
            supportsTools: base.supportsTools === 'none' ? 'none' : 'emulated',
        };
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

        // NanoGPT is a routing/meta-provider. Keep ACA's tool protocol under our
        // control by emulating tools in-prompt and forcing native tool_choice=none
        // in the upstream OpenAI-compatible request.
        const needsEmulation = !!request.tools && request.tools.length > 0;

        const effectiveRequest = needsEmulation
            ? injectToolsIntoRequest({ ...request, responseFormat: undefined })
            : request;

        if (needsEmulation) {
            yield* wrapStreamWithToolEmulation(this.rawStream(effectiveRequest));
        } else {
            // No tools, but still strip model preambles (e.g. Qwen's
            // "Thinking...\n> ..." thinking blocks) from the raw stream.
            yield* wrapStreamWithPreambleStrip(this.rawStream(effectiveRequest));
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

        if (process.env.NANOGPT_DEBUG) {
            const debugBody = { ...body, messages: (body.messages as unknown[]).length + ' messages' };
            process.stderr.write(`[NANOGPT_DEBUG] REQUEST body (summary): ${JSON.stringify(debugBody)}\n`);
            process.stderr.write(`[NANOGPT_DEBUG] REQUEST has tools: ${JSON.stringify((body as Record<string,unknown>).tools ?? null)}\n`);
            process.stderr.write(`[NANOGPT_DEBUG] REQUEST tool_choice: ${JSON.stringify((body as Record<string,unknown>).tool_choice ?? null)}\n`);
        }

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

        const debugMode = process.env.NANOGPT_DEBUG === '1';

        try {
            for await (const sseEvent of parseSSE(response)) {
                resetIdleTimer();

                if (debugMode) {
                    process.stderr.write(`[NANOGPT_DEBUG] SSE data: ${sseEvent.data}\n`);
                }

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

                // Some models emit reasoning/thinking tokens in a separate field
                // rather than delta.content. Two field names are in use:
                //   delta.reasoning_content — Qwen3, DeepSeek R1, OpenAI o-series
                //   delta.reasoning          — GLM-5, GLM-4.x (ZhipuAI format)
                // These are NOT yielded as text_delta — reasoning is internal CoT and
                // must not contaminate the response text buffer used by tool emulation.
                // (Qwen's blockquote-format reasoning in delta.content is handled by
                // stripModelPreamble in tool-emulation.ts.)

                const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
                if (toolCalls) {
                    for (const tc of toolCalls) {
                        const fn = tc.function as Record<string, string> | undefined;
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

        // Emulation mode: no tool schemas are sent to the API; the model generates
        // tool calls as plain JSON text which we extract locally. In this mode we
        // must NOT re-serialize those extracted calls back as native tool_calls in
        // subsequent turns, because models like DeepSeek will then respond with
        // native function calls that NanoGPT rejects (502 malformed_tool_call).
        // Detect emulation mode by the absence of a tool schema on the request.
        const isEmulationMode = !request.tools || request.tools.length === 0;

        const body: Record<string, unknown> = {
            model: request.model,
            messages: request.messages.map(msg => {
                // In emulation mode, tool results must be role:user. Sending them
                // as role:tool without a matching native tool schema in the request
                // causes strict models to attempt (and fail) native function calls.
                const effectiveRole = isEmulationMode && msg.role === 'tool' ? 'user' : msg.role;
                const out: Record<string, unknown> = {
                    role: effectiveRole,
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
                        if (isEmulationMode) {
                            // Re-encode as emulation JSON text so the model sees its
                            // own output format rather than a native tool_calls field
                            // that has no corresponding tool schema in this request.
                            const emulationJson = JSON.stringify({
                                tool_calls: toolCallParts.map(p => ({
                                    name: p.toolName,
                                    arguments: p.arguments ?? {},
                                })),
                            }, null, 4);
                            out.content = textParts ? `${textParts}\n${emulationJson}` : emulationJson;
                        } else {
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
                }
                if (!isEmulationMode && msg.toolCallId) {
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
        if (request.responseFormat !== undefined && this.supportsResponseFormat(request.model)) {
            body.response_format = request.responseFormat;
        }

        body.tool_choice = 'none';

        return body;
    }

    private supportsResponseFormat(model: string): boolean {
        const entry = this.catalog?.getModel(model);
        return entry?.capabilities.structuredOutput !== false;
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
