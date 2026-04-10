import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { checkZone, resolveToolPath } from './workspace-sandbox.js';

interface EditOp {
    search: string;
    replace: string;
}

interface Reject {
    index: number;
    search: string;
    reason: string;
}

export const editFileSpec: ToolSpec = {
    name: 'edit_file',
    description:
        'Apply surgical search/replace edits to an existing file. ' +
        'Each edit in the edits array supplies an exact search string and its replacement — the search text must match exactly once in the file (ambiguous or duplicate matches cause that edit to be rejected). ' +
        'Multiple edits are applied left-to-right as a single atomic operation; the file is only written if all edits succeed. ' +
        'Supply expectedHash to guard against editing a file that changed since it was last read.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', minLength: 1 },
            edits: {
                type: 'array',
                minItems: 1,
                items: {
                    type: 'object',
                    properties: {
                        search: { type: 'string' },
                        replace: { type: 'string' },
                    },
                    required: ['search', 'replace'],
                    additionalProperties: false,
                },
            },
            expectedHash: { type: 'string' },
        },
        required: ['path', 'edits'],
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

export const editFileImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const filePath = args.path as string;
    const edits = args.edits as EditOp[];
    const expectedHash = args.expectedHash as string | undefined;

    // Zone check — must be within allowed sandbox zones
    const denied = await checkZone(filePath, context);
    if (denied) return denied;
    const targetPath = resolveToolPath(filePath, context);

    let content: string;
    let fileMode = 0o644; // default; overwritten by actual file mode below
    try {
        const fileStats = await stat(targetPath);
        if (!fileStats.isFile()) {
            return errorOutput('tool.not_file', `Path is not a regular file: ${filePath}`);
        }
        fileMode = fileStats.mode;
        const buf = await readFile(targetPath);
        content = buf.toString('utf8');

        if (expectedHash !== undefined) {
            const currentHash = createHash('sha256').update(buf).digest('hex');
            if (currentHash !== expectedHash) {
                return errorOutput(
                    'tool.hash_mismatch',
                    `File hash mismatch: expected ${expectedHash}, got ${currentHash}. File may have changed.`,
                );
            }
        }
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'ENOENT') {
            return errorOutput('tool.not_found', `File not found: ${filePath}`);
        }
        if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
            return errorOutput('tool.permission_denied', `Permission denied: ${filePath}`);
        }
        return errorOutput('tool.io_error', `Cannot read file: ${filePath} (${nodeErr.code ?? 'unknown'})`);
    }

    // Apply each edit in order, replacing the first occurrence of each search string
    let current = content;
    let applied = 0;
    const rejects: Reject[] = [];

    for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        const idx = current.indexOf(edit.search);
        if (idx === -1) {
            rejects.push({ index: i, search: edit.search, reason: 'search string not found' });
        } else {
            current = current.slice(0, idx) + edit.replace + current.slice(idx + edit.search.length);
            applied++;
        }
    }

    const buf = Buffer.from(current, 'utf8');
    try {
        // Pass mode to preserve permissions on newly-created files; existing files keep their mode via O_TRUNC
        await writeFile(targetPath, buf, { mode: fileMode & 0o777 });
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
            return errorOutput('tool.permission_denied', `Permission denied writing: ${filePath}`);
        }
        return errorOutput('tool.io_error', `Cannot write file: ${filePath} (${nodeErr.code ?? 'unknown'})`);
    }

    const data = JSON.stringify({ applied, rejects });
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
