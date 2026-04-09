import { describe, it, expect, beforeEach } from 'vitest';
import type { MessageItem, ToolResultItem, ConversationItem } from '../../src/types/conversation.js';
import type { ToolCallId, ItemId, TurnId, SessionId } from '../../src/types/ids.js';
import type { TurnRecord } from '../../src/types/session.js';
import {
    FileActivityIndex,
    getActiveOpenLoopFiles,
} from '../../src/core/file-activity-index.js';
import type { DurableTaskState } from '../../src/core/durable-task-state.js';

// --- Test helpers ---

let seqCounter = 0;

function resetSeq(): void {
    seqCounter = 0;
}

function nextId(prefix: string): string {
    return `${prefix}_test${++seqCounter}`;
}

function makeUserMsg(text: string, seq?: number): MessageItem {
    const s = seq ?? ++seqCounter;
    return {
        kind: 'message',
        id: nextId('itm') as ItemId,
        seq: s,
        role: 'user',
        parts: [{ type: 'text', text }],
        timestamp: '2026-01-01T00:00:00Z',
    };
}

function makeAssistantToolCall(
    toolCallId: ToolCallId,
    toolName: string,
    args: Record<string, unknown>,
    seq?: number,
): MessageItem {
    const s = seq ?? ++seqCounter;
    return {
        kind: 'message',
        id: nextId('itm') as ItemId,
        seq: s,
        role: 'assistant',
        parts: [{ type: 'tool_call', toolCallId, toolName, arguments: args }],
        timestamp: '2026-01-01T00:00:00Z',
    };
}

function makeToolResult(
    toolCallId: ToolCallId,
    toolName: string,
    status: 'success' | 'error',
    data: string,
    seq?: number,
): ToolResultItem {
    const s = seq ?? ++seqCounter;
    return {
        kind: 'tool_result',
        id: nextId('itm') as ItemId,
        seq: s,
        toolCallId,
        toolName,
        output: {
            status,
            data,
            truncated: false,
            bytesReturned: data.length,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        },
        timestamp: '2026-01-01T00:00:00Z',
    };
}

/** Create a turn with a single tool call + result. */
function makeToolTurn(
    toolName: string,
    args: Record<string, unknown>,
    data: string,
    status: 'success' | 'error' = 'success',
): ConversationItem[] {
    const callId = nextId('call') as ToolCallId;
    return [
        makeAssistantToolCall(callId, toolName, args),
        makeToolResult(callId, toolName, status, data),
    ];
}

/** Create an empty turn (user message only, no tool calls). */
function makeIdleTurn(text = 'ok'): ConversationItem[] {
    return [makeUserMsg(text)];
}

function makeTurnRecord(turnNumber: number, seqStart: number, seqEnd: number): TurnRecord {
    return {
        id: `trn_test${turnNumber}` as TurnId,
        sessionId: 'ses_test' as SessionId,
        turnNumber,
        status: 'completed',
        itemSeqStart: seqStart,
        itemSeqEnd: seqEnd,
        steps: [],
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
    };
}

// --- Tests ---

