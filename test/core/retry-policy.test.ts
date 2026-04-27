/**
 * Tests for M7.7a: LLM Retry Policies.
 *
 * Covers retry behavior, backoff, health transitions, per-call state isolation.
 */
import { describe, it, expect } from 'vitest';
import {
    LLM_RETRY_POLICIES,
    computeBackoff,
    getRetryPolicy,
    executeWithLlmRetry,
} from '../../src/core/retry-policy.js';
import type { HealthTransition } from '../../src/core/retry-policy.js';
import type { StreamEvent } from '../../src/types/provider.js';
import { LLM_ERRORS } from '../../src/types/errors.js';
import type { ErrorCode } from '../../src/types/errors.js';

// --- Helpers ---

function textResponse(text: string): StreamEvent[] {
    return [
        { type: 'text_delta', text },
        { type: 'done', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 3 } },
    ];
}

function errorResponse(code: string): StreamEvent[] {
    return [
        { type: 'error', error: { code, message: `Mock: ${code}` } },
    ];
}

/** Create a stream factory that returns different results per call. */
function makeStreamFactory(responses: StreamEvent[][]): () => AsyncIterable<StreamEvent> {
    let callIndex = 0;
    return () => ({
        async *[Symbol.asyncIterator]() {
            const events = responses[callIndex++] ?? [];
            for (const ev of events) yield ev;
        },
    });
}

/** No-op sleep for tests (returns immediately). */
const immediateSleep = () => Promise.resolve();

/** Sleep that tracks delay values. */
function trackingSleep(): { sleepFn: (ms: number) => Promise<void>; delays: number[] } {
    const delays: number[] = [];
    return {
        delays,
        sleepFn: (ms: number) => { delays.push(ms); return Promise.resolve(); },
    };
}

// --- Retry policy table (parameterized) ---

describe('Retry policy table', () => {
    // Tool errors: no retry
    const noRetryToolCodes: ErrorCode[] = [
        'tool.not_found', 'tool.validation', 'tool.execution', 'tool.permission', 'tool.sandbox',
    ];
    it.each(noRetryToolCodes)('%s → no retry policy (tool errors handled by ToolRunner)', (code) => {
        expect(getRetryPolicy(code)).toBeUndefined();
    });

    it('tool.timeout → no LLM retry policy (handled by ToolRunner)', () => {
        expect(getRetryPolicy('tool.timeout')).toBeUndefined();
    });

    it('llm.rate_limit → 5 attempts, exponential backoff, ±20% jitter, 60s cap, → degraded', () => {
        const p = LLM_RETRY_POLICIES[LLM_ERRORS.RATE_LIMIT];
        expect(p.maxAttempts).toBe(5);
        expect(p.baseDelayMs).toBe(1000);
        expect(p.multiplier).toBe(2);
        expect(p.jitter).toBe(0.2);
        expect(p.maxDelayMs).toBe(60_000);
        expect(p.healthTransition?.state).toBe('degraded');
    });

    it('llm.rate_limited aliases to the canonical rate-limit retry policy', () => {
        expect(getRetryPolicy('llm.rate_limited')).toBe(LLM_RETRY_POLICIES[LLM_ERRORS.RATE_LIMIT]);
    });

    it('llm.server_error → 3 attempts, 1s base, cap 16s, → degraded', () => {
        const p = LLM_RETRY_POLICIES[LLM_ERRORS.SERVER_ERROR];
        expect(p.maxAttempts).toBe(3);
        expect(p.baseDelayMs).toBe(1000);
        expect(p.maxDelayMs).toBe(16_000);
        expect(p.healthTransition?.state).toBe('degraded');
    });

    it('llm.timeout → 2 attempts, 150% timeout scale, → degraded', () => {
        const p = LLM_RETRY_POLICIES[LLM_ERRORS.TIMEOUT];
        expect(p.maxAttempts).toBe(2);
        expect(p.timeoutScaleFactor).toBe(1.5);
        expect(p.healthTransition?.state).toBe('degraded');
    });

    it('llm.malformed → 2 attempts, immediate retry (no backoff)', () => {
        const p = LLM_RETRY_POLICIES[LLM_ERRORS.MALFORMED];
        expect(p.maxAttempts).toBe(2);
        expect(p.baseDelayMs).toBe(0);
    });

    it('llm.malformed_response aliases to the canonical malformed retry policy', () => {
        expect(getRetryPolicy('llm.malformed_response')).toBe(LLM_RETRY_POLICIES[LLM_ERRORS.MALFORMED]);
    });

    it('llm.context_length → 2 attempts (1 + compress)', () => {
        const p = LLM_RETRY_POLICIES[LLM_ERRORS.CONTEXT_LENGTH];
        expect(p.maxAttempts).toBe(2);
    });

    it('llm.auth_error → 1 attempt (no retry), → unavailable session-terminal', () => {
        const p = LLM_RETRY_POLICIES[LLM_ERRORS.AUTH_ERROR];
        expect(p.maxAttempts).toBe(1);
        expect(p.healthTransition?.state).toBe('unavailable');
        expect(p.healthTransition?.sessionTerminal).toBe(true);
    });

    it('llm.content_filtered → 1 attempt (no retry)', () => {
        const p = LLM_RETRY_POLICIES[LLM_ERRORS.CONTENT_FILTERED];
        expect(p.maxAttempts).toBe(1);
    });

    it('llm.confused → 1 attempt (no retry)', () => {
        const p = LLM_RETRY_POLICIES[LLM_ERRORS.CONFUSED];
        expect(p.maxAttempts).toBe(1);
    });

    // Delegation and system: no LLM retry policy
    const nonLlmCodes: ErrorCode[] = [
        'delegation.spawn_failed', 'delegation.timeout',
        'delegation.depth_exceeded', 'delegation.message_failed',
        'system.io_error', 'system.config_error',
        'system.budget_exceeded', 'system.internal',
    ];
    it.each(nonLlmCodes)('%s → no LLM retry policy', (code) => {
        expect(getRetryPolicy(code)).toBeUndefined();
    });
});

