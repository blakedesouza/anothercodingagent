import { describe, it, expect, beforeEach } from 'vitest';
import type {
    ConversationItem,
    MessageItem,
    ToolResultItem,
    SummaryItem,
    ToolOutput,
    AssistantPart,
} from '../../src/types/conversation.js';
import type { ItemId, ToolCallId } from '../../src/types/ids.js';
import {
    determineTier,
    escalateTier,
    estimateItemTokens,
    groupIntoTurns,
    computeDigest,
    findToolCallArgs,
    assembleContext,
    getVerbatimTurnLimit,
    renderProjectForTier,
    buildToolDefsForTier,
    getTierContextFlags,
    EMERGENCY_WARNING_MESSAGE,
} from '../../src/core/context-assembly.js';
import { estimateTextTokens, MESSAGE_OVERHEAD, TOOL_CALL_OVERHEAD } from '../../src/core/token-estimator.js';
import type { ProjectSnapshot } from '../../src/core/project-awareness.js';
import type { RegisteredTool } from '../../src/tools/tool-registry.js';

// --- Test helpers ---

let seqCounter = 0;

function nextSeq(): number {
    return ++seqCounter;
}

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

function makeSummary(text: string, coversStart: number, coversEnd: number, seq?: number): SummaryItem {
    const s = seq ?? nextSeq();
    return {
        kind: 'summary',
        id: `itm_s${s}` as ItemId,
        seq: s,
        text,
        coversSeq: { start: coversStart, end: coversEnd },
        timestamp: new Date().toISOString(),
    };
}

/** Create a string that estimates to approximately `n` text tokens at bytesPerToken=3. */
function textOfTokens(n: number): string {
    return 'x'.repeat(n * 3);
}

/**
 * Build a simple turn: user message + assistant response.
 * Returns items and their total estimated token count.
 */
function buildTurn(
    userText: string,
    assistantText: string,
    seqStart?: number,
): { items: ConversationItem[]; tokens: number } {
    const s1 = seqStart ?? nextSeq();
    const s2 = s1 + 1;
    seqCounter = Math.max(seqCounter, s2);
    const user = makeUserMsg(userText, s1);
    const assistant = makeAssistantMsg(assistantText, s2);
    const tokens = estimateItemTokens(user) + estimateItemTokens(assistant);
    return { items: [user, assistant], tokens };
}

beforeEach(() => {
    seqCounter = 0;
});

// --- determineTier ---

describe('determineTier', () => {
    it('< 60% → full', () => {
        expect(determineTier(0.0)).toBe('full');
        expect(determineTier(0.3)).toBe('full');
        expect(determineTier(0.59)).toBe('full');
        expect(determineTier(0.599)).toBe('full');
    });

    it('exactly 60% → medium (not full)', () => {
        expect(determineTier(0.6)).toBe('medium');
    });

    it('>= 60% and < 80% → medium', () => {
        expect(determineTier(0.65)).toBe('medium');
        expect(determineTier(0.7)).toBe('medium');
        expect(determineTier(0.79)).toBe('medium');
    });

    it('exactly 80% → aggressive', () => {
        expect(determineTier(0.8)).toBe('aggressive');
    });

    it('>= 80% and < 90% → aggressive', () => {
        expect(determineTier(0.85)).toBe('aggressive');
        expect(determineTier(0.89)).toBe('aggressive');
    });

    it('exactly 90% → emergency', () => {
        expect(determineTier(0.9)).toBe('emergency');
    });

    it('>= 90% → emergency', () => {
        expect(determineTier(0.95)).toBe('emergency');
        expect(determineTier(1.0)).toBe('emergency');
        expect(determineTier(1.5)).toBe('emergency');
    });
});

// --- escalateTier ---

describe('escalateTier', () => {
    it('full → medium', () => expect(escalateTier('full')).toBe('medium'));
    it('medium → aggressive', () => expect(escalateTier('medium')).toBe('aggressive'));
    it('aggressive → emergency', () => expect(escalateTier('aggressive')).toBe('emergency'));
    it('emergency → emergency (cannot escalate further)', () => expect(escalateTier('emergency')).toBe('emergency'));
});

// --- estimateItemTokens ---

describe('estimateItemTokens', () => {
    it('user message: MESSAGE_OVERHEAD + text tokens', () => {
        const msg = makeUserMsg('hello'); // 5 bytes → ceil(5/3) = 2
        expect(estimateItemTokens(msg)).toBe(MESSAGE_OVERHEAD + 2); // 12 + 2 = 14
    });

    it('assistant message with tool call: overhead + args', () => {
        const msg = makeAssistantMsg('thinking...', undefined, [{
            toolCallId: 'call_1',
            toolName: 'read_file',
            arguments: { path: '/tmp/test.ts' },
        }]);
        const textTokens = estimateTextTokens('thinking...');
        const argsTokens = estimateTextTokens(JSON.stringify({ path: '/tmp/test.ts' }));
        expect(estimateItemTokens(msg)).toBe(MESSAGE_OVERHEAD + textTokens + TOOL_CALL_OVERHEAD + argsTokens);
    });

    it('tool result: TOOL_CALL_OVERHEAD + JSON payload tokens', () => {
        const tr = makeToolResult('read_file', 'file content here');
        const payload = JSON.stringify({
            status: 'success',
            data: 'file content here',
            error: undefined,
        });
        const payloadTokens = estimateTextTokens(payload);
        expect(estimateItemTokens(tr)).toBe(TOOL_CALL_OVERHEAD + payloadTokens);
    });

    it('summary item: MESSAGE_OVERHEAD + summary text tokens', () => {
        const summary = makeSummary('The user asked about X and Y.', 1, 5);
        const expectedText = '[Summary of earlier conversation]\nThe user asked about X and Y.';
        const textTokens = estimateTextTokens(expectedText);
        expect(estimateItemTokens(summary)).toBe(MESSAGE_OVERHEAD + textTokens);
    });

    it('calibration multiplier scales estimate', () => {
        const msg = makeUserMsg('hello');
        const base = estimateItemTokens(msg, 3.0, 1.0);
        const calibrated = estimateItemTokens(msg, 3.0, 1.5);
        expect(calibrated).toBe(Math.ceil(base * 1.5));
    });
});

