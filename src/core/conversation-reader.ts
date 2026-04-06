import { readFileSync, existsSync } from 'node:fs';
import type { ConversationItem, MessageItem, ToolResultItem, SummaryItem } from '../types/conversation.js';
import type { TurnRecord, StepRecord } from '../types/session.js';
import type { RecordType } from './conversation-writer.js';

/** Parsed record from JSONL — discriminated by recordType. */
export type ParsedRecord =
    | { recordType: 'message'; record: MessageItem }
    | { recordType: 'tool_result'; record: ToolResultItem }
    | { recordType: 'summary'; record: SummaryItem }
    | { recordType: 'turn'; record: TurnRecord }
    | { recordType: 'step'; record: StepRecord };

/** Warning emitted when a JSONL line is malformed or incomplete. */
export interface ReadWarning {
    lineNumber: number;
    raw: string;
    reason: string;
}

export interface ReadResult {
    records: ParsedRecord[];
    warnings: ReadWarning[];
}

const ITEM_RECORD_TYPES = new Set<RecordType>(['message', 'tool_result', 'summary']);

/**
 * Reads a conversation JSONL file, parses each line, and returns typed records.
 *
 * - Skips empty lines silently.
 * - Skips malformed lines (invalid JSON or missing recordType) with a warning.
 * - Partial last line (from a crash) is detected and discarded with a warning.
 * - Maps `recordType` back to `kind` for ConversationItems.
 */
export function readConversationLog(filePath: string): ReadResult {
    if (!existsSync(filePath)) {
        return { records: [], warnings: [] };
    }

    const content = readFileSync(filePath, 'utf-8');
    if (content.length === 0) {
        return { records: [], warnings: [] };
    }

    const lines = content.split('\n');
    const records: ParsedRecord[] = [];
    const warnings: ReadWarning[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = i + 1;

        // Skip empty lines (including trailing newline)
        if (line.trim() === '') continue;

        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            warnings.push({
                lineNumber,
                raw: line.length > 200 ? line.slice(0, 200) + '...' : line,
                reason: 'Invalid JSON',
            });
            continue;
        }

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            warnings.push({
                lineNumber,
                raw: line.length > 200 ? line.slice(0, 200) + '...' : line,
                reason: `Expected JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
            });
            continue;
        }

        const obj = parsed as Record<string, unknown>;
        const recordType = obj.recordType as RecordType | undefined;
        if (!recordType) {
            warnings.push({
                lineNumber,
                raw: line.length > 200 ? line.slice(0, 200) + '...' : line,
                reason: 'Missing recordType field',
            });
            continue;
        }

        // Map recordType back to kind for ConversationItems
        // Strip both recordType and kind (defensive against corrupted payloads)
        if (ITEM_RECORD_TYPES.has(recordType)) {
            const { recordType: _rt, kind: _k, ...rest } = obj;
            const item = { kind: recordType, ...rest } as unknown as ConversationItem;
            records.push({ recordType, record: item } as ParsedRecord);
        } else if (recordType === 'turn') {
            const { recordType: _rt, ...rest } = obj;
            records.push({ recordType: 'turn', record: rest as unknown as TurnRecord });
        } else if (recordType === 'step') {
            const { recordType: _rt, ...rest } = obj;
            records.push({ recordType: 'step', record: rest as unknown as StepRecord });
        } else {
            warnings.push({
                lineNumber,
                raw: line.length > 200 ? line.slice(0, 200) + '...' : line,
                reason: `Unknown recordType: ${recordType}`,
            });
        }
    }

    return { records, warnings };
}
