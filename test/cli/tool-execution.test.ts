import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import {
    existsSync,
    readFileSync,
    readdirSync,
    mkdtempSync,
    rmSync,
    unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { loadSecrets } from '../../src/config/secrets.js';
import { ensureBuiltCliFresh } from '../helpers/built-cli.js';

const ROOT = join(import.meta.dirname, '..', '..');
const DIST_INDEX = join(ROOT, 'dist', 'index.js');
const execFileAsync = promisify(execFile);

/** Isolated HOME for test sessions — prevents polluting user's real ~/.aca/ */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'aca-tool-test-'));

/** Check if a real NanoGPT key is available. */
let hasApiKey = false;
let apiKeyEnv: Record<string, string> = {};
let rawApiKey = '';

beforeAll(async () => {
    ensureBuiltCliFresh(ROOT, DIST_INDEX);
    const result = await loadSecrets();
    const key = result.secrets.nanogpt;
    if (key && key.trim() !== '') {
        hasApiKey = true;
        rawApiKey = key;
        apiKeyEnv = { NANOGPT_API_KEY: key };
    }
});

afterAll(() => {
    // Clean up temp files created by tests
    const smokeFile = join(ROOT, '.aca-smoke-test.txt');
    if (existsSync(smokeFile)) {
        try { unlinkSync(smokeFile); } catch { /* best-effort */ }
    }
    // Clean up isolated TEST_HOME to prevent /tmp leaks
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * Helper: run `node dist/index.js <args>` with the built standalone CLI.
 * HOME is set to an isolated temp dir to prevent polluting user sessions.
 */
async function runAca(
    args: string[],
    options?: { env?: Record<string, string>; timeout?: number; cwd?: string },
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
            cwd: options?.cwd ?? ROOT,
            encoding: 'utf-8',
            timeout: options?.timeout ?? 120_000,
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

/** Find the most recently created session directory under TEST_HOME. */
function findLatestSession(): string | null {
    const sessionsDir = join(TEST_HOME, '.aca', 'sessions');
    if (!existsSync(sessionsDir)) return null;
    const dirs = readdirSync(sessionsDir)
        .filter(d => d.startsWith('ses_'))
        .sort()
        .reverse();
    return dirs.length > 0 ? join(sessionsDir, dirs[0]) : null;
}

/** Parse all JSONL records from a session's conversation.jsonl */
function readConversationJsonl(sessionDir: string): Record<string, unknown>[] {
    const convPath = join(sessionDir, 'conversation.jsonl');
    if (!existsSync(convPath)) return [];
    const lines = readFileSync(convPath, 'utf-8')
        .split('\n')
        .filter(l => l.trim().length > 0);
    return lines.map((l, i) => {
        try {
            return JSON.parse(l) as Record<string, unknown>;
        } catch {
            throw new Error(`Malformed JSONL at line ${i + 1} in ${convPath}: ${l.slice(0, 100)}`);
        }
    });
}

describe('M8.3 — Real Tool Execution', () => {
    describe('read_file tool', () => {
        it('reads package.json and returns project name via real LLM', { timeout: 120_000 }, async () => {
            if (!hasApiKey) return;

            const { stdout, exitCode } = await runAca([
                '--no-confirm',
                'Read the file package.json in the current directory and tell me only the project name. Reply with just the name, nothing else.',
            ]);

            expect(exitCode).toBe(0);
            // The LLM should return something containing the project name
            expect(stdout.toLowerCase()).toContain('anothercodingagent');
        });
    });

    describe('write_file tool', () => {
        it('creates a file in the workspace via real LLM', { timeout: 180_000 }, async () => {
            if (!hasApiKey) return;

            const targetFile = join(ROOT, '.aca-smoke-test.txt');
            // Clean up from prior runs
            if (existsSync(targetFile)) unlinkSync(targetFile);

            const { exitCode } = await runAca(
                [
                    '--no-confirm',
                    `Create a file at the absolute path ${targetFile} with exactly this content: hello from aca`,
                ],
                { timeout: 180_000 },
            );

            expect(exitCode).toBe(0);
            expect(existsSync(targetFile)).toBe(true);

            const content = readFileSync(targetFile, 'utf-8');
            expect(content).toContain('hello from aca');
        });
    });

    describe('exec_command tool', () => {
        it('runs echo command and returns output via real LLM', { timeout: 120_000 }, async () => {
            if (!hasApiKey) return;

            await runAca([
                '--no-confirm',
                'Run the shell command: echo hello world. Then tell me what the output was.',
            ]);

            // Verify via conversation.jsonl that exec_command ran and captured output.
            // The LLM may not produce a follow-up text response (tool_error outcome),
            // so we check the durable log rather than exit code or stdout.
            const sessionDir = findLatestSession();
            expect(sessionDir).not.toBeNull();

            const records = readConversationJsonl(sessionDir!);
            const toolResults = records.filter(
                r => r.recordType === 'tool_result' && r.toolName === 'exec_command',
            );
            expect(toolResults.length).toBeGreaterThan(0);

            const output = toolResults[0].output as { status: string; data: string };
            expect(output.status).toBe('success');
            expect(output.data).toContain('hello world');
        });
    });

    describe('conversation.jsonl contains tool records', () => {
        it('has tool_call parts in assistant messages and tool_result records', { timeout: 120_000 }, async () => {
            if (!hasApiKey) return;

            // Run a tool-using prompt
            await runAca([
                '--no-confirm',
                'Use the read_file tool to read package.json in the current directory. Then say "done".',
            ]);

            const sessionDir = findLatestSession();
            expect(sessionDir).not.toBeNull();

            const records = readConversationJsonl(sessionDir!);
            expect(records.length).toBeGreaterThan(0);

            // Check for assistant message with tool_call parts
            const assistantMessages = records.filter(
                r => r.recordType === 'message' && r.role === 'assistant',
            );
            const hasToolCall = assistantMessages.some(msg => {
                const parts = msg.parts as Array<{ type: string }>;
                return Array.isArray(parts) && parts.some(p => p.type === 'tool_call');
            });
            expect(hasToolCall).toBe(true);

            // Check for tool_result records
            const toolResults = records.filter(r => r.recordType === 'tool_result');
            expect(toolResults.length).toBeGreaterThan(0);
        });
    });

    describe('--no-confirm auto-approval', () => {
        it('auto-approves workspace-write tools without prompting', { timeout: 120_000 }, async () => {
            if (!hasApiKey) return;

            const targetFile = join(ROOT, '.aca-smoke-test.txt');
            if (existsSync(targetFile)) unlinkSync(targetFile);

            // --no-confirm should auto-approve write_file without TTY prompt
            const { exitCode: ec, stderr } = await runAca([
                '--no-confirm',
                `Create a file at ${targetFile} containing the text "smoke test passed"`,
            ]);

            expect(ec).toBe(0);
            // Should not contain permission errors
            expect(stderr).not.toContain('tool.permission');
            expect(existsSync(targetFile)).toBe(true);
        });
    });

    describe('sandbox enforcement', () => {
        it('blocks write_file outside workspace with clear error', { timeout: 120_000 }, async () => {
            if (!hasApiKey) return;

            // /root/ is outside all trusted zones — even --no-confirm won't bypass sandbox.
            // Retry up to 2 times if the LLM times out before producing a tool call.
            let toolResults: Record<string, unknown>[] = [];
            for (let attempt = 0; attempt < 2; attempt++) {
                await runAca([
                    '--no-confirm',
                    'Use write_file to create a file at /root/aca-sandbox-test.txt with content "should fail". Report whether it succeeded or failed.',
                ]);

                const sessionDir = findLatestSession();
                expect(sessionDir).not.toBeNull();

                const records = readConversationJsonl(sessionDir!);
                toolResults = records.filter(
                    r => r.recordType === 'tool_result' && r.toolName === 'write_file',
                );
                if (toolResults.length > 0) break;
                // LLM timed out without producing a tool call — retry
            }

            expect(toolResults.length).toBeGreaterThan(0);

            const output = toolResults[0].output as {
                status: string;
                error?: { code: string; message: string };
            };
            expect(output.status).toBe('error');
            expect(output.error?.code).toBe('tool.sandbox');
            expect(output.error?.message).toContain('outside workspace sandbox');

            // The file must NOT exist
            expect(existsSync('/root/aca-sandbox-test.txt')).toBe(false);
        });
    });

    describe('secret scrubbing', () => {
        it('API key does not appear in conversation.jsonl', { timeout: 120_000 }, async () => {
            if (!hasApiKey) return;
            if (!rawApiKey || rawApiKey.length < 8) return; // need real key to test

            // Run any tool-using prompt to generate conversation log
            await runAca([
                '--no-confirm',
                'Read the file package.json and tell me the version.',
            ]);

            const sessionDir = findLatestSession();
            expect(sessionDir).not.toBeNull();

            const convPath = join(sessionDir!, 'conversation.jsonl');
            expect(existsSync(convPath)).toBe(true);

            const convContent = readFileSync(convPath, 'utf-8');
            // The raw API key should never appear in the conversation log
            expect(convContent).not.toContain(rawApiKey);
        });
    });
});
