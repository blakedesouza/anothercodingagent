import { describe, it, expect } from 'vitest';
import { JsonlEventSink, createEvent } from '../../src/core/event-sink.js';
import type { AcaEvent, EventType } from '../../src/types/events.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/types/events.js';
import type { SessionId, EventId } from '../../src/types/ids.js';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// --- Helpers ---

function tmpDir(): string {
    const dir = join(tmpdir(), `aca-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

const TEST_SESSION_ID = 'ses_TEST000000000000000000000' as SessionId;
const TEST_AGENT_ID = 'root';

function readEvents(filePath: string): AcaEvent[] {
    const content = readFileSync(filePath, 'utf-8');
    return content
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line) as AcaEvent);
}

describe('EventSink', () => {
    it('emits session.started with correct envelope fields', () => {
        const dir = tmpDir();
        const filePath = join(dir, 'events.jsonl');
        const sink = new JsonlEventSink(filePath);

        const event = createEvent(
            'session.started',
            TEST_SESSION_ID,
            0,
            TEST_AGENT_ID,
            { workspace_id: 'wrk_abc123', model: 'claude-sonnet', provider: 'nanogpt' },
        );
        sink.emit(event);

        const events = readEvents(filePath);
        expect(events).toHaveLength(1);
        const e = events[0];
        expect(e.event_id).toMatch(/^evt_/);
        expect(e.session_id).toBe(TEST_SESSION_ID);
        expect(e.turn_number).toBe(0);
        expect(e.agent_id).toBe(TEST_AGENT_ID);
        expect(e.event_type).toBe('session.started');
        expect(e.schema_version).toBe(CURRENT_SCHEMA_VERSION);
        expect(e.payload).toEqual({
            workspace_id: 'wrk_abc123',
            model: 'claude-sonnet',
            provider: 'nanogpt',
        });
    });

    it('emits turn.started + turn.ended with outcome', () => {
        const dir = tmpDir();
        const filePath = join(dir, 'events.jsonl');
        const sink = new JsonlEventSink(filePath);

        const startEvent = createEvent(
            'turn.started',
            TEST_SESSION_ID,
            1,
            TEST_AGENT_ID,
            { turn_id: 'trn_TEST', input_preview: 'Hello world' },
        );
        sink.emit(startEvent);

        const endEvent = createEvent(
            'turn.ended',
            TEST_SESSION_ID,
            1,
            TEST_AGENT_ID,
            {
                turn_id: 'trn_TEST',
                outcome: 'assistant_final',
                step_count: 1,
                tokens_in: 100,
                tokens_out: 50,
                duration_ms: 1500,
            },
        );
        sink.emit(endEvent);

        const events = readEvents(filePath);
        expect(events).toHaveLength(2);
        expect(events[0].event_type).toBe('turn.started');
        expect(events[1].event_type).toBe('turn.ended');
        expect((events[1].payload as { outcome: string }).outcome).toBe('assistant_final');
    });

    it('emits llm.request + llm.response with token counts and latency', () => {
        const dir = tmpDir();
        const filePath = join(dir, 'events.jsonl');
        const sink = new JsonlEventSink(filePath);

        const reqEvent = createEvent(
            'llm.request',
            TEST_SESSION_ID,
            1,
            TEST_AGENT_ID,
            { model: 'claude-sonnet', provider: 'nanogpt', estimated_input_tokens: 500, tool_count: 2 },
        );
        sink.emit(reqEvent);

        const respEvent = createEvent(
            'llm.response',
            TEST_SESSION_ID,
            1,
            TEST_AGENT_ID,
            {
                model: 'claude-sonnet',
                provider: 'nanogpt',
                tokens_in: 520,
                tokens_out: 150,
                latency_ms: 2300,
                finish_reason: 'stop',
                cost_usd: null,
            },
        );
        sink.emit(respEvent);

        const events = readEvents(filePath);
        expect(events).toHaveLength(2);
        const resp = events[1].payload as { tokens_in: number; tokens_out: number; latency_ms: number };
        expect(resp.tokens_in).toBe(520);
        expect(resp.tokens_out).toBe(150);
        expect(resp.latency_ms).toBe(2300);
    });

    it('emits tool.invoked + tool.completed paired by correlation_id', () => {
        const dir = tmpDir();
        const filePath = join(dir, 'events.jsonl');
        const sink = new JsonlEventSink(filePath);

        const correlationId = 'corr_12345';

        const invokedEvent = createEvent(
            'tool.invoked',
            TEST_SESSION_ID,
            1,
            TEST_AGENT_ID,
            { tool_name: 'read_file', args_summary: '{"path":"/src/index.ts"}', correlation_id: correlationId },
        );
        sink.emit(invokedEvent);

        const completedEvent = createEvent(
            'tool.completed',
            TEST_SESSION_ID,
            1,
            TEST_AGENT_ID,
            {
                tool_name: 'read_file',
                status: 'success',
                duration_ms: 12,
                bytes_returned: 1024,
                correlation_id: correlationId,
            },
        );
        sink.emit(completedEvent);

        const events = readEvents(filePath);
        expect(events).toHaveLength(2);
        const invoked = events[0].payload as { correlation_id: string };
        const completed = events[1].payload as { correlation_id: string };
        expect(invoked.correlation_id).toBe(correlationId);
        expect(completed.correlation_id).toBe(correlationId);
        expect(invoked.correlation_id).toBe(completed.correlation_id);
    });

    it('emits delegation.started + delegation.completed with child agent info', () => {
        const dir = tmpDir();
        const filePath = join(dir, 'events.jsonl');
        const sink = new JsonlEventSink(filePath);

        const startEvent = createEvent(
            'delegation.started',
            TEST_SESSION_ID,
            1,
            TEST_AGENT_ID,
            { child_agent_id: 'sub_agent_1', task_summary: 'Search for files' },
        );
        sink.emit(startEvent);

        const endEvent = createEvent(
            'delegation.completed',
            TEST_SESSION_ID,
            1,
            TEST_AGENT_ID,
            {
                child_agent_id: 'sub_agent_1',
                final_status: 'completed',
                tokens_in: 200,
                tokens_out: 80,
            },
        );
        sink.emit(endEvent);

        const events = readEvents(filePath);
        expect(events).toHaveLength(2);
        const completed = events[1].payload as { child_agent_id: string; final_status: string };
        expect(completed.child_agent_id).toBe('sub_agent_1');
        expect(completed.final_status).toBe('completed');
    });

    it('emits error event with code, message, and context', () => {
        const dir = tmpDir();
        const filePath = join(dir, 'events.jsonl');
        const sink = new JsonlEventSink(filePath);

        const errEvent = createEvent(
            'error',
            TEST_SESSION_ID,
            1,
            TEST_AGENT_ID,
            {
                code: 'llm.rate_limit',
                message: 'Rate limit exceeded',
                context: { retry_after_ms: 5000 },
            },
        );
        sink.emit(errEvent);

        const events = readEvents(filePath);
        expect(events).toHaveLength(1);
        const payload = events[0].payload as { code: string; message: string; context: Record<string, unknown> };
        expect(payload.code).toBe('llm.rate_limit');
        expect(payload.message).toBe('Rate limit exceeded');
        expect(payload.context).toEqual({ retry_after_ms: 5000 });
    });

    it('generates unique ULID event IDs', () => {
        const dir = tmpDir();
        const filePath = join(dir, 'events.jsonl');
        const sink = new JsonlEventSink(filePath);

        const ids = new Set<string>();
        for (let i = 0; i < 20; i++) {
            const event = createEvent(
                'context.assembled',
                TEST_SESSION_ID,
                1,
                TEST_AGENT_ID,
                { estimated_tokens: 1000, token_budget: 128000, compression_tier: 'none', item_count: 10 },
            );
            sink.emit(event);
            ids.add(event.event_id);
        }

        expect(ids.size).toBe(20);

        const events = readEvents(filePath);
        const fileIds = new Set(events.map(e => e.event_id));
        expect(fileIds.size).toBe(20);
    });

    it('produces valid ISO-8601 timestamps', () => {
        const dir = tmpDir();
        const filePath = join(dir, 'events.jsonl');
        const sink = new JsonlEventSink(filePath);

        const event = createEvent(
            'session.started',
            TEST_SESSION_ID,
            0,
            TEST_AGENT_ID,
            { workspace_id: 'wrk_test', model: 'test', provider: 'test' },
        );
        sink.emit(event);

        const events = readEvents(filePath);
        const ts = events[0].timestamp;
        // Date.parse returns NaN for invalid dates
        expect(Number.isNaN(Date.parse(ts))).toBe(false);
        // ISO-8601 format check
        expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('throws on malformed event (missing required field)', () => {
        const dir = tmpDir();
        const filePath = join(dir, 'events.jsonl');
        const sink = new JsonlEventSink(filePath);

        // Create a partial event missing 'payload'
        const badEvent = {
            event_id: 'evt_TEST' as EventId,
            timestamp: new Date().toISOString(),
            session_id: TEST_SESSION_ID,
            turn_number: 0,
            agent_id: TEST_AGENT_ID,
            event_type: 'session.started' as EventType,
            schema_version: CURRENT_SCHEMA_VERSION,
            // payload intentionally missing
        } as unknown as AcaEvent<'session.started'>;

        expect(() => sink.emit(badEvent)).toThrow('Event missing required field: payload');

        // Also test missing event_id
        const noId = {
            timestamp: new Date().toISOString(),
            session_id: TEST_SESSION_ID,
            turn_number: 0,
            agent_id: TEST_AGENT_ID,
            event_type: 'error' as EventType,
            schema_version: CURRENT_SCHEMA_VERSION,
            payload: { code: 'test', message: 'test' },
        } as unknown as AcaEvent<'error'>;

        expect(() => sink.emit(noId)).toThrow('Event missing required field: event_id');
    });
});
