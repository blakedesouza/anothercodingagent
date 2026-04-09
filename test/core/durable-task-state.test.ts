import { describe, it, expect, vi } from 'vitest';
import type { MessageItem, ToolResultItem } from '../../src/types/conversation.js';
import type { ToolCallId, ItemId } from '../../src/types/ids.js';
import type { ProviderDriver } from '../../src/types/provider.js';
import {
    createInitialDurableTaskState,
    extractTurnFacts,
    applyDeterministicUpdates,
    applyLlmPatch,
    updateDurableTaskState,
    renderDurableTaskState,
} from '../../src/core/durable-task-state.js';
import type {
    DurableTaskState,
    DurableStatePatch,
    TurnFacts,
} from '../../src/core/durable-task-state.js';

// --- Test helpers ---

let seqCounter = 0;

function nextId(prefix: string): string {
    return `${prefix}_test${++seqCounter}` as string;
}

function makeUserMsg(text: string, seq = seqCounter + 1): MessageItem {
    seqCounter = seq;
    return {
        kind: 'message',
        id: nextId('itm') as ItemId,
        seq,
        role: 'user',
        parts: [{ type: 'text', text }],
        timestamp: '2026-01-01T00:00:00Z',
    };
}

function makeAssistantMsgWithToolCall(
    toolCallId: ToolCallId,
    toolName: string,
    args: Record<string, unknown>,
    seq = seqCounter + 1,
): MessageItem {
    seqCounter = seq;
    return {
        kind: 'message',
        id: nextId('itm') as ItemId,
        seq,
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
    extras: Partial<{
        errorCode: string;
        errorMessage: string;
        yieldOutcome: 'awaiting_user' | 'approval_required';
    }> = {},
    seq = seqCounter + 1,
): ToolResultItem {
    seqCounter = seq;
    return {
        kind: 'tool_result',
        id: nextId('itm') as ItemId,
        seq,
        toolCallId,
        toolName,
        output: {
            status,
            data,
            error: extras.errorCode
                ? { code: extras.errorCode, message: extras.errorMessage ?? data, retryable: false }
                : undefined,
            truncated: false,
            bytesReturned: data.length,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
            yieldOutcome: extras.yieldOutcome,
        },
        timestamp: '2026-01-01T00:00:00Z',
    };
}

// --- Tests ---

describe('createInitialDurableTaskState', () => {
    it('returns state with all fields at initial values', () => {
        const state = createInitialDurableTaskState();
        expect(state.goal).toBeNull();
        expect(state.constraints).toEqual([]);
        expect(state.confirmedFacts).toEqual([]);
        expect(state.decisions).toEqual([]);
        expect(state.openLoops).toEqual([]);
        expect(state.blockers).toEqual([]);
        expect(state.filesOfInterest).toEqual([]);
        expect(state.revision).toBe(0);
        expect(state.stale).toBe(false);
    });
});

describe('extractTurnFacts', () => {
    it('extracts modified file from successful write_file tool call', () => {
        const callId = 'call_write1' as ToolCallId;
        const items = [
            makeAssistantMsgWithToolCall(callId, 'write_file', { path: 'src/foo.ts', content: 'export {}' }),
            makeToolResult(callId, 'write_file', 'success', 'Written 10 bytes'),
        ];
        const facts = extractTurnFacts(items);
        expect(facts.modifiedFiles).toContain('src/foo.ts');
        expect(facts.toolErrors).toHaveLength(0);
    });

    it('extracts modified file from successful edit_file tool call', () => {
        const callId = 'call_edit1' as ToolCallId;
        const items = [
            makeAssistantMsgWithToolCall(callId, 'edit_file', { path: 'src/bar.ts', edits: [] }),
            makeToolResult(callId, 'edit_file', 'success', 'Edited'),
        ];
        const facts = extractTurnFacts(items);
        expect(facts.modifiedFiles).toContain('src/bar.ts');
    });

    it('extracts both source and destination from move_path', () => {
        const callId = 'call_move1' as ToolCallId;
        const items = [
            makeAssistantMsgWithToolCall(callId, 'move_path', { source: 'old/a.ts', destination: 'new/a.ts' }),
            makeToolResult(callId, 'move_path', 'success', 'Moved'),
        ];
        const facts = extractTurnFacts(items);
        expect(facts.modifiedFiles).toContain('old/a.ts');
        expect(facts.modifiedFiles).toContain('new/a.ts');
    });

    it('does not add file from failed file tool call', () => {
        const callId = 'call_writefail' as ToolCallId;
        const items = [
            makeAssistantMsgWithToolCall(callId, 'write_file', { path: 'src/missing.ts', content: '' }),
            makeToolResult(callId, 'write_file', 'error', 'permission denied', {
                errorCode: 'fs.permission_denied',
                errorMessage: 'permission denied',
            }),
        ];
        const facts = extractTurnFacts(items);
        expect(facts.modifiedFiles).not.toContain('src/missing.ts');
        expect(facts.toolErrors).toHaveLength(1);
        expect(facts.toolErrors[0].toolName).toBe('write_file');
        expect(facts.toolErrors[0].filePath).toBe('src/missing.ts');
    });

    it('extracts tool error from exec_command failure', () => {
        const callId = 'call_exec1' as ToolCallId;
        const items = [
            makeAssistantMsgWithToolCall(callId, 'exec_command', { command: 'npm test' }),
            makeToolResult(callId, 'exec_command', 'error', 'exit code 1', {
                errorCode: 'exec.nonzero_exit',
                errorMessage: 'Command failed with exit code 1',
            }),
        ];
        const facts = extractTurnFacts(items);
        expect(facts.toolErrors).toHaveLength(1);
        expect(facts.toolErrors[0].toolName).toBe('exec_command');
        expect(facts.toolErrors[0].errorSummary).toContain('Command failed');
        expect(facts.toolErrors[0].filePath).toBeUndefined();
    });

    it('ignores deferred overflow tool results when extracting durable errors', () => {
        const callId = 'call_deferred1' as ToolCallId;
        const items = [
            makeAssistantMsgWithToolCall(callId, 'fetch_mediawiki_page', { api_url: 'https://example.test/api.php', page: 'Alpha' }),
            makeToolResult(callId, 'fetch_mediawiki_page', 'error', '', {
                errorCode: 'tool.deferred',
                errorMessage: 'Tool call deferred: max 10 calls per message.',
            }),
        ];
        const facts = extractTurnFacts(items);
        expect(facts.toolErrors).toHaveLength(0);
    });

    it('ignores read_file validation errors for files written earlier in the same turn', () => {
        const writeCallId = 'call_write_selfcheck' as ToolCallId;
        const readCallId = 'call_read_selfcheck' as ToolCallId;
        const items = [
            makeAssistantMsgWithToolCall(writeCallId, 'write_file', { path: 'world/characters/lilith-asami.md', content: '# Lilith\n' }),
            makeToolResult(writeCallId, 'write_file', 'success', 'Written 9 bytes'),
            makeAssistantMsgWithToolCall(readCallId, 'read_file', {
                path: 'world/characters/lilith-asami.md',
                line_start: '1',
                line_end: '50',
            }),
            makeToolResult(readCallId, 'read_file', 'error', '', {
                errorCode: 'tool.validation',
                errorMessage: 'Input validation failed',
            }),
        ];
        const facts = extractTurnFacts(items);
        expect(facts.modifiedFiles).toContain('world/characters/lilith-asami.md');
        expect(facts.toolErrors).toHaveLength(0);
    });

    it('extracts approval denial when approved===false in tool result data', () => {
        const callId = 'call_del1' as ToolCallId;
        const items = [
            makeAssistantMsgWithToolCall(callId, 'delete_path', { path: 'src/old.ts' }),
            // confirm_action always sets yieldOutcome; denial is data.approved===false
            makeToolResult(callId, 'delete_path', 'success', '{"approved":false}', {
                yieldOutcome: 'approval_required',
            }),
        ];
        const facts = extractTurnFacts(items);
        expect(facts.approvalsDenied).toHaveLength(1);
        expect(facts.approvalsDenied[0].toolName).toBe('delete_path');
    });

    it('does not extract denial when approved===true (user approved)', () => {
        const callId = 'call_del2' as ToolCallId;
        const items = [
            makeAssistantMsgWithToolCall(callId, 'write_file', { path: 'src/a.ts', content: '' }),
            makeToolResult(callId, 'write_file', 'success', '{"approved":true}', {
                yieldOutcome: 'approval_required',
            }),
        ];
        const facts = extractTurnFacts(items);
        expect(facts.approvalsDenied).toHaveLength(0);
    });

    it('extracts file paths mentioned in user message', () => {
        const items = [makeUserMsg('please look at src/core/agent.ts and test/core/agent.test.ts')];
        const facts = extractTurnFacts(items);
        expect(facts.mentionedFiles).toContain('src/core/agent.ts');
        expect(facts.mentionedFiles).toContain('test/core/agent.test.ts');
    });

    it('deduplicates modified files', () => {
        const callId1 = 'call_w1' as ToolCallId;
        const callId2 = 'call_w2' as ToolCallId;
        const items = [
            makeAssistantMsgWithToolCall(callId1, 'write_file', { path: 'src/a.ts', content: '' }),
            makeAssistantMsgWithToolCall(callId2, 'edit_file', { path: 'src/a.ts', edits: [] }),
            makeToolResult(callId1, 'write_file', 'success', 'ok'),
            makeToolResult(callId2, 'edit_file', 'success', 'ok'),
        ];
        const facts = extractTurnFacts(items);
        expect(facts.modifiedFiles.filter(f => f === 'src/a.ts')).toHaveLength(1);
    });

    it('normalizes workspace-local absolute and relative file references to one key', () => {
        const callId = 'call_norm1' as ToolCallId;
        const items = [
            makeAssistantMsgWithToolCall(callId, 'write_file', { path: '/repo/src/a.ts', content: '' }),
            makeToolResult(callId, 'write_file', 'success', 'ok'),
            makeUserMsg('also check /repo/test/a.test.ts'),
        ];

        const facts = extractTurnFacts(items, '/repo');
        expect(facts.modifiedFiles).toContain('src/a.ts');
        expect(facts.modifiedFiles).not.toContain('/repo/src/a.ts');
        expect(facts.mentionedFiles).toContain('test/a.test.ts');
        expect(facts.mentionedFiles).not.toContain('/repo/test/a.test.ts');
    });
});

describe('applyDeterministicUpdates', () => {
    it('adds modified files to filesOfInterest', () => {
        const initial = createInitialDurableTaskState();
        const facts: TurnFacts = {
            modifiedFiles: ['src/foo.ts'],
            toolErrors: [],
            approvalsDenied: [],
            mentionedFiles: [],
        };
        const state = applyDeterministicUpdates(initial, facts);
        expect(state.filesOfInterest).toContain('src/foo.ts');
    });

    it('adds mentioned files to filesOfInterest', () => {
        const initial = createInitialDurableTaskState();
        const facts: TurnFacts = {
            modifiedFiles: [],
            toolErrors: [],
            approvalsDenied: [],
            mentionedFiles: ['docs/spec/07.md'],
        };
        const state = applyDeterministicUpdates(initial, facts);
        expect(state.filesOfInterest).toContain('docs/spec/07.md');
    });

    it('adds tool error as open loop with status open', () => {
        const initial = createInitialDurableTaskState();
        const facts: TurnFacts = {
            modifiedFiles: [],
            toolErrors: [{ toolName: 'exec_command', errorSummary: 'Command failed with exit code 1' }],
            approvalsDenied: [],
            mentionedFiles: [],
        };
        const state = applyDeterministicUpdates(initial, facts);
        expect(state.openLoops).toHaveLength(1);
        expect(state.openLoops[0].status).toBe('open');
        expect(state.openLoops[0].text).toContain('exec_command');
        expect(state.openLoops[0].text).toContain('failed');
    });

    it('adds file from tool error to filesOfInterest when filePath provided', () => {
        const initial = createInitialDurableTaskState();
        const facts: TurnFacts = {
            modifiedFiles: [],
            toolErrors: [{ toolName: 'write_file', errorSummary: 'permission denied', filePath: 'src/locked.ts' }],
            approvalsDenied: [],
            mentionedFiles: [],
        };
        const state = applyDeterministicUpdates(initial, facts);
        expect(state.filesOfInterest).toContain('src/locked.ts');
    });

    it('adds approval denial as blocked loop and blocker', () => {
        const initial = createInitialDurableTaskState();
        const facts: TurnFacts = {
            modifiedFiles: [],
            toolErrors: [],
            approvalsDenied: [{ toolName: 'delete_path', argsSummary: 'path="src/old.ts"' }],
            mentionedFiles: [],
        };
        const state = applyDeterministicUpdates(initial, facts);
        expect(state.openLoops).toHaveLength(1);
        expect(state.openLoops[0].status).toBe('blocked');
        expect(state.blockers).toHaveLength(1);
        expect(state.blockers[0]).toContain('approval denied');
        expect(state.blockers[0]).toContain('delete_path');
    });

    it('increments revision on each call', () => {
        const initial = createInitialDurableTaskState();
        const emptyFacts: TurnFacts = { modifiedFiles: [], toolErrors: [], approvalsDenied: [], mentionedFiles: [] };
        const s1 = applyDeterministicUpdates(initial, emptyFacts);
        const s2 = applyDeterministicUpdates(s1, emptyFacts);
        const s3 = applyDeterministicUpdates(s2, emptyFacts);
        expect(s1.revision).toBe(1);
        expect(s2.revision).toBe(2);
        expect(s3.revision).toBe(3);
    });

    it('preserves stale flag — only successful LLM patch clears it', () => {
        const staleState: DurableTaskState = { ...createInitialDurableTaskState(), stale: true };
        const emptyFacts: TurnFacts = { modifiedFiles: [], toolErrors: [], approvalsDenied: [], mentionedFiles: [] };
        const updated = applyDeterministicUpdates(staleState, emptyFacts);
        expect(updated.stale).toBe(true); // preserved by deterministic update
    });

    it('caps filesOfInterest at 50 entries', () => {
        const existingFiles = Array.from({ length: 50 }, (_, i) => `old/file${i}.ts`);
        const initial: DurableTaskState = { ...createInitialDurableTaskState(), filesOfInterest: existingFiles };
        const facts: TurnFacts = {
            modifiedFiles: ['new/important.ts'],
            toolErrors: [],
            approvalsDenied: [],
            mentionedFiles: [],
        };
        const state = applyDeterministicUpdates(initial, facts);
        expect(state.filesOfInterest).toHaveLength(50);
        expect(state.filesOfInterest).toContain('new/important.ts');
    });

    it('does not duplicate filesOfInterest', () => {
        const initial: DurableTaskState = { ...createInitialDurableTaskState(), filesOfInterest: ['src/a.ts'] };
        const facts: TurnFacts = {
            modifiedFiles: ['src/a.ts'],
            toolErrors: [],
            approvalsDenied: [],
            mentionedFiles: ['src/a.ts'],
        };
        const state = applyDeterministicUpdates(initial, facts);
        expect(state.filesOfInterest.filter(f => f === 'src/a.ts')).toHaveLength(1);
    });

    it('is a pure function — does not mutate input state', () => {
        const initial = createInitialDurableTaskState();
        const facts: TurnFacts = {
            modifiedFiles: ['src/x.ts'],
            toolErrors: [{ toolName: 'exec_command', errorSummary: 'fail' }],
            approvalsDenied: [{ toolName: 'delete_path', argsSummary: '' }],
            mentionedFiles: [],
        };
        applyDeterministicUpdates(initial, facts);
        expect(initial.filesOfInterest).toHaveLength(0);
        expect(initial.openLoops).toHaveLength(0);
        expect(initial.blockers).toHaveLength(0);
        expect(initial.revision).toBe(0);
    });

    it('openLoops does not grow unboundedly — done loops pruned when cap exceeded', () => {
        // Start with 98 existing open loops (already at cap - 2)
        const initial: DurableTaskState = {
            ...createInitialDurableTaskState(),
            openLoops: Array.from({ length: 98 }, (_, i) => ({
                id: `loop_${i}`,
                text: `error ${i}`,
                status: 'open' as const,
            })),
        };
        // Add 10 more errors — should trigger cap enforcement (done loops pruned first)
        // Since all are 'open', the active count (98+10=108) exceeds MAX_OPEN_LOOPS=100
        let state = initial;
        for (let i = 0; i < 10; i++) {
            state = applyDeterministicUpdates(state, {
                modifiedFiles: [],
                toolErrors: [{ toolName: 'exec_command', errorSummary: `error turn ${i}` }],
                approvalsDenied: [],
                mentionedFiles: [],
            });
        }
        // openLoops should be capped at MAX_OPEN_LOOPS (100)
        expect(state.openLoops.length).toBeLessThanOrEqual(100);
    });
});

describe('applyLlmPatch', () => {
    it('sets goal from patch', () => {
        const state = createInitialDurableTaskState();
        const patch: DurableStatePatch = { goal: 'implement auth module' };
        const updated = applyLlmPatch(state, patch);
        expect(updated.goal).toBe('implement auth module');
    });

    it('clears goal when patch sets null', () => {
        const state: DurableTaskState = { ...createInitialDurableTaskState(), goal: 'old goal' };
        const patch: DurableStatePatch = { goal: null };
        const updated = applyLlmPatch(state, patch);
        expect(updated.goal).toBeNull();
    });

    it('adds constraints without removing existing', () => {
        const state: DurableTaskState = { ...createInitialDurableTaskState(), constraints: ['use pnpm'] };
        const patch: DurableStatePatch = { constraintsAdd: ['use vitest'] };
        const updated = applyLlmPatch(state, patch);
        expect(updated.constraints).toContain('use pnpm');
        expect(updated.constraints).toContain('use vitest');
    });

    it('removes constraints by value', () => {
        const state: DurableTaskState = { ...createInitialDurableTaskState(), constraints: ['use jest', 'use pnpm'] };
        const patch: DurableStatePatch = { constraintsRemove: ['use jest'], constraintsAdd: ['use vitest'] };
        const updated = applyLlmPatch(state, patch);
        expect(updated.constraints).not.toContain('use jest');
        expect(updated.constraints).toContain('use vitest');
        expect(updated.constraints).toContain('use pnpm');
    });

    it('updates open loop status by id', () => {
        const loopId = 'itm_testloop1';
        const state: DurableTaskState = {
            ...createInitialDurableTaskState(),
            openLoops: [{ id: loopId, text: 'auth not working', status: 'open' }],
        };
        const patch: DurableStatePatch = { openLoopsUpdate: [{ id: loopId, status: 'done' }] };
        const updated = applyLlmPatch(state, patch);
        expect(updated.openLoops[0].status).toBe('done');
    });

    it('adds new open loops from patch', () => {
        const state = createInitialDurableTaskState();
        const patch: DurableStatePatch = {
            openLoopsAdd: [{ id: 'itm_new1', text: 'review security', status: 'open' }],
        };
        const updated = applyLlmPatch(state, patch);
        expect(updated.openLoops).toHaveLength(1);
        expect(updated.openLoops[0].text).toBe('review security');
    });

    it('adds confirmed facts without duplicates', () => {
        const state: DurableTaskState = { ...createInitialDurableTaskState(), confirmedFacts: ['project uses pnpm'] };
        const patch: DurableStatePatch = {
            confirmedFactsAdd: ['project uses pnpm', 'auth in src/auth/'],
        };
        const updated = applyLlmPatch(state, patch);
        expect(updated.confirmedFacts.filter(f => f === 'project uses pnpm')).toHaveLength(1);
        expect(updated.confirmedFacts).toContain('auth in src/auth/');
    });

    it('removes blocker when corresponding loop is marked done', () => {
        const loopId = 'itm_blockerloop1';
        const blockerText = `approval denied for write_file(path="src/a.ts")`;
        const state: DurableTaskState = {
            ...createInitialDurableTaskState(),
            openLoops: [{ id: loopId, text: blockerText, status: 'blocked' }],
            blockers: [blockerText],
        };
        const patch: DurableStatePatch = { openLoopsUpdate: [{ id: loopId, status: 'done' }] };
        const updated = applyLlmPatch(state, patch);
        expect(updated.openLoops[0].status).toBe('done');
        expect(updated.blockers).toHaveLength(0); // blocker removed
    });

    it('does not remove unrelated blockers when loop is marked done', () => {
        const loopId = 'itm_loop_done';
        const otherBlocker = 'some other blocker';
        const state: DurableTaskState = {
            ...createInitialDurableTaskState(),
            openLoops: [{ id: loopId, text: 'approval denied for write_file()', status: 'blocked' }],
            blockers: ['approval denied for write_file()', otherBlocker],
        };
        const patch: DurableStatePatch = { openLoopsUpdate: [{ id: loopId, status: 'done' }] };
        const updated = applyLlmPatch(state, patch);
        expect(updated.blockers).toContain(otherBlocker);
        expect(updated.blockers).not.toContain('approval denied for write_file()');
    });

    it('does not cross-delete blocker when another blocked loop shares identical text', () => {
        // Regression test: two distinct loops with identical text (e.g. same tool denied twice).
        // Resolving one loop must NOT remove the blocker that the other loop still needs.
        const sharedText = 'approval denied for write_file(path="src/a.ts")';
        const state: DurableTaskState = {
            ...createInitialDurableTaskState(),
            openLoops: [
                { id: 'loop_A', text: sharedText, status: 'blocked' },
                { id: 'loop_B', text: sharedText, status: 'blocked' },
            ],
            blockers: [sharedText],  // addUnique deduplicates to single entry
        };
        // Resolve only loop_A
        const patch: DurableStatePatch = { openLoopsUpdate: [{ id: 'loop_A', status: 'done' }] };
        const updated = applyLlmPatch(state, patch);
        expect(updated.openLoops.find(l => l.id === 'loop_A')?.status).toBe('done');
        expect(updated.openLoops.find(l => l.id === 'loop_B')?.status).toBe('blocked');
        // Blocker must be retained — loop_B still needs it
        expect(updated.blockers).toContain(sharedText);
    });

    it('is a pure function — does not mutate input state', () => {
        const state = createInitialDurableTaskState();
        const patch: DurableStatePatch = { goal: 'new goal', constraintsAdd: ['a'] };
        applyLlmPatch(state, patch);
        expect(state.goal).toBeNull();
        expect(state.constraints).toHaveLength(0);
    });

    it('enforces MAX_FILES_OF_INTEREST cap on filesOfInterestAdd', () => {
        const state = {
            ...createInitialDurableTaskState(),
            filesOfInterest: Array.from({ length: 45 }, (_, i) => `existing-${i}.ts`),
        };
        const patch: DurableStatePatch = {
            filesOfInterestAdd: Array.from({ length: 20 }, (_, i) => `new-${i}.ts`),
        };
        const updated = applyLlmPatch(state, patch);
        expect(updated.filesOfInterest.length).toBeLessThanOrEqual(50);
    });

    it('enforces MAX_OPEN_LOOPS cap on openLoopsAdd', () => {
        const state = {
            ...createInitialDurableTaskState(),
            openLoops: Array.from({ length: 95 }, (_, i) => ({
                id: `loop_${i}`,
                text: `loop ${i}`,
                status: 'open' as const,
            })),
        };
        const patch: DurableStatePatch = {
            openLoopsAdd: Array.from({ length: 20 }, (_, i) => ({
                id: `new_loop_${i}`,
                text: `new loop ${i}`,
                status: 'open' as const,
            })),
        };
        const updated = applyLlmPatch(state, patch);
        expect(updated.openLoops.length).toBeLessThanOrEqual(100);
    });

    it('prunes done loops first when enforcing open loops cap', () => {
        const state = {
            ...createInitialDurableTaskState(),
            openLoops: [
                ...Array.from({ length: 50 }, (_, i) => ({
                    id: `done_${i}`, text: `done ${i}`, status: 'done' as const,
                })),
                ...Array.from({ length: 50 }, (_, i) => ({
                    id: `active_${i}`, text: `active ${i}`, status: 'open' as const,
                })),
            ],
        };
        const patch: DurableStatePatch = {
            openLoopsAdd: Array.from({ length: 10 }, (_, i) => ({
                id: `new_${i}`, text: `new ${i}`, status: 'open' as const,
            })),
        };
        const updated = applyLlmPatch(state, patch);
        expect(updated.openLoops.length).toBeLessThanOrEqual(100);
        // All done loops should be pruned
        expect(updated.openLoops.every(l => l.status !== 'done')).toBe(true);
    });
});

describe('updateDurableTaskState', () => {
    it('applies deterministic updates when no provider given', async () => {
        const initial = createInitialDurableTaskState();
        const facts: TurnFacts = {
            modifiedFiles: ['src/agent.ts'],
            toolErrors: [],
            approvalsDenied: [],
            mentionedFiles: [],
        };
        const result = await updateDurableTaskState(initial, facts, []);
        expect(result.filesOfInterest).toContain('src/agent.ts');
        // Without LLM, stale stays as initial (false — never tried and failed)
        expect(result.stale).toBe(false);
        expect(result.revision).toBe(1);
    });

    it('clears stale after successful LLM patch', async () => {
        const mockProvider = {
            validate: vi.fn(),
            capabilities: vi.fn(),
            stream: vi.fn().mockImplementation(async function* () {
                yield { type: 'text_delta', text: '{}' };
                yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } };
            }),
        } as unknown as ProviderDriver;

        const staleState: DurableTaskState = { ...createInitialDurableTaskState(), stale: true };
        const emptyFacts: TurnFacts = { modifiedFiles: [], toolErrors: [], approvalsDenied: [], mentionedFiles: [] };
        const result = await updateDurableTaskState(staleState, emptyFacts, [], mockProvider, 'test-model');
        expect(result.stale).toBe(false); // cleared by successful LLM patch
    });

    it('applies LLM patch and updates constraints', async () => {
        const mockProvider = {
            validate: vi.fn(),
            capabilities: vi.fn(),
            stream: vi.fn().mockImplementation(async function* () {
                yield { type: 'text_delta', text: '{ "constraintsAdd": ["use vitest not jest"] }' };
                yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 10 } };
            }),
        } as unknown as ProviderDriver;

        const initial = createInitialDurableTaskState();
        const facts: TurnFacts = { modifiedFiles: [], toolErrors: [], approvalsDenied: [], mentionedFiles: [] };
        const userMsg = makeUserMsg('please use vitest not jest for tests');

        const result = await updateDurableTaskState(initial, facts, [userMsg], mockProvider, 'test-model');
        expect(result.constraints).toContain('use vitest not jest');
        expect(result.stale).toBe(false);
    });

    it('sets stale=true and keeps deterministic updates when LLM patch fails', async () => {
        const failingProvider = {
            validate: vi.fn(),
            capabilities: vi.fn(),
            stream: vi.fn().mockImplementation(async function* () {
                yield { type: 'error', error: { code: 'network', message: 'connection timeout' } };
            }),
        } as unknown as ProviderDriver;

        const initial = createInitialDurableTaskState();
        const facts: TurnFacts = {
            modifiedFiles: ['src/a.ts'],
            toolErrors: [],
            approvalsDenied: [],
            mentionedFiles: [],
        };

        const result = await updateDurableTaskState(initial, facts, [], failingProvider, 'test-model');
        expect(result.stale).toBe(true);
        expect(result.filesOfInterest).toContain('src/a.ts');
        expect(result.revision).toBe(1);
    });

    it('sets stale=true when provider stream throws', async () => {
        const throwingProvider = {
            validate: vi.fn(),
            capabilities: vi.fn(),
            stream: vi.fn().mockImplementation(() => {
                throw new Error('provider unavailable');
            }),
        } as unknown as ProviderDriver;

        const initial = createInitialDurableTaskState();
        const emptyFacts: TurnFacts = { modifiedFiles: [], toolErrors: [], approvalsDenied: [], mentionedFiles: [] };
        const result = await updateDurableTaskState(initial, emptyFacts, [], throwingProvider, 'test-model');
        expect(result.stale).toBe(true);
    });

    it('integrates full turn: write_file + error + user mention', async () => {
        const callId1 = 'call_wf2' as ToolCallId;
        const callId2 = 'call_ex2' as ToolCallId;
        const items = [
            makeUserMsg('update src/config.ts and check the output'),
            makeAssistantMsgWithToolCall(callId1, 'write_file', { path: 'src/config.ts', content: 'x' }),
            makeToolResult(callId1, 'write_file', 'success', 'Written'),
            makeAssistantMsgWithToolCall(callId2, 'exec_command', { command: 'node src/config.ts' }),
            makeToolResult(callId2, 'exec_command', 'error', 'TypeError: x is not defined', {
                errorCode: 'exec.nonzero_exit',
                errorMessage: 'TypeError: x is not defined',
            }),
        ];

        const initial = createInitialDurableTaskState();
        const facts = extractTurnFacts(items);

        expect(facts.modifiedFiles).toContain('src/config.ts');
        expect(facts.toolErrors).toHaveLength(1);
        expect(facts.mentionedFiles).toContain('src/config.ts');

        const state = applyDeterministicUpdates(initial, facts);
        expect(state.filesOfInterest).toContain('src/config.ts');
        expect(state.openLoops).toHaveLength(1);
        expect(state.openLoops[0].status).toBe('open');
    });
});

