/**
 * `aca stats` command (Block 19, M5.5).
 *
 * Queries the SQLite observability store for session analytics:
 * - Default: last 7 days summary
 * - --session <id>: per-turn breakdown
 * - --today: today's usage + remaining budget
 * - --json: structured JSON output
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { SqliteStore } from '../observability/sqlite-store.js';
import type { SessionId } from '../types/ids.js';

// --- Result types (used for JSON output) ---

export interface SummaryResult {
    period: string;
    sessionCount: number;
    totalCostUsd: number;
    totalTokensIn: number;
    totalTokensOut: number;
    topTools: Array<{ tool: string; calls: number }>;
    errorRate: number;
    errorCount: number;
    totalToolCalls: number;
}

export interface TurnInfo {
    turn: number;
    toolCalls: string[];
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    outcome: string | null;
}

export interface SessionResult {
    sessionId: string;
    startedAt: string;
    endedAt: string | null;
    status: string;
    turns: TurnInfo[];
    totalCostUsd: number;
    totalTokensIn: number;
    totalTokensOut: number;
}

export interface TodayResult extends SummaryResult {
    remainingDailyBudget: number | null;
    dailyBudgetLimit: number | null;
}

export interface StatsOptions {
    session?: string;
    today?: boolean;
    json?: boolean;
}

export interface BudgetInfo {
    daily: number | null;
}

// --- Helpers ---

function daysAgoIso(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString();
}

function todayPrefix(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// --- Core stats logic (testable with injected store) ---

export function buildSummary(store: SqliteStore, sinceIso: string, period: string): SummaryResult {
    const sessions = store.getSessionsSince(sinceIso);
    const agg = store.getAggregateSince(sinceIso);
    const topTools = store.getTopToolsSince(sinceIso, 5);
    const errorCount = store.getToolErrorCountSince(sinceIso);
    const toolCallCount = store.getToolCallCountSince(sinceIso);
    const errorRate = toolCallCount > 0 ? (errorCount / toolCallCount) * 100 : 0;

    return {
        period,
        sessionCount: sessions.length,
        totalCostUsd: agg.totalCost,
        totalTokensIn: agg.totalTokensIn,
        totalTokensOut: agg.totalTokensOut,
        topTools: topTools.map(t => ({ tool: t.tool_name, calls: t.count })),
        errorRate,
        errorCount,
        totalToolCalls: toolCallCount,
    };
}

export function buildSessionDetail(store: SqliteStore, sessionId: string): SessionResult | null {
    const session = store.getSessionById(sessionId);
    if (!session) return null;
    return buildSessionFromEvents(store, session, sessionId);
}

function buildSessionFromEvents(
    store: SqliteStore,
    session: { session_id: string; started_at: string; ended_at: string | null; status: string },
    sessionId: string,
): SessionResult {
    const events = store.getEventsForSession(sessionId as SessionId);
    const toolCalls = store.getToolCallsForSession(sessionId as SessionId);

    // Map event_ids to tool names
    const toolCallMap = new Map<string, string>();
    for (const tc of toolCalls) {
        toolCallMap.set(tc.event_id, tc.tool_name);
    }

    // Build per-turn breakdown by processing events sequentially
    const turns: TurnInfo[] = [];
    let currentTurn = 0;
    let currentToolCalls: string[] = [];
    let currentCost = 0;
    let currentTokensIn = 0;
    let currentTokensOut = 0;

    for (const event of events) {
        if (event.event_type === 'turn.started') {
            currentTurn++;
            currentToolCalls = [];
            currentCost = 0;
            currentTokensIn = 0;
            currentTokensOut = 0;
        } else if (event.event_type === 'tool.completed') {
            const toolName = toolCallMap.get(event.event_id);
            if (toolName) currentToolCalls.push(toolName);
        } else if (event.event_type === 'llm.response') {
            try {
                const payload = JSON.parse(event.payload) as Record<string, unknown>;
                if (typeof payload.cost_usd === 'number') currentCost += payload.cost_usd;
                if (typeof payload.tokens_in === 'number') currentTokensIn += payload.tokens_in;
                if (typeof payload.tokens_out === 'number') currentTokensOut += payload.tokens_out;
            } catch { /* ignore parse errors */ }
        } else if (event.event_type === 'turn.ended') {
            let outcome: string | null = null;
            try {
                const payload = JSON.parse(event.payload) as Record<string, unknown>;
                outcome = typeof payload.outcome === 'string' ? payload.outcome : null;
            } catch { /* ignore */ }
            turns.push({
                turn: currentTurn,
                toolCalls: [...currentToolCalls],
                tokensIn: currentTokensIn,
                tokensOut: currentTokensOut,
                costUsd: currentCost,
                outcome,
            });
        }
    }

    // Flush incomplete final turn (session crashed before turn.ended)
    if (currentTurn > 0 && (turns.length === 0 || turns[turns.length - 1].turn !== currentTurn)) {
        turns.push({
            turn: currentTurn,
            toolCalls: [...currentToolCalls],
            tokensIn: currentTokensIn,
            tokensOut: currentTokensOut,
            costUsd: currentCost,
            outcome: null,
        });
    }

    const totalCost = turns.reduce((s, t) => s + t.costUsd, 0);
    const totalTokensIn = turns.reduce((s, t) => s + t.tokensIn, 0);
    const totalTokensOut = turns.reduce((s, t) => s + t.tokensOut, 0);

    return {
        sessionId,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        status: session.status,
        turns,
        totalCostUsd: totalCost,
        totalTokensIn,
        totalTokensOut,
    };
}

