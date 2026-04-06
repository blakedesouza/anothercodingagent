import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { checkZone } from './workspace-sandbox.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const searchTextSpec: ToolSpec = {
    name: 'search_text',
    description: 'Search for a regex or exact text pattern across files. Hard max 200 matches, default limit 50.',
    inputSchema: {
        type: 'object',
        properties: {
            root: { type: 'string', minLength: 1 },
            pattern: { type: 'string', minLength: 1 },
            file_globs: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
            },
            context_lines: { type: 'integer', minimum: 0, maximum: 10 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            exact: { type: 'boolean' },
        },
        required: ['root', 'pattern'],
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

/** Escape a string for use as a literal regex pattern. */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert a glob pattern to a RegExp. Handles **, *, ?, character classes [...], and special char escaping. */
function globToRegex(pattern: string): RegExp {
    let result = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*' && pattern[i + 1] === '*') {
            result += '.*';
            i += 2;
            if (pattern[i] === '/') i++;
        } else if (ch === '*') {
            result += '[^/]*';
            i++;
        } else if (ch === '?') {
            result += '[^/]';
            i++;
        } else if (ch === '[') {
            // Preserve character classes as-is (e.g., [abc], [a-z], [!abc])
            const closeIdx = pattern.indexOf(']', i + 1);
            if (closeIdx === -1) {
                // Unclosed bracket — treat as literal
                result += '\\[';
                i++;
            } else {
                result += pattern.slice(i, closeIdx + 1);
                i = closeIdx + 1;
            }
        } else if ('()+.^$|{}\\'.includes(ch)) {
            result += '\\' + ch;
            i++;
        } else {
            result += ch;
            i++;
        }
    }
    return new RegExp(`^${result}$`);
}

/**
 * Test whether a relative path matches a glob pattern.
 * Patterns without a path separator are matched against the basename.
 */
function matchesGlob(relPath: string, pattern: string): boolean {
    const regex = globToRegex(pattern);
    if (!pattern.includes('/')) {
        return regex.test(basename(relPath));
    }
    return regex.test(relPath);
}

interface SearchMatch {
    file: string;
    line: number;
    content: string;
    context_before: string[];
    context_after: string[];
}

export const searchTextImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const root = args.root as string;
    const pattern = args.pattern as string;
    const fileGlobs = (args.file_globs as string[] | undefined) ?? [];
    const contextLines = (args.context_lines as number | undefined) ?? 0;
    const rawLimit = (args.limit as number | undefined) ?? DEFAULT_LIMIT;
    const limit = Math.min(rawLimit, MAX_LIMIT);
    const exact = (args.exact as boolean | undefined) ?? false;

    // Zone check — root must be within allowed sandbox zones
    const denied = await checkZone(root, context);
    if (denied) return denied;

    // Build search regex
    let searchRegex: RegExp;
    try {
        searchRegex = new RegExp(exact ? escapeRegex(pattern) : pattern);
    } catch (err: unknown) {
        return errorOutput('tool.invalid_input', `Invalid regex pattern: ${(err as Error).message}`);
    }

    // Verify root is a directory
    try {
        const rootStat = await stat(root);
        if (!rootStat.isDirectory()) {
            return errorOutput('tool.not_directory', `Root is not a directory: ${root}`);
        }
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'ENOENT') {
            return errorOutput('tool.not_found', `Root directory not found: ${root}`);
        }
        return errorOutput('tool.io_error', `Cannot access root: ${root} (${nodeErr.code ?? 'unknown'})`);
    }

    const matches: SearchMatch[] = [];
    let truncated = false;

    async function walk(dir: string): Promise<void> {
        if (matches.length >= limit) {
            truncated = true;
            return;
        }

        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return; // skip unreadable directories
        }

        for (const entry of entries) {
            if (matches.length >= limit) {
                truncated = true;
                return;
            }

            const fullPath = join(dir, entry.name);
            const relPath = relative(root, fullPath);

            // Don't recurse into symlinks — avoids cycles on platforms where
            // entry.isDirectory() returns true for directory symlinks (e.g. Windows junctions)
            if (entry.isDirectory() && !entry.isSymbolicLink()) {
                await walk(fullPath);
                continue;
            }

            if (!entry.isFile()) continue;

            // Apply file glob filter if provided
            if (fileGlobs.length > 0 && !fileGlobs.some(glob => matchesGlob(relPath, glob))) continue;

            // Read file, skip binary files
            let content: string | undefined;
            try {
                const buf = await readFile(fullPath);
                const checkLen = Math.min(buf.length, 1024);
                let isBinary = false;
                for (let j = 0; j < checkLen; j++) {
                    if (buf[j] === 0) { isBinary = true; break; }
                }
                if (!isBinary) {
                    content = buf.toString('utf8');
                }
            } catch {
                // skip unreadable files
            }
            if (content === undefined) continue;

            const lines = content.split('\n');
            for (let lineIdx = 0; lineIdx < lines.length && matches.length < limit; lineIdx++) {
                if (searchRegex.test(lines[lineIdx])) {
                    const contextBefore = lines.slice(Math.max(0, lineIdx - contextLines), lineIdx);
                    const contextAfter = lines.slice(lineIdx + 1, Math.min(lines.length, lineIdx + 1 + contextLines));
                    matches.push({
                        file: fullPath,
                        line: lineIdx + 1, // 1-indexed
                        content: lines[lineIdx],
                        context_before: contextBefore,
                        context_after: contextAfter,
                    });
                }
            }
        }
    }

    await walk(root);

    const data = JSON.stringify({ matches, truncated });
    return {
        status: 'success',
        data,
        truncated,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    };
};
