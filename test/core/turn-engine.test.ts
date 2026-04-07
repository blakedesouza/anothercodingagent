import { describe, it, expect, beforeEach } from 'vitest';
import { TurnEngine, Phase } from '../../src/core/turn-engine.js';
import type { TurnEngineConfig } from '../../src/core/turn-engine.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolSpec, ToolImplementation } from '../../src/tools/tool-registry.js';
import { ConversationWriter } from '../../src/core/conversation-writer.js';
import { SequenceGenerator } from '../../src/types/sequence.js';
import type { ProviderDriver, StreamEvent, ModelRequest, ModelCapabilities } from '../../src/types/provider.js';
import type { MessageItem, ToolResultItem } from '../../src/types/conversation.js';
import type { SessionId } from '../../src/types/ids.js';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// --- Helpers ---

function tmpDir(): string {
    const dir = join(tmpdir(), `aca-test-${randomUUID()}`);
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

/** Create a mock provider that yields predetermined stream events for each call. */
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
            for (const event of events) {
                yield event;
            }
        },
        validate() {
            return { ok: true as const, value: undefined };
        },
    };
}

/** Helper to create a simple text-only stream response. */
function textResponse(text: string, inputTokens = 10, outputTokens = 5): StreamEvent[] {
    return [
        { type: 'text_delta', text },
        { type: 'done', finishReason: 'stop', usage: { inputTokens, outputTokens } },
    ];
}

/** Helper to create a stream response with tool calls. */
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

/** Register a simple echo tool. */
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

/** Register a tool that returns a non-retryable error. */
function registerFailingTool(registry: ToolRegistry): void {
    const spec: ToolSpec = {
        name: 'failing_tool',
        description: 'Always fails',
        inputSchema: { type: 'object', properties: {} },
        approvalClass: 'read-only',
        idempotent: false,
        timeoutCategory: 'file',
    };
    const impl: ToolImplementation = async () => ({
        status: 'error',
        data: '',
        error: { code: 'tool.test_failure', message: 'Intentional failure', retryable: false },
        truncated: false,
        bytesReturned: 0,
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    });
    registry.register(spec, impl);
}

