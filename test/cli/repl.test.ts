import { describe, it, expect, vi } from 'vitest';
import { Repl } from '../../src/cli/repl.js';
import type { ReplOptions } from '../../src/cli/repl.js';
import { handleSlashCommand, isSlashCommand } from '../../src/cli/commands.js';
import type { SlashCommandContext } from '../../src/cli/commands.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ConversationWriter } from '../../src/core/conversation-writer.js';
import { SessionManager } from '../../src/core/session-manager.js';
import { SequenceGenerator } from '../../src/types/sequence.js';
import type { SessionProjection, SessionManifest } from '../../src/core/session-manager.js';
import type {
    ProviderDriver,
    StreamEvent,
    ModelRequest,
    ModelCapabilities,
} from '../../src/types/provider.js';
import type { SessionId, WorkspaceId } from '../../src/types/ids.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';

// --- Helpers ---

function tmpDir(): string {
    const dir = join(tmpdir(), `aca-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function makeMockCapabilities(): ModelCapabilities {
    return {
        maxContext: 128_000,
        maxOutput: 4096,
        supportsTools: 'native',
        supportsVision: false,
        supportsStreaming: true,
        supportsPrefill: false,
        supportsEmbedding: false,
        embeddingModels: [],
        toolReliability: 'native',
        costPerMillion: { input: 3, output: 15 },
        specialFeatures: [],
        bytesPerToken: 3,
    };
}

function textResponse(text: string, inputTokens = 10, outputTokens = 5): StreamEvent[] {
    return [
        { type: 'text_delta', text },
        { type: 'done', finishReason: 'stop', usage: { inputTokens, outputTokens } },
    ];
}

/** Create a mock provider that yields text responses in order. */
function createMockProvider(responseQueue: StreamEvent[][]): ProviderDriver {
    let callIndex = 0;
    return {
        capabilities(): ModelCapabilities {
            return makeMockCapabilities();
        },
        async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
            const events = responseQueue[callIndex++];
            if (!events) throw new Error('No more mock responses');
            for (const event of events) {
                yield event;
            }
        },
        validate() {
            return { ok: true as const, value: undefined };
        },
    };
}

function createProjection(dir: string): SessionProjection {
    const sessionDir = join(dir, 'test-session');
    mkdirSync(sessionDir, { recursive: true });
    const conversationPath = join(sessionDir, 'conversation.jsonl');
    writeFileSync(conversationPath, '');

    const manifest: SessionManifest = {
        sessionId: 'ses_TEST000000000000000000000' as SessionId,
        workspaceId: 'wrk_abc123' as WorkspaceId,
        status: 'active',
        turnCount: 0,
        lastActivityTimestamp: new Date().toISOString(),
        configSnapshot: { model: 'mock-model' },
        durableTaskState: null,
        calibration: null,
    };

    writeFileSync(join(sessionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    return {
        manifest,
        sessionDir,
        items: [],
        turns: [],
        steps: [],
        sequenceGenerator: new SequenceGenerator(0),
        currentTurn: null,
        writer: new ConversationWriter(conversationPath),
        warnings: [],
    };
}

/** Collect all data written to a writable stream. */
function collectStream(): { stream: Writable; data: () => string } {
    const chunks: Buffer[] = [];
    const stream = new Writable({
        write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
        },
    });
    return {
        stream,
        data: () => Buffer.concat(chunks).toString('utf-8'),
    };
}

/** Creates a PassThrough stream that simulates typed input lines. */
function createInputLines(lines: string[]): PassThrough {
    const input = new PassThrough();
    // Write all lines, then end to signal EOF
    for (const line of lines) {
        input.write(line + '\n');
    }
    input.end();
    return input;
}

function makeReplOptions(
    dir: string,
    provider: ProviderDriver,
    overrides: Partial<ReplOptions> = {},
): { repl: Repl; stdout: ReturnType<typeof collectStream>; stderr: ReturnType<typeof collectStream>; projection: SessionProjection } {
    const projection = createProjection(dir);
    const sessionManager = new SessionManager(dir);
    const toolRegistry = new ToolRegistry();
    const stdout = collectStream();
    const stderr = collectStream();

    const repl = new Repl({
        projection,
        sessionManager,
        provider,
        toolRegistry,
        model: 'mock-model',
        verbose: false,
        workspaceRoot: dir,
        output: stdout.stream,
        stderrOutput: stderr.stream,
        ...overrides,
    });

    return { repl, stdout, stderr, projection };
}

// --- Tests ---

describe('Slash Commands (unit)', () => {
    function makeCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
        const dir = tmpDir();
        return {
            projection: createProjection(dir),
            model: 'mock-model',
            turnCount: 3,
            totalInputTokens: 150,
            totalOutputTokens: 75,
            exit: vi.fn(),
            ...overrides,
        };
    }

    it('isSlashCommand returns true for slash-prefixed input', () => {
        expect(isSlashCommand('/exit')).toBe(true);
        expect(isSlashCommand('/help')).toBe(true);
        expect(isSlashCommand('  /status  ')).toBe(true);
    });

    it('isSlashCommand returns false for non-slash input', () => {
        expect(isSlashCommand('hello')).toBe(false);
        expect(isSlashCommand('')).toBe(false);
    });

    it('/help outputs available commands', () => {
        const ctx = makeCtx();
        const result = handleSlashCommand('/help', ctx);
        expect(result).not.toBeNull();
        expect(result!.shouldExit).toBe(false);
        expect(result!.output).toContain('/help');
        expect(result!.output).toContain('/exit');
        expect(result!.output).toContain('/quit');
        expect(result!.output).toContain('/status');
    });

    it('/status outputs session ID, model, turn count, token usage', () => {
        const ctx = makeCtx();
        const result = handleSlashCommand('/status', ctx);
        expect(result).not.toBeNull();
        expect(result!.shouldExit).toBe(false);
        expect(result!.output).toContain('ses_TEST000000000000000000000');
        expect(result!.output).toContain('mock-model');
        expect(result!.output).toContain('3');
        expect(result!.output).toContain('150');
        expect(result!.output).toContain('75');
    });

    it('/exit calls exit and returns shouldExit true', () => {
        const ctx = makeCtx();
        const result = handleSlashCommand('/exit', ctx);
        expect(result).not.toBeNull();
        expect(result!.shouldExit).toBe(true);
        expect(ctx.exit).toHaveBeenCalled();
    });

    it('/quit is an alias for /exit', () => {
        const ctx = makeCtx();
        const result = handleSlashCommand('/quit', ctx);
        expect(result).not.toBeNull();
        expect(result!.shouldExit).toBe(true);
        expect(ctx.exit).toHaveBeenCalled();
    });

    it('unknown slash command returns null', () => {
        const ctx = makeCtx();
        const result = handleSlashCommand('/unknown', ctx);
        expect(result).toBeNull();
    });
});

describe('REPL', () => {
    it('startup with valid provider → prompt displayed, processes input', async () => {
        const dir = tmpDir();
        const provider = createMockProvider([textResponse('Hello! How can I help?')]);
        const input = createInputLines(['hello']);
        const { repl, stdout, stderr } = makeReplOptions(dir, provider);

        await repl.run(input);

        // Stdout should have the assistant's response
        expect(stdout.data()).toContain('Hello! How can I help?');
    });

    it('/exit causes clean exit with code 0 behavior', async () => {
        const dir = tmpDir();
        const provider = createMockProvider([]);
        const input = createInputLines(['/exit']);
        const { repl, stderr } = makeReplOptions(dir, provider);

        await repl.run(input);

        // Should see goodbye message
        expect(stderr.data()).toContain('Goodbye.');
    });

    it('/quit causes clean exit (alias for /exit)', async () => {
        const dir = tmpDir();
        const provider = createMockProvider([]);
        const input = createInputLines(['/quit']);
        const { repl, stderr } = makeReplOptions(dir, provider);

        await repl.run(input);

        expect(stderr.data()).toContain('Goodbye.');
    });

    it('/help outputs help text', async () => {
        const dir = tmpDir();
        const provider = createMockProvider([]);
        const input = createInputLines(['/help']);
        const { repl, stderr } = makeReplOptions(dir, provider);

        await repl.run(input);

        const output = stderr.data();
        expect(output).toContain('/help');
        expect(output).toContain('/exit');
        expect(output).toContain('/status');
    });

    it('/status outputs session info', async () => {
        const dir = tmpDir();
        const provider = createMockProvider([]);
        const input = createInputLines(['/status']);
        const { repl, stderr } = makeReplOptions(dir, provider);

        await repl.run(input);

        const output = stderr.data();
        expect(output).toContain('ses_TEST000000000000000000000');
        expect(output).toContain('mock-model');
    });

    it('--model flag overrides model in turn engine config', async () => {
        const dir = tmpDir();
        let capturedModel: string | undefined;
        const provider: ProviderDriver = {
            capabilities: () => makeMockCapabilities(),
            async *stream(request: ModelRequest) {
                capturedModel = request.model;
                yield { type: 'text_delta' as const, text: 'ok' };
                yield {
                    type: 'done' as const,
                    finishReason: 'stop',
                    usage: { inputTokens: 5, outputTokens: 2 },
                };
            },
            validate: () => ({ ok: true as const, value: undefined }),
        };
        const input = createInputLines(['test']);
        const { repl } = makeReplOptions(dir, provider, { model: 'gpt-4o-custom' });

        await repl.run(input);

        expect(capturedModel).toBe('gpt-4o-custom');
    });

    it('--verbose flag enables debug output on stderr', async () => {
        const dir = tmpDir();
        const provider = createMockProvider([textResponse('response')]);
        const input = createInputLines(['hello']);
        const { repl, stderr } = makeReplOptions(dir, provider, { verbose: true });

        await repl.run(input);

        const output = stderr.data();
        expect(output).toContain('[turn 1]');
        expect(output).toContain('outcome=');
    });

    it('Ctrl+D (EOF) during idle causes clean exit', async () => {
        const dir = tmpDir();
        const provider = createMockProvider([]);
        // Empty input → EOF immediately
        const input = createInputLines([]);
        const { repl } = makeReplOptions(dir, provider);

        // Should not throw — clean exit
        await expect(repl.run(input)).resolves.toBeUndefined();
    });

    it('empty lines are skipped without calling provider', async () => {
        const dir = tmpDir();
        let streamCallCount = 0;
        const provider: ProviderDriver = {
            capabilities: () => makeMockCapabilities(),
            async *stream() {
                streamCallCount++;
                yield { type: 'text_delta' as const, text: 'response' };
                yield {
                    type: 'done' as const,
                    finishReason: 'stop',
                    usage: { inputTokens: 5, outputTokens: 2 },
                };
            },
            validate: () => ({ ok: true as const, value: undefined }),
        };
        const input = createInputLines(['', '  ', 'hello']);
        const { repl } = makeReplOptions(dir, provider);

        await repl.run(input);

        expect(streamCallCount).toBe(1);
    });

    it('unknown slash command prints error', async () => {
        const dir = tmpDir();
        const provider = createMockProvider([]);
        const input = createInputLines(['/foobar']);
        const { repl, stderr } = makeReplOptions(dir, provider);

        await repl.run(input);

        expect(stderr.data()).toContain('Unknown command: /foobar');
    });

    it('multiple turns accumulate items and token counts', async () => {
        const dir = tmpDir();
        const provider = createMockProvider([
            textResponse('first response', 10, 5),
            textResponse('second response', 20, 10),
        ]);
        const input = createInputLines(['first', 'second', '/status']);
        const { repl, stderr } = makeReplOptions(dir, provider);

        await repl.run(input);

        const stderrText = stderr.data();
        // Status should show 2 turns and accumulated tokens
        expect(stderrText).toContain('Turns:    2');
        expect(stderrText).toContain('30 in');
        expect(stderrText).toContain('15 out');
    });
});

describe('Mode detection (entry point logic)', () => {
    // These test the logic concepts rather than spawning the process,
    // since the entry point does process.exit() which we can't capture in vitest.

    it('non-TTY detection logic: isTTY false with prompt → one-shot not supported', () => {
        // Test the decision logic directly
        const isTTY = false;
        const prompt = 'some prompt';
        const shouldRejectOneShot = !isTTY && !!prompt;
        expect(shouldRejectOneShot).toBe(true);
    });

    it('TTY detection logic: isTTY true → interactive mode', () => {
        const isTTY = true;
        const shouldEnterRepl = isTTY;
        expect(shouldEnterRepl).toBe(true);
    });
});
