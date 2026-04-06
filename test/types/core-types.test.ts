import { describe, it, expect } from 'vitest';
import { generateId, ID_PREFIXES } from '../../src/types/ids.js';
import { SequenceGenerator } from '../../src/types/sequence.js';
import type { AcaError } from '../../src/types/errors.js';
import type {
    MessageItem,
    ToolResultItem,
    SummaryItem,
    ConversationItem,
    ToolOutput,
    ToolCallPart,
    DelegationRecord,
} from '../../src/types/conversation.js';
import type { ItemId, ToolCallId, SessionId, EventId } from '../../src/types/ids.js';

// --- ULID Generation ---

describe('generateId (ULID)', () => {
    it('produces IDs with correct prefixes for all types', () => {
        for (const [type, prefix] of Object.entries(ID_PREFIXES)) {
            const id = generateId(type as keyof typeof ID_PREFIXES);
            expect(id).toMatch(new RegExp(`^${prefix}`));
        }
    });

    it('produces valid ULIDs after the prefix (26 Crockford Base32 chars)', () => {
        const id = generateId('session');
        const ulidPart = id.slice(4); // remove 'ses_'
        expect(ulidPart).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it('generates unique IDs', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) {
            ids.add(generateId('item'));
        }
        expect(ids.size).toBe(100);
    });

    it('generates time-sortable IDs', async () => {
        const id1 = generateId('turn');
        // Small delay to ensure different timestamp
        await new Promise(resolve => setTimeout(resolve, 2));
        const id2 = generateId('turn');

        // ULIDs are lexicographically sortable by time
        const ulid1 = id1.slice(4);
        const ulid2 = id2.slice(4);
        expect(ulid1 < ulid2).toBe(true);
    });
});

// --- AcaError ---

describe('AcaError', () => {
    it('requires code, message, and retryable', () => {
        const error: AcaError = {
            code: 'tool.validation',
            message: 'Missing required field: path',
            retryable: false,
        };

        expect(error.code).toBe('tool.validation');
        expect(error.message).toBe('Missing required field: path');
        expect(error.retryable).toBe(false);
    });

    it('supports optional details and cause', () => {
        const cause: AcaError = {
            code: 'system.io_error',
            message: 'original',
            retryable: false,
        };
        const error: AcaError = {
            code: 'tool.timeout',
            message: 'Timed out after 5000ms',
            retryable: true,
            details: { timeoutMs: 5000, toolName: 'read_file' },
            cause,
        };

        expect(error.details).toEqual({ timeoutMs: 5000, toolName: 'read_file' });
        expect(error.cause).toBe(cause);
    });

    it('code is a dot-delimited string', () => {
        const error: AcaError = {
            code: 'llm.rate_limit',
            message: 'Rate limited',
            retryable: true,
        };

        expect(error.code).toMatch(/^\w+\.\w+/);
    });
});

// --- SequenceGenerator ---

describe('SequenceGenerator', () => {
    it('starts at 1 by default', () => {
        const seq = new SequenceGenerator();
        expect(seq.next()).toBe(1);
    });

    it('is strictly monotonic', () => {
        const seq = new SequenceGenerator();
        const values: number[] = [];
        for (let i = 0; i < 100; i++) {
            values.push(seq.next());
        }

        // No duplicates
        expect(new Set(values).size).toBe(100);

        // Strictly increasing
        for (let i = 1; i < values.length; i++) {
            expect(values[i]).toBeGreaterThan(values[i - 1]);
        }
    });

    it('can resume from a given value', () => {
        const seq = new SequenceGenerator(42);
        expect(seq.next()).toBe(43);
        expect(seq.next()).toBe(44);
    });

    it('peek returns next value without advancing', () => {
        const seq = new SequenceGenerator();
        expect(seq.peek()).toBe(1);
        expect(seq.peek()).toBe(1);
        expect(seq.next()).toBe(1);
        expect(seq.peek()).toBe(2);
    });

    it('value returns current position', () => {
        const seq = new SequenceGenerator();
        expect(seq.value()).toBe(0);
        seq.next();
        expect(seq.value()).toBe(1);
    });
});

