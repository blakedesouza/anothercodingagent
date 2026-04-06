/**
 * Tests for M7.7a: Error Taxonomy — 22 error codes, AcaError construction, serialization.
 */
import { describe, it, expect } from 'vitest';
import {
    ALL_ERROR_CODES,
    TOOL_ERRORS,
    LLM_ERRORS,
    DELEGATION_ERRORS,
    SYSTEM_ERRORS,
    createAcaError,
    serializeAcaError,
    isValidErrorCode,
    getErrorCategory,
    TypedError,
} from '../../src/types/errors.js';
import type { ErrorCode } from '../../src/types/errors.js';

// --- All 22 codes listed explicitly for parameterized testing ---

const ALL_CODES: Array<{ code: ErrorCode; category: string }> = [
    { code: 'tool.not_found', category: 'tool' },
    { code: 'tool.validation', category: 'tool' },
    { code: 'tool.execution', category: 'tool' },
    { code: 'tool.timeout', category: 'tool' },
    { code: 'tool.permission', category: 'tool' },
    { code: 'tool.sandbox', category: 'tool' },
    { code: 'llm.rate_limit', category: 'llm' },
    { code: 'llm.server_error', category: 'llm' },
    { code: 'llm.timeout', category: 'llm' },
    { code: 'llm.malformed', category: 'llm' },
    { code: 'llm.context_length', category: 'llm' },
    { code: 'llm.auth_error', category: 'llm' },
    { code: 'llm.content_filtered', category: 'llm' },
    { code: 'llm.confused', category: 'llm' },
    { code: 'delegation.spawn_failed', category: 'delegation' },
    { code: 'delegation.timeout', category: 'delegation' },
    { code: 'delegation.depth_exceeded', category: 'delegation' },
    { code: 'delegation.message_failed', category: 'delegation' },
    { code: 'system.io_error', category: 'system' },
    { code: 'system.config_error', category: 'system' },
    { code: 'system.budget_exceeded', category: 'system' },
    { code: 'system.internal', category: 'system' },
];

describe('Error Taxonomy', () => {
    it('has exactly 22 codes', () => {
        expect(ALL_ERROR_CODES).toHaveLength(22);
    });

    it('ALL_ERROR_CODES matches explicit list', () => {
        const expected = ALL_CODES.map(c => c.code);
        expect([...ALL_ERROR_CODES].sort()).toEqual([...expected].sort());
    });

    it('category constants cover all codes', () => {
        const fromConstants = [
            ...Object.values(TOOL_ERRORS),
            ...Object.values(LLM_ERRORS),
            ...Object.values(DELEGATION_ERRORS),
            ...Object.values(SYSTEM_ERRORS),
        ];
        expect(fromConstants.sort()).toEqual([...ALL_ERROR_CODES].sort());
    });
});

describe('Individual error code construction (22 parameterized cases)', () => {
    it.each(ALL_CODES)('$code → constructs with message + details, serializes correctly', ({ code }) => {
        const error = createAcaError(code, `Test message for ${code}`, {
            details: { key: 'value' },
        });

        expect(error.code).toBe(code);
        expect(error.message).toBe(`Test message for ${code}`);
        expect(error.retryable).toBe(false); // default
        expect(error.details).toEqual({ key: 'value' });
        expect(error.cause).toBeUndefined();

        // Serialization round-trip
        const serialized = serializeAcaError(error);
        expect(serialized).toEqual({
            code,
            message: `Test message for ${code}`,
            retryable: false,
            details: { key: 'value' },
        });
    });
});

