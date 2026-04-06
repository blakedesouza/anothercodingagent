import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
    mkdirSync,
    writeFileSync,
    existsSync,
    readFileSync,
    readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { SqliteStore } from '../../src/observability/sqlite-store.js';
import { runRetention } from '../../src/observability/log-retention.js';
import type { RetentionConfig } from '../../src/observability/log-retention.js';

// --- Helpers ---

function tmpDir(): string {
    const dir = join(tmpdir(), `aca-retention-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function daysAgo(n: number): string {
    // Use direct ms arithmetic to avoid DST issues with setDate()
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Create a fake session directory with a manifest and dummy files.
 */
function createSession(
    sessionsDir: string,
    sessionId: string,
    opts: {
        lastActivity: string;
        /** Approximate size of conversation.jsonl content in bytes. */
        jsonlSize?: number;
        /** Whether to create a blobs directory with a dummy blob. */
        withBlobs?: boolean;
        /** Whether to create an events.jsonl file. */
        withEvents?: boolean;
    },
): string {
    const dir = join(sessionsDir, sessionId);
    mkdirSync(dir, { recursive: true });

    const manifest = {
        sessionId,
        workspaceId: 'wrk_test123',
        status: 'ended',
        turnCount: 3,
        lastActivityTimestamp: opts.lastActivity,
        configSnapshot: {},
        durableTaskState: null,
        fileActivityIndex: null,
        calibration: null,
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Create conversation.jsonl with approximate size
    const jsonlSize = opts.jsonlSize ?? 100;
    const jsonlContent = 'x'.repeat(jsonlSize);
    writeFileSync(join(dir, 'conversation.jsonl'), jsonlContent);

    if (opts.withEvents !== false) {
        writeFileSync(join(dir, 'events.jsonl'), 'x'.repeat(jsonlSize));
    }

    if (opts.withBlobs) {
        const blobsDir = join(dir, 'blobs');
        mkdirSync(blobsDir, { recursive: true });
        writeFileSync(join(blobsDir, 'sha256-abc.bin'), Buffer.alloc(1024));
    }

    return dir;
}

/**
 * Register a session in SQLite so we can check the pruned flag.
 */
function registerSessionInSqlite(
    store: SqliteStore,
    sessionId: string,
    startedAt: string,
): void {
    // Use insertBatch with a minimal session.started event
    store.insertBatch([{
        event_id: `evt_${randomUUID().replace(/-/g, '').slice(0, 26)}`,
        session_id: sessionId,
        event_type: 'session.started',
        timestamp: startedAt,
        turn_number: 0,
        agent_id: 'root',
        payload: { workspace_id: 'wrk_test123', model: 'test', provider: 'test' },
    } as any]);
}

const DEFAULT_CONFIG: RetentionConfig = {
    days: 30,
    maxSizeGb: 5,
};

// --- Tests ---

describe('Log Retention', () => {
    let dir: string;
    let sessionsDir: string;
    let store: SqliteStore;

    beforeEach(() => {
        dir = tmpDir();
        sessionsDir = join(dir, 'sessions');
        mkdirSync(sessionsDir, { recursive: true });
        store = new SqliteStore(join(dir, 'observability.db'));
        store.open();
    });

    afterEach(() => {
        store.close();
    });

    it('session 31 days old → pruned from disk, SQLite row has pruned=true', async () => {
        const sessionId = 'ses_OLD0000000000000000000001';
        const startedAt = daysAgo(31);

        createSession(sessionsDir, sessionId, { lastActivity: startedAt });
        registerSessionInSqlite(store, sessionId, startedAt);

        const result = await runRetention(sessionsDir, store, DEFAULT_CONFIG);

        // Directory should be gone
        expect(existsSync(join(sessionsDir, sessionId))).toBe(false);
        expect(result.pruned).toBe(1);

        // SQLite row should have pruned=1
        const row = store.getSessionById(sessionId);
        expect(row).not.toBeNull();
        expect(row!.pruned).toBe(1);
    });

    it('session 8 days old → JSONL gzipped, blobs removed', async () => {
        const sessionId = 'ses_MID0000000000000000000001';
        const startedAt = daysAgo(8);

        createSession(sessionsDir, sessionId, {
            lastActivity: startedAt,
            withBlobs: true,
            withEvents: true,
        });

        const result = await runRetention(sessionsDir, store, DEFAULT_CONFIG);

        const sessionDir = join(sessionsDir, sessionId);

        // Directory should still exist
        expect(existsSync(sessionDir)).toBe(true);

        // JSONL files should be gzipped
        expect(existsSync(join(sessionDir, 'conversation.jsonl'))).toBe(false);
        expect(existsSync(join(sessionDir, 'conversation.jsonl.gz'))).toBe(true);
        expect(existsSync(join(sessionDir, 'events.jsonl'))).toBe(false);
        expect(existsSync(join(sessionDir, 'events.jsonl.gz'))).toBe(true);

        // Gzipped content should decompress to original
        const gzContent = readFileSync(join(sessionDir, 'conversation.jsonl.gz'));
        const decompressed = gunzipSync(gzContent).toString('utf-8');
        expect(decompressed).toBe('x'.repeat(100));

        // Blobs directory should be removed
        expect(existsSync(join(sessionDir, 'blobs'))).toBe(false);

        // Manifest should still exist
        expect(existsSync(join(sessionDir, 'manifest.json'))).toBe(true);

        expect(result.compressed).toBe(1);
        expect(result.pruned).toBe(0);
    });

    it('total > 5 GB → oldest sessions pruned until under limit', async () => {
        // Create sessions that together exceed maxSizeGb
        // Use a tiny maxSizeGb to trigger without huge files
        const tinyConfig: RetentionConfig = { days: 30, maxSizeGb: 0.000001 }; // ~1 KB

        const session1 = 'ses_BIG0000000000000000000001';
        const session2 = 'ses_BIG0000000000000000000002';
        const session3 = 'ses_BIG0000000000000000000003';

        // Oldest first
        createSession(sessionsDir, session1, {
            lastActivity: daysAgo(5),
            jsonlSize: 500,
        });
        createSession(sessionsDir, session2, {
            lastActivity: daysAgo(3),
            jsonlSize: 500,
        });
        createSession(sessionsDir, session3, {
            lastActivity: daysAgo(1),
            jsonlSize: 500,
        });

        registerSessionInSqlite(store, session1, daysAgo(5));
        registerSessionInSqlite(store, session2, daysAgo(3));
        registerSessionInSqlite(store, session3, daysAgo(1));

        const result = await runRetention(sessionsDir, store, tinyConfig);

        // Oldest sessions should be pruned first
        expect(result.pruned).toBeGreaterThanOrEqual(1);
        expect(existsSync(join(sessionsDir, session1))).toBe(false);

        // SQLite rows should be retained with pruned flag
        const row1 = store.getSessionById(session1);
        expect(row1).not.toBeNull();
        expect(row1!.pruned).toBe(1);
    });

    it('max 10 per startup → remaining sessions deferred to next startup', async () => {
        // Create 12 expired sessions (> 30 days old)
        for (let i = 0; i < 12; i++) {
            const id = `ses_EXP${String(i).padStart(23, '0')}`;
            createSession(sessionsDir, id, {
                lastActivity: daysAgo(31 + i),
            });
            registerSessionInSqlite(store, id, daysAgo(31 + i));
        }

        const result = await runRetention(sessionsDir, store, DEFAULT_CONFIG);

        // Only 10 should be processed
        expect(result.pruned).toBe(10);

        // 2 sessions should remain on disk
        const remaining = readdirSync(sessionsDir);
        expect(remaining.length).toBe(2);
    });

    it('session < 7 days old → untouched', async () => {
        const sessionId = 'ses_NEW0000000000000000000001';
        createSession(sessionsDir, sessionId, {
            lastActivity: daysAgo(3),
            withBlobs: true,
        });

        const result = await runRetention(sessionsDir, store, DEFAULT_CONFIG);

        const sessionDir = join(sessionsDir, sessionId);
        expect(existsSync(join(sessionDir, 'conversation.jsonl'))).toBe(true);
        expect(existsSync(join(sessionDir, 'blobs'))).toBe(true);
        expect(result.pruned).toBe(0);
        expect(result.compressed).toBe(0);
    });

    it('already compressed session → not re-compressed', async () => {
        const sessionId = 'ses_GZ00000000000000000000001';
        const sessionDir = createSession(sessionsDir, sessionId, {
            lastActivity: daysAgo(8),
        });

        // Manually "compress" — remove .jsonl, create .jsonl.gz
        const jsonlPath = join(sessionDir, 'conversation.jsonl');
        const eventsPath = join(sessionDir, 'events.jsonl');
        writeFileSync(`${jsonlPath}.gz`, 'compressed');
        writeFileSync(`${eventsPath}.gz`, 'compressed');
        try { require('node:fs').unlinkSync(jsonlPath); } catch {}
        try { require('node:fs').unlinkSync(eventsPath); } catch {}

        const result = await runRetention(sessionsDir, store, DEFAULT_CONFIG);

        expect(result.compressed).toBe(0);
    });

    it('nonexistent sessions dir → returns empty result', async () => {
        const result = await runRetention('/nonexistent/path', store, DEFAULT_CONFIG);
        expect(result.pruned).toBe(0);
        expect(result.compressed).toBe(0);
        expect(result.sizeReclaimed).toBe(0);
    });

    it('empty sessions dir → returns empty result', async () => {
        const result = await runRetention(sessionsDir, store, DEFAULT_CONFIG);
        expect(result.pruned).toBe(0);
        expect(result.compressed).toBe(0);
    });

    it('works with null store (no SQLite)', async () => {
        const sessionId = 'ses_NULL000000000000000000001';
        createSession(sessionsDir, sessionId, { lastActivity: daysAgo(31) });

        // Should not throw when store is null
        const result = await runRetention(sessionsDir, null, DEFAULT_CONFIG);
        expect(result.pruned).toBe(1);
        expect(existsSync(join(sessionsDir, sessionId))).toBe(false);
    });
});