// --- ConversationItem discriminated union ---

describe('ConversationItem discriminated union', () => {
    const makeMessage = (): MessageItem => ({
        kind: 'message',
        id: 'itm_test' as ItemId,
        seq: 1,
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
        timestamp: new Date().toISOString(),
    });

    const makeToolResult = (): ToolResultItem => ({
        kind: 'tool_result',
        id: 'itm_test2' as ItemId,
        seq: 2,
        toolCallId: 'call_test' as ToolCallId,
        toolName: 'read_file',
        output: {
            status: 'success',
            data: 'file contents',
            truncated: false,
            bytesReturned: 13,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        },
        timestamp: new Date().toISOString(),
    });

    const makeSummary = (): SummaryItem => ({
        kind: 'summary',
        id: 'itm_test3' as ItemId,
        seq: 3,
        text: 'Summary of prior conversation',
        pinnedFacts: ['The user wants to read /tmp/test.txt'],
        coversSeq: { start: 1, end: 10 },
        timestamp: new Date().toISOString(),
    });

    it('narrows correctly via kind field', () => {
        const items: ConversationItem[] = [makeMessage(), makeToolResult(), makeSummary()];

        for (const item of items) {
            switch (item.kind) {
                case 'message':
                    expect(item.role).toBeDefined();
                    expect(item.parts).toBeDefined();
                    break;
                case 'tool_result':
                    expect(item.toolCallId).toBeDefined();
                    expect(item.output).toBeDefined();
                    break;
                case 'summary':
                    expect(item.text).toBeDefined();
                    expect(item.coversSeq).toBeDefined();
                    break;
            }
        }
    });

    it('MessageItem requires role and non-empty parts', () => {
        const msg = makeMessage();
        expect(['system', 'user', 'assistant']).toContain(msg.role);
        expect(msg.parts.length).toBeGreaterThan(0);
    });
});

// --- ToolCallPart ---

describe('ToolCallPart', () => {
    it('requires toolName, arguments, and toolCallId', () => {
        const part: ToolCallPart = {
            type: 'tool_call',
            toolCallId: generateId('toolCall') as ToolCallId,
            toolName: 'read_file',
            arguments: { path: '/tmp/test.txt' },
        };

        expect(part.toolName).toBe('read_file');
        expect(part.toolCallId).toMatch(/^call_/);
        expect(part.arguments).toEqual({ path: '/tmp/test.txt' });
    });
});

// --- ToolOutput envelope ---

describe('ToolOutput envelope', () => {
    it('validates required fields', () => {
        const output: ToolOutput = {
            status: 'success',
            data: 'content',
            truncated: false,
            bytesReturned: 7,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        };

        expect(output.status).toBe('success');
        expect(output.bytesOmitted).toBe(0);
    });

    it('bytesOmitted is correct when truncated', () => {
        const originalSize = 100_000;
        const returnedSize = 65_536;
        const output: ToolOutput = {
            status: 'success',
            data: 'x'.repeat(returnedSize),
            truncated: true,
            bytesReturned: returnedSize,
            bytesOmitted: originalSize - returnedSize,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        };

        expect(output.truncated).toBe(true);
        expect(output.bytesOmitted).toBe(34_464);
        expect(output.bytesReturned + output.bytesOmitted).toBe(originalSize);
    });

    it('error field is AcaError when status is error', () => {
        const output: ToolOutput = {
            status: 'error',
            data: '',
            error: {
                code: 'tool.not_found',
                message: 'File not found: /tmp/missing.txt',
                retryable: false,
            },
            truncated: false,
            bytesReturned: 0,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        };

        expect(output.error?.code).toBe('tool.not_found');
        expect(output.error?.message).toContain('File not found');
    });
});

// --- DelegationRecord ---

