import { describe, it, expect } from 'vitest';
import {
    buildToolSchemaPrompt,
    injectToolsIntoRequest,
    parseEmulatedToolCalls,
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
});
