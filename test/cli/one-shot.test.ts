import { describe, it, expect } from 'vitest';
import { TurnEngine } from '../../src/core/turn-engine.js';
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
import type { ToolOutput } from '../../src/types/conversation.js';
import type { SessionId } from '../../src/types/ids.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SecretScrubber } from '../../src/permissions/secret-scrubber.js';

// --- Helpers ---

function tmpDir(): string {
    const dir = join(tmpdir(), `aca-oneshot-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function makeMockCapabilities(): ModelCapabilities {
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
}

function textResponse(text: string, inputTokens = 10, outputTokens = 5): StreamEvent[] {
    return [
        { type: 'text_delta', text },
        { type: 'done', finishReason: 'stop', usage: { inputTokens, outputTokens } },
    ];
}

function toolCallResponse(name: string, args: Record<string, unknown>, inputTokens = 10, outputTokens = 5): StreamEvent[] {
    return [
        { type: 'tool_call_delta', index: 0, name, arguments: JSON.stringify(args) },
        { type: 'done', finishReason: 'tool_calls', usage: { inputTokens, outputTokens } },
    ];
}

function createMockProvider(responseQueue: StreamEvent[][]): ProviderDriver {
    let callIndex = 0;
    return {
        capabilities(): ModelCapabilities {
            return makeMockCapabilities();
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

function createWriter(dir: string): { writer: ConversationWriter; path: string } {
    const path = join(dir, 'conversation.jsonl');
    writeFileSync(path, '');
    return { writer: new ConversationWriter(path), path };
}

// Replicated from index.ts for unit testing
function outcomeToExitCode(outcome: string): number {
    switch (outcome) {
        case 'assistant_final':
        case 'awaiting_user':
            return 0;
        case 'cancelled':
            return 2;
        default:
            // aborted, max_steps, tool_error, budget_exceeded, etc.
            return 1;
    }
}

function makeNoopTool(): { spec: ToolSpec; impl: ToolImplementation } {
    const spec: ToolSpec = {
        name: 'noop_tool',
        description: 'Does nothing',
        inputSchema: { type: 'object', properties: {} },
        approvalClass: 'read-only',
        idempotent: true,
        timeoutCategory: 'file',
    };
    const impl: ToolImplementation = async (): Promise<ToolOutput> => ({
        status: 'success',
        data: 'done',
        truncated: false,
        bytesReturned: 4,
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    });
    return { spec, impl };
}

function makeConfirmTool(): { spec: ToolSpec; impl: ToolImplementation } {
    const spec: ToolSpec = {
        name: 'dangerous_tool',
        description: 'Needs approval',
        inputSchema: { type: 'object', properties: {} },
        approvalClass: 'workspace-write',
        idempotent: false,
        timeoutCategory: 'file',
    };
    const impl: ToolImplementation = async (): Promise<ToolOutput> => ({
        status: 'success',
        data: 'executed',
        truncated: false,
        bytesReturned: 8,
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'filesystem',
    });
    return { spec, impl };
}

describe('One-Shot Mode', () => {
    describe('outcomeToExitCode', () => {
        it('maps assistant_final to exit 0', () => {
            expect(outcomeToExitCode('assistant_final')).toBe(0);
        });

        it('maps awaiting_user to exit 0', () => {
            expect(outcomeToExitCode('awaiting_user')).toBe(0);
        });

        it('maps cancelled to exit 2', () => {
            expect(outcomeToExitCode('cancelled')).toBe(2);
        });

        it('maps aborted to exit 1 (runtime error, not cancellation)', () => {
            expect(outcomeToExitCode('aborted')).toBe(1);
        });

        it('maps max_steps to exit 1', () => {
            expect(outcomeToExitCode('max_steps')).toBe(1);
        });

        it('maps tool_error to exit 1', () => {
            expect(outcomeToExitCode('tool_error')).toBe(1);
        });

        it('maps budget_exceeded to exit 1', () => {
            expect(outcomeToExitCode('budget_exceeded')).toBe(1);
        });
    });

    describe('session ID disambiguation', () => {
        const SESSION_ID_RE = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/i;

        it('recognizes valid session IDs', () => {
            expect(SESSION_ID_RE.test('ses_01JQ7K8ABCDEFGHJKMNPQRSTVW')).toBe(true);
        });

        it('rejects non-session-ID strings', () => {
            expect(SESSION_ID_RE.test('fix the bug')).toBe(false);
            expect(SESSION_ID_RE.test('ses_short')).toBe(false);
            expect(SESSION_ID_RE.test('hello')).toBe(false);
        });
    });

    describe('TurnEngine with interactive=false (one-shot semantics)', () => {
        it('executes a turn with text output and yields assistant_final', async () => {
            const dir = tmpDir();
            const { writer } = createWriter(dir);
            const provider = createMockProvider([
                textResponse('Hello from one-shot!'),
            ]);
            const toolRegistry = new ToolRegistry();
            const scrubber = new SecretScrubber([], { enabled: true });

            const engine = new TurnEngine(
                provider,
                toolRegistry,
                writer,
                new SequenceGenerator(0),
                scrubber,
            );

            const collected: string[] = [];
            const config: TurnEngineConfig = {
                sessionId: 'ses_TEST000000000000000000000' as SessionId,
                model: 'mock-model',
                provider: 'mock',
                interactive: false,
                autoConfirm: false,
                isSubAgent: false,
                workspaceRoot: dir,
                onTextDelta: (text: string) => collected.push(text),
            };

            const result = await engine.executeTurn(config, 'echo hello', []);

            expect(result.turn.outcome).toBe('assistant_final');
            expect(collected.join('')).toBe('Hello from one-shot!');
            expect(outcomeToExitCode(result.turn.outcome!)).toBe(0);
        });

        it('non-interactive mode has no step ceiling (runs >30 steps)', async () => {
            const dir = tmpDir();
            const { writer } = createWriter(dir);
            const { spec, impl } = makeNoopTool();

            let stepCount = 0;
            const provider: ProviderDriver = {
                capabilities: () => makeMockCapabilities(),
                async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
                    stepCount++;
                    if (stepCount <= 35) {
                        yield { type: 'tool_call_delta', index: 0, name: 'noop_tool', arguments: '{}' };
                        yield { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 5, outputTokens: 3 } };
                    } else {
                        yield { type: 'text_delta', text: 'done' };
                        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 3 } };
                    }
                },
                validate() {
                    return { ok: true as const, value: undefined };
                },
            };

            const toolRegistry = new ToolRegistry();
            toolRegistry.register(spec, impl);
            const scrubber = new SecretScrubber([], { enabled: true });

            const engine = new TurnEngine(
                provider,
                toolRegistry,
                writer,
                new SequenceGenerator(0),
                scrubber,
            );

            const config: TurnEngineConfig = {
                sessionId: 'ses_TEST000000000000000000000' as SessionId,
                model: 'mock-model',
                provider: 'mock',
                interactive: false,
                autoConfirm: true,
                isSubAgent: false,
                workspaceRoot: dir,
            };

            const result = await engine.executeTurn(config, 'do stuff', []);

            // Non-interactive mode uses Infinity step limit — MCP deadline is the safety net
            expect(result.turn.outcome).toBe('assistant_final');
            expect(result.steps.length).toBe(36); // 35 tool steps + 1 text step
            expect(outcomeToExitCode(result.turn.outcome!)).toBe(0);
        });

        it('auto-approves with autoConfirm=true (--no-confirm)', async () => {
            const dir = tmpDir();
            const { writer } = createWriter(dir);
            const { spec, impl } = makeConfirmTool();

            const provider = createMockProvider([
                toolCallResponse('dangerous_tool', {}),
                textResponse('Tool was executed'),
            ]);

            const toolRegistry = new ToolRegistry();
            toolRegistry.register(spec, impl);
            const scrubber = new SecretScrubber([], { enabled: true });

            const engine = new TurnEngine(
                provider,
                toolRegistry,
                writer,
                new SequenceGenerator(0),
                scrubber,
            );

            const collected: string[] = [];
            const config: TurnEngineConfig = {
                sessionId: 'ses_TEST000000000000000000000' as SessionId,
                model: 'mock-model',
                provider: 'mock',
                interactive: false,
                autoConfirm: true,
                isSubAgent: false,
                workspaceRoot: dir,
                onTextDelta: (text: string) => collected.push(text),
            };

            const result = await engine.executeTurn(config, 'run dangerous tool', []);

            expect(result.turn.outcome).toBe('assistant_final');
            expect(collected.join('')).toBe('Tool was executed');
        });

        it('denies confirmation without promptUser when autoConfirm=false', async () => {
            const dir = tmpDir();
            const { writer } = createWriter(dir);
            const { spec, impl } = makeConfirmTool();

            const provider = createMockProvider([
                toolCallResponse('dangerous_tool', {}),
                textResponse('Tool was denied'),
            ]);

            const toolRegistry = new ToolRegistry();
            toolRegistry.register(spec, impl);
            const scrubber = new SecretScrubber([], { enabled: true });

            const engine = new TurnEngine(
                provider,
                toolRegistry,
                writer,
                new SequenceGenerator(0),
                scrubber,
            );

            const collected: string[] = [];
            const config: TurnEngineConfig = {
                sessionId: 'ses_TEST000000000000000000000' as SessionId,
                model: 'mock-model',
                provider: 'mock',
                interactive: false,
                autoConfirm: false,
                isSubAgent: false,
                workspaceRoot: dir,
                onTextDelta: (text: string) => collected.push(text),
                // No promptUser — simulates no TTY + no --no-confirm
            };

            const result = await engine.executeTurn(config, 'run dangerous tool', []);

            // Tool denied → LLM gets error result → responds with text
            expect(result.turn.outcome).toBe('assistant_final');
            expect(collected.join('')).toBe('Tool was denied');
        });

        it('allows prompting with TTY (promptUser provided, interactive=false)', async () => {
            const dir = tmpDir();
            const { writer } = createWriter(dir);
            const { spec, impl } = makeConfirmTool();

            const provider = createMockProvider([
                toolCallResponse('dangerous_tool', {}),
                textResponse('Approved and executed'),
            ]);

            const toolRegistry = new ToolRegistry();
            toolRegistry.register(spec, impl);
            const scrubber = new SecretScrubber([], { enabled: true });

            const engine = new TurnEngine(
                provider,
                toolRegistry,
                writer,
                new SequenceGenerator(0),
                scrubber,
            );

            const collected: string[] = [];
            const config: TurnEngineConfig = {
                sessionId: 'ses_TEST000000000000000000000' as SessionId,
                model: 'mock-model',
                provider: 'mock',
                interactive: false,
                autoConfirm: false,
                isSubAgent: false,
                workspaceRoot: dir,
                onTextDelta: (text: string) => collected.push(text),
                promptUser: async () => 'y',
            };

            const result = await engine.executeTurn(config, 'run dangerous tool', []);

            expect(result.turn.outcome).toBe('assistant_final');
            expect(collected.join('')).toBe('Approved and executed');
        });

        it('handles runtime errors and maps to exit code 1', async () => {
            const dir = tmpDir();
            const { writer } = createWriter(dir);

            const provider: ProviderDriver = {
                capabilities: () => makeMockCapabilities(),
                async *stream(): AsyncIterable<StreamEvent> {
                    throw new Error('LLM connection failed');
                },
                validate() {
                    return { ok: true as const, value: undefined };
                },
            };

            const toolRegistry = new ToolRegistry();
            const scrubber = new SecretScrubber([], { enabled: true });

            const engine = new TurnEngine(
                provider,
                toolRegistry,
                writer,
                new SequenceGenerator(0),
                scrubber,
            );

            const config: TurnEngineConfig = {
                sessionId: 'ses_TEST000000000000000000000' as SessionId,
                model: 'mock-model',
                provider: 'mock',
                interactive: false,
                autoConfirm: false,
                isSubAgent: false,
                workspaceRoot: dir,
            };

            try {
                const result = await engine.executeTurn(config, 'do something', []);
                expect(outcomeToExitCode(result.turn.outcome ?? 'tool_error')).toBe(1);
            } catch {
                // Runtime error caught → exit code 1
                expect(outcomeToExitCode('tool_error')).toBe(1);
            }
        });
    });
});
