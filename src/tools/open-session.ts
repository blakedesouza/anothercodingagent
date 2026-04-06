import { spawn } from 'node:child_process';
import { ulid } from 'ulid';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { processRegistry } from './process-registry.js';
import type { ProcessRecord } from './process-registry.js';
import { analyzeCommand } from './command-risk-analyzer.js';

// Wait this long after spawn before returning initial output.
const INITIAL_WAIT_MS = 100;

// Maximum bytes buffered between session_io calls. Once exceeded, new output is dropped.
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10 MiB

// --- Tool spec ---

export const openSessionSpec: ToolSpec = {
    name: 'open_session',
    description:
        'Spawn a persistent shell session. Returns a session handle for use with ' +
        'session_io and close_session.',
    inputSchema: {
        type: 'object',
        properties: {
            command: { type: 'string', minLength: 1 },
            cwd: { type: 'string', minLength: 1 },
            env: {
                type: 'object',
                additionalProperties: { type: 'string' },
            },
        },
        required: ['command'],
        additionalProperties: false,
    },
    approvalClass: 'external-effect',
    idempotent: false,
    timeoutCategory: 'shell',
};

// --- Helpers ---

function errorOutput(code: string, message: string): ToolOutput {
    return {
        status: 'error',
        data: '',
        error: { code, message, retryable: false },
        truncated: false,
        bytesReturned: 0,
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'process',
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Implementation ---

export const openSessionImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const command = args.command as string;
    const cwd = (args.cwd as string | undefined) ?? context.workspaceRoot;
    const envOverrides = args.env as Record<string, string> | undefined;
    const env = envOverrides ? { ...process.env, ...envOverrides } : process.env;

    // Risk analysis: forbidden commands are blocked before spawn.
    const riskAssessment = analyzeCommand(command, cwd, envOverrides, context.workspaceRoot);
    if (riskAssessment.tier === 'forbidden') {
        return errorOutput(
            'tool.risk_forbidden',
            `Command blocked by risk analyzer: ${riskAssessment.reason}`,
        );
    }

    const handle = `psh_${ulid()}`;

    // Spawn via /bin/sh. detached: true creates a new process group (pgid = child.pid),
    // enabling tree-kill and clean cleanup.
    const child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
    });

    // Build the ProcessRecord before attaching listeners so callbacks can reference it.
    const record: ProcessRecord = {
        handle,
        sessionId: context.sessionId,
        pid: 0, // set once spawn succeeds
        process: child,
        startTime: Date.now(),
        lastActivity: Date.now(),
        exited: false,
        exitCode: null,
        exitSignal: null,
        outputBuffer: [],
        outputBufferBytes: 0,
        dataListeners: [],
        closeListeners: [],
    };

    return new Promise<ToolOutput>((resolve) => {
        // Guards against double-resolution from concurrent handlers.
        let resolved = false;
        const finish = (out: ToolOutput): void => {
            if (!resolved) {
                resolved = true;
                resolve(out);
            }
        };

        child.on('error', (err) => {
            finish(errorOutput('tool.spawn_failed', `Failed to spawn session: ${err.message}`));
        });

        child.on('close', (code, sig) => {
            record.exited = true;
            record.exitCode = code;
            record.exitSignal = sig ? String(sig) : null;
            // Notify any waiting close listeners (used by close_session).
            const listeners = record.closeListeners.splice(0);
            for (const fn of listeners) fn(code, sig ? String(sig) : null);
            // If setImmediate hasn't resolved yet (process exited before the 100ms wait),
            // resolve with an error so the caller is never left hanging.
            finish(
                errorOutput(
                    'tool.session_exited',
                    `Session process exited immediately (code ${code ?? 'unknown'})`,
                ),
            );
        });

        const appendOutput = (chunk: Buffer): void => {
            if (record.outputBufferBytes < MAX_BUFFER_BYTES) {
                const str = chunk.toString('utf8');
                const bytes = Buffer.byteLength(str, 'utf8');
                record.outputBuffer.push(str);
                record.outputBufferBytes += bytes;
            }
            record.lastActivity = Date.now();
            const listeners = record.dataListeners.splice(0);
            for (const fn of listeners) fn();
        };

        child.stdout!.on('data', appendOutput);
        child.stderr!.on('data', appendOutput);

        // Use setImmediate to give the 'error' event one event-loop iteration to fire
        // if spawn fails synchronously. On success, proceed to the registration path.
        setImmediate(async () => {
            if (record.exited) {
                // 'close' (or 'error') handler already resolved.
                return;
            }

            if (child.pid === undefined) {
                finish(errorOutput('tool.spawn_failed', 'Spawn produced no PID'));
                return;
            }

            record.pid = child.pid;

            // unref so the Node.js process can exit even if the session remains open.
            child.unref();

            // Register in the process registry.
            processRegistry.register(context.sessionId, record);

            // Wait briefly for initial output (e.g., shell prompts, banners).
            await sleep(INITIAL_WAIT_MS);

            const initialOutput = record.outputBuffer.splice(0).join('');
            record.outputBufferBytes = 0;

            const data = JSON.stringify({
                session_id: handle,
                initial_output: initialOutput,
                pid: record.pid,
            });

            finish({
                status: 'success',
                data,
                truncated: false,
                bytesReturned: Buffer.byteLength(data, 'utf8'),
                bytesOmitted: 0,
                retryable: false,
                timedOut: false,
                mutationState: 'process',
            });
        });
    });
};
