/**
 * BackgroundWriter — debounced batch writer for SQLite observability (Block 19, M5.3).
 *
 * Collects events in an in-memory queue. A debounce timer fires after 1s of
 * the last event and flushes the batch to SQLite. The timer resets on each
 * new event, so rapid events are coalesced into a single batch.
 *
 * Implements the EventSink interface so it can be composed with the JSONL sink.
 */

import type { AcaEvent, EventType } from '../types/events.js';
import type { EventSink } from '../core/event-sink.js';
import type { SqliteStore } from './sqlite-store.js';

const DEFAULT_DEBOUNCE_MS = 1000;

export class BackgroundWriter implements EventSink {
    private readonly store: SqliteStore;
    private readonly debounceMs: number;
    private queue: AcaEvent[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(store: SqliteStore, debounceMs: number = DEFAULT_DEBOUNCE_MS) {
        this.store = store;
        this.debounceMs = debounceMs;
    }

    /**
     * Queue an event for batch writing. Resets the debounce timer.
     */
    emit<T extends EventType>(event: AcaEvent<T>): void {
        this.queue.push(event as AcaEvent);

        // Reset debounce timer
        if (this.timer !== null) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => this.flush(), this.debounceMs);
    }

    /**
     * Flush all queued events to SQLite immediately.
     * Called by the debounce timer, and should be called on shutdown.
     */
    flush(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (this.queue.length === 0) return;

        const batch = this.queue;
        this.queue = [];
        this.store.insertBatch(batch);
    }

    /**
     * Returns the number of events currently queued (not yet flushed).
     */
    get pendingCount(): number {
        return this.queue.length;
    }

    /**
     * Shutdown: flush remaining events and clear timer.
     */
    shutdown(): void {
        this.flush();
    }
}
