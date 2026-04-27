import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversationWriter } from '../../src/core/conversation-writer.js';
import { TurnEngine } from '../../src/core/turn-engine.js';
import type { ModelCatalog, ModelCatalogEntry } from '../../src/providers/model-catalog.js';
import { NanoGptDriver } from '../../src/providers/nanogpt-driver.js';
import { ToolRegistry, type ToolImplementation, type ToolSpec } from '../../src/tools/tool-registry.js';
import type { SessionId } from '../../src/types/ids.js';
import type { SequenceGenerator } from '../../src/types/sequence.js';
import { SequenceGenerator as SequenceGeneratorImpl } from '../../src/types/sequence.js';
import type { ModelCapabilities, ModelRequest, ProviderDriver, StreamEvent } from '../../src/types/provider.js';
import { MockNanoGPTServer } from '../helpers/mock-nanogpt-server.js';

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
    return {
        model: 'native/model',
        messages: [{ role: 'user', content: 'use a tool' }],
        maxTokens: 1024,
        temperature: 0.1,
        tools: [{
            name: 'echo',
            description: 'Echo text.',
            parameters: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
                additionalProperties: false,
            },
        }],
        ...overrides,
    };
}

function catalog(toolCalling: boolean): ModelCatalog {
    const entry: ModelCatalogEntry = {
        id: toolCalling ? 'native/model' : 'emulated/model',
        contextLength: 128_000,
        maxOutputTokens: 4096,
        capabilities: {
            toolCalling,
            structuredOutput: true,
            vision: false,
            reasoning: false,
        },
    };
    return {
        async fetch() {
            // Static test catalog; no remote discovery needed.
        },
        getModel(model: string) {
            return model === entry.id ? entry : null;
        },
        get isLoaded() {
            return true;
        },
    };
}

const BASE_CAPS: ModelCapabilities = {
    maxContext: 128_000,
    maxOutput: 4096,
    supportsTools: 'native',
    supportsVision: false,
    supportsStreaming: true,
    supportsPrefill: false,
    supportsEmbedding: false,
    embeddingModels: [],
    toolReliability: 'native',
    costPerMillion: { input: 0, output: 0 },
    specialFeatures: [],
    bytesPerToken: 3,
};

function mockProvider(events: StreamEvent[][]): ProviderDriver {
    let callIndex = 0;
    return {
        capabilities: () => BASE_CAPS,
        async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
            const next = events[callIndex++] ?? [];
            for (const event of next) yield event;
        },
        validate: () => ({ ok: true, value: undefined }),
    };
}

function echoTool(): { spec: ToolSpec; impl: ToolImplementation } {
    const spec: ToolSpec = {
        name: 'echo',
        description: 'Echo text.',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
        },
        approvalClass: 'read-only',
        idempotent: true,
        timeoutCategory: 'file',
    };
    const impl: ToolImplementation = async args => ({
        status: 'success',
        data: String(args.text),
        truncated: false,
        bytesReturned: Buffer.byteLength(String(args.text)),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    });
    return { spec, impl };
}

function makeEngine(provider: ProviderDriver, registry: ToolRegistry, dir: string): TurnEngine {
    const logPath = join(dir, 'conversation.jsonl');
    writeFileSync(logPath, '');
    const sequence: SequenceGenerator = new SequenceGeneratorImpl(0);
    return new TurnEngine(provider, registry, new ConversationWriter(logPath), sequence);
}

