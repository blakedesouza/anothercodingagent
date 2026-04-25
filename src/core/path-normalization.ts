import { posix } from 'node:path';
import {
    isAbsolutePath,
    isPathWithin,
    normalizePathForComparison,
    relativePathWithInputStyle,
    resolvePathWithInputStyle,
} from './path-comparison.js';

function toPortablePath(value: string): string {
    return value.split(/[\\/]+/).join('/');
}

export function normalizeTrackedPath(rawPath: string, workspaceRoot?: string): string | undefined {
    const trimmed = rawPath.trim();
    if (!trimmed) return undefined;

    if (!workspaceRoot) {
        return toPortablePath(
            isAbsolutePath(trimmed)
                ? normalizePathForComparison(trimmed)
                : posix.normalize(toPortablePath(trimmed)),
        );
    }

    const resolvedPath = isAbsolutePath(trimmed)
        ? normalizePathForComparison(trimmed)
        : resolvePathWithInputStyle(workspaceRoot, trimmed);
    if (isPathWithin(workspaceRoot, resolvedPath)) {
        const rel = relativePathWithInputStyle(workspaceRoot, resolvedPath);
        return rel === '' ? '.' : toPortablePath(rel);
    }

    return toPortablePath(normalizePathForComparison(resolvedPath));
}

export function normalizeTrackedPaths(paths: readonly string[], workspaceRoot?: string): string[] {
    const normalized: string[] = [];
    for (const rawPath of paths) {
        const nextPath = normalizeTrackedPath(rawPath, workspaceRoot);
        if (nextPath) normalized.push(nextPath);
    }
    return normalized;
}
