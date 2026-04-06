import { lstat, unlink, readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { checkZone } from './workspace-sandbox.js';

export const deletePathSpec: ToolSpec = {
    name: 'delete_path',
    description: 'Delete a file or directory. Requires recursive=true for non-empty directories.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', minLength: 1 },
            recursive: { type: 'boolean' },
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

function successOutput(deleted: number): ToolOutput {
    const data = JSON.stringify({ deleted });
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
}

/** Count all items under a path (including the path itself). */
async function countItems(targetPath: string): Promise<number> {
    const info = await lstat(targetPath);
    if (!info.isDirectory()) return 1;
    const entries = await readdir(targetPath);
    let count = 1; // count the directory itself
    for (const entry of entries) {
        count += await countItems(join(targetPath, entry));
    }
    return count;
}

export const deletePathImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const targetPath = args.path as string;
    const recursive = (args.recursive as boolean | undefined) ?? false;

    // Zone check — must be within allowed sandbox zones
    const denied = await checkZone(targetPath, context);
    if (denied) return denied;

    let pathStat;
    try {
        pathStat = await lstat(targetPath);
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'ENOENT') {
            return errorOutput('tool.not_found', `Path not found: ${targetPath}`);
        }
        if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
            return errorOutput('tool.permission_denied', `Permission denied: ${targetPath}`);
        }
        return errorOutput('tool.io_error', `Cannot access path: ${targetPath} (${nodeErr.code ?? 'unknown'})`);
    }

    if (pathStat.isDirectory()) {
        if (!recursive) {
            let entries: string[];
            try {
                entries = await readdir(targetPath);
            } catch (err: unknown) {
                const nodeErr = err as NodeJS.ErrnoException;
                return errorOutput('tool.io_error', `Cannot read directory: ${targetPath} (${nodeErr.code ?? 'unknown'})`);
            }
            if (entries.length > 0) {
                return errorOutput(
                    'tool.not_empty',
                    `Directory is not empty: ${targetPath}. Use recursive=true to delete non-empty directories.`,
                );
            }
            try {
                await rmdir(targetPath);
            } catch (err: unknown) {
                const nodeErr = err as NodeJS.ErrnoException;
                if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
                    return errorOutput('tool.permission_denied', `Permission denied: ${targetPath}`);
                }
                return errorOutput('tool.io_error', `Cannot delete directory: ${targetPath} (${nodeErr.code ?? 'unknown'})`);
            }
            return successOutput(1);
        }

        // Recursive delete: count before removing
        let deleted: number;
        try {
            deleted = await countItems(targetPath);
            await rm(targetPath, { recursive: true, force: false });
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
                return errorOutput('tool.permission_denied', `Permission denied: ${targetPath}`);
            }
            return errorOutput('tool.io_error', `Cannot delete: ${targetPath} (${nodeErr.code ?? 'unknown'})`);
        }
        return successOutput(deleted);
    }

    // File or symlink
    try {
        await unlink(targetPath);
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
            return errorOutput('tool.permission_denied', `Permission denied: ${targetPath}`);
        }
        return errorOutput('tool.io_error', `Cannot delete: ${targetPath} (${nodeErr.code ?? 'unknown'})`);
    }
    return successOutput(1);
};
