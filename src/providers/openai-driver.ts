import type {
    ProviderDriver,
    ProviderConfig,
    ModelCapabilities,
    ModelRequest,
    StreamEvent,
    StreamErrorEvent,
    EmbeddingResult,
    Result,
    ConfigError,
    TokenUsage,
    ExtensionRequest,
} from '../types/provider.js';
import { getModelCapabilities, getKnownModelIds } from './model-registry.js';
import { parseSSE } from './sse-parser.js';

export interface OpenAiDriverOptions {
    apiKey?: string;
    baseUrl?: string;
    timeout?: number;
}

/** Model ID prefixes served by the direct OpenAI driver. */
const SUPPORTED_PREFIXES = ['gpt-', 'o1-', 'o3-'];

/** Extension types natively handled by the OpenAI driver. */
const SUPPORTED_EXTENSIONS: readonly string[] = ['openai-reasoning'];

/**
 * OpenAI provider driver.
 * Communicates with the OpenAI API using OpenAI-compatible SSE format.
 * Supports gpt-*, o1-*, and o3-* models.
 */
export class OpenAiDriver implements ProviderDriver {
    private readonly apiKey: string | undefined;
    private readonly baseUrl: string;
    private readonly timeout: number;

    constructor(options: OpenAiDriverOptions = {}) {
        this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
        this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
        this.timeout = options.timeout ?? 30_000;
    }

    validate(config: ProviderConfig): Result<void, ConfigError> {
        if (!this.apiKey || this.apiKey.trim() === '') {
            return {
                ok: false,
                error: {
                    code: 'config.missing_api_key',
                    message: 'OPENAI_API_KEY environment variable is not set or empty',
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
        if (!SUPPORTED_PREFIXES.some(prefix => model.startsWith(prefix))) {
            throw new Error(
                `OpenAiDriver: unsupported model '${model}'. ` +
                `Only ${SUPPORTED_PREFIXES.join(', ')} models are supported.`,
            );
        }
        const caps = getModelCapabilities(model);
        if (!caps) {
            throw new Error(`Unknown model: ${model}. Known models: ${getKnownModelIds().join(', ')}`);
        }
        return caps;
    }

    /** embed() is deferred until M6 — throws an Error with code='not_implemented'. */
    async embed(_texts: string[], _model: string): Promise<EmbeddingResult> {
        throw Object.assign(new Error('OpenAiDriver.embed() is deferred until M6'), {
            code: 'not_implemented' as const,
        });
    }

    async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
        const extError = checkExtensions(
            request.extensions ?? [],
            SUPPORTED_EXTENSIONS,
            'OpenAI',
        );
        if (extError) {
            yield extError;
            return;
        }

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
                    streamError = errorEvent(
                        'llm.malformed_response',
                        `Invalid JSON in SSE data: ${sseEvent.data.slice(0, 100)}`,
                    );
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
            await response.body?.cancel().catch(() => {});
        }

        if (streamError) {
            yield streamError;
            return;
        }

        yield { type: 'done' as const, finishReason, usage };
    }

    private buildRequestBody(request: ModelRequest): Record<string, unknown> {
        const body: Record<string, unknown> = {
            model: request.model,
            messages: request.messages.map(msg => {
                const out: Record<string, unknown> = { role: msg.role };
                if (typeof msg.content === 'string') {
                    out.content = msg.content;
                } else {
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
            max_tokens: request.maxTokens,
            temperature: request.temperature,
        };

        if (request.tools && request.tools.length > 0) {
            body.tools = request.tools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                },
            }));
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
            // OpenAI returns 400 (not 413) for context-too-long; detect via error message
            const lower = message.toLowerCase();
            if (lower.includes('context_length_exceeded') ||
                lower.includes('maximum context length') ||
                lower.includes('too many tokens')) {
                return errorEvent('llm.context_too_long', message);
            }
            return errorEvent('llm.invalid_request', message);
        }
        if (status === 401 || status === 403) return errorEvent('llm.auth_error', message);
        if (status === 429) return errorEvent('llm.rate_limited', message);
        if (status >= 500) return errorEvent('llm.server_error', message);
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
