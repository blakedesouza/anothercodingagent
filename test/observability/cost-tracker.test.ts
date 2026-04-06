import { describe, it, expect } from 'vitest';
import { calculateCost, CostTracker } from '../../src/observability/cost-tracker.js';
import type { BudgetConfig } from '../../src/observability/cost-tracker.js';

// --- Pure cost calculation ---

describe('calculateCost', () => {
    it('correct USD from input/output tokens and model cost rates', () => {
        // Step file test: 1000 input + 500 output, model cost = $3/$15 per million
        const cost = calculateCost(1000, 500, { input: 3, output: 15 });
        // (1000 * 3 + 500 * 15) / 1_000_000 = (3000 + 7500) / 1_000_000 = 0.0105
        expect(cost).toBeCloseTo(0.0105, 6);
    });

    it('returns null when costPerMillion is undefined', () => {
        expect(calculateCost(1000, 500, undefined)).toBeNull();
    });

    it('returns 0 for zero tokens', () => {
        expect(calculateCost(0, 0, { input: 3, output: 15 })).toBe(0);
    });
});

// --- CostTracker class ---

describe('CostTracker', () => {
    function makeBudget(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
        return {
            session: null,
            daily: null,
            warning: 0.80,
            ...overrides,
        };
    }

    it('session accumulator: 3 LLM calls → total matches sum', () => {
        const tracker = new CostTracker(makeBudget(), 0, () => {});

        tracker.recordCost(0.003);
        tracker.recordCost(0.005);
        tracker.recordCost(0.002);

        expect(tracker.getSessionCost()).toBeCloseTo(0.010, 6);
    });

    it('budget warning at 80% of $5 budget → warning emitted at $4.00', () => {
        const warnings: string[] = [];
        const tracker = new CostTracker(
            makeBudget({ session: 5.00, warning: 0.80 }),
            0,
            (msg) => warnings.push(msg),
        );

        // Below threshold
        tracker.recordCost(3.99);
        expect(warnings).toHaveLength(0);

        // At/above 80% ($4.00)
        const result = tracker.recordCost(0.01);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Budget alert');
        expect(warnings[0]).toContain('$4.00');
        expect(warnings[0]).toContain('$5.00');
        expect(result.status).toBe('warning');
    });

    it('budget exceeded at $5.00 → turn yields with budget_exceeded', () => {
        const tracker = new CostTracker(
            makeBudget({ session: 5.00 }),
            0,
            () => {},
        );

        tracker.recordCost(4.99);
        const result = tracker.recordCost(0.02);

        expect(result.status).toBe('exceeded');
        expect(result.sessionCost).toBeCloseTo(5.01, 6);
        expect(result.sessionLimit).toBe(5.00);
        expect(result.message).toContain('Budget exceeded');
    });

    it('/budget extend 5 → budget raised to $10, execution continues', () => {
        const tracker = new CostTracker(
            makeBudget({ session: 5.00 }),
            0,
            () => {},
        );

        // Spend $4.99, just below limit
        tracker.recordCost(4.99);

        // Extend by $5
        tracker.extendSessionBudget(5);
        expect(tracker.getBudget().session).toBe(10.00);

        // Now $5.01 should be OK (well below $10)
        const result = tracker.recordCost(0.02);
        expect(result.status).toBe('ok');
    });

    it('daily budget: previous sessions cost $20, limit $25 → $5 remaining', () => {
        const warnings: string[] = [];
        const tracker = new CostTracker(
            makeBudget({ daily: 25.00, warning: 0.80 }),
            20.00, // dailyBaselineCost from SQLite
            (msg) => warnings.push(msg),
        );

        // $4.99 → daily total $24.99, which is >80% ($20) → warning
        const warn = tracker.recordCost(4.99);
        expect(warn.status).toBe('warning');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Daily budget alert');

        // $0.02 more → total $25.01 → exceeded
        const exceeded = tracker.recordCost(0.02);
        expect(exceeded.status).toBe('exceeded');
        expect(exceeded.dailyCost).toBeCloseTo(25.01, 2);
        expect(exceeded.message).toContain('Daily budget exceeded');
    });

    it('unknown model cost (null) → no budget enforcement for that call, warning not emitted', () => {
        const warnings: string[] = [];
        const tracker = new CostTracker(
            makeBudget({ session: 5.00 }),
            0,
            (msg) => warnings.push(msg),
        );

        // null cost doesn't increment accumulator
        const result = tracker.recordCost(null);
        expect(result.status).toBe('ok');
        expect(tracker.getSessionCost()).toBe(0);
        expect(warnings).toHaveLength(0);
    });

    it('daily budget mid-session: baseline=$20, limit=$25, session spends $6 → blocked at $26', () => {
        const warnings: string[] = [];
        const tracker = new CostTracker(
            makeBudget({ daily: 25.00, warning: 0.80 }),
            20.00,
            (msg) => warnings.push(msg),
        );

        // Spend $5 → total daily = $25 → should exceed
        const r1 = tracker.recordCost(3.00);
        // At $23 total daily, 92% → warning already fired (>80%)
        expect(r1.status).toBe('warning');

        const r2 = tracker.recordCost(2.00);
        // At $25 total daily → exceeded
        expect(r2.status).toBe('exceeded');

        // Spend one more → still exceeded
        const r3 = tracker.recordCost(1.00);
        expect(r3.status).toBe('exceeded');
        expect(tracker.getDailyCost()).toBeCloseTo(26.00, 2);
    });

    it('warning is only emitted once per session', () => {
        const warnings: string[] = [];
        const tracker = new CostTracker(
            makeBudget({ session: 10.00, warning: 0.80 }),
            0,
            (msg) => warnings.push(msg),
        );

        tracker.recordCost(8.00); // 80% → warning
        tracker.recordCost(0.50); // 85% → no second warning

        expect(warnings).toHaveLength(1);
    });

    it('extendSessionBudget resets warning so it fires again at new threshold', () => {
        const warnings: string[] = [];
        const tracker = new CostTracker(
            makeBudget({ session: 5.00, warning: 0.80 }),
            0,
            (msg) => warnings.push(msg),
        );

        tracker.recordCost(4.00); // 80% → warning
        expect(warnings).toHaveLength(1);

        tracker.extendSessionBudget(5); // Now limit is $10
        tracker.recordCost(4.00); // 80% of $10 = $8, total is $8 → warning
        expect(warnings).toHaveLength(2);
    });

    it('extendSessionBudget with no prior session budget creates one', () => {
        const tracker = new CostTracker(makeBudget(), 0, () => {});
        tracker.recordCost(2.00);

        tracker.extendSessionBudget(5);
        // New limit should be sessionCost + amount = $2 + $5 = $7
        expect(tracker.getBudget().session).toBe(7.00);
    });

    it('session warning does NOT suppress daily warning (independent flags)', () => {
        const warnings: string[] = [];
        // Session=$100, Daily=$50 with baseline=$30
        // Session warning at $80, daily warning at $40 (baseline+session >= 80% of $50 = $40)
        // So at session cost=$10, daily = $30+$10=$40 → daily warning
        // At session cost=$80, session warning fires
        const tracker = new CostTracker(
            makeBudget({ session: 100.00, daily: 50.00, warning: 0.80 }),
            30.00,
            (msg) => warnings.push(msg),
        );

        // $10 → session=10 (10% of $100, no session warning)
        // daily = $30+$10 = $40 (80% of $50 → daily warning)
        tracker.recordCost(10.00);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('daily budget');

        // $70 more → session=$80 (80% of $100 → session warning)
        tracker.recordCost(70.00);
        expect(warnings).toHaveLength(2);
        expect(warnings[1]).toContain('session budget');
    });

    it('no budget configured → always ok', () => {
        const tracker = new CostTracker(makeBudget(), 0, () => {});

        tracker.recordCost(100.00);
        const result = tracker.recordCost(100.00);

        expect(result.status).toBe('ok');
        expect(tracker.getSessionCost()).toBeCloseTo(200.00, 2);
    });
});
