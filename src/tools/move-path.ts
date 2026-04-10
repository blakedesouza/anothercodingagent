import { rename, lstat } from 'node:fs/promises';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { checkZone, resolveToolPath } from './workspace-sandbox.js';

export const movePathSpec: ToolSpec = {
    name: 'move_path',
    description:
        'Move or rename a file or directory to a new path. ' +
        'The operation is atomic; if a file already existed at the destination it is overwritten and the response includes conflict=true. ' +
        'Both source and destination must be within the workspace sandbox.',
    inputSchema: {
        type: 'object',
        properties: {
            source: { type: 'string', minLength: 1 },
            destination: { type: 'string', minLength: 1 },
        },
        required: ['source', 'destination'],
        additionalProperties: false,
    },
    approvalClass: 'workspace-write',
    idempotent: false,
    timeoutCategory: 'file',
};

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
        mutationState: 'none',
    };
}

export const movePathImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const source = args.source as string;
    const destination = args.destination as string;

    // Zone check — both source and destination must be in allowed zones
    const srcDenied = await checkZone(source, context);
    if (srcDenied) return srcDenied;
    const dstDenied = await checkZone(destination, context);
    if (dstDenied) return dstDenied;
    const sourcePath = resolveToolPath(source, context);
    const destinationPath = resolveToolPath(destination, context);

    // Verify source exists
    try {
        await lstat(sourcePath);
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'ENOENT') {
            return errorOutput('tool.not_found', `Source not found: ${source}`);
        }
        return errorOutput('tool.io_error', `Cannot access source: ${source} (${nodeErr.code ?? 'unknown'})`);
    }

    // Check whether destination already exists (for conflict flag)
    let conflict = false;
    try {
        await lstat(destinationPath);
        conflict = true;
    } catch {
        // destination doesn't exist — no conflict
    }

    try {
        await rename(sourcePath, destinationPath);
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
            return errorOutput('tool.permission_denied', `Permission denied moving ${source}`);
        }
        if (nodeErr.code === 'EXDEV') {
            return errorOutput('tool.io_error', `Cannot move across filesystems: ${source} → ${destination}`);
        }
        return errorOutput('tool.io_error', `Cannot move: ${source} → ${destination} (${nodeErr.code ?? 'unknown'})`);
    }

    const data = JSON.stringify({ result: 'moved', conflict });
    return {
        status: 'success',
        data,
        truncated: false,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'filesystem',
    };
};
