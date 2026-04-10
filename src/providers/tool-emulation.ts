import type { ModelRequest, RequestMessage, ToolDefinition, StreamEvent } from '../types/provider.js';
import { NO_NATIVE_FUNCTION_CALLING, NO_PROTOCOL_DELIBERATION } from '../prompts/prompt-guardrails.js';

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
        '## TOOL USE — MANDATORY',
        '',
        NO_NATIVE_FUNCTION_CALLING,
        NO_PROTOCOL_DELIBERATION,
        'The ONLY way to invoke a tool is by writing the JSON object below directly into your response text.',
        '',
        'When you need a tool, your entire response must be ONLY this JSON object:',
        '{"tool_calls":[{"name":"<tool_name>","arguments":{<arguments>}}]}',
        '',
        '- Do NOT use the API\'s native tool_calls mechanism — it is disabled here.',
        '- Do not wrap the JSON in Markdown fences or any XML/HTML tags.',
        '- Do not add prose, explanation, or commentary before or after the JSON.',
        '- Do not emit <tool_call>, <function_calls>, <invoke>, or similar wrappers.',
        '- For multiple tools, include multiple entries in the "tool_calls" array.',
        '- After tool results arrive, call another tool or give your final text answer.',
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
    const trimmed = stripJsonMarkdownFence(text.trim());
    return parseStructuredJsonToolCalls(trimmed)
        ?? parseWrappedJsonToolCalls(trimmed)
        ?? parseArgTagToolCall(trimmed)
        ?? parseInvokeTagToolCall(trimmed)
        ?? parseFunctionTagToolCall(trimmed);
}

function parseToolCallObject(candidate: string): EmulatedToolCall[] | null {
    try {
        const parsed = JSON.parse(candidate) as {
            tool_calls?: Array<{ name?: unknown; arguments?: unknown }>;
        };
        if (!Array.isArray(parsed.tool_calls) || parsed.tool_calls.length === 0) {
            return null;
        }
        const calls = parsed.tool_calls
            .map(toEmulatedToolCall)
            .filter((call): call is EmulatedToolCall => call !== null);
        return calls.length > 0 ? calls : null;
    } catch {
        return null;
    }
}

function parseStructuredJsonToolCalls(text: string): EmulatedToolCallResult | null {
    if (!text.includes('tool_calls')) return null;

    let startIndex = text.indexOf('{');
    while (startIndex !== -1) {
        const endIndex = findMatchingObjectEnd(text, startIndex);
        if (endIndex !== -1) {
            const candidate = text.slice(startIndex, endIndex);
            if (candidate.includes('tool_calls')) {
                const parsed = parseToolCallObject(candidate);
                if (parsed) {
                    return {
                        calls: parsed,
                        preamble: text.slice(0, startIndex).trim(),
                    };
                }
            }
        }

        startIndex = text.indexOf('{', startIndex + 1);
    }

    const salvaged = salvageTruncatedToolCallObject(text);
    if (!salvaged) return null;

    const parsed = parseToolCallObject(salvaged.candidate);
    if (!parsed) return null;

    return {
        calls: parsed,
        preamble: text.slice(0, salvaged.startIndex).trim(),
    };
}

function parseWrappedJsonToolCalls(text: string): EmulatedToolCallResult | null {
    const wrappedArray = text.match(/<(?:[\w-]+:)?tool_calls>\s*([\s\S]*?)\s*<\/(?:[\w-]+:)?tool_calls>/i);
    if (wrappedArray) {
        const parsed = parseToolCallArray(wrappedArray[1]);
        if (parsed) {
            return {
                calls: parsed,
                preamble: text.slice(0, wrappedArray.index ?? 0).trim(),
            };
        }
    }

    const wrappedSingles = [...text.matchAll(/<(?:[\w-]+:)?tool_call>\s*({[\s\S]*?})\s*<\/(?:[\w-]+:)?tool_call>/gi)];
    if (wrappedSingles.length === 0) return null;
    const calls = wrappedSingles
        .map(match => parseSingleToolCallObject(match[1]))
        .filter((call): call is EmulatedToolCall => call !== null);
    if (calls.length === 0) return null;

    return {
        calls,
        preamble: text.slice(0, wrappedSingles[0]?.index ?? 0).trim(),
    };
}

function parseToolCallArray(candidate: string): EmulatedToolCall[] | null {
    try {
        const parsed = JSON.parse(candidate) as Array<{ name?: unknown; arguments?: unknown }>;
        if (!Array.isArray(parsed) || parsed.length === 0) return null;
        const calls = parsed
            .map(toEmulatedToolCall)
            .filter((call): call is EmulatedToolCall => call !== null);
        return calls.length > 0 ? calls : null;
    } catch {
        return null;
    }
}