describe('renderDurableTaskState', () => {
    it('renders empty state as empty string', () => {
        const state = createInitialDurableTaskState();
        expect(renderDurableTaskState(state)).toBe('');
    });

    it('renders goal, open loops, and facts within 200 tokens with Task State header', () => {
        const state: DurableTaskState = {
            ...createInitialDurableTaskState(),
            goal: 'implement the auth module',
            openLoops: [
                { id: 'itm_1', text: 'need to configure JWT secret', status: 'open' },
                { id: 'itm_2', text: 'waiting on design decision', status: 'blocked' },
            ],
            confirmedFacts: [
                'project uses pnpm',
                'auth module is in src/auth/',
                'JWT library is jose',
            ],
        };
        const rendered = renderDurableTaskState(state);
        expect(rendered).toContain('Task State:');
        expect(rendered).toContain('Goal: implement the auth module');
        expect(rendered).toContain('need to configure JWT secret');
        expect(rendered).toContain('waiting on design decision');
        expect(rendered).toContain('(blocked)');
        expect(rendered).toContain('project uses pnpm');
        // Token estimate: bytes / 3
        const tokenEstimate = Math.ceil(Buffer.byteLength(rendered) / 3);
        expect(tokenEstimate).toBeLessThan(200);
    });

    it('includes blockers in rendering', () => {
        const state: DurableTaskState = {
            ...createInitialDurableTaskState(),
            blockers: ['approval denied for delete_path(path="src/old.ts")'],
        };
        const rendered = renderDurableTaskState(state);
        expect(rendered).toContain('Blockers:');
        expect(rendered).toContain('approval denied');
    });

    it('limits open loops to 5 active ones', () => {
        const state: DurableTaskState = {
            ...createInitialDurableTaskState(),
            openLoops: Array.from({ length: 8 }, (_, i) => ({
                id: `itm_loop${i}`,
                text: `loop item ${i}`,
                status: 'open' as const,
            })),
        };
        const rendered = renderDurableTaskState(state);
        // Count lines starting with "Open:"
        const openLines = rendered.split('\n').filter(l => l.startsWith('Open:'));
        expect(openLines).toHaveLength(5);
    });

    it('excludes done loops from rendering', () => {
        const state: DurableTaskState = {
            ...createInitialDurableTaskState(),
            openLoops: [
                { id: 'itm_d1', text: 'already resolved', status: 'done' },
                { id: 'itm_o1', text: 'still pending', status: 'open' },
            ],
        };
        const rendered = renderDurableTaskState(state);
        expect(rendered).not.toContain('already resolved');
        expect(rendered).toContain('still pending');
    });

    it('shows stale flag when state is stale', () => {
        const state: DurableTaskState = { ...createInitialDurableTaskState(), stale: true };
        expect(renderDurableTaskState(state)).toContain('stale');
    });

    it('limits confirmed facts to the 3 most recent', () => {
        const state: DurableTaskState = {
            ...createInitialDurableTaskState(),
            confirmedFacts: ['fact1', 'fact2', 'fact3', 'fact4', 'fact5'],
        };
        const rendered = renderDurableTaskState(state);
        expect(rendered).not.toContain('fact1');
        expect(rendered).not.toContain('fact2');
        expect(rendered).toContain('fact3');
        expect(rendered).toContain('fact4');
        expect(rendered).toContain('fact5');
    });
});