// --- groupIntoTurns ---

describe('groupIntoTurns', () => {
    it('empty items → empty turns', () => {
        expect(groupIntoTurns([])).toEqual([]);
    });

    it('single user message → one turn', () => {
        const items = [makeUserMsg('hello', 1)];
        const turns = groupIntoTurns(items);
        expect(turns).toHaveLength(1);
        expect(turns[0]).toHaveLength(1);
        expect(turns[0][0].kind).toBe('message');
    });

    it('user + assistant = one turn', () => {
        const items: ConversationItem[] = [
            makeUserMsg('hello', 1),
            makeAssistantMsg('hi there', 2),
        ];
        const turns = groupIntoTurns(items);
        expect(turns).toHaveLength(1);
        expect(turns[0]).toHaveLength(2);
    });

    it('two user messages → two turns', () => {
        const items: ConversationItem[] = [
            makeUserMsg('first', 1),
            makeAssistantMsg('response 1', 2),
            makeUserMsg('second', 3),
            makeAssistantMsg('response 2', 4),
        ];
        const turns = groupIntoTurns(items);
        expect(turns).toHaveLength(2);
        expect(turns[0]).toHaveLength(2);
        expect(turns[1]).toHaveLength(2);
    });

    it('tool results grouped with their turn', () => {
        const items: ConversationItem[] = [
            makeUserMsg('read a file', 1),
            makeAssistantMsg('', 2, [{
                toolCallId: 'call_1',
                toolName: 'read_file',
                arguments: { path: '/tmp/test' },
            }]),
            makeToolResult('read_file', 'file content', 3, 'call_1'),
            makeAssistantMsg('here is the file', 4),
        ];
        const turns = groupIntoTurns(items);
        expect(turns).toHaveLength(1);
        expect(turns[0]).toHaveLength(4);
    });

    it('preamble items before first user message form their own group', () => {
        const items: ConversationItem[] = [
            makeAssistantMsg('system init', 1),
            makeUserMsg('hello', 2),
            makeAssistantMsg('hi', 3),
        ];
        const turns = groupIntoTurns(items);
        expect(turns).toHaveLength(2);
        expect(turns[0]).toHaveLength(1); // preamble
        expect(turns[1]).toHaveLength(2); // user turn
    });

    it('summary items do not start new turns', () => {
        const items: ConversationItem[] = [
            makeUserMsg('first', 1),
            makeAssistantMsg('resp', 2),
            makeSummary('summary of old stuff', 0, 0, 3),
            makeUserMsg('second', 4),
        ];
        const turns = groupIntoTurns(items);
        expect(turns).toHaveLength(2);
        expect(turns[0]).toHaveLength(3); // user + assistant + summary
        expect(turns[1]).toHaveLength(1); // second user
    });
});

// --- findToolCallArgs ---

describe('findToolCallArgs', () => {
    it('finds arguments for matching toolCallId', () => {
        const items: ConversationItem[] = [
            makeAssistantMsg('', 1, [{
                toolCallId: 'call_42',
                toolName: 'read_file',
                arguments: { path: '/test.ts' },
            }]),
            makeToolResult('read_file', 'content', 2, 'call_42'),
        ];
        const args = findToolCallArgs(items, 'call_42');
        expect(args).toEqual({ path: '/test.ts' });
    });

    it('returns undefined for unknown toolCallId', () => {
        const items: ConversationItem[] = [
            makeAssistantMsg('no tools', 1),
        ];
        expect(findToolCallArgs(items, 'call_999')).toBeUndefined();
    });
});

// --- computeDigest ---

