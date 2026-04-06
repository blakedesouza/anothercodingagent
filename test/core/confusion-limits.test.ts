import { describe, it, expect, beforeEach } from 'vitest';
import {
    TurnEngine,
    CONFUSION_CONSECUTIVE_THRESHOLD,
    CONFUSION_SESSION_THRESHOLD,
    CONFUSION_SYSTEM_MESSAGE,
} from '../../src/core/turn-engine.js';
import type { TurnEngineConfig } from '../../src/core/turn-engine.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolSpec, ToolImplementation } from '../../src/tools/tool-registry.js';
import { ConversationWriter } from '../../src/core/conversation-writer.js';
import { SequenceGenerator } from '../../src/types/sequence.js';
import type {
    ProviderDriver,
    StreamEvent,
    ModelRequest,
    ModelCapabilities,
} from '../../src/types/provider.js';
import type { ToolResultItem } from '../../src/types/conversation.js';
import type { SessionId } from '../../src/types/ids.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// --- Helpers ---

function tmpDir(): string {
    const dir = join(tmpdir(), `aca-confusion-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function makeConfig(overrides: Partial<TurnEngineConfig> = {}): TurnEngineConfig {
    return {
        sessionId: 'ses_TEST000000000000000000000' as SessionId,
        model: 'mock-model',
        provider: 'mock',
        interactive: true,
        autoConfirm: false,
        isSubAgent: false,
        workspaceRoot: '/tmp/test',
        ...overrides,
    };
}

function createMockProvider(responseQueue: StreamEvent[][]): ProviderDriver {
    let callIndex = 0;
    return {
        capabilities(): ModelCapabilities {
            return {
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
        },
        async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
            const events = responseQueue[callIndex++];
            if (!events) throw new Error('No more mock responses');
            for (const event of events) yield event;
        },
        validate() {
            return { ok: true as const, value: undefined };
        },
    };
}

/** Mock provider that also captures requests for inspection. */
function createCapturingProvider(responseQueue: StreamEvent[][]): {
    provider: ProviderDriver;
    capturedRequests: ModelRequest[];
} {
    const capturedRequests: ModelRequest[] = [];
    let callIndex = 0;
    const provider: ProviderDriver = {
        capabilities(): ModelCapabilities {
            return {
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
        },
        async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
            capturedRequests.push(structuredClone(request));
            const events = responseQueue[callIndex++];
            if (!events) throw new Error('No more mock responses');
            for (const event of events) yield event;
        },
        validate() {
            return { ok: true as const, value: undefined };
        },
    };
    return { provider, capturedRequests };
}

function textResponse(text: string, inputTokens = 10, outputTokens = 5): StreamEvent[] {
    return [
        { type: 'text_delta', text },
        { type: 'done', finishReason: 'stop', usage: { inputTokens, outputTokens } },
    ];
}

function toolCallResponse(
    calls: Array<{ name: string; args: Record<string, unknown> }>,
    inputTokens = 10,
    outputTokens = 5,
): StreamEvent[] {
    const events: StreamEvent[] = [];
    for (let i = 0; i < calls.length; i++) {
        events.push({
            type: 'tool_call_delta',
            index: i,
            name: calls[i].name,
            arguments: JSON.stringify(calls[i].args),
        });
    }
    events.push({
        type: 'done',
        finishReason: 'tool_calls',
        usage: { inputTokens, outputTokens },
    });
    return events;
}

/** Tool call response with raw (potentially malformed) JSON arguments. */
function rawToolCallResponse(
    name: string,
    rawArgs: string,
    inputTokens = 10,
    outputTokens = 5,
): StreamEvent[] {
    return [
        { type: 'tool_call_delta', index: 0, name, arguments: rawArgs },
        { type: 'done', finishReason: 'tool_calls', usage: { inputTokens, outputTokens } },
    ];
}

function registerEchoTool(registry: ToolRegistry): void {
    const spec: ToolSpec = {
        name: 'echo',
        description: 'Returns input as output',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
        },
        approvalClass: 'read-only',
        idempotent: true,
        timeoutCategory: 'file',
    };
    const impl: ToolImplementation = async (args) => ({
        status: 'success',
        data: String(args.text),
        truncated: false,
        bytesReturned: Buffer.byteLength(String(args.text)),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    });
    registry.register(spec, impl);
}

/** Tool with strict schema for testing validation failures. */
function registerStrictTool(registry: ToolRegistry): void {
    const spec: ToolSpec = {
        name: 'strict_tool',
        description: 'Tool with strict param validation',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string' },
                mode: { type: 'string', enum: ['read', 'write'] },
            },
            required: ['text'],
        },
        approvalClass: 'read-only',
        idempotent: true,
        timeoutCategory: 'file',
    };
    const impl: ToolImplementation = async (args) => ({
        status: 'success',
        data: String(args.text),
        truncated: false,
        bytesReturned: Buffer.byteLength(String(args.text)),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    });
    registry.register(spec, impl);
}

/** Tool that always returns a non-retryable policy error (NOT in CONFUSION_ERROR_CODES).
 * Uses tool.permission rather than tool.execution because M10.1c widened the
 * confusion set to include execution/timeout/crash codes — a permission denial
 * is still outside the confusion counter's tracking. */
function registerExecutionFailTool(registry: ToolRegistry): void {
    const spec: ToolSpec = {
        name: 'exec_fail',
        description: 'Always fails with a non-confusion policy error',
        inputSchema: { type: 'object', properties: {} },
        approvalClass: 'read-only',
        idempotent: false,
        timeoutCategory: 'file',
    };
    const impl: ToolImplementation = async () => ({
        status: 'error',
        data: '',
        error: { code: 'tool.permission', message: 'Policy denied', retryable: false },
        truncated: false,
        bytesReturned: 0,
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    });
    registry.register(spec, impl);
}

function createEngine(
    provider: ProviderDriver,
    registry: ToolRegistry,
    dir: string,
): { engine: TurnEngine; logPath: string } {
    const logPath = join(dir, 'conversation.jsonl');
    writeFileSync(logPath, '');
    const writer = new ConversationWriter(logPath);
    const seq = new SequenceGenerator(0);
    const engine = new TurnEngine(provider, registry, writer, seq);
    return { engine, logPath };
}

function getToolResults(items: unknown[]): ToolResultItem[] {
    return items.filter(
        (i): i is ToolResultItem =>
            typeof i === 'object' && i !== null && (i as Record<string, unknown>).kind === 'tool_result',
    );
}

// --- Tests ---

describe('Confusion Limits', () => {
    let registry: ToolRegistry;
    let dir: string;

    beforeEach(() => {
        registry = new ToolRegistry();
        dir = tmpDir();
    });

    // --- Per-turn consecutive counter ---

    it('1 bad tool call → synthetic error result, model gets another step (no yield)', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'nonexistent', args: {} }]),
            textResponse('Recovered'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Test', []);

        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = getToolResults(result.items);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.error?.code).toBe('tool.not_found');
    });

    it('2 consecutive bad tool calls → same behavior, model still gets another step', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'bad1', args: {} }]),
            toolCallResponse([{ name: 'bad2', args: {} }]),
            textResponse('Recovered after 2'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Test', []);

        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = getToolResults(result.items);
        expect(toolResults).toHaveLength(2);
        expect(toolResults[0].output.error?.code).toBe('tool.not_found');
        expect(toolResults[1].output.error?.code).toBe('tool.not_found');
    });

    it('3 consecutive bad tool calls → turn yields with tool_error and llm.confused', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'bad1', args: {} }]),
            toolCallResponse([{ name: 'bad2', args: {} }]),
            toolCallResponse([{ name: 'bad3', args: {} }]),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Test', []);

        expect(result.turn.outcome).toBe('tool_error');
        const toolResults = getToolResults(result.items);
        expect(toolResults).toHaveLength(3);
        // First two keep original error codes
        expect(toolResults[0].output.error?.code).toBe('tool.not_found');
        expect(toolResults[1].output.error?.code).toBe('tool.not_found');
        // Third is overridden to llm.confused
        expect(toolResults[2].output.error?.code).toBe('llm.confused');
    });

    it('counter resets on successful tool call: bad→bad→success→bad → counter is 1, model continues', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'bad1', args: {} }]),       // count=1
            toolCallResponse([{ name: 'bad2', args: {} }]),       // count=2
            toolCallResponse([{ name: 'echo', args: { text: 'ok' } }]),  // count=0
            toolCallResponse([{ name: 'bad3', args: {} }]),       // count=1
            textResponse('Recovered'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Test', []);

        expect(result.turn.outcome).toBe('assistant_final');
    });

    it('exactly 2 consecutive → does NOT yield; exactly 3 → yields (boundary)', async () => {
        // 2 consecutive: should NOT yield
        const provider2 = createMockProvider([
            toolCallResponse([{ name: 'bad1', args: {} }]),
            toolCallResponse([{ name: 'bad2', args: {} }]),
            textResponse('OK'),
        ]);
        registerEchoTool(registry);
        const { engine: e2 } = createEngine(provider2, registry, dir);
        const r2 = await e2.executeTurn(makeConfig(), 'Test', []);
        expect(r2.turn.outcome).toBe('assistant_final');

        // 3 consecutive: SHOULD yield
        const dir3 = tmpDir();
        const registry3 = new ToolRegistry();
        registerEchoTool(registry3);
        const provider3 = createMockProvider([
            toolCallResponse([{ name: 'bad1', args: {} }]),
            toolCallResponse([{ name: 'bad2', args: {} }]),
            toolCallResponse([{ name: 'bad3', args: {} }]),
        ]);
        const { engine: e3 } = createEngine(provider3, registry3, dir3);
        const r3 = await e3.executeTurn(makeConfig(), 'Test', []);
        expect(r3.turn.outcome).toBe('tool_error');
    });

    // --- Per-session cumulative counter ---

    it('9 cumulative confusion events → no system message injected', async () => {
        const { provider, capturedRequests } = createCapturingProvider([
            toolCallResponse([{ name: 'bad', args: {} }]),
            textResponse('OK'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        // Pre-set count to 8, this turn adds 1 → total 9
        (engine as any).sessionConfusionCount = 8;

        await engine.executeTurn(makeConfig(), 'Test', []);

        expect(engine.getSessionConfusionCount()).toBe(9);
        // Second LLM call (text response step) should NOT have confusion message
        const lastRequest = capturedRequests[capturedRequests.length - 1];
        const systemMessages = lastRequest.messages.filter(m => m.role === 'system');
        const hasConfusionMsg = systemMessages.some(
            m => typeof m.content === 'string' && m.content.includes('Tool call accuracy'),
        );
        expect(hasConfusionMsg).toBe(false);
    });

    it('10th cumulative confusion event → persistent system message injected', async () => {
        const { provider, capturedRequests } = createCapturingProvider([
            toolCallResponse([{ name: 'bad', args: {} }]),
            textResponse('OK'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        // Pre-set count to 9, this turn adds 1 → total 10
        (engine as any).sessionConfusionCount = 9;

        await engine.executeTurn(makeConfig(), 'Test', []);

        expect(engine.getSessionConfusionCount()).toBe(10);
        // Second LLM call should have the confusion system message
        const lastRequest = capturedRequests[capturedRequests.length - 1];
        const systemMessages = lastRequest.messages.filter(m => m.role === 'system');
        const hasConfusionMsg = systemMessages.some(
            m => typeof m.content === 'string' && m.content === CONFUSION_SYSTEM_MESSAGE,
        );
        expect(hasConfusionMsg).toBe(true);
    });

    it('cumulative confusion count does NOT reset between turns', async () => {
        const responses = [
            // Turn 1: bad → bad → good → text (2 confusion events)
            toolCallResponse([{ name: 'bad1', args: {} }]),
            toolCallResponse([{ name: 'bad2', args: {} }]),
            toolCallResponse([{ name: 'echo', args: { text: 'ok' } }]),
            textResponse('Turn 1 done'),
            // Turn 2: bad → text (1 more, total 3)
            toolCallResponse([{ name: 'bad3', args: {} }]),
            textResponse('Turn 2 done'),
        ];
        const provider = createMockProvider(responses);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        await engine.executeTurn(makeConfig(), 'Turn 1', []);
        expect(engine.getSessionConfusionCount()).toBe(2);

        await engine.executeTurn(makeConfig(), 'Turn 2', []);
        expect(engine.getSessionConfusionCount()).toBe(3);
    });

    // --- What counts as confusion ---

    it('JSON parse failure counts as confusion', async () => {
        const provider = createMockProvider([
            rawToolCallResponse('echo', '{invalid json!!!'),
            textResponse('Recovered'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Test', []);

        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = getToolResults(result.items);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.error?.code).toBe('tool.validation');
        expect(engine.getSessionConfusionCount()).toBe(1);
    });

    it('missing required param counts as confusion (tool.validation from ToolRunner)', async () => {
        const provider = createMockProvider([
            // strict_tool requires 'text' param — pass empty args
            toolCallResponse([{ name: 'strict_tool', args: {} }]),
            textResponse('Recovered'),
        ]);
        registerStrictTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Test', []);

        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = getToolResults(result.items);
        expect(toolResults[0].output.error?.code).toBe('tool.validation');
        expect(engine.getSessionConfusionCount()).toBe(1);
    });

    it('type mismatch counts as confusion', async () => {
        const provider = createMockProvider([
            // text should be string, pass number
            toolCallResponse([{ name: 'strict_tool', args: { text: 42 } }]),
            textResponse('Recovered'),
        ]);
        registerStrictTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Test', []);

        expect(result.turn.outcome).toBe('assistant_final');
        expect(engine.getSessionConfusionCount()).toBe(1);
    });

    it('enum violation counts as confusion', async () => {
        const provider = createMockProvider([
            // mode must be 'read' or 'write', pass 'invalid'
            toolCallResponse([{ name: 'strict_tool', args: { text: 'hi', mode: 'invalid' } }]),
            textResponse('Recovered'),
        ]);
        registerStrictTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Test', []);

        expect(result.turn.outcome).toBe('assistant_final');
        expect(engine.getSessionConfusionCount()).toBe(1);
    });

    // --- What does NOT count as confusion ---

    it('tool execution failure does NOT count as confusion', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'exec_fail', args: {} }]),
            // Per M10.1c, tool errors are fed back — model gets another step and gives up.
            textResponse('Unable to proceed.'),
        ]);
        registerExecutionFailTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Test', []);

        // The turn no longer terminates on non-confusion tool errors (M10.1c).
        // The key assertion for this test is that the confusion counter stays at 0.
        expect(result.turn.outcome).toBe('assistant_final');
        expect(engine.getSessionConfusionCount()).toBe(0);
    });

    it('non-confusion error in batch breaks the consecutive confusion chain', async () => {
        // Single batch with 5 calls: [bad, exec_fail, bad, bad, bad]
        // exec_fail is a non-confusion error that resets the consecutive counter.
        // Counter: bad(1) → exec_fail(0) → bad(1) → bad(2) → bad(3) → threshold at index 4
        // Without the reset fix, counter would be: bad(1) → exec_fail(1) → bad(2) → bad(3) → threshold at index 3
        const provider = createMockProvider([
            toolCallResponse([
                { name: 'bad1', args: {} },      // confusion, count=1
                { name: 'exec_fail', args: {} }, // non-confusion error, count→0
                { name: 'bad2', args: {} },      // confusion, count=1
                { name: 'bad3', args: {} },      // confusion, count=2
                { name: 'bad4', args: {} },      // confusion, count=3 → threshold
            ]),
        ]);
        registerEchoTool(registry);
        registerExecutionFailTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Test', []);

        expect(result.turn.outcome).toBe('tool_error');
        const toolResults = getToolResults(result.items);
        expect(toolResults).toHaveLength(5);
        // llm.confused on the 5th call (index 4) — NOT the 4th,
        // because exec_fail broke the chain
        expect(toolResults[4].output.error?.code).toBe('llm.confused');
        expect(toolResults[3].output.error?.code).toBe('tool.not_found');
        // All 4 confusion events counted (no early break)
        expect(engine.getSessionConfusionCount()).toBe(4);
    });

    // --- Constants exported correctly ---

    it('exported constants match spec values', () => {
        expect(CONFUSION_CONSECUTIVE_THRESHOLD).toBe(3);
        expect(CONFUSION_SESSION_THRESHOLD).toBe(10);
        expect(CONFUSION_SYSTEM_MESSAGE).toContain('Tool call accuracy');
    });
});
