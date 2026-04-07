import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockNanoGPTServer } from '../helpers/mock-nanogpt-server.js';
import { NanoGptDriver } from '../../src/providers/nanogpt-driver.js';
import type { ModelCatalog, ModelCatalogEntry } from '../../src/providers/model-catalog.js';
import type { StreamEvent, ModelRequest, ProviderConfig } from '../../src/types/provider.js';

/**
 * Helper: collect all stream events from a driver.stream() call.
 */
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
        name: 'nanogpt',
        driver: 'nanogpt',
        baseUrl: 'https://api.nano-gpt.com/v1',
        timeout: 30000,
        priority: 1,
        ...overrides,
    };
}

describe('M1.4 — Provider Interface + NanoGPT Driver', () => {
    let server: MockNanoGPTServer;
    let driver: NanoGptDriver;

    beforeEach(async () => {
        server = new MockNanoGPTServer();
        await server.start();
        driver = new NanoGptDriver({
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
            // Clear env to ensure no fallback
            const orig = process.env.NANOGPT_API_KEY;
            delete process.env.NANOGPT_API_KEY;
            try {
                const noKeyDriver = new NanoGptDriver({ baseUrl: server.baseUrl });
                const result = noKeyDriver.validate(makeProviderConfig());
                expect(result.ok).toBe(false);
                if (!result.ok) {
                    expect(result.error.code).toBe('config.missing_api_key');
                }
            } finally {
                if (orig !== undefined) process.env.NANOGPT_API_KEY = orig;
            }
        });

        it('returns ConfigError when API key is empty string', () => {
            const emptyKeyDriver = new NanoGptDriver({ apiKey: '', baseUrl: server.baseUrl });
            const result = emptyKeyDriver.validate(makeProviderConfig());
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
        it('returns correct maxContext for known models', () => {
            const caps = driver.capabilities('claude-sonnet-4-20250514');
            expect(caps.maxContext).toBe(200_000);
            expect(caps.maxOutput).toBe(16_384);
            expect(caps.supportsTools).toBe('native');
            expect(caps.supportsStreaming).toBe(true);
            expect(caps.bytesPerToken).toBe(3.5);
        });

        it('returns correct capabilities for GPT-4o', () => {
            const caps = driver.capabilities('gpt-4o');
            expect(caps.maxContext).toBe(128_000);
            expect(caps.supportsTools).toBe('native');
        });

        it('returns default capabilities for unknown model', () => {
            const caps = driver.capabilities('nonexistent-model');
            expect(caps.supportsTools).toBe('native');
            expect(caps.maxContext).toBe(32_000);
        });
    });

    // --- stream(): text response ---

    describe('stream() — text response', () => {
        it('yields text_delta events followed by done', async () => {
            server.addTextResponse('Hello, world!');

            const events = await collectEvents(driver.stream(makeRequest()));

            const textDeltas = events.filter(e => e.type === 'text_delta');
            expect(textDeltas.length).toBeGreaterThan(0);

            // Reconstruct full text from deltas
            const fullText = textDeltas
                .map(e => e.type === 'text_delta' ? e.text : '')
                .join('');
            expect(fullText).toBe('Hello, world!');

            const doneEvents = events.filter(e => e.type === 'done');
            expect(doneEvents).toHaveLength(1);
            if (doneEvents[0].type === 'done') {
                expect(doneEvents[0].finishReason).toBe('stop');
                expect(doneEvents[0].usage.inputTokens).toBeGreaterThanOrEqual(0);
                expect(doneEvents[0].usage.outputTokens).toBeGreaterThanOrEqual(0);
            }
        });

        it('sends correct request headers', async () => {
            server.addTextResponse('OK');
            await collectEvents(driver.stream(makeRequest()));

            expect(server.receivedRequests).toHaveLength(1);
            const req = server.receivedRequests[0];
            expect(req.headers['authorization']).toBe('Bearer test-api-key');
            expect(req.headers['content-type']).toBe('application/json');
        });

        it('sends correct request body', async () => {
            server.addTextResponse('OK');
            const request = makeRequest({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: 'You are helpful.' },
                    { role: 'user', content: 'Hi' },
                ],
                maxTokens: 2048,
                temperature: 0.5,
                topP: 0.95,
                thinking: { type: 'enabled' },
            });
            await collectEvents(driver.stream(request));

            const body = server.receivedRequests[0].body as Record<string, unknown>;
            expect(body.model).toBe('gpt-4o');
            expect(body.stream).toBe(true);
            expect(body.max_tokens).toBe(2048);
            expect(body.temperature).toBe(0.5);
            expect(body.top_p).toBe(0.95);
            expect(body.thinking).toEqual({ type: 'enabled' });
            expect(body.tool_choice).toBe('none');
            const messages = body.messages as Array<Record<string, unknown>>;
            expect(messages).toHaveLength(2);
            expect(messages[0].role).toBe('system');
            expect(messages[1].role).toBe('user');
        });
    });

    // --- stream(): tool call response ---

    describe('stream() — tool call response', () => {
        it('yields tool_call_delta events with correct name and arguments', async () => {
            server.addToolCallResponse([
                { id: 'call_001', name: 'read_file', arguments: { path: '/tmp/test.txt' } },
            ]);

            const events = await collectEvents(driver.stream(makeRequest()));

            const toolDeltas = events.filter(e => e.type === 'tool_call_delta');
            expect(toolDeltas.length).toBeGreaterThan(0);

            // First delta should have the tool name
            const nameEvent = toolDeltas.find(e =>
                e.type === 'tool_call_delta' && e.name !== undefined,
            );
            expect(nameEvent).toBeDefined();
            if (nameEvent?.type === 'tool_call_delta') {
                expect(nameEvent.name).toBe('read_file');
                expect(nameEvent.index).toBe(0);
            }

            // Accumulate arguments from all deltas (may be split across chunks)
            const accumulatedArgs = toolDeltas
                .filter((e): e is Extract<StreamEvent, { type: 'tool_call_delta' }> =>
                    e.type === 'tool_call_delta')
                .map(e => e.arguments ?? '')
                .join('');
            const parsedArgs = JSON.parse(accumulatedArgs);
            expect(parsedArgs.path).toBe('/tmp/test.txt');

            // Should end with done
            const done = events.find(e => e.type === 'done');
            expect(done).toBeDefined();
            if (done?.type === 'done') {
                expect(done.finishReason).toBe('tool_calls');
            }
        });

        it('reconstructs complete tool call from accumulated deltas', async () => {
            server.addToolCallResponse([
                { id: 'call_002', name: 'write_file', arguments: { path: '/tmp/out.txt', content: 'hello' } },
            ]);

            const events = await collectEvents(driver.stream(makeRequest()));

            // Accumulate tool call from deltas
            const toolDeltas = events.filter(
                (e): e is Extract<StreamEvent, { type: 'tool_call_delta' }> =>
                    e.type === 'tool_call_delta',
            );

            let name = '';
            let args = '';
            for (const delta of toolDeltas) {
                if (delta.name) name = delta.name;
                if (delta.arguments) args += delta.arguments;
            }

            expect(name).toBe('write_file');
            const parsedArgs = JSON.parse(args);
            expect(parsedArgs.path).toBe('/tmp/out.txt');
            expect(parsedArgs.content).toBe('hello');
        });
    });

    // --- stream(): error responses ---

    describe('stream() — HTTP error responses', () => {
        it('429 → llm.rate_limited error event', async () => {
            server.addErrorResponse(429, 'Rate limited', 'rate_limit_exceeded');

            const events = await collectEvents(driver.stream(makeRequest()));

            expect(events).toHaveLength(1);
            expect(events[0].type).toBe('error');
            if (events[0].type === 'error') {
                expect(events[0].error.code).toBe('llm.rate_limited');
            }
        });

        it('500 → llm.server_error error event', async () => {
            server.addErrorResponse(500, 'Internal server error', 'server_error');

            const events = await collectEvents(driver.stream(makeRequest()));

            expect(events).toHaveLength(1);
            expect(events[0].type).toBe('error');
            if (events[0].type === 'error') {
                expect(events[0].error.code).toBe('llm.server_error');
            }
        });

        it('401 → llm.auth_error error event', async () => {
            server.addErrorResponse(401, 'Unauthorized', 'auth_error');

            const events = await collectEvents(driver.stream(makeRequest()));

            expect(events).toHaveLength(1);
            expect(events[0].type).toBe('error');
            if (events[0].type === 'error') {
                expect(events[0].error.code).toBe('llm.auth_error');
            }
        });
    });

    // --- stream(): timeout ---

    describe('stream() — timeout', () => {
        it('yields llm.timeout error when server hangs (initial connection timeout)', async () => {
            server.addResponse({ type: 'hang' });

            const shortTimeoutDriver = new NanoGptDriver({
                apiKey: 'test-api-key',
                baseUrl: server.baseUrl,
                timeout: 200,
            });

            const events = await collectEvents(shortTimeoutDriver.stream(makeRequest()));

            expect(events).toHaveLength(1);
            expect(events[0].type).toBe('error');
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

            const slowDriver = new NanoGptDriver({
                apiKey: 'test-api-key',
                baseUrl: server.baseUrl,
                timeout: 500,
            });

            const events = await collectEvents(slowDriver.stream(makeRequest()));

            // Stream completes normally despite total duration > timeout
            const doneEvent = events.find(e => e.type === 'done');
            expect(doneEvent).toBeDefined();

            const textEvents = events.filter(e => e.type === 'text_delta');
            expect(textEvents.length).toBeGreaterThan(0);

            const errorEvents = events.filter(e => e.type === 'error');
            expect(errorEvents).toHaveLength(0);
        }, 10_000);

        it('times out when stream goes silent mid-response', async () => {
            // Send one chunk then hang (no more data, connection stays open)
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

            const shortDriver = new NanoGptDriver({
                apiKey: 'test-api-key',
                baseUrl: server.baseUrl,
                timeout: 500,
            });

            const events = await collectEvents(shortDriver.stream(makeRequest()));

            // Should have received the text delta before timing out
            const textEvents = events.filter(e => e.type === 'text_delta');
            expect(textEvents.length).toBeGreaterThan(0);

            // Last event should be timeout error
            const lastEvent = events[events.length - 1];
            expect(lastEvent.type).toBe('error');
            if (lastEvent.type === 'error') {
                expect(lastEvent.error.code).toBe('llm.timeout');
            }
        }, 10_000);
    });

    // --- stream(): malformed SSE ---

    describe('stream() — malformed SSE', () => {
        it('yields llm.malformed_response error for invalid JSON in SSE', async () => {
            // Send valid SSE framing but invalid JSON content
            const rawBody = 'data: {not valid json}\n\ndata: [DONE]\n\n';
            server.addResponse({ type: 'raw_stream', rawBody });

            const events = await collectEvents(driver.stream(makeRequest()));

            const errorEvents = events.filter(e => e.type === 'error');
            expect(errorEvents).toHaveLength(1);
            if (errorEvents[0].type === 'error') {
                expect(errorEvents[0].error.code).toBe('llm.malformed_response');
            }
        });
    });

    // --- stream(): stream interruption ---

    describe('stream() — stream interruption', () => {
        it('yields error event when connection is destroyed mid-stream', async () => {
            // Build a partial SSE response that gets cut off
            const partialChunk = JSON.stringify({
                id: 'mock-chunk',
                object: 'chat.completion.chunk',
                model: 'mock-model',
                choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
            });
            const rawBody = `data: ${partialChunk}\n\ndata: ${partialChunk}\n\ndata: [DONE]\n\n`;

            // Cut the connection after sending only part of the response
            server.addResponse({
                type: 'raw_stream',
                rawBody,
                destroyAfterBytes: 20, // Destroy very early
            });

            const events = await collectEvents(driver.stream(makeRequest()));

            // Should get an error event (either from partial data or connection reset)
            const lastEvent = events[events.length - 1];
            expect(lastEvent.type).toBe('error');
            if (lastEvent.type === 'error') {
                expect(lastEvent.error.code).toBe('llm.server_error');
            }
        });
    });

    // --- stream(): slow stream ---

    describe('stream() — slow stream', () => {
        it('receives all chunks in order with delays', async () => {
            server.addTextResponse('ABCDEF', { chunkDelayMs: 50 });

            const events = await collectEvents(driver.stream(makeRequest()));

            const textDeltas = events.filter(e => e.type === 'text_delta');
            const fullText = textDeltas
                .map(e => e.type === 'text_delta' ? e.text : '')
                .join('');
            expect(fullText).toBe('ABCDEF');

            const done = events.find(e => e.type === 'done');
            expect(done).toBeDefined();
        });
    });

    // --- stream(): empty stream ---

    describe('stream() — empty stream', () => {
        it('yields done with no content when server sends DONE immediately', async () => {
            server.addTextResponse('');

            const events = await collectEvents(driver.stream(makeRequest()));

            const textDeltas = events.filter(e => e.type === 'text_delta');
            expect(textDeltas).toHaveLength(0);

            const done = events.find(e => e.type === 'done');
            expect(done).toBeDefined();
            if (done?.type === 'done') {
                expect(done.finishReason).toBe('stop');
            }
        });
    });

    // --- stream(): token usage ---

    describe('stream() — token usage', () => {
        it('captures usage from stream events', async () => {
            server.addTextResponse('Hi', { inputTokens: 42, outputTokens: 7 });

            const events = await collectEvents(driver.stream(makeRequest()));

            const done = events.find(e => e.type === 'done');
            expect(done).toBeDefined();
            if (done?.type === 'done') {
                expect(done.usage.inputTokens).toBe(42);
                expect(done.usage.outputTokens).toBe(7);
            }
        });
    });

    // --- stream(): tools in request ---

    describe('stream() — tools in request body', () => {
        it('emulates ACA tools and disables native NanoGPT tool calling', async () => {
            server.addTextResponse('{"tool_calls":[{"name":"read_file","arguments":{"path":"/tmp/test.txt"}}]}');

            const request = makeRequest({
                tools: [{
                    name: 'read_file',
                    description: 'Read a file from disk',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: 'File path' },
                        },
                        required: ['path'],
                    },
                }],
            });

            const events = await collectEvents(driver.stream(request));

            const body = server.receivedRequests[0].body as Record<string, unknown>;
            expect(body.tools).toBeUndefined();
            expect(body.tool_choice).toBe('none');
            const messages = body.messages as Array<Record<string, unknown>>;
            expect(messages[0].role).toBe('system');
            expect(messages[0].content).toContain('Available tools:');
            expect(messages[0].content).toContain('read_file');

            const toolDeltas = events.filter(e => e.type === 'tool_call_delta');
            expect(toolDeltas).toHaveLength(1);
            if (toolDeltas[0]?.type === 'tool_call_delta') {
                expect(toolDeltas[0].name).toBe('read_file');
                expect(JSON.parse(toolDeltas[0].arguments ?? '{}')).toEqual({ path: '/tmp/test.txt' });
            }
        });
    });
});

