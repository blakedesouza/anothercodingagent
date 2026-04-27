/**
 * Tests for TurnEngine model fallback chain (M5.2).
 *
 * Fallback is triggered after retry exhaustion on: llm.rate_limited, llm.server_error, llm.timeout.
 * Fallback is NOT triggered on: llm.content_filtered, llm.auth_error, llm.context_too_long.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { TurnEngine } from '../../src/core/turn-engine.js';
import type { TurnEngineConfig } from '../../src/core/turn-engine.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ConversationWriter } from '../../src/core/conversation-writer.js';
import { SequenceGenerator } from '../../src/types/sequence.js';
import { ProviderRegistry } from '../../src/providers/provider-registry.js';
import type { ProviderDriver, StreamEvent, ModelCapabilities, ProviderConfig } from '../../src/types/provider.js';
import type { SessionId } from '../../src/types/ids.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// --- Helpers ---

function tmpDir(): string {
    const dir = join(tmpdir(), `aca-fallback-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function makeConfig(overrides: Partial<TurnEngineConfig> = {}): TurnEngineConfig {
    return {
        sessionId: 'ses_TEST000000000000000000000' as SessionId,
        model: 'primary-model',
        provider: 'primary',
        interactive: false,
        autoConfirm: false,
        isSubAgent: false,
        workspaceRoot: '/tmp/test',
        ...overrides,
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
    costPerMillion: { input: 3, output: 15 },
    specialFeatures: [],
    bytesPerToken: 3,
};

function makeDriver(responses: StreamEvent[][]): ProviderDriver {
    let callIndex = 0;
    return {
        capabilities: () => BASE_CAPS,
        async *stream(): AsyncIterable<StreamEvent> {
            const evs = responses[callIndex++] ?? [];
            for (const ev of evs) yield ev;
        },
        validate: () => ({ ok: true as const, value: undefined }),
    };
}

function makeProviderConfig(name: string, priority = 1): ProviderConfig {
    return {
        name,
        driver: name,
        baseUrl: 'http://localhost',
        timeout: 5000,
        priority,
    };
}

function textResponse(text: string): StreamEvent[] {
    return [
        { type: 'text_delta', text },
        { type: 'done', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 3 } },
    ];
}

function errorResponse(code: string): StreamEvent[] {
    return [
        { type: 'error', error: { code, message: `Mock error: ${code}` } },
    ];
}

function repeatedErrorResponses(code: string, count: number): StreamEvent[][] {
    return Array.from({ length: count }, () => errorResponse(code));
}

function makeTurnEngine(
    primary: ProviderDriver,
    registry?: ProviderRegistry,
): { engine: TurnEngine; writer: ConversationWriter } {
    const dir = tmpDir();
    const logPath = join(dir, 'conversation.jsonl');
    writeFileSync(logPath, '');
    const writer = new ConversationWriter(logPath);
    const seq = new SequenceGenerator(0);
    const engine = new TurnEngine(
        primary,
        new ToolRegistry(),
        writer,
        seq,
        undefined,
        registry,
    );
    return { engine, writer };
}

// --- Tests ---

afterEach(() => {
    vi.useRealTimers();
});

describe('TurnEngine fallback chain', () => {
    it('tries next model when primary returns llm.rate_limited (429)', async () => {
        vi.useFakeTimers();
        const primaryDriver = makeDriver(repeatedErrorResponses('llm.rate_limited', 5));
        const fallbackDriver = makeDriver([textResponse('fallback response')]);

        const registry = new ProviderRegistry();
        registry.register(fallbackDriver, makeProviderConfig('fallback'));

        // Register fallback model in the driver's capabilities
        // We override capabilities to accept 'fallback-model'
        const fallbackDriverWithModel: ProviderDriver = {
            capabilities: (model: string) => {
                if (model === 'fallback-model') return BASE_CAPS;
                throw new Error(`Unknown model: ${model}`);
            },
            stream: fallbackDriver.stream.bind(fallbackDriver),
            validate: fallbackDriver.validate.bind(fallbackDriver),
        };
        registry.register(fallbackDriverWithModel, makeProviderConfig('fallback-provider'));

        const { engine } = makeTurnEngine(primaryDriver, registry);
        const fallbackEvents: unknown[] = [];
        engine.on('model.fallback', (payload) => fallbackEvents.push(payload));

        const resultPromise = engine.executeTurn(
            makeConfig({
                model: 'primary-model',
                fallbackChain: ['fallback-model'],
            }),
            'hello',
            [],
        );
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        vi.useRealTimers();

        // Fallback was triggered after primary retry exhaustion.
        expect(fallbackEvents).toHaveLength(1);
        expect((fallbackEvents[0] as { reason: string }).reason).toBe('llm.rate_limited');
        // Turn completed successfully using fallback
        expect(result.turn.outcome).toBe('assistant_final');
    });

    it('tries next model when primary returns llm.server_error', async () => {
        vi.useFakeTimers();
        const primaryDriver = makeDriver(repeatedErrorResponses('llm.server_error', 3));
        const fallbackDriverWithModel: ProviderDriver = {
            capabilities: (model: string) => {
                if (model === 'backup-model') return BASE_CAPS;
                throw new Error(`Unknown model: ${model}`);
            },
            async *stream(): AsyncIterable<StreamEvent> {
                yield* textResponse('backup response');
            },
            validate: () => ({ ok: true as const, value: undefined }),
        };

        const registry = new ProviderRegistry();
        registry.register(fallbackDriverWithModel, makeProviderConfig('backup-provider'));

        const { engine } = makeTurnEngine(primaryDriver, registry);
        const fallbackEvents: unknown[] = [];
        engine.on('model.fallback', (payload) => fallbackEvents.push(payload));

        const resultPromise = engine.executeTurn(
            makeConfig({ fallbackChain: ['backup-model'] }),
            'hello',
            [],
        );
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        vi.useRealTimers();

        expect(fallbackEvents).toHaveLength(1);
        expect(result.turn.outcome).toBe('assistant_final');
    });

    it('tries next model when primary returns llm.timeout', async () => {
        const primaryDriver = makeDriver(repeatedErrorResponses('llm.timeout', 2));
        const fallbackDriverWithModel: ProviderDriver = {
            capabilities: (model: string) => {
                if (model === 'fast-model') return BASE_CAPS;
                throw new Error(`Unknown model: ${model}`);
            },
            async *stream(): AsyncIterable<StreamEvent> {
                yield* textResponse('fast response');
            },
            validate: () => ({ ok: true as const, value: undefined }),
        };

        const registry = new ProviderRegistry();
        registry.register(fallbackDriverWithModel, makeProviderConfig('fast-provider'));

        const { engine } = makeTurnEngine(primaryDriver, registry);
        const fallbackEvents: unknown[] = [];
        engine.on('model.fallback', (payload) => fallbackEvents.push(payload));

        const result = await engine.executeTurn(
            makeConfig({ fallbackChain: ['fast-model'] }),
            'hello',
            [],
        );

        expect(fallbackEvents).toHaveLength(1);
        expect(result.turn.outcome).toBe('assistant_final');
    });

    it('does NOT fall back on llm.content_filtered', async () => {
        const primaryDriver = makeDriver([errorResponse('llm.content_filtered')]);
        const fallbackDriverWithModel: ProviderDriver = {
            capabilities: (model: string) => {
                if (model === 'fallback-model') return BASE_CAPS;
                throw new Error(`Unknown model: ${model}`);
            },
            async *stream(): AsyncIterable<StreamEvent> {
                yield* textResponse('fallback response');
            },
            validate: () => ({ ok: true as const, value: undefined }),
        };

        const registry = new ProviderRegistry();
        registry.register(fallbackDriverWithModel, makeProviderConfig('fallback-provider'));

        const { engine } = makeTurnEngine(primaryDriver, registry);
        const fallbackEvents: unknown[] = [];
        engine.on('model.fallback', (payload) => fallbackEvents.push(payload));

        const result = await engine.executeTurn(
            makeConfig({ fallbackChain: ['fallback-model'] }),
            'hello',
            [],
        );

        // No fallback triggered — turn aborted with the content_filtered error
        expect(fallbackEvents).toHaveLength(0);
        expect(result.turn.outcome).toBe('aborted');
    });

    it('does NOT fall back on llm.auth_error', async () => {
        const primaryDriver = makeDriver([errorResponse('llm.auth_error')]);
        const fallbackDriverWithModel: ProviderDriver = {
            capabilities: (model: string) => {
                if (model === 'fallback-model') return BASE_CAPS;
                throw new Error(`Unknown model: ${model}`);
            },
            async *stream(): AsyncIterable<StreamEvent> {
                yield* textResponse('fallback response');
            },
            validate: () => ({ ok: true as const, value: undefined }),
        };

        const registry = new ProviderRegistry();
        registry.register(fallbackDriverWithModel, makeProviderConfig('fallback-provider'));

        const { engine } = makeTurnEngine(primaryDriver, registry);
        const fallbackEvents: unknown[] = [];
        engine.on('model.fallback', (payload) => fallbackEvents.push(payload));

        const result = await engine.executeTurn(
            makeConfig({ fallbackChain: ['fallback-model'] }),
            'hello',
            [],
        );

        expect(fallbackEvents).toHaveLength(0);
        expect(result.turn.outcome).toBe('aborted');
    });

    it('aborts when fallback chain is exhausted', async () => {
        // Primary fails, fallback also fails
        vi.useFakeTimers();
        const primaryDriver = makeDriver(repeatedErrorResponses('llm.rate_limited', 5));
        const fallbackDriverWithModel: ProviderDriver = {
            capabilities: (model: string) => {
                if (model === 'fallback-model') return BASE_CAPS;
                throw new Error(`Unknown model: ${model}`);
            },
            async *stream(): AsyncIterable<StreamEvent> {
                yield { type: 'error', error: { code: 'llm.rate_limited', message: 'also rate limited' } };
            },
            validate: () => ({ ok: true as const, value: undefined }),
        };

        const registry = new ProviderRegistry();
        registry.register(fallbackDriverWithModel, makeProviderConfig('fallback-provider'));

        const { engine } = makeTurnEngine(primaryDriver, registry);

        const resultPromise = engine.executeTurn(
            makeConfig({ fallbackChain: ['fallback-model'] }),
            'hello',
            [],
        );
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        vi.useRealTimers();

        // Chain exhausted — aborted
        expect(result.turn.outcome).toBe('aborted');
    });

    it('emits model.fallback event with correct payload', async () => {
        vi.useFakeTimers();
        const primaryDriver = makeDriver(repeatedErrorResponses('llm.rate_limited', 5));
        const fallbackDriverWithModel: ProviderDriver = {
            capabilities: (model: string) => {
                if (model === 'backup-model') return BASE_CAPS;
                throw new Error(`Unknown model: ${model}`);
            },
            async *stream(): AsyncIterable<StreamEvent> {
                yield* textResponse('backup response');
            },
            validate: () => ({ ok: true as const, value: undefined }),
        };

        const registry = new ProviderRegistry();
        registry.register(fallbackDriverWithModel, makeProviderConfig('backup-provider'));

        const { engine } = makeTurnEngine(primaryDriver, registry);

        const fallbackPayloads: unknown[] = [];
        engine.on('model.fallback', (p) => fallbackPayloads.push(p));

        const resultPromise = engine.executeTurn(
            makeConfig({
                model: 'primary-model',
                provider: 'primary-provider',
                fallbackChain: ['backup-model'],
            }),
            'hello',
            [],
        );
        await vi.runAllTimersAsync();
        await resultPromise;
        vi.useRealTimers();

        expect(fallbackPayloads).toHaveLength(1);
        const payload = fallbackPayloads[0] as {
            from_model: string;
            to_model: string;
            reason: string;
            provider: string;
        };
        expect(payload.from_model).toBe('primary-model');
        expect(payload.to_model).toBe('backup-model');
        expect(payload.reason).toBe('llm.rate_limited');
        expect(payload.provider).toBe('backup-provider');
    });

    it('operates normally without fallback chain (no registry needed)', async () => {
        const primaryDriver = makeDriver([textResponse('success')]);
        const { engine } = makeTurnEngine(primaryDriver);

        const result = await engine.executeTurn(
            makeConfig(),
            'hello',
            [],
        );

        expect(result.turn.outcome).toBe('assistant_final');
    });
});