describe('NanoGPT tool request shape', () => {
    it('sends native tools when catalog advertises tool calling', async () => {
        const server = new MockNanoGPTServer();
        await server.start();
        try {
            server.addToolCallResponse([{ id: 'call_1', name: 'echo', arguments: { text: 'hi' } }]);
            const driver = new NanoGptDriver({
                apiKey: 'test',
                baseUrl: server.baseUrl,
                catalog: catalog(true),
            });

            const events = await collect(driver.stream(request({ model: 'native/model' })));

            const body = server.receivedRequests[0].body as Record<string, unknown>;
            expect(body.tools).toBeDefined();
            expect(body.tool_choice).toBe('auto');
            expect(body.parallel_tool_calls).toBe(true);
            expect(events.some(event => event.type === 'tool_call_delta')).toBe(true);
        } finally {
            await server.stop();
        }
    });

    it('strips native tools and injects schema when catalog requires emulation', async () => {
        const server = new MockNanoGPTServer();
        await server.start();
        try {
            server.addTextResponse('{"tool_calls":[{"name":"echo","arguments":{"text":"hi"}}]}');
            const driver = new NanoGptDriver({
                apiKey: 'test',
                baseUrl: server.baseUrl,
                catalog: catalog(false),
            });

            const events = await collect(driver.stream(request({
                model: 'emulated/model',
                responseFormat: { type: 'json_object' },
            })));

            const body = server.receivedRequests[0].body as Record<string, unknown>;
            const messages = body.messages as Array<Record<string, unknown>>;
            expect(body.tools).toBeUndefined();
            expect(body.tool_choice).toBe('none');
            expect(body.response_format).toBeUndefined();
            expect(String(messages[0].content)).toContain('Available tools:');
            expect(String(messages[0].content)).toContain('echo');
            expect(events.some(event => event.type === 'tool_call_delta')).toBe(true);
        } finally {
            await server.stop();
        }
    });

    it('serializes prior native assistant tool calls as content null plus tool_calls', async () => {
        const server = new MockNanoGPTServer();
        await server.start();
        try {
            server.addTextResponse('done');
            const driver = new NanoGptDriver({
                apiKey: 'test',
                baseUrl: server.baseUrl,
                catalog: catalog(true),
            });

            await collect(driver.stream(request({
                model: 'native/model',
                messages: [
                    { role: 'user', content: 'echo hi' },
                    {
                        role: 'assistant',
                        content: [{
                            type: 'tool_call',
                            toolCallId: 'call_prev',
                            toolName: 'echo',
                            arguments: { text: 'hi' },
                        }],
                    },
                    { role: 'tool', toolCallId: 'call_prev', content: '{"status":"success","data":"hi"}' },
                ],
            })));

            const body = server.receivedRequests[0].body as { messages: Array<Record<string, unknown>> };
            expect(body.messages[1].content).toBeNull();
            expect(body.messages[1].tool_calls).toBeDefined();
            expect(body.messages[2].tool_call_id).toBe('call_prev');
        } finally {
            await server.stop();
        }
    });
});

describe('TurnEngine tool stream normalization', () => {
    it('keeps duplicate native index calls separate when ids differ', async () => {
        const registry = new ToolRegistry();
        const { spec, impl } = echoTool();
        registry.register(spec, impl);
        const dir = mkdtempSync(join(tmpdir(), `aca-tool-contract-${randomUUID()}`));
        const provider = mockProvider([
            [
                { type: 'tool_call_delta', index: 0, id: 'call_a', name: 'echo', arguments: '{"text":"one"}' },
                { type: 'tool_call_delta', index: 0, id: 'call_b', name: 'echo', arguments: '{"text":"two"}' },
                { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 5, outputTokens: 5 } },
            ],
            [
                { type: 'text_delta', text: 'done' },
                { type: 'done', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 1 } },
            ],
        ]);
        const engine = makeEngine(provider, registry, dir);

        const result = await engine.executeTurn({
            sessionId: 'ses_TEST000000000000000000000' as SessionId,
            model: 'mock-model',
            provider: 'mock',
            interactive: false,
            autoConfirm: true,
            isSubAgent: true,
            workspaceRoot: dir,
        }, 'echo twice', []);

        const toolResults = result.items.filter(item => item.kind === 'tool_result');
        expect(toolResults).toHaveLength(2);
        expect(toolResults.map(item => item.kind === 'tool_result' ? item.output.data : '')).toEqual(['one', 'two']);
    });

    it('feeds malformed native argument JSON back as tool.validation', async () => {
        const registry = new ToolRegistry();
        const { spec, impl } = echoTool();
        registry.register(spec, impl);
        const dir = mkdtempSync(join(tmpdir(), `aca-tool-contract-${randomUUID()}`));
        const provider = mockProvider([
            [
                { type: 'tool_call_delta', index: 0, id: 'call_bad', name: 'echo', arguments: '{"text":' },
                { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 5, outputTokens: 5 } },
            ],
            [
                { type: 'text_delta', text: 'recovered' },
                { type: 'done', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 1 } },
            ],
        ]);
        const engine = makeEngine(provider, registry, dir);

        const result = await engine.executeTurn({
            sessionId: 'ses_TEST000000000000000000000' as SessionId,
            model: 'mock-model',
            provider: 'mock',
            interactive: false,
            autoConfirm: true,
            isSubAgent: true,
            workspaceRoot: dir,
        }, 'bad args', []);

        const validationResult = result.items.find(item =>
            item.kind === 'tool_result'
            && item.output.status === 'error'
            && item.output.error?.code === 'tool.validation'
        );
        expect(validationResult).toBeDefined();
    });
});