function parseSingleToolCallObject(candidate: string): EmulatedToolCall | null {
    try {
        const parsed = JSON.parse(candidate) as { name?: unknown; arguments?: unknown };
        return toEmulatedToolCall(parsed);
    } catch {
        return null;
    }
}

function toEmulatedToolCall(value: { name?: unknown; arguments?: unknown }): EmulatedToolCall | null {
    if (typeof value.name !== 'string' || value.name.trim() === '') return null;
    return {
        name: value.name,
        arguments: typeof value.arguments === 'string'
            ? value.arguments
            : JSON.stringify(value.arguments ?? {}),
    };
}

function parseArgTagToolCall(text: string): EmulatedToolCallResult | null {
    const matches = [...text.matchAll(
        /<(?:[\w-]+:)?tool_call>\s*([A-Za-z0-9_.-]+)\s*((?:<arg_key>[\s\S]*?<\/arg_key>\s*<arg_value>[\s\S]*?<\/arg_value>\s*)+)<\/(?:[\w-]+:)?tool_call>/gi,
    )];
    if (matches.length === 0) return null;

    const calls = matches.map((match) => {
        const name = match[1]?.trim();
        if (!name) return null;
        const args = extractTaggedArguments(match[2], 'arg_key', 'arg_value');
        if (!args) return null;
        return { name, arguments: JSON.stringify(args) };
    }).filter((call): call is EmulatedToolCall => call !== null);
    if (calls.length === 0) return null;

    return {
        calls,
        preamble: text.slice(0, matches[0]?.index ?? 0).trim(),
    };
}

function parseInvokeTagToolCall(text: string): EmulatedToolCallResult | null {
    const matches = [...text.matchAll(
        /<(?:[\w-]+:)?invoke\b[^>]*\bname=(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))[^>]*>\s*([\s\S]*?)\s*<\/(?:[\w-]+:)?invoke>/gi,
    )];
    if (matches.length === 0) return null;

    const calls = matches.map((match) => {
        const name = match[1]?.trim() || match[2]?.trim() || match[3]?.trim() || '';
        if (!name) return null;
        const args = extractParameterArguments(match[4] ?? '');
        if (!args) return null;
        return { name, arguments: JSON.stringify(args) };
    }).filter((call): call is EmulatedToolCall => call !== null);
    if (calls.length === 0) return null;

    return {
        calls,
        preamble: text.slice(0, matches[0]?.index ?? 0).replace(/<(?:[\w-]+:)?tool_call>\s*$/i, '').trim(),
    };
}

function parseFunctionTagToolCall(text: string): EmulatedToolCallResult | null {
    const matches = [...text.matchAll(/<function=([A-Za-z0-9_.-]+)>\s*([\s\S]*?)\s*<\/function>/gi)];
    if (matches.length === 0) return null;

    const calls = matches.map((match) => {
        const name = match[1]?.trim();
        if (!name) return null;
        const args = extractParameterArguments(match[2] ?? '');
        if (!args) return null;
        return { name, arguments: JSON.stringify(args) };
    }).filter((call): call is EmulatedToolCall => call !== null);
    if (calls.length === 0) return null;

    return {
        calls,
        preamble: text.slice(0, matches[0]?.index ?? 0).replace(/<tool_call>\s*$/i, '').trim(),
    };
}

function extractParameterArguments(text: string): Record<string, unknown> | null {
    const args: Record<string, unknown> = {};
    let matched = false;
    for (const match of text.matchAll(
        /<parameter(?:=([A-Za-z0-9_.-]+)|\s+name=(?:"([^"]+)"|'([^']+)'))>\s*([\s\S]*?)\s*<\/parameter>/gi,
    )) {
        const key = match[1]?.trim() || match[2]?.trim() || match[3]?.trim() || '';
        if (!key) continue;
        args[key] = coercePseudoArgumentValue(match[4] ?? '');
        matched = true;
    }
    return matched ? args : null;
}

function extractTaggedArguments(
    text: string,
    keyTag: string,
    valueTag: string,
): Record<string, unknown> | null {
    const args: Record<string, unknown> = {};
    const pairPattern = keyTag === valueTag
        ? /<parameter=([A-Za-z0-9_.-]+)>\s*([\s\S]*?)\s*<\/parameter>/gi
        : /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;

    let matched = false;
    for (const match of text.matchAll(pairPattern)) {
        const key = match[1]?.trim();
        if (!key) continue;
        args[key] = coercePseudoArgumentValue(match[2] ?? '');
        matched = true;
    }

    return matched ? args : null;
}