describe('AcaError shape', () => {
    it('serializes { code, message, retryable } at minimum', () => {
        const error = createAcaError('tool.not_found', 'File not found');
        const json = serializeAcaError(error);
        expect(json).toEqual({
            code: 'tool.not_found',
            message: 'File not found',
            retryable: false,
        });
        // No details or cause keys when not provided
        expect('details' in json).toBe(false);
        expect('cause' in json).toBe(false);
    });

    it('retryable can be set to true', () => {
        const error = createAcaError('tool.timeout', 'Timed out', { retryable: true });
        expect(error.retryable).toBe(true);
        expect(serializeAcaError(error).retryable).toBe(true);
    });

    it('serializes nested cause (delegation error chain)', () => {
        const leaf = createAcaError('llm.auth_error', 'Bad key', {
            details: { provider: 'nanogpt' },
        });
        const child = createAcaError('delegation.spawn_failed', 'Child failed', {
            cause: leaf,
        });
        const root = createAcaError('delegation.spawn_failed', 'Grandchild failed', {
            cause: child,
        });

        const serialized = serializeAcaError(root);
        expect(serialized.cause).toBeDefined();
        const childSerialized = serialized.cause as Record<string, unknown>;
        expect(childSerialized.code).toBe('delegation.spawn_failed');
        const leafSerialized = childSerialized.cause as Record<string, unknown>;
        expect(leafSerialized.code).toBe('llm.auth_error');
        expect((leafSerialized.details as Record<string, unknown>).provider).toBe('nanogpt');
    });

    it('depth-limits cause chains to prevent stack overflow', () => {
        // Build a chain deeper than 10
        let error = createAcaError('system.internal', 'leaf');
        for (let i = 0; i < 15; i++) {
            error = createAcaError('delegation.spawn_failed', `level-${i}`, { cause: error });
        }
        // Should not throw
        const serialized = serializeAcaError(error);
        // Walk to the depth limit
        let node = serialized;
        let depth = 0;
        while (node.cause) {
            node = node.cause as Record<string, unknown>;
            depth++;
        }
        // Depth capped at 11 (root + 10 levels of cause + truncated node)
        expect(depth).toBeLessThanOrEqual(11);
        expect(node.message).toBe('[cause chain too deep]');
    });
});

describe('isValidErrorCode', () => {
    it.each(ALL_CODES)('$code is valid', ({ code }) => {
        expect(isValidErrorCode(code)).toBe(true);
    });

    it('rejects unknown codes', () => {
        expect(isValidErrorCode('tool.unknown')).toBe(false);
        expect(isValidErrorCode('foo.bar')).toBe(false);
        expect(isValidErrorCode('nope')).toBe(false);
    });
});

describe('getErrorCategory', () => {
    it.each(ALL_CODES)('$code → category $category', ({ code, category }) => {
        expect(getErrorCategory(code)).toBe(category);
    });

    it('returns undefined for invalid codes', () => {
        expect(getErrorCategory('nope')).toBeUndefined();
        expect(getErrorCategory('unknown.code')).toBeUndefined();
    });
});

describe('TypedError', () => {
    it('extends Error and carries AcaError fields', () => {
        const acaError = createAcaError('tool.execution', 'Tool crashed', {
            details: { toolName: 'exec_command', exitCode: 1 },
        });
        const typed = new TypedError(acaError);

        expect(typed).toBeInstanceOf(Error);
        expect(typed.name).toBe('TypedError');
        expect(typed.message).toBe('Tool crashed');
        expect(typed.code).toBe('tool.execution');
        expect(typed.retryable).toBe(false);
        expect(typed.details).toEqual({ toolName: 'exec_command', exitCode: 1 });
    });

    it('toAcaError() round-trips correctly', () => {
        const cause = createAcaError('llm.timeout', 'Timed out');
        const original = createAcaError('delegation.timeout', 'Child timed out', {
            retryable: true,
            cause,
            details: { childAgentId: 'agt_123' },
        });
        const typed = new TypedError(original);
        const roundTripped = typed.toAcaError();

        expect(roundTripped.code).toBe('delegation.timeout');
        expect(roundTripped.message).toBe('Child timed out');
        expect(roundTripped.retryable).toBe(true);
        expect(roundTripped.details).toEqual({ childAgentId: 'agt_123' });
        expect(roundTripped.cause).toBe(cause);
    });

    it('accepts optional native cause as second argument', () => {
        const nativeErr = new SyntaxError('bad JSON');
        const typed = new TypedError(
            createAcaError('system.io_error', 'Parse failed'),
            nativeErr,
        );

        // Error.cause is ES2022 — access via cast to avoid TS exclusion in test tsconfig
        expect((typed as unknown as { cause: unknown }).cause).toBe(nativeErr);
        expect(typed.acaCause).toBeUndefined();
    });
});