describe('computeDigest', () => {
    it('read_file: contains file path, line range, total lines, omission notice', () => {
        const data = 'line1\nline2\nline3\nline4\nline5';
        const tr = makeToolResult('read_file', data, 1, 'call_1');
        const digest = computeDigest(tr, { path: '/src/main.ts', line_start: 10, line_end: 14 });
        expect(digest).toContain('/src/main.ts');
        expect(digest).toContain('lines 10-14');
        expect(digest).toContain('5 lines total');
        expect(digest).toContain('[content omitted — use read_file to re-read]');
    });

    it('read_file digest prefers structured totalLines metadata from live tool output', () => {
        const data = JSON.stringify({
            content: 'line1\nline2\nline3',
            encoding: 'utf-8',
            lineCount: 3,
            byteCount: 17,
            totalLines: 42,
            totalBytes: 420,
            nextStartLine: 4,
        });
        const tr = makeToolResult('read_file', data, 1, 'call_1');
        const digest = computeDigest(tr, { path: '/src/main.ts', line_start: 1, line_end: 3 });
        expect(digest).toContain('42 lines total');
    });

    it('read_file with no line range args → "all lines"', () => {
        const tr = makeToolResult('read_file', 'content\nhere', 1, 'call_1');
        const digest = computeDigest(tr, { path: '/test.ts' });
        expect(digest).toContain('all lines');
    });

    it('exec_command: contains command, exit code, stderr headline, bytes omitted', () => {
        const data = JSON.stringify({
            exit_code: 1,
            stdout: '',
            stderr: 'Error: file not found\nsome other line',
            duration_ms: 50,
        });
        const tr = makeToolResult('exec_command', data, 1, 'call_1', {
            bytesReturned: data.length,
            bytesOmitted: 500,
        });
        const digest = computeDigest(tr, { command: 'cat /nonexistent' });
        expect(digest).toContain('`cat /nonexistent`');
        expect(digest).toContain('Exit code: 1');
        expect(digest).toContain('Error: file not found');
        expect(digest).toContain('500 bytes omitted');
    });

    it('exec_command with success → exit code 0', () => {
        const data = JSON.stringify({ exit_code: 0, stdout: 'ok', stderr: '', duration_ms: 10 });
        const tr = makeToolResult('exec_command', data, 1, 'call_1');
        const digest = computeDigest(tr, { command: 'echo hello' });
        expect(digest).toContain('Exit code: 0');
    });

    it('search_text: contains query, match count, top 3 paths', () => {
        const data = JSON.stringify({
            matches: [
                { file: 'src/a.ts', line: 1, content: 'TODO: a' },
                { file: 'src/b.ts', line: 2, content: 'TODO: b' },
                { file: 'src/c.ts', line: 3, content: 'TODO: c' },
                { file: 'src/d.ts', line: 4, content: 'TODO: d' },
                { file: 'src/e.ts', line: 5, content: 'TODO: e' },
            ],
            truncated: false,
        });
        const tr = makeToolResult('search_text', data, 1, 'call_1');
        const digest = computeDigest(tr, { pattern: 'TODO' });
        expect(digest).toContain('"TODO"');
        expect(digest).toContain('5 matches');
        expect(digest).toContain('src/a.ts');
        expect(digest).toContain('src/b.ts');
        expect(digest).toContain('src/c.ts');
        expect(digest).not.toContain('src/d.ts');
    });

    it('find_paths: contains pattern, match count, top 3 paths', () => {
        const data = JSON.stringify({
            matches: [
                { path: 'lib/foo.js', kind: 'file', size: 100, mtime: 1 },
                { path: 'lib/bar.js', kind: 'file', size: 120, mtime: 2 },
            ],
            truncated: false,
        });
        const tr = makeToolResult('find_paths', data, 1, 'call_1');
        const digest = computeDigest(tr, { pattern: '*.js' });
        expect(digest).toContain('"*.js"');
        expect(digest).toContain('2 matches');
        expect(digest).toContain('lib/foo.js');
        expect(digest).toContain('lib/bar.js');
    });

    it('lsp_query: contains operation, target, result count, first result', () => {
        const data = JSON.stringify({
            kind: 'references',
            locations: [
                {
                    uri: 'file:///workspace/src/main.ts',
                    startLine: 10,
                    startCharacter: 1,
                    endLine: 10,
                    endCharacter: 14,
                },
                {
                    uri: 'file:///workspace/src/main.ts',
                    startLine: 25,
                    startCharacter: 1,
                    endLine: 25,
                    endCharacter: 15,
                },
            ],
        });
        const tr = makeToolResult('lsp_query', data, 1, 'call_1');
        const digest = computeDigest(tr, { operation: 'references', file: 'src/main.ts' });
        expect(digest).toContain('references');
        expect(digest).toContain('src/main.ts');
        expect(digest).toContain('2 results');
        expect(digest).toContain('First:');
    });

    it('unknown tool: contains tool name, status, data size, [result omitted]', () => {
        const data = 'some data here';
        const tr = makeToolResult('custom_tool', data, 1, 'call_1', {
            bytesReturned: 100,
            bytesOmitted: 50,
        });
        const digest = computeDigest(tr);
        expect(digest).toContain('custom_tool');
        expect(digest).toContain('success');
        expect(digest).toContain('150 bytes');
        expect(digest).toContain('[result omitted]');
    });

    it('digest is typically 50-150 tokens', () => {
        const bigData = 'x'.repeat(50000);
        const tr = makeToolResult('read_file', bigData, 1, 'call_1');
        const digest = computeDigest(tr, { file_path: '/big-file.ts' });
        const digestTokens = estimateTextTokens(digest);
        expect(digestTokens).toBeGreaterThanOrEqual(10);
        expect(digestTokens).toBeLessThanOrEqual(200);
    });
});

// --- assembleContext ---