describe('DelegationRecord', () => {
    it('embeds correctly in ToolResultItem', () => {
        const delegation: DelegationRecord = {
            childSessionId: 'ses_child123' as SessionId,
            childAgentId: 'summarizer',
            finalStatus: 'completed',
            parentEventId: 'evt_parent456' as EventId,
        };

        const toolResult: ToolResultItem = {
            kind: 'tool_result',
            id: 'itm_del' as ItemId,
            seq: 5,
            toolCallId: 'call_del' as ToolCallId,
            toolName: 'delegate',
            output: {
                status: 'success',
                data: JSON.stringify(delegation),
                truncated: false,
                bytesReturned: JSON.stringify(delegation).length,
                bytesOmitted: 0,
                retryable: false,
                timedOut: false,
                mutationState: 'none',
            },
            timestamp: new Date().toISOString(),
        };

        const parsed = JSON.parse(toolResult.output.data) as DelegationRecord;
        expect(parsed.childSessionId).toBe('ses_child123');
        expect(parsed.childAgentId).toBe('summarizer');
        expect(parsed.finalStatus).toBe('completed');
    });

    it('validates required fields', () => {
        const record: DelegationRecord = {
            childSessionId: 'ses_abc' as SessionId,
            childAgentId: 'code-reviewer',
            finalStatus: 'failed',
            parentEventId: 'evt_xyz' as EventId,
        };

        expect(record.childSessionId).toMatch(/^ses_/);
        expect(record.childAgentId).toBeTruthy();
        expect(['completed', 'failed', 'cancelled']).toContain(record.finalStatus);
    });
});

// --- Serialization round-trips ---

describe('Serialization round-trips', () => {
    it('MessageItem survives JSON round-trip', () => {
        const original: MessageItem = {
            kind: 'message',
            id: generateId('item') as ItemId,
            seq: 1,
            role: 'assistant',
            parts: [
                { type: 'text', text: 'Hello' },
                {
                    type: 'tool_call',
                    toolCallId: generateId('toolCall') as ToolCallId,
                    toolName: 'read_file',
                    arguments: { path: '/tmp/test.txt' },
                },
            ],
            timestamp: new Date().toISOString(),
        };

        const roundTripped = JSON.parse(JSON.stringify(original)) as MessageItem;
        expect(roundTripped).toEqual(original);
        expect(roundTripped.kind).toBe('message');
    });

    it('ToolResultItem survives JSON round-trip', () => {
        const original: ToolResultItem = {
            kind: 'tool_result',
            id: generateId('item') as ItemId,
            seq: 2,
            toolCallId: generateId('toolCall') as ToolCallId,
            toolName: 'read_file',
            output: {
                status: 'error',
                data: '',
                error: {
                    code: 'tool.not_found',
                    message: 'Not found',
                    retryable: false,
                    details: { path: '/missing' },
                },
                truncated: false,
                bytesReturned: 0,
                bytesOmitted: 0,
                retryable: false,
                timedOut: false,
                mutationState: 'none',
            },
            timestamp: new Date().toISOString(),
        };

        const roundTripped = JSON.parse(JSON.stringify(original)) as ToolResultItem;
        expect(roundTripped).toEqual(original);
        expect(roundTripped.output.error?.code).toBe('tool.not_found');
    });

    it('SummaryItem survives JSON round-trip', () => {
        const original: SummaryItem = {
            kind: 'summary',
            id: generateId('item') as ItemId,
            seq: 3,
            text: 'The user discussed file reading.',
            pinnedFacts: ['Target file: /tmp/test.txt'],
            coversSeq: { start: 1, end: 10 },
            timestamp: new Date().toISOString(),
        };

        const roundTripped = JSON.parse(JSON.stringify(original)) as SummaryItem;
        expect(roundTripped).toEqual(original);
    });

    it('AcaError survives JSON round-trip (cause is lost if non-serializable)', () => {
        const error: AcaError = {
            code: 'tool.timeout',
            message: 'Timed out',
            retryable: true,
            details: { elapsed: 5000 },
        };

        const roundTripped = JSON.parse(JSON.stringify(error)) as AcaError;
        expect(roundTripped.code).toBe(error.code);
        expect(roundTripped.message).toBe(error.message);
        expect(roundTripped.retryable).toBe(error.retryable);
        expect(roundTripped.details).toEqual(error.details);
    });
});
