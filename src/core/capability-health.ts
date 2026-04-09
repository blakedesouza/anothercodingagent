/**
 * Capability Health Tracking — per-session, in-memory health map.
 *
 * Tracks health state for each registered capability. Two kinds:
 * - local: session-scoped processes (LSP, browser, sub-agents).
 *          One lifetime restart allowed; second crash is session-terminal.
 * - http: stateless HTTP services (LLM APIs, search APIs).
 *         Cooldown + circuit breaker (2 consecutive failures → unavailable).
 *
 * Health is reactive (derived from invocation outcomes), not proactive.
 * No background polls or heartbeats — the invocation IS the health check.
 */

import type { HealthState } from './retry-policy.js';

export type { HealthState };

export type CapabilityKind = 'local' | 'http';

export interface HealthEntry {
    readonly id: string;
    state: HealthState;
    kind: CapabilityKind;
    reason?: string;
    /** Consecutive failures without a success in between (resets on success). */
    consecutiveFailures: number;
    /** Total crash count for local processes (never resets). */
    totalLocalCrashes: number;
    lastSuccessAt?: number;
    lastFailureAt?: number;
    cooldownExpiresAt?: number;
    /** How many cooldowns have been applied (for exponential backoff). Resets on success. */
    cooldownCount: number;
    sessionTerminal: boolean;
}

// --- Cooldown constants ---

export const COOLDOWN_BASE_MS = 5_000;
export const COOLDOWN_MULTIPLIER = 2;
export const COOLDOWN_CAP_MS = 60_000;
export const CIRCUIT_BREAKER_THRESHOLD = 2;

/**
 * Compute cooldown duration for the Nth cooldown (1-indexed).
 * Formula: base * 2^(n-1), capped at 60s.
 *
 * n=1 → 5s, n=2 → 10s, n=3 → 20s, n=4 → 40s, n=5+ → 60s
 */
export function computeCooldown(n: number): number {
    const safeN = Math.max(1, n);
    const ms = COOLDOWN_BASE_MS * Math.pow(COOLDOWN_MULTIPLIER, safeN - 1);
    return Math.min(ms, COOLDOWN_CAP_MS);
}

export class CapabilityHealthMap {
    private readonly entries = new Map<string, HealthEntry>();
    private readonly now: () => number;

    constructor(nowFn?: () => number) {
        this.now = nowFn ?? Date.now;
    }

    /** Register a capability. Idempotent — does not overwrite existing entries. */
    register(id: string, kind: CapabilityKind): void {
        if (!this.entries.has(id)) {
            this.entries.set(id, this.createEntry(id, kind));
        }
    }

    /** Get the current health state, checking cooldown expiry. */
    getState(id: string): HealthState {
        const entry = this.entries.get(id);
        if (!entry) return 'unknown';
        this.checkCooldown(entry);
        return entry.state;
    }

    /** Get the full health entry (for diagnostics/testing). Returns undefined for unregistered. */
    getEntry(id: string): Readonly<HealthEntry> | undefined {
        const entry = this.entries.get(id);
        if (entry) this.checkCooldown(entry);
        return entry;
    }

    /** Report a successful invocation. Resets failure counters and cooldown. No-op on session-terminal entries. */
    reportSuccess(id: string): HealthState {
        const entry = this.ensureEntry(id);
        if (entry.sessionTerminal) return entry.state;
        this.checkCooldown(entry);

        entry.state = 'available';
        entry.reason = undefined;
        entry.consecutiveFailures = 0;
        entry.lastSuccessAt = this.now();
        entry.cooldownExpiresAt = undefined;
        entry.cooldownCount = 0;

        return entry.state;
    }

    /**
     * Report a retryable failure (after retries are exhausted).
     *
     * Local: tracks crash count. First crash → degraded (restart pending).
     *        Second crash → unavailable (session-terminal).
     * HTTP:  first failure → degraded with cooldown.
     *        2 consecutive failures → circuit breaker → unavailable with cooldown.
     */
    reportRetryableFailure(id: string, reason: string): HealthState {
        const entry = this.ensureEntry(id);
        this.checkCooldown(entry);

        if (entry.sessionTerminal) return entry.state;

        entry.lastFailureAt = this.now();
        entry.reason = reason;
        entry.consecutiveFailures++;

        if (entry.kind === 'local') {
            entry.totalLocalCrashes++;
            if (entry.totalLocalCrashes >= 2) {
                entry.state = 'unavailable';
                entry.sessionTerminal = true;
            } else {
                entry.state = 'degraded';
            }
        } else {
            // HTTP: escalating cooldown + circuit breaker
            entry.cooldownCount++;
            const cooldownMs = computeCooldown(entry.cooldownCount);
            entry.cooldownExpiresAt = this.now() + cooldownMs;

            if (entry.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
                entry.state = 'unavailable';
            } else {
                entry.state = 'degraded';
            }
        }

        return entry.state;
    }

