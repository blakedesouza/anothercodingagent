import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockNanoGPTServer } from '../helpers/mock-nanogpt-server.js';
import { OpenAiDriver } from '../../src/providers/openai-driver.js';
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
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 1024,
        temperature: 0.7,
        ...overrides,
    };
}

function makeProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
        name: 'openai',
        driver: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        timeout: 30000,
        priority: 1,
        ...overrides,
    };
}

describe('M5.1 — OpenAI Driver', () => {
    // Reuse MockNanoGPTServer since OpenAI and NanoGPT share the same SSE format
    let server: MockNanoGPTServer;
    let driver: OpenAiDriver;

    beforeEach(async () => {
        server = new MockNanoGPTServer();
        await server.start();
        driver = new OpenAiDriver({
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
            const orig = process.env.OPENAI_API_KEY;
            delete process.env.OPENAI_API_KEY;
            try {
                const noKeyDriver = new OpenAiDriver({ baseUrl: server.baseUrl });
                const result = noKeyDriver.validate(makeProviderConfig({ baseUrl: server.baseUrl }));
                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.code).toBe('config.missing_api_key');
                }
            } finally {
                if (orig !== undefined) process.env.OPENAI_API_KEY = orig;
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
        it('returns correct capabilities for gpt-4o', () => {
            const caps = driver.capabilities('gpt-4o');
            expect(caps.maxContext).toBe(128_000);
            expect(caps.maxOutput).toBe(16_384);
            expect(caps.supportsTools).toBe('native');
            expect(caps.supportsStreaming).toBe(true);
        });

        it('throws for claude model (not an OpenAI model)', () => {
            expect(() => driver.capabilities('claude-sonnet-4-20250514')).toThrow('OpenAiDriver: unsupported model');
        });

        it('throws for unknown gpt model', () => {
            expect(() => driver.capabilities('gpt-unknown-model')).toThrow('Unknown model');
        });
    });

    // --- embed() ---

    describe('embed()', () => {
        it('throws not_implemented', async () => {
            await expect(driver.embed(['hello'], 'text-embedding-3-small')).rejects.toMatchObject({
                code: 'not_implemented',
            });
        });
    });

    // --- stream(): text response normalization ---

    describe('stream() — text response', () => {
        it('normalizes OpenAI SSE token deltas to text_delta events', async () => {
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
            server.addTextResponse('Hi', { inputTokens: 30, outputTokens: 10 });

            const events = await collectEvents(driver.stream(makeRequest()));

            const done = events.find(e => e.type === 'done');
            expect(done).toBeDefined();
            if (done?.type === 'done') {
                expect(done.finishReason).toBe('stop');
                expect(done.usage.inputTokens).toBe(30);
                expect(done.usage.outputTokens).toBe(10);
            }
        });

        it('sends Authorization: Bearer header', async () => {
            server.addTextResponse('OK');
            await collectEvents(driver.stream(makeRequest()));

            const req = server.receivedRequests[0];
            expect(req.headers['authorization']).toBe('Bearer test-api-key');
        });
    });

    // --- stream(): tool call normalization ---

    describe('stream() — tool call response', () => {
        it('normalizes OpenAI tool_calls deltas to tool_call_delta events', async () => {
            server.addToolCallResponse([
                { id: 'call_001', name: 'read_file', arguments: { path: '/tmp/test.txt' } },
            ]);

            const events = await collectEvents(driver.stream(makeRequest()));

            const toolDeltas = events.filter(e => e.type === 'tool_call_delta');
            expect(toolDeltas.length).toBeGreaterThan(0);

            const nameEvent = toolDeltas.find(e => e.type === 'tool_call_delta' && e.name !== undefined);
            expect(nameEvent).toBeDefined();
            if (nameEvent?.type === 'tool_call_delta') {
                expect(nameEvent.name).toBe('read_file');
            }

            const argJson = toolDeltas
                .filter((e): e is Extract<StreamEvent, { type: 'tool_call_delta' }> =>
                    e.type === 'tool_call_delta')
                .map(e => e.arguments ?? '')
                .join('');
            const parsed = JSON.parse(argJson);
            expect(parsed.path).toBe('/tmp/test.txt');
        });

        it('done event has tool_calls finish reason', async () => {
            server.addToolCallResponse([
                { id: 'call_002', name: 'write_file', arguments: { path: '/out.txt', content: 'hi' } },
            ]);

            const events = await collectEvents(driver.stream(makeRequest()));
            const done = events.find(e => e.type === 'done');
            expect(done?.type).toBe('done');
            if (done?.type === 'done') {
                expect(done.finishReason).toBe('tool_calls');
            }
        });
    });

    // --- stream(): HTTP error responses ---

    describe('stream() — HTTP error responses', () => {
        it('429 → llm.rate_limited', async () => {
            server.addErrorResponse(429, 'Rate limited', 'rate_limit_exceeded');

            const events = await collectEvents(driver.stream(makeRequest()));
            expect(events).toHaveLength(1);
            if (events[0].type === 'error') {
                expect(events[0].error.code).toBe('llm.rate_limited');
            }
        });

        it('401 → llm.auth_error', async () => {
            server.addErrorResponse(401, 'Unauthorized', 'auth_error');

            const events = await collectEvents(driver.stream(makeRequest()));
            expect(events).toHaveLength(1);
            if (events[0].type === 'error') {
                expect(events[0].error.code).toBe('llm.auth_error');
            }
        });

        it('500 → llm.server_error', async () => {
            server.addErrorResponse(500, 'Internal server error', 'server_error');

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

            const shortDriver = new OpenAiDriver({
                apiKey: 'test-api-key',
                baseUrl: server.baseUrl,
                timeout: 200,
            });

            const events = await collectEvents(shortDriver.stream(makeRequest()));
            expect(events).toHaveLength(1);
            if (events[0].type === 'error') {
                expect(events[0].error.code).toBe('llm.timeout');
            }
        });

        it('survives a slow-but-active stream (idle timer resets on each SSE event)', async () => {
            // 40-char text → 4 chunks of 10, each 100ms apart → total ~400ms
            // Timeout is 500ms, but idle timer resets on each chunk (100ms gap < 500ms timeout)
            // 5x margin avoids flakiness under CI load
            server.addTextResponse(
                'This is a slow but active stream test!',
                { chunkDelayMs: 100 },
            );

            const slowDriver = new OpenAiDriver({
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

        it('captures delta.reasoning_content as text_delta (thinking-only response)', async () => {
            // Reasoning models (DeepSeek R1, o-series) emit thinking in reasoning_content,
            // not content. A reasoning-only response must not trigger the empty-response guard.
            const chunk = JSON.stringify({
                id: 'test', object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { reasoning_content: 'Let me think...' }, finish_reason: null }],
            });
            const done = JSON.stringify({
                id: 'test', object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
            });
            server.addResponse({ type: 'raw_stream', rawBody: `data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n` });

            const events = await collectEvents(driver.stream(makeRequest()));

            const textDeltas = events.filter(e => e.type === 'text_delta');
            expect(textDeltas.length).toBeGreaterThan(0);
            const fullText = textDeltas.map(e => e.type === 'text_delta' ? e.text : '').join('');
            expect(fullText).toBe('Let me think...');

            const errorEvents = events.filter(e => e.type === 'error');
            expect(errorEvents).toHaveLength(0);
        });

        it('captures both delta.reasoning_content and delta.content when both present', async () => {
            const thinkChunk = JSON.stringify({
                id: 'test', object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { reasoning_content: '<think>' }, finish_reason: null }],
            });
            const answerChunk = JSON.stringify({
                id: 'test', object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content: 'The answer is 42.' }, finish_reason: null }],
            });
            const done = JSON.stringify({
                id: 'test', object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 8 },
            });
            const rawBody = `data: ${thinkChunk}\n\ndata: ${answerChunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`;
            server.addResponse({ type: 'raw_stream', rawBody });

            const events = await collectEvents(driver.stream(makeRequest()));

            const fullText = events
                .filter(e => e.type === 'text_delta')
                .map(e => e.type === 'text_delta' ? e.text : '').join('');
            expect(fullText).toBe('<think>The answer is 42.');

            const errorEvents = events.filter(e => e.type === 'error');
            expect(errorEvents).toHaveLength(0);
        });
    });

    describe('stream() — timeout', () => {
        it('times out when stream goes silent mid-response', async () => {
            const chunk = JSON.stringify({
                id: 'mock-chunk',
                object: 'chat.completion.chunk',
                model: 'mock-model',
                choices: [{
                    index: 0,
                    delta: { content: 'Hello' },
                    finish_reason: null,
                }],
            });
            server.addResponse({
                type: 'raw_stream',
                rawBody: `data: ${chunk}\n\n`,
                hangAfterSend: true,
            });

            const shortDriver = new OpenAiDriver({
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
