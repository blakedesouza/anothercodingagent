import { describe, it, expect, afterEach } from 'vitest';
import { openSessionSpec, openSessionImpl } from '../../src/tools/open-session.js';
import { closeSessionImpl } from '../../src/tools/close-session.js';
import { closeSessionSpec } from '../../src/tools/close-session.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

const registry = new ToolRegistry();
registry.register(openSessionSpec, openSessionImpl);
registry.register(closeSessionSpec, closeSessionImpl);
const runner = new ToolRunner(registry);

const SESSION = 'ses_open_test';
const baseContext = { sessionId: SESSION, workspaceRoot: '/tmp' };

const openedHandles: string[] = [];

function parse(result: { data: string }): Record<string, unknown> {
    return JSON.parse(result.data) as Record<string, unknown>;
}

afterEach(async () => {
    // Best-effort cleanup of any sessions opened during tests.
    for (const handle of openedHandles.splice(0)) {
        try {
            await runner.execute('close_session', { session_id: handle, signal: 'SIGKILL' }, baseContext);
        } catch {
            // Ignore cleanup errors.
        }
    }
});

describe('open_session tool', () => {
    describe('spec metadata', () => {
        it('has correct approval class', () => {
            expect(openSessionSpec.name).toBe('open_session');
            expect(openSessionSpec.approvalClass).toBe('external-effect');
            expect(openSessionSpec.idempotent).toBe(false);
        });
    });

    describe('start cat → session_id returned, process running', () => {
        it('returns a session handle and the cat process is running', async () => {
            const result = await runner.execute(
                'open_session',
                { command: 'cat' },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parse(result);
            expect(typeof data.session_id).toBe('string');
            expect(String(data.session_id).startsWith('psh_')).toBe(true);
            expect(typeof data.pid).toBe('number');
            expect(data.pid as number).toBeGreaterThan(0);

            openedHandles.push(data.session_id as string);
        }, 5_000);
    });

    describe('initial_output field', () => {
        it('returns initial_output as a string', async () => {
            const result = await runner.execute(
                'open_session',
                { command: 'cat' },
                baseContext,
            );
            expect(result.status).toBe('success');
            const data = parse(result);
            expect(typeof data.initial_output).toBe('string');

            openedHandles.push(data.session_id as string);
        }, 5_000);
    });

    describe('spawn failure', () => {
        it('returns tool.session_exited when command exits immediately', async () => {
            // /bin/sh starts fine but exits within the initial 100ms wait (code 127).
            // The close handler fires and resolves with tool.session_exited.
            const result = await runner.execute(
                'open_session',
                { command: '/nonexistent_command_aca_test' },
                baseContext,
            );
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.session_exited');
        }, 5_000);
    });

    describe('validation', () => {
        it('returns validation error when command is missing', async () => {
            const result = await runner.execute('open_session', {}, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
