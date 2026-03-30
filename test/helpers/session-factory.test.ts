import { describe, it, expect, beforeEach } from 'vitest';
import {
    createSession,
    createItem,
    createToolCallItem,
    createToolResultItem,
    createTurn,
    resetSeqCounter,
} from './session-factory.js';
import type { SessionId } from '../../src/types/ids.js';

describe('Session Factory', () => {
    beforeEach(() => {
        resetSeqCounter();
    });

    describe('createSession', () => {
        it('creates an empty session with defaults', () => {
            const { session, items } = createSession();

            expect(session.id).toMatch(/^ses_/);
            expect(session.workspaceId).toMatch(/^wrk_/);
            expect(session.status).toBe('active');
            expect(session.model).toBe('mock-model');
            expect(session.provider).toBe('nanogpt');
            expect(session.turns).toHaveLength(0);
            expect(session.currentTurnNumber).toBe(0);
            expect(session.nextItemSeq).toBe(1);
            expect(items).toHaveLength(0);
        });

        it('creates a session with turns', () => {
            const { session, items } = createSession({ turnCount: 3 });

            expect(session.turns).toHaveLength(3);
            expect(session.currentTurnNumber).toBe(3);
            // Each turn has 1 user message + 1 assistant response = 2 items
            expect(items).toHaveLength(6);
        });

        it('respects custom options', () => {
            const { session } = createSession({
                model: 'claude-sonnet',
                provider: 'anthropic',
                status: 'completed',
                label: 'Test session',
            });

            expect(session.model).toBe('claude-sonnet');
            expect(session.provider).toBe('anthropic');
            expect(session.status).toBe('completed');
            expect(session.label).toBe('Test session');
        });
    });

    describe('createItem', () => {
        it('creates a message item with correct structure', () => {
            const item = createItem('user', 'Hello');

            expect(item.kind).toBe('message');
            expect(item.id).toMatch(/^itm_/);
            expect(item.role).toBe('user');
            expect(item.parts).toHaveLength(1);
            expect(item.parts[0]).toEqual({ type: 'text', text: 'Hello' });
            expect(item.seq).toBe(1);
        });

        it('assigns monotonically increasing sequence numbers', () => {
            const item1 = createItem('user', 'First');
            const item2 = createItem('assistant', 'Second');
            const item3 = createItem('user', 'Third');

            expect(item2.seq).toBe(item1.seq + 1);
            expect(item3.seq).toBe(item2.seq + 1);
        });
    });

    describe('createToolCallItem', () => {
        it('creates an assistant message with tool call part', () => {
            const { message, toolCallId } = createToolCallItem('read_file', { path: '/tmp/test.txt' });

            expect(message.role).toBe('assistant');
            expect(toolCallId).toMatch(/^call_/);
            expect(message.parts).toHaveLength(1);
            expect(message.parts[0]).toMatchObject({
                type: 'tool_call',
                toolName: 'read_file',
                arguments: { path: '/tmp/test.txt' },
            });
        });

        it('includes text part when provided', () => {
            const { message } = createToolCallItem('read_file', {}, 'Let me read that file');

            expect(message.parts).toHaveLength(2);
            expect(message.parts[0]).toEqual({ type: 'text', text: 'Let me read that file' });
            expect(message.parts[1]).toMatchObject({ type: 'tool_call' });
        });
    });

    describe('createToolResultItem', () => {
        it('creates a tool result with output envelope', () => {
            const result = createToolResultItem(
                'call_abc123' as `call_${string}`,
                'read_file',
                'file contents here',
            );

            expect(result.kind).toBe('tool_result');
            expect(result.toolCallId).toBe('call_abc123');
            expect(result.toolName).toBe('read_file');
            expect(result.output.status).toBe('success');
            expect(result.output.data).toBe('file contents here');
            expect(result.output.truncated).toBe(false);
            expect(result.output.mutationState).toBe('none');
        });

        it('supports error status', () => {
            const result = createToolResultItem(
                'call_xyz' as `call_${string}`,
                'exec_command',
                'Command failed',
                'error',
            );

            expect(result.output.status).toBe('error');
        });
    });

    describe('createTurn', () => {
        it('creates a turn with user message and assistant response', () => {
            const sessionId = 'ses_test123' as SessionId;
            const { turn, items } = createTurn(sessionId, 1);

            expect(turn.id).toMatch(/^trn_/);
            expect(turn.sessionId).toBe(sessionId);
            expect(turn.turnNumber).toBe(1);
            expect(turn.status).toBe('completed');
            expect(turn.outcome).toBe('assistant_final');
            expect(turn.steps).toHaveLength(1);
            expect(items).toHaveLength(2);
            expect(items[0].kind).toBe('message');
            expect((items[0] as { role: string }).role).toBe('user');
            expect((items[1] as { role: string }).role).toBe('assistant');
        });

        it('creates a turn with tool calls', () => {
            const sessionId = 'ses_test456' as SessionId;
            const { turn, items } = createTurn(sessionId, 1, {
                toolCalls: [
                    { name: 'read_file', arguments: { path: '/tmp/a.txt' } },
                    { name: 'write_file', arguments: { path: '/tmp/b.txt', content: 'hello' } },
                ],
            });

            // user + (toolcall + result) * 2 + assistant = 6 items
            expect(items).toHaveLength(6);
            expect(turn.itemSeqStart).toBe(items[0].seq);
            expect(turn.itemSeqEnd).toBe(items[items.length - 1].seq);
        });
    });
});
