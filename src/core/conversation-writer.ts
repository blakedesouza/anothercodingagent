import { writeSync, openSync, closeSync, constants } from 'node:fs';
import type { ConversationItem } from '../types/conversation.js';
import type { TurnRecord, StepRecord } from '../types/session.js';
import type { SecretScrubber } from '../permissions/secret-scrubber.js';

/**
 * Maps in-memory types to JSONL recordType discriminator values.
 * ConversationItems use their `kind` field; Turn/Step get explicit labels.
 */
export type RecordType = 'message' | 'tool_result' | 'summary' | 'turn' | 'step';

/** A record as it appears in the JSONL file (with recordType, without kind for items). */
export type JsonlRecord =
    | (Omit<ConversationItem, 'kind'> & { recordType: RecordType })
    | (TurnRecord & { recordType: 'turn' })
    | (StepRecord & { recordType: 'step' });

/**
 * Append-only writer for conversation JSONL files.
 *
 * Each write is a single writeSync call using O_APPEND,
 * guaranteeing that each line is atomically written as a complete JSON object.
 * If the process crashes mid-write, the partial line is detectable on read
 * because it won't be valid JSON.
 */
export class ConversationWriter {
    private readonly filePath: string;
    private readonly scrubber?: SecretScrubber;

    constructor(filePath: string, scrubber?: SecretScrubber) {
        this.filePath = filePath;
        this.scrubber = scrubber;
    }

    /** Append a ConversationItem (message, tool_result, summary). */
    writeItem(item: ConversationItem): void {
        const { kind, ...rest } = item;
        const record = { recordType: kind as RecordType, ...rest };
        this.appendLine(record);
    }

    /** Append a TurnRecord. */
    writeTurn(turn: TurnRecord): void {
        const record = { recordType: 'turn' as const, ...turn };
        this.appendLine(record);
    }

    /** Append a StepRecord. */
    writeStep(step: StepRecord): void {
        const record = { recordType: 'step' as const, ...step };
        this.appendLine(record);
    }

    /**
     * Serialize and append a single JSON line.
     * Uses O_APPEND so concurrent writers don't interleave within a line
     * (POSIX guarantees atomicity for writes ≤ PIPE_BUF, typically 4096 bytes;
     * for larger writes the kernel still appends atomically on most Linux/macOS fs).
     */
    private appendLine(record: Record<string, unknown>): void {
        let line = JSON.stringify(record) + '\n';
        if (this.scrubber) {
            line = this.scrubber.scrub(line);
        }
        const fd = openSync(this.filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
        try {
            writeSync(fd, line, null, 'utf-8');
        } finally {
            closeSync(fd);
        }
    }
}
