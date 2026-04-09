import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
    ConversationItem,
    MessageItem,
} from '../../src/types/conversation.js';
import type {
    ItemId,
    SessionId,
    WorkspaceId,
} from '../../src/types/ids.js';
import type {
    ProviderDriver,
    ModelCapabilities,
    ModelRequest,
    StreamEvent,
} from '../../src/types/provider.js';
import { ConversationWriter } from '../../src/core/conversation-writer.js';
import { SequenceGenerator } from '../../src/types/sequence.js';
import type { SessionManifest } from '../../src/core/session-manager.js';
import { summarizeHistoryBeforeTurn } from '../../src/core/pre-turn-summarization.js';
import { preparePrompt } from '../../src/core/prompt-assembly.js';
import { readConversationLog } from '../../src/core/conversation-reader.js';

function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'aca-preturn-summary-'));
}

function makeMockCapabilities(): ModelCapabilities {
    return {
        maxContext: 1800,
        maxOutput: 256,
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

function createProvider(): ProviderDriver {
    return {
        capabilities: () => makeMockCapabilities(),
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

function makeManifest(): SessionManifest {
    return {
        sessionId: 'ses_TEST000000000000000000000' as SessionId,
        workspaceId: 'wrk_TEST' as WorkspaceId,
        status: 'active',
        turnCount: 0,
        lastActivityTimestamp: new Date().toISOString(),
        configSnapshot: { workspaceRoot: '/repo' },
        durableTaskState: null,
        fileActivityIndex: null,
        calibration: null,
    };
}

describe('pre-turn summarization', () => {
    it('creates a persisted summary before the next turn when history would be dropped', async () => {
        const dir = tmpDir();
        try {
            const conversationPath = join(dir, 'conversation.jsonl');
            writeFileSync(conversationPath, '');
            const writer = new ConversationWriter(conversationPath);
            const historyItems = makeHistory(9, 'x'.repeat(180));
            const sequenceGenerator = new SequenceGenerator(historyItems[historyItems.length - 1].seq);
            const manifest = makeManifest();
            const provider = createProvider();

            const created = await summarizeHistoryBeforeTurn({
                historyItems,
                pendingUserInput: 'Next task',
                workspaceRoot: dir,
                shell: 'bash',
                manifest,
                writer,
                sequenceGenerator,
                provider,
                model: 'mock-model',
                tools: [],
            });

            expect(created.length).toBeGreaterThan(0);
            expect(manifest.durableTaskState).not.toBeNull();
            expect(manifest.durableTaskState!.goal).toBe('Document the compressed work');
            expect(manifest.durableTaskState!.confirmedFacts).toContain('fact-a');
            expect(manifest.durableTaskState!.revision).toBe(1);

            const log = readConversationLog(conversationPath);
            expect(log.records.some((record) => record.recordType === 'summary')).toBe(true);

            const prepared = preparePrompt({
                model: 'mock-model',
                tools: [],
                items: [
                    ...historyItems,
                    makeUserMessage('Next task', sequenceGenerator.peek()),
                ],
                cwd: dir,
                shell: 'bash',
                contextLimit: provider.capabilities('mock-model').maxContext,
                reservedOutputTokens: provider.capabilities('mock-model').maxOutput,
                bytesPerToken: provider.capabilities('mock-model').bytesPerToken,
            });

            const contents = prepared.request.messages.map((message) => String(message.content));
            expect(contents.some((content) => content.includes('Question 0'))).toBe(false);
            expect(contents.some((content) => content.includes('[Summary of earlier conversation]'))).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
