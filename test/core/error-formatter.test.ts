/**
 * Tests for M7.7a: Mode-dependent error formatting.
 */
import { describe, it, expect } from 'vitest';
import {
    formatErrorInteractive,
    formatErrorOneShot,
    formatErrorExecutor,
} from '../../src/core/error-formatter.js';
import { createAcaError } from '../../src/types/errors.js';

describe('Interactive error format', () => {
    it('tool error → compact line with tool name and code', () => {
        const error = createAcaError('tool.not_found', 'file not found — /src/missing.ts', {
            details: { toolName: 'read_file' },
        });
        const formatted = formatErrorInteractive(error);
        expect(formatted).toBe('! read_file failed: file not found — /src/missing.ts [tool.not_found]');
    });

    it('tool error without toolName detail', () => {
        const error = createAcaError('tool.validation', 'Missing required field: path');
        const formatted = formatErrorInteractive(error);
        expect(formatted).toBe('! Missing required field: path [tool.validation]');
    });

    it('LLM error → prefixed with "LLM error:"', () => {
        const error = createAcaError('llm.rate_limit', 'rate limited after 5 retries');
        const formatted = formatErrorInteractive(error);
        expect(formatted).toBe('! LLM error: rate limited after 5 retries [llm.rate_limit]');
    });

    it('delegation error', () => {
        const error = createAcaError('delegation.timeout', 'Child timed out after 120s');
        const formatted = formatErrorInteractive(error);
        expect(formatted).toBe('! Delegation error: Child timed out after 120s [delegation.timeout]');
    });

    it('system error', () => {
        const error = createAcaError('system.internal', 'Invariant violated');
        const formatted = formatErrorInteractive(error);
        expect(formatted).toBe('! Invariant violated [system.internal]');
    });
});

describe('One-shot error format', () => {
    it('prefixed with "aca: error:" for machine parsing', () => {
        const error = createAcaError('tool.timeout', 'exec_command timed out after 60s');
        const formatted = formatErrorOneShot(error);
        expect(formatted).toBe('aca: error: tool.timeout — exec_command timed out after 60s');
    });
});

describe('Executor error format', () => {
    it('structured JSON with turnOutcome and sessionId', () => {
        const error = createAcaError('llm.rate_limit', 'Rate limited by nanogpt after 5 retries', {
            details: { provider: 'nanogpt', attempts: 5, totalWaitMs: 47200 },
        });
        const formatted = formatErrorExecutor(error, 'tool_error', 'ses_01JQ7K123');
        const parsed = JSON.parse(formatted);

        expect(parsed.status).toBe('error');
        expect(parsed.error.code).toBe('llm.rate_limit');
        expect(parsed.error.message).toBe('Rate limited by nanogpt after 5 retries');
        expect(parsed.error.retryable).toBe(false);
        expect(parsed.error.details.provider).toBe('nanogpt');
        expect(parsed.error.details.attempts).toBe(5);
        expect(parsed.turnOutcome).toBe('tool_error');
        expect(parsed.sessionId).toBe('ses_01JQ7K123');
    });

    it('omits details when not present', () => {
        const error = createAcaError('llm.auth_error', 'Auth failed');
        const formatted = formatErrorExecutor(error, 'aborted', 'ses_test');
        const parsed = JSON.parse(formatted);

        expect(parsed.error.code).toBe('llm.auth_error');
        expect('details' in parsed.error).toBe(false);
    });
});
