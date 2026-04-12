import { spawn } from 'node:child_process';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';

// 62 KiB combined budget for stdout+stderr content; leaves ~3.5 KiB for JSON overhead.
const COMBINED_CAP = 62_000;

// Collection limit per stream — prevents OOM on pathological output.
const MAX_COLLECT_PER_STREAM = 4 * 1024 * 1024; // 4 MiB

const DEFAULT_TIMEOUT_MS = 60_000;

// --- Tool spec ---

export const execCommandSpec: ToolSpec = {
    name: 'exec_command',
    description:
        'Execute a shell command and capture stdout, stderr, exit code, and wall-clock duration. ' +
        'Combined output is capped at ~62 KiB; oversized output is preserved head+tail with an omission marker in the middle. ' +
        'Default timeout is 60 seconds; pass a custom timeout in milliseconds to override. ' +
        'Use cwd to set the working directory and env to inject additional environment variables on top of the inherited process environment.',
    inputSchema: {
        type: 'object',
        properties: {
            command: { type: 'string', minLength: 1 },
            cwd: { type: 'string', minLength: 1 },
            env: {
                type: 'object',
                additionalProperties: { type: 'string' },
            },
            timeout: { type: 'number', minimum: 0 },
        },
        required: ['command'],
        additionalProperties: false,
    },
    approvalClass: 'external-effect',
    idempotent: false,
    timeoutCategory: 'shell',
};

// --- Helpers ---

function errorOutput(code: string, message: string, timedOut = false): ToolOutput {
    return {
        status: 'error',
        data: '',
        error: { code, message, retryable: false },
        truncated: false,
        bytesReturned: 0,
        bytesOmitted: 0,
        retryable: false,
        timedOut,
        mutationState: 'indeterminate',
    };
}

/**
 * Keep the first and last `half` bytes of `buf` with an omission marker between them.
 * Returns the full string unchanged if buf fits within maxBytes.
 */
function headTail(buf: Buffer, maxBytes: number): { text: string; truncated: boolean } {
    if (maxBytes <= 0) {
        return { text: '', truncated: buf.length > 0 };
    }
    if (buf.length <= maxBytes) {
        return { text: buf.toString('utf8'), truncated: false };
    }
    const half = Math.floor(maxBytes / 2);
    const head = buf.subarray(0, half);
    const tail = buf.subarray(buf.length - half);
    const omitted = buf.length - maxBytes;
    const text =
        head.toString('utf8') +
        `\n[... ${omitted} bytes omitted ...]\n` +
        tail.toString('utf8');
    return { text, truncated: true };
}

interface StreamResult {
    stdoutText: string;
    stderrText: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
}

/**
 * Apply the combined 64 KiB cap to stdout and stderr buffers.
 * Allocates the cap proportionally by stream size, then applies head+tail to each.
 */
function applyOutputCap(stdoutBuf: Buffer, stderrBuf: Buffer): StreamResult {
    const combined = stdoutBuf.length + stderrBuf.length;
    if (combined <= COMBINED_CAP) {
        return {
            stdoutText: stdoutBuf.toString('utf8'),
            stderrText: stderrBuf.toString('utf8'),
            stdoutTruncated: false,
            stderrTruncated: false,
        };
    }
    // Proportional allocation: larger stream gets a proportionally larger share.
    const stdoutAlloc =
        combined > 0 ? Math.round(COMBINED_CAP * (stdoutBuf.length / combined)) : 0;
    const stderrAlloc = COMBINED_CAP - stdoutAlloc;

    const { text: stdoutText, truncated: stdoutTruncated } = headTail(stdoutBuf, stdoutAlloc);
    const { text: stderrText, truncated: stderrTruncated } = headTail(stderrBuf, stderrAlloc);
    return { stdoutText, stderrText, stdoutTruncated, stderrTruncated };
}

// --- Implementation ---

