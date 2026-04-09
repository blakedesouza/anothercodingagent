import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RegisteredTool } from '../../src/tools/tool-registry.js';
import {
    finalizeInvokeTurnState,
    prepareInvokeTurnConfig,
} from '../../src/cli/invoke-runtime-state.js';
import { SessionManager } from '../../src/core/session-manager.js';
import type {
    ConversationItem,
    MessageItem,
    ToolResultItem,
} from '../../src/types/conversation.js';
import type { ItemId, SessionId } from '../../src/types/ids.js';
import type {
    ModelCapabilities,
    ModelRequest,
    ProviderDriver,
    StreamEvent,
    RequestMessage,
} from '../../src/types/provider.js';

function tmpDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

function makeCapabilities(maxContext = 1800, maxOutput = 256): ModelCapabilities {
    return {
        maxContext,
        maxOutput,
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
}

function createSummaryProvider(): ProviderDriver {
    return {
        capabilities: () => makeCapabilities(),
        async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
            yield {
                type: 'text_delta',
                text: JSON.stringify({
                    summaryText: 'Compressed summary of earlier turns',
                    pinnedFacts: ['fact-a'],
                    durableStatePatch: {
                        goal: 'Document the compressed work',
                        confirmedFactsAdd: ['fact-a'],
                    },
                }),
            };
            yield {
                type: 'done',
                finishReason: 'stop',
                usage: { inputTokens: 20, outputTokens: 20 },
            };
        },
        validate: () => ({ ok: true as const, value: undefined }),
    };
}

function createNoopProvider(): ProviderDriver {
    return {
        capabilities: () => makeCapabilities(32_000, 4096),
        async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
            yield { type: 'text_delta', text: 'ok' };
            yield {
                type: 'done',
                finishReason: 'stop',
                usage: { inputTokens: 10, outputTokens: 5 },
            };
        },
        validate: () => ({ ok: true as const, value: undefined }),
    };
}

function makeUserMessage(text: string, seq: number): MessageItem {
    return {
        kind: 'message',
        id: `item_u_${seq}` as ItemId,
        seq,
        role: 'user',
        parts: [{ type: 'text', text }],
        timestamp: new Date().toISOString(),
    };
}

function makeAssistantMessage(text: string, seq: number): MessageItem {
    return {
        kind: 'message',
        id: `item_a_${seq}` as ItemId,
        seq,
        role: 'assistant',
        parts: [{ type: 'text', text }],
        timestamp: new Date().toISOString(),
    };
}

function makeHistory(turnCount: number, payload: string): ConversationItem[] {
    const items: ConversationItem[] = [];
    let seq = 1;
    for (let i = 0; i < turnCount; i++) {
        items.push(makeUserMessage(`Question ${i} ${payload}`, seq++));
        items.push(makeAssistantMessage(`Answer ${i} ${payload}`, seq++));
    }
    return items;
}

function makeWriteTurnItems(): ConversationItem[] {
    const assistant: MessageItem = {
        kind: 'message',
        id: 'item_assistant_write' as ItemId,
        seq: 1,
        role: 'assistant',
        parts: [
            {
                type: 'tool_call',
                toolCallId: 'call_write_1',
                toolName: 'write_file',
                arguments: {
                    path: 'src/out.ts',
                    content: 'export const value = 1;\n',
                },
            },
        ],
        timestamp: new Date().toISOString(),
    };
    const result: ToolResultItem = {
        kind: 'tool_result',
        id: 'item_tool_write' as ItemId,
        seq: 2,
        toolCallId: 'call_write_1',
        toolName: 'write_file',
        output: {
            status: 'success',
            data: 'Wrote src/out.ts',
            truncated: false,
            bytesReturned: 16,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'filesystem',
        },
        timestamp: new Date().toISOString(),
    };
    return [assistant, result];
}

function baseTurnConfig(sessionId: SessionId, workspaceRoot: string) {
    return {
        sessionId,
        model: 'mock-model',
        provider: 'mock',
        interactive: false,
        autoConfirm: true,
        isSubAgent: true,
        workspaceRoot,
    };
}

describe('invoke runtime state', () => {
    it('prepares invoke turns with pre-turn summaries and refreshed runtime context', async () => {
        const workspaceRoot = tmpDir('aca-invoke-state-ws-');
        const sessionsDir = tmpDir('aca-invoke-state-sessions-');
        try {
            writeFileSync(join(workspaceRoot, 'package.json'), '{"name":"test"}\n');
            const sessionManager = new SessionManager(sessionsDir);
            const projection = sessionManager.create(workspaceRoot, { mode: 'executor' });
            const historyItems = makeHistory(9, 'x'.repeat(180));
            const systemMessages: RequestMessage[] = [{ role: 'system', content: 'base invoke prompt' }];

            const config = await prepareInvokeTurnConfig({
                conversationItems: historyItems,
                task: 'Next task',
                projection,
                provider: createSummaryProvider(),
                model: 'mock-model',
                tools: [] as RegisteredTool[],
                workspaceRoot,
                shell: 'bash',
                baseConfig: baseTurnConfig(projection.manifest.sessionId, workspaceRoot),
                baseSystemMessages: systemMessages,
                includeRuntimeContextMessage: true,
            });

            expect(historyItems.some((item) => item.kind === 'summary')).toBe(true);
            expect(config.durableTaskState?.goal).toBe('Document the compressed work');
            expect(config.systemMessages).toHaveLength(2);
            expect(String(config.systemMessages?.[1].content)).toContain('CWD:');
            expect(String(config.systemMessages?.[1].content)).toContain('Goal: Document the compressed work');
        } finally {
            rmSync(workspaceRoot, { recursive: true, force: true });
            rmSync(sessionsDir, { recursive: true, force: true });
        }
    });

    it('persists invoke turn state so later turns see updated working-set context', async () => {
        const workspaceRoot = tmpDir('aca-invoke-state-ws-');
        const sessionsDir = tmpDir('aca-invoke-state-sessions-');
        try {
            writeFileSync(join(workspaceRoot, 'package.json'), '{"name":"test"}\n');
            const sessionManager = new SessionManager(sessionsDir);
            const projection = sessionManager.create(workspaceRoot, { mode: 'executor' });

            await finalizeInvokeTurnState(
                sessionManager,
                projection,
                workspaceRoot,
                makeWriteTurnItems(),
            );

            expect(projection.manifest.turnCount).toBe(1);
            expect(projection.manifest.fileActivityIndex).not.toBeNull();

            const reloaded = sessionManager.load(projection.manifest.sessionId);
            expect(reloaded.manifest.turnCount).toBe(1);
            expect(reloaded.manifest.fileActivityIndex).not.toBeNull();

            const config = await prepareInvokeTurnConfig({
                conversationItems: [],
                task: 'Verify prior file activity',
                projection,
                provider: createNoopProvider(),
                model: 'mock-model',
                tools: [] as RegisteredTool[],
                workspaceRoot,
                shell: 'bash',
                baseConfig: baseTurnConfig(projection.manifest.sessionId, workspaceRoot),
                baseSystemMessages: [{ role: 'system', content: 'base invoke prompt' }],
                includeRuntimeContextMessage: true,
            });

            expect(config.workingSet?.some((entry) => entry.path === 'src/out.ts')).toBe(true);
            expect(String(config.systemMessages?.[1].content)).toContain('src/out.ts');
        } finally {
            rmSync(workspaceRoot, { recursive: true, force: true });
            rmSync(sessionsDir, { recursive: true, force: true });
        }
    });
});
