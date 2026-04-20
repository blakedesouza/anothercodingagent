import type { ModelRequest, RequestMessage, ToolDefinition, StreamEvent } from '../types/provider.js';
import { NO_NATIVE_FUNCTION_CALLING, NO_PROTOCOL_DELIBERATION } from '../prompts/prompt-guardrails.js';
import { getModelHints } from '../prompts/model-hints.js';

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
export function buildToolSchemaPrompt(tools: ToolDefinition[], modelId?: string): string {
    const toolList = tools
        .map(t => `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters)}`)
        .join('\n');

    const hints = modelId ? getModelHints(modelId, 'tool_emulation') : [];
    const hintSection = hints.length > 0
        ? '\n\n<model_hints>\n' + hints.join('\n') + '\n</model_hints>'
        : '';

    return [
        '',
        '## TOOL USE — MANDATORY',
        '',
        NO_NATIVE_FUNCTION_CALLING,
        NO_PROTOCOL_DELIBERATION,
        'The ONLY way to invoke a tool is by writing the JSON object below directly into your response text.',
        '',
        'When you need a tool, your entire response must be ONLY this JSON object:',
        '{"tool_calls":[{"name":"TOOL_NAME","arguments":{ARGUMENTS}}]}',
        '',
        '- Do NOT use the API\'s native tool_calls mechanism — it is disabled here.',
        '- Do not wrap the JSON in Markdown fences or any XML/HTML tags.',
        '- Do not add prose, explanation, or commentary before or after the JSON.',
        '- Do not emit `<tool_call>`, `<function_calls>`, `<invoke>`, or similar wrappers.',
        '- For multiple tools, include multiple entries in the "tool_calls" array.',
        '- After tool results arrive, call another tool or give your final text answer.',
        '- Inside JSON strings, only valid escape sequences are allowed: `\\"`, `\\\\`, `\\/`, `\\b`, `\\f`, `\\n`, `\\r`, `\\t`, `\\uXXXX`. Do NOT write `\\-`, `\\.`, `\\<`, `\\>`, or any other invalid escape — write the literal character instead.',
        '',
        'CORRECT — entire response is only the JSON object:',
        '{"tool_calls":[{"name":"read_file","arguments":{"path":"src/main.ts"}}]}',
        '',
        'WRONG — prose before the JSON:',
        'I will read the file now. {"tool_calls":[...]}',
        '',
        'WRONG — JSON split across lines or wrapped in fences:',
        '```json',
        '{"tool_calls":[...]}',
        '```',
        '',
        'Available tools:',
        toolList + hintSection,
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

    const schemaBlock = buildToolSchemaPrompt(request.tools, request.model);

    let injected = false;
    const messages: RequestMessage[] = request.messages.map(msg => {
        if (msg.role === 'system' && !injected) {
            injected = true;
            if (typeof msg.content === 'string') {
                return { ...msg, content: msg.content + schemaBlock };
            }
            return {
                ...msg,
                content: [
                    ...msg.content,
                    { type: 'text', text: schemaBlock },
                ],
            };
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

/**
 * Repair common invalid JSON escape sequences emitted by models.
 *
 * RFC 8259 only allows \", \\, \/, \b, \f, \n, \r, \t, and \uXXXX inside
 * JSON strings. Models (especially GLM-5) sometimes emit \-, \., \<, \>, \!,
 * etc. which cause JSON.parse to throw a SyntaxError. This strips the
 * backslash from any unrecognised escape, converting \- → -, \. → ., etc.
 * Valid escape sequences are left untouched.
 */
export function sanitizeModelJson(text: string): string {
    // Match backslash NOT followed by a valid JSON escape character.
    // Valid: " \ / b f n r t u
    return text.replace(/\\([^"\\\/bfnrtu])/g, '$1');
}

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
    return parseFencedToolCalls(trimmed)
        ?? parseToolCallPayload(stripJsonMarkdownFence(trimmed));
}

function parseToolCallPayload(text: string): EmulatedToolCallResult | null {
    return parseStructuredJsonToolCalls(text)
        ?? parseWrappedJsonToolCalls(text)
        ?? parseArgTagToolCall(text)
        ?? parseInvokeTagToolCall(text)
        ?? parseFunctionTagToolCall(text);
}

function parseFencedToolCalls(text: string): EmulatedToolCallResult | null {
    const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
    for (const fence of fences) {
        const inner = fence[1]?.trim();
        if (!inner) continue;
        const parsed = parseToolCallPayload(inner);
        if (!parsed) continue;

        const fencePreamble = text.slice(0, fence.index ?? 0).trim();
        const preamble = [fencePreamble, parsed.preamble]
            .filter(part => part.length > 0)
            .join('\n')
            .trim();

        return { calls: parsed.calls, preamble };
    }

    return null;
}

function parseToolCallObject(candidate: string): EmulatedToolCall[] | null {
    try {
        const parsed = JSON.parse(sanitizeModelJson(candidate)) as {
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
        const parsed = JSON.parse(sanitizeModelJson(candidate)) as Array<{ name?: unknown; arguments?: unknown }>;
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
        const parsed = JSON.parse(sanitizeModelJson(candidate)) as { name?: unknown; arguments?: unknown };
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
/**
 * Strip proxy-injected chain-of-thought preamble from model text.
 *
 * Some proxies (e.g. NanoGPT for Qwen) convert the model's internal reasoning
 * into a "Thinking...\n> ..." markdown-blockquote prefix inside delta.content
 * rather than a separate reasoning_content field. This must be removed from
 * every surface where buffered model text is handed back to the agent loop —
 * both the tool-call preamble path and the no-tool-calls result path.
 */
const PREAMBLE_RE = /^Thinking\.\.\.\r?\n(?:>.*\r?\n)+\r?\n*/;
const MAX_PREAMBLE_BUFFER = 8_192;

function stripModelPreamble(text: string): string {
    const stripped = text.replace(PREAMBLE_RE, '');
    return stripped.length > 0 ? stripped : text;
}

/**
 * Streaming-safe preamble stripper for no-tools NanoGPT responses.
 *
 * Some models (e.g. Qwen via NanoGPT) emit a "Thinking...\n> ..." thinking
 * block at the very start of every response, regardless of whether tool
 * emulation is active. wrapStreamWithToolEmulation handles this for the
 * tools path, but that wrapper buffers the full response before yielding.
 * For no-tools requests (e.g. consult witnesses) we need a pass-through that
 * only buffers during the preamble detection window, then streams normally.
 *
 * Algorithm:
 * - Buffer text_delta events until we can determine whether a preamble is
 *   present (i.e. until the prefix no longer matches "Thinking...\n> ...")
 * - If the preamble ends (blank line after blockquote), strip it and emit
 *   the remainder; stream all subsequent events immediately.
 * - If the prefix never starts with "Thinking...", emit it immediately and
 *   stop buffering.
 * - Safety valve at 8 KiB: stop buffering and emit as-is.
 * - Non-text events (tool_call_delta, done, error, etc.) always pass through
 *   immediately regardless of buffer state.
 */
// Require at least one blockquote line (>.*\r?\n)+ so bare "Thinking...\n" followed
// by normal content is not mistakenly treated as a preamble.
export async function* wrapStreamWithPreambleStrip(
    inner: AsyncIterable<StreamEvent>,
): AsyncGenerator<StreamEvent> {
    let prefix = '';
    let decided = false;
    // The `done` event must be held until any buffered prefix is flushed;
    // emitting `done` before a pending text_delta violates stream order.
    let heldDone: Extract<StreamEvent, { type: 'done' }> | null = null;

    for await (const event of inner) {
        if (decided || event.type !== 'text_delta') {
            if (!decided && event.type === 'done') {
                // Hold done — flush buffer first (after the loop).
                heldDone = event;
                continue;
            }
            yield event;
            continue;
        }

        prefix += event.text;

        if (!prefix.startsWith('Thinking...')) {
            // No preamble — emit all buffered text and stop buffering.
            decided = true;
            yield { type: 'text_delta', text: prefix };
            continue;
        }

        const match = prefix.match(PREAMBLE_RE);
        if (match) {
            // Preamble complete — strip it and emit the remainder.
            decided = true;
            const remainder = prefix.slice(match[0].length);
            if (remainder.length > 0) {
                yield { type: 'text_delta', text: remainder };
            }
            continue;
        }

        if (prefix.length > MAX_PREAMBLE_BUFFER) {
            // Safety valve — emit verbatim rather than buffer forever.
            decided = true;
            yield { type: 'text_delta', text: prefix };
        }
        // else: still accumulating the preamble header, keep buffering.
    }

    // Stream ended while buffering. Strip and emit whatever's left, then
    // release any held done event so it is always the final yielded event.
    if (!decided && prefix.length > 0) {
        const stripped = prefix.replace(PREAMBLE_RE, '');
        if (stripped.length > 0) {
            yield { type: 'text_delta', text: stripped };
        }
    }
    if (heldDone) {
        yield heldDone;
    }
}

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
                const cleanPreamble = stripModelPreamble(result.preamble);
                if (cleanPreamble.length > 0) {
                    yield { type: 'text_delta', text: cleanPreamble };
                }
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
        yield { type: 'text_delta', text: stripModelPreamble(bufferedText) };
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
