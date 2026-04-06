/**
 * Tests for M7.13: Capability Health Tracking.
 *
 * Covers: 4 health states, local/HTTP asymmetric policies,
 * circuit breaker, cooldown timing, LLM context rendering.
 */
import { describe, it, expect } from 'vitest';
import {
    CapabilityHealthMap,
    computeCooldown,
    COOLDOWN_BASE_MS,
} from '../../src/core/capability-health.js';

// --- Fake clock helper ---

function fakeClock(startMs = 1000) {
    let now = startMs;
    return {
        now: () => now,
        advance: (ms: number) => { now += ms; },
        set: (ms: number) => { now = ms; },
    };
}

// --- computeCooldown unit tests ---

describe('computeCooldown', () => {
    it('computes base cooldown for n=1', () => {
        expect(computeCooldown(1)).toBe(5_000);
    });

    it('doubles for each subsequent cooldown', () => {
        expect(computeCooldown(2)).toBe(10_000);
        expect(computeCooldown(3)).toBe(20_000);
        expect(computeCooldown(4)).toBe(40_000);
    });

    it('caps at 60s', () => {
        expect(computeCooldown(5)).toBe(60_000);
        expect(computeCooldown(6)).toBe(60_000);
        expect(computeCooldown(100)).toBe(60_000);
    });

    it('clamps n<1 to base cooldown', () => {
        expect(computeCooldown(0)).toBe(5_000);
        expect(computeCooldown(-1)).toBe(5_000);
    });
});

// --- CapabilityHealthMap ---

