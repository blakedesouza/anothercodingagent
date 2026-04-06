import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAnthropicServer } from '../helpers/mock-anthropic-server.js';
import { AnthropicDriver } from '../../src/providers/anthropic-driver.js';
import type { StreamEvent, ModelRequest, ProviderConfig } from '../../src/types/provider.js';

async function collectEvents(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const event of stream) {
        events.push(event);
    }
    return events;
}

function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
    return {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 1024,
        temperature: 0.7,
        ...overrides,
    };
}

function makeProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
        name: 'anthropic',
        driver: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        timeout: 30000,
        priority: 1,
        ...overrides,
    };
}

describe('M5.1 — Anthropic Driver', () => {
    let server: MockAnthropicServer;
    let driver: AnthropicDriver;

    beforeEach(async () => {
        server = new MockAnthropicServer();
        await server.start();
        driver = new AnthropicDriver({
            apiKey: 'test-api-key',
            baseUrl: server.baseUrl,
            timeout: 5000,
        });
    });

    afterEach(async () => {
        await server.stop();
    });

    // --- validate() ---

    describe('validate()', () => {
        it('returns ConfigError when API key is missing', () => {
            const orig = process.env.ANTHROPIC_API_KEY;
            delete process.env.ANTHROPIC_API_KEY;
            try {
                const noKeyDriver = new AnthropicDriver({ baseUrl: server.baseUrl });
                const result = noKeyDriver.validate(makeProviderConfig({ baseUrl: server.baseUrl }));
                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.code).toBe('config.missing_api_key');
                }
            } finally {
                if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
            }
        });

        it('returns ConfigError when API key is empty string', () => {
            const emptyDriver = new AnthropicDriver({ apiKey: '', baseUrl: server.baseUrl });
            const result = emptyDriver.validate(makeProviderConfig({ baseUrl: server.baseUrl }));
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.code).toBe('config.missing_api_key');
            }
        });

        it('succeeds with valid config', () => {
            const result = driver.validate(makeProviderConfig({ baseUrl: server.baseUrl }));
            expect(result.ok).toBe(true);
        });

        it('returns ConfigError for invalid base URL', () => {
            const result = driver.validate(makeProviderConfig({ baseUrl: 'not-a-url' }));
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error.code).toBe('config.invalid_base_url');
            }
        });
    });

    // --- capabilities() ---

    describe('capabilities()', () => {
        it('returns correct capabilities for claude-sonnet', () => {
            const caps = driver.capabilities('claude-sonnet-4-20250514');
            expect(caps.maxContext).toBe(200_000);
            expect(caps.maxOutput).toBe(16_384);
            expect(caps.supportsTools).toBe('native');
            expect(caps.supportsStreaming).toBe(true);
            expect(caps.supportsPrefill).toBe(true);
        });

        it('throws for non-claude model (gpt-4o)', () => {
            expect(() => driver.capabilities('gpt-4o')).toThrow('AnthropicDriver: unsupported model');
        });

        it('throws for unknown claude model', () => {
            expect(() => driver.capabilities('claude-unknown-model')).toThrow('Unknown model');
        });
    });

    // --- embed() ---

    describe('embed()', () => {
        it('throws not_implemented', async () => {
            await expect(driver.embed(['hello'], 'claude-sonnet-4-20250514')).rejects.toMatchObject({
                code: 'not_implemented',
            });
        });
    });

    // --- stream(): text response normalization ---

    describe('stream() — text response', () => {
        it('normalizes Anthropic content blocks to text_delta events', async () => {
            server.addTextResponse('Hello, world!');

            const events = await collectEvents(driver.stream(makeRequest()));

            const textDeltas = events.filter(e => e.type === 'text_delta');
            expect(textDeltas.length).toBeGreaterThan(0);

            const fullText = textDeltas
                .map(e => e.type === 'text_delta' ? e.text : '')
                .join('');
            expect(fullText).toBe('Hello, world!');
        });

        it('final done event preserves finishReason and usage (token counts)', async () => {
            server.addTextResponse('Hi', { inputTokens: 42, outputTokens: 7 });

            const events = await collectEvents(driver.stream(makeRequest()));

            const done = events.find(e => e.type === 'done');
            expect(done).toBeDefined();
            if (done?.type === 'done') {
                expect(done.finishReason).toBe('end_turn');
                expect(done.usage.inputTokens).toBe(42);
                expect(done.usage.outputTokens).toBe(7);
            }
        });

        it('yields done as last event', async () => {
            server.addTextResponse('test');

            const events = await collectEvents(driver.stream(makeRequest()));

            const lastEvent = events[events.length - 1];
            expect(lastEvent.type).toBe('done');
        });

        it('sends correct Anthropic request headers', async () => {
            server.addTextResponse('OK');
            await collectEvents(driver.stream(makeRequest()));

            expect(server.receivedRequests).toHaveLength(1);
            const req = server.receivedRequests[0];
            expect(req.headers['x-api-key']).toBe('test-api-key');
            expect(req.headers['anthropic-version']).toBe('2023-06-01');
            expect(req.headers['content-type']).toBe('application/json');
        });

        it('sends system message in top-level system field', async () => {
            server.addTextResponse('Sure');
            const request = makeRequest({
                messages: [
                    { role: 'system', content: 'You are a helpful assistant.' },
                    { role: 'user', content: 'Hi' },
                ],
            });
            await collectEvents(driver.stream(request));

            const body = server.receivedRequests[0].body as Record<string, unknown>;
            expect(body.system).toBe('You are a helpful assistant.');
            const messages = body.messages as Array<Record<string, unknown>>;
            // system is extracted, so only user message remains
            expect(messages.every(m => m.role !== 'system')).toBe(true);
        });
    });

    // --- stream(): tool call normalization ---

    describe('stream() — tool call response', () => {
        it('normalizes Anthropic tool_use blocks to tool_call_delta events', async () => {
            server.addToolCallResponse([
                { id: 'toolu_01', name: 'read_file', arguments: { path: '/tmp/test.txt' } },
            ]);

            const events = await collectEvents(driver.stream(makeRequest()));

            const toolDeltas = events.filter(e => e.type === 'tool_call_delta');
            expect(toolDeltas.length).toBeGreaterThan(0);

            const nameEvent = toolDeltas.find(e => e.type === 'tool_call_delta' && e.name !== undefined);
            expect(nameEvent).toBeDefined();
            if (nameEvent?.type === 'tool_call_delta') {
                expect(nameEvent.name).toBe('read_file');
                expect(nameEvent.index).toBe(0);
            }

            const argJson = toolDeltas
                .filter((e): e is Extract<StreamEvent, { type: 'tool_call_delta' }> =>
                    e.type === 'tool_call_delta')
                .map(e => e.arguments ?? '')
                .join('');
            const parsed = JSON.parse(argJson);
            expect(parsed.path).toBe('/tmp/test.txt');
        });

        it('done event has tool_use stop reason and token counts', async () => {
            server.addToolCallResponse(
                [{ id: 'toolu_02', name: 'write_file', arguments: { path: '/out.txt', content: 'hi' } }],
                { inputTokens: 20, outputTokens: 15 },
            );

            const events = await collectEvents(driver.stream(makeRequest()));

            const done = events.find(e => e.type === 'done');
            expect(done).toBeDefined();
            if (done?.type === 'done') {
                expect(done.finishReason).toBe('tool_use');
                expect(done.usage.inputTokens).toBe(20);
                expect(done.usage.outputTokens).toBe(15);
            }
        });

        it('sends tools in Anthropic input_schema format', async () => {
            server.addTextResponse('No tools needed.');
            const request = makeRequest({
                tools: [{
                    name: 'read_file',
                    description: 'Read a file from disk',
                    parameters: {
                        type: 'object',
                        properties: { path: { type: 'string' } },
                        required: ['path'],
                    },
                }],
            });
            await collectEvents(driver.stream(request));

            const body = server.receivedRequests[0].body as Record<string, unknown>;
            const tools = body.tools as Array<Record<string, unknown>>;
            expect(tools).toHaveLength(1);
            expect(tools[0].name).toBe('read_file');
            // Anthropic uses input_schema, not parameters
            expect(tools[0].input_schema).toBeDefined();
            expect(tools[0].parameters).toBeUndefined();
        });
    });

    // --- stream(): HTTP error responses ---

    describe('stream() — HTTP error responses', () => {
        it('401 → llm.auth_error', async () => {
            server.addErrorResponse(401, 'Unauthorized', 'authentication_error');

            const events = await collectEvents(driver.stream(makeRequest()));
            expect(events).toHaveLength(1);
            expect(events[0].type).toBe('error');
            if (events[0].type === 'error') {
                expect(events[0].error.code).toBe('llm.auth_error');
            }
        });

        it('429 → llm.rate_limited', async () => {
            server.addErrorResponse(429, 'Rate limited', 'rate_limit_error');

            const events = await collectEvents(driver.stream(makeRequest()));
            expect(events).toHaveLength(1);
            if (events[0].type === 'error') {
                expect(events[0].error.code).toBe('llm.rate_limited');
            }
        });

        it('500 → llm.server_error', async () => {
            server.addErrorResponse(500, 'Internal server error', 'api_error');

            const events = await collectEvents(driver.stream(makeRequest()));
            expect(events).toHaveLength(1);
            if (events[0].type === 'error') {
                expect(events[0].error.code).toBe('llm.server_error');
            }
        });
    });

    // --- stream(): timeout ---

    describe('stream() — timeout', () => {
        it('yields llm.timeout when server hangs (initial connection timeout)', async () => {
            server.addResponse({ type: 'hang' });

            const shortDriver = new AnthropicDriver({
                apiKey: 'test-api-key',
                baseUrl: server.baseUrl,
                timeout: 200,
            });

            const events = await collectEvents(shortDriver.stream(makeRequest()));
            expect(events).toHaveLength(1);
            expect(events[0].type).toBe('error');
            if (events[0].type === 'error') {
                expect(events[0].error.code).toBe('llm.timeout');
            }
        });

        it('survives a slow-but-active stream (idle timer resets on each SSE event)', async () => {
            // Anthropic sends ~6 events for a text response. With 100ms delay
            // between events, total ~600ms. Timeout is 500ms, but idle timer
            // resets on each event (100ms gap < 500ms timeout).
            // 5x margin avoids flakiness under CI load.
            server.addTextResponse('Hello from a slow Anthropic stream', { chunkDelayMs: 100 });

            const slowDriver = new AnthropicDriver({
                apiKey: 'test-api-key',
                baseUrl: server.baseUrl,
                timeout: 500,
            });

            const events = await collectEvents(slowDriver.stream(makeRequest()));

            const doneEvent = events.find(e => e.type === 'done');
            expect(doneEvent).toBeDefined();

            const textEvents = events.filter(e => e.type === 'text_delta');
            expect(textEvents.length).toBeGreaterThan(0);

            const errorEvents = events.filter(e => e.type === 'error');
            expect(errorEvents).toHaveLength(0);
        }, 10_000);

        it('times out when stream goes silent mid-response', async () => {
            // Send message_start + one content block delta, then hang
            const messageStart = JSON.stringify({
                type: 'message_start',
                message: {
                    id: 'msg_mock', type: 'message', role: 'assistant',
                    content: [], model: 'mock-model', stop_reason: null,
                    usage: { input_tokens: 10, output_tokens: 0 },
                },
            });
            const blockStart = JSON.stringify({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
            });
            const blockDelta = JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Hi' },
            });

            const rawBody = [
                `event: message_start\ndata: ${messageStart}\n\n`,
                `event: content_block_start\ndata: ${blockStart}\n\n`,
                `event: content_block_delta\ndata: ${blockDelta}\n\n`,
            ].join('');

            server.addResponse({ type: 'raw_stream', rawBody, hangAfterSend: true });

            const shortDriver = new AnthropicDriver({
                apiKey: 'test-api-key',
                baseUrl: server.baseUrl,
                timeout: 500,
            });

            const events = await collectEvents(shortDriver.stream(makeRequest()));

            const textEvents = events.filter(e => e.type === 'text_delta');
            expect(textEvents.length).toBeGreaterThan(0);

            const lastEvent = events[events.length - 1];
            expect(lastEvent.type).toBe('error');
            if (lastEvent.type === 'error') {
                expect(lastEvent.error.code).toBe('llm.timeout');
            }
        }, 10_000);
    });
});