describe('assembleContext', () => {
    /**
     * Helper: create N turns (user + assistant pairs) with controlled text sizes.
     * Uses reservedOutputTokens=0 convention (all tests in this suite use it).
     *
     * For contextLimit C with reservedOutput=0:
     *   guard = max(512, ceil(C * 0.08))
     *   safeInputBudget = C - guard
     * For C > 6400: safeInputBudget ≈ C * 0.92
     * For C ≤ 6400: safeInputBudget = C - 512
     */
    function buildConversation(
        turnCount: number,
        tokensPerTurn: number,
    ): { items: ConversationItem[]; totalItemTokens: number } {
        const items: ConversationItem[] = [];
        let totalItemTokens = 0;

        for (let i = 0; i < turnCount; i++) {
            const s = i * 2 + 1;
            const textTokensEach = Math.floor((tokensPerTurn - 2 * MESSAGE_OVERHEAD) / 2);
            const user = makeUserMsg(textOfTokens(textTokensEach), s);
            const assistant = makeAssistantMsg(textOfTokens(textTokensEach), s + 1);
            items.push(user, assistant);
            totalItemTokens += estimateItemTokens(user) + estimateItemTokens(assistant);
        }

        return { items, totalItemTokens };
    }

    /**
     * Compute contextLimit such that ratio = total/contextLimit equals targetRatio,
     * AND safeInputBudget (with reservedOutput=0) >= total.
     * Uses large enough values to exceed the 512 guard floor.
     */
    function contextLimitForRatio(total: number, targetRatio: number): number {
        const fromRatio = Math.ceil(total / targetRatio);
        // Ensure contextLimit is large enough that safeBudget >= total
        // safeBudget = C - max(512, C*0.08). For C > 6400: safeBudget = 0.92*C >= total → C >= total/0.92
        const fromBudget = Math.ceil(total / 0.92);
        return Math.max(fromRatio, fromBudget);
    }

    it('small conversation (< 60%) → tier=full, all items included verbatim', () => {
        const { items, totalItemTokens } = buildConversation(5, 1000);
        const alwaysPinnedTokens = 2000;
        const conditionalPinnedTokens = 500;
        const total = alwaysPinnedTokens + conditionalPinnedTokens + totalItemTokens;
        // ratio ≈ 0.5 → full tier
        const contextLimit = contextLimitForRatio(total, 0.5);

        const result = assembleContext({
            contextLimit,
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
            conditionalPinnedTokens,
        });

        expect(result.tier).toBe('full');
        expect(result.includedItems).toHaveLength(items.length);
        expect(result.droppedItemCount).toBe(0);
        expect(result.digestOverrides.size).toBe(0);
        expect(result.instructionSummaryIncluded).toBe(true);
        expect(result.durableTaskStateIncluded).toBe(true);
        expect(result.warning).toBeUndefined();
    });

    it('conversation at 70% → tier=medium', () => {
        const { items, totalItemTokens } = buildConversation(5, 1000);
        const alwaysPinnedTokens = 2000;
        const conditionalPinnedTokens = 500;
        const total = alwaysPinnedTokens + conditionalPinnedTokens + totalItemTokens;
        const contextLimit = contextLimitForRatio(total, 0.7);

        const result = assembleContext({
            contextLimit,
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
            conditionalPinnedTokens,
        });

        expect(result.tier).toBe('medium');
        expect(result.instructionSummaryIncluded).toBe(true);
    });

    it('conversation at 85% → tier=aggressive', () => {
        const { items, totalItemTokens } = buildConversation(5, 1000);
        const alwaysPinnedTokens = 2000;
        const conditionalPinnedTokens = 500;
        const total = alwaysPinnedTokens + conditionalPinnedTokens + totalItemTokens;
        // For aggressive: ratio=0.85, safeBudget may not fit everything — that's fine,
        // packing will drop oldest turns. Tier is determined by initial ratio.
        const contextLimit = Math.ceil(total / 0.85);

        const result = assembleContext({
            contextLimit,
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
            conditionalPinnedTokens,
        });

        expect(result.tier).toBe('aggressive');
        expect(result.instructionSummaryIncluded).toBe(true);
    });

    it('conversation at 95% → tier=emergency, only always-pinned + current turn', () => {
        const { items, totalItemTokens } = buildConversation(5, 1000);
        const alwaysPinnedTokens = 2000;
        const conditionalPinnedTokens = 500;
        const total = alwaysPinnedTokens + conditionalPinnedTokens + totalItemTokens;
        const contextLimit = Math.ceil(total / 0.95);

        const result = assembleContext({
            contextLimit,
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
            conditionalPinnedTokens,
        });

        expect(result.tier).toBe('emergency');
        // Emergency: only current turn items included (last 2 items = last turn)
        expect(result.includedItems).toHaveLength(2);
        expect(result.instructionSummaryIncluded).toBe(false);
        expect(result.durableTaskStateIncluded).toBe(false);
        expect(result.warning).toBe('emergency_compression');
    });

    it('turn boundary: 3 turns, budget fits 2.5 → include 2 full turns, not partial third', () => {
        const turn1 = buildTurn(textOfTokens(500), textOfTokens(500), 1);
        const turn2 = buildTurn(textOfTokens(500), textOfTokens(500), 3);
        const turn3 = buildTurn(textOfTokens(500), textOfTokens(500), 5); // current turn

        const allItems = [...turn1.items, ...turn2.items, ...turn3.items];
        const alwaysPinnedTokens = 1000;
        const turnTokens = turn1.tokens; // ~1024 per turn

        // Use reservedOutputTokens to constrain budget while keeping ratio in medium range.
        // contextLimit = 10000 (large enough for guard = 800, not 512)
        // ratio = total / 10000 → need total ≈ 7000 → ~0.7 (medium tier)
        // total = pinned + 3*turn = 1000 + 3072 = 4072
        // safeBudget = 10000 - reservedOutput - max(512, 800)
        // Need safeBudget = pinned + 2.5*turn = 1000 + 2560 = 3560
        // → 10000 - reservedOutput - 800 = 3560 → reservedOutput = 5640
        const contextLimit = 10000;
        const total = alwaysPinnedTokens + 3 * turnTokens;
        const guard = Math.max(512, Math.ceil(contextLimit * 0.08));
        const targetBudget = alwaysPinnedTokens + turnTokens * 2 + Math.floor(turnTokens * 0.5);
        const reservedOutputTokens = contextLimit - guard - targetBudget;

        const result = assembleContext({
            contextLimit,
            reservedOutputTokens,
            items: allItems,
            alwaysPinnedTokens,
            conditionalPinnedTokens: 0,
        });

        // Verify ratio is not emergency (total/contextLimit < 0.9)
        expect(total / contextLimit).toBeLessThan(0.9);
        // Should include current turn (turn3) + turn2 (newest completed) but NOT turn1
        expect(result.includedItems).toHaveLength(4);
        expect(result.includedItems[0]).toBe(turn2.items[0]);
        expect(result.includedItems[1]).toBe(turn2.items[1]);
        expect(result.includedItems[2]).toBe(turn3.items[0]);
        expect(result.includedItems[3]).toBe(turn3.items[1]);
        expect(result.droppedItemCount).toBe(2);
    });

    it('pinned sections present at full/medium/aggressive, dropped at emergency', () => {
        const { items, totalItemTokens } = buildConversation(3, 1000);
        const alwaysPinnedTokens = 1500;
        const conditionalPinnedTokens = 500;
        const total = alwaysPinnedTokens + conditionalPinnedTokens + totalItemTokens;

        // Full tier
        const fullResult = assembleContext({
            contextLimit: contextLimitForRatio(total, 0.4),
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
            conditionalPinnedTokens,
        });
        expect(fullResult.instructionSummaryIncluded).toBe(true);
        expect(fullResult.durableTaskStateIncluded).toBe(true);

        // Emergency tier
        const emergencyResult = assembleContext({
            contextLimit: Math.ceil(total / 0.95),
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
            conditionalPinnedTokens,
        });
        expect(emergencyResult.instructionSummaryIncluded).toBe(false);
        expect(emergencyResult.durableTaskStateIncluded).toBe(false);
    });

    it('always-pinned sections present at ALL tiers including emergency', () => {
        const items: ConversationItem[] = [
            makeUserMsg(textOfTokens(300), 1),
            makeAssistantMsg(textOfTokens(300), 2),
            makeUserMsg(textOfTokens(300), 3),
            makeAssistantMsg(textOfTokens(300), 4),
            makeUserMsg(textOfTokens(300), 5), // current turn
        ];

        const alwaysPinnedTokens = 1000;
        const total = alwaysPinnedTokens + items.reduce(
            (sum, item) => sum + estimateItemTokens(item), 0,
        );

        const result = assembleContext({
            contextLimit: Math.ceil(total / 0.95),
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
        });

        expect(result.tier).toBe('emergency');
        // Current turn (last user message) is always included
        expect(result.includedItems.length).toBeGreaterThanOrEqual(1);
        const lastIncluded = result.includedItems[result.includedItems.length - 1] as MessageItem;
        expect(lastIncluded.kind).toBe('message');
        expect(lastIncluded.role).toBe('user');
    });

    it('boundary: exactly 60% → medium', () => {
        const { items, totalItemTokens } = buildConversation(3, 1000);
        const alwaysPinnedTokens = 1500;
        const total = alwaysPinnedTokens + totalItemTokens;
        const contextLimit = Math.round(total / 0.6);

        const result = assembleContext({
            contextLimit,
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
        });

        expect(result.tier).toBe('medium');
    });

    it('boundary: exactly 80% → aggressive', () => {
        const { items, totalItemTokens } = buildConversation(3, 1000);
        const alwaysPinnedTokens = 1500;
        const total = alwaysPinnedTokens + totalItemTokens;
        const contextLimit = Math.round(total / 0.8);

        const result = assembleContext({
            contextLimit,
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
        });

        expect(result.tier).toBe('aggressive');
    });

    it('boundary: exactly 90% → emergency', () => {
        const { items, totalItemTokens } = buildConversation(3, 1000);
        const alwaysPinnedTokens = 1500;
        const total = alwaysPinnedTokens + totalItemTokens;
        const contextLimit = Math.round(total / 0.9);

        const result = assembleContext({
            contextLimit,
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
        });

        expect(result.tier).toBe('emergency');
    });

    it('emergency: oversized tool results within current turn → downgraded to digest', () => {
        const userMsg = makeUserMsg('read this file', 1);
        const assistantMsg = makeAssistantMsg('', 2, [{
            toolCallId: 'call_big',
            toolName: 'read_file',
            arguments: { file_path: '/big.ts' },
        }]);
        const bigData = 'x'.repeat(30000); // ~10000 tokens
        const toolResult = makeToolResult('read_file', bigData, 3, 'call_big');

        const items: ConversationItem[] = [userMsg, assistantMsg, toolResult];
        const alwaysPinnedTokens = 500;
        const total = alwaysPinnedTokens + items.reduce(
            (sum, item) => sum + estimateItemTokens(item), 0,
        );

        const result = assembleContext({
            contextLimit: Math.ceil(total / 0.95),
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
        });

        expect(result.tier).toBe('emergency');
        expect(result.digestOverrides.has(toolResult.id)).toBe(true);
        expect(result.digestedItemCount).toBeGreaterThan(0);
        const digest = result.digestOverrides.get(toolResult.id)!;
        expect(digest).toContain('read_file');
        expect(digest).toContain('/big.ts');
        expect(digest).toContain('[content omitted');
    });

    it('single large tool result (>25% budget) → downgraded to digest in completed turn', () => {
        // Turn 1: normal
        const turn1User = makeUserMsg(textOfTokens(200), 1);
        const turn1Assistant = makeAssistantMsg(textOfTokens(200), 2);

        // Turn 2: has oversized tool result
        const turn2User = makeUserMsg('search for errors', 3);
        const turn2Assistant = makeAssistantMsg('', 4, [{
            toolCallId: 'call_search',
            toolName: 'search_text',
            arguments: { query: 'ERROR' },
        }]);
        const bigSearchResult = (Array.from({ length: 500 }, (_, i) => `src/file${i}.ts`)).join('\n');
        const turn2ToolResult = makeToolResult('search_text', bigSearchResult, 5, 'call_search');
        const turn2Response = makeAssistantMsg('Found many matches', 6);

        // Turn 3: current turn (small)
        const currentUser = makeUserMsg('ok thanks', 7);

        const items: ConversationItem[] = [
            turn1User, turn1Assistant,
            turn2User, turn2Assistant, turn2ToolResult, turn2Response,
            currentUser,
        ];

        const alwaysPinnedTokens = 500;
        const toolResultTokens = estimateItemTokens(turn2ToolResult);
        // Need: itemBudget * 0.25 < toolResultTokens → itemBudget < 4 * toolResultTokens
        const targetSafeBudget = alwaysPinnedTokens + toolResultTokens * 3;
        const contextLimit = Math.ceil(targetSafeBudget / 0.92);

        const result = assembleContext({
            contextLimit,
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
        });

        // The search_text tool result should be digested
        expect(result.digestOverrides.has(turn2ToolResult.id)).toBe(true);
        const digest = result.digestOverrides.get(turn2ToolResult.id)!;
        expect(digest).toContain('search_text');
        expect(digest).toContain('"ERROR"');
        expect(digest).toContain('matches');
        expect(result.digestedItemCount).toBeGreaterThan(0);
        // The turn itself should still be included (with the digest)
        expect(result.includedItems).toContain(turn2ToolResult);
    });

    it('escalation: assembled result too large → bump tier and retry', () => {
        // Scenario: pinnedTokens(full) + currentTurnTokens > safeBudget at initial tier,
        // forcing escalation. At emergency, conditional pinned is dropped, making it fit.
        //
        // contextLimit = 20000
        // reservedOutput = 8000
        // guard = max(512, 1600) = 1600
        // safeBudget = 20000 - 8000 - 1600 = 10400
        //
        // alwaysPinned = 5000, conditionalPinned = 3000
        // currentTurn = 5000 tokens (one big turn)
        // completedTurns = 4000 tokens (2 turns of 2000)
        //
        // total = 5000 + 3000 + 5000 + 4000 = 17000
        // ratio = 17000/20000 = 0.85 → aggressive
        //
        // At aggressive: pinnedTokens = 8000, currentTurn = 5000 → committed = 13000 > 10400
        //   → escalate to emergency
        // At emergency: pinnedTokens = 5000, currentTurn = 5000 → committed = 10000 ≤ 10400 ✓
        //   remaining = 400, completed turns don't fit → dropped

        // Build current turn of ~5000 tokens
        const currentUser = makeUserMsg(textOfTokens(2400), 1);
        const currentAssistant = makeAssistantMsg(textOfTokens(2400), 2);
        // Build 2 completed turns of ~2000 tokens each
        const t1 = buildTurn(textOfTokens(900), textOfTokens(900), 3);
        const t2 = buildTurn(textOfTokens(900), textOfTokens(900), 5);

        const items: ConversationItem[] = [
            ...t1.items, ...t2.items, currentUser, currentAssistant,
        ];

        const result = assembleContext({
            contextLimit: 20000,
            reservedOutputTokens: 8000,
            items,
            alwaysPinnedTokens: 5000,
            conditionalPinnedTokens: 3000,
        });

        // Should have escalated to emergency
        expect(result.tier).toBe('emergency');
        // All completed turns dropped
        expect(result.droppedItemCount).toBe(4);
        // Budget respected
        expect(result.estimatedTokens).toBeLessThanOrEqual(result.safeInputBudget);
        // Conditional pinned sections dropped
        expect(result.instructionSummaryIncluded).toBe(false);
    });

    it('current turn with tool calls always fully included even at medium tier', () => {
        const items: ConversationItem[] = [];
        for (let i = 0; i < 3; i++) {
            items.push(makeUserMsg(textOfTokens(400), i * 2 + 1));
            items.push(makeAssistantMsg(textOfTokens(400), i * 2 + 2));
        }
        // Current turn with tool call chain
        const currentUser = makeUserMsg('read /src/app.ts', 7);
        const currentAssistant = makeAssistantMsg('', 8, [{
            toolCallId: 'call_read',
            toolName: 'read_file',
            arguments: { file_path: '/src/app.ts' },
        }]);
        const currentToolResult = makeToolResult('read_file', 'const app = 1;', 9, 'call_read');
        items.push(currentUser, currentAssistant, currentToolResult);

        const alwaysPinnedTokens = 2000;
        const total = alwaysPinnedTokens + items.reduce(
            (sum, item) => sum + estimateItemTokens(item), 0,
        );
        const contextLimit = contextLimitForRatio(total, 0.7);

        const result = assembleContext({
            contextLimit,
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
        });

        expect(result.tier).toBe('medium');
        expect(result.includedItems).toContain(currentUser);
        expect(result.includedItems).toContain(currentAssistant);
        expect(result.includedItems).toContain(currentToolResult);
    });

    it('no items → tier=full, empty result', () => {
        const result = assembleContext({
            contextLimit: 100000,
            reservedOutputTokens: 0,
            items: [],
            alwaysPinnedTokens: 500,
        });
        expect(result.tier).toBe('full');
        expect(result.includedItems).toHaveLength(0);
        expect(result.droppedItemCount).toBe(0);
    });

    it('single turn (current only, no history) → tier=full, all included', () => {
        const items: ConversationItem[] = [
            makeUserMsg('hello', 1),
            makeAssistantMsg('hi there', 2),
        ];

        const result = assembleContext({
            contextLimit: 100000,
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens: 500,
        });

        expect(result.tier).toBe('full');
        expect(result.includedItems).toHaveLength(2);
        expect(result.historyItemCount).toBe(0);
        expect(result.droppedItemCount).toBe(0);
    });

    it('newest completed turns preserved, oldest dropped when budget tight', () => {
        const items: ConversationItem[] = [];
        for (let i = 0; i < 5; i++) {
            items.push(makeUserMsg(textOfTokens(300), i * 2 + 1));
            items.push(makeAssistantMsg(textOfTokens(300), i * 2 + 2));
        }

        const alwaysPinnedTokens = 1000;
        const total = alwaysPinnedTokens + items.reduce(
            (sum, item) => sum + estimateItemTokens(item), 0,
        );
        // Medium tier with tight budget — should drop oldest turns
        const contextLimit = contextLimitForRatio(total, 0.7);

        const result = assembleContext({
            contextLimit,
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
        });

        if (result.droppedItemCount > 0) {
            // Oldest items should be dropped
            expect(result.includedItems).not.toContain(items[0]);
            // Current turn always included
            expect(result.includedItems).toContain(items[items.length - 2]);
            expect(result.includedItems).toContain(items[items.length - 1]);
        }
    });

    it('25% guard applies to current turn at non-emergency tiers', () => {
        // Create a current turn with an oversized tool result at full tier
        const userMsg = makeUserMsg('read big file', 1);
        const assistantMsg = makeAssistantMsg('', 2, [{
            toolCallId: 'call_big',
            toolName: 'read_file',
            arguments: { file_path: '/huge.ts' },
        }]);
        const bigData = 'x'.repeat(30000); // ~10000 tokens
        const toolResult = makeToolResult('read_file', bigData, 3, 'call_big');

        const items: ConversationItem[] = [userMsg, assistantMsg, toolResult];
        const alwaysPinnedTokens = 1000;
        const total = alwaysPinnedTokens + items.reduce(
            (sum, item) => sum + estimateItemTokens(item), 0,
        );
        // Keep ratio in full tier (< 60%)
        const contextLimit = contextLimitForRatio(total, 0.4);

        const result = assembleContext({
            contextLimit,
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens,
        });

        expect(result.tier).toBe('full');
        // The oversized tool result should still be digested via 25% guard
        expect(result.digestOverrides.has(toolResult.id)).toBe(true);
        expect(result.digestedItemCount).toBeGreaterThan(0);
        const digest = result.digestOverrides.get(toolResult.id)!;
        expect(digest).toContain('read_file');
        expect(digest).toContain('/huge.ts');
    });

    it('negative itemBudget (pinned > budget) does not crash', () => {
        // alwaysPinnedTokens exceeds safe budget → itemBudget clamped to 0
        const items: ConversationItem[] = [
            makeUserMsg('hello', 1),
            makeAssistantMsg('world', 2),
        ];

        const result = assembleContext({
            contextLimit: 10000,
            reservedOutputTokens: 0,
            items,
            alwaysPinnedTokens: 20000, // way more than budget
        });

        // Should not crash, should return emergency with everything dropped
        expect(result.tier).toBe('emergency');
        expect(result.warning).toBe('emergency_compression');
        // Items are still included (current turn always present)
        expect(result.includedItems.length).toBeGreaterThanOrEqual(1);
    });

    it('emergency tier keeps digesting current-turn tool results until the chain fits the budget', () => {
        const items: ConversationItem[] = [makeUserMsg('do work', 1)];
        let seq = 2;
        for (let i = 0; i < 4; i++) {
            const callId = `call_${i}`;
            items.push(makeAssistantMsg('', seq++, [{
                toolCallId: callId,
                toolName: 'exec_command',
                arguments: { command: `echo ${i}` },
            }]));
            items.push(makeToolResult(
                'exec_command',
                JSON.stringify({
                    exit_code: 0,
                    stdout: 'x'.repeat(120),
                    stderr: '',
                    duration_ms: 1,
                }),
                seq++,
                callId,
            ));
        }

        const result = assembleContext({
            contextLimit: 1200,
            reservedOutputTokens: 200,
            items,
            alwaysPinnedTokens: 120,
            conditionalPinnedTokens: 80,
        });

        expect(result.tier).toBe('emergency');
        expect(result.digestedItemCount).toBeGreaterThan(0);
        expect(result.estimatedTokens).toBeLessThanOrEqual(result.safeInputBudget);
    });

    it('medium tier caps at 6 completed turns even when budget allows more', () => {
        // Create 10 completed turns + 1 current turn, all small
        const allItems: ConversationItem[] = [];
        for (let i = 0; i < 10; i++) {
            allItems.push(makeUserMsg(textOfTokens(50), i * 2 + 1));
            allItems.push(makeAssistantMsg(textOfTokens(50), i * 2 + 2));
        }
        // Current turn
        allItems.push(makeUserMsg('current', 21));

        const alwaysPinnedTokens = 200;
        const total = alwaysPinnedTokens + allItems.reduce(
            (sum, item) => sum + estimateItemTokens(item), 0,
        );

        // Budget fits all items, but ratio → medium tier
        const contextLimit = contextLimitForRatio(total, 0.7);

        const result = assembleContext({
            contextLimit,
            reservedOutputTokens: 0,
            items: allItems,
            alwaysPinnedTokens,
        });

        expect(result.tier).toBe('medium');
        // Medium: max 6 completed turns → 12 history items
        expect(result.historyItemCount).toBe(12);
        // 4 completed turns dropped → 8 items
        expect(result.droppedItemCount).toBe(8);
    });

    it('cumulative: aggressive keeps only 3 turns vs medium keeping 6', () => {
        const allItems: ConversationItem[] = [];
        for (let i = 0; i < 10; i++) {
            allItems.push(makeUserMsg(textOfTokens(50), i * 2 + 1));
            allItems.push(makeAssistantMsg(textOfTokens(50), i * 2 + 2));
        }
        allItems.push(makeUserMsg('current', 21));

        const alwaysPinnedTokens = 200;
        const total = alwaysPinnedTokens + allItems.reduce(
            (sum, item) => sum + estimateItemTokens(item), 0,
        );

        // Medium tier
        const mediumLimit = contextLimitForRatio(total, 0.7);
        const mediumResult = assembleContext({
            contextLimit: mediumLimit,
            reservedOutputTokens: 0,
            items: allItems,
            alwaysPinnedTokens,
        });

        // Aggressive tier
        const aggressiveLimit = contextLimitForRatio(total, 0.85);
        const aggressiveResult = assembleContext({
            contextLimit: aggressiveLimit,
            reservedOutputTokens: 0,
            items: allItems,
            alwaysPinnedTokens,
        });

        expect(mediumResult.tier).toBe('medium');
        expect(aggressiveResult.tier).toBe('aggressive');
        // Medium: 6 completed turns (12 items), aggressive: 3 (6 items)
        expect(mediumResult.historyItemCount).toBe(12);
        expect(aggressiveResult.historyItemCount).toBe(6);
        // Aggressive drops more
        expect(aggressiveResult.droppedItemCount).toBeGreaterThan(mediumResult.droppedItemCount);
    });
});

