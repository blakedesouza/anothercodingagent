import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { processRegistry, killProcessTree } from './process-registry.js';
import type { ProcessRecord } from './process-registry.js';
import { analyzeCommand } from './command-risk-analyzer.js';

// Maximum wait time when wait=true and no output is buffered.
const WAIT_TIMEOUT_MS = 5_000;

// --- Tool spec ---

export const sessionIoSpec: ToolSpec = {
    name: 'session_io',
    description:
        'Read from and/or write to an open session. Optionally send a signal. ' +
        'Returns buffered output and process status.',
    inputSchema: {
        type: 'object',
        properties: {
            session_id: { type: 'string', minLength: 1 },
            stdin: { type: 'string' },
            signal: {
                type: 'string',
                enum: ['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGHUP'],
            },
            wait: { type: 'boolean' },
        },
        required: ['session_id'],
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

/**
 * Wait until new data is added to the record's outputBuffer, the process exits,
 * or the timeout/abort fires. Does not wait if output is already buffered.
 */
function waitForOutput(
    record: ProcessRecord,
    timeoutMs: number,
    signal: AbortSignal,
): Promise<void> {
    if (record.outputBuffer.length > 0 || record.exited) {
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        let done = false;

        const finish = (): void => {
            if (!done) {
                done = true;
                resolve();
            }
        };

        // Listener added to the record — fired when stdout/stderr data arrives.
        record.dataListeners.push(finish);

        // Listen for process exit.
        const onClose = (): void => {
            const idx = record.dataListeners.indexOf(finish);
            if (idx !== -1) record.dataListeners.splice(idx, 1);
            finish();
        };
        record.closeListeners.push(onClose);

        const timer = setTimeout(() => {
            const idx = record.dataListeners.indexOf(finish);
            if (idx !== -1) record.dataListeners.splice(idx, 1);
            const cidx = record.closeListeners.indexOf(onClose);
            if (cidx !== -1) record.closeListeners.splice(cidx, 1);
            finish();
        }, timeoutMs);

        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                const idx = record.dataListeners.indexOf(finish);
                if (idx !== -1) record.dataListeners.splice(idx, 1);
                const cidx = record.closeListeners.indexOf(onClose);
                if (cidx !== -1) record.closeListeners.splice(cidx, 1);
                finish();
            },
            { once: true },
        );
    });
}

// --- Implementation ---

export const sessionIoImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const sessionHandle = args.session_id as string;
    const stdinInput = args.stdin as string | undefined;
    const signalName = args.signal as NodeJS.Signals | undefined;
    const shouldWait = (args.wait as boolean | undefined) ?? false;

    const record = processRegistry.lookup(context.sessionId, sessionHandle);
    if (!record) {
        return errorOutput(
            'tool.not_found',
            `Session not found: ${sessionHandle}`,
        );
    }

    // Send signal if requested.
    if (signalName) {
        if (record.exited) {
            return errorOutput('tool.session_exited', 'Session has already exited');
        }
        killProcessTree(record.pid, signalName);
        record.lastActivity = Date.now();
    }

    // Write stdin if provided.
    if (stdinInput !== undefined && !record.exited) {
        // Risk analysis: forbidden stdin is blocked before delivery to the shell process.
        const stdinRisk = analyzeCommand(
            stdinInput,
            context.workspaceRoot,
            undefined,
            context.workspaceRoot,
        );
        if (stdinRisk.tier === 'forbidden') {
            return errorOutput(
                'tool.risk_forbidden',
                `Stdin blocked by risk analyzer: ${stdinRisk.reason}`,
            );
        }

        await new Promise<void>((resolve, reject) => {
            record.process.stdin!.write(stdinInput, (err) => {
                if (err) reject(err);
                else resolve();
            });
        }).catch(() => {
            // Ignore write errors (process may have exited between the check and write).
        });
        record.lastActivity = Date.now();
    }

    // Optionally wait for output.
    if (shouldWait) {
        await waitForOutput(record, WAIT_TIMEOUT_MS, context.signal);
    }

    // Drain the output buffer and reset the byte counter so new output is accepted.
    const output = record.outputBuffer.splice(0).join('');
    record.outputBufferBytes = 0;
    if (output.length > 0) {
        record.lastActivity = Date.now();
    }

    const status = record.exited ? 'exited' : 'running';
    const data = JSON.stringify({
        output,
        status,
        exit_code: record.exited ? record.exitCode : null,
        exit_signal: record.exited ? record.exitSignal : null,
    });

    return {
        status: 'success',
        data,
        truncated: false,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'process',
    };
};