/** Register a tool that returns indeterminate mutation state. */
function registerIndeterminateTool(registry: ToolRegistry): void {
    const spec: ToolSpec = {
        name: 'indeterminate_tool',
        description: 'Returns indeterminate mutation',
        inputSchema: { type: 'object', properties: {} },
        approvalClass: 'workspace-write',
        idempotent: false,
        timeoutCategory: 'file',
    };
    const impl: ToolImplementation = async () => ({
        status: 'success',
        data: 'partial write',
        truncated: false,
        bytesReturned: 13,
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'indeterminate',
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

/** Type guard for MessageItem results. */
function isMessage(item: unknown): item is MessageItem {
    return typeof item === 'object' && item !== null && (item as Record<string, unknown>).kind === 'message';
}

/** Type guard for ToolResultItem results. */
function isToolResult(item: unknown): item is ToolResultItem {
    return typeof item === 'object' && item !== null && (item as Record<string, unknown>).kind === 'tool_result';
}

/** Typed JSONL record as stored on disk. */
interface JsonlRecord {
    recordType: string;
    role?: string;
    output?: { data: string; status: string; error?: { code: string } };
    [key: string]: unknown;
}

function readJsonlLines(filePath: string): JsonlRecord[] {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line) as JsonlRecord);
}

// --- Tests ---

describe('TurnEngine', () => {
    let registry: ToolRegistry;
    let dir: string;

    beforeEach(() => {
        registry = new ToolRegistry();
        dir = tmpDir();
    });

    // Test 1: Text-only response
    it('text-only response → yields with assistant_final, single step recorded', async () => {
        const provider = createMockProvider([
            textResponse('Hello, world!'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Hi', []);

        expect(result.turn.outcome).toBe('assistant_final');
        expect(result.steps).toHaveLength(1);
        expect(result.items).toHaveLength(2); // user message + assistant message
        const msg0 = result.items[0];
        const msg1 = result.items[1];
        expect(isMessage(msg0) && msg0.role).toBe('user');
        expect(isMessage(msg1) && msg1.role).toBe('assistant');
    });

    // Test 2: Single tool call
    it('single tool call → tool executes → LLM returns text → yields with assistant_final, two steps', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'echo', args: { text: 'ping' } }]),
            textResponse('Tool returned: ping'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Echo ping', []);

        expect(result.turn.outcome).toBe('assistant_final');
        expect(result.steps).toHaveLength(2);
        expect(result.items.length).toBeGreaterThanOrEqual(4);
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].toolName).toBe('echo');
        expect(toolResults[0].output.data).toBe('ping');
    });

    // Test 3: Multi-tool response
    it('multi-tool response → all executed sequentially → results appended → next LLM call', async () => {
        const provider = createMockProvider([
            toolCallResponse([
                { name: 'echo', args: { text: 'one' } },
                { name: 'echo', args: { text: 'two' } },
                { name: 'echo', args: { text: 'three' } },
            ]),
            textResponse('Got all three results'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Echo three things', []);

        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(3);
        expect(toolResults[0].output.data).toBe('one');
        expect(toolResults[1].output.data).toBe('two');
        expect(toolResults[2].output.data).toBe('three');
    });

    // Test 4: Non-interactive mode has no step ceiling (MCP deadline is the safety net)
    it('non-interactive mode → no step limit → runs all tool calls until text response', async () => {
        const responses: StreamEvent[][] = [];
        // 35 tool calls followed by a text-only response
        for (let i = 0; i < 35; i++) {
            responses.push(toolCallResponse([{ name: 'echo', args: { text: `step${i}` } }]));
        }
        responses.push(textResponse('Done after 35 tool steps'));
        const provider = createMockProvider(responses);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ interactive: false, isSubAgent: true }),
            'Loop many times',
            [],
        );

        expect(result.turn.outcome).toBe('assistant_final');
        expect(result.steps.length).toBe(36); // 35 tool steps + 1 text step
    });

    it('configured maxSteps caps non-interactive tool loops', async () => {
        const responses: StreamEvent[][] = [];
        for (let i = 0; i < 10; i++) {
            responses.push(toolCallResponse([{ name: 'echo', args: { text: `step${i}` } }]));
        }
        const provider = createMockProvider(responses);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ interactive: false, isSubAgent: true, maxSteps: 3 }),
            'Loop with configured cap',
            [],
        );

        expect(result.turn.outcome).toBe('max_steps');
        expect(result.steps).toHaveLength(3);
        expect(result.items.filter(isToolResult)).toHaveLength(2);
    });

    it('configured maxToolCalls allows one tool call then a no-tools final step', async () => {
        let secondRequest: ModelRequest | null = null;
        let callIndex = 0;
        const provider: ProviderDriver = {
            capabilities: () => ({
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
            }),
            async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
                callIndex++;
                if (callIndex === 1) {
                    yield* toolCallResponse([{ name: 'echo', args: { text: 'once' } }]);
                    return;
                }
                secondRequest = request;
                yield* textResponse('Final after one tool');
            },
            validate: () => ({ ok: true as const, value: undefined }),
        };
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ interactive: false, isSubAgent: true, maxToolCalls: 1 }),
            'Use one tool then summarize',
            [],
        );

        expect(result.turn.outcome).toBe('assistant_final');
        expect(result.steps).toHaveLength(2);
        expect(result.items.filter(isToolResult)).toHaveLength(1);
        expect(secondRequest).not.toBeNull();
        expect(secondRequest!.tools).toBeUndefined();
    });

    it('configured maxToolCalls stops when the model exceeds the cap', async () => {
        const provider = createMockProvider([
            toolCallResponse([
                { name: 'echo', args: { text: 'accepted' } },
                { name: 'echo', args: { text: 'rejected' } },
            ]),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ interactive: false, isSubAgent: true, maxToolCalls: 1 }),
            'Try two tools',
            [],
        );

        expect(result.turn.outcome).toBe('max_tool_calls');
        expect(result.steps).toHaveLength(1);
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(2);
        expect(toolResults[0].output.status).toBe('success');
        expect(toolResults[0].output.data).toBe('accepted');
        expect(toolResults[1].output.status).toBe('error');
        expect(toolResults[1].output.error?.code).toBe('tool.max_tool_calls');
    });

    it('authority deny rules reject matching tool calls without failing open', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'echo', args: { text: 'blocked' } }]),
            textResponse('Saw the denial'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({
                interactive: false,
                isSubAgent: true,
                authority: [{
                    tool: 'echo',
                    args_match: { text: 'blocked' },
                    decision: 'deny',
                }],
            }),
            'Try denied echo',
            [],
        );

        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.status).toBe('error');
        expect(toolResults[0].output.error?.code).toBe('tool.permission');
        expect(toolResults[0].output.error?.message).toContain('authority deny');
    });

    it('configured maxToolCallsByName rejects excess calls for a specific tool', async () => {
        const provider = createMockProvider([
            toolCallResponse([
                { name: 'echo', args: { text: 'accepted' } },
                { name: 'echo', args: { text: 'rejected' } },
            ]),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({
                interactive: false,
                isSubAgent: true,
                maxToolCalls: 10,
                maxToolCallsByName: { echo: 1 },
            }),
            'Try two echo calls',
            [],
        );

        expect(result.turn.outcome).toBe('max_tool_calls');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(2);
        expect(toolResults[0].output.status).toBe('success');
        expect(toolResults[1].output.status).toBe('error');
        expect(toolResults[1].output.error?.message).toContain('max_tool_calls_by_name.echo');
        expect(result.steps[0].safetyStats?.acceptedToolCallsByName).toEqual({ echo: 1 });
    });

    it('configured maxToolResultBytes truncates stored tool output before the next LLM step', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'echo', args: { text: 'abcdef' } }]),
            textResponse('Final after truncated result'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ interactive: false, isSubAgent: true, maxToolResultBytes: 3 }),
            'Echo too much data',
            [],
        );

        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.data).toBe('abc');
        expect(toolResults[0].output.truncated).toBe(true);
        expect(result.steps[0].safetyStats?.guardrail).toBe('max_tool_result_bytes');
        expect(result.steps[0].safetyStats?.cumulativeToolResultBytes).toBe(3);
    });

    it('configured maxToolResultBytes truncates without exceeding the byte budget on multibyte characters', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'echo', args: { text: 'éé' } }]),
            textResponse('Final after truncated result'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ interactive: false, isSubAgent: true, maxToolResultBytes: 3 }),
            'Echo multibyte data',
            [],
        );

        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.data).toBe('é');
        expect(toolResults[0].output.bytesReturned).toBe(2);
        expect(toolResults[0].output.bytesOmitted).toBe(2);
        expect(Buffer.byteLength(toolResults[0].output.data, 'utf8')).toBeLessThanOrEqual(3);
        expect(result.steps[0].safetyStats?.cumulativeToolResultBytes).toBe(2);
    });

    it('configured maxInputTokens stops before making an oversized LLM request', async () => {
        const provider = createMockProvider([]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ interactive: false, isSubAgent: true, maxInputTokens: 1 }),
            'This request is too large for the configured input guard',
            [],
        );

        expect(result.turn.outcome).toBe('budget_exceeded');
        expect(result.steps).toHaveLength(1);
        expect(result.steps[0].finishReason).toBe('input_guard');
        expect(result.steps[0].safetyStats?.guardrail).toBe('max_input_tokens');
    });

    it('configured maxRepeatedReadCalls rejects overlapping read_file calls', async () => {
        const provider = createMockProvider([
            toolCallResponse([
                { name: 'read_file', args: { path: 'src/index.ts', line_start: 1, line_end: 10 } },
                { name: 'read_file', args: { path: 'src/index.ts', line_start: 5, line_end: 12 } },
            ]),
        ]);
        const spec: ToolSpec = {
            name: 'read_file',
            description: 'Read a file',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    line_start: { type: 'number' },
                    line_end: { type: 'number' },
                },
                required: ['path'],
            },
            approvalClass: 'read-only',
            idempotent: true,
            timeoutCategory: 'file',
        };
        const impl: ToolImplementation = async () => ({
            status: 'success',
            data: 'file chunk',
            truncated: false,
            bytesReturned: 10,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        });
        registry.register(spec, impl);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({
                interactive: false,
                isSubAgent: true,
                maxRepeatedReadCalls: 1,
            }),
            'Try overlapping reads',
            [],
        );

        expect(result.turn.outcome).toBe('max_tool_calls');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(2);
        expect(toolResults[0].output.status).toBe('success');
        expect(toolResults[1].output.status).toBe('error');
        expect(toolResults[1].output.error?.message).toContain('max_repeated_read_calls');
    });

    it('configured maxTotalTokens caps cumulative turn token usage', async () => {
        const provider = createMockProvider([
            textResponse('This response is over the delegated token budget', 11, 5),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ interactive: false, isSubAgent: true, maxTotalTokens: 15 }),
            'Use too many tokens',
            [],
        );

        expect(result.turn.outcome).toBe('budget_exceeded');
        expect(result.steps).toHaveLength(1);
    });

    // Test 5: Consecutive tool limit (10 in interactive)
    it('consecutive tool limit → yields with max_consecutive_tools at step 10', async () => {
        const responses: StreamEvent[][] = [];
        for (let i = 0; i < 15; i++) {
            responses.push(toolCallResponse([{ name: 'echo', args: { text: `step${i}` } }]));
        }
        const provider = createMockProvider(responses);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig({ interactive: true }), 'Loop with tools', []);

        expect(result.turn.outcome).toBe('max_consecutive_tools');
        expect(result.steps.length).toBeLessThanOrEqual(10);
    });

    // Test 6: Max tool calls per message (10 active, rest deferred)
    it('max tool calls per message → first 10 executed, remaining 2 get synthetic deferred error', async () => {
        const calls = Array.from({ length: 12 }, (_, i) => ({
            name: 'echo',
            args: { text: `call${i}` },
        }));
        const provider = createMockProvider([
            toolCallResponse(calls),
            textResponse('Done'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), '12 calls', []);

        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(12);

        // First 10 should be successful
        for (let i = 0; i < 10; i++) {
            expect(toolResults[i].output.status).toBe('success');
            expect(toolResults[i].output.data).toBe(`call${i}`);
        }

        // Last 2 should be deferred errors
        for (let i = 10; i < 12; i++) {
            expect(toolResults[i].output.status).toBe('error');
            expect(toolResults[i].output.error?.code).toBe('tool.deferred');
        }
    });

    // Test 7: Validation failure → synthetic error result
    it('validation failure → LLM returns unknown tool → synthetic error ToolResultItem, model gets another step', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'nonexistent_tool', args: {} }]),
            textResponse('I see the tool failed'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Call unknown tool', []);

        const toolResults = result.items.filter(isToolResult);
        expect(toolResults.length).toBeGreaterThanOrEqual(1);
        expect(toolResults[0].output.status).toBe('error');
        expect(toolResults[0].output.error?.code).toBe('tool.not_found');
    });

    // Test 8: Non-retryable tool errors are NOT fatal (M10.1c).
    // The error is fed back to the model on the next step; only mutationState
    // 'indeterminate' terminates the turn.
    it('non-retryable tool error is fed back to model (M10.1c — formerly yielded tool_error)', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'failing_tool', args: {} }]),
            // After seeing the error, model produces a final text response
            textResponse('The tool failed; giving up.'),
        ]);
        registerEchoTool(registry);
        registerFailingTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Call failing tool', []);

        // Before M10.1c: outcome was 'tool_error'. After: turn continues normally.
        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.error?.code).toBe('tool.test_failure');
    });

    // Test 9: Indeterminate mutation → yields with tool_error
    it('indeterminate mutation → yields with tool_error (unsafe to continue)', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'indeterminate_tool', args: {} }]),
        ]);
        registerEchoTool(registry);
        registerIndeterminateTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Call indeterminate tool', []);

        expect(result.turn.outcome).toBe('tool_error');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.mutationState).toBe('indeterminate');
    });

    // Test 10: Phase transitions → verify each phase emits correct event
    it('phase transitions → emits events for each phase in correct order', async () => {
        const provider = createMockProvider([
            textResponse('Simple response'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const phases: Phase[] = [];
        engine.on('phase', (phase: Phase) => phases.push(phase));

        await engine.executeTurn(makeConfig(), 'Hello', []);

        // For a text-only response, phases should be:
        // OpenTurn → AppendUserMessage → AssembleContext → CreateStep → CallLLM →
        // NormalizeResponse → AppendAssistantMessage → CheckYieldConditions
        expect(phases).toEqual([
            Phase.OpenTurn,
            Phase.AppendUserMessage,
            Phase.AssembleContext,
            Phase.CreateStep,
            Phase.CallLLM,
            Phase.NormalizeResponse,
            Phase.AppendAssistantMessage,
            Phase.CheckYieldConditions,
        ]);
    });

    // Test 11: Turn record → completed turn has correct outcome, step count, item range
    it('turn record → has correct outcome, step count, item range', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'echo', args: { text: 'hello' } }]),
            textResponse('Done'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Test turn record', []);

        expect(result.turn.status).toBe('completed');
        expect(result.turn.outcome).toBe('assistant_final');
        expect(result.turn.steps).toHaveLength(2);
        expect(result.turn.itemSeqStart).toBe(1);
        expect(result.turn.itemSeqEnd).toBeGreaterThan(result.turn.itemSeqStart);
        expect(result.turn.startedAt).toBeTruthy();
        expect(result.turn.completedAt).toBeTruthy();
    });

    // Test 12: Conversation log → after turn, all items are in the JSONL
    it('conversation log → all items written to JSONL (user, assistant, tool results)', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'echo', args: { text: 'logged' } }]),
            textResponse('Logged response'),
        ]);
        registerEchoTool(registry);
        const { engine, logPath } = createEngine(provider, registry, dir);

        await engine.executeTurn(makeConfig(), 'Test logging', []);

        const records = readJsonlLines(logPath);
        expect(records.length).toBeGreaterThanOrEqual(6);

        const recordTypes = records.map(r => r.recordType);
        expect(recordTypes).toContain('turn');
        expect(recordTypes).toContain('message');
        expect(recordTypes).toContain('tool_result');
        expect(recordTypes).toContain('step');

        // Verify user message is present
        const messages = records.filter(r => r.recordType === 'message');
        const userMsg = messages.find(m => m.role === 'user');
        expect(userMsg).toBeTruthy();

        // Verify tool result is present
        const toolResults = records.filter(r => r.recordType === 'tool_result');
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output?.data).toBe('logged');
    });

    // Test 14: Indeterminate mutation in autoConfirm mode → continues (no tool_error)
    it('indeterminate mutation + autoConfirm + success → continues without tool_error', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'indeterminate_tool', args: {} }]),
            textResponse('Done after exec'),
        ]);
        registerEchoTool(registry);
        registerIndeterminateTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ autoConfirm: true }),
            'Call indeterminate tool',
            [],
        );

        // Should continue to the next LLM call and finish with assistant_final
        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.mutationState).toBe('indeterminate');
        expect(toolResults[0].output.status).toBe('success');
    });

    // Test 15: Indeterminate mutation + autoConfirm + error → still yields tool_error
    it('indeterminate mutation + autoConfirm + error → still yields tool_error', async () => {
        // Register a tool that errors with indeterminate mutation state
        const errorIndeterminateSpec: ToolSpec = {
            name: 'error_indeterminate',
            description: 'Errors with indeterminate mutation',
            inputSchema: { type: 'object', properties: {} },
            approvalClass: 'external-effect',
            idempotent: false,
            timeoutCategory: 'file',
        };
        const errorIndeterminateImpl: ToolImplementation = async () => ({
            status: 'error',
            data: '',
            error: { code: 'tool.exec_failed', message: 'Command crashed', retryable: false },
            truncated: false,
            bytesReturned: 0,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'indeterminate',
        });
        registry.register(errorIndeterminateSpec, errorIndeterminateImpl);

        const provider = createMockProvider([
            toolCallResponse([{ name: 'error_indeterminate', args: {} }]),
        ]);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ autoConfirm: true }),
            'Call error indeterminate tool',
            [],
        );

        // Error with indeterminate mutation should still stop, even in autoConfirm
        expect(result.turn.outcome).toBe('tool_error');
    });

    // Test 16: allowedTools constraint denies tools not in the list
    it('allowedTools constraint denies tools not in allowed list', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'echo', args: { text: 'test' } }]),
            textResponse('Denied'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ allowedTools: ['other_tool'] }),
            'Try echo tool',
            [],
        );

        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.status).toBe('error');
        expect(toolResults[0].output.error?.code).toBe('tool.permission');
        expect(toolResults[0].output.error?.message).toContain('allowed_tools');
    });

    // Test 17: allowedTools constraint allows tools in the list
    it('allowedTools constraint allows tools in the list', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'echo', args: { text: 'hello' } }]),
            textResponse('Echo succeeded'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ allowedTools: ['echo'] }),
            'Call echo',
            [],
        );

        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.status).toBe('success');
        expect(toolResults[0].output.data).toBe('hello');
    });

    // Test 18: allowedTools null = all tools allowed
    it('allowedTools null = all tools allowed', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'echo', args: { text: 'allowed' } }]),
            textResponse('All allowed'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ allowedTools: null }),
            'Call echo',
            [],
        );

        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.status).toBe('success');
    });

    // Test 19: allowedTools empty array = deny all tools
    it('allowedTools empty array denies all tools', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'echo', args: { text: 'blocked' } }]),
            textResponse('All denied'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ allowedTools: [] }),
            'Try any tool',
            [],
        );

        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.status).toBe('error');
        expect(toolResults[0].output.error?.code).toBe('tool.permission');
    });

    // --- M10.1c: non-fatal error handling + tool filtering ---

    // Test 20: tool.permission error is non-fatal → loop continues, model sees the error
    it('tool.permission error is non-fatal → turn continues so model can course-correct', async () => {
        const provider = createMockProvider([
            // Step 1: model calls a tool it isn't allowed to use → denied by allowedTools
            toolCallResponse([{ name: 'echo', args: { text: 'blocked' } }]),
            // Step 2: after seeing the error, model responds with text
            textResponse('Understood, I cannot use echo.'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(
            makeConfig({ allowedTools: ['other_tool'] }),
            'Call echo',
            [],
        );

        // Before M10.1c: turn would have ended with outcome 'tool_error'.
        // After M10.1c: tool.permission is fed back to the model and the loop continues.
        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.error?.code).toBe('tool.permission');
        // Assistant produced a follow-up message after seeing the error
        const assistantMsgs = result.items.filter(isMessage).filter(m => m.role === 'assistant');
        expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    });

    // Test 21: mixed batch (success + validation error) → turn continues
    it('mixed batch: success + validation error → turn continues, both results visible', async () => {
        // Register a tool that will have one call succeed and another fail validation
        const provider = createMockProvider([
            toolCallResponse([
                { name: 'echo', args: { text: 'good' } },
                // second call passes wrong type — triggers validation failure
                { name: 'echo', args: { text: 12345 } },
            ]),
            textResponse('Done processing both.'),
        ]);
        registerEchoTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Call echo twice', []);

        // After M10.1c: validation errors are non-fatal; loop continues.
        expect(result.turn.outcome).toBe('assistant_final');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(2);
        // One success, one validation error
        const statuses = toolResults.map(r => r.output.status).sort();
        expect(statuses).toEqual(['error', 'success']);
        const errorResult = toolResults.find(r => r.output.status === 'error');
        expect(errorResult?.output.error?.code).toBe('tool.validation');
    });

    // Test 22: indeterminate mutation still terminates even after M10.1c changes
    it('indeterminate mutation still terminates turn (safety preserved)', async () => {
        const provider = createMockProvider([
            toolCallResponse([{ name: 'indeterminate_tool', args: {} }]),
        ]);
        registerEchoTool(registry);
        registerIndeterminateTool(registry);
        const { engine } = createEngine(provider, registry, dir);

        // autoConfirm=false here, so indeterminate mutation always kills the turn
        const result = await engine.executeTurn(makeConfig(), 'Run risky tool', []);

        expect(result.turn.outcome).toBe('tool_error');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.mutationState).toBe('indeterminate');
    });

    // Test 23: allowedTools filters API request tool list
    it('allowedTools filters API request — model only sees permitted tools', async () => {
        // Capture the request that was sent to the provider
        let capturedRequest: ModelRequest | null = null;
        const capturingProvider: ProviderDriver = {
            capabilities: () => ({
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
            }),
            async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
                capturedRequest = request;
                // Respond with text so the turn ends without calling any tools
                yield { type: 'text_delta', text: 'OK' };
                yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
            },
            validate: () => ({ ok: true as const, value: undefined }),
        };

        // Register echo and a second tool; only allow echo
        registerEchoTool(registry);
        registerFailingTool(registry);
        const { engine } = createEngine(capturingProvider, registry, dir);

        await engine.executeTurn(
            makeConfig({ allowedTools: ['echo'] }),
            'Say hi',
            [],
        );

        expect(capturedRequest).not.toBeNull();
        expect(capturedRequest!.tools).toBeDefined();
        // Only echo should appear in the tools array — failing_tool must be filtered out.
        const toolNames = capturedRequest!.tools!.map(t => t.name).sort();
        expect(toolNames).toEqual(['echo']);
    });

    // Test 24: allowedTools null → all registered tools presented to model
    it('allowedTools null → all registered tools appear in API request', async () => {
        let capturedRequest: ModelRequest | null = null;
        const capturingProvider: ProviderDriver = {
            capabilities: () => ({
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
            }),
            async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
                capturedRequest = request;
                yield { type: 'text_delta', text: 'OK' };
                yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
            },
            validate: () => ({ ok: true as const, value: undefined }),
        };

        registerEchoTool(registry);
        registerFailingTool(registry);
        const { engine } = createEngine(capturingProvider, registry, dir);

        await engine.executeTurn(
            makeConfig({ allowedTools: null }),
            'Say hi',
            [],
        );

        expect(capturedRequest).not.toBeNull();
        const toolNames = capturedRequest!.tools!.map(t => t.name).sort();
        expect(toolNames).toContain('echo');
        expect(toolNames).toContain('failing_tool');
    });

    // --- M10.1c consult-round consensus fixes ---

    // Test C1: Widened confusion counter catches runaway tool.execution loops.
    // Before: confusion set was {not_found, validation}; tool.execution didn't count.
    // After: execution/timeout/crash count → 3 consecutive fires llm.confused.
    it('widened confusion set — 3 consecutive tool.permission-not errors fire llm.confused', async () => {
        // Use a tool that returns tool.execution directly. After the widening,
        // 3 in a row should replace the 3rd with llm.confused and yield tool_error.
        const execFailSpec: ToolSpec = {
            name: 'exec_fail_test',
            description: 'Always fails with tool.execution',
            inputSchema: { type: 'object', properties: {} },
            approvalClass: 'read-only',
            idempotent: false,
            timeoutCategory: 'file',
        };
        const execFailImpl: ToolImplementation = async () => ({
            status: 'error',
            data: '',
            error: { code: 'tool.execution', message: 'exec failed', retryable: false },
            truncated: false,
            bytesReturned: 0,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        });
        registry.register(execFailSpec, execFailImpl);

        const provider = createMockProvider([
            toolCallResponse([
                { name: 'exec_fail_test', args: {} },
                { name: 'exec_fail_test', args: {} },
                { name: 'exec_fail_test', args: {} }, // 3rd consecutive → llm.confused
            ]),
        ]);
        const { engine } = createEngine(provider, registry, dir);

        const result = await engine.executeTurn(makeConfig(), 'Try failing tool', []);

        expect(result.turn.outcome).toBe('tool_error');
        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(3);
        expect(toolResults[2].output.error?.code).toBe('llm.confused');
    });

    // Test C2: Masked-tool alternatives respect allowedTools filter.
    // A tool that's masked (capability unavailable) should not suggest
    // alternatives the agent isn't allowed to use either.
    it('masked-tool alternatives are filtered by allowedTools', async () => {
        // Register two tools: one for the masked error message, another only
        // allowed by allowedTools. Force the first to be masked manually via
        // a capability health map stub.
        const { CapabilityHealthMap } = await import('../../src/core/capability-health.js');
        const healthMap = new CapabilityHealthMap();
        // Mark the lsp capability session-terminal unavailable so the masking fires
        healthMap.reportNonRetryableFailure('lsp', 'probe failed');

        // Tool A: masked (capability 'lsp'), not in allowedTools
        const lspSpec: ToolSpec = {
            name: 'lsp_tool',
            description: 'LSP-backed tool',
            inputSchema: { type: 'object', properties: {} },
            approvalClass: 'read-only',
            idempotent: true,
            timeoutCategory: 'file',
            capabilityId: 'lsp',
        };
        const noopLspImpl: ToolImplementation = async () => ({
            status: 'success',
            data: '',
            truncated: false,
            bytesReturned: 0,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        });
        registry.register(lspSpec, noopLspImpl);

        // Tool B: allowed + not masked
        const allowedSpec: ToolSpec = {
            name: 'allowed_tool',
            description: 'An allowed tool',
            inputSchema: { type: 'object', properties: {} },
            approvalClass: 'read-only',
            idempotent: true,
            timeoutCategory: 'file',
        };
        registry.register(allowedSpec, noopLspImpl);

        // Tool C: NOT allowed + not masked — must NOT appear in alternatives
        const leakSpec: ToolSpec = {
            name: 'leaked_tool',
            description: 'Would leak if alternatives not filtered',
            inputSchema: { type: 'object', properties: {} },
            approvalClass: 'read-only',
            idempotent: true,
            timeoutCategory: 'file',
        };
        registry.register(leakSpec, noopLspImpl);

        const provider = createMockProvider([
            toolCallResponse([{ name: 'lsp_tool', args: {} }]),
            textResponse('I cannot use lsp_tool.'),
        ]);

        const logPath = join(dir, 'conversation.jsonl');
        writeFileSync(logPath, '');
        const writer = new ConversationWriter(logPath);
        const seq = new SequenceGenerator(0);
        const engine = new TurnEngine(
            provider, registry, writer, seq,
            undefined, undefined, undefined, undefined,
            healthMap,
        );

        const result = await engine.executeTurn(
            makeConfig({ allowedTools: ['lsp_tool', 'allowed_tool'] }),
            'Call LSP',
            [],
        );

        const toolResults = result.items.filter(isToolResult);
        expect(toolResults).toHaveLength(1);
        const errorMsg = toolResults[0].output.error?.message ?? '';
        // 'allowed_tool' IS allowed → may appear. 'leaked_tool' is NOT allowed → must not appear.
        expect(errorMsg).not.toContain('leaked_tool');
    });

    // Test 25: allowedTools empty array → tools field is omitted from API request
    it('allowedTools empty array → API request has no tools presented', async () => {
        let capturedRequest: ModelRequest | null = null;
        const capturingProvider: ProviderDriver = {
            capabilities: () => ({
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
            }),
            async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
                capturedRequest = request;
                yield { type: 'text_delta', text: 'I cannot call any tools.' };
                yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
            },
            validate: () => ({ ok: true as const, value: undefined }),
        };

        registerEchoTool(registry);
        const { engine } = createEngine(capturingProvider, registry, dir);

        await engine.executeTurn(
            makeConfig({ allowedTools: [] }),
            'Do anything',
            [],
        );

        expect(capturedRequest).not.toBeNull();
        // When the filtered list is empty, the request.tools field should be omitted
        // (or undefined). TurnEngine does `tools: toolDefs.length > 0 ? toolDefs : undefined`.
        expect(capturedRequest!.tools).toBeUndefined();
    });

    // ---------------------------------------------------------------------
    // tool_call_delta accumulation
    //
    // The accumulator in TurnEngine.normalizeStreamEvents() must handle:
    //   1. Standard OpenAI streaming: id sent on first chunk only, args
    //      streamed across multiple chunks at the same index.
    //   2. Standard parallel: distinct indices per parallel tool call.
    //   3. Gemma-style index collision: parallel tool calls all sharing
    //      `index: 0` but with distinct ids. Observed on the NanoGPT
    //      gemma-4-31b-it short-id backend in production. Pre-fix, the
    //      accumulator keyed on `index`, merging all calls into one entry,
    //      concatenating their JSON arg blobs into invalid JSON, and
    //      tripping the JSON.parse failure path → "Malformed JSON in tool
    //      call arguments" → llm.confused after 3 strikes → tool_error.
    // ---------------------------------------------------------------------
    describe('tool_call_delta accumulation', () => {
        it('standard OpenAI streaming: id on first chunk, args chunked across later deltas', async () => {
            // Simulates: chunk 1 has {id, name, ""}, chunk 2 has {arguments: '{"text":'},
            // chunk 3 has {arguments: '"hi"}'}. All chunks share index=0.
            const provider = createMockProvider([
                [
                    { type: 'tool_call_delta', index: 0, id: 'call_abc', name: 'echo', arguments: '' },
                    { type: 'tool_call_delta', index: 0, arguments: '{"text":' },
                    { type: 'tool_call_delta', index: 0, arguments: '"hi"}' },
                    { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 } },
                ],
                textResponse('done'),
            ]);
            registerEchoTool(registry);
            const { engine } = createEngine(provider, registry, dir);

            const result = await engine.executeTurn(makeConfig(), 'echo hi', []);

            const toolResults = result.items.filter(isToolResult);
            expect(toolResults).toHaveLength(1);
            expect(toolResults[0].toolName).toBe('echo');
            expect(toolResults[0].output.data).toBe('hi');
            expect(toolResults[0].output.status).toBe('success');
        });

        it('standard parallel: distinct indices, each chunk also has its own id', async () => {
            const provider = createMockProvider([
                [
                    { type: 'tool_call_delta', index: 0, id: 'call_a', name: 'echo', arguments: '{"text":"one"}' },
                    { type: 'tool_call_delta', index: 1, id: 'call_b', name: 'echo', arguments: '{"text":"two"}' },
                    { type: 'tool_call_delta', index: 2, id: 'call_c', name: 'echo', arguments: '{"text":"three"}' },
                    { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 } },
                ],
                textResponse('done'),
            ]);
            registerEchoTool(registry);
            const { engine } = createEngine(provider, registry, dir);

            const result = await engine.executeTurn(makeConfig(), 'echo three', []);

            const toolResults = result.items.filter(isToolResult);
            expect(toolResults).toHaveLength(3);
            expect(toolResults.map(t => t.output.data)).toEqual(['one', 'two', 'three']);
            expect(toolResults.every(t => t.output.status === 'success')).toBe(true);
        });

        it('legacy parallel: distinct indices, no ids on any chunk (pre-fix backward compat)', async () => {
            const provider = createMockProvider([
                [
                    { type: 'tool_call_delta', index: 0, name: 'echo', arguments: '{"text":"alpha"}' },
                    { type: 'tool_call_delta', index: 1, name: 'echo', arguments: '{"text":"beta"}' },
                    { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 } },
                ],
                textResponse('done'),
            ]);
            registerEchoTool(registry);
            const { engine } = createEngine(provider, registry, dir);

            const result = await engine.executeTurn(makeConfig(), 'echo two', []);

            const toolResults = result.items.filter(isToolResult);
            expect(toolResults).toHaveLength(2);
            expect(toolResults.map(t => t.output.data)).toEqual(['alpha', 'beta']);
        });

        it('gemma collision: parallel tool calls with all index=0 but distinct ids → reconstructed as N separate tool calls', async () => {
            // This is the exact failure pattern from
            // /tmp/aca-gemma-fail-sse-2.txt — gemma's short-id NanoGPT
            // backend emits 4 parallel tool calls in one SSE stream, all
            // at index 0, each with a distinct id and complete arguments.
            // Pre-fix: ACA merged them into one entry, last name wins
            // (exec_command), 4 JSON arg blobs concatenated → JSON.parse
            // throws → tool.validation: "Malformed JSON in tool call
            // arguments" → llm.confused → tool_error.
            // Post-fix: collision detected via id mismatch at the same
            // index, each delta gets its own slot, 4 distinct tool calls
            // executed cleanly.
            const provider = createMockProvider([
                [
                    { type: 'tool_call_delta', index: 0, id: 'call_bao4exy4', name: 'echo', arguments: '{"text":"first"}' },
                    { type: 'tool_call_delta', index: 0, id: 'call_bffx74vu', name: 'echo', arguments: '{"text":"second"}' },
                    { type: 'tool_call_delta', index: 0, id: 'call_chezyjpy', name: 'echo', arguments: '{"text":"third"}' },
                    { type: 'tool_call_delta', index: 0, id: 'call_3o0n7un8', name: 'echo', arguments: '{"text":"fourth"}' },
                    { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 } },
                ],
                textResponse('done'),
            ]);
            registerEchoTool(registry);
            const { engine } = createEngine(provider, registry, dir);

            const result = await engine.executeTurn(makeConfig(), 'gemma collision', []);

            // The fix should produce 4 separate tool results, one per delta.
            const toolResults = result.items.filter(isToolResult);
            expect(toolResults).toHaveLength(4);
            expect(toolResults.map(t => t.output.data)).toEqual(['first', 'second', 'third', 'fourth']);
            expect(toolResults.every(t => t.output.status === 'success')).toBe(true);

            // Critical: NONE of the tool results should be the malformed-args
            // error that the pre-fix accumulator produced.
            expect(
                toolResults.some(t => t.output.error?.code === 'tool.validation'),
            ).toBe(false);
        });

        it('gemma collision with mixed tool names: last-name-wins is gone, each call keeps its own name', async () => {
            // The pre-fix bug also caused name corruption: the merged entry
            // ended with whatever the LAST delta's name was. Verify post-fix
            // each tool call keeps its own name.
            const provider = createMockProvider([
                [
                    { type: 'tool_call_delta', index: 0, id: 'call_x1', name: 'echo', arguments: '{"text":"keep_echo"}' },
                    { type: 'tool_call_delta', index: 0, id: 'call_x2', name: 'failing_tool', arguments: '{}' },
                    { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 } },
                ],
                textResponse('done'),
            ]);
            registerEchoTool(registry);
            registerFailingTool(registry);
            const { engine } = createEngine(provider, registry, dir);

            const result = await engine.executeTurn(makeConfig(), 'mixed collision', []);

            const toolResults = result.items.filter(isToolResult);
            expect(toolResults).toHaveLength(2);
            expect(toolResults[0].toolName).toBe('echo');
            expect(toolResults[0].output.status).toBe('success');
            expect(toolResults[0].output.data).toBe('keep_echo');
            expect(toolResults[1].toolName).toBe('failing_tool');
            // failing_tool is non-retryable but does NOT have indeterminate
            // mutation state, so the turn continues per M10.1c semantics.
            expect(toolResults[1].output.status).toBe('error');
        });
    });
});
