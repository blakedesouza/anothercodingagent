/**
 * EventSink — structured event logging for ACA (Block 14).
 *
 * Append-only JSONL writer for typed events. Each event is a complete
 * JSON object on a single line. Synchronous writes for crash durability.
 */

import { writeSync, openSync, closeSync, constants } from 'node:fs';
import { generateId } from '../types/ids.js';
import type { EventId, SessionId } from '../types/ids.js';
import type {
    AcaEvent,
    EventType,
    EventPayloadMap,
} from '../types/events.js';
import { CURRENT_SCHEMA_VERSION as SCHEMA_VERSION } from '../types/events.js';

// --- Required envelope fields for validation ---

const REQUIRED_ENVELOPE_FIELDS: readonly string[] = [
    'event_id',
    'timestamp',
    'session_id',
    'turn_number',
    'agent_id',
    'event_type',
    'schema_version',
    'payload',
];

const VALID_EVENT_TYPES = new Set<string>([
    'session.started', 'session.ended',
    'turn.started', 'turn.ended',
    'llm.request', 'llm.response',
    'tool.invoked', 'tool.completed',
    'delegation.started', 'delegation.completed',
    'context.assembled', 'model.fallback',
    'network.checked', 'error',
]);

// --- EventSink interface ---

export interface EventSink {
    emit<T extends EventType>(event: AcaEvent<T>): void;
}

// --- NullEventSink (for tests or disabled logging) ---

export class NullEventSink implements EventSink {
    emit<T extends EventType>(_event: AcaEvent<T>): void {
        // no-op
    }
}

// --- JSONL event writer ---

export class JsonlEventSink implements EventSink {
    private readonly filePath: string;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    emit<T extends EventType>(event: AcaEvent<T>): void {
        this.validate(event);
        const line = JSON.stringify(event) + '\n';
        const fd = openSync(
            this.filePath,
            constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
        );
        try {
            writeSync(fd, line, null, 'utf-8');
        } finally {
            closeSync(fd);
        }
    }

    private validate(event: AcaEvent): void {
        for (const field of REQUIRED_ENVELOPE_FIELDS) {
            if ((event as unknown as Record<string, unknown>)[field] === undefined) {
                throw new Error(
                    `Event missing required field: ${field}`,
                );
            }
        }
        if (typeof event.event_id !== 'string' || !event.event_id.startsWith('evt_')) {
            throw new Error('event_id must be a prefixed ULID starting with evt_');
        }
        if (typeof event.timestamp !== 'string') {
            throw new Error('timestamp must be an ISO-8601 string');
        }
        if (typeof event.session_id !== 'string' || !event.session_id.startsWith('ses_')) {
            throw new Error('session_id must be a prefixed ULID starting with ses_');
        }
        if (typeof event.turn_number !== 'number') {
            throw new Error('turn_number must be a number');
        }
        if (typeof event.schema_version !== 'number') {
            throw new Error('schema_version must be a number');
        }
        if (!VALID_EVENT_TYPES.has(event.event_type)) {
            throw new Error(`Invalid event_type: ${event.event_type}`);
        }
    }
}

// --- Helper to create a fully-typed event ---

export function createEvent<T extends EventType>(
    eventType: T,
    sessionId: SessionId,
    turnNumber: number,
    agentId: string,
    payload: EventPayloadMap[T],
    parentEventId?: EventId,
): AcaEvent<T> {
    return {
        event_id: generateId('event') as EventId,
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        turn_number: turnNumber,
        agent_id: agentId,
        event_type: eventType,
        schema_version: SCHEMA_VERSION,
        parent_event_id: parentEventId,
        payload,
    } as AcaEvent<T>;
}
