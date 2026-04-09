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
    RequestMessage,
    RequestContentPart,
    ExtensionRequest,
} from '../types/provider.js';
import { getModelCapabilities, getKnownModelIds } from './model-registry.js';
import { parseSSE } from './sse-parser.js';
import { DEFAULT_API_TIMEOUT_MS } from '../config/schema.js';

export interface AnthropicDriverOptions {
    apiKey?: string;
    baseUrl?: string;
    timeout?: number;
}

/** Extension types natively handled by the Anthropic driver. */
const SUPPORTED_EXTENSIONS: readonly string[] = [
    'anthropic-prompt-caching',
    'claude-extended-thinking',
];

/**
 * Anthropic provider driver.
 * Communicates with the Anthropic Messages API using Anthropic-specific SSE format.
 * Supports only claude-* models.
 */
export class AnthropicDriver implements ProviderDriver {
    private readonly apiKey: string | undefined;
    private readonly baseUrl: string;
    private readonly timeout: number;

    constructor(options: AnthropicDriverOptions = {}) {
        this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
        this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
        this.timeout = options.timeout ?? DEFAULT_API_TIMEOUT_MS;
    }

    validate(config: ProviderConfig): Result<void, ConfigError> {
        if (!this.apiKey || this.apiKey.trim() === '') {
            return {
                ok: false,
                error: {
                    code: 'config.missing_api_key',
                    message: 'ANTHROPIC_API_KEY environment variable is not set or empty',
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
        if (!model.startsWith('claude-')) {
            throw new Error(`AnthropicDriver: unsupported model '${model}'. Only claude-* models are supported.`);
        }
        const caps = getModelCapabilities(model);
        if (!caps) {
            throw new Error(`Unknown model: ${model}. Known models: ${getKnownModelIds().join(', ')}`);
        }
        return caps;
    }

    /** embed() is deferred until M6 — throws an Error with code='not_implemented'. */
    async embed(_texts: string[], _model: string): Promise<EmbeddingResult> {
        throw Object.assign(new Error('AnthropicDriver.embed() is deferred until M6'), {
            code: 'not_implemented' as const,
        });
    }

    async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
        const extError = checkExtensions(
            request.extensions ?? [],
            SUPPORTED_EXTENSIONS,
            'Anthropic',
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
            response = await fetch(`${this.baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey!,
                    'anthropic-version': '2023-06-01',
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
        let finishReason = 'end_turn';
        let streamError: StreamErrorEvent | null = null;

        try {
            for await (const sseEvent of parseSSE(response)) {
                resetIdleTimer();
                const eventType = sseEvent.event;
                if (!eventType) continue;

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

                if (eventType === 'message_start') {
                    // Fix Q2: use direct field mutation to avoid zeroing out the other field
                    const msg = parsed.message as Record<string, unknown> | undefined;
                    const msgUsage = msg?.usage as Record<string, number> | undefined;
                    if (msgUsage?.input_tokens !== undefined) {
                        usage.inputTokens = msgUsage.input_tokens;
                    }
                } else if (eventType === 'content_block_start') {
                    // Fix Q9: guard against missing/invalid index
                    const rawIndex = parsed.index;
                    if (typeof rawIndex !== 'number' || !Number.isFinite(rawIndex)) {
                        streamError = errorEvent('llm.malformed_response',
                            `Invalid or missing index in content_block_start: ${String(rawIndex)}`);
                        break;
                    }
                    const index = rawIndex;
                    const block = parsed.content_block as Record<string, unknown> | undefined;
                    if (block?.type === 'tool_use') {
                        const name = block.name as string | undefined;
                        const blockId = typeof block.id === 'string' ? block.id : undefined;
                        if (name) {
                            yield { type: 'tool_call_delta' as const, index, id: blockId, name };
                        }
                    }
                } else if (eventType === 'content_block_delta') {
                    // Fix Q9: guard against missing/invalid index
                    const rawIndex = parsed.index;
                    if (typeof rawIndex !== 'number' || !Number.isFinite(rawIndex)) {
                        streamError = errorEvent('llm.malformed_response',
                            `Invalid or missing index in content_block_delta: ${String(rawIndex)}`);
                        break;
                    }
                    const index = rawIndex;
                    const delta = parsed.delta as Record<string, unknown> | undefined;
                    const deltaType = delta?.type as string | undefined;

                    if (deltaType === 'text_delta') {
                        const text = delta?.text as string | undefined;
                        if (text && text.length > 0) {
                            yield { type: 'text_delta' as const, text };
                        }
                    } else if (deltaType === 'input_json_delta') {
                        const partialJson = delta?.partial_json as string | undefined;
                        if (partialJson !== undefined) {
                            yield { type: 'tool_call_delta' as const, index, arguments: partialJson };
                        }
                    }
                } else if (eventType === 'message_delta') {
                    const delta = parsed.delta as Record<string, unknown> | undefined;
                    if (delta?.stop_reason) {
                        finishReason = String(delta.stop_reason);
                    }
                    // Fix Q2: direct field mutation to avoid zeroing out inputTokens
                    const msgUsage = parsed.usage as Record<string, number> | undefined;
                    if (msgUsage?.output_tokens !== undefined) {
                        usage.outputTokens = msgUsage.output_tokens;
                    }
                }
                // content_block_stop, message_stop, ping — no StreamEvent to emit
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
        let system: string | undefined;
        const messages: Array<Record<string, unknown>> = [];

        for (const msg of request.messages) {
            if (msg.role === 'system') {
                system = extractTextContent(msg);
                continue;
            }

            if (msg.role === 'tool') {
                // Tool result → Anthropic user message with tool_result content block
                messages.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: msg.toolCallId,
                        content: typeof msg.content === 'string' ? msg.content : extractTextContent(msg),
                    }],
                });
                continue;
            }

            if (typeof msg.content === 'string') {
                messages.push({ role: msg.role, content: msg.content });
                continue;
            }

            const anthropicContent = convertContentParts(msg.content);
            messages.push({ role: msg.role, content: anthropicContent });
        }

        const body: Record<string, unknown> = {
            model: request.model,
            messages,
            max_tokens: request.maxTokens,
            temperature: request.temperature,
            stream: true,
        };

        if (system) {
            body.system = system;
        }

        if (request.tools && request.tools.length > 0) {
            body.tools = request.tools.map(t => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
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
        if (status === 400) return errorEvent('llm.invalid_request', message);
        if (status === 401 || status === 403) return errorEvent('llm.auth_error', message);
        if (status === 413) return errorEvent('llm.context_too_long', message);
        if (status === 429) return errorEvent('llm.rate_limited', message);
        if (status >= 500) return errorEvent('llm.server_error', message);
        return errorEvent('llm.server_error', `HTTP ${status}: ${message}`);
    }
}

// --- Helpers ---

/**
 * Check extensions against the list the driver supports.
 * Returns an error event for the first required-but-unsupported extension,
 * or null if all extensions are acceptable. Optional unsupported extensions
 * produce a console.warn and are ignored.
 */
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

function extractTextContent(msg: RequestMessage): string {
    if (typeof msg.content === 'string') return msg.content;
    return msg.content
        .filter(p => p.type === 'text')
        .map(p => p.text ?? '')
        .join('');
}

function convertContentParts(parts: RequestContentPart[]): Array<Record<string, unknown>> {
    return parts.map(part => {
        if (part.type === 'text') {
            return { type: 'text', text: part.text ?? '' };
        }
        if (part.type === 'tool_call') {
            return {
                type: 'tool_use',
                id: part.toolCallId,
                name: part.toolName,
                input: part.arguments ?? {},
            };
        }
        // tool_result
        return {
            type: 'tool_result',
            tool_use_id: part.toolCallId,
            content: part.text ?? '',
        };
    });
}

function errorEvent(code: string, message: string): StreamErrorEvent {
    return { type: 'error', error: { code, message } };
}

function isAbortError(err: unknown): boolean {
    if (err instanceof DOMException && err.name === 'AbortError') return true;
    if (err instanceof Error && err.name === 'AbortError') return true;
    return false;
}