// --- M11.2: ModelCatalog integration ---

/**
 * Minimal mock ModelCatalog for testing driver integration.
 */
function makeMockCatalog(entries: Map<string, ModelCatalogEntry>): ModelCatalog {
    return {
        async fetch() {},
        getModel(id: string) { return entries.get(id) ?? null; },
        get isLoaded() { return true; },
    };
}

function makeCatalogEntry(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
    return {
        id: 'qwen/qwen3-coder',
        contextLength: 262_000,
        maxOutputTokens: 65_536,
        capabilities: {
            vision: false,
            toolCalling: true,
            reasoning: false,
            structuredOutput: true,
        },
        ...overrides,
    };
}

describe('M11.2 — Driver + ModelCatalog Integration', () => {
    let server: MockNanoGPTServer;

    beforeEach(async () => {
        server = new MockNanoGPTServer();
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    describe('capabilities() with catalog', () => {
        it('returns catalog limits when model is in catalog', () => {
            const entry = makeCatalogEntry({
                id: 'qwen/qwen3-coder',
                contextLength: 262_000,
                maxOutputTokens: 65_536,
            });
            const catalog = makeMockCatalog(new Map([['qwen/qwen3-coder', entry]]));

            const driver = new NanoGptDriver({
                apiKey: 'test-key',
                baseUrl: server.baseUrl,
                catalog,
            });

            const caps = driver.capabilities('qwen/qwen3-coder');
            expect(caps.maxContext).toBe(262_000);
            expect(caps.maxOutput).toBe(65_536);
        });

        it('preserves static registry behavioral fields when catalog has the model', () => {
            // claude-sonnet-4-20250514 is in models.json with known behavioral fields
            const entry = makeCatalogEntry({
                id: 'claude-sonnet-4-20250514',
                contextLength: 200_000,
                maxOutputTokens: 64_000,
                capabilities: { vision: true, toolCalling: true, reasoning: false, structuredOutput: true },
            });
            const catalog = makeMockCatalog(new Map([['claude-sonnet-4-20250514', entry]]));

            const driver = new NanoGptDriver({
                apiKey: 'test-key',
                baseUrl: server.baseUrl,
                catalog,
            });

            const caps = driver.capabilities('claude-sonnet-4-20250514');
            // Catalog-sourced limits
            expect(caps.maxContext).toBe(200_000);
            expect(caps.maxOutput).toBe(64_000);
            expect(caps.supportsVision).toBe(true);
            // Static-registry behavioral fields preserved
            expect(caps.supportsTools).toBe('native');
            expect(caps.supportsStreaming).toBe(true);
            expect(caps.bytesPerToken).toBe(3.5);
        });

        it('falls back to static registry when model is NOT in catalog', () => {
            const catalog = makeMockCatalog(new Map()); // empty catalog

            const driver = new NanoGptDriver({
                apiKey: 'test-key',
                baseUrl: server.baseUrl,
                catalog,
            });

            // claude-sonnet-4-20250514 is in static registry
            const caps = driver.capabilities('claude-sonnet-4-20250514');
            expect(caps.maxContext).toBe(200_000);
            expect(caps.maxOutput).toBe(16_384);
            expect(caps.supportsTools).toBe('native');
        });

        it('falls back to UNKNOWN_MODEL_DEFAULTS when no catalog and unknown model', () => {
            const driver = new NanoGptDriver({
                apiKey: 'test-key',
                baseUrl: server.baseUrl,
                // no catalog
            });

            const caps = driver.capabilities('nonexistent-model-xyz');
            expect(caps.maxContext).toBe(32_000);
            expect(caps.maxOutput).toBe(8192);
            expect(caps.supportsTools).toBe('native');
        });

        it('merges catalog pricing into costPerMillion when available', () => {
            const entry = makeCatalogEntry({
                id: 'claude-sonnet-4-20250514',
                pricing: { input: 3.0, output: 15.0 },
            });
            const catalog = makeMockCatalog(new Map([['claude-sonnet-4-20250514', entry]]));

            const driver = new NanoGptDriver({
                apiKey: 'test-key',
                baseUrl: server.baseUrl,
                catalog,
            });

            const caps = driver.capabilities('claude-sonnet-4-20250514');
            expect(caps.costPerMillion.input).toBe(3.0);
            expect(caps.costPerMillion.output).toBe(15.0);
        });

        it('uses static registry costPerMillion when catalog has no pricing', () => {
            const entry: ModelCatalogEntry = {
                id: 'claude-sonnet-4-20250514',
                contextLength: 200_000,
                maxOutputTokens: 64_000,
                capabilities: { vision: true, toolCalling: true, reasoning: false, structuredOutput: true },
                // pricing intentionally omitted (undefined)
            };
            const catalog = makeMockCatalog(new Map([['claude-sonnet-4-20250514', entry]]));

            const driver = new NanoGptDriver({
                apiKey: 'test-key',
                baseUrl: server.baseUrl,
                catalog,
            });

            const caps = driver.capabilities('claude-sonnet-4-20250514');
            // Falls back to static registry's costPerMillion
            expect(caps.costPerMillion).toBeDefined();
        });

        it('maps toolCalling=false to supportsTools="none"', () => {
            const entry = makeCatalogEntry({
                id: 'no-tools-model',
                capabilities: { vision: false, toolCalling: false, reasoning: false, structuredOutput: false },
            });
            const catalog = makeMockCatalog(new Map([['no-tools-model', entry]]));

            const driver = new NanoGptDriver({
                apiKey: 'test-key',
                baseUrl: server.baseUrl,
                catalog,
            });

            const caps = driver.capabilities('no-tools-model');
            expect(caps.supportsTools).toBe('none');
        });

        it('preserves emulated tool support from static registry', () => {
            // moonshot-v1-8k has supportsTools='emulated' in models.json
            const entry = makeCatalogEntry({
                id: 'moonshot-v1-8k',
                contextLength: 8_000,
                maxOutputTokens: 4_096,
                capabilities: { vision: false, toolCalling: true, reasoning: false, structuredOutput: false },
            });
            const catalog = makeMockCatalog(new Map([['moonshot-v1-8k', entry]]));

            const driver = new NanoGptDriver({
                apiKey: 'test-key',
                baseUrl: server.baseUrl,
                catalog,
            });

            const caps = driver.capabilities('moonshot-v1-8k');
            expect(caps.supportsTools).toBe('emulated');
        });
    });

    describe('maxOutputTokens in request body', () => {
        it('uses catalog maxOutputTokens instead of request.maxTokens', async () => {
            const entry = makeCatalogEntry({
                id: 'qwen/qwen3-coder',
                maxOutputTokens: 65_536,
            });
            const catalog = makeMockCatalog(new Map([['qwen/qwen3-coder', entry]]));

            const driver = new NanoGptDriver({
                apiKey: 'test-key',
                baseUrl: server.baseUrl,
                catalog,
            });

            server.addTextResponse('OK');
            await collectEvents(driver.stream(makeRequest({
                model: 'qwen/qwen3-coder',
                maxTokens: 4096, // old default — should be overridden
            })));

            const body = server.receivedRequests[0].body as Record<string, unknown>;
            expect(body.max_tokens).toBe(65_536);
        });

        it('falls back to request.maxTokens when model not in catalog', async () => {
            const catalog = makeMockCatalog(new Map()); // empty

            const driver = new NanoGptDriver({
                apiKey: 'test-key',
                baseUrl: server.baseUrl,
                catalog,
            });

            server.addTextResponse('OK');
            await collectEvents(driver.stream(makeRequest({
                model: 'unknown-model',
                maxTokens: 4096,
            })));

            const body = server.receivedRequests[0].body as Record<string, unknown>;
            expect(body.max_tokens).toBe(4096);
        });

        it('falls back to request.maxTokens when no catalog provided', async () => {
            const driver = new NanoGptDriver({
                apiKey: 'test-key',
                baseUrl: server.baseUrl,
                // no catalog
            });

            server.addTextResponse('OK');
            await collectEvents(driver.stream(makeRequest({
                maxTokens: 2048,
            })));

            const body = server.receivedRequests[0].body as Record<string, unknown>;
            expect(body.max_tokens).toBe(2048);
        });
    });
});

// --- M11.5: Witness model catalog limit verification ---

describe('M11.5 — Witness models use catalog ceilings via invoke path', () => {
    let server: MockNanoGPTServer;

    beforeEach(async () => {
        server = new MockNanoGPTServer();
        await server.start();
    });

    afterEach(async () => {
        await server.stop();
    });

    // Witness models and their actual API ceilings (from NanoGPT, 2026-04-05)
    const WITNESS_CEILINGS: Array<{ model: string; maxOutput: number }> = [
        { model: 'minimax/minimax-m2.7', maxOutput: 131_072 },
        { model: 'moonshotai/kimi-k2.5', maxOutput: 65_536 },
        { model: 'qwen/qwen3.5-397b-a17b', maxOutput: 65_536 },
        { model: 'google/gemma-4-31b-it', maxOutput: 131_072 },
    ];

    for (const { model, maxOutput } of WITNESS_CEILINGS) {
        it(`sends catalog ceiling ${maxOutput} for ${model} (not old hardcoded values)`, async () => {
            const entry = makeCatalogEntry({
                id: model,
                maxOutputTokens: maxOutput,
            });
            const catalog = makeMockCatalog(new Map([[model, entry]]));

            const driver = new NanoGptDriver({
                apiKey: 'test-key',
                baseUrl: server.baseUrl,
                catalog,
            });

            server.addTextResponse('witness review output');
            await collectEvents(driver.stream(makeRequest({
                model,
                maxTokens: 4096, // old hardcoded value — must be overridden by catalog
            })));

            const body = server.receivedRequests[0].body as Record<string, unknown>;
            expect(body.max_tokens).toBe(maxOutput);
        });
    }

    it('without catalog, witness model falls back to request.maxTokens', async () => {
        const driver = new NanoGptDriver({
            apiKey: 'test-key',
            baseUrl: server.baseUrl,
            // no catalog — simulates old invoke path
        });

        server.addTextResponse('witness review output');
        await collectEvents(driver.stream(makeRequest({
            model: 'minimax/minimax-m2.7',
            maxTokens: 8192, // old consult_ring.py value
        })));

        const body = server.receivedRequests[0].body as Record<string, unknown>;
        expect(body.max_tokens).toBe(8192); // no catalog → stuck at old limit
    });
});