export function buildToday(store: SqliteStore, budgetInfo?: BudgetInfo): TodayResult {
    const since = todayPrefix();
    const summary = buildSummary(store, since, 'today');

    let remainingDailyBudget: number | null = null;
    const dailyLimit = budgetInfo?.daily ?? null;
    if (dailyLimit !== null) {
        remainingDailyBudget = Math.max(0, dailyLimit - summary.totalCostUsd);
    }

    return {
        ...summary,
        remainingDailyBudget,
        dailyBudgetLimit: dailyLimit,
    };
}

// --- Formatters ---

export function formatSummaryText(result: SummaryResult): string {
    const lines = [
        `=== ACA Stats (${result.period}) ===`,
        '',
        `Sessions:     ${result.sessionCount}`,
        `Total cost:   $${result.totalCostUsd.toFixed(4)}`,
        `Tokens:       ${result.totalTokensIn} in / ${result.totalTokensOut} out`,
        '',
        'Top tools:',
    ];

    if (result.topTools.length === 0) {
        lines.push('  (none)');
    } else {
        for (const t of result.topTools) {
            lines.push(`  ${t.tool}: ${t.calls} calls`);
        }
    }

    lines.push('');
    lines.push(`Error rate:   ${result.errorRate.toFixed(1)}% (${result.errorCount}/${result.totalToolCalls})`);

    return lines.join('\n');
}

export function formatSessionText(result: SessionResult): string {
    const lines = [
        `=== Session ${result.sessionId} ===`,
        '',
        `Started:  ${result.startedAt}`,
        `Ended:    ${result.endedAt ?? '(active)'}`,
        `Status:   ${result.status}`,
        '',
    ];

    if (result.turns.length === 0) {
        lines.push('No turns recorded.');
    } else {
        lines.push('Per-turn breakdown:');
        lines.push('');
        for (const turn of result.turns) {
            lines.push(`  Turn ${turn.turn}:`);
            lines.push(`    Tools:    ${turn.toolCalls.length > 0 ? turn.toolCalls.join(', ') : '(none)'}`);
            lines.push(`    Tokens:   ${turn.tokensIn} in / ${turn.tokensOut} out`);
            lines.push(`    Cost:     $${turn.costUsd.toFixed(4)}`);
            lines.push(`    Outcome:  ${turn.outcome ?? '(unknown)'}`);
            lines.push('');
        }
    }

    lines.push(`Total cost:   $${result.totalCostUsd.toFixed(4)}`);
    lines.push(`Total tokens: ${result.totalTokensIn} in / ${result.totalTokensOut} out`);

    return lines.join('\n');
}

export function formatTodayText(result: TodayResult): string {
    const base = formatSummaryText(result);
    const lines = [base];

    if (result.dailyBudgetLimit !== null) {
        lines.push('');
        lines.push(`Daily budget: $${result.dailyBudgetLimit.toFixed(2)}`);
        lines.push(`Remaining:    $${(result.remainingDailyBudget ?? 0).toFixed(4)}`);
    }

    return lines.join('\n');
}

// --- Entry point ---

export function runStats(options: StatsOptions, budgetInfo?: BudgetInfo): string {
    const dbPath = join(homedir(), '.aca', 'observability.db');
    const store = new SqliteStore(dbPath);

    try {
        if (!store.open()) {
            return 'No observability data found. Run some sessions first.';
        }
        if (options.session) {
            const detail = buildSessionDetail(store, options.session);
            if (!detail) return `Session ${options.session} not found.`;
            return options.json
                ? JSON.stringify(detail, null, 2)
                : formatSessionText(detail);
        }

        if (options.today) {
            const today = buildToday(store, budgetInfo);
            return options.json
                ? JSON.stringify(today, null, 2)
                : formatTodayText(today);
        }

        const summary = buildSummary(store, daysAgoIso(7), 'last 7 days');
        return options.json
            ? JSON.stringify(summary, null, 2)
            : formatSummaryText(summary);
    } finally {
        store.close();
    }
}
