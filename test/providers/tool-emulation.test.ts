import { describe, it, expect } from 'vitest';
import {
    buildToolSchemaPrompt,
    injectToolsIntoRequest,
    parseEmulatedToolCalls,
    sanitizeModelJson,
    wrapStreamWithPreambleStrip,
    wrapStreamWithToolEmulation,
} from '../../src/providers/tool-emulation.js';
import type { ModelRequest, StreamEvent, ToolDefinition } from '../../src/types/provider.js';

// --- Helpers ---

function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
    return {
        model: 'moonshot-v1-8k',
        messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'List the files in /tmp' },
        ],
        maxTokens: 1024,
        temperature: 0.0,
        ...overrides,
    };
}

const sampleTools: ToolDefinition[] = [
    {
        name: 'read_file',
        description: 'Read a file from the filesystem',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
        name: 'list_directory',
        description: 'List contents of a directory',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
];

async function collectStream(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
}

// --- Tests ---

describe('buildToolSchemaPrompt', () => {
    it('includes tool names and descriptions', () => {
        const prompt = buildToolSchemaPrompt(sampleTools);
        expect(prompt).toContain('read_file');
        expect(prompt).toContain('Read a file from the filesystem');
        expect(prompt).toContain('list_directory');
    });

    it('includes parameter schemas as JSON', () => {
        const prompt = buildToolSchemaPrompt(sampleTools);
        expect(prompt).toContain('"type":"object"');
    });

    it('contains JSON format instruction', () => {
        const prompt = buildToolSchemaPrompt(sampleTools);
        expect(prompt).toContain('tool_calls');
        expect(prompt).toContain('name');
        expect(prompt).toContain('arguments');
        expect(prompt).toContain('Do not wrap the JSON in Markdown fences');
        expect(prompt).toContain('Do not deliberate over the protocol');
        expect(prompt).toContain('NOT available in this session');
    });

    it('includes tool-emulation-only model hints without leaking non-tool surfaces', () => {
        const prompt = buildToolSchemaPrompt(sampleTools, 'zai-org/glm-5');
        expect(prompt).toContain('your ENTIRE response must be ONLY the JSON object');
        expect(prompt).toContain('Make tool calls directly');
        expect(prompt).not.toContain('needs_context JSON object');
    });

    it('includes DeepSeek V4 Pro protocol hints in tool emulation prompts', () => {
        const prompt = buildToolSchemaPrompt(sampleTools, 'deepseek/deepseek-v4-pro');
        expect(prompt).toContain('Never write literal `Tool:`');
        expect(prompt).toContain('Never end a response with intent phrases');
        expect(prompt).toContain('your entire response must be only the executable JSON object');
        expect(prompt).not.toContain('Do not finalize a coding task');
        expect(prompt).not.toContain('<redacted:...>');
    });
});

describe('injectToolsIntoRequest', () => {
    it('injects tool schemas into the system message', () => {
        const req = makeRequest({ tools: sampleTools });
        const result = injectToolsIntoRequest(req);

        const sysMsg = result.messages.find(m => m.role === 'system');
        expect(sysMsg).toBeDefined();
        const content = sysMsg!.content as string;
        expect(content).toContain('read_file');
        expect(content).toContain('list_directory');
        expect(content).toContain('tool_calls');
        // Original system message text preserved
        expect(content).toContain('You are a helpful assistant.');
    });

    it('removes the native tools field', () => {
        const req = makeRequest({ tools: sampleTools });
        const result = injectToolsIntoRequest(req);
        expect(result.tools).toBeUndefined();
    });

    it('prepends a system message if none exists', () => {
        const req = makeRequest({
            tools: sampleTools,
            messages: [{ role: 'user', content: 'hello' }],
        });
        const result = injectToolsIntoRequest(req);
        expect(result.messages[0].role).toBe('system');
        expect(typeof result.messages[0].content).toBe('string');
        expect(result.messages[0].content as string).toContain('tool_calls');
    });

    it('preserves structured system content when appending the tool schema block', () => {
        const req = makeRequest({
            tools: sampleTools,
            messages: [
                {
                    role: 'system',
                    content: [{ type: 'text', text: 'Existing structured system message.' }],
                },
                { role: 'user', content: 'hello' },
            ],
        });
        const result = injectToolsIntoRequest(req);
        const sysMsg = result.messages[0];
        expect(sysMsg.role).toBe('system');
        expect(Array.isArray(sysMsg.content)).toBe(true);
        const textParts = (sysMsg.content as Array<{ type: string; text?: string }>)
            .filter(part => part.type === 'text')
            .map(part => part.text ?? '');
        expect(textParts[0]).toBe('Existing structured system message.');
        expect(textParts.some(text => text.includes('tool_calls'))).toBe(true);
        expect(textParts.some(text => text.includes('read_file'))).toBe(true);
    });

    it('returns request unchanged when no tools provided', () => {
        const req = makeRequest({ tools: undefined });
        const result = injectToolsIntoRequest(req);
        expect(result).toBe(req); // same reference
    });

    it('returns request unchanged when tools array is empty', () => {
        const req = makeRequest({ tools: [] });
        const result = injectToolsIntoRequest(req);
        expect(result).toBe(req);
    });
});

describe('parseEmulatedToolCalls', () => {
    it('sanitizes invalid model JSON escapes without changing valid escapes', () => {
        const text = String.raw`{"path":"world\/rules.md","topic":"magic\-rules","note":"line\nbreak"}`;
        expect(JSON.parse(sanitizeModelJson(text))).toEqual({
            path: 'world/rules.md',
            topic: 'magic-rules',
            note: 'line\nbreak',
        });
    });

    it('parses tool-call JSON containing invalid model escape sequences', () => {
        const text = String.raw`{"tool_calls":[{"name":"write_file","arguments":{"path":"world\/rules.md","content":"Use magic\-rules and class\.rank terms"}}]}`;
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(1);
        expect(JSON.parse(result!.calls[0].arguments)).toEqual({
            path: 'world/rules.md',
            content: 'Use magic-rules and class.rank terms',
        });
    });

    it('preserves valid doubled backslashes while repairing invalid single escapes', () => {
        const text = String.raw`{"tool_calls":[{"name":"search_text","arguments":{"pattern":"kimi-k2\\.(5|6)|glm-5\\.1","other":"\"id\":\\s*\"foo","note":"bad\-escape"}}]}`;
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(1);
        expect(JSON.parse(result!.calls[0].arguments)).toEqual({
            pattern: String.raw`kimi-k2\.(5|6)|glm-5\.1`,
            other: String.raw`"id":\s*"foo`,
            note: 'bad-escape',
        });
    });

    it('parses a single tool call with object arguments', () => {
        const text = '{"tool_calls":[{"name":"read_file","arguments":{"path":"/tmp/foo"}}]}';
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(1);
        expect(result!.calls[0].name).toBe('read_file');
        // arguments must be a JSON string
        const args = JSON.parse(result!.calls[0].arguments) as { path: string };
        expect(args.path).toBe('/tmp/foo');
        expect(result!.preamble).toBe('');
    });

    it('parses a single tool call with string arguments', () => {
        const text = '{"tool_calls":[{"name":"read_file","arguments":"{\\"path\\":\\"/tmp/foo\\"}"}]}';
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls[0].name).toBe('read_file');
        const args = JSON.parse(result!.calls[0].arguments) as { path: string };
        expect(args.path).toBe('/tmp/foo');
    });

    it('parses multiple tool calls', () => {
        const text = JSON.stringify({
            tool_calls: [
                { name: 'read_file', arguments: { path: '/a' } },
                { name: 'list_directory', arguments: { path: '/b' } },
            ],
        });
        const result = parseEmulatedToolCalls(text);
        expect(result!.calls).toHaveLength(2);
        expect(result!.calls[0].name).toBe('read_file');
        expect(result!.calls[1].name).toBe('list_directory');
    });

    it('returns null for plain text with no tool call', () => {
        expect(parseEmulatedToolCalls('Hello, world!')).toBeNull();
        expect(parseEmulatedToolCalls('')).toBeNull();
    });

    it('returns null for malformed JSON', () => {
        expect(parseEmulatedToolCalls('{tool_calls: [bad json]}')).toBeNull();
    });

    it('finds tool call embedded in surrounding text and captures preamble', () => {
        const text = 'Let me call a tool: {"tool_calls":[{"name":"read_file","arguments":{"path":"/x"}}]} done.';
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls[0].name).toBe('read_file');
        expect(result!.preamble).toBe('Let me call a tool:');
    });

    it('parses fenced tool-call JSON without treating the fence as preamble', () => {
        const text = [
            '```json',
            '{"tool_calls":[{"name":"read_file","arguments":{"path":"/x"}}]}',
            '```',
        ].join('\n');
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls[0].name).toBe('read_file');
        expect(result!.preamble).toBe('');
    });

    it('parses prose plus fenced tool-call JSON without leaking fence markers into the preamble', () => {
        const text = [
            'I will read the file now.',
            '```json',
            '{"tool_calls":[{"name":"read_file","arguments":{"path":"/x"}}]}',
            '```',
        ].join('\n');
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls[0].name).toBe('read_file');
        expect(result!.preamble).toBe('I will read the file now.');
    });

    it('salvages truncated tool-call JSON followed by think tags and prose', () => {
        const text = '{"tool_calls":[{"name":"read_file","arguments":{"path":"/x"}}]</think></think>Now let me continue.';
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(1);
        expect(result!.calls[0].name).toBe('read_file');
        expect(JSON.parse(result!.calls[0].arguments)).toEqual({ path: '/x' });
    });

    it('parses tool-call JSON when string arguments contain braces', () => {
        const text = JSON.stringify({
            tool_calls: [
                {
                    name: 'write_file',
                    arguments: {
                        path: '/tmp/out.md',
                        content: 'literal braces: {keep this}',
                    },
                },
            ],
        });
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(1);
        expect(JSON.parse(result!.calls[0].arguments)).toEqual({
            path: '/tmp/out.md',
            content: 'literal braces: {keep this}',
        });
    });

    it('parses wrapped single-call JSON inside tool_call tags', () => {
        const text = '<tool_call>{"name":"read_file","arguments":{"path":"/tmp/x"}}</tool_call>';
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(1);
        expect(result!.calls[0].name).toBe('read_file');
        expect(JSON.parse(result!.calls[0].arguments)).toEqual({ path: '/tmp/x' });
    });

    it('parses repeated wrapped single-call JSON blocks', () => {
        const text = [
            '<tool_call>{"name":"read_file","arguments":{"path":"/tmp/a"}}</tool_call>',
            '<tool_call>{"name":"list_directory","arguments":{"path":"/tmp"}}</tool_call>',
        ].join('\n');
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(2);
        expect(result!.calls[0].name).toBe('read_file');
        expect(result!.calls[1].name).toBe('list_directory');
    });

    it('parses wrapped tool call arrays inside tool_calls tags', () => {
        const text = '<tool_calls>[{"name":"read_file","arguments":{"path":"/tmp/a"}},{"name":"list_directory","arguments":{"path":"/tmp"}}]</tool_calls>';
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(2);
        expect(result!.calls[0].name).toBe('read_file');
        expect(result!.calls[1].name).toBe('list_directory');
    });

    it('parses arg_key/arg_value pseudo tool markup', () => {
        const text = '<tool_call>write_file<arg_key>path</arg_key><arg_value>/tmp/out.md</arg_value><arg_key>content</arg_key><arg_value># Heading</arg_value></tool_call>';
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(1);
        expect(result!.calls[0].name).toBe('write_file');
        expect(JSON.parse(result!.calls[0].arguments)).toEqual({
            path: '/tmp/out.md',
            content: '# Heading',
        });
    });

    it('parses repeated arg_key/arg_value pseudo tool markup blocks', () => {
        const text = [
            '<tool_call>make_directory<arg_key>path</arg_key><arg_value>/tmp/out</arg_value></tool_call>',
            '<tool_call>write_file<arg_key>path</arg_key><arg_value>/tmp/out/file.md</arg_value><arg_key>content</arg_key><arg_value># Body</arg_value></tool_call>',
        ].join('\n');
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(2);
        expect(result!.calls[0].name).toBe('make_directory');
        expect(result!.calls[1].name).toBe('write_file');
    });

    it('parses function/parameter pseudo tool markup', () => {
        const text = [
            '<tool_call>',
            '<function=fetch_mediawiki_page>',
            '<parameter=api_url>https://example.test/api.php</parameter>',
            '<parameter=page>Asahiyama High School</parameter>',
            '</function>',
            '</tool_call>',
        ].join('\n');
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(1);
        expect(result!.calls[0].name).toBe('fetch_mediawiki_page');
        expect(JSON.parse(result!.calls[0].arguments)).toEqual({
            api_url: 'https://example.test/api.php',
            page: 'Asahiyama High School',
        });
    });

    it('parses invoke/parameter pseudo tool markup', () => {
        const text = [
            '<invoke name="read_file">',
            '<parameter name="path">/tmp/a</parameter>',
            '</invoke>',
        ].join('\n');
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(1);
        expect(result!.calls[0].name).toBe('read_file');
        expect(JSON.parse(result!.calls[0].arguments)).toEqual({ path: '/tmp/a' });
    });

    it('parses namespaced invoke wrappers emitted by routed models', () => {
        const text = [
            '<minimax:tool_call>',
            '<invoke name="write_file">',
            '<parameter name="path">/tmp/out.md</parameter>',
            '<parameter name="content"># Body</parameter>',
            '</invoke>',
            '</minimax:tool_call>',
        ].join('\n');
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(1);
        expect(result!.calls[0].name).toBe('write_file');
        expect(JSON.parse(result!.calls[0].arguments)).toEqual({
            path: '/tmp/out.md',
            content: '# Body',
        });
    });

    it('ignores invalid tool entries with missing names instead of returning empty-name calls', () => {
        const text = '{"tool_calls":[{"name":"","arguments":{"path":"/tmp/x"}},{"name":"read_file","arguments":{"path":"/tmp/y"}}]}';
        const result = parseEmulatedToolCalls(text);
        expect(result).not.toBeNull();
        expect(result!.calls).toHaveLength(1);
        expect(result!.calls[0].name).toBe('read_file');
        expect(JSON.parse(result!.calls[0].arguments)).toEqual({ path: '/tmp/y' });
    });
});

