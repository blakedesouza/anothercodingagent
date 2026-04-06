import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { processRegistry, killProcessTree } from './process-registry.js';

// How long to wait for the process to exit after sending the kill signal.
const CLOSE_WAIT_MS = 5_000;

// --- Tool spec ---

export const closeSessionSpec: ToolSpec = {
    name: 'close_session',
    description:
        'Kill a persistent session and clean up its resources. ' +
        'Sends a signal to the process group (default: SIGTERM) and waits for exit.',
    inputSchema: {
        type: 'object',
        properties: {
            session_id: { type: 'string', minLength: 1 },
            signal: {
                type: 'string',
                enum: ['SIGTERM', 'SIGINT', 'SIGKILL', 'SIGHUP'],
            },
        },
        required: ['session_id'],
        additionalProperties: false,
    },
    approvalClass: 'external-effect',
    idempotent: false,
    timeoutCategory: 'shell',
};

// --- Implementation ---

export const closeSessionImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const sessionHandle = args.session_id as string;
    const signalName = (args.signal as NodeJS.Signals | undefined) ?? 'SIGTERM';

    const record = processRegistry.lookup(context.sessionId, sessionHandle);
    if (!record) {
        // Idempotent: session already closed (or never existed) — desired state achieved.
        const data = JSON.stringify({
            session_id: sessionHandle,
            exit_code: null,
            exit_signal: null,
            status: 'already_closed',
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
    }

    // Build a promise that resolves when the process exits (or timeout).
    const exitPromise = new Promise<{ code: number | null; signal: string | null }>(
        (resolve) => {
            if (record.exited) {
                resolve({ code: record.exitCode, signal: record.exitSignal });
                return;
            }

            const onClose = (code: number | null, sig: string | null): void => {
                resolve({ code, signal: sig });
            };
            record.closeListeners.push(onClose);

            setTimeout(() => {
                const idx = record.closeListeners.indexOf(onClose);
                if (idx !== -1) record.closeListeners.splice(idx, 1);
                // Force-kill and resolve if still running after wait.
                if (!record.exited) {
                    try {
                        killProcessTree(record.pid, 'SIGKILL');
                    } catch {
                        // Already gone.
                    }
                }
                resolve({ code: record.exitCode, signal: record.exitSignal });
            }, CLOSE_WAIT_MS);
        },
    );

    // Send the requested signal to the process group.
    if (!record.exited) {
        killProcessTree(record.pid, signalName);
    }

    const { code, signal } = await exitPromise;

    // Remove from registry.
    processRegistry.remove(context.sessionId, sessionHandle);

    const data = JSON.stringify({
        session_id: sessionHandle,
        exit_code: code,
        exit_signal: signal,
        status: 'closed',
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