describe('session-level integration', () => {
    it('full turn flow: extract facts → deterministic update → revision tracks updates', async () => {
        let state = createInitialDurableTaskState();

        // Turn 1: write a file
        const callId = 'call_t1' as ToolCallId;
        const turn1 = [
            makeAssistantMsgWithToolCall(callId, 'write_file', { path: 'src/main.ts', content: '' }),
            makeToolResult(callId, 'write_file', 'success', 'Written'),
        ];
        const facts1 = extractTurnFacts(turn1);
        state = await updateDurableTaskState(state, facts1, turn1);
        expect(state.revision).toBe(1);
        expect(state.filesOfInterest).toContain('src/main.ts');

        // Turn 2: exec fails
        const callId2 = 'call_t2' as ToolCallId;
        const turn2 = [
            makeAssistantMsgWithToolCall(callId2, 'exec_command', { command: 'node src/main.ts' }),
            makeToolResult(callId2, 'exec_command', 'error', 'ReferenceError', {
                errorCode: 'exec.nonzero_exit',
                errorMessage: 'ReferenceError: x is not defined',
            }),
        ];
        const facts2 = extractTurnFacts(turn2);
        state = await updateDurableTaskState(state, facts2, turn2);
        expect(state.revision).toBe(2);
        expect(state.openLoops).toHaveLength(1);
        expect(state.openLoops[0].status).toBe('open');
    });
});
