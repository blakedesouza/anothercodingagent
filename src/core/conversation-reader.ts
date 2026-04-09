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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(isString);
}

function isNumberArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every(isFiniteNumber);
}

function isTextPart(value: unknown): boolean {
    return isObjectRecord(value) &&
        value.type === 'text' &&
        isString(value.text);
}

function isToolCallPart(value: unknown): boolean {
    return isObjectRecord(value) &&
        value.type === 'tool_call' &&
        isString(value.toolCallId) &&
        isString(value.toolName) &&
        isObjectRecord(value.arguments);
}

function isValidMessageRecord(value: Record<string, unknown>): boolean {
    if (!isString(value.id) || !isFiniteNumber(value.seq) || !isString(value.timestamp)) {
        return false;
    }
    if (value.role !== 'system' && value.role !== 'user' && value.role !== 'assistant') {
        return false;
    }
    if (!Array.isArray(value.parts) || value.parts.length === 0) {
        return false;
    }
    return value.parts.every((part) => {
        if (isTextPart(part)) return true;
        if (value.role === 'assistant' && isToolCallPart(part)) return true;
        return false;
    });
}

function isValidToolOutput(value: unknown): boolean {
    return isObjectRecord(value) &&
        (value.status === 'success' || value.status === 'error') &&
        isString(value.data) &&
        typeof value.truncated === 'boolean' &&
        isFiniteNumber(value.bytesReturned) &&
        isFiniteNumber(value.bytesOmitted) &&
        typeof value.retryable === 'boolean' &&
        typeof value.timedOut === 'boolean' &&
        isString(value.mutationState);
}

function isValidToolResultRecord(value: Record<string, unknown>): boolean {
    return isString(value.id) &&
        isFiniteNumber(value.seq) &&
        isString(value.toolCallId) &&
        isString(value.toolName) &&
        isValidToolOutput(value.output) &&
        isString(value.timestamp);
}

function isValidSummaryRecord(value: Record<string, unknown>): boolean {
    return isString(value.id) &&
        isFiniteNumber(value.seq) &&
        isString(value.text) &&
        isObjectRecord(value.coversSeq) &&
        isFiniteNumber(value.coversSeq.start) &&
        isFiniteNumber(value.coversSeq.end) &&
        isString(value.timestamp) &&
        (value.pinnedFacts === undefined || isStringArray(value.pinnedFacts));
}

function isValidTurnRecord(value: Record<string, unknown>): boolean {
    return isString(value.id) &&
        isString(value.sessionId) &&
        isFiniteNumber(value.turnNumber) &&
        (value.status === 'active' || value.status === 'completed' || value.status === 'cancelled') &&
        isFiniteNumber(value.itemSeqStart) &&
        isFiniteNumber(value.itemSeqEnd) &&
        Array.isArray(value.steps) &&
        isString(value.startedAt) &&
        (value.completedAt === undefined || isString(value.completedAt));
}

function isValidStepRecord(value: Record<string, unknown>): boolean {
    return isString(value.id) &&
        isString(value.turnId) &&
        isFiniteNumber(value.stepNumber) &&
        isString(value.model) &&
        isString(value.provider) &&
        isNumberArray(value.inputItemSeqs) &&
        isNumberArray(value.outputItemSeqs) &&
        isString(value.finishReason) &&
        isObjectRecord(value.contextStats) &&
        isFiniteNumber(value.contextStats.tokenCount) &&
        isFiniteNumber(value.contextStats.tokenLimit) &&
        (
            value.contextStats.compressionTier === 'full' ||
            value.contextStats.compressionTier === 'medium' ||
            value.contextStats.compressionTier === 'aggressive'
            || value.contextStats.compressionTier === 'emergency'
        ) &&
        isString(value.contextStats.systemPromptFingerprint) &&
        isObjectRecord(value.tokenUsage) &&
        isFiniteNumber(value.tokenUsage.inputTokens) &&
        isFiniteNumber(value.tokenUsage.outputTokens) &&
        isString(value.timestamp);
}

function validateRecordShape(recordType: RecordType, value: Record<string, unknown>): string | null {
    switch (recordType) {
        case 'message':
            return isValidMessageRecord(value) ? null : 'Invalid message record shape';
        case 'tool_result':
            return isValidToolResultRecord(value) ? null : 'Invalid tool_result record shape';
        case 'summary':
            return isValidSummaryRecord(value) ? null : 'Invalid summary record shape';
        case 'turn':
            return isValidTurnRecord(value) ? null : 'Invalid turn record shape';
        case 'step':
            return isValidStepRecord(value) ? null : 'Invalid step record shape';
    }
}

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

        const shapeError = validateRecordShape(recordType, obj);
        if (shapeError) {
            warnings.push({
                lineNumber,
                raw: line.length > 200 ? line.slice(0, 200) + '...' : line,
                reason: shapeError,
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
