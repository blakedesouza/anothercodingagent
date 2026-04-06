/**
 * Log retention — time-based pruning with size cap (Block 19, M5.6).
 *
 * Runs at session start (not a background daemon). Processes at most
 * MAX_SESSIONS_PER_RUN expired sessions per startup to avoid slow starts.
 *
 * Policy:
 *   - Sessions > retentionDays: remove directory, mark pruned in SQLite
 *   - Sessions > COMPRESS_AFTER_DAYS: gzip JSONL files, remove blobs
 *   - Total > maxSizeGb: prune oldest sessions until under limit
 *   - SQLite records are always retained (with pruned flag)
 */

import {
    readdirSync,
    readFileSync,
    statSync,
    unlinkSync,
    rmSync,
    existsSync,
    createReadStream,
    createWriteStream,
} from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { SqliteStore } from './sqlite-store.js';
import type { WarnFn } from './sqlite-store.js';

// --- Constants ---

const COMPRESS_AFTER_DAYS = 7;
const MAX_SESSIONS_PER_RUN = 10;
const BYTES_PER_GB = 1024 * 1024 * 1024;

// --- Types ---

export interface RetentionConfig {
    days: number;
    maxSizeGb: number;
}

export interface RetentionResult {
    pruned: number;
    compressed: number;
    sizeReclaimed: number;
}

interface SessionInfo {
    sessionId: string;
    dir: string;
    lastActivity: Date;
    sizeBytes: number;
}

// --- Public API ---

/**
 * Run the retention policy on the sessions directory.
 * Called at session start. Non-destructive to SQLite records.
 *
 * @returns Summary of actions taken.
 */
export async function runRetention(
    sessionsDir: string,
    store: SqliteStore | null,
    config: RetentionConfig,
    warn: WarnFn = () => {},
): Promise<RetentionResult> {
    const result: RetentionResult = { pruned: 0, compressed: 0, sizeReclaimed: 0 };

    if (!existsSync(sessionsDir)) return result;

    // Scan session directories and read manifests
    const sessions = scanSessions(sessionsDir, warn);
    if (sessions.length === 0) return result;

    // Sort oldest first (oldest = most likely to prune)
    sessions.sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime());

    const now = new Date();
    let processed = 0;

    // Phase 1: Prune sessions beyond retention period
    for (const session of sessions) {
        if (processed >= MAX_SESSIONS_PER_RUN) break;

        const ageDays = daysBetween(session.lastActivity, now);
        if (ageDays > config.days) {
            if (pruneSession(session, store, warn)) {
                result.pruned++;
                result.sizeReclaimed += session.sizeBytes;
                processed++;
            }
        }
    }

    // Phase 2: Compress sessions older than COMPRESS_AFTER_DAYS
    for (const session of sessions) {
        if (processed >= MAX_SESSIONS_PER_RUN) break;

        // Skip sessions that were already pruned in Phase 1
        if (!existsSync(session.dir)) continue;

        const ageDays = daysBetween(session.lastActivity, now);
        if (ageDays > COMPRESS_AFTER_DAYS && ageDays <= config.days) {
            // Skip if already compressed (no uncompressed JSONL files)
            if (!hasUncompressedJsonl(session.dir)) continue;

            const sizeBefore = dirSize(session.dir);
            await compressSession(session, warn);
            const sizeAfter = dirSize(session.dir);
            result.compressed++;
            result.sizeReclaimed += Math.max(0, sizeBefore - sizeAfter);
            processed++;
        }
    }

    // Phase 3: Enforce size cap — prune oldest unpruned sessions until under limit
    const maxBytes = config.maxSizeGb * BYTES_PER_GB;

    // Re-scan to get fresh sizes after prune/compress phases
    const remaining = scanSessions(sessionsDir, warn);
    const totalSize = remaining.reduce((sum, s) => sum + s.sizeBytes, 0);

    if (totalSize > maxBytes) {
        remaining.sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime());

        let currentSize = totalSize;
        for (const session of remaining) {
            if (processed >= MAX_SESSIONS_PER_RUN) break;
            if (currentSize <= maxBytes) break;

            if (pruneSession(session, store, warn)) {
                currentSize -= session.sizeBytes;
                result.pruned++;
                result.sizeReclaimed += session.sizeBytes;
                processed++;
            }
        }
    }

    return result;
}

