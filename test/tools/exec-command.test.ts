import { describe, it, expect } from 'vitest';
import { execCommandSpec, execCommandImpl } from '../../src/tools/exec-command.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

const registry = new ToolRegistry();
registry.register(execCommandSpec, execCommandImpl);
const runner = new ToolRunner(registry);

const baseContext = {
    sessionId: 'ses_exectest',
    workspaceRoot: '/tmp',
};

function parse(result: { data: string }): Record<string, unknown> {
    return JSON.parse(result.data) as Record<string, unknown>;
}

describe('exec_command tool', () => {
    describe('spec metadata', () => {
        it('has correct approval class and timeout category', () => {
            expect(execCommandSpec.name).toBe('exec_command');
            expect(execCommandSpec.approvalClass).toBe('external-effect');
            expect(execCommandSpec.timeoutCategory).toBe('shell');
            expect(execCommandSpec.idempotent).toBe(false);
        });
    });

    describe('echo hello → stdout, exit 0', () => {
        it('captures stdout and exit code 0', async () => {
            const result = await runner.execute(
                'exec_command',
                { command: 'echo hello' },
                baseContext,
            );
            expect(result.status).toBe('success');
            const data = parse(result);
            expect(data.stdout).toBe('hello\n');
            expect(data.exit_code).toBe(0);
            expect(data.stderr).toBe('');
            expect(data.stdout_truncated).toBe(false);
        });
    });

    describe('false → exit 1', () => {
        it('returns exit code 1 but status success (tool ran fine)', async () => {
            const result = await runner.execute(
                'exec_command',
                { command: 'false' },
                baseContext,
            );
            expect(result.status).toBe('success');
            const data = parse(result);
            expect(data.exit_code).toBe(1);
        });
    });

    describe('stderr capture', () => {
        it('captures stderr separately from stdout', async () => {
            const result = await runner.execute(
                'exec_command',
                { command: 'echo out && echo err >&2' },
                baseContext,
            );
            expect(result.status).toBe('success');
            const data = parse(result);
            expect(data.stdout).toBe('out\n');
            expect(data.stderr).toBe('err\n');
        });
    });

    describe('custom cwd', () => {
        it('runs in the specified working directory', async () => {
            const result = await runner.execute(
                'exec_command',
                { command: 'pwd', cwd: '/tmp' },
                baseContext,
            );
            expect(result.status).toBe('success');
            const data = parse(result);
            expect(String(data.stdout).trim()).toBe('/tmp');
        });
    });

    describe('custom env vars', () => {
        it('makes env vars available to the command', async () => {
            const result = await runner.execute(
                'exec_command',
                { command: 'echo $ACA_TEST_VAR', env: { ACA_TEST_VAR: 'hello_aca' } },
                baseContext,
            );
            expect(result.status).toBe('success');
            const data = parse(result);
            expect(data.stdout).toBe('hello_aca\n');
        });
    });

    describe('timeout', () => {
        it('kills the process and returns tool.timeout when timeout expires', async () => {
            const result = await runner.execute(
                'exec_command',
                { command: 'sleep 60', timeout: 200 },
                baseContext,
            );
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.timeout');
            expect(result.timedOut).toBe(true);
        }, 5_000);
    });

    describe('output > combined cap → head+tail truncation', () => {
        it('truncates large stdout with head+tail preserved', async () => {
            // Generate ~100 KB of output to exceed the 62 KB combined cap.
            const result = await runner.execute(
                'exec_command',
                {
                    command: "node -e \"process.stdout.write('X'.repeat(100000))\"",
                },
                baseContext,
            );
            expect(result.status).toBe('success');
            const raw = result.data;
            // Must be valid JSON.
            const data = JSON.parse(raw) as Record<string, unknown>;
            expect(data.stdout_truncated).toBe(true);
            expect(typeof data.stdout).toBe('string');
            const stdout = data.stdout as string;
            // Head preserved — starts with X.
            expect(stdout.startsWith('X')).toBe(true);
            // Tail preserved — ends with X.
            expect(stdout.endsWith('X')).toBe(true);
            // Omission marker present.
            expect(stdout).toContain('[...');
            // JSON data stays within ToolRunner's 64 KiB cap.
            expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(65_536);
        }, 10_000);
    });

    describe('duration', () => {
        it('includes a non-negative duration_ms', async () => {
            const result = await runner.execute(
                'exec_command',
                { command: 'echo hi' },
                baseContext,
            );
            expect(result.status).toBe('success');
            const data = parse(result);
            expect(typeof data.duration_ms).toBe('number');
            expect(data.duration_ms as number).toBeGreaterThanOrEqual(0);
        });
    });

    describe('validation', () => {
        it('returns validation error when command is missing', async () => {
            const result = await runner.execute('exec_command', {}, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
