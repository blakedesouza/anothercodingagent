/**
 * SQLite observability store (Block 19, M5.3).
 *
 * Secondary queryable index built from the authoritative JSONL event stream.
 * Uses better-sqlite3 for synchronous reads. Writes are batched via
 * BackgroundWriter (not called directly in the hot path).
 *
 * All SQLite operations are wrapped in try/catch — failures emit warnings
 * but never disrupt the agent loop.
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { AcaEvent, EventType } from '../types/events.js';
import type { SessionId } from '../types/ids.js';

// --- Schema DDL ---

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    status TEXT,
    duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS errors (
    event_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_errors_session ON errors(session_id);
`;

// --- Types ---

export interface SessionRow {
    session_id: string;
    workspace_id: string;
    started_at: string;
    ended_at: string | null;
    status: string;
    pruned: number;
}

export interface EventRow {
    event_id: string;
    session_id: string;
    event_type: string;
    timestamp: string;
    payload: string;
}

export interface ToolCallRow {
    event_id: string;
    session_id: string;
    tool_name: string;
    status: string | null;
    duration_ms: number | null;
}

export interface ErrorRow {
    event_id: string;
    session_id: string;
    code: string;
    message: string;
}

// --- Warning callback type ---

export type WarnFn = (message: string) => void;

// Default no-op warning function
const defaultWarn: WarnFn = () => {};

// --- SQLite Store ---

export class SqliteStore {
    private db: DatabaseType | null = null;
    private readonly dbPath: string;
    private readonly warn: WarnFn;

    // Cached prepared statements (initialized in open())
    private stmtInsertEvent: Database.Statement | null = null;
    private stmtInsertSession: Database.Statement | null = null;
    private stmtUpdateSessionEnded: Database.Statement | null = null;
    private stmtInsertToolCall: Database.Statement | null = null;
    private stmtInsertError: Database.Statement | null = null;

    constructor(dbPath: string, warn?: WarnFn) {
        this.dbPath = dbPath;
        this.warn = warn ?? defaultWarn;
    }

    /**
     * Open the database and ensure schema exists.
     * Returns false if the database could not be opened.
     */
    open(): boolean {
        if (this.db) return true; // Already open

        try {
            this.db = new Database(this.dbPath);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(SCHEMA_DDL);
            this.runMigrations();
            this.prepareStatements();
            return true;
        } catch (err) {
            this.warn(`SQLite open failed: ${(err as Error).message}`);
            this.db = null;
            return false;
        }
    }

    /**
     * Close the database connection.
     */
    close(): void {
        this.clearStatements();
        try {
            this.db?.close();
        } catch {
            // Ignore close errors
        }
        this.db = null;
    }

    /**
     * Returns true if the database is open and usable.
     */
    isOpen(): boolean {
        return this.db !== null;
    }

    /**
     * Insert a batch of events into SQLite tables.
     * Each event is routed to the appropriate table(s) based on event_type.
     * Runs inside a single transaction for atomicity.
     */
    insertBatch(events: AcaEvent[]): void {
        if (!this.db || !this.stmtInsertEvent || events.length === 0) return;

        try {
            const runBatch = this.db.transaction(() => {
                for (const event of events) {
                    this.stmtInsertEvent!.run(
                        event.event_id,
                        event.session_id,
                        event.event_type,
                        event.timestamp,
                        JSON.stringify(event.payload),
                    );
                    this.routeEvent(event);
                }
            });

            runBatch();
        } catch (err) {
            this.warn(`SQLite batch insert failed: ${(err as Error).message}`);
        }
    }

    /**
     * Get all event IDs for a session that are already in SQLite.
     * Used by backfill to determine which JSONL events are missing.
     */
    getEventIdsForSession(sessionId: SessionId): Set<string> {
        if (!this.db) return new Set();

        try {
            const rows = this.db
                .prepare('SELECT event_id FROM events WHERE session_id = ?')
                .all(sessionId) as Array<{ event_id: string }>;
            return new Set(rows.map((r) => r.event_id));
        } catch (err) {
            this.warn(`SQLite query failed: ${(err as Error).message}`);
            return new Set();
        }
    }

    /**
     * Query all sessions.
     */
    getAllSessions(): SessionRow[] {
        if (!this.db) return [];

        try {
            return this.db
                .prepare('SELECT * FROM sessions ORDER BY started_at DESC')
                .all() as SessionRow[];
        } catch (err) {
            this.warn(`SQLite query failed: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * Query events for a specific session.
     */
    getEventsForSession(sessionId: SessionId): EventRow[] {
        if (!this.db) return [];

        try {
            return this.db
                .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC')
                .all(sessionId) as EventRow[];
        } catch (err) {
            this.warn(`SQLite query failed: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * Query tool calls for a specific session.
     */
    getToolCallsForSession(sessionId: SessionId): ToolCallRow[] {
        if (!this.db) return [];

        try {
            return this.db
                .prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY rowid ASC')
                .all(sessionId) as ToolCallRow[];
        } catch (err) {
            this.warn(`SQLite query failed: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * Sum cost_usd for all llm.response events today (UTC), excluding a given session.
     * Used by CostTracker to compute daily baseline cost at session start.
     * Returns 0 if SQLite is unavailable or no data exists.
     */
    getDailyCostExcludingSession(excludeSessionId: SessionId): number {
        if (!this.db) return 0;

        try {
            const todayPrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            const row = this.db
                .prepare(
                    `SELECT COALESCE(SUM(json_extract(payload, '$.cost_usd')), 0) AS total
                     FROM events
                     JOIN sessions ON sessions.session_id = events.session_id
                     WHERE event_type = 'llm.response'
                       AND events.session_id != ?
                       AND events.timestamp >= ?
                       AND sessions.ended_at IS NOT NULL
                       AND sessions.status = 'ended'`,
                )
                .get(excludeSessionId, todayPrefix) as { total: number } | undefined;
            return row?.total ?? 0;
        } catch (err) {
            this.warn(`SQLite daily cost query failed: ${(err as Error).message}`);
            return 0;
        }
    }

    /**
     * Get a single session by ID. Returns null if not found.
     */
    getSessionById(sessionId: string): SessionRow | null {
        if (!this.db) return null;
        try {
            const row = this.db
                .prepare('SELECT * FROM sessions WHERE session_id = ?')
                .get(sessionId) as SessionRow | undefined;
            return row ?? null;
        } catch (err) {
            this.warn(`SQLite query failed: ${(err as Error).message}`);
            return null;
        }
    }

    /**
     * Get sessions started on or after a given ISO date string.
     */
    getSessionsSince(sinceIso: string): SessionRow[] {
        if (!this.db) return [];
        try {
            return this.db
                .prepare('SELECT * FROM sessions WHERE started_at >= ? ORDER BY started_at DESC')
                .all(sinceIso) as SessionRow[];
        } catch (err) {
            this.warn(`SQLite query failed: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * Get aggregate token and cost stats from llm.response events since a date.
     */
    getAggregateSince(sinceIso: string): { totalCost: number; totalTokensIn: number; totalTokensOut: number } {
        if (!this.db) return { totalCost: 0, totalTokensIn: 0, totalTokensOut: 0 };
        try {
            const row = this.db.prepare(`
                SELECT
                    COALESCE(SUM(json_extract(payload, '$.cost_usd')), 0) AS totalCost,
                    COALESCE(SUM(json_extract(payload, '$.tokens_in')), 0) AS totalTokensIn,
                    COALESCE(SUM(json_extract(payload, '$.tokens_out')), 0) AS totalTokensOut
                FROM events
                WHERE event_type = 'llm.response' AND timestamp >= ?
            `).get(sinceIso) as { totalCost: number; totalTokensIn: number; totalTokensOut: number };
            return row;
        } catch (err) {
            this.warn(`SQLite query failed: ${(err as Error).message}`);
            return { totalCost: 0, totalTokensIn: 0, totalTokensOut: 0 };
        }
    }

    /**
     * Get top N most-used tools since a date.
     */
    getTopToolsSince(sinceIso: string, limit = 5): Array<{ tool_name: string; count: number }> {
        if (!this.db) return [];
        try {
            return this.db.prepare(`
                SELECT tc.tool_name, COUNT(*) AS count
                FROM tool_calls tc
                JOIN events e ON tc.event_id = e.event_id
                WHERE e.timestamp >= ?
                GROUP BY tc.tool_name
                ORDER BY count DESC
                LIMIT ?
            `).all(sinceIso, limit) as Array<{ tool_name: string; count: number }>;
        } catch (err) {
            this.warn(`SQLite query failed: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * Get error count since a date.
     */
    getErrorCountSince(sinceIso: string): number {
        if (!this.db) return 0;
        try {
            const row = this.db.prepare(`
                SELECT COUNT(*) AS count
                FROM errors er
                JOIN events e ON er.event_id = e.event_id
                WHERE e.timestamp >= ?
            `).get(sinceIso) as { count: number };
            return row.count;
        } catch (err) {
            this.warn(`SQLite query failed: ${(err as Error).message}`);
            return 0;
        }
    }

    /**
     * Get failed tool call count since a date.
     */
    getToolErrorCountSince(sinceIso: string): number {
        if (!this.db) return 0;
        try {
            const row = this.db.prepare(`
                SELECT COUNT(*) AS count
                FROM tool_calls tc
                JOIN events e ON tc.event_id = e.event_id
                WHERE tc.status = 'error' AND e.timestamp >= ?
            `).get(sinceIso) as { count: number };
            return row.count;
        } catch (err) {
            this.warn(`SQLite query failed: ${(err as Error).message}`);
            return 0;
        }
    }

    /**
     * Get total tool call count since a date.
     */
    getToolCallCountSince(sinceIso: string): number {
        if (!this.db) return 0;
        try {
            const row = this.db.prepare(`
                SELECT COUNT(*) AS count
                FROM tool_calls tc
                JOIN events e ON tc.event_id = e.event_id
                WHERE e.timestamp >= ?
            `).get(sinceIso) as { count: number };
            return row.count;
        } catch (err) {
            this.warn(`SQLite query failed: ${(err as Error).message}`);
            return 0;
        }
    }

    /**
     * Query errors for a specific session.
     */
    getErrorsForSession(sessionId: SessionId): ErrorRow[] {
        if (!this.db) return [];

        try {
            return this.db
                .prepare('SELECT * FROM errors WHERE session_id = ? ORDER BY rowid ASC')
                .all(sessionId) as ErrorRow[];
        } catch (err) {
            this.warn(`SQLite query failed: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * Mark a session as pruned (disk data deleted, SQLite records retained).
     */
    markSessionPruned(sessionId: string): void {
        if (!this.db) return;
        try {
            this.db.prepare('UPDATE sessions SET pruned = 1 WHERE session_id = ?').run(sessionId);
        } catch (err) {
            this.warn(`SQLite markSessionPruned failed: ${(err as Error).message}`);
        }
    }

    /**
     * Run schema migrations for columns added after initial schema.
     */
    private runMigrations(): void {
        if (!this.db) return;
        // M5.6: Add pruned column to sessions table
        const cols = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
        const hasPruned = cols.some((c) => c.name === 'pruned');
        if (!hasPruned) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN pruned INTEGER NOT NULL DEFAULT 0');
        }
    }

    /**
     * Prepare and cache all statements after opening the database.
     */
    private prepareStatements(): void {
        if (!this.db) return;
        this.stmtInsertEvent = this.db.prepare(
            'INSERT OR IGNORE INTO events (event_id, session_id, event_type, timestamp, payload) VALUES (?, ?, ?, ?, ?)',
        );
        this.stmtInsertSession = this.db.prepare(
            'INSERT OR IGNORE INTO sessions (session_id, workspace_id, started_at, status) VALUES (?, ?, ?, ?)',
        );
        this.stmtUpdateSessionEnded = this.db.prepare(
            'UPDATE sessions SET ended_at = ?, status = ? WHERE session_id = ?',
        );
        this.stmtInsertToolCall = this.db.prepare(
            'INSERT OR IGNORE INTO tool_calls (event_id, session_id, tool_name, status, duration_ms) VALUES (?, ?, ?, ?, ?)',
        );
        this.stmtInsertError = this.db.prepare(
            'INSERT OR IGNORE INTO errors (event_id, session_id, code, message) VALUES (?, ?, ?, ?)',
        );
    }

    /**
     * Clear cached statements (called before close).
     */
    private clearStatements(): void {
        this.stmtInsertEvent = null;
        this.stmtInsertSession = null;
        this.stmtUpdateSessionEnded = null;
        this.stmtInsertToolCall = null;
        this.stmtInsertError = null;
    }

    /**
     * Route a single event to the appropriate specialized table(s).
     */
    private routeEvent(event: AcaEvent): void {
        const payload = event.payload as unknown as Record<string, unknown>;

        switch (event.event_type as EventType) {
            case 'session.started':
                this.stmtInsertSession!.run(
                    event.session_id,
                    payload.workspace_id ?? '',
                    event.timestamp,
                    'active',
                );
                break;

            case 'session.ended':
                this.stmtUpdateSessionEnded!.run(
                    event.timestamp,
                    'ended',
                    event.session_id,
                );
                break;

            case 'tool.completed':
                this.stmtInsertToolCall!.run(
                    event.event_id,
                    event.session_id,
                    payload.tool_name ?? '',
                    payload.status ?? null,
                    typeof payload.duration_ms === 'number' ? payload.duration_ms : null,
                );
                break;

            case 'error':
                this.stmtInsertError!.run(
                    event.event_id,
                    event.session_id,
                    payload.code ?? '',
                    payload.message ?? '',
                );
                break;
        }
    }
}