describe('CapabilityHealthMap', () => {
    // Test 1: Initial state → unknown
    describe('initial state', () => {
        it('returns unknown for unregistered capability', () => {
            const map = new CapabilityHealthMap();
            expect(map.getState('nonexistent')).toBe('unknown');
        });

        it('returns unknown for registered capability before any invocation', () => {
            const map = new CapabilityHealthMap();
            map.register('lsp:ts', 'local');
            expect(map.getState('lsp:ts')).toBe('unknown');
        });

        it('getEntry returns undefined for unregistered capability', () => {
            const map = new CapabilityHealthMap();
            expect(map.getEntry('nonexistent')).toBeUndefined();
        });

        it('register is idempotent — does not overwrite existing entry', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');
            map.reportSuccess('api');
            map.register('api', 'http'); // should not reset
            expect(map.getState('api')).toBe('available');
        });
    });

    // Test 2: Successful invocation → available
    describe('successful invocation', () => {
        it('transitions from unknown to available', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('search:tavily', 'http');
            expect(map.reportSuccess('search:tavily')).toBe('available');
            expect(map.getState('search:tavily')).toBe('available');
        });

        it('records lastSuccessAt timestamp', () => {
            const clock = fakeClock(5000);
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');
            map.reportSuccess('api');
            const entry = map.getEntry('api')!;
            expect(entry.lastSuccessAt).toBe(5000);
        });

        it('resets consecutive failures on success', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');
            map.reportRetryableFailure('api', 'rate_limited');
            expect(map.getEntry('api')!.consecutiveFailures).toBe(1);
            map.reportSuccess('api');
            expect(map.getEntry('api')!.consecutiveFailures).toBe(0);
        });

        it('resets cooldown on success', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');
            map.reportRetryableFailure('api', 'rate_limited');
            expect(map.getEntry('api')!.cooldownExpiresAt).toBeDefined();
            map.reportSuccess('api');
            expect(map.getEntry('api')!.cooldownExpiresAt).toBeUndefined();
            expect(map.getEntry('api')!.cooldownCount).toBe(0);
        });
    });

    // Test 3: Retryable failure → degraded
    describe('retryable failure', () => {
        it('transitions HTTP from unknown to degraded on first failure', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('search:tavily', 'http');
            expect(map.reportRetryableFailure('search:tavily', 'rate_limited')).toBe('degraded');
        });

        it('transitions HTTP from available to degraded on retryable failure', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');
            map.reportSuccess('api');
            expect(map.reportRetryableFailure('api', 'server_error')).toBe('degraded');
        });

        it('records reason and failure timestamp', () => {
            const clock = fakeClock(3000);
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');
            map.reportRetryableFailure('api', 'rate_limited');
            const entry = map.getEntry('api')!;
            expect(entry.reason).toBe('rate_limited');
            expect(entry.lastFailureAt).toBe(3000);
        });
    });

    // Test 4: Non-retryable failure → unavailable
    describe('non-retryable failure', () => {
        it('transitions directly to session-terminal unavailable', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('llm:anthropic', 'http');
            expect(map.reportNonRetryableFailure('llm:anthropic', 'auth_invalid')).toBe('unavailable');
            const entry = map.getEntry('llm:anthropic')!;
            expect(entry.sessionTerminal).toBe(true);
            expect(entry.cooldownExpiresAt).toBeUndefined();
        });

        it('applies to local capabilities too', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('lsp:ts', 'local');
            expect(map.reportNonRetryableFailure('lsp:ts', 'binary_not_found')).toBe('unavailable');
            expect(map.getEntry('lsp:ts')!.sessionTerminal).toBe(true);
        });

        it('session-terminal cannot be overridden by reportRetryableFailure', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');
            map.reportNonRetryableFailure('api', 'auth_invalid');
            map.reportRetryableFailure('api', 'rate_limited');
            expect(map.getState('api')).toBe('unavailable');
        });

        it('session-terminal cannot be overridden by reportSuccess', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');
            map.reportNonRetryableFailure('api', 'auth_invalid');
            expect(map.reportSuccess('api')).toBe('unavailable');
            expect(map.getState('api')).toBe('unavailable');
            expect(map.getEntry('api')!.sessionTerminal).toBe(true);
        });
    });

    // Test 5: Local process crash → restart once → available. Second crash → unavailable
    describe('local process lifecycle', () => {
        it('first crash → degraded (restart pending)', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('lsp:ts', 'local');
            expect(map.reportRetryableFailure('lsp:ts', 'process_crashed')).toBe('degraded');
            expect(map.getEntry('lsp:ts')!.totalLocalCrashes).toBe(1);
            expect(map.getEntry('lsp:ts')!.sessionTerminal).toBe(false);
        });

        it('restart success after first crash → available', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('lsp:ts', 'local');
            map.reportRetryableFailure('lsp:ts', 'process_crashed');
            expect(map.reportSuccess('lsp:ts')).toBe('available');
        });

        it('second crash → unavailable (session-terminal)', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('lsp:ts', 'local');
            map.reportRetryableFailure('lsp:ts', 'process_crashed'); // crash 1
            map.reportSuccess('lsp:ts'); // restart succeeded
            expect(map.reportRetryableFailure('lsp:ts', 'process_crashed')).toBe('unavailable'); // crash 2
            expect(map.getEntry('lsp:ts')!.sessionTerminal).toBe(true);
            expect(map.getEntry('lsp:ts')!.totalLocalCrashes).toBe(2);
        });

        it('second crash without restart also → unavailable', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('browser', 'local');
            map.reportRetryableFailure('browser', 'crash_1');
            expect(map.reportRetryableFailure('browser', 'crash_2')).toBe('unavailable');
            expect(map.getEntry('browser')!.sessionTerminal).toBe(true);
        });

        it('local unavailable has no cooldown — stays unavailable forever', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('lsp:ts', 'local');
            map.reportRetryableFailure('lsp:ts', 'crash_1');
            map.reportRetryableFailure('lsp:ts', 'crash_2');
            clock.advance(999_999);
            expect(map.getState('lsp:ts')).toBe('unavailable');
        });
    });

    // Test 6: HTTP rate limit → degraded with cooldown → expires → unknown → success → available
    describe('HTTP cooldown lifecycle', () => {
        it('rate limit → degraded with cooldown', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('llm:openai', 'http');
            map.reportRetryableFailure('llm:openai', 'rate_limited');
            const entry = map.getEntry('llm:openai')!;
            expect(entry.state).toBe('degraded');
            expect(entry.cooldownExpiresAt).toBe(COOLDOWN_BASE_MS);
        });

        it('cooldown expires → state reverts to unknown', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('llm:openai', 'http');
            map.reportRetryableFailure('llm:openai', 'rate_limited');
            clock.advance(COOLDOWN_BASE_MS);
            expect(map.getState('llm:openai')).toBe('unknown');
        });

        it('cooldown not yet expired → still degraded', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');
            map.reportRetryableFailure('api', 'rate_limited');
            clock.advance(COOLDOWN_BASE_MS - 1);
            expect(map.getState('api')).toBe('degraded');
        });

        it('full cycle: degraded → cooldown → unknown → success → available', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('search:tavily', 'http');

            map.reportRetryableFailure('search:tavily', 'rate_limited');
            expect(map.getState('search:tavily')).toBe('degraded');

            clock.advance(COOLDOWN_BASE_MS);
            expect(map.getState('search:tavily')).toBe('unknown');

            map.reportSuccess('search:tavily');
            expect(map.getState('search:tavily')).toBe('available');
        });
    });

    // Test 7: Cooldown timing — exponential backoff, cap at 60s
    describe('cooldown timing', () => {
        it('escalates: 5s, 10s, 20s, 40s, 60s (capped)', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');

            // Failure 1: cooldown = 5s
            map.reportRetryableFailure('api', 'fail_1');
            expect(map.getEntry('api')!.cooldownExpiresAt).toBe(5_000);

            // Expire cooldown, failure 2: cooldown = 10s (circuit breaker → unavailable)
            clock.advance(5_000);
            expect(map.getState('api')).toBe('unknown');
            map.reportRetryableFailure('api', 'fail_2');
            expect(map.getEntry('api')!.cooldownExpiresAt).toBe(5_000 + 10_000);

            // Expire cooldown, failure 3: cooldown = 20s
            clock.advance(10_000);
            expect(map.getState('api')).toBe('unknown');
            map.reportRetryableFailure('api', 'fail_3');
            expect(map.getEntry('api')!.cooldownExpiresAt).toBe(15_000 + 20_000);

            // Expire cooldown, failure 4: cooldown = 40s
            clock.advance(20_000);
            map.reportRetryableFailure('api', 'fail_4');
            expect(map.getEntry('api')!.cooldownExpiresAt).toBe(35_000 + 40_000);

            // Expire cooldown, failure 5: cooldown = 60s (capped)
            clock.advance(40_000);
            map.reportRetryableFailure('api', 'fail_5');
            expect(map.getEntry('api')!.cooldownExpiresAt).toBe(75_000 + 60_000);
        });
    });

    // Test 8: Circuit breaker — 2 consecutive failures → unavailable with cooldown
    describe('circuit breaker', () => {
        it('2 consecutive failures → unavailable with cooldown', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');

            map.reportRetryableFailure('api', 'fail_1');
            expect(map.getState('api')).toBe('degraded');

            clock.advance(COOLDOWN_BASE_MS); // expire first cooldown
            map.reportRetryableFailure('api', 'fail_2');
            expect(map.getState('api')).toBe('unavailable');
            expect(map.getEntry('api')!.sessionTerminal).toBe(false); // NOT session-terminal
            expect(map.getEntry('api')!.cooldownExpiresAt).toBeDefined();
        });

        it('circuit breaker cooldown expiry → unknown (not directly available)', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');

            map.reportRetryableFailure('api', 'fail_1');
            clock.advance(COOLDOWN_BASE_MS);
            map.reportRetryableFailure('api', 'fail_2');

            // Expire the circuit breaker cooldown
            clock.advance(10_000); // second cooldown is 10s
            expect(map.getState('api')).toBe('unknown');
        });

        it('success resets consecutive failure count — breaks circuit', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');

            map.reportRetryableFailure('api', 'fail_1');
            clock.advance(COOLDOWN_BASE_MS);
            map.reportSuccess('api'); // resets consecutive count
            expect(map.getEntry('api')!.consecutiveFailures).toBe(0);

            // Next failure is only 1 consecutive → degraded, not unavailable
            map.reportRetryableFailure('api', 'fail_again');
            expect(map.getState('api')).toBe('degraded');
        });
    });

    // Test 9: LLM context rendering
    describe('renderHealthContext', () => {
        it('returns empty string when all capabilities are healthy', () => {
            const map = new CapabilityHealthMap();
            map.register('api', 'http');
            map.reportSuccess('api');
            expect(map.renderHealthContext()).toBe('');
        });

        it('does not include unknown or available entries', () => {
            const map = new CapabilityHealthMap();
            map.register('a', 'http');
            map.register('b', 'http');
            map.reportSuccess('b');
            expect(map.renderHealthContext()).toBe('');
        });

        it('includes degraded capability with reason and "retry ~" suffix', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('search:tavily', 'http');
            map.reportRetryableFailure('search:tavily', 'rate_limited');
            const ctx = map.renderHealthContext();
            expect(ctx).toContain('search:tavily=degraded');
            expect(ctx).toContain('rate_limited');
            expect(ctx).toContain('retry ~');
        });

        it('includes unavailable capability with session-terminal suffix', () => {
            const clock = fakeClock();
            const map = new CapabilityHealthMap(clock.now);
            map.register('lsp:ts', 'local');
            map.reportRetryableFailure('lsp:ts', 'crash');
            map.reportRetryableFailure('lsp:ts', 'crash');
            const ctx = map.renderHealthContext();
            expect(ctx).toContain('lsp:ts=unavailable');
            expect(ctx).toContain('this session');
        });

        it('includes cooldown time for HTTP unavailable', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');
            map.reportRetryableFailure('api', 'fail_1');
            clock.advance(COOLDOWN_BASE_MS);
            map.reportRetryableFailure('api', 'fail_2');
            const ctx = map.renderHealthContext();
            expect(ctx).toContain('unavailable');
            expect(ctx).toContain('cooldown');
        });

        it('joins multiple entries with pipe separator', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('lsp:ts', 'local');
            map.register('search:tavily', 'http');
            map.reportRetryableFailure('lsp:ts', 'crash');
            map.reportRetryableFailure('search:tavily', 'rate_limited');
            const ctx = map.renderHealthContext();
            expect(ctx).toMatch(/Capability status:.*\|.*/);
        });

        it('prefixes with "Capability status:"', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');
            map.reportRetryableFailure('api', 'error');
            expect(map.renderHealthContext()).toMatch(/^Capability status:/);
        });
    });

    // Test 10: Session-terminal unavailable (local) → no cooldown expiry
    describe('session-terminal permanence', () => {
        it('local session-terminal stays unavailable regardless of time', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('playwright', 'local');
            map.reportNonRetryableFailure('playwright', 'browser_launch_failed');
            clock.advance(1_000_000);
            expect(map.getState('playwright')).toBe('unavailable');
            expect(map.getEntry('playwright')!.sessionTerminal).toBe(true);
        });

        it('HTTP session-terminal (auth) also stays unavailable', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('llm:anthropic', 'http');
            map.reportNonRetryableFailure('llm:anthropic', 'auth_invalid');
            clock.advance(1_000_000);
            expect(map.getState('llm:anthropic')).toBe('unavailable');
        });

        it('retryable failure on session-terminal entry is a no-op', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('lsp:ts', 'local');
            map.reportNonRetryableFailure('lsp:ts', 'init_failed');
            map.reportRetryableFailure('lsp:ts', 'should_be_ignored');
            const after = map.getEntry('lsp:ts')!;
            expect(after.state).toBe('unavailable');
            expect(after.reason).toBe('init_failed'); // original reason preserved
        });
    });

    // Edge cases
    describe('edge cases', () => {
        it('ensureEntry defaults to http kind for unregistered', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            // Report without registering
            map.reportRetryableFailure('unregistered', 'error');
            const entry = map.getEntry('unregistered')!;
            expect(entry.kind).toBe('http');
            expect(entry.state).toBe('degraded');
        });

        it('degraded → available on success (HTTP)', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('api', 'http');
            map.reportRetryableFailure('api', 'error');
            expect(map.getState('api')).toBe('degraded');
            map.reportSuccess('api');
            expect(map.getState('api')).toBe('available');
        });

        it('degraded → available on success (local)', () => {
            const clock = fakeClock(0);
            const map = new CapabilityHealthMap(clock.now);
            map.register('lsp:ts', 'local');
            map.reportRetryableFailure('lsp:ts', 'crash');
            expect(map.getState('lsp:ts')).toBe('degraded');
            map.reportSuccess('lsp:ts');
            expect(map.getState('lsp:ts')).toBe('available');
        });
    });
});