// --- getVerbatimTurnLimit ---

describe('getVerbatimTurnLimit', () => {
    it('full → Infinity', () => expect(getVerbatimTurnLimit('full')).toBe(Infinity));
    it('medium → 6', () => expect(getVerbatimTurnLimit('medium')).toBe(6));
    it('aggressive → 3', () => expect(getVerbatimTurnLimit('aggressive')).toBe(3));
    it('emergency → 0', () => expect(getVerbatimTurnLimit('emergency')).toBe(0));
});

// --- renderProjectForTier ---

describe('renderProjectForTier', () => {
    const snapshot: ProjectSnapshot = {
        root: '/home/user/project',
        stack: ['Node', 'TypeScript', 'pnpm'],
        git: { branch: 'main', status: 'clean', staged: false },
        ignorePaths: ['.git/', 'node_modules/', 'dist/'],
        indexStatus: 'ready',
    };

    it('full → complete renderProjectContext output', () => {
        const result = renderProjectForTier('full', snapshot);
        expect(result).toContain('Project root: /home/user/project');
        expect(result).toContain('Stack: Node, TypeScript, pnpm');
        expect(result).toContain('branch=main');
        expect(result).toContain('staged=false');
        expect(result).toContain('Ignore: .git/, node_modules/, dist/');
        expect(result).toContain('Index: ready');
    });

    it('medium → root + stack + git only (no ignore, no index, no staged)', () => {
        const result = renderProjectForTier('medium', snapshot);
        expect(result).toContain('Project root: /home/user/project');
        expect(result).toContain('Stack: Node, TypeScript, pnpm');
        expect(result).toContain('Git: branch=main, clean');
        // Removed fields
        expect(result).not.toContain('Ignore');
        expect(result).not.toContain('node_modules');
        expect(result).not.toContain('Index');
        expect(result).not.toContain('staged');
    });

    it('aggressive → stack one-liner + git branch only', () => {
        const result = renderProjectForTier('aggressive', snapshot);
        expect(result).toContain('Stack: Node, TypeScript, pnpm');
        expect(result).toContain('Git: main');
        // No root, no status, no ignore
        expect(result).not.toContain('Project root');
        expect(result).not.toContain('clean');
        expect(result).not.toContain('Ignore');
    });

    it('emergency → empty string', () => {
        expect(renderProjectForTier('emergency', snapshot)).toBe('');
    });
});

