import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationWriter } from '../../src/core/conversation-writer.js';
import { readConversationLog } from '../../src/core/conversation-reader.js';
import {
    createItem,
    createToolCallItem,
    createToolResultItem,
    createTurn,
    createStep,
    resetSeqCounter,
    resetStepCounter,
} from '../helpers/session-factory.js';
import { generateId } from '../../src/types/ids.js';
import type { SessionId, TurnId, ItemId } from '../../src/types/ids.js';
import type { ConversationItem, MessageItem, SummaryItem, ToolResultItem } from '../../src/types/conversation.js';
import type { TurnRecord, StepRecord } from '../../src/types/session.js';

describe('M1.2 — JSONL Conversation Log', () => {
    let tmpDir: string;
    let logPath: string;

    beforeEach(() => {
        resetSeqCounter();
        resetStepCounter();
        tmpDir = mkdtempSync(join(tmpdir(), 'aca-test-'));
        logPath = join(tmpDir, 'conversation.jsonl');
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('Round-trip: write 10 records → read back → all 10 match', () => {
        it('should write and read back 10 mixed records', () => {
            const writer = new ConversationWriter(logPath);
            const sessionId = generateId('session') as SessionId;
            const turnId = generateId('turn') as TurnId;

            // Build 10 records: 3 messages, 2 tool results, 1 summary, 2 turns, 2 steps
            const msg1 = createItem('user', 'Hello');
            const msg2 = createItem('assistant', 'Hi there');
            const msg3 = createItem('system', 'System prompt');

            const { toolCallId: tc1 } = createToolCallItem('read_file', { path: '/tmp/test' });
            const toolResult1 = createToolResultItem(tc1, 'read_file', 'file contents');

            const { toolCallId: tc2 } = createToolCallItem('write_file', { path: '/tmp/out', content: 'data' });
            const toolResult2 = createToolResultItem(tc2, 'write_file', 'written');

            const summary: SummaryItem = {
                kind: 'summary',
                id: generateId('item') as ItemId,
                seq: 100,
                text: 'Conversation summary',
                pinnedFacts: ['fact1', 'fact2'],
                coversSeq: { start: 1, end: 50 },
                timestamp: new Date().toISOString(),
            };

            const { turn: turn1 } = createTurn(sessionId, 1);
            const { turn: turn2 } = createTurn(sessionId, 2);

            const step1 = createStep(turnId, [1, 2], [3, 4]);
            const step2 = createStep(turnId, [5], [6]);

            // Write all 10
            writer.writeItem(msg1);
            writer.writeItem(msg2);
            writer.writeItem(msg3);
            writer.writeItem(toolResult1);
            writer.writeItem(toolResult2);
            writer.writeItem(summary);
            writer.writeTurn(turn1);
            writer.writeTurn(turn2);
            writer.writeStep(step1);
            writer.writeStep(step2);

            // Read back
            const { records, warnings } = readConversationLog(logPath);

            expect(warnings).toHaveLength(0);
            expect(records).toHaveLength(10);

            // Verify types
            expect(records[0].recordType).toBe('message');
            expect(records[1].recordType).toBe('message');
            expect(records[2].recordType).toBe('message');
            expect(records[3].recordType).toBe('tool_result');
            expect(records[4].recordType).toBe('tool_result');
            expect(records[5].recordType).toBe('summary');
            expect(records[6].recordType).toBe('turn');
            expect(records[7].recordType).toBe('turn');
            expect(records[8].recordType).toBe('step');
            expect(records[9].recordType).toBe('step');

            // Verify message round-trip: kind restored, recordType stripped
            const readMsg1 = records[0].record as MessageItem;
            expect(readMsg1.kind).toBe('message');
            expect((readMsg1 as Record<string, unknown>).recordType).toBeUndefined();
            expect(readMsg1.id).toBe(msg1.id);

            // Verify tool_result round-trip
            const readTr = records[3].record as ToolResultItem;
            expect(readTr.kind).toBe('tool_result');
            expect(readTr.toolName).toBe('read_file');

            // Verify summary round-trip
            const readSummary = records[5].record as SummaryItem;
            expect(readSummary.kind).toBe('summary');
            expect(readSummary.text).toBe('Conversation summary');
            expect(readSummary.pinnedFacts).toEqual(['fact1', 'fact2']);

            // Verify turn round-trip: no kind, recordType stripped
            const readTurn = records[6].record as TurnRecord;
            expect((readTurn as Record<string, unknown>).recordType).toBeUndefined();
            expect(readTurn.id).toBe(turn1.id);
            expect(readTurn.sessionId).toBe(sessionId);

            // Verify step round-trip
            const readStep = records[8].record as StepRecord;
            expect((readStep as Record<string, unknown>).recordType).toBeUndefined();
            expect(readStep.id).toBe(step1.id);
        });
    });

    describe('Crash recovery: partial last line is skipped', () => {
        it('should skip truncated JSON and return all complete records', () => {
            const writer = new ConversationWriter(logPath);

            // Write 3 valid records
            const msg1 = createItem('user', 'First message');
            const msg2 = createItem('assistant', 'Second message');
            const msg3 = createItem('user', 'Third message');
            writer.writeItem(msg1);
            writer.writeItem(msg2);
            writer.writeItem(msg3);

            // Simulate crash: append a partial JSON line (truncated)
            appendFileSync(logPath, '{"recordType":"message","id":"itm_PARTIAL","seq":99,"role":"user","parts":[{"type":"tex');

            const { records, warnings } = readConversationLog(logPath);

            expect(records).toHaveLength(3);
            expect(warnings).toHaveLength(1);
            expect(warnings[0].reason).toBe('Invalid JSON');
            expect(warnings[0].lineNumber).toBe(4);
        });
    });

    describe('Empty file returns empty array', () => {
        it('should return empty records for empty file', () => {
            writeFileSync(logPath, '');
            const { records, warnings } = readConversationLog(logPath);
            expect(records).toHaveLength(0);
            expect(warnings).toHaveLength(0);
        });

        it('should return empty records for nonexistent file', () => {
            const { records, warnings } = readConversationLog(join(tmpDir, 'nonexistent.jsonl'));
            expect(records).toHaveLength(0);
            expect(warnings).toHaveLength(0);
        });
    });

    describe('Large record (near 64 KiB)', () => {
        it('should write and read a record near 64 KiB correctly', () => {
            const writer = new ConversationWriter(logPath);

            // Create a message with ~63 KiB of text
            const largeText = 'A'.repeat(63 * 1024);
            const largeMsg = createItem('user', largeText);

            writer.writeItem(largeMsg);

            const { records, warnings } = readConversationLog(logPath);

            expect(warnings).toHaveLength(0);
            expect(records).toHaveLength(1);

            const restored = records[0].record as MessageItem;
            expect(restored.kind).toBe('message');
            expect(restored.parts[0]?.type).toBe('text');
            expect(restored.parts[0] && 'text' in restored.parts[0] ? restored.parts[0].text : undefined).toBe(largeText);
            expect(restored.parts[0] && 'text' in restored.parts[0] ? restored.parts[0].text.length : undefined).toBe(63 * 1024);
        });
    });

    describe('Concurrent append safety (O_APPEND)', () => {
        it('should not interleave lines from two writers', () => {
            const writer1 = new ConversationWriter(logPath);
            const writer2 = new ConversationWriter(logPath);

            // Write alternating records from two writers
            for (let i = 0; i < 20; i++) {
                const msg = createItem('user', `Writer${(i % 2) + 1} message ${i}`);
                if (i % 2 === 0) {
                    writer1.writeItem(msg);
                } else {
                    writer2.writeItem(msg);
                }
            }

            const { records, warnings } = readConversationLog(logPath);

            expect(warnings).toHaveLength(0);
            expect(records).toHaveLength(20);

            // Every line should be valid JSON (no interleaving)
            const rawLines = readFileSync(logPath, 'utf-8').split('\n').filter(l => l.trim() !== '');
            expect(rawLines).toHaveLength(20);
            for (const line of rawLines) {
                expect(() => JSON.parse(line)).not.toThrow();
            }
        });
    });

    describe('recordType discriminator', () => {
        it('should correctly map kind→recordType on write and recordType→kind on read', () => {
            const writer = new ConversationWriter(logPath);
            const sessionId = generateId('session') as SessionId;
            const turnId = generateId('turn') as TurnId;

            // Write one of each type
            const userMsg = createItem('user', 'hello');
            const { toolCallId } = createToolCallItem('read_file', { path: '/test' });
            const toolResult = createToolResultItem(toolCallId, 'read_file', 'content');
            const summary: SummaryItem = {
                kind: 'summary',
                id: generateId('item') as ItemId,
                seq: 50,
                text: 'Summary text',
                coversSeq: { start: 1, end: 10 },
                timestamp: new Date().toISOString(),
            };
            const { turn } = createTurn(sessionId, 1);
            const step = createStep(turnId, [1], [2]);

            writer.writeItem(userMsg);
            writer.writeItem(toolResult);
            writer.writeItem(summary);
            writer.writeTurn(turn);
            writer.writeStep(step);

            // Verify raw JSONL has recordType, not kind
            const rawLines = readFileSync(logPath, 'utf-8').split('\n').filter(l => l.trim() !== '');
            for (const line of rawLines) {
                const parsed = JSON.parse(line);
                expect(parsed).toHaveProperty('recordType');
                expect(parsed).not.toHaveProperty('kind');
            }

            // Verify reader restores kind for items, strips recordType
            const { records, warnings } = readConversationLog(logPath);
            expect(warnings).toHaveLength(0);
            expect(records).toHaveLength(5);

            // message → kind: 'message'
            expect(records[0].recordType).toBe('message');
            expect((records[0].record as MessageItem).kind).toBe('message');
            expect((records[0].record as Record<string, unknown>).recordType).toBeUndefined();

            // tool_result → kind: 'tool_result'
            expect(records[1].recordType).toBe('tool_result');
            expect((records[1].record as ToolResultItem).kind).toBe('tool_result');

            // summary → kind: 'summary'
            expect(records[2].recordType).toBe('summary');
            expect((records[2].record as SummaryItem).kind).toBe('summary');

            // turn → no kind, no recordType on record
            expect(records[3].recordType).toBe('turn');
            expect((records[3].record as Record<string, unknown>).kind).toBeUndefined();
            expect((records[3].record as Record<string, unknown>).recordType).toBeUndefined();

            // step → no kind, no recordType on record
            expect(records[4].recordType).toBe('step');
            expect((records[4].record as Record<string, unknown>).kind).toBeUndefined();
            expect((records[4].record as Record<string, unknown>).recordType).toBeUndefined();
        });
    });

    describe('Line validation: malformed lines skipped with warning', () => {
        it('should skip lines with missing recordType', () => {
            writeFileSync(logPath, '{"id":"itm_abc","seq":1}\n{"recordType":"message","kind":"message","id":"itm_def","seq":2,"role":"user","parts":[{"type":"text","text":"ok"}],"timestamp":"2026-01-01T00:00:00Z"}\n');

            const { records, warnings } = readConversationLog(logPath);

            expect(records).toHaveLength(1);
            expect(warnings).toHaveLength(1);
            expect(warnings[0].reason).toBe('Missing recordType field');
            expect(warnings[0].lineNumber).toBe(1);
        });

        it('should skip lines with unknown recordType', () => {
            writeFileSync(logPath, '{"recordType":"unknown_type","data":"test"}\n');

            const { records, warnings } = readConversationLog(logPath);

            expect(records).toHaveLength(0);
            expect(warnings).toHaveLength(1);
            expect(warnings[0].reason).toContain('Unknown recordType');
        });

        it('should skip malformed message records', () => {
            writeFileSync(
                logPath,
                '{"recordType":"message","id":"itm_bad","seq":1,"timestamp":"2026-01-01T00:00:00Z"}\n' +
                '{"recordType":"message","id":"itm_ok","seq":2,"role":"user","parts":[{"type":"text","text":"ok"}],"timestamp":"2026-01-01T00:00:01Z"}\n',
            );

            const { records, warnings } = readConversationLog(logPath);

            expect(records).toHaveLength(1);
            expect(records[0].recordType).toBe('message');
            expect((records[0].record as ConversationItem).id).toBe('itm_ok');
            expect(warnings).toHaveLength(1);
            expect(warnings[0].reason).toBe('Invalid message record shape');
        });

        it('should skip malformed turn records', () => {
            writeFileSync(
                logPath,
                '{"recordType":"turn","id":"trn_bad","sessionId":"ses_test","turnNumber":1,"itemSeqStart":1,"itemSeqEnd":2,"steps":[],"startedAt":"2026-01-01T00:00:00Z"}\n' +
                '{"recordType":"turn","id":"trn_ok","sessionId":"ses_test","turnNumber":2,"status":"completed","itemSeqStart":3,"itemSeqEnd":4,"steps":[],"startedAt":"2026-01-01T00:00:01Z","completedAt":"2026-01-01T00:00:02Z"}\n',
            );

            const { records, warnings } = readConversationLog(logPath);

            expect(records).toHaveLength(1);
            expect(records[0].recordType).toBe('turn');
            expect((records[0].record as TurnRecord).id).toBe('trn_ok');
            expect(warnings).toHaveLength(1);
            expect(warnings[0].reason).toBe('Invalid turn record shape');
        });

        it('should handle multiple malformed lines interspersed with valid ones', () => {
            const writer = new ConversationWriter(logPath);
            const msg = createItem('user', 'valid message');
            writer.writeItem(msg);

            // Append garbage
            appendFileSync(logPath, 'not json at all\n');
            appendFileSync(logPath, '{"broken": true\n');

            // Write another valid record
            const msg2 = createItem('assistant', 'also valid');
            writer.writeItem(msg2);

            const { records, warnings } = readConversationLog(logPath);

            expect(records).toHaveLength(2);
            expect(warnings).toHaveLength(2);
        });
    });
});
