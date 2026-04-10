import { mkdir, stat } from 'node:fs/promises';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { checkZone, resolveToolPath } from './workspace-sandbox.js';

export const makeDirectorySpec: ToolSpec = {
    name: 'make_directory',
    description:
        'Create a directory and all necessary parent directories in one operation. ' +
        'If the directory already exists the call succeeds and returns created=false; it is safe to call unconditionally as an idempotent setup step.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', minLength: 1 },
        },
        required: ['path'],
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

export const makeDirectoryImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const dirPath = args.path as string;

    // Zone check — must be within allowed sandbox zones
    const denied = await checkZone(dirPath, context);
    if (denied) return denied;
    const targetPath = resolveToolPath(dirPath, context);

    // Check if path already exists
    let alreadyExisted = false;
    try {
        const s = await stat(targetPath);
        if (!s.isDirectory()) {
            return errorOutput('tool.not_directory', `Path exists but is not a directory: ${dirPath}`);
        }
        alreadyExisted = true;
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code !== 'ENOENT') {
            return errorOutput('tool.io_error', `Cannot access path: ${dirPath} (${nodeErr.code ?? 'unknown'})`);
        }
    }

    if (!alreadyExisted) {
        try {
            await mkdir(targetPath, { recursive: true });
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
                return errorOutput('tool.permission_denied', `Permission denied: ${dirPath}`);
            }
            return errorOutput('tool.io_error', `Cannot create directory: ${dirPath} (${nodeErr.code ?? 'unknown'})`);
        }
    }

    const data = JSON.stringify({ created: !alreadyExisted });
    return {
        status: 'success',
        data,
        truncated: false,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: alreadyExisted ? 'none' : 'filesystem',
    };
};
