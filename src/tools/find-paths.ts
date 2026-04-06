import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { checkZone } from './workspace-sandbox.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const findPathsSpec: ToolSpec = {
    name: 'find_paths',
    description: 'Find files or directories matching a glob pattern. Hard max 200 matches, default limit 50.',
    inputSchema: {
        type: 'object',
        properties: {
            root: { type: 'string', minLength: 1 },
            pattern: { type: 'string', minLength: 1 },
            type: { type: 'string', enum: ['file', 'directory', 'any'] },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
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

/** Convert a glob pattern to a RegExp. Handles **, *, ?, character classes [...], and special char escaping. */
function globToRegex(pattern: string): RegExp {
    let result = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*' && pattern[i + 1] === '*') {
            result += '.*';
            i += 2;
            // Consume an optional trailing slash after **
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
 * Patterns without a path separator are matched against the basename only,
 * so `*.ts` finds `.ts` files in any subdirectory.
 * Patterns with a path separator are matched against the full relative path.
 */
function matchesGlob(relPath: string, pattern: string): boolean {
    const regex = globToRegex(pattern);
    if (!pattern.includes('/')) {
        return regex.test(basename(relPath));
    }
    return regex.test(relPath);
}

/**
 * Parse .gitignore content into a list of exclusion regexes.
 * Only handles basic patterns (no negations, no extended globbing).
 */
function parseGitignorePatterns(content: string): RegExp[] {
    const patterns: RegExp[] = [];
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        // Remove trailing slash (directory indicator)
        const p = line.endsWith('/') ? line.slice(0, -1) : line;
        if (p.includes('/')) {
            // Anchored to root: match from start
            patterns.push(globToRegex(p));
        } else {
            // Unanchored: match basename anywhere in the tree
            const baseRegex = globToRegex(p);
            patterns.push(new RegExp(`(^|/)${baseRegex.source.slice(1, -1)}(/|$)`));
        }
    }
    return patterns;
}

function isIgnoredByGitignore(relPath: string, patterns: RegExp[]): boolean {
    return patterns.some(pat => pat.test(relPath));
}

interface PathMatch {
    path: string;
    kind: 'file' | 'directory';
    size: number;
    mtime: number;
}

export const findPathsImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const root = args.root as string;
    const pattern = args.pattern as string;
    const typeFilter = (args.type as string | undefined) ?? 'any';
    const rawLimit = (args.limit as number | undefined) ?? DEFAULT_LIMIT;
    const limit = Math.min(rawLimit, MAX_LIMIT);

    // Zone check — root must be within allowed sandbox zones
    const denied = await checkZone(root, context);
    if (denied) return denied;

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

    // Load .gitignore patterns from the root
    let gitignorePatterns: RegExp[] = [];
    try {
        const gitignoreContent = await readFile(join(root, '.gitignore'), 'utf8');
        gitignorePatterns = parseGitignorePatterns(gitignoreContent);
    } catch {
        // No .gitignore — fine
    }

    const matches: PathMatch[] = [];
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

            // Apply .gitignore exclusions
            if (isIgnoredByGitignore(relPath, gitignorePatterns)) continue;

            const isDir = entry.isDirectory();
            const isFile = entry.isFile();

            const kindMatches =
                typeFilter === 'any' ||
                (typeFilter === 'file' && isFile) ||
                (typeFilter === 'directory' && isDir);

            if (kindMatches && matchesGlob(relPath, pattern)) {
                try {
                    const s = await stat(fullPath);
                    matches.push({
                        path: fullPath,
                        kind: isDir ? 'directory' : 'file',
                        size: s.size,
                        mtime: s.mtimeMs,
                    });
                } catch {
                    // skip entries we can't stat
                }
            }

            // Don't recurse into symlinks — avoids cycles on platforms where
            // entry.isDirectory() returns true for directory symlinks (e.g. Windows junctions)
            if (isDir && !entry.isSymbolicLink()) {
                await walk(fullPath);
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
