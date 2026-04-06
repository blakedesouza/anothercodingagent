import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openSessionSpec, openSessionImpl } from '../../src/tools/open-session.js';
import { sessionIoSpec, sessionIoImpl } from '../../src/tools/session-io.js';
import { closeSessionSpec, closeSessionImpl } from '../../src/tools/close-session.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

const registry = new ToolRegistry();
registry.register(openSessionSpec, openSessionImpl);
registry.register(sessionIoSpec, sessionIoImpl);
registry.register(closeSessionSpec, closeSessionImpl);
const runner = new ToolRunner(registry);

const SESSION = 'ses_io_test';
const baseContext = { sessionId: SESSION, workspaceRoot: '/tmp' };

let catHandle: string;

function parse(result: { data: string }): Record<string, unknown> {
    return JSON.parse(result.data) as Record<string, unknown>;
}

beforeAll(async () => {
    const openResult = await runner.execute('open_session', { command: 'cat' }, baseContext);
    expect(openResult.status).toBe('success');
    catHandle = parse(openResult).session_id as string;
}, 10_000);

afterAll(async () => {
    if (catHandle) {
        await runner.execute(
            'close_session',
            { session_id: catHandle, signal: 'SIGKILL' },
            baseContext,
        );
    }
}, 10_000);

describe('session_io tool', () => {
    describe('spec metadata', () => {
        it('has correct approval class', () => {
            expect(sessionIoSpec.name).toBe('session_io');
            expect(sessionIoSpec.approvalClass).toBe('external-effect');
            expect(sessionIoSpec.idempotent).toBe(false);
        });
    });

    describe('send stdin to cat → output returned', () => {
        it('echoes stdin back via stdout when wait=true', async () => {
            const result = await runner.execute(
                'session_io',
                { session_id: catHandle, stdin: 'hello from aca\n', wait: true },
                baseContext,
            );
            expect(result.status).toBe('success');
            const data = parse(result);
            expect(data.status).toBe('running');
            expect(data.output).toBe('hello from aca\n');
        }, 10_000);
    });

    describe('read without wait → returns buffered or empty', () => {
        it('returns success with empty output when nothing is buffered', async () => {
            // Drain any leftover output first.
            await runner.execute('session_io', { session_id: catHandle, wait: false }, baseContext);

            const result = await runner.execute(
                'session_io',
                { session_id: catHandle, wait: false },
                baseContext,
            );
            expect(result.status).toBe('success');
            const data = parse(result);
            expect(data.status).toBe('running');
            expect(data.output).toBe('');
        }, 5_000);
    });

    describe('send signal → status updated', () => {
        it('sends SIGTERM and the process eventually reports as exited', async () => {
            // Open a dedicated session for signal testing.
            const sigResult = await runner.execute(
                'open_session',
                { command: 'cat' },
                baseContext,
            );
            expect(sigResult.status).toBe('success');
            const sigHandle = parse(sigResult).session_id as string;

            // Send SIGTERM.
            const ioResult = await runner.execute(
                'session_io',
                { session_id: sigHandle, signal: 'SIGTERM', wait: false },
                baseContext,
            );
            expect(ioResult.status).toBe('success');

            // Wait briefly and poll for exited status.
            let statusData: Record<string, unknown> = {};
            for (let i = 0; i < 20; i++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                const poll = await runner.execute(
                    'session_io',
                    { session_id: sigHandle, wait: false },
                    baseContext,
                );
                statusData = parse(poll);
                if (statusData.status === 'exited') break;
            }
            expect(statusData.status).toBe('exited');

            // Cleanup.
            await runner.execute(
                'close_session',
                { session_id: sigHandle, signal: 'SIGKILL' },
                baseContext,
            );
        }, 10_000);
    });

    describe('unknown session handle', () => {
        it('returns tool.not_found for an unknown handle', async () => {
            const result = await runner.execute(
                'session_io',
                { session_id: 'psh_notexist', wait: false },
                baseContext,
            );
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.not_found');
        });
    });

    describe('validation', () => {
        it('returns validation error when session_id is missing', async () => {
            const result = await runner.execute('session_io', {}, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