// --- computeBackoff ---

describe('computeBackoff', () => {
    it('first retry: base delay', () => {
        const delay = computeBackoff(1, LLM_RETRY_POLICIES[LLM_ERRORS.RATE_LIMIT], () => 0.5);
        expect(delay).toBe(1000); // base * 2^0 = 1000, jitter at 0.5 → no change
    });

    it('second retry: doubled', () => {
        const delay = computeBackoff(2, LLM_RETRY_POLICIES[LLM_ERRORS.RATE_LIMIT], () => 0.5);
        expect(delay).toBe(2000); // base * 2^1 = 2000
    });

    it('respects maxDelayMs cap', () => {
        // Very high attempt number
        const delay = computeBackoff(20, LLM_RETRY_POLICIES[LLM_ERRORS.RATE_LIMIT], () => 0.5);
        expect(delay).toBe(60_000);
    });

    it('jitter at lower bound (rng=0)', () => {
        const delay = computeBackoff(1, LLM_RETRY_POLICIES[LLM_ERRORS.RATE_LIMIT], () => 0);
        // 1000 * (1 - 0.2 + 0) = 1000 * 0.8 = 800
        expect(delay).toBe(800);
    });

    it('jitter at upper bound (rng=1)', () => {
        const delay = computeBackoff(1, LLM_RETRY_POLICIES[LLM_ERRORS.RATE_LIMIT], () => 1);
        // 1000 * (1 - 0.2 + 0.4) = 1000 * 1.2 = 1200
        expect(delay).toBe(1200);
    });

    it('returns 0 when baseDelayMs is 0 (immediate retry)', () => {
        const delay = computeBackoff(1, LLM_RETRY_POLICIES[LLM_ERRORS.MALFORMED]);
        expect(delay).toBe(0);
    });
});

// --- executeWithLlmRetry ---

