import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { loadSecrets } from '../../src/config/secrets.js';

const ROOT = join(import.meta.dirname, '..', '..');
const DIST_INDEX = join(ROOT, 'dist', 'index.js');
const execFileAsync = promisify(execFile);

/** Isolated HOME for test sessions — prevents polluting user's real ~/.aca/ */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'aca-test-home-'));

/** Check if a real NanoGPT key is available. */
let hasApiKey = false;
let apiKeyEnv: Record<string, string> = {};

beforeAll(async () => {
    if (!existsSync(DIST_INDEX)) {
        execFileSync('npm', ['run', 'build'], {
            cwd: ROOT,
            encoding: 'utf-8',
            timeout: 60_000,
        });
    }
    const result = await loadSecrets();
    const key = result.secrets.nanogpt;
    if (key && key.trim() !== '') {
        hasApiKey = true;
        apiKeyEnv = { NANOGPT_API_KEY: key };
    }
});

afterAll(() => {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * Helper: run `node dist/index.js <args>` with the built standalone CLI.
 * HOME is set to an isolated temp dir to prevent polluting user sessions.
 */
async function runAca(
    args: string[],
    options?: { env?: Record<string, string>; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const env = {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        HOME: TEST_HOME,
        ...apiKeyEnv,
        ...(options?.env ?? {}),
    };
    try {
        const { stdout, stderr } = await execFileAsync('node', [DIST_INDEX, ...args], {
            cwd: ROOT,
            encoding: 'utf-8',
            timeout: options?.timeout ?? 60_000,
            env,
        });
        return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number | string };
        return {
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? '',
            exitCode: typeof e.code === 'number' ? e.code : 1,
        };
    }
}

describe('M8.2 — First Real Run', () => {
    describe('one-shot with real NanoGPT', () => {
        it('produces non-empty stdout with real LLM response', { timeout: 60_000 }, async () => {
            if (!hasApiKey) return; // skip without API key

            const { stdout, exitCode } = await runAca(['"what is 2+2"']);
            // The LLM should produce some text
            expect(exitCode).toBe(0);
            expect(stdout.trim().length).toBeGreaterThan(0);
        });

        it('session manifest exists after run', { timeout: 60_000 }, async () => {
            if (!hasApiKey) return;

            // Run a one-shot and check session dir
            await runAca(['what is the capital of France']);

            const sessionsDir = join(TEST_HOME, '.aca', 'sessions');
            expect(existsSync(sessionsDir)).toBe(true);

            // Find the most recent session
            const dirs = readdirSync(sessionsDir)
                .filter(d => d.startsWith('ses_'))
                .sort()
                .reverse();
            expect(dirs.length).toBeGreaterThan(0);

            const latestDir = join(sessionsDir, dirs[0]);
            expect(existsSync(join(latestDir, 'manifest.json'))).toBe(true);

            const manifest = JSON.parse(
                readFileSync(join(latestDir, 'manifest.json'), 'utf-8'),
            );
            expect(manifest.sessionId).toMatch(/^ses_/);
            expect(manifest.workspaceId).toMatch(/^wrk_/);
            expect(manifest.turnCount).toBeGreaterThanOrEqual(1);
        });

        it('conversation.jsonl contains user message + assistant response', { timeout: 60_000 }, async () => {
            if (!hasApiKey) return;

            // Run a one-shot
            await runAca(['say hello']);

            const sessionsDir = join(TEST_HOME, '.aca', 'sessions');
            const dirs = readdirSync(sessionsDir)
                .filter(d => d.startsWith('ses_'))
                .sort()
                .reverse();
            const latestDir = join(sessionsDir, dirs[0]);
            const convPath = join(latestDir, 'conversation.jsonl');

            expect(existsSync(convPath)).toBe(true);

            const lines = readFileSync(convPath, 'utf-8')
                .split('\n')
                .filter(l => l.trim().length > 0);

            // Should have at least: turn(active), user message, assistant message, step, turn(completed)
            expect(lines.length).toBeGreaterThanOrEqual(2);

            const records = lines.map(l => JSON.parse(l) as Record<string, unknown>);
            const hasUser = records.some(r => r.recordType === 'message' && r.role === 'user');
            const hasAssistant = records.some(r => r.recordType === 'message' && r.role === 'assistant');

            expect(hasUser).toBe(true);
            expect(hasAssistant).toBe(true);
        });
    });

    describe('error handling', () => {
        it('bad API key → stderr contains auth error and exit code 4', { timeout: 30_000 }, async () => {
            const { stderr, exitCode } = await runAca(['hello'], {
                env: { NANOGPT_API_KEY: 'bad-key-12345' },
            });
            expect(exitCode).toBe(4);
            expect(stderr).toContain('API key');
        });

        it('missing API key → stderr contains error and exit code 4', { timeout: 30_000 }, async () => {
            // Override key to empty AND set HOME to temp dir to prevent ~/.api_keys fallback
            const { mkdtempSync } = require('node:fs');
            const fakeHome = mkdtempSync(join(require('node:os').tmpdir(), 'aca-nohome-'));
            const env: Record<string, string> = { NANOGPT_API_KEY: '', HOME: fakeHome };
            const { stderr, exitCode } = await runAca(['hello'], { env });
            expect(exitCode).toBe(4);
            expect(stderr).toContain('API key');
        });

        it('invalid model → exits non-zero with error on stderr', { timeout: 30_000 }, async () => {
            if (!hasApiKey) return;

            const { stderr, exitCode } = await runAca(['--model', 'nonexistent/fake-model-xyz', 'hello']);
            expect(exitCode).not.toBe(0);
            expect(stderr.length).toBeGreaterThan(0);
        });
    });

    describe('invoke mode (executor)', () => {
        async function runInvoke(
            task: string,
            opts?: { env?: Record<string, string>; timeout?: number; args?: string[] },
        ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
            const request = JSON.stringify({
                contract_version: '1.0.0',
                schema_version: '1.0.0',
                task,
            });
            const env = {
                ...process.env,
                NODE_NO_WARNINGS: '1',
                HOME: TEST_HOME,
                ...apiKeyEnv,
                ...(opts?.env ?? {}),
            };
            return await new Promise((resolve) => {
                const child = spawn('node', [DIST_INDEX, 'invoke', ...(opts?.args ?? [])], {
                    cwd: ROOT,
                    env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });

                let stdout = '';
                let stderr = '';
                let settled = false;
                const timeoutMs = opts?.timeout ?? 60_000;

                const finalize = (exitCode: number) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve({ stdout, stderr, exitCode });
                };

                const timer = setTimeout(() => {
                    child.kill('SIGTERM');
                    finalize(1);
                }, timeoutMs);

                child.stdout.setEncoding('utf-8');
                child.stdout.on('data', (chunk: string) => {
                    stdout += chunk;
                });

                child.stderr.setEncoding('utf-8');
                child.stderr.on('data', (chunk: string) => {
                    stderr += chunk;
                });

                child.on('error', (error) => {
                    stderr += error.message;
                    finalize(1);
                });

                child.on('close', (code) => {
                    finalize(code ?? 1);
                });

                child.stdin.end(request);
            });
        }

        // TODO(M10.2): moonshotai/kimi-k2.5 (current project default) does not emit
        // usage stats in its SSE stream for trivial prompts. Re-enable or split when
        // model default changes or after NanoGPT driver gets per-model usage handling.
        it.skip('returns non-empty result with non-zero token usage', { timeout: 60_000 }, () => {
            if (!hasApiKey) return;

            const { stdout, exitCode } = runInvoke('Say hello in one word');
            expect(exitCode).toBe(0);

            const response = JSON.parse(stdout.trim());
            expect(response.status).toBe('success');
            expect(response.result.length).toBeGreaterThan(0);
            expect(response.usage).toBeDefined();
            expect(response.usage.input_tokens).toBeGreaterThan(0);
            expect(response.usage.output_tokens).toBeGreaterThan(0);
        });

        it('returns error for bad API key', { timeout: 30_000 }, async () => {
            const { stdout, exitCode } = await runInvoke('hello', {
                env: { NANOGPT_API_KEY: 'bad-key-12345' },
            });
            expect(exitCode).not.toBe(0);

            const response = JSON.parse(stdout.trim());
            expect(response.status).toBe('error');
            expect(response.errors.length).toBeGreaterThan(0);
        });

        it('returns structured error response (not empty success) on LLM failure', { timeout: 30_000 }, async () => {
            if (!hasApiKey) return;

            const { stdout, exitCode } = await runInvoke('hello', {
                env: {
                    ACA_MODEL_DEFAULT: 'nonexistent/fake-model-xyz-999',
                },
            });

            expect(exitCode).not.toBe(0);
            const response = JSON.parse(stdout.trim());
            expect(response.status).toBe('error');
            expect(response.errors.length).toBeGreaterThan(0);
        });

        it('accepts invoke --json as a backward-compatible alias', { timeout: 30_000 }, async () => {
            const { stdout, exitCode } = await runInvoke('hello', {
                args: ['--json'],
                env: { NANOGPT_API_KEY: 'bad-key-12345' },
            });
            expect(exitCode).not.toBe(0);

            const response = JSON.parse(stdout.trim());
            expect(response.status).toBe('error');
            expect(response.errors.length).toBeGreaterThan(0);
        });
    });

    describe('lastErrorCode propagation', () => {
        it('TurnResult includes lastErrorCode on auth error', async () => {
            // Unit test: mock provider returns auth error, check TurnResult.lastErrorCode
            const { TurnEngine } = await import('../../src/core/turn-engine.js');
            const { ToolRegistry } = await import('../../src/tools/tool-registry.js');
            const { ConversationWriter } = await import('../../src/core/conversation-writer.js');
            const { SequenceGenerator } = await import('../../src/types/sequence.js');
            const { mkdirSync, writeFileSync } = await import('node:fs');
            const { tmpdir } = await import('node:os');
            const { randomUUID } = await import('node:crypto');

            const dir = join(tmpdir(), `aca-auth-test-${randomUUID()}`);
            mkdirSync(dir, { recursive: true });
            const convPath = join(dir, 'conversation.jsonl');
            writeFileSync(convPath, '');

            const provider = {
                capabilities() {
                    return {
                        maxContext: 32000, maxOutput: 4096,
                        supportsTools: 'native' as const, supportsVision: false,
                        supportsStreaming: true, supportsPrefill: false,
                        supportsEmbedding: false, embeddingModels: [],
                        toolReliability: 'good' as const,
                        costPerMillion: { input: 0, output: 0 },
                        specialFeatures: [], bytesPerToken: 3,
                    };
                },
                async *stream() {
                    yield { type: 'error' as const, error: { code: 'llm.auth_error', message: 'Unauthorized' } };
                },
                validate() {
                    return { ok: true as const, value: undefined };
                },
            };

            const engine = new TurnEngine(
                provider,
                new ToolRegistry(),
                new ConversationWriter(convPath),
                new SequenceGenerator(0),
            );

            const result = await engine.executeTurn(
                {
                    sessionId: 'ses_TEST000000000000000000000' as import('../../src/types/ids.js').SessionId,
                    model: 'mock', provider: 'mock',
                    interactive: false, autoConfirm: false,
                    isSubAgent: false, workspaceRoot: dir,
                },
                'hello',
                [],
            );

            expect(result.turn.outcome).toBe('aborted');
            expect(result.lastError).toEqual({ code: 'llm.auth_error', message: 'Unauthorized' });
        });
    });
});
