import { writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { checkZone, resolveToolPath } from './workspace-sandbox.js';

export const writeFileSpec: ToolSpec = {
    name: 'write_file',
    description: 'Create or fully replace a file with the given content. Creates parent directories if needed.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', minLength: 1 },
            content: { type: 'string' },
            mode: { type: 'string', enum: ['create', 'overwrite'] },
        },
        required: ['path', 'content'],
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

export const writeFileImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const filePath = args.path as string;
    const content = args.content as string;
    const mode = (args.mode as string | undefined) ?? 'overwrite';

    // Zone check — must be within allowed sandbox zones
    const denied = await checkZone(filePath, context);
    if (denied) return denied;
    const targetPath = resolveToolPath(filePath, context);

    // Create parent directories first (needed regardless of mode)
    const parent = dirname(targetPath);
    if (parent && parent !== '.') {
        try {
            await mkdir(parent, { recursive: true });
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
                return errorOutput('tool.permission_denied', `Permission denied creating parent directories: ${parent}`);
            }
            return errorOutput('tool.io_error', `Cannot create parent directories for ${filePath}: ${nodeErr.message}`);
        }
    }

    // Use 'wx' flag for create mode to get atomic O_CREAT|O_EXCL semantics (no TOCTOU window)
    const flag = mode === 'create' ? 'wx' : 'w';
    const buf = Buffer.from(content, 'utf8');
    try {
        await fsWriteFile(targetPath, buf, { flag });
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'EEXIST') {
            return errorOutput('tool.already_exists', `File already exists: ${filePath}`);
        }
        if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
            return errorOutput('tool.permission_denied', `Permission denied: ${filePath}`);
        }
        return errorOutput('tool.io_error', `Cannot write file: ${filePath} (${nodeErr.code ?? 'unknown'})`);
    }

    const hash = createHash('sha256').update(buf).digest('hex');
    const data = JSON.stringify({ bytes_written: buf.length, hash });

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
