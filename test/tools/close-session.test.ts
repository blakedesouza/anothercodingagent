import { describe, it, expect } from 'vitest';
import { openSessionSpec, openSessionImpl } from '../../src/tools/open-session.js';
import { closeSessionSpec, closeSessionImpl } from '../../src/tools/close-session.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';
import { isPidRunning } from '../../src/tools/process-registry.js';

const registry = new ToolRegistry();
registry.register(openSessionSpec, openSessionImpl);
registry.register(closeSessionSpec, closeSessionImpl);
const runner = new ToolRunner(registry);

const SESSION = 'ses_close_test';
const baseContext = { sessionId: SESSION, workspaceRoot: '/tmp' };

function parse(result: { data: string }): Record<string, unknown> {
    return JSON.parse(result.data) as Record<string, unknown>;
}

describe('close_session tool', () => {
    describe('spec metadata', () => {
        it('has correct approval class', () => {
            expect(closeSessionSpec.name).toBe('close_session');
            expect(closeSessionSpec.approvalClass).toBe('external-effect');
            expect(closeSessionSpec.idempotent).toBe(false);
        });
    });

    describe('close cat → process killed, final status returned', () => {
        it('kills the process and returns closed status', async () => {
            // Open a cat session.
            const openResult = await runner.execute(
                'open_session',
                { command: 'cat' },
                baseContext,
            );
            expect(openResult.status).toBe('success');
            const openData = parse(openResult);
            const handle = openData.session_id as string;
            const pid = openData.pid as number;

            expect(isPidRunning(pid)).toBe(true);

            // Close the session.
            const closeResult = await runner.execute(
                'close_session',
                { session_id: handle },
                baseContext,
            );
            expect(closeResult.status).toBe('success');

            const data = parse(closeResult);
            expect(data.session_id).toBe(handle);
            expect(data.status).toBe('closed');

            // Give the OS a moment to clean up.
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(isPidRunning(pid)).toBe(false);
        }, 10_000);
    });

    describe('custom signal', () => {
        it('sends SIGKILL when signal=SIGKILL', async () => {
            const openResult = await runner.execute(
                'open_session',
                { command: 'cat' },
                baseContext,
            );
            expect(openResult.status).toBe('success');
            const handle = parse(openResult).session_id as string;

            const closeResult = await runner.execute(
                'close_session',
                { session_id: handle, signal: 'SIGKILL' },
                baseContext,
            );
            expect(closeResult.status).toBe('success');
            const data = parse(closeResult);
            expect(data.status).toBe('closed');
        }, 10_000);
    });

    describe('unknown session handle (idempotent)', () => {
        it('returns success with already_closed for an unknown handle', async () => {
            const result = await runner.execute(
                'close_session',
                { session_id: 'psh_notexist' },
                baseContext,
            );
            expect(result.status).toBe('success');
            const data = parse(result);
            expect(data.status).toBe('already_closed');
        });
    });

    describe('validation', () => {
        it('returns validation error when session_id is missing', async () => {
            const result = await runner.execute('close_session', {}, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
