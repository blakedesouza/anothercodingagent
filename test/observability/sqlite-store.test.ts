import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../../src/observability/sqlite-store.js';
import { BackgroundWriter } from '../../src/observability/background-writer.js';
import { backfillSession } from '../../src/observability/backfill.js';
import { createEvent } from '../../src/core/event-sink.js';
import type { AcaEvent } from '../../src/types/events.js';
import type { SessionId } from '../../src/types/ids.js';

// --- Helpers ---

function tmpDir(): string {
    const dir = join(tmpdir(), `aca-obs-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

const TEST_SESSION = 'ses_TEST000000000000000000000' as SessionId;
const TEST_SESSION_2 = 'ses_TEST000000000000000000001' as SessionId;
const TEST_SESSION_3 = 'ses_TEST000000000000000000002' as SessionId;
const TEST_AGENT = 'root';

function makeSessionStarted(sessionId: SessionId = TEST_SESSION): AcaEvent {
    return createEvent('session.started', sessionId, 0, TEST_AGENT, {
        workspace_id: 'wrk_abc123',
        model: 'claude-sonnet',
        provider: 'nanogpt',
    });
}

function makeToolCompleted(sessionId: SessionId = TEST_SESSION, turnNumber = 1): AcaEvent {
    return createEvent('tool.completed', sessionId, turnNumber, TEST_AGENT, {
        tool_name: 'read_file',
        status: 'success',
        duration_ms: 42,
        bytes_returned: 1024,
        correlation_id: 'corr_123',
    });
}

function makeError(sessionId: SessionId = TEST_SESSION): AcaEvent {
    return createEvent('error', sessionId, 1, TEST_AGENT, {
        code: 'llm.timeout',
        message: 'Request timed out',
    });
}

function makeLlmResponse(sessionId: SessionId = TEST_SESSION, turnNumber = 1): AcaEvent {
    return createEvent('llm.response', sessionId, turnNumber, TEST_AGENT, {
        model: 'claude-sonnet',
        provider: 'nanogpt',
        tokens_in: 500,
        tokens_out: 200,
        latency_ms: 1500,
        finish_reason: 'stop',
        cost_usd: null,
    });
}

function makeSessionEnded(sessionId: SessionId = TEST_SESSION): AcaEvent {
    return createEvent('session.ended', sessionId, 0, TEST_AGENT, {
        total_turns: 5,
        total_tokens_in: 2500,
        total_tokens_out: 1000,
        duration_ms: 30000,
    });
}

// --- SqliteStore tests ---

describe('SqliteStore', () => {
    let dir: string;
    let store: SqliteStore;

    beforeEach(() => {
        dir = tmpDir();
        store = new SqliteStore(join(dir, 'observability.db'));
        store.open();
    });

    afterEach(() => {
        store.close();
    });

    it('session start → session row created in SQLite', () => {
        const event = makeSessionStarted();
        store.insertBatch([event]);

        const sessions = store.getAllSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].session_id).toBe(TEST_SESSION);
        expect(sessions[0].workspace_id).toBe('wrk_abc123');
        expect(sessions[0].status).toBe('active');
        expect(sessions[0].started_at).toBe(event.timestamp);
    });

    it('session end updates the session row', () => {
        const start = makeSessionStarted();
        const end = makeSessionEnded();
        store.insertBatch([start, end]);

        const sessions = store.getAllSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].status).toBe('ended');
        expect(sessions[0].ended_at).toBe(end.timestamp);
    });

    it('tool.completed routes to tool_calls table', () => {
        store.insertBatch([makeToolCompleted()]);

        const toolCalls = store.getToolCallsForSession(TEST_SESSION);
        expect(toolCalls).toHaveLength(1);
        expect(toolCalls[0].tool_name).toBe('read_file');
        expect(toolCalls[0].status).toBe('success');
        expect(toolCalls[0].duration_ms).toBe(42);
    });

    it('error routes to errors table', () => {
        store.insertBatch([makeError()]);

        const errors = store.getErrorsForSession(TEST_SESSION);
        expect(errors).toHaveLength(1);
        expect(errors[0].code).toBe('llm.timeout');
        expect(errors[0].message).toBe('Request timed out');
    });

    it('all events stored in events table regardless of type', () => {
        const events = [
            makeSessionStarted(),
            makeLlmResponse(),
            makeToolCompleted(),
            makeError(),
            makeSessionEnded(),
        ];
        store.insertBatch(events);

        const rows = store.getEventsForSession(TEST_SESSION);
        expect(rows).toHaveLength(5);
    });

    it('query across sessions: 3 sessions → all queryable', () => {
        store.insertBatch([
            makeSessionStarted(TEST_SESSION),
            makeLlmResponse(TEST_SESSION),
        ]);
        store.insertBatch([
            makeSessionStarted(TEST_SESSION_2),
            makeToolCompleted(TEST_SESSION_2),
        ]);
        store.insertBatch([
            makeSessionStarted(TEST_SESSION_3),
            makeError(TEST_SESSION_3),
        ]);

        const sessions = store.getAllSessions();
        expect(sessions).toHaveLength(3);

        const events1 = store.getEventsForSession(TEST_SESSION);
        expect(events1).toHaveLength(2);

        const events2 = store.getEventsForSession(TEST_SESSION_2);
        expect(events2).toHaveLength(2);

        const events3 = store.getEventsForSession(TEST_SESSION_3);
        expect(events3).toHaveLength(2);
    });

    it('duplicate event_id is ignored (INSERT OR IGNORE)', () => {
        const event = makeSessionStarted();
        store.insertBatch([event]);
        store.insertBatch([event]); // Same event again

        const events = store.getEventsForSession(TEST_SESSION);
        expect(events).toHaveLength(1);
    });

    it('getEventIdsForSession returns correct set', () => {
        const e1 = makeSessionStarted();
        const e2 = makeLlmResponse();
        store.insertBatch([e1, e2]);

        const ids = store.getEventIdsForSession(TEST_SESSION);
        expect(ids.size).toBe(2);
        expect(ids.has(e1.event_id)).toBe(true);
        expect(ids.has(e2.event_id)).toBe(true);
    });
});

// --- SqliteStore failure handling ---

describe('SqliteStore failure handling', () => {
    it('SQLite write failure → warning emitted, agent continues', () => {
        const warnings: string[] = [];
        const store = new SqliteStore('/nonexistent/path/observability.db', (msg) => {
            warnings.push(msg);
        });

        // open() fails → returns false, emits warning
        const opened = store.open();
        expect(opened).toBe(false);
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]).toContain('SQLite open failed');

        // Operations on a closed store are no-ops (no throws)
        store.insertBatch([makeSessionStarted()]);
        expect(store.getAllSessions()).toEqual([]);
        expect(store.getEventsForSession(TEST_SESSION)).toEqual([]);
        expect(store.getEventIdsForSession(TEST_SESSION)).toEqual(new Set());

        store.close();
    });

    it('isOpen returns false when db is not available', () => {
        const store = new SqliteStore('/nonexistent/path/obs.db');
        expect(store.isOpen()).toBe(false);
        store.open(); // will fail silently
        expect(store.isOpen()).toBe(false);
        store.close();
    });
});

// --- BackgroundWriter tests ---

describe('BackgroundWriter', () => {
    let dir: string;
    let store: SqliteStore;

    beforeEach(() => {
        vi.useFakeTimers();
        dir = tmpDir();
        store = new SqliteStore(join(dir, 'observability.db'));
        store.open();
    });

    afterEach(() => {
        store.close();
        vi.useRealTimers();
    });

    it('batch write: 5 events rapidly → all 5 in single batch after 1s debounce', () => {
        const writer = new BackgroundWriter(store);

        // Emit 5 events rapidly
        for (let i = 0; i < 5; i++) {
            writer.emit(makeLlmResponse(TEST_SESSION, i));
        }

        // At 999ms: nothing written yet
        vi.advanceTimersByTime(999);
        expect(store.getEventsForSession(TEST_SESSION)).toHaveLength(0);

        // At 1001ms: all 5 present
        vi.advanceTimersByTime(2);
        expect(store.getEventsForSession(TEST_SESSION)).toHaveLength(5);
    });

    it('events during debounce window → queued and included in next batch', () => {
        const writer = new BackgroundWriter(store);

        // Emit 3 events
        writer.emit(makeLlmResponse(TEST_SESSION, 1));
        writer.emit(makeLlmResponse(TEST_SESSION, 2));
        writer.emit(makeLlmResponse(TEST_SESSION, 3));

        // Advance 500ms (half the debounce window)
        vi.advanceTimersByTime(500);
        expect(store.getEventsForSession(TEST_SESSION)).toHaveLength(0);

        // Emit 2 more events (resets debounce timer)
        writer.emit(makeLlmResponse(TEST_SESSION, 4));
        writer.emit(makeLlmResponse(TEST_SESSION, 5));

        // Original 1s from first batch hasn't expired, but timer was reset
        vi.advanceTimersByTime(500);
        expect(store.getEventsForSession(TEST_SESSION)).toHaveLength(0);

        // 1s from last emit → all 5 flushed
        vi.advanceTimersByTime(500);
        expect(store.getEventsForSession(TEST_SESSION)).toHaveLength(5);
    });

    it('flush() writes immediately without waiting for timer', () => {
        const writer = new BackgroundWriter(store);

        writer.emit(makeLlmResponse(TEST_SESSION, 1));
        writer.emit(makeLlmResponse(TEST_SESSION, 2));

        expect(writer.pendingCount).toBe(2);
        writer.flush();
        expect(writer.pendingCount).toBe(0);
        expect(store.getEventsForSession(TEST_SESSION)).toHaveLength(2);
    });

    it('shutdown flushes remaining events', () => {
        const writer = new BackgroundWriter(store);

        writer.emit(makeLlmResponse(TEST_SESSION, 1));
        writer.shutdown();

        expect(store.getEventsForSession(TEST_SESSION)).toHaveLength(1);
        expect(writer.pendingCount).toBe(0);
    });
});

// --- Backfill tests ---

describe('backfillSession', () => {
    let dir: string;
    let store: SqliteStore;

    beforeEach(() => {
        dir = tmpDir();
        store = new SqliteStore(join(dir, 'observability.db'));
        store.open();
    });

    afterEach(() => {
        store.close();
    });

    it('backfill: events in JSONL not in SQLite → inserted', () => {
        // Create 3 events and write them to JSONL only
        const events = [
            makeSessionStarted(),
            makeLlmResponse(),
            makeToolCompleted(),
        ];

        const eventsJsonl = join(dir, 'events.jsonl');
        const jsonlContent = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
        writeFileSync(eventsJsonl, jsonlContent);

        // SQLite has no events for this session
        expect(store.getEventsForSession(TEST_SESSION)).toHaveLength(0);

        // Backfill
        const inserted = backfillSession(store, TEST_SESSION, eventsJsonl);
        expect(inserted).toBe(3);

        // All events now in SQLite
        expect(store.getEventsForSession(TEST_SESSION)).toHaveLength(3);
    });

    it('backfill: some events already in SQLite → only missing ones inserted', () => {
        const e1 = makeSessionStarted();
        const e2 = makeLlmResponse();
        const e3 = makeToolCompleted();

        // e1 is already in SQLite
        store.insertBatch([e1]);

        // JSONL has all 3
        const eventsJsonl = join(dir, 'events.jsonl');
        writeFileSync(eventsJsonl, [e1, e2, e3].map((e) => JSON.stringify(e)).join('\n') + '\n');

        const inserted = backfillSession(store, TEST_SESSION, eventsJsonl);
        expect(inserted).toBe(2);

        expect(store.getEventsForSession(TEST_SESSION)).toHaveLength(3);
    });

    it('backfill: all events already in SQLite → 0 inserted', () => {
        const events = [makeSessionStarted(), makeLlmResponse()];
        store.insertBatch(events);

        const eventsJsonl = join(dir, 'events.jsonl');
        writeFileSync(eventsJsonl, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

        const inserted = backfillSession(store, TEST_SESSION, eventsJsonl);
        expect(inserted).toBe(0);
    });

    it('backfill: missing JSONL file → 0 inserted, no error', () => {
        const inserted = backfillSession(
            store,
            TEST_SESSION,
            join(dir, 'nonexistent-events.jsonl'),
        );
        expect(inserted).toBe(0);
    });

    it('backfill: malformed JSONL lines are skipped', () => {
        const event = makeSessionStarted();
        const eventsJsonl = join(dir, 'events.jsonl');
        writeFileSync(
            eventsJsonl,
            `${JSON.stringify(event)}\n{bad json\nnot json at all\n`,
        );

        const warnings: string[] = [];
        const inserted = backfillSession(store, TEST_SESSION, eventsJsonl, (msg) => {
            warnings.push(msg);
        });
        expect(inserted).toBe(1);
        expect(warnings.length).toBe(2); // Two malformed lines
    });

    it('backfill: store not open → 0 inserted', () => {
        const closedStore = new SqliteStore(join(dir, 'closed.db'));
        // Don't open it

        const eventsJsonl = join(dir, 'events.jsonl');
        writeFileSync(eventsJsonl, JSON.stringify(makeSessionStarted()) + '\n');

        const inserted = backfillSession(closedStore, TEST_SESSION, eventsJsonl);
        expect(inserted).toBe(0);
    });
});
