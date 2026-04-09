import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
    ConversationItem,
    MessageItem,
    ToolResultItem,
    SummaryItem,
    ToolOutput,
    AssistantPart,
} from '../../src/types/conversation.js';
import type { ItemId, ToolCallId } from '../../src/types/ids.js';
import type {
    ProviderDriver,
    ModelCapabilities,
    StreamEvent,
} from '../../src/types/provider.js';
import {
    buildCoverageMap,
    visibleHistory,
    computeCostCeiling,
    exceedsCostCeiling,
    deterministicFallback,
    summarizeChunk,
    chunkForSummarization,
} from '../../src/core/summarizer.js';
import { readConversationLog } from '../../src/core/conversation-reader.js';
import { ConversationWriter } from '../../src/core/conversation-writer.js';
import { groupIntoTurns } from '../../src/core/context-assembly.js';

// --- Test helpers ---

let seqCounter = 0;

function nextSeq(): number {
    return ++seqCounter;
}

beforeEach(() => {
    seqCounter = 0;
});

function makeUserMsg(text: string, seq?: number): MessageItem {
    const s = seq ?? nextSeq();
    return {
        kind: 'message',
        id: `itm_u${s}` as ItemId,
        seq: s,
        role: 'user',
        parts: [{ type: 'text', text }],
        timestamp: new Date().toISOString(),
    };
}

function makeAssistantMsg(
    text: string,
    seq?: number,
    toolCalls?: Array<{ toolCallId: string; toolName: string; arguments: Record<string, unknown> }>,
): MessageItem {
    const s = seq ?? nextSeq();
    const parts: AssistantPart[] = [];
    if (text) parts.push({ type: 'text', text });
    if (toolCalls) {
        for (const tc of toolCalls) {
            parts.push({
                type: 'tool_call',
                toolCallId: tc.toolCallId as ToolCallId,
                toolName: tc.toolName,
                arguments: tc.arguments,
            });
        }
    }
    return {
        kind: 'message',
        id: `itm_a${s}` as ItemId,
        seq: s,
        role: 'assistant',
        parts,
        timestamp: new Date().toISOString(),
    };
}

function makeToolOutput(data: string, overrides?: Partial<ToolOutput>): ToolOutput {
    return {
        status: 'success',
        data,
        truncated: false,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
        ...overrides,
    };
}

function makeToolResult(
    toolName: string,
    data: string,
    seq?: number,
    toolCallId?: string,
    outputOverrides?: Partial<ToolOutput>,
): ToolResultItem {
    const s = seq ?? nextSeq();
    return {
        kind: 'tool_result',
        id: `itm_tr${s}` as ItemId,
        seq: s,
        toolCallId: (toolCallId ?? `call_${s}`) as ToolCallId,
        toolName,
        output: makeToolOutput(data, outputOverrides),
        timestamp: new Date().toISOString(),
    };
}

function makeSummary(
    text: string,
    coversStart: number,
    coversEnd: number,
    seq?: number,
    pinnedFacts?: string[],
): SummaryItem {
    const s = seq ?? nextSeq();
    return {
        kind: 'summary',
        id: `itm_s${s}` as ItemId,
        seq: s,
        text,
        pinnedFacts,
        coversSeq: { start: coversStart, end: coversEnd },
        timestamp: new Date().toISOString(),
    };
}

/** Build a simple turn: user message + assistant response. */
function makeSimpleTurn(userText: string, assistantText: string): ConversationItem[] {
    return [makeUserMsg(userText), makeAssistantMsg(assistantText)];
}