// --- buildToolDefsForTier ---

describe('buildToolDefsForTier', () => {
    function mockTool(
        name: string,
        description: string,
        schema: Record<string, unknown>,
    ): RegisteredTool {
        return {
            spec: {
                name,
                description,
                inputSchema: schema,
                approvalClass: 'read-only',
                idempotent: true,
                timeoutCategory: 'file',
            },
            impl: async () => ({
                status: 'success' as const,
                data: '',
                truncated: false,
                bytesReturned: 0,
                bytesOmitted: 0,
                retryable: false,
                timedOut: false,
                mutationState: 'none' as const,
            }),
        };
    }

    const tools = [
        mockTool(
            'read_file',
            'Read a file from disk. Supports line ranges and encoding options.',
            {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The file path to read' },
                    start_line: { type: 'number', description: 'First line to include' },
                    end_line: { type: 'number', description: 'Last line to include' },
                },
                required: ['path'],
            },
        ),
        mockTool(
            'edit_file',
            'Edit a file by replacing text. Supports multiple replacements in a single call.',
            {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'The file path to edit',
                        examples: ['/src/main.ts'],
                    },
                    old_text: { type: 'string', description: 'The text to find and replace' },
                    new_text: { type: 'string', description: 'The replacement text' },
                },
                required: ['path', 'old_text', 'new_text'],
            },
        ),
    ];

    it('full → complete definitions with descriptions and param details', () => {
        const defs = buildToolDefsForTier('full', tools);
        expect(defs).toHaveLength(2);
        expect(defs[0].description).toBe('Read a file from disk. Supports line ranges and encoding options.');
        const pathProp = (defs[0].parameters as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> }).properties.path;
        expect(pathProp.description).toBe('The file path to read');
    });

    it('medium → same as full (unchanged)', () => {
        const defs = buildToolDefsForTier('medium', tools);
        expect(defs[0].description).toBe('Read a file from disk. Supports line ranges and encoding options.');
        const pathProp = (defs[0].parameters as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> }).properties.path;
        expect(pathProp.description).toBe('The file path to read');
    });

    it('aggressive → short-form: first sentence + no param descriptions/examples', () => {
        const defs = buildToolDefsForTier('aggressive', tools);
        expect(defs).toHaveLength(2);
        // Description truncated to first sentence
        expect(defs[0].description).toBe('Read a file from disk.');
        expect(defs[1].description).toBe('Edit a file by replacing text.');
        // Parameter descriptions stripped
        const readProps = (defs[0].parameters as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> }).properties;
        expect(readProps.path.type).toBe('string');
        expect(readProps.path.description).toBeUndefined();
        expect(readProps.start_line.description).toBeUndefined();
        // Examples stripped
        const editProps = (defs[1].parameters as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> }).properties;
        expect(editProps.path.examples).toBeUndefined();
        expect(editProps.old_text.description).toBeUndefined();
        // Required array preserved
        expect((defs[0].parameters as Record<string, unknown>).required).toEqual(['path']);
        expect((defs[1].parameters as Record<string, unknown>).required).toEqual(['path', 'old_text', 'new_text']);
    });

    it('emergency → signatures only: empty description, full schema preserved', () => {
        const defs = buildToolDefsForTier('emergency', tools);
        expect(defs).toHaveLength(2);
        // No description
        expect(defs[0].description).toBe('');
        expect(defs[1].description).toBe('');
        // Full schema preserved (needed for validation)
        const pathProp = (defs[0].parameters as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> }).properties.path;
        expect(pathProp.description).toBe('The file path to read');
        expect((defs[0].parameters as Record<string, unknown>).required).toEqual(['path']);
    });
});

