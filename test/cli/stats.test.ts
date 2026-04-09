import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../../src/observability/sqlite-store.js';
import { createEvent } from '../../src/core/event-sink.js';
import type { AcaEvent } from '../../src/types/events.js';
import type { SessionId } from '../../src/types/ids.js';
import type { TurnOutcome } from '../../src/types/session.js';
import {
    buildSummary,
    buildSessionDetail,
    buildToday,
    formatSummaryText,
    formatSessionText,
    formatTodayText,
} from '../../src/cli/stats.js';
import type { SummaryResult, TodayResult } from '../../src/cli/stats.js';

// --- Helpers ---

function tmpDir(): string {
    const dir = join(tmpdir(), `aca-stats-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

const SES_1 = 'ses_STATS_TEST_00000000000001' as SessionId;
const SES_2 = 'ses_STATS_TEST_00000000000002' as SessionId;
const AGENT = 'root';

function makeSessionStarted(sessionId: SessionId): AcaEvent {
    return createEvent('session.started', sessionId, 0, AGENT, {
        workspace_id: 'wrk_test',
        model: 'claude-sonnet',
        provider: 'nanogpt',
    });
}

function makeSessionEnded(sessionId: SessionId): AcaEvent {
    return createEvent('session.ended', sessionId, 0, AGENT, {
        total_turns: 2,
        total_tokens_in: 1000,
        total_tokens_out: 500,
        duration_ms: 10000,
    });
}

function makeTurnStarted(sessionId: SessionId, turn: number): AcaEvent {
    return createEvent('turn.started', sessionId, turn, AGENT, {
        turn_id: `turn_${turn}`,
        input_preview: `User message for turn ${turn}`,
    });
}

function makeTurnEnded(sessionId: SessionId, turn: number, outcome: TurnOutcome = 'assistant_final'): AcaEvent {
    return createEvent('turn.ended', sessionId, turn, AGENT, {
        turn_id: `turn_${turn}`,
        outcome,
        step_count: 2,
        tokens_in: 500,
        tokens_out: 200,
        duration_ms: 3000,
    });
}

function makeLlmResponse(sessionId: SessionId, turn: number, costUsd: number | null = 0.005): AcaEvent {
    return createEvent('llm.response', sessionId, turn, AGENT, {
        model: 'claude-sonnet',
        provider: 'nanogpt',
        tokens_in: 500,
        tokens_out: 200,
        latency_ms: 1500,
        finish_reason: 'stop',
        cost_usd: costUsd,
    });
}

function makeToolCompleted(
    sessionId: SessionId,
    turn: number,
    toolName = 'read_file',
    status: 'success' | 'error' = 'success',
): AcaEvent {
    return createEvent('tool.completed', sessionId, turn, AGENT, {
        tool_name: toolName,
        status,
        duration_ms: 42,
        bytes_returned: 1024,
        correlation_id: 'corr_123',
    });
}

function makeError(sessionId: SessionId): AcaEvent {
    return createEvent('error', sessionId, 1, AGENT, {
        code: 'llm.timeout',
        message: 'Request timed out',
    });
}

/**
 * Seed a store with realistic session data: 2 sessions, each with turns,
 * tool calls, and one failed tool call in session 2.
 */
function seedStore(store: SqliteStore): void {
    // Session 1: 2 turns, read_file + write_file, no errors
    store.insertBatch([
        makeSessionStarted(SES_1),
        makeTurnStarted(SES_1, 1),
        makeLlmResponse(SES_1, 1, 0.003),
        makeToolCompleted(SES_1, 1, 'read_file'),
        makeLlmResponse(SES_1, 1, 0.002),
        makeTurnEnded(SES_1, 1),
        makeTurnStarted(SES_1, 2),
        makeLlmResponse(SES_1, 2, 0.004),
        makeToolCompleted(SES_1, 2, 'write_file'),
        makeLlmResponse(SES_1, 2, 0.001),
        makeTurnEnded(SES_1, 2, 'approval_required'),
        makeSessionEnded(SES_1),
    ]);

    // Session 2: 1 turn, exec_command fails once
    store.insertBatch([
        makeSessionStarted(SES_2),
        makeTurnStarted(SES_2, 1),
        makeLlmResponse(SES_2, 1, 0.006),
        makeToolCompleted(SES_2, 1, 'exec_command', 'error'),
        makeTurnEnded(SES_2, 1, 'assistant_final'),
        makeSessionEnded(SES_2),
    ]);
}

// --- Tests ---

describe('aca stats — default summary', () => {
    let dir: string;
    let store: SqliteStore;

    beforeEach(() => {
        dir = tmpDir();
        store = new SqliteStore(join(dir, 'observability.db'));
        store.open();
    });

    afterEach(() => {
        store.close();
    });

    it('default output contains: session count, total cost, tokens, top tools, error rate', () => {
        seedStore(store);
        const since = '1970-01-01T00:00:00.000Z'; // all time
        const result = buildSummary(store, since, 'last 7 days');

        expect(result.sessionCount).toBe(2);
        expect(result.totalCostUsd).toBeCloseTo(0.016, 4); // 0.003+0.002+0.004+0.001+0.006
        expect(result.totalTokensIn).toBe(2500); // 5 llm.response × 500
        expect(result.totalTokensOut).toBe(1000); // 5 llm.response × 200
        expect(result.topTools.length).toBeGreaterThanOrEqual(1);
        expect(result.topTools.length).toBeLessThanOrEqual(5);
        // read_file: 1, write_file: 1, exec_command: 1
        expect(result.topTools.map(t => t.tool)).toContain('read_file');
        expect(result.totalToolCalls).toBe(3);
        expect(result.errorCount).toBe(1);
        expect(result.errorRate).toBeCloseTo((1 / 3) * 100, 1); // ~33.3%

        // Text format contains key fields
        const text = formatSummaryText(result);
        expect(text).toContain('Sessions:');
        expect(text).toContain('Total cost:');
        expect(text).toContain('Tokens:');
        expect(text).toContain('Top tools:');
        expect(text).toContain('Error rate:');
        expect(text).toContain('read_file');
    });

    it('ignores non-tool runtime errors when computing tool error rate', () => {
        store.insertBatch([
            makeSessionStarted(SES_1),
            makeTurnStarted(SES_1, 1),
            makeToolCompleted(SES_1, 1, 'read_file', 'error'),
            makeError(SES_1),
            makeTurnEnded(SES_1, 1),
            makeSessionEnded(SES_1),
        ]);

        const result = buildSummary(store, '1970-01-01T00:00:00.000Z', 'last 7 days');

        expect(result.totalToolCalls).toBe(1);
        expect(result.errorCount).toBe(1);
        expect(result.errorRate).toBe(100);
    });
});

describe('aca stats --session', () => {
    let dir: string;
    let store: SqliteStore;

    beforeEach(() => {
        dir = tmpDir();
        store = new SqliteStore(join(dir, 'observability.db'));
        store.open();
    });

    afterEach(() => {
        store.close();
    });

    it('per-turn breakdown: turn number, tool calls, tokens, cost, outcome', () => {
        seedStore(store);
        const detail = buildSessionDetail(store, SES_1);

        expect(detail).not.toBeNull();
        expect(detail!.sessionId).toBe(SES_1);
        expect(detail!.turns).toHaveLength(2);

        // Turn 1: read_file, 0.003+0.002=0.005 cost
        const t1 = detail!.turns[0];
        expect(t1.turn).toBe(1);
        expect(t1.toolCalls).toContain('read_file');
        expect(t1.tokensIn).toBe(1000); // 2 llm.response × 500
        expect(t1.tokensOut).toBe(400); // 2 × 200
        expect(t1.costUsd).toBeCloseTo(0.005, 4);
        expect(t1.outcome).toBe('assistant_final');

        // Turn 2: write_file, 0.004+0.001=0.005 cost
        const t2 = detail!.turns[1];
        expect(t2.turn).toBe(2);
        expect(t2.toolCalls).toContain('write_file');
        expect(t2.costUsd).toBeCloseTo(0.005, 4);
        expect(t2.outcome).toBe('approval_required');

        // Text format
        const text = formatSessionText(detail!);
        expect(text).toContain('Turn 1:');
        expect(text).toContain('Turn 2:');
        expect(text).toContain('read_file');
        expect(text).toContain('write_file');
        expect(text).toContain('Total cost:');
    });

    it('nonexistent session returns null', () => {
        seedStore(store);
        const detail = buildSessionDetail(store, 'ses_NONEXISTENT');
        expect(detail).toBeNull();
    });
});

describe('aca stats --today', () => {
    let dir: string;
    let store: SqliteStore;

    beforeEach(() => {
        dir = tmpDir();
        store = new SqliteStore(join(dir, 'observability.db'));
        store.open();
    });

    afterEach(() => {
        store.close();
    });

    it('today stats show session count, cost, remaining daily budget, tokens', () => {
        seedStore(store);

        const result = buildToday(store, { daily: 25.0 });

        // Sessions are created with current timestamps, so they count as "today"
        expect(result.sessionCount).toBe(2);
        expect(result.totalCostUsd).toBeCloseTo(0.016, 4);
        expect(result.totalTokensIn).toBe(2500);
        expect(result.totalTokensOut).toBe(1000);
        expect(result.dailyBudgetLimit).toBe(25.0);
        expect(result.remainingDailyBudget).toBeCloseTo(25.0 - 0.016, 4);

        const text = formatTodayText(result);
        expect(text).toContain('Daily budget:');
        expect(text).toContain('Remaining:');
    });

    it('no daily budget configured → remainingDailyBudget is null', () => {
        seedStore(store);
        const result = buildToday(store);
        expect(result.dailyBudgetLimit).toBeNull();
        expect(result.remainingDailyBudget).toBeNull();
    });
});

describe('aca stats --json', () => {
    let dir: string;
    let store: SqliteStore;

    beforeEach(() => {
        dir = tmpDir();
        store = new SqliteStore(join(dir, 'observability.db'));
        store.open();
    });

    afterEach(() => {
        store.close();
    });

    it('JSON output is valid and parseable with same fields as text mode', () => {
        seedStore(store);
        const since = '1970-01-01T00:00:00.000Z';
        const result = buildSummary(store, since, 'last 7 days');
        const jsonStr = JSON.stringify(result, null, 2);

        const parsed = JSON.parse(jsonStr) as SummaryResult;
        expect(parsed.sessionCount).toBe(2);
        expect(parsed.totalCostUsd).toBeCloseTo(0.016, 4);
        expect(parsed.totalTokensIn).toBe(2500);
        expect(parsed.totalTokensOut).toBe(1000);
        expect(parsed.topTools).toBeInstanceOf(Array);
        expect(typeof parsed.errorRate).toBe('number');
        expect(typeof parsed.errorCount).toBe('number');
        expect(typeof parsed.totalToolCalls).toBe('number');
    });

    it('--json --session produces valid JSON', () => {
        seedStore(store);
        const detail = buildSessionDetail(store, SES_1);
        expect(detail).not.toBeNull();

        const jsonStr = JSON.stringify(detail, null, 2);
        const parsed = JSON.parse(jsonStr);
        expect(parsed.sessionId).toBe(SES_1);
        expect(parsed.turns).toBeInstanceOf(Array);
        expect(parsed.turns.length).toBe(2);
    });

    it('--json --today produces valid JSON with budget fields', () => {
        seedStore(store);
        const result = buildToday(store, { daily: 25.0 });
        const jsonStr = JSON.stringify(result, null, 2);

        const parsed = JSON.parse(jsonStr) as TodayResult;
        expect(parsed.dailyBudgetLimit).toBe(25.0);
        expect(typeof parsed.remainingDailyBudget).toBe('number');
        expect(parsed.sessionCount).toBe(2);
    });
});

describe('aca stats — no sessions', () => {
    let dir: string;
    let store: SqliteStore;

    beforeEach(() => {
        dir = tmpDir();
        store = new SqliteStore(join(dir, 'observability.db'));
        store.open();
    });

    afterEach(() => {
        store.close();
    });

    it('no sessions → graceful empty output, not an error', () => {
        const since = '1970-01-01T00:00:00.000Z';
        const result = buildSummary(store, since, 'last 7 days');

        expect(result.sessionCount).toBe(0);
        expect(result.totalCostUsd).toBe(0);
        expect(result.totalTokensIn).toBe(0);
        expect(result.totalTokensOut).toBe(0);
        expect(result.topTools).toEqual([]);
        expect(result.errorCount).toBe(0);
        expect(result.errorRate).toBe(0);

        const text = formatSummaryText(result);
        expect(text).toContain('Sessions:     0');
        expect(text).toContain('(none)');
    });
});