function createMockProvider(responseJson: Record<string, unknown>): ProviderDriver {
    const responseText = JSON.stringify(responseJson);
    return {
        capabilities: (): ModelCapabilities => ({
            maxContext: 128000,
            maxOutput: 4096,
            supportsTools: 'native',
            supportsVision: false,
            supportsStreaming: true,
            supportsPrefill: false,
            supportsEmbedding: false,
            embeddingModels: [],
            toolReliability: 'native',
            costPerMillion: { input: 1, output: 3 },
            specialFeatures: [],
            bytesPerToken: 3.0,
        }),
        stream: (_request) => {
            async function* generate(): AsyncIterable<StreamEvent> {
                yield { type: 'text_delta', text: responseText };
                yield {
                    type: 'done',
                    finishReason: 'stop',
                    usage: { inputTokens: 100, outputTokens: 50 },
                };
            }
            return generate();
        },
        validate: () => ({ ok: true as const, value: undefined }),
    };
}

function createErrorProvider(): ProviderDriver {
    return {
        capabilities: (): ModelCapabilities => ({
            maxContext: 128000,
            maxOutput: 4096,
            supportsTools: 'native',
            supportsVision: false,
            supportsStreaming: true,
            supportsPrefill: false,
            supportsEmbedding: false,
            embeddingModels: [],
            toolReliability: 'native',
            costPerMillion: { input: 1, output: 3 },
            specialFeatures: [],
            bytesPerToken: 3.0,
        }),
        stream: (_request) => {
            async function* generate(): AsyncIterable<StreamEvent> {
                yield {
                    type: 'error',
                    error: { code: 'test_error', message: 'Mock LLM error' },
                };
            }
            return generate();
        },
        validate: () => ({ ok: true as const, value: undefined }),
    };
}

/** Create a string of approximately n tokens at bytesPerToken=3. */
function textOfTokens(n: number): string {
    return 'x'.repeat(n * 3);
}

// --- Tests ---