describe('wrapStreamWithToolEmulation', () => {
    it('converts text with tool call JSON into tool_call_delta events', async () => {
        const toolCallJson = JSON.stringify({
            tool_calls: [{ name: 'read_file', arguments: { path: '/tmp/test' } }],
        });

        async function* inner(): AsyncIterable<StreamEvent> {
            yield { type: 'text_delta', text: toolCallJson };
            yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
        }

        const events = await collectStream(wrapStreamWithToolEmulation(inner()));
        const toolDeltas = events.filter(e => e.type === 'tool_call_delta');
        expect(toolDeltas).toHaveLength(1);
        expect(toolDeltas[0]).toMatchObject({ type: 'tool_call_delta', index: 0, name: 'read_file' });
        const argsParsed = JSON.parse((toolDeltas[0] as { arguments: string }).arguments) as { path: string };
        expect(argsParsed.path).toBe('/tmp/test');
        // No preamble text_delta when tool call JSON starts at beginning
        expect(events.filter(e => e.type === 'text_delta')).toHaveLength(0);
    });

    it('re-emits text_delta when no tool call is found', async () => {
        async function* inner(): AsyncIterable<StreamEvent> {
            yield { type: 'text_delta', text: 'Hello, world!' };
            yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 3 } };
        }

        const events = await collectStream(wrapStreamWithToolEmulation(inner()));
        expect(events.filter(e => e.type === 'text_delta')).toHaveLength(1);
        expect(events.filter(e => e.type === 'tool_call_delta')).toHaveLength(0);
    });

    it('passes through error events and stops', async () => {
        async function* inner(): AsyncIterable<StreamEvent> {
            yield { type: 'text_delta', text: 'partial' };
            yield { type: 'error', error: { code: 'llm.server_error', message: 'boom' } };
            yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
        }

        const events = await collectStream(wrapStreamWithToolEmulation(inner()));
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('error');
    });

    it('preserves done event with correct usage', async () => {
        const toolCallJson = JSON.stringify({
            tool_calls: [{ name: 'read_file', arguments: { path: '/x' } }],
        });

        async function* inner(): AsyncIterable<StreamEvent> {
            yield { type: 'text_delta', text: toolCallJson };
            yield { type: 'done', finishReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 50 } };
        }

        const events = await collectStream(wrapStreamWithToolEmulation(inner()));
        const done = events.find(e => e.type === 'done');
        expect(done).toMatchObject({ finishReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 50 } });
    });

    it('yields preamble text before tool_call_delta when model outputs text before JSON (BUG-2 regression)', async () => {
        const toolCallJson = JSON.stringify({
            tool_calls: [{ name: 'read_file', arguments: { path: '/tmp/test' } }],
        });
        const preamble = 'Let me check that file: ';

        async function* inner(): AsyncIterable<StreamEvent> {
            yield { type: 'text_delta', text: preamble + toolCallJson };
            yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
        }

        const events = await collectStream(wrapStreamWithToolEmulation(inner()));
        const textDeltas = events.filter(e => e.type === 'text_delta');
        const toolDeltas = events.filter(e => e.type === 'tool_call_delta');
        expect(textDeltas).toHaveLength(1);
        expect((textDeltas[0] as { text: string }).text).toBe('Let me check that file:');
        expect(toolDeltas).toHaveLength(1);
        expect(toolDeltas[0]).toMatchObject({ name: 'read_file' });
    });

    it('does not emit markdown fence text before fenced tool-call JSON', async () => {
        const toolCallJson = [
            '```json',
            '{"tool_calls":[{"name":"read_file","arguments":{"path":"/tmp/test"}}]}',
            '```',
        ].join('\n');

        async function* inner(): AsyncIterable<StreamEvent> {
            yield { type: 'text_delta', text: toolCallJson };
            yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
        }

        const events = await collectStream(wrapStreamWithToolEmulation(inner()));
        expect(events.filter(e => e.type === 'text_delta')).toHaveLength(0);
        expect(events.filter(e => e.type === 'tool_call_delta')).toHaveLength(1);
    });

    it('drops fence markers when prose precedes fenced tool-call JSON', async () => {
        const toolCallJson = [
            'I will read the file now.',
            '```json',
            '{"tool_calls":[{"name":"read_file","arguments":{"path":"/tmp/test"}}]}',
            '```',
        ].join('\n');

        async function* inner(): AsyncIterable<StreamEvent> {
            yield { type: 'text_delta', text: toolCallJson };
            yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
        }

        const events = await collectStream(wrapStreamWithToolEmulation(inner()));
        const textDeltas = events.filter(e => e.type === 'text_delta');
        expect(textDeltas).toHaveLength(1);
        expect((textDeltas[0] as { text: string }).text).toBe('I will read the file now.');
        expect(events.filter(e => e.type === 'tool_call_delta')).toHaveLength(1);
    });

    it('buffers chunked text and parses tool calls from combined text', async () => {
        const fullJson = JSON.stringify({
            tool_calls: [{ name: 'read_file', arguments: { path: '/chunk' } }],
        });
        // Split the JSON across multiple text_delta events
        const half = Math.floor(fullJson.length / 2);

        async function* inner(): AsyncIterable<StreamEvent> {
            yield { type: 'text_delta', text: fullJson.slice(0, half) };
            yield { type: 'text_delta', text: fullJson.slice(half) };
            yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
        }

        const events = await collectStream(wrapStreamWithToolEmulation(inner()));
        const toolDeltas = events.filter(e => e.type === 'tool_call_delta');
        expect(toolDeltas).toHaveLength(1);
        expect(toolDeltas[0]).toMatchObject({ name: 'read_file' });
    });

    it('salvages truncated emulated tool-call JSON before trailing prose', async () => {
        const malformed = '{"tool_calls":[{"name":"read_file","arguments":{"path":"/tmp/test"}}]</think>next';

        async function* inner(): AsyncIterable<StreamEvent> {
            yield { type: 'text_delta', text: malformed };
            yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
        }

        const events = await collectStream(wrapStreamWithToolEmulation(inner()));
        const toolDeltas = events.filter(e => e.type === 'tool_call_delta');
        expect(toolDeltas).toHaveLength(1);
        expect(toolDeltas[0]).toMatchObject({ name: 'read_file' });
    });

    it('converts pseudo tool markup into tool_call_delta events', async () => {
        async function* inner(): AsyncIterable<StreamEvent> {
            yield {
                type: 'text_delta',
                text: '<tool_call>{"name":"read_file","arguments":{"path":"/tmp/pseudo"}}</tool_call>',
            };
            yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
        }

        const events = await collectStream(wrapStreamWithToolEmulation(inner()));
        const toolDeltas = events.filter(e => e.type === 'tool_call_delta');
        expect(toolDeltas).toHaveLength(1);
        expect(toolDeltas[0]).toMatchObject({ name: 'read_file' });
        expect(JSON.parse((toolDeltas[0] as { arguments: string }).arguments)).toEqual({ path: '/tmp/pseudo' });
    });

    it('emits tool calls before the inner stream finishes when JSON is already complete', async () => {
        const toolCallJson = JSON.stringify({
            tool_calls: [{ name: 'read_file', arguments: { path: '/tmp/early' } }],
        });
        let releaseDone: (() => void) | undefined;
        const doneGate = new Promise<void>(resolve => {
            releaseDone = resolve;
        });

        async function* inner(): AsyncIterable<StreamEvent> {
            yield { type: 'text_delta', text: toolCallJson };
            await doneGate;
            yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
        }

        const iterator = wrapStreamWithToolEmulation(inner())[Symbol.asyncIterator]();
        const first = await Promise.race([
            iterator.next(),
            new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 50)),
        ]);

        expect(first).not.toBe('timeout');
        const firstResult = first as IteratorResult<StreamEvent>;
        expect(firstResult.done).toBe(false);
        expect(firstResult.value).toMatchObject({ type: 'tool_call_delta', name: 'read_file' });

        releaseDone?.();
        const remaining: StreamEvent[] = [];
        for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
            remaining.push(event);
        }
        expect(remaining.find(event => event.type === 'done')).toBeDefined();
    });
});

describe('wrapStreamWithPreambleStrip', () => {
    it('strips CRLF thinking preambles before yielding text', async () => {
        async function* inner(): AsyncIterable<StreamEvent> {
            yield {
                type: 'text_delta',
                text: 'Thinking...\r\n> first thought\r\n> second thought\r\n\r\nVisible answer',
            };
            yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
        }

        const events = await collectStream(wrapStreamWithPreambleStrip(inner()));
        expect(events.filter(e => e.type === 'tool_call_delta')).toHaveLength(0);
        const textDeltas = events.filter(e => e.type === 'text_delta');
        expect(textDeltas).toHaveLength(1);
        expect((textDeltas[0] as { text: string }).text).toBe('Visible answer');
        expect(events.find(e => e.type === 'done')).toBeDefined();
    });
});