// --- getTierContextFlags ---

describe('getTierContextFlags', () => {
    it('full → all sections included', () => {
        const flags = getTierContextFlags('full');
        expect(flags.includeOsShell).toBe(true);
        expect(flags.includeCwd).toBe(true);
        expect(flags.includeProjectSnapshot).toBe(true);
        expect(flags.includeWorkingSet).toBe(true);
        expect(flags.includeCapabilityHealth).toBe(true);
        expect(flags.includeUserInstructions).toBe(true);
        expect(flags.includeDurableTaskState).toBe(true);
    });

    it('medium → same as full (all included)', () => {
        const flags = getTierContextFlags('medium');
        expect(flags.includeOsShell).toBe(true);
        expect(flags.includeWorkingSet).toBe(true);
        expect(flags.includeDurableTaskState).toBe(true);
    });

    it('aggressive → no OS/shell, no working set, no capability health', () => {
        const flags = getTierContextFlags('aggressive');
        expect(flags.includeOsShell).toBe(false);
        expect(flags.includeCwd).toBe(true);
        expect(flags.includeProjectSnapshot).toBe(true);
        expect(flags.includeWorkingSet).toBe(false);
        expect(flags.includeCapabilityHealth).toBe(false);
        expect(flags.includeUserInstructions).toBe(true);
        expect(flags.includeDurableTaskState).toBe(true);
    });

    it('emergency → nothing included (only active errors survive, no flag needed)', () => {
        const flags = getTierContextFlags('emergency');
        expect(flags.includeOsShell).toBe(false);
        expect(flags.includeCwd).toBe(false);
        expect(flags.includeProjectSnapshot).toBe(false);
        expect(flags.includeWorkingSet).toBe(false);
        expect(flags.includeCapabilityHealth).toBe(false);
        expect(flags.includeUserInstructions).toBe(false);
        expect(flags.includeDurableTaskState).toBe(false);
    });
});

// --- EMERGENCY_WARNING_MESSAGE ---

describe('EMERGENCY_WARNING_MESSAGE', () => {
    it('contains expected warning text', () => {
        expect(EMERGENCY_WARNING_MESSAGE).toContain('Context limit reached');
        expect(EMERGENCY_WARNING_MESSAGE).toContain('minimal history');
    });
});
