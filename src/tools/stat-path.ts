import { lstat } from 'node:fs/promises';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { checkZone, resolveToolPath } from './workspace-sandbox.js';

export const statPathSpec: ToolSpec = {
    name: 'stat_path',
    description: 'Get metadata about a file or directory without reading its contents.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', minLength: 1 },
        },
        required: ['path'],
        additionalProperties: false,
    },
    approvalClass: 'read-only',
    idempotent: true,
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

export const statPathImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const targetPath = args.path as string;

    // Zone check — must be within allowed sandbox zones
    const denied = await checkZone(targetPath, context);
    if (denied) return denied;
    const resolvedPath = resolveToolPath(targetPath, context);

    let s;
    try {
        s = await lstat(resolvedPath);
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'ENOENT') {
            const data = JSON.stringify({ exists: false });
            return {
                status: 'success',
                data,
                truncated: false,
                bytesReturned: Buffer.byteLength(data, 'utf8'),
                bytesOmitted: 0,
                retryable: false,
                timedOut: false,
                mutationState: 'none',
            };
        }
        if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
            return errorOutput('tool.permission_denied', `Permission denied: ${targetPath}`);
        }
        return errorOutput('tool.io_error', `Cannot stat path: ${targetPath} (${nodeErr.code ?? 'unknown'})`);
    }

    let kind: string;
    if (s.isFile()) {
        kind = 'file';
    } else if (s.isDirectory()) {
        kind = 'directory';
    } else if (s.isSymbolicLink()) {
        kind = 'symlink';
    } else {
        kind = 'other';
    }

    // Format permissions as 4-digit octal string (e.g. "0644")
    const permissions = (s.mode & 0o777).toString(8).padStart(4, '0');

    const result = {
        exists: true,
        kind,
        size: s.size,
        mtime: s.mtimeMs,
        permissions,
    };

    const data = JSON.stringify(result);
    return {
        status: 'success',
        data,
        truncated: false,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    };
};