describe('Summarizer', () => {
    describe('buildCoverageMap', () => {
        it('builds map from summary items coversSeq ranges', () => {
            const items: ConversationItem[] = [
                makeUserMsg('hello', 1),
                makeAssistantMsg('hi', 2),
                makeUserMsg('how?', 3),
                makeAssistantMsg('fine', 4),
                makeSummary('Summary of turns 1-4', 1, 4, 5),
            ];
            const map = buildCoverageMap(items);

            expect(map.size).toBe(4);
            expect(map.get(1)).toBe(5);
            expect(map.get(2)).toBe(5);
            expect(map.get(3)).toBe(5);
            expect(map.get(4)).toBe(5);
            expect(map.has(5)).toBe(false);
        });

        it('later summaries override earlier for overlapping ranges', () => {
            const items: ConversationItem[] = [
                makeUserMsg('a', 1),
                makeAssistantMsg('b', 2),
                makeUserMsg('c', 3),
                makeAssistantMsg('d', 4),
                makeSummary('First summary', 1, 2, 5),
                makeUserMsg('e', 6),
                makeAssistantMsg('f', 7),
                // Newer summary covering 1-5 (includes the first summary)
                makeSummary('Second summary', 1, 5, 8),
            ];
            const map = buildCoverageMap(items);

            // Seqs 1-2 now point to summary 8, not 5
            expect(map.get(1)).toBe(8);
            expect(map.get(2)).toBe(8);
            // Seqs 3-5 also covered by summary 8
            expect(map.get(3)).toBe(8);
            expect(map.get(4)).toBe(8);
            expect(map.get(5)).toBe(8);
            // Seqs 6-7 not covered
            expect(map.has(6)).toBe(false);
            expect(map.has(7)).toBe(false);
        });
    });

    describe('visibleHistory', () => {
        it('returns all items when no summaries exist', () => {
            const items: ConversationItem[] = [
                makeUserMsg('a', 1),
                makeAssistantMsg('b', 2),
            ];
            const map = buildCoverageMap(items);
            const visible = visibleHistory(items, map);

            expect(visible).toHaveLength(2);
            expect(visible[0].seq).toBe(1);
            expect(visible[1].seq).toBe(2);
        });

        it('hides items covered by a summary, shows the summary (test 2)', () => {
            const items: ConversationItem[] = [
                makeUserMsg('hello', 1),
                makeAssistantMsg('hi', 2),
                makeUserMsg('how?', 3),
                makeAssistantMsg('fine', 4),
                // Summary covering seqs 1-4
                makeSummary('Summary of early conversation', 1, 4, 5),
                // Newer items not covered
                makeUserMsg('next question', 6),
                makeAssistantMsg('answer', 7),
            ];
            const map = buildCoverageMap(items);
            const visible = visibleHistory(items, map);

            expect(visible).toHaveLength(3);
            expect(visible[0].kind).toBe('summary');
            expect(visible[0].seq).toBe(5);
            expect(visible[1].seq).toBe(6);
            expect(visible[2].seq).toBe(7);
        });

        it('with nested summaries, only newest summary visible (test 7)', () => {
            const items: ConversationItem[] = [
                makeUserMsg('a', 1),
                makeAssistantMsg('b', 2),
                makeUserMsg('c', 3),
                makeAssistantMsg('d', 4),
                // First summary: covers 1-4
                makeSummary('First summary', 1, 4, 5),
                makeUserMsg('e', 6),
                makeAssistantMsg('f', 7),
                makeUserMsg('g', 8),
                makeAssistantMsg('h', 9),
                // Second summary: covers 1-9, including first summary (seq 5)
                makeSummary('Nested summary covering everything', 1, 9, 10),
                // Items after the nested summary
                makeUserMsg('final', 11),
                makeAssistantMsg('done', 12),
            ];
            const map = buildCoverageMap(items);
            const visible = visibleHistory(items, map);

            // Only the newer summary (seq 10) and post-summary items should be visible
            expect(visible).toHaveLength(3);
            expect(visible[0].kind).toBe('summary');
            expect(visible[0].seq).toBe(10);
            expect((visible[0] as SummaryItem).text).toBe('Nested summary covering everything');
            expect(visible[1].seq).toBe(11);
            expect(visible[2].seq).toBe(12);
        });
    });

    describe('computeCostCeiling', () => {
        it('returns 40% of original tokens (test 3)', () => {
            // 5 turns totaling 100 tokens → ceiling = 40
            expect(computeCostCeiling(100)).toBe(40);
            expect(computeCostCeiling(200)).toBe(80);
            expect(computeCostCeiling(1000)).toBe(400);
        });
    });

    describe('exceedsCostCeiling', () => {
        it('returns true for small chunks — 100 tokens exceeds ceiling', () => {
            // 100 tokens → ceiling = 40, estimated response = max(50, 10) = 50 > 40
            expect(exceedsCostCeiling(100)).toBe(true);
        });

        it('returns false for large chunks — 5000 tokens within ceiling', () => {
            // 5000 tokens → ceiling = 2000, estimated response = max(50, 500) = 500 < 2000
            expect(exceedsCostCeiling(5000)).toBe(false);
        });

        it('boundary: 125 tokens is the crossover point', () => {
            // 125 tokens → ceiling = 50, estimated response = max(50, 12.5→13) = 50 ≤ 50
            // floor(125 * 0.4) = 50, max(50, 13) = 50, 50 > 50 is false
            expect(exceedsCostCeiling(125)).toBe(false);
            // 124 tokens → ceiling = floor(49.6) = 49, response = 50 > 49
            expect(exceedsCostCeiling(124)).toBe(true);
        });
    });

    describe('deterministicFallback', () => {
        it('preserves first item, last item, tool call digests (test 5)', () => {
            const userMsg = makeUserMsg('Fix the bug in auth.ts', 1);
            const assistantCallMsg = makeAssistantMsg('', 2, [
                { toolCallId: 'call_3', toolName: 'read_file', arguments: { file_path: 'src/auth.ts' } },
            ]);
            const toolResult = makeToolResult('read_file', 'file contents here...', 3, 'call_3');
            const assistantReply = makeAssistantMsg('I found the issue, let me fix it', 4);
            const assistantFixMsg = makeAssistantMsg('', 5, [
                { toolCallId: 'call_6', toolName: 'edit_file', arguments: { file_path: 'src/auth.ts' } },
            ]);
            const editResult = makeToolResult('edit_file', 'OK', 6, 'call_6');
            const finalMsg = makeAssistantMsg('Fixed the bug', 7);

            const items = [userMsg, assistantCallMsg, toolResult, assistantReply, assistantFixMsg, editResult, finalMsg];
            const fallback = deterministicFallback(items, items);

            // First item preserved
            expect(fallback).toContain('[user]: Fix the bug in auth.ts');
            // Last item preserved
            expect(fallback).toContain('[assistant]: Fixed the bug');
            // Tool result in middle gets a digest
            expect(fallback).toContain('read_file:');
            expect(fallback).toContain('src/auth.ts');
            expect(fallback).toContain('edit_file:');
            // Assistant filler text in middle is discarded
            expect(fallback).not.toContain('I found the issue');
        });

        it('handles single item', () => {
            const item = makeUserMsg('hello', 1);
            const result = deterministicFallback([item], [item]);
            expect(result).toContain('[user]: hello');
        });

        it('handles empty items', () => {
            expect(deterministicFallback([], [])).toBe('');
        });
    });

    describe('summarizeChunk', () => {
        it('creates SummaryItem with correct coversSeq range (test 1)', async () => {
            // Build 5 simple turns (small enough to trigger fallback)
            const allItems: ConversationItem[] = [];
            for (let i = 0; i < 5; i++) {
                allItems.push(...makeSimpleTurn(`question ${i}`, `answer ${i}`));
            }

            const result = await summarizeChunk({
                chunkItems: allItems,
                allItems,
                nextSeq: 100,
            });

            expect(result.summary.kind).toBe('summary');
            expect(result.summary.seq).toBe(100);
            expect(result.summary.coversSeq.start).toBe(allItems[0].seq);
            expect(result.summary.coversSeq.end).toBe(allItems[allItems.length - 1].seq);
            expect(result.summary.text.length).toBeGreaterThan(0);
        });

        it('uses fallback when cost ceiling exceeded — no LLM call (test 4)', async () => {
            // 3 turns with minimal text → ~78 tokens total
            // ceiling = floor(78 * 0.4) = 31, estimated response = 50 > 31 → fallback
            const allItems: ConversationItem[] = [];
            for (let i = 0; i < 3; i++) {
                allItems.push(...makeSimpleTurn(`q${i}`, `a${i}`));
            }

            // Provide a provider that should NOT be called
            let llmCalled = false;
            const mockProvider: ProviderDriver = {
                ...createMockProvider({ summaryText: 'should not appear' }),
                stream: (_request) => {
                    llmCalled = true;
                    async function* generate(): AsyncIterable<StreamEvent> {
                        yield { type: 'text_delta', text: '{}' };
                        yield {
                            type: 'done',
                            finishReason: 'stop',
                            usage: { inputTokens: 100, outputTokens: 50 },
                        };
                    }
                    return generate();
                },
            };

            const result = await summarizeChunk({
                chunkItems: allItems,
                allItems,
                provider: mockProvider,
                model: 'test-model',
                nextSeq: 50,
            });

            expect(result.usedFallback).toBe(true);
            expect(llmCalled).toBe(false);
        });

        it('uses LLM when cost ceiling not exceeded', async () => {
            // Create a large enough chunk to pass the cost ceiling
            const allItems: ConversationItem[] = [];
            for (let i = 0; i < 5; i++) {
                // Each turn has ~1000 tokens of content
                allItems.push(...makeSimpleTurn(textOfTokens(200), textOfTokens(200)));
            }

            const mockProvider = createMockProvider({
                summaryText: 'LLM-generated summary of the conversation',
                pinnedFacts: ['fact1', 'fact2'],
                durableStatePatch: {},
            });

            const result = await summarizeChunk({
                chunkItems: allItems,
                allItems,
                provider: mockProvider,
                model: 'test-model',
                nextSeq: 50,
            });

            expect(result.usedFallback).toBe(false);
            expect(result.summary.text).toBe('LLM-generated summary of the conversation');
            expect(result.summary.pinnedFacts).toEqual(['fact1', 'fact2']);
            expect(result.durableStatePatch).toEqual({});
        });

        it('surfaces normalized durableStatePatch from the summarizer response', async () => {
            const allItems: ConversationItem[] = [];
            for (let i = 0; i < 5; i++) {
                allItems.push(...makeSimpleTurn(textOfTokens(200), textOfTokens(200)));
            }

            const mockProvider = createMockProvider({
                summaryText: 'summary',
                pinnedFacts: [],
                durableStatePatch: {
                    goal: 'ship auth fix',
                    confirmedFactsAdd: ['tests are green'],
                    openLoopsUpdate: [{ id: 'loop_1', status: 'done' }],
                },
            });

            const result = await summarizeChunk({
                chunkItems: allItems,
                allItems,
                provider: mockProvider,
                model: 'test-model',
                nextSeq: 51,
            });

            expect(result.durableStatePatch).toEqual({
                goal: 'ship auth fix',
                confirmedFactsAdd: ['tests are green'],
                openLoopsUpdate: [{ id: 'loop_1', status: 'done' }],
            });
        });

        it('falls back to deterministic on LLM error', async () => {
            const allItems: ConversationItem[] = [];
            for (let i = 0; i < 5; i++) {
                allItems.push(...makeSimpleTurn(textOfTokens(200), textOfTokens(200)));
            }

            const errorProvider = createErrorProvider();

            const result = await summarizeChunk({
                chunkItems: allItems,
                allItems,
                provider: errorProvider,
                model: 'test-model',
                nextSeq: 50,
            });

            expect(result.usedFallback).toBe(true);
            expect(result.summary.text.length).toBeGreaterThan(0);
        });

        it('uses fallback when no provider given', async () => {
            const allItems = makeSimpleTurn('hello', 'world');

            const result = await summarizeChunk({
                chunkItems: allItems,
                allItems,
                nextSeq: 10,
            });

            expect(result.usedFallback).toBe(true);
        });
    });

    describe('nested summaries (test 6)', () => {
        it('re-summarize existing summary — newer summary covers older range', async () => {
            // Original items
            const items: ConversationItem[] = [
                makeUserMsg('a', 1),
                makeAssistantMsg('b', 2),
                makeUserMsg('c', 3),
                makeAssistantMsg('d', 4),
            ];

            // First summarization: covers seqs 1-4
            const firstResult = await summarizeChunk({
                chunkItems: items,
                allItems: items,
                nextSeq: 5,
            });
            expect(firstResult.summary.coversSeq).toEqual({ start: 1, end: 4 });

            // Add more items
            const moreItems: ConversationItem[] = [
                firstResult.summary,
                makeUserMsg('e', 6),
                makeAssistantMsg('f', 7),
            ];

            const allItemsWithSummary = [...items, ...moreItems];

            // Second summarization: covers seqs 5-7 (includes the first summary)
            const secondResult = await summarizeChunk({
                chunkItems: moreItems,
                allItems: allItemsWithSummary,
                nextSeq: 8,
            });
            expect(secondResult.summary.coversSeq).toEqual({ start: 5, end: 7 });

            // Build coverage map with both summaries
            const allFinal = [...allItemsWithSummary, secondResult.summary];
            const map = buildCoverageMap(allFinal);

            // First summary (seq 5) is covered by second summary (seq 8)
            expect(map.get(5)).toBe(8);
            // Original items 1-4 still covered by first summary (seq 5)
            expect(map.get(1)).toBe(5);

            // visibleHistory should show: summary 5 is covered by 8, so only 8 is visible
            // Items 1-4 are covered by 5, items 5-7 are covered by 8
            const visible = visibleHistory(allFinal, map);
            expect(visible).toHaveLength(1);
            expect(visible[0].seq).toBe(8);
        });
    });

    describe('chunkForSummarization', () => {
        it('respects max turns per chunk', () => {
            const allItems: ConversationItem[] = [];
            for (let i = 0; i < 15; i++) {
                allItems.push(...makeSimpleTurn(`q${i}`, `a${i}`));
            }
            const turns = groupIntoTurns(allItems);

            const chunks = chunkForSummarization(turns, 3.0, 1.0, 5, 100_000);

            expect(chunks.length).toBe(3); // 15 turns / 5 per chunk = 3 chunks
            // Each chunk should have items from 5 turns (2 items each = 10 items)
            expect(chunks[0].length).toBe(10);
            expect(chunks[1].length).toBe(10);
            expect(chunks[2].length).toBe(10);
        });

        it('respects max tokens per chunk', () => {
            const allItems: ConversationItem[] = [];
            // Each turn: ~400 tokens (user 200 + assistant 200, plus overhead)
            for (let i = 0; i < 10; i++) {
                allItems.push(...makeSimpleTurn(textOfTokens(200), textOfTokens(200)));
            }
            const turns = groupIntoTurns(allItems);

            // Max 1000 tokens per chunk — should fit ~2 turns each
            const chunks = chunkForSummarization(turns, 3.0, 1.0, 100, 1000);

            expect(chunks.length).toBeGreaterThan(1);
            // Each chunk should have few turns due to token limit
            for (const chunk of chunks) {
                const turns = groupIntoTurns(chunk);
                expect(turns.length).toBeLessThanOrEqual(3);
            }
        });
    });

    describe('coverage map rebuild from JSONL (test 8)', () => {
        it('rebuilds coverage map from loaded conversation items', () => {
            let tmpDir: string;
            try {
                tmpDir = mkdtempSync(join(tmpdir(), 'summarizer-test-'));
            } catch {
                // Skip test if temp dir creation fails
                return;
            }

            const logPath = join(tmpDir, 'conversation.jsonl');

            try {
                const writer = new ConversationWriter(logPath);

                // Write original items
                const item1 = makeUserMsg('hello', 1);
                const item2 = makeAssistantMsg('hi there', 2);
                const item3 = makeUserMsg('how are you?', 3);
                const item4 = makeAssistantMsg('doing well', 4);
                writer.writeItem(item1);
                writer.writeItem(item2);
                writer.writeItem(item3);
                writer.writeItem(item4);

                // Write a summary covering items 1-4
                const summary = makeSummary('Earlier greeting exchange', 1, 4, 5);
                writer.writeItem(summary);

                // Write more items after summary
                const item6 = makeUserMsg('new topic', 6);
                const item7 = makeAssistantMsg('new response', 7);
                writer.writeItem(item6);
                writer.writeItem(item7);

                // Read back and rebuild
                const { records } = readConversationLog(logPath);
                const loadedItems: ConversationItem[] = records
                    .filter(r => r.recordType === 'message' || r.recordType === 'tool_result' || r.recordType === 'summary')
                    .map(r => r.record as ConversationItem);

                const map = buildCoverageMap(loadedItems);

                // Verify coverage map
                expect(map.size).toBe(4);
                expect(map.get(1)).toBe(5);
                expect(map.get(2)).toBe(5);
                expect(map.get(3)).toBe(5);
                expect(map.get(4)).toBe(5);
                expect(map.has(5)).toBe(false);
                expect(map.has(6)).toBe(false);

                // Verify visible history
                const visible = visibleHistory(loadedItems, map);
                expect(visible).toHaveLength(3); // summary + items 6, 7
                expect(visible[0].kind).toBe('summary');
                expect(visible[0].seq).toBe(5);
                expect(visible[1].seq).toBe(6);
                expect(visible[2].seq).toBe(7);
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    });
});