function coercePseudoArgumentValue(raw: string): unknown {
    const trimmed = raw.trim();
    if (trimmed === '') return '';
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    if (/^(?:true|false|null)$/i.test(trimmed)) {
        return JSON.parse(trimmed.toLowerCase());
    }
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return trimmed;
        }
    }
    return trimmed;
}

function findMatchingObjectEnd(text: string, startIndex: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];

        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\' && inString) {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;

        if (ch === '{') {
            depth++;
            continue;
        }
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                return i + 1;
            }
        }
    }

    return -1;
}

function salvageTruncatedToolCallObject(text: string): { candidate: string; startIndex: number } | null {
    const keyIndex = text.indexOf('"tool_calls"');
    if (keyIndex === -1) return null;

    const startIndex = text.lastIndexOf('{', keyIndex);
    const arrayStart = text.indexOf('[', keyIndex);
    if (startIndex === -1 || arrayStart === -1) return null;

    let bracketDepth = 0;
    let inString = false;
    let escaped = false;

    for (let i = arrayStart; i < text.length; i++) {
        const ch = text[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\' && inString) {
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;

        if (ch === '[') {
            bracketDepth++;
            continue;
        }
        if (ch === ']') {
            bracketDepth--;
            if (bracketDepth === 0) {
                const candidate = `${text.slice(startIndex, i + 1)}}`;
                return { candidate, startIndex };
            }
        }
    }

    return null;
}

function stripJsonMarkdownFence(text: string): string {
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced?.[1]?.trim() ?? text;
}

// ---------------------------------------------------------------------------
// Stream wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a raw provider stream with tool-emulation post-processing.
 *
 * Text deltas are buffered only until a complete emulated tool-call JSON object
 * becomes parseable. At that point the wrapper emits tool_call_delta events
 * immediately and continues draining the inner stream only for done/error/usage.
 * If no tool-call JSON is ever found, the buffered text is emitted at the end.
 *
 * This ensures the agent loop always sees uniform StreamEvent regardless of
 * whether tool calling is native or emulated.
 */
export async function* wrapStreamWithToolEmulation(
    inner: AsyncIterable<StreamEvent>,
): AsyncGenerator<StreamEvent> {
    let bufferedText = '';
    let emittedToolCalls = false;
    let doneEvent: Extract<StreamEvent, { type: 'done' }> | null = null;

    const debugMode = process.env.NANOGPT_DEBUG === '1';

    for await (const event of inner) {
        if (event.type === 'text_delta') {
            if (emittedToolCalls) continue;
            bufferedText += event.text;
            const result = parseEmulatedToolCalls(bufferedText);
            if (!result || result.calls.length === 0) continue;

            if (debugMode) {
                process.stderr.write(`[NANOGPT_DEBUG] emulation buffer at parse success:\n${bufferedText}\n---\n`);
            }

            if (result.preamble.length > 0) {
                yield { type: 'text_delta', text: result.preamble };
            }
            for (let i = 0; i < result.calls.length; i++) {
                yield {
                    type: 'tool_call_delta',
                    index: i,
                    id: `emulated_${i}`,
                    name: result.calls[i].name,
                    arguments: result.calls[i].arguments,
                };
            }
            emittedToolCalls = true;
        } else if (event.type === 'tool_call_delta') {
            emittedToolCalls = true;
            yield event;
        } else if (event.type === 'done') {
            doneEvent = event;
        } else if (event.type === 'error') {
            yield event;
            return;
        } else {
            yield event;
        }
    }

    if (!emittedToolCalls && bufferedText.length > 0) {
        if (debugMode) {
            process.stderr.write(`[NANOGPT_DEBUG] emulation buffer at stream end (no tool calls extracted):\n${bufferedText}\n---\n`);
        }
        // Some proxies (e.g. NanoGPT for Qwen) emit the model's chain-of-thought
        // as a "Thinking...\n> ..." markdown-blockquote prefix inside delta.content
        // rather than a separate reasoning_content field. Strip it before handing
        // the text back to the agent loop so it never leaks into invoke results.
        const stripped = bufferedText.replace(/^Thinking\.\.\.\n(>.*\n)*\n*/, '');
        yield { type: 'text_delta', text: stripped.length > 0 ? stripped : bufferedText };
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
