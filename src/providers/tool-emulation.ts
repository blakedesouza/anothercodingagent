import type { ModelRequest, RequestMessage, ToolDefinition, StreamEvent } from '../types/provider.js';

/**
 * A parsed emulated tool call (arguments stored as a JSON string, matching
 * ToolCallDeltaEvent.arguments).
 */
export interface EmulatedToolCall {
    name: string;
    arguments: string; // JSON-encoded arguments object
}

// ---------------------------------------------------------------------------
// System prompt injection
// ---------------------------------------------------------------------------

/**
 * Build the tool-schema block that is appended to the system prompt when
 * the model does not have native tool-calling support.
 *
 * The block instructs the model to respond with a specific JSON format and
 * lists all available tools with their parameter schemas.
 */
export function buildToolSchemaPrompt(tools: ToolDefinition[]): string {
    const toolList = tools
        .map(t => `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters)}`)
        .join('\n');

    return [
        '',
        'You have access to the following tools. When you need to use a tool, respond',
        'ONLY with a JSON object in exactly this format (no surrounding text):',
        '{"tool_calls":[{"name":"<tool_name>","arguments":{<arguments>}}]}',
        '',
        'Available tools:',
        toolList,
    ].join('\n');
}

/**
 * Return a copy of `request` with:
 *  - tool schemas injected into the system message content
 *  - the `tools` field removed (the driver sends no native tool definitions)
 *
 * If no system message exists, a new one is prepended.
 */
export function injectToolsIntoRequest(request: ModelRequest): ModelRequest {
    if (!request.tools || request.tools.length === 0) return request;

    const schemaBlock = buildToolSchemaPrompt(request.tools);

    let injected = false;
    const messages: RequestMessage[] = request.messages.map(msg => {
        if (msg.role === 'system' && !injected) {
            injected = true;
            const existing = typeof msg.content === 'string' ? msg.content : '';
            return { ...msg, content: existing + schemaBlock };
        }
        return msg;
    });

    if (!injected) {
        // No existing system message — prepend one
        messages.unshift({ role: 'system', content: schemaBlock.trimStart() });
    }

    return { ...request, messages, tools: undefined };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Result of parsing emulated tool calls, including the preamble text before the JSON block. */
export interface EmulatedToolCallResult {
    calls: EmulatedToolCall[];
    /** Text before the tool call JSON block (may be empty). */
    preamble: string;
}

/**
 * Attempt to parse emulated tool calls from a model text response.
 *
 * Looks for a JSON object of the form:
 *   {"tool_calls":[{"name":"...","arguments":{...}}]}
 *
 * Returns an EmulatedToolCallResult on success, or null if none are found.
 * The `arguments` field is a JSON string (to match ToolCallDeltaEvent.arguments).
 */
export function parseEmulatedToolCalls(text: string): EmulatedToolCallResult | null {
    const trimmed = text.trim();
    if (!trimmed.includes('tool_calls')) return null;

    // O(n) scan: find each '{' and use brace-depth counting to find the matching '}'.
    // This avoids the O(n²) nested slicing approach.
    let startIndex = trimmed.indexOf('{');
    while (startIndex !== -1) {
        let depth = 0;
        let endIndex = startIndex;

        for (let i = startIndex; i < trimmed.length; i++) {
            if (trimmed[i] === '{') depth++;
            else if (trimmed[i] === '}') {
                depth--;
                if (depth === 0) {
                    endIndex = i + 1;
                    break;
                }
            }
        }

        if (endIndex > startIndex) {
            const candidate = trimmed.slice(startIndex, endIndex);
            if (candidate.includes('tool_calls')) {
                try {
                    const parsed = JSON.parse(candidate) as {
                        tool_calls?: Array<{ name?: unknown; arguments?: unknown }>;
                    };
                    if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
                        const calls = parsed.tool_calls.map(tc => ({
                            name: typeof tc.name === 'string' ? tc.name : '',
                            arguments: typeof tc.arguments === 'string'
                                ? tc.arguments
                                : JSON.stringify(tc.arguments ?? {}),
                        }));
                        const preamble = trimmed.slice(0, startIndex).trim();
                        return { calls, preamble };
                    }
                } catch {
                    // Not valid JSON — advance to next '{'
                }
            }
        }

        startIndex = trimmed.indexOf('{', startIndex + 1);
    }

    return null;
}

// ---------------------------------------------------------------------------
// Stream wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a raw provider stream with tool-emulation post-processing.
 *
 * All text_delta events are buffered. After the underlying stream finishes:
 *  - If the buffered text contains a tool call JSON block → emit tool_call_delta
 *    events (one per tool call) followed by the done event.
 *  - Otherwise → re-emit the buffered text_delta events followed by done.
 *
 * This ensures the agent loop always sees uniform StreamEvent regardless of
 * whether tool calling is native or emulated.
 */
export async function* wrapStreamWithToolEmulation(
    inner: AsyncIterable<StreamEvent>,
): AsyncGenerator<StreamEvent> {
    const textChunks: string[] = [];
    let doneEvent: Extract<StreamEvent, { type: 'done' }> | null = null;
    let errorEvent: Extract<StreamEvent, { type: 'error' }> | null = null;
    const passthrough: StreamEvent[] = []; // non-text, non-done events (e.g. unexpected tool_call_delta)

    for await (const event of inner) {
        if (event.type === 'text_delta') {
            textChunks.push(event.text);
        } else if (event.type === 'done') {
            doneEvent = event;
        } else if (event.type === 'error') {
            errorEvent = event;
            break;
        } else {
            passthrough.push(event);
        }
    }

    if (errorEvent) {
        yield errorEvent;
        return;
    }

    const fullText = textChunks.join('');
    const result = parseEmulatedToolCalls(fullText);

    if (result && result.calls.length > 0) {
        // Yield any preamble text before the tool call JSON
        if (result.preamble.length > 0) {
            yield { type: 'text_delta', text: result.preamble };
        }
        for (let i = 0; i < result.calls.length; i++) {
            // Synthesize a stable id per emulated tool call so the downstream
            // accumulator path is type-uniform with provider-native paths.
            yield {
                type: 'tool_call_delta',
                index: i,
                id: `emulated_${i}`,
                name: result.calls[i].name,
                arguments: result.calls[i].arguments,
            };
        }
    } else {
        // No tool calls detected — yield original text
        if (fullText.length > 0) {
            yield { type: 'text_delta', text: fullText };
        }
    }

    // Always yield passthrough events (e.g., unexpected tool_call_delta from
    // underlying stream) in both branches to avoid silent event loss.
    for (const ev of passthrough) {
        yield ev;
    }

    if (doneEvent) {
        yield doneEvent;
    } else {
        // Inner stream ended without a done event (abrupt termination, missing
        // DONE marker, etc.). Synthesize one to prevent consumers from hanging.
        // Usage is zeroed since no accounting data is available.
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
    }
}
