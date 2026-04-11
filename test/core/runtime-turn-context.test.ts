import { describe, it, expect } from 'vitest';
import type { ConversationItem, MessageItem, ToolResultItem } from '../../src/types/conversation.js';
import type { ItemId, ToolCallId, SessionId, WorkspaceId } from '../../src/types/ids.js';
import type { SessionManifest } from '../../src/core/session-manager.js';
import { CapabilityHealthMap } from '../../src/core/capability-health.js';
import {
    applyRuntimeTurnState,
    buildRuntimePromptContext,
} from '../../src/core/runtime-turn-context.js';

let seqCounter = 0;

function nextId(prefix: string): string {
    return `${prefix}_${++seqCounter}`;
}

function makeUserMessage(text: string, seq: number): MessageItem {
    return {
        kind: 'message',
        id: nextId('itm') as ItemId,
        seq,
        role: 'user',
        parts: [{ type: 'text', text }],
        timestamp: '2026-01-01T00:00:00Z',
    };
}

function makeAssistantToolCall(toolCallId: ToolCallId, toolName: string, args: Record<string, unknown>, seq: number): MessageItem {
    return {
        kind: 'message',
        id: nextId('itm') as ItemId,
        seq,
        role: 'assistant',
        parts: [{ type: 'tool_call', toolCallId, toolName, arguments: args }],
        timestamp: '2026-01-01T00:00:00Z',
    };
}

function makeToolResult(toolCallId: ToolCallId, toolName: string, data: string, seq: number): ToolResultItem {
    return {
        kind: 'tool_result',
        id: nextId('itm') as ItemId,
        seq,
        toolCallId,
        toolName,
        output: {
            status: 'success',
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

function makeManifest(): SessionManifest {
    return {
        sessionId: 'ses_TEST000000000000000000000' as SessionId,
        workspaceId: 'wrk_TEST' as WorkspaceId,
        status: 'active',
        turnCount: 0,
        lastActivityTimestamp: '2026-01-01T00:00:00Z',
        configSnapshot: { workspaceRoot: '/repo' },
        durableTaskState: null,
        fileActivityIndex: null,
        calibration: null,
    };
}

describe('runtime-turn-context', () => {
    it('applyRuntimeTurnState updates durable task state and file activity index deterministically', async () => {
        const manifest = makeManifest();
        const callId = 'call_1' as ToolCallId;
        const turnItems: ConversationItem[] = [
            makeUserMessage('please check src/app.ts', 1),
            makeAssistantToolCall(callId, 'write_file', { path: '/repo/src/app.ts', content: 'export {}' }, 2),
            makeToolResult(callId, 'write_file', 'ok', 3),
        ];

        await applyRuntimeTurnState(manifest, turnItems, '/repo');

        expect(manifest.durableTaskState).not.toBeNull();
        expect(manifest.durableTaskState!.filesOfInterest).toContain('src/app.ts');
        expect(manifest.durableTaskState!.revision).toBe(1);
        expect(manifest.fileActivityIndex).not.toBeNull();
        expect(manifest.fileActivityIndex!['src/app.ts']?.score).toBe(55);
    });

    it('buildRuntimePromptContext exposes project snapshot, working set, durable summary, and degraded capabilities', () => {
        const manifest = makeManifest();
        manifest.durableTaskState = {
            goal: 'Fix auth flow',
            constraints: [],
            confirmedFacts: ['uses vitest', 'entrypoint is src/main.ts'],
            decisions: [],
            openLoops: [{ id: 'ol1', text: 'run auth tests', status: 'open' }],
            blockers: ['waiting on fixture update'],
            filesOfInterest: ['src/main.ts'],
            revision: 1,
            stale: false,
        };
        manifest.fileActivityIndex = {
            'src/main.ts': { score: 30, turnsSinceLastTouch: 0, role: 'editing' },
        };

        const healthMap = new CapabilityHealthMap(() => 0);
        healthMap.register('lsp', 'local');
        healthMap.reportRetryableFailure('lsp', 'server crashed');

        const context = buildRuntimePromptContext('/workspace/anothercodingagent', manifest, healthMap);

        expect(context.projectSnapshot).toBeDefined();
        expect(context.workingSet).toEqual([{ path: 'src/main.ts', role: 'editing' }]);
        expect(context.durableTaskState?.goal).toBe('Fix auth flow');
        expect(context.durableTaskState?.openLoops).toContain('run auth tests');
        expect(context.capabilities?.[0]).toMatchObject({ name: 'lsp', status: 'degraded' });
    });
});
