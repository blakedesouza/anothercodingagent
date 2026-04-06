/**
 * LLM retry policies and per-call retry state.
 *
 * Each error code has a defined retry policy (max attempts, backoff, health transition).
 * Retry state is per-call — each LLM API call maintains its own counter/backoff.
 * After retry exhaustion, health state transitions are emitted to the caller.
 */

import type { StreamEvent } from '../types/provider.js';
import { LLM_ERRORS } from '../types/errors.js';
import type { ErrorCode } from '../types/errors.js';

// --- Health state types ---

export type HealthState = 'unknown' | 'available' | 'degraded' | 'unavailable';

export interface HealthTransition {
    state: HealthState;
    cooldownMs?: number;
    sessionTerminal?: boolean;
}

// --- Retry policy definition ---

export interface RetryPolicy {
    /** Total attempts including the initial call. 1 = no retry. */
    maxAttempts: number;
    /** Base delay in ms before first retry. 0 = immediate. */
    baseDelayMs: number;
    /** Multiplier per subsequent retry (exponential backoff). */
    multiplier: number;
    /** Jitter range as fraction (e.g., 0.2 = ±20%). 0 = no jitter. */
    jitter: number;
    /** Max delay in ms (cap). */
    maxDelayMs: number;
    /** Health transition after retry exhaustion. undefined = no change. */
    healthTransition?: HealthTransition;
    /** For timeout errors: multiply the timeout by this factor on retry. */
    timeoutScaleFactor?: number;
}

// --- LLM retry policy table ---

export const LLM_RETRY_POLICIES: Record<string, RetryPolicy> = {
    [LLM_ERRORS.RATE_LIMIT]: {
        maxAttempts: 5,
        baseDelayMs: 1000,
        multiplier: 2,
        jitter: 0.2,
        maxDelayMs: 60_000,
        healthTransition: { state: 'degraded', cooldownMs: 5000 },
    },
    [LLM_ERRORS.SERVER_ERROR]: {
        maxAttempts: 3,
        baseDelayMs: 1000,
        multiplier: 2,
        jitter: 0.2,
        maxDelayMs: 16_000,
        healthTransition: { state: 'degraded' },
    },
    [LLM_ERRORS.TIMEOUT]: {
        maxAttempts: 2,
        baseDelayMs: 0,
        multiplier: 1,
        jitter: 0,
        maxDelayMs: 0,
        timeoutScaleFactor: 1.5,
        healthTransition: { state: 'degraded' },
    },
    [LLM_ERRORS.MALFORMED]: {
        maxAttempts: 2,
        baseDelayMs: 0,
        multiplier: 1,
        jitter: 0,
        maxDelayMs: 0,
    },
    [LLM_ERRORS.CONTEXT_LENGTH]: {
        maxAttempts: 2,
        baseDelayMs: 0,
        multiplier: 1,
        jitter: 0,
        maxDelayMs: 0,
    },
    [LLM_ERRORS.AUTH_ERROR]: {
        maxAttempts: 1,
        baseDelayMs: 0,
        multiplier: 1,
        jitter: 0,
        maxDelayMs: 0,
        healthTransition: { state: 'unavailable', sessionTerminal: true },
    },
    [LLM_ERRORS.CONTENT_FILTERED]: {
        maxAttempts: 1,
        baseDelayMs: 0,
        multiplier: 1,
        jitter: 0,
        maxDelayMs: 0,
    },
    [LLM_ERRORS.CONFUSED]: {
        maxAttempts: 1,
        baseDelayMs: 0,
        multiplier: 1,
        jitter: 0,
        maxDelayMs: 0,
    },
};

/**
 * Compute backoff delay for a given attempt number.
 * attempt is 1-indexed (attempt 1 = first retry after initial call).
 */