describe('Rate limit retry', () => {
    it('mock 429 → 5 total attempts (4 retries) with backoff → error after exhaustion', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.rate_limit'),
            errorResponse('llm.rate_limit'),
            errorResponse('llm.rate_limit'),
            errorResponse('llm.rate_limit'),
            errorResponse('llm.rate_limit'),
        ]);
        const { sleepFn, delays } = trackingSleep();
        const healthUpdates: Array<{ code: string; transition: HealthTransition }> = [];

        const result = await executeWithLlmRetry(factory, {
            onHealthUpdate: (code, transition) => healthUpdates.push({ code, transition }),
        }, sleepFn);

        expect(result.attempts).toBe(5);
        expect(delays).toHaveLength(4); // 4 waits between 5 attempts
        expect(result.healthTransition?.state).toBe('degraded');
        expect(healthUpdates).toHaveLength(1);
        expect(healthUpdates[0].code).toBe('llm.rate_limit');
        // Final events contain the error
        expect(result.events).toHaveLength(1);
        expect(result.events[0].type).toBe('error');
    });

    it('succeeds on 3rd attempt after 2 rate limits', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.rate_limit'),
            errorResponse('llm.rate_limit'),
            textResponse('success'),
        ]);

        const result = await executeWithLlmRetry(factory, undefined, immediateSleep);

        expect(result.attempts).toBe(3);
        expect(result.healthTransition).toBeUndefined();
        const doneEvent = result.events.find(e => e.type === 'done');
        expect(doneEvent).toBeDefined();
    });
});

describe('Server error retry', () => {
    it('mock 500 → 3 total attempts → health degraded after exhaustion', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.server_error'),
            errorResponse('llm.server_error'),
            errorResponse('llm.server_error'),
        ]);
        const healthUpdates: Array<{ code: string; transition: HealthTransition }> = [];

        const result = await executeWithLlmRetry(factory, {
            onHealthUpdate: (code, transition) => healthUpdates.push({ code, transition }),
        }, immediateSleep);

        expect(result.attempts).toBe(3);
        expect(result.healthTransition?.state).toBe('degraded');
        expect(healthUpdates).toHaveLength(1);
    });
});

describe('Timeout retry', () => {
    it('mock timeout → 2 total attempts → health degraded', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.timeout'),
            errorResponse('llm.timeout'),
        ]);
        const healthUpdates: Array<{ code: string; transition: HealthTransition }> = [];

        const result = await executeWithLlmRetry(factory, {
            onHealthUpdate: (code, transition) => healthUpdates.push({ code, transition }),
        }, immediateSleep);

        expect(result.attempts).toBe(2);
        expect(result.healthTransition?.state).toBe('degraded');
    });
});

describe('Auth error', () => {
    it('mock 401 → no retry, immediate error, provider unavailable', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.auth_error'),
        ]);
        const healthUpdates: Array<{ code: string; transition: HealthTransition }> = [];

        const result = await executeWithLlmRetry(factory, {
            onHealthUpdate: (code, transition) => healthUpdates.push({ code, transition }),
        }, immediateSleep);

        expect(result.attempts).toBe(1);
        expect(result.healthTransition?.state).toBe('unavailable');
        expect(result.healthTransition?.sessionTerminal).toBe(true);
        expect(healthUpdates).toHaveLength(1);
    });
});

describe('Content filter', () => {
    it('mock refusal → no retry, surfaced as error', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.content_filtered'),
        ]);

        const result = await executeWithLlmRetry(factory, undefined, immediateSleep);

        expect(result.attempts).toBe(1);
        expect(result.healthTransition).toBeUndefined();
        expect(result.events[0].type).toBe('error');
    });
});

describe('Malformed response', () => {
    it('mock bad JSON → 2 total attempts, immediate retry (no backoff)', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.malformed'),
            errorResponse('llm.malformed'),
        ]);
        const { sleepFn, delays } = trackingSleep();

        const result = await executeWithLlmRetry(factory, undefined, sleepFn);

        expect(result.attempts).toBe(2);
        // baseDelayMs=0 → no sleep calls (or zero-ms sleep)
        for (const d of delays) expect(d).toBe(0);
    });

    it('succeeds on 2nd attempt after malformed first', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.malformed'),
            textResponse('recovered'),
        ]);

        const result = await executeWithLlmRetry(factory, undefined, immediateSleep);
        expect(result.attempts).toBe(2);
        expect(result.events.some(e => e.type === 'done')).toBe(true);
    });
});

