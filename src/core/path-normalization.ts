import { isAbsolute, normalize, relative, resolve } from 'node:path';

function isWithinDirectory(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function normalizeTrackedPath(rawPath: string, workspaceRoot?: string): string | undefined {
    const trimmed = rawPath.trim();
    if (!trimmed) return undefined;

    if (!workspaceRoot) {
        return isAbsolute(trimmed) ? resolve(trimmed) : normalize(trimmed);
    }

    const root = resolve(workspaceRoot);
    const resolvedPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);
    if (isWithinDirectory(root, resolvedPath)) {
        const rel = relative(root, resolvedPath);
        return rel === '' ? '.' : normalize(rel);
    }

    return resolvedPath;
}

export function normalizeTrackedPaths(paths: readonly string[], workspaceRoot?: string): string[] {
    const normalized: string[] = [];
    for (const rawPath of paths) {
        const nextPath = normalizeTrackedPath(rawPath, workspaceRoot);
        if (nextPath) normalized.push(nextPath);
    }
    return normalized;
}