describe('FileActivityIndex', () => {
    let index: FileActivityIndex;

    beforeEach(() => {
        resetSeq();
        index = new FileActivityIndex();
    });

    describe('scoring weights', () => {
        it('edit_file on a.ts → score = 30', () => {
            const items = makeToolTurn('edit_file', { path: 'a.ts' }, 'ok');
            index.processTurn(items);
            expect(index.getEntry('a.ts')?.score).toBe(30);
        });

        it('write_file on b.ts → score = 30', () => {
            const items = makeToolTurn('write_file', { path: 'b.ts', content: '...' }, 'ok');
            index.processTurn(items);
            expect(index.getEntry('b.ts')?.score).toBe(30);
        });

        it('delete_path on c.ts → score = 35', () => {
            const items = makeToolTurn('delete_path', { path: 'c.ts' }, 'ok');
            index.processTurn(items);
            expect(index.getEntry('c.ts')?.score).toBe(35);
        });

        it('move_path scores both source and destination at +35', () => {
            const items = makeToolTurn('move_path', { source: 'old.ts', destination: 'new.ts' }, 'ok');
            index.processTurn(items);
            expect(index.getEntry('old.ts')?.score).toBe(35);
            expect(index.getEntry('new.ts')?.score).toBe(35);
        });

        it('read_file on d.ts → score = 10', () => {
            const items = makeToolTurn('read_file', { path: 'd.ts' }, 'file contents');
            index.processTurn(items);
            expect(index.getEntry('d.ts')?.score).toBe(10);
        });

        it('search_text with matched files → +5 per unique file', () => {
            const data = JSON.stringify({
                matches: [
                    { file: '/src/a.ts', line: 1, content: 'foo' },
                    { file: '/src/a.ts', line: 5, content: 'foo again' },
                    { file: '/src/b.ts', line: 2, content: 'foo' },
                ],
            });
            const items = makeToolTurn('search_text', { root: '/src', pattern: 'foo' }, data);
            index.processTurn(items);
            expect(index.getEntry('/src/a.ts')?.score).toBe(5);
            expect(index.getEntry('/src/b.ts')?.score).toBe(5);
        });

        it('user mention of file path → +25', () => {
            const items = [makeUserMsg('please check src/utils/helper.ts')];
            index.processTurn(items);
            expect(index.getEntry('src/utils/helper.ts')?.score).toBe(25);
        });
    });

    describe('score accumulation', () => {
        it('read_file then edit_file on same file → score = 40', () => {
            // Both in same turn
            const callId1 = nextId('call') as ToolCallId;
            const callId2 = nextId('call') as ToolCallId;
            const items: ConversationItem[] = [
                makeAssistantToolCall(callId1, 'read_file', { path: 'a.ts' }),
                makeToolResult(callId1, 'read_file', 'success', 'contents'),
                makeAssistantToolCall(callId2, 'edit_file', { path: 'a.ts' }),
                makeToolResult(callId2, 'edit_file', 'success', 'ok'),
            ];
            index.processTurn(items);
            expect(index.getEntry('a.ts')?.score).toBe(40);
        });

        it('accumulates across turns', () => {
            const turn1 = makeToolTurn('read_file', { path: 'a.ts' }, 'contents');
            index.processTurn(turn1);
            expect(index.getEntry('a.ts')?.score).toBe(10);

            const turn2 = makeToolTurn('edit_file', { path: 'a.ts' }, 'ok');
            index.processTurn(turn2);
            // 10 (from read) + 30 (from edit) = 40, no decay because file was touched
            expect(index.getEntry('a.ts')?.score).toBe(40);
        });

        it('normalizes absolute search results and relative tool args to one workspace file key', () => {
            index = new FileActivityIndex(undefined, '/repo');

            const searchTurn = makeToolTurn('search_text', { root: '/repo/src', pattern: 'foo' }, JSON.stringify({
                matches: [
                    { file: '/repo/src/a.ts', line: 1, content: 'foo' },
                    { file: '/repo/src/a.ts', line: 2, content: 'foo again' },
                ],
                truncated: false,
            }));
            index.processTurn(searchTurn);

            const readTurn = makeToolTurn('read_file', { path: 'src/a.ts' }, 'contents');
            index.processTurn(readTurn);

            expect(index.getEntry('src/a.ts')?.score).toBe(15);
            expect(index.getEntry('/repo/src/a.ts')).toBeUndefined();
        });
    });

    describe('decay', () => {
        it('subtracts 5 per inactive turn', () => {
            const turn1 = makeToolTurn('edit_file', { path: 'a.ts' }, 'ok');
            index.processTurn(turn1);
            expect(index.getEntry('a.ts')?.score).toBe(30);

            // 2 idle turns
            index.processTurn(makeIdleTurn());
            expect(index.getEntry('a.ts')?.score).toBe(25);
            expect(index.getEntry('a.ts')?.turnsSinceLastTouch).toBe(1);

            index.processTurn(makeIdleTurn());
            expect(index.getEntry('a.ts')?.score).toBe(20);
            expect(index.getEntry('a.ts')?.turnsSinceLastTouch).toBe(2);
        });

        it('8 consecutive inactive turns → score drops by 40, file removed', () => {
            const turn1 = makeToolTurn('edit_file', { path: 'a.ts' }, 'ok');
            index.processTurn(turn1);
            expect(index.getEntry('a.ts')?.score).toBe(30);

            for (let i = 0; i < 8; i++) {
                index.processTurn(makeIdleTurn());
            }

            // turnsSinceLastTouch = 8 → evicted
            expect(index.getEntry('a.ts')).toBeUndefined();
            expect(index.size).toBe(0);
        });

        it('decay reset: edit turn 1, idle 2-5, read turn 6', () => {
            // Turn 1: edit → score=30, turnsSince=0
            index.processTurn(makeToolTurn('edit_file', { path: 'a.ts' }, 'ok'));
            expect(index.getEntry('a.ts')?.score).toBe(30);

            // Turns 2-5: idle (4 turns) → score drops by 20 → score=10
            for (let i = 0; i < 4; i++) {
                index.processTurn(makeIdleTurn());
            }
            expect(index.getEntry('a.ts')?.score).toBe(10);
            expect(index.getEntry('a.ts')?.turnsSinceLastTouch).toBe(4);

            // Turn 6: read → turnsSince resets, score += 10 → score=20
            index.processTurn(makeToolTurn('read_file', { path: 'a.ts' }, 'contents'));
            expect(index.getEntry('a.ts')?.score).toBe(20);
            expect(index.getEntry('a.ts')?.turnsSinceLastTouch).toBe(0);
        });
    });

    describe('open-loop exemption', () => {
        it('file in active open loop is NOT removed after 8 idle turns', () => {
            index.processTurn(makeToolTurn('edit_file', { path: 'a.ts' }, 'ok'));

            const openLoopFiles = new Set(['a.ts']);

            for (let i = 0; i < 8; i++) {
                index.processTurn(makeIdleTurn(), openLoopFiles);
            }

            // File survives eviction due to open-loop exemption
            expect(index.getEntry('a.ts')).toBeDefined();
            expect(index.getEntry('a.ts')!.turnsSinceLastTouch).toBe(8);
            // Score has decayed but floored at 0: max(0, 30 - 40) = 0
            expect(index.getEntry('a.ts')!.score).toBe(0);
        });

        it('file NOT in open loop IS removed after 8 idle turns', () => {
            index.processTurn(makeToolTurn('edit_file', { path: 'a.ts' }, 'ok'));
            index.processTurn(makeToolTurn('edit_file', { path: 'b.ts' }, 'ok'));

            const openLoopFiles = new Set(['a.ts']); // only a.ts is exempt

            for (let i = 0; i < 8; i++) {
                index.processTurn(makeIdleTurn(), openLoopFiles);
            }

            expect(index.getEntry('a.ts')).toBeDefined(); // exempt
            expect(index.getEntry('b.ts')).toBeUndefined(); // evicted
        });
    });

    describe('top files and rendering', () => {
        it('top 5: 7 files across turns → only top 5 with positive scores appear', () => {
            // Each file in its own turn → earlier files decay (floored at 0).
            // Turn 1: f1 edit=30
            // Turn 2: f1=max(0,30-5)=25, f2=30
            // Turn 3: f1=20, f2=25, f3=35
            // Turn 4: f1=15, f2=20, f3=30, f4=10
            // Turn 5: f1=10, f2=15, f3=25, f4=5, f5=10
            // Turn 6: f1=5, f2=10, f3=20, f4=0, f5=5, f6=10
            // Turn 7: f1=0, f2=5, f3=15, f4=0, f5=0, f6=5, f7=10
            // Positive scores: f2(5), f3(15), f6(5), f7(10)
            const files = ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts', 'f6.ts', 'f7.ts'];
            const tools = ['edit_file', 'write_file', 'delete_path', 'read_file', 'read_file', 'read_file', 'read_file'];

            for (let i = 0; i < files.length; i++) {
                const items = makeToolTurn(tools[i], { path: files[i] }, 'ok');
                index.processTurn(items);
            }

            const top = index.getTopFiles();
            // Only files with positive scores appear (f2, f3, f6, f7)
            expect(top).toHaveLength(4);
            for (const f of top) {
                expect(f.score).toBeGreaterThan(0);
            }
            // f3 (delete=35, decayed 4 turns → 15) should be highest
            expect(top[0].path).toBe('f3.ts');
            expect(top[0].score).toBe(15);
        });

        it('top 5: 7 files in one turn → only top 5 appear', () => {
            // All files in a single turn
            const items: ConversationItem[] = [];
            const toolFiles = [
                { name: 'f1.ts', tool: 'delete_path', score: 35 },
                { name: 'f2.ts', tool: 'edit_file', score: 30 },
                { name: 'f3.ts', tool: 'write_file', score: 30 },
                { name: 'f4.ts', tool: 'edit_file', score: 30 },
                { name: 'f5.ts', tool: 'read_file', score: 10 },
                { name: 'f6.ts', tool: 'read_file', score: 10 },
                { name: 'f7.ts', tool: 'read_file', score: 10 },
            ];

            for (const f of toolFiles) {
                const callId = nextId('call') as ToolCallId;
                items.push(makeAssistantToolCall(callId, f.tool, { path: f.name }));
                items.push(makeToolResult(callId, f.tool, 'success', 'ok'));
            }

            index.processTurn(items);

            expect(index.size).toBe(7);
            const top = index.getTopFiles(5);
            expect(top).toHaveLength(5);

            // Top should be f1 (35), then f2, f3, f4 (30 each), then one of f5/f6/f7 (10)
            expect(top[0].score).toBe(35);
            expect(top[1].score).toBe(30);
            expect(top[4].score).toBe(10);
        });

        it('renderWorkingSet includes path and role', () => {
            const items = makeToolTurn('edit_file', { path: 'src/foo.ts' }, 'ok');
            index.processTurn(items);

            const rendered = index.renderWorkingSet();
            expect(rendered).toContain('src/foo.ts');
            expect(rendered).toContain('(editing)');
            expect(rendered).toMatch(/^Active files:/);
        });

        it('renderWorkingSet returns empty string when no active files', () => {
            expect(index.renderWorkingSet()).toBe('');
        });
    });

    describe('failed tool calls', () => {
        it('failed tool call does not score the file', () => {
            const items = makeToolTurn('edit_file', { path: 'a.ts' }, 'permission denied', 'error');
            index.processTurn(items);
            expect(index.getEntry('a.ts')).toBeUndefined();
        });
    });

    describe('serialization', () => {
        it('serialize → deserialize round-trip preserves state', () => {
            index.processTurn(makeToolTurn('edit_file', { path: 'a.ts' }, 'ok'));
            index.processTurn(makeToolTurn('read_file', { path: 'b.ts' }, 'contents'));

            const serialized = index.serialize();
            const restored = new FileActivityIndex(serialized);

            expect(restored.getEntry('a.ts')?.score).toBe(index.getEntry('a.ts')?.score);
            expect(restored.getEntry('b.ts')?.score).toBe(index.getEntry('b.ts')?.score);
            expect(restored.size).toBe(index.size);
        });

        it('constructor with null serialized creates empty index', () => {
            const empty = new FileActivityIndex(null);
            expect(empty.size).toBe(0);
        });
    });

    describe('rebuildFromLog', () => {
        it('rebuild produces same scores as live tracking', () => {
            // Build a sequence of turns with items and turn records
            resetSeq();
            const allItems: ConversationItem[] = [];
            const turns: TurnRecord[] = [];

            // Turn 1: edit a.ts (seqs 1-2)
            const turn1Items = makeToolTurn('edit_file', { path: 'a.ts' }, 'ok');
            allItems.push(...turn1Items);
            turns.push(makeTurnRecord(1, turn1Items[0].seq, turn1Items[turn1Items.length - 1].seq));

            // Turn 2: read b.ts (seqs 3-4)
            const turn2Items = makeToolTurn('read_file', { path: 'b.ts' }, 'contents');
            allItems.push(...turn2Items);
            turns.push(makeTurnRecord(2, turn2Items[0].seq, turn2Items[turn2Items.length - 1].seq));

            // Turn 3: edit a.ts again (seqs 5-6)
            const turn3Items = makeToolTurn('edit_file', { path: 'a.ts' }, 'ok');
            allItems.push(...turn3Items);
            turns.push(makeTurnRecord(3, turn3Items[0].seq, turn3Items[turn3Items.length - 1].seq));

            // Rebuild from log
            const rebuilt = FileActivityIndex.rebuildFromLog(allItems, turns);

            // Also compute live
            resetSeq();
            const live = new FileActivityIndex();
            const liveTurn1 = makeToolTurn('edit_file', { path: 'a.ts' }, 'ok');
            live.processTurn(liveTurn1);
            const liveTurn2 = makeToolTurn('read_file', { path: 'b.ts' }, 'contents');
            live.processTurn(liveTurn2);
            const liveTurn3 = makeToolTurn('edit_file', { path: 'a.ts' }, 'ok');
            live.processTurn(liveTurn3);

            // Compare
            expect(rebuilt.getEntry('a.ts')?.score).toBe(live.getEntry('a.ts')?.score);
            expect(rebuilt.getEntry('b.ts')?.score).toBe(live.getEntry('b.ts')?.score);
            expect(rebuilt.size).toBe(live.size);
        });

        it('rebuild skips active (incomplete) turns', () => {
            resetSeq();
            const items = makeToolTurn('edit_file', { path: 'a.ts' }, 'ok');
            const turns: TurnRecord[] = [{
                id: 'trn_test1' as TurnId,
                sessionId: 'ses_test' as SessionId,
                turnNumber: 1,
                status: 'active', // not completed
                itemSeqStart: items[0].seq,
                itemSeqEnd: items[items.length - 1].seq,
                steps: [],
                startedAt: '2026-01-01T00:00:00Z',
            }];

            const rebuilt = FileActivityIndex.rebuildFromLog(items, turns);
            expect(rebuilt.size).toBe(0); // active turn skipped
        });
    });

    describe('roles', () => {
        it('tracks most recent tool role per file', () => {
            const callId1 = nextId('call') as ToolCallId;
            const callId2 = nextId('call') as ToolCallId;
            const items: ConversationItem[] = [
                makeAssistantToolCall(callId1, 'read_file', { path: 'a.ts' }),
                makeToolResult(callId1, 'read_file', 'success', 'contents'),
                makeAssistantToolCall(callId2, 'edit_file', { path: 'a.ts' }),
                makeToolResult(callId2, 'edit_file', 'success', 'ok'),
            ];
            index.processTurn(items);
            expect(index.getEntry('a.ts')?.role).toBe('editing');
        });

        it('user mention sets role to "mentioned" when no tool touch', () => {
            const items = [makeUserMsg('check src/core/foo.ts please')];
            index.processTurn(items);
            expect(index.getEntry('src/core/foo.ts')?.role).toBe('mentioned');
        });

        it('duplicate user mentions of same file score only once per turn', () => {
            const items = [makeUserMsg('compare src/core/foo.ts with src/core/foo.ts')];
            index.processTurn(items);
            // Deduplicated: +25 once, not +50
            expect(index.getEntry('src/core/foo.ts')?.score).toBe(25);
        });
    });

    describe('getActiveOpenLoopFiles', () => {
        it('returns files from active (non-done) open loops', () => {
            const state: DurableTaskState = {
                goal: 'test',
                constraints: [],
                confirmedFacts: [],
                decisions: [],
                openLoops: [
                    { id: 'l1', text: 'fix a.ts', status: 'open', files: ['a.ts', 'b.ts'] },
                    { id: 'l2', text: 'done thing', status: 'done', files: ['c.ts'] },
                    { id: 'l3', text: 'blocked', status: 'blocked', files: ['d.ts'] },
                ],
                blockers: [],
                filesOfInterest: [],
                revision: 1,
                stale: false,
            };

            const files = getActiveOpenLoopFiles(state);
            expect(files).toContain('a.ts');
            expect(files).toContain('b.ts');
            expect(files).not.toContain('c.ts'); // done loop
            expect(files).toContain('d.ts'); // blocked is active
        });

        it('returns empty set for null state', () => {
            expect(getActiveOpenLoopFiles(null).size).toBe(0);
        });
    });
});