export function computeBackoff(attempt: number, policy: RetryPolicy, rng?: () => number): number {
    if (policy.baseDelayMs === 0) return 0;

    const base = policy.baseDelayMs * Math.pow(policy.multiplier, attempt - 1);
    const capped = Math.min(base, policy.maxDelayMs);

    if (policy.jitter === 0) return capped;

    const random = (rng ?? Math.random)();
    // ±jitter range: value * (1 - jitter) to value * (1 + jitter)
    const jittered = capped * (1 - policy.jitter + 2 * policy.jitter * random);
    return Math.round(jittered);
}

/**
 * Get the retry policy for an LLM error code.
 * Returns undefined for non-LLM codes (tool.*, delegation.*, system.*).
 */
export function getRetryPolicy(code: ErrorCode | string): RetryPolicy | undefined {
    return LLM_RETRY_POLICIES[code];
}

// --- LLM retry runner ---

export interface LlmRetryCallbacks {
    onRetry?: (attempt: number, code: string, delayMs: number) => void;
    onHealthUpdate?: (code: string, transition: HealthTransition) => void;
    /** Called for llm.context_length: attempt compression. Return true to retry. */
    onContextTooLong?: () => Promise<boolean>;
}

export interface LlmRetryResult {
    /**
     * Stream events from the final attempt (success or exhausted).
     * On error, may contain partial text_delta events before the terminal error event.
     * Callers should check for error events before rendering text content.
     */
    events: StreamEvent[];
    /** Number of attempts made (1 = no retries). */
    attempts: number;
    /** Total time spent waiting on backoff delays (ms). */
    totalWaitMs: number;
    /** Health transition emitted after exhaustion, if any. */
    healthTransition?: HealthTransition;
}

/**
 * Execute an LLM stream call with retry logic.
 *
 * The streamFactory is called for each attempt. Events from failed attempts
 * are discarded. Only events from the final attempt (success or exhaustion)
 * are returned.
 *
 * @param streamFactory Creates a new stream for each attempt.
 * @param callbacks Optional callbacks for retry progress and health updates.
 * @param sleepFn Injectable sleep for testing (default: real setTimeout).
 */
export async function executeWithLlmRetry(
    streamFactory: () => AsyncIterable<StreamEvent>,
    callbacks?: LlmRetryCallbacks,
    sleepFn: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms)),
): Promise<LlmRetryResult> {
    let attempts = 0;
    let totalWaitMs = 0;

    for (;;) {
        attempts++;
        const events: StreamEvent[] = [];
        let errorEvent: StreamEvent | null = null;

        for await (const event of streamFactory()) {
            events.push(event);
            if (event.type === 'error') {
                errorEvent = event;
            }
        }

        // No error — success
        if (!errorEvent || errorEvent.type !== 'error') {
            return { events, attempts, totalWaitMs };
        }

        const code = errorEvent.error.code;
        const policy = LLM_RETRY_POLICIES[code];

        // No retry policy or single-attempt policy — return immediately
        if (!policy || policy.maxAttempts <= 1) {
            if (policy?.healthTransition) {
                callbacks?.onHealthUpdate?.(code, policy.healthTransition);
            }
            return {
                events,
                attempts,
                totalWaitMs,
                healthTransition: policy?.healthTransition,
            };
        }

        // Retries exhausted
        if (attempts >= policy.maxAttempts) {
            if (policy.healthTransition) {
                callbacks?.onHealthUpdate?.(code, policy.healthTransition);
            }
            return {
                events,
                attempts,
                totalWaitMs,
                healthTransition: policy.healthTransition,
            };
        }

        // Special handling for context_length: compress before retry
        if (code === LLM_ERRORS.CONTEXT_LENGTH) {
            if (callbacks?.onContextTooLong) {
                const compressed = await callbacks.onContextTooLong();
                if (!compressed) {
                    return { events, attempts, totalWaitMs };
                }
                // Compression succeeded — retry without delay
                continue;
            }
            // No compression callback — return error
            return { events, attempts, totalWaitMs };
        }

        // Compute delay and wait
        const delay = computeBackoff(attempts, policy);
        callbacks?.onRetry?.(attempts, code, delay);
        if (delay > 0) {
            await sleepFn(delay);
            totalWaitMs += delay;
        }
    }
}
