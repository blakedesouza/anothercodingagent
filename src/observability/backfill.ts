/**
 * JSONL → SQLite backfill (Block 19, M5.3).
 *
 * On session resume, compares event_ids present in the JSONL event log
 * against those already in SQLite. Any missing events are batch-inserted.
 * JSONL is authoritative — SQLite is just a queryable secondary index.
 */

import { readFileSync, existsSync } from 'node:fs';
import type { AcaEvent } from '../types/events.js';
import type { SessionId } from '../types/ids.js';
import type { SqliteStore, WarnFn } from './sqlite-store.js';

/**
 * Parse events from a JSONL file, skipping malformed lines.
 */
function parseEventsFromJsonl(filePath: string, warn: WarnFn): AcaEvent[] {
    if (!existsSync(filePath)) return [];

    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const events: AcaEvent[] = [];

    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            // Only include lines that look like events (have event_id and event_type)
            if (
                typeof parsed.event_id === 'string' &&
                typeof parsed.event_type === 'string'
            ) {
                events.push(parsed as unknown as AcaEvent);
            }
        } catch {
            warn(`Backfill: skipping malformed JSONL line`);
        }
    }

    return events;
}

/**
 * Backfill missing events from a JSONL file into SQLite for a given session.
 * Returns the number of events inserted.
 */
export function backfillSession(
    store: SqliteStore,
    sessionId: SessionId,
    eventsJsonlPath: string,
    warn: WarnFn = () => {},
): number {
    if (!store.isOpen()) return 0;

    try {
        // Get event IDs already in SQLite
        const existingIds = store.getEventIdsForSession(sessionId);

        // Parse all events from JSONL
        const jsonlEvents = parseEventsFromJsonl(eventsJsonlPath, warn);

        // Find events missing from SQLite
        const missing = jsonlEvents.filter(
            (event) => !existingIds.has(event.event_id),
        );

        if (missing.length === 0) return 0;

        // Batch insert missing events
        store.insertBatch(missing);
        return missing.length;
    } catch (err) {
        warn(`Backfill failed: ${(err as Error).message}`);
        return 0;
    }
}
