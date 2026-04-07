import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

function isWithinDirectory(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function validateRequiredOutputPaths(workspaceRoot: string, paths: readonly string[] | undefined): string[] {
    if (!paths || paths.length === 0) return [];
    const root = resolve(workspaceRoot);
    const missingOrEmpty: string[] = [];
    for (const rawPath of paths) {
        const trimmed = rawPath.trim();
        if (!trimmed) continue;
        const fullPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);
        if (!isWithinDirectory(root, fullPath)) {
            missingOrEmpty.push(trimmed);
            continue;
        }
        try {
            const stat = existsSync(fullPath) ? statSync(fullPath) : undefined;
            if (!stat?.isFile() || stat.size <= 0) {
                missingOrEmpty.push(trimmed);
            }
        } catch {
            missingOrEmpty.push(trimmed);
        }
    }
    return missingOrEmpty;
}