    /**
     * Report a non-retryable failure (auth, config, missing binary, boot failure).
     * Always session-terminal unavailable regardless of kind. No cooldown.
     */
    reportNonRetryableFailure(id: string, reason: string): HealthState {
        const entry = this.ensureEntry(id);

        entry.state = 'unavailable';
        entry.sessionTerminal = true;
        entry.reason = reason;
        entry.lastFailureAt = this.now();
        entry.consecutiveFailures++;
        entry.cooldownExpiresAt = undefined;

        return entry.state;
    }

    /**
     * Render health context lines for LLM injection.
     * Only includes degraded and unavailable entries.
     * Returns empty string if all capabilities are healthy.
     */
    renderHealthContext(): string {
        const lines: string[] = [];

        for (const entry of this.entries.values()) {
            this.checkCooldown(entry);

            if (entry.state === 'degraded') {
                const retrySuffix = entry.cooldownExpiresAt
                    ? `, retry ~${Math.ceil((entry.cooldownExpiresAt - this.now()) / 1000)}s`
                    : '';
                lines.push(`${entry.id}=degraded (${entry.reason ?? 'unknown'}${retrySuffix})`);
            } else if (entry.state === 'unavailable') {
                const suffix = entry.sessionTerminal
                    ? ' this session'
                    : entry.cooldownExpiresAt
                        ? `, cooldown ${Math.ceil((entry.cooldownExpiresAt - this.now()) / 1000)}s`
                        : '';
                lines.push(`${entry.id}=unavailable (${entry.reason ?? 'unknown'}${suffix})`);
            }
        }

        if (lines.length === 0) return '';
        return `Capability status: ${lines.join(' | ')}`;
    }

    /**
     * Return non-available entries in a prompt-friendly structured form.
     * Used by prompt assembly for per-turn context injection.
     */
    toPromptEntries(): Array<{ name: string; status: 'degraded' | 'unavailable'; detail?: string }> {
        const entries: Array<{ name: string; status: 'degraded' | 'unavailable'; detail?: string }> = [];

        for (const entry of this.entries.values()) {
            this.checkCooldown(entry);

            if (entry.state === 'degraded') {
                const retrySuffix = entry.cooldownExpiresAt
                    ? `, retry ~${Math.ceil((entry.cooldownExpiresAt - this.now()) / 1000)}s`
                    : '';
                entries.push({
                    name: entry.id,
                    status: 'degraded',
                    detail: `${entry.reason ?? 'unknown'}${retrySuffix}`,
                });
            } else if (entry.state === 'unavailable') {
                const suffix = entry.sessionTerminal
                    ? ' this session'
                    : entry.cooldownExpiresAt
                        ? `, cooldown ${Math.ceil((entry.cooldownExpiresAt - this.now()) / 1000)}s`
                        : '';
                entries.push({
                    name: entry.id,
                    status: 'unavailable',
                    detail: `${entry.reason ?? 'unknown'}${suffix}`,
                });
            }
        }

        return entries;
    }

    /**
     * Return the set of tool names that should be masked (removed from LLM definitions)
     * because their associated capability is unavailable.
     * Tools without a capabilityId always pass through.
     */
    getMaskedToolNames(tools: ReadonlyArray<{ spec: { name: string; capabilityId?: string } }>): Set<string> {
        const masked = new Set<string>();
        for (const tool of tools) {
            if (tool.spec.capabilityId) {
                const state = this.getState(tool.spec.capabilityId);
                if (state === 'unavailable') {
                    masked.add(tool.spec.name);
                }
            }
        }
        return masked;
    }

    // --- Private helpers ---

    private checkCooldown(entry: HealthEntry): void {
        if (entry.sessionTerminal) return;
        if (!entry.cooldownExpiresAt) return;
        if (this.now() >= entry.cooldownExpiresAt) {
            entry.state = 'unknown';
            entry.cooldownExpiresAt = undefined;
        }
    }

    private ensureEntry(id: string): HealthEntry {
        let entry = this.entries.get(id);
        if (!entry) {
            entry = this.createEntry(id, 'http');
            this.entries.set(id, entry);
        }
        return entry;
    }

    private createEntry(id: string, kind: CapabilityKind): HealthEntry {
        return {
            id,
            state: 'unknown',
            kind,
            consecutiveFailures: 0,
            totalLocalCrashes: 0,
            cooldownCount: 0,
            sessionTerminal: false,
        };
    }
}