// --- Internal helpers ---

/**
 * Scan the sessions directory and return info for each valid session.
 */
function scanSessions(sessionsDir: string, warn: WarnFn): SessionInfo[] {
    const sessions: SessionInfo[] = [];

    const entries = readdirSyncSafe(sessionsDir);
    for (const name of entries) {
        const dir = join(sessionsDir, name);

        try {
            const stat = statSync(dir);
            if (!stat.isDirectory()) continue;
        } catch {
            continue;
        }

        const manifestPath = join(dir, 'manifest.json');
        if (!existsSync(manifestPath)) continue;

        try {
            const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
            const lastActivity = typeof raw.lastActivityTimestamp === 'string'
                ? new Date(raw.lastActivityTimestamp)
                : new Date(0);

            if (isNaN(lastActivity.getTime())) continue;

            sessions.push({
                sessionId: raw.sessionId ?? name,
                dir,
                lastActivity,
                sizeBytes: dirSize(dir),
            });
        } catch (err) {
            warn(`Retention: failed to read manifest for ${name}: ${(err as Error).message}`);
        }
    }

    return sessions;
}

/**
 * Remove a session directory from disk and mark as pruned in SQLite.
 * Returns true if the directory was successfully removed.
 */
function pruneSession(session: SessionInfo, store: SqliteStore | null, warn: WarnFn): boolean {
    try {
        rmSync(session.dir, { recursive: true, force: true });
    } catch (err) {
        warn(`Retention: failed to remove ${session.dir}: ${(err as Error).message}`);
        return false;
    }

    store?.markSessionPruned(session.sessionId);
    return true;
}

/**
 * Compress a session: gzip JSONL files, remove blob files.
 */
async function compressSession(session: SessionInfo, warn: WarnFn): Promise<void> {
    // Gzip all .jsonl files
    const files = readdirSyncSafe(session.dir);
    for (const file of files) {
        const filePath = join(session.dir, file);

        if (file.endsWith('.jsonl')) {
            try {
                await gzipFile(filePath);
                unlinkSync(filePath);
            } catch (err) {
                warn(`Retention: failed to gzip ${filePath}: ${(err as Error).message}`);
            }
        }
    }

    // Remove blobs directory if it exists
    const blobsDir = join(session.dir, 'blobs');
    if (existsSync(blobsDir)) {
        try {
            rmSync(blobsDir, { recursive: true, force: true });
        } catch (err) {
            warn(`Retention: failed to remove blobs for ${session.sessionId}: ${(err as Error).message}`);
        }
    }
}

/**
 * Gzip a file, writing to <path>.gz.
 */
async function gzipFile(filePath: string): Promise<void> {
    const gzPath = `${filePath}.gz`;
    const source = createReadStream(filePath);
    const gzip = createGzip();
    const dest = createWriteStream(gzPath);
    await pipeline(source, gzip, dest);
}

/**
 * Check if session directory has any uncompressed .jsonl files.
 */
function hasUncompressedJsonl(dir: string): boolean {
    const files = readdirSyncSafe(dir);
    return files.some((f) => f.endsWith('.jsonl'));
}

/**
 * Calculate total bytes of a directory recursively.
 */
function dirSize(dir: string): number {
    let total = 0;
    const files = readdirSyncSafe(dir);

    for (const file of files) {
        const filePath = join(dir, file);
        try {
            const stat = statSync(filePath);
            if (stat.isDirectory()) {
                total += dirSize(filePath);
            } else {
                total += stat.size;
            }
        } catch {
            // Skip inaccessible files
        }
    }

    return total;
}


/**
 * Safe readdirSync that returns [] on error. Returns string[] (file names only).
 */
function readdirSyncSafe(dir: string): string[] {
    try {
        return readdirSync(dir, { encoding: 'utf-8' });
    } catch {
        return [];
    }
}

/**
 * Days between two dates (floored to whole days).
 */
function daysBetween(older: Date, newer: Date): number {
    const ms = newer.getTime() - older.getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
}