export const execCommandImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const command = args.command as string;
    const cwd = (args.cwd as string | undefined) ?? context.workspaceRoot;
    const envOverrides = args.env as Record<string, string> | undefined;
    const timeoutMs =
        typeof args.timeout === 'number' ? args.timeout : DEFAULT_TIMEOUT_MS;

    const env = envOverrides ? { ...process.env, ...envOverrides } : process.env;

    // Shell interpretation via /bin/sh -c is intentional — this tool is a shell
    // execution primitive. The security boundary is enforced upstream by the
    // approval layer (src/permissions/approval.ts) before this function is
    // reached. Callers must not pass command strings without prior approval.
    // Shell metacharacters in `command` are interpreted as intended.
    // detached: true places the child in its own process group (pgid = child.pid),
    // enabling tree-kill via process.kill(-pgid, signal).
    const child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout!.on('data', (chunk: Buffer) => {
        if (stdoutBytes < MAX_COLLECT_PER_STREAM) {
            stdoutChunks.push(chunk);
            stdoutBytes += chunk.length;
        }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
        if (stderrBytes < MAX_COLLECT_PER_STREAM) {
            stderrChunks.push(chunk);
            stderrBytes += chunk.length;
        }
    });

    const startTime = Date.now();

    return new Promise<ToolOutput>((resolve) => {
        let resolved = false;
        // Declared before killAndTimeout so the closure can reference it for cleanup.
        let abortHandler: (() => void) | undefined;

        const finish = (output: ToolOutput): void => {
            if (!resolved) {
                resolved = true;
                resolve(output);
            }
        };

        // Kill the process group and return a timeout error.
        const killAndTimeout = (reason: string): void => {
            clearTimeout(timeoutId);
            if (abortHandler) context.signal.removeEventListener('abort', abortHandler);
            try {
                if (child.pid !== undefined) {
                    process.kill(-child.pid, 'SIGKILL');
                }
            } catch {
                child.kill('SIGKILL');
            }
            // Explicitly destroy stdio streams so the 'close' event fires promptly
            // rather than waiting for the OS to drain piped file descriptors.
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(errorOutput('tool.timeout', reason, true));
        };

        // Tool-level timeout.
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        if (timeoutMs !== Infinity && timeoutMs > 0) {
            timeoutId = setTimeout(
                () => killAndTimeout(`Command exceeded ${timeoutMs}ms timeout`),
                timeoutMs,
            );
        }

        // AbortSignal from ToolRunner (outer timeout or cancellation).
        abortHandler = (): void => {
            clearTimeout(timeoutId);
            killAndTimeout('Command was aborted');
        };
        context.signal.addEventListener('abort', abortHandler, { once: true });

        child.on('error', (err) => {
            clearTimeout(timeoutId);
            context.signal.removeEventListener('abort', abortHandler);
            finish(errorOutput('tool.spawn_failed', `Failed to spawn command: ${err.message}`));
        });

        child.on('close', (code) => {
            clearTimeout(timeoutId);
            context.signal.removeEventListener('abort', abortHandler);

            const duration = Date.now() - startTime;
            const stdoutBuf = Buffer.concat(stdoutChunks);
            const stderrBuf = Buffer.concat(stderrChunks);

            const { stdoutText, stderrText, stdoutTruncated, stderrTruncated } =
                applyOutputCap(stdoutBuf, stderrBuf);

            const data = JSON.stringify({
                exit_code: code ?? -1,
                stdout: stdoutText,
                stderr: stderrText,
                duration_ms: duration,
                stdout_truncated: stdoutTruncated,
                stderr_truncated: stderrTruncated,
            });

            finish({
                status: 'success',
                data,
                truncated: stdoutTruncated || stderrTruncated,
                bytesReturned: Buffer.byteLength(data, 'utf8'),
                bytesOmitted: 0,
                retryable: false,
                timedOut: false,
                mutationState: 'indeterminate',
            });
        });
    });
};
