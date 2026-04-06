/**
 * Workspace Sandbox — Zone-based filesystem boundary enforcement.
 *
 * All file system tools call checkZone() before any operation.
 * exec_command is NOT sandboxed here (uses CommandRiskAnalyzer instead).
 *
 * Allowed zones:
 *   1. workspaceRoot (and descendants)
 *   2. ~/.aca/sessions/<sessionId>/
 *   3. /tmp/aca-<sessionId>/
 *   4. User-configured extraTrustedRoots
 */

import { realpath } from 'node:fs/promises';
import { resolve, dirname, basename, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolContext } from './tool-registry.js';

/**
 * Check whether a target path falls within the allowed zones for this session.
 * Returns null if allowed, or a permission_denied ToolOutput if denied.
 *
 * Works for both existing and non-existing paths:
 * - Existing paths: resolved via fs.realpath (follows symlinks)
 * - Non-existing paths: nearest existing ancestor resolved via realpath,
 *   remaining components validated (no '..' traversal)
 *
 * Security notes:
 * - TOCTOU: There is a race window between checkZone() and the actual filesystem
 *   operation. This is best-effort per spec — perfect prevention requires openat(2)
 *   which isn't exposed by Node.js fs promises API. An attacker exploiting this
 *   window would need write access to a trusted zone and sub-millisecond timing.
 */
export async function checkZone(
    targetPath: string,
    context: ToolContext,
): Promise<ToolOutput | null> {
    // Reject null bytes — prevents truncation attacks where fs APIs see a different
    // path than the zone check (e.g., "file\0/../../../etc/passwd")
    if (targetPath.includes('\0')) {
        return permissionDenied(targetPath, '[contains null byte]');
    }

    const absolutePath = isAbsolute(targetPath)
        ? targetPath
        : resolve(context.workspaceRoot, targetPath);

    const resolved = await resolvePathSafely(absolutePath);
    const zones = computeZones(context);

    for (const zone of zones) {
        const resolvedZone = await resolvePathSafely(zone);
        if (isWithin(resolved, resolvedZone)) return null;
    }

    return permissionDenied(targetPath, resolved);
}

// --- Internal helpers (exported for testing) ---

/**
 * Resolve a path to its canonical form, handling non-existent paths.
 * For existing paths, uses fs.realpath() to resolve symlinks.
 * For non-existent paths, resolves the nearest existing ancestor
 * and appends the remaining literal components.
 */
export async function resolvePathSafely(inputPath: string): Promise<string> {
    const normalized = resolve(inputPath);

    // Fast path: full path exists — realpath resolves all symlinks
    try {
        return await realpath(normalized);
    } catch {
        // Path doesn't fully exist — walk up to nearest existing ancestor
    }

    let current = normalized;
    const tail: string[] = [];

    while (current !== dirname(current)) {
        tail.unshift(basename(current));
        current = dirname(current);

        try {
            const resolvedAncestor = await realpath(current);
            // Defense-in-depth: remaining components should never contain '..'
            // after resolve() already collapsed them, but guard anyway
            if (tail.some(component => component === '..')) {
                return resolvedAncestor;
            }
            return join(resolvedAncestor, ...tail);
        } catch {
            continue;
        }
    }

    // Root reached — reconstruct from root
    return join(current, ...tail);
}

/** Check if resolvedPath is within (or equal to) resolvedZone. */
export function isWithin(resolvedPath: string, resolvedZone: string): boolean {
    if (resolvedPath === resolvedZone) return true;
    return resolvedPath.startsWith(resolvedZone + '/');
}

/** Validate sessionId contains only safe characters (alphanumeric, underscore, hyphen). */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Compute allowed zone paths from context. */
export function computeZones(context: ToolContext): string[] {
    const home = homedir();
    const zones = [context.workspaceRoot];

    // Defense-in-depth: validate sessionId format before using in path construction.
    // sessionId is system-generated (ses_ + ULID) but we guard against injection.
    if (SESSION_ID_RE.test(context.sessionId)) {
        zones.push(join(home, '.aca', 'sessions', context.sessionId));
        zones.push(`/tmp/aca-${context.sessionId}`);
    }

    if (context.extraTrustedRoots) {
        for (const root of context.extraTrustedRoots) {
            // Validate: must be a non-empty absolute path, not filesystem root,
            // and no null bytes. Relative or root paths silently ignored.
            if (root && isAbsolute(root) && root !== '/' && !root.includes('\0')) {
                zones.push(root);
            }
        }
    }
    return zones;
}

/** Build a permission-denied ToolOutput. */
function permissionDenied(originalPath: string, resolvedPath: string): ToolOutput {
    const message = originalPath === resolvedPath
        ? `Path outside workspace sandbox: ${originalPath}`
        : `Path outside workspace sandbox: ${originalPath} (resolves to ${resolvedPath})`;

    return {
        status: 'error',
        data: '',
        error: {
            code: 'tool.sandbox',
            message,
            retryable: false,
        },
        truncated: false,
        bytesReturned: 0,
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    };
}