describe('Retry aliases', () => {
    it('retries provider rate_limited aliases', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.rate_limited'),
            textResponse('rate limit recovered'),
        ]);

        const result = await executeWithLlmRetry(factory, undefined, immediateSleep);

        expect(result.attempts).toBe(2);
        expect(result.events.some(e => e.type === 'done')).toBe(true);
    });

    it('retries provider malformed_response aliases', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.malformed_response'),
            textResponse('malformed recovered'),
        ]);

        const result = await executeWithLlmRetry(factory, undefined, immediateSleep);

        expect(result.attempts).toBe(2);
        expect(result.events.some(e => e.type === 'done')).toBe(true);
    });
});

describe('Context too long', () => {
    it('mock rejection → calls onContextTooLong, retries once on compression success', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.context_length'),
            textResponse('compressed response'),
        ]);
        let compressionCalled = false;

        const result = await executeWithLlmRetry(factory, {
            onContextTooLong: async () => { compressionCalled = true; return true; },
        }, immediateSleep);

        expect(compressionCalled).toBe(true);
        expect(result.attempts).toBe(2);
        expect(result.events.some(e => e.type === 'done')).toBe(true);
    });

    it('returns error if compression fails', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.context_length'),
        ]);

        const result = await executeWithLlmRetry(factory, {
            onContextTooLong: async () => false,
        }, immediateSleep);

        expect(result.attempts).toBe(1);
        expect(result.events[0].type).toBe('error');
    });

    it('returns error if no onContextTooLong callback', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.context_length'),
        ]);

        const result = await executeWithLlmRetry(factory, undefined, immediateSleep);

        expect(result.attempts).toBe(1);
    });
});

describe('Per-call state isolation', () => {
    it('rate limit on call N does not affect call N+1 retry budget', async () => {
        // Call 1: rate limited, exhausts all 5 attempts
        const factory1 = makeStreamFactory([
            errorResponse('llm.rate_limit'),
            errorResponse('llm.rate_limit'),
            errorResponse('llm.rate_limit'),
            errorResponse('llm.rate_limit'),
            errorResponse('llm.rate_limit'),
        ]);
        const result1 = await executeWithLlmRetry(factory1, undefined, immediateSleep);
        expect(result1.attempts).toBe(5);

        // Call 2: rate limited once then succeeds — full retry budget available
        const factory2 = makeStreamFactory([
            errorResponse('llm.rate_limit'),
            textResponse('success'),
        ]);
        const result2 = await executeWithLlmRetry(factory2, undefined, immediateSleep);
        expect(result2.attempts).toBe(2);
        expect(result2.events.some(e => e.type === 'done')).toBe(true);
    });
});

describe('onRetry callback', () => {
    it('called with attempt number, code, and delay', async () => {
        const factory = makeStreamFactory([
            errorResponse('llm.server_error'),
            errorResponse('llm.server_error'),
            errorResponse('llm.server_error'),
        ]);
        const retries: Array<{ attempt: number; code: string; delay: number }> = [];

        await executeWithLlmRetry(factory, {
            onRetry: (attempt, code, delay) => retries.push({ attempt, code, delay }),
        }, immediateSleep);

        expect(retries).toHaveLength(2); // 2 retries for 3 total attempts
        expect(retries[0].attempt).toBe(1);
        expect(retries[0].code).toBe('llm.server_error');
        expect(retries[1].attempt).toBe(2);
    });
});

describe('Success on first attempt', () => {
    it('returns immediately with no retries', async () => {
        const factory = makeStreamFactory([textResponse('hello')]);

        const result = await executeWithLlmRetry(factory, undefined, immediateSleep);

        expect(result.attempts).toBe(1);
        expect(result.totalWaitMs).toBe(0);
        expect(result.healthTransition).toBeUndefined();
    });
});
