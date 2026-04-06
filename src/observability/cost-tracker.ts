/**
 * Cost tracking and budget enforcement (Block 19, M5.4).
 *
 * Tracks per-event cost from model pricing, maintains an in-memory session
 * cost accumulator, and enforces session/daily budget limits. The accumulator
 * is the authoritative source for real-time budget checks — SQLite is only
 * used at session start for historical daily costs.
 */

// --- Types ---

export interface BudgetConfig {
    session: number | null;
    daily: number | null;
    warning: number; // fraction 0-1 (default 0.80)
}

export type BudgetStatus = 'ok' | 'warning' | 'exceeded';

export interface BudgetCheckResult {
    status: BudgetStatus;
    sessionCost: number;
    sessionLimit: number | null;
    dailyCost: number;
    dailyLimit: number | null;
    message: string | null;
}

// --- Pure cost calculation ---

/**
 * Calculate USD cost for a single LLM call.
 * Returns null if the model's cost data is unavailable.
 */
export function calculateCost(
    inputTokens: number,
    outputTokens: number,
    costPerMillion: { input: number; output: number } | undefined,
): number | null {
    if (!costPerMillion) return null;
    return (inputTokens * costPerMillion.input + outputTokens * costPerMillion.output) / 1_000_000;
}

// --- CostTracker class ---

export class CostTracker {
    private sessionCost = 0;
    private dailyBaselineCost = 0;
    private sessionWarningEmitted = false;
    private dailyWarningEmitted = false;
    private readonly budget: BudgetConfig;
    private readonly onWarning: (message: string) => void;

    constructor(
        budget: BudgetConfig,
        dailyBaselineCost: number,
        onWarning: (message: string) => void,
    ) {
        this.budget = budget;
        this.dailyBaselineCost = dailyBaselineCost;
        this.onWarning = onWarning;
    }

    /**
     * Record the cost of an LLM response. Returns the budget check result.
     * Called synchronously after each llm.response event.
     */
    recordCost(costUsd: number | null): BudgetCheckResult {
        if (costUsd !== null && costUsd > 0) {
            this.sessionCost += costUsd;
        }
        return this.checkBudget();
    }

    /**
     * Extend the session budget by the given amount.
     * Used by `/budget extend <amount>`.
     */
    extendSessionBudget(amount: number): void {
        if (this.budget.session !== null) {
            this.budget.session += amount;
        } else {
            this.budget.session = this.sessionCost + amount;
        }
        // Reset session warning so it can fire again at the new threshold
        this.sessionWarningEmitted = false;
    }

    /**
     * Get the current session cost accumulator value.
     */
    getSessionCost(): number {
        return this.sessionCost;
    }

    /**
     * Get the current total daily cost (baseline + session).
     */
    getDailyCost(): number {
        return this.dailyBaselineCost + this.sessionCost;
    }

    /**
     * Get the current budget config (may have been modified by extend).
     */
    getBudget(): Readonly<BudgetConfig> {
        return this.budget;
    }

    /**
     * Check budget status and emit warnings if needed.
     */
    private checkBudget(): BudgetCheckResult {
        const dailyCost = this.dailyBaselineCost + this.sessionCost;
        let status: BudgetStatus = 'ok';
        let message: string | null = null;

        // Check session budget
        if (this.budget.session !== null && this.budget.session > 0) {
            if (this.sessionCost >= this.budget.session) {
                status = 'exceeded';
                message = `Budget exceeded: $${this.sessionCost.toFixed(2)} / $${this.budget.session.toFixed(2)} session budget used`;
            } else if (!this.sessionWarningEmitted && this.sessionCost >= this.budget.session * this.budget.warning) {
                status = 'warning';
                const pct = Math.round((this.sessionCost / this.budget.session) * 100);
                message = `Budget alert: $${this.sessionCost.toFixed(2)} / $${this.budget.session.toFixed(2)} session budget used (${pct}%)`;
                this.sessionWarningEmitted = true;
                this.onWarning(message);
            }
        }

        // Check daily budget (only if session isn't already exceeded)
        if (status !== 'exceeded' && this.budget.daily !== null && this.budget.daily > 0) {
            if (dailyCost >= this.budget.daily) {
                status = 'exceeded';
                message = `Daily budget exceeded: $${dailyCost.toFixed(2)} / $${this.budget.daily.toFixed(2)}`;
            } else if (!this.dailyWarningEmitted && dailyCost >= this.budget.daily * this.budget.warning) {
                status = 'warning';
                const pct = Math.round((dailyCost / this.budget.daily) * 100);
                message = `Daily budget alert: $${dailyCost.toFixed(2)} / $${this.budget.daily.toFixed(2)} daily budget used (${pct}%)`;
                this.dailyWarningEmitted = true;
                this.onWarning(message);
            }
        }

        return {
            status,
            sessionCost: this.sessionCost,
            sessionLimit: this.budget.session,
            dailyCost,
            dailyLimit: this.budget.daily,
            message,
        };
    }
}
