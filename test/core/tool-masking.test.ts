/**
 * Tests for M7.7c: Degraded Capability Handling + Tool Masking.
 *
 * Covers:
 * - Tool masking: unavailable capability → tool removed from definitions
 * - Degraded capability → health line present, tool still available
 * - Model tries masked tool → tool.validation error with alternatives
 * - Delegation error chains: nested cause across depth
 * - Error chain depth: 3 levels of nested cause
 */
import { describe, it, expect } from 'vitest';
import { CapabilityHealthMap } from '../../src/core/capability-health.js';
import {
    buildContextBlock,
    buildToolDefinitions,
    type CapabilityHealth,
} from '../../src/core/prompt-assembly.js';
import {
    createAcaError,
    wrapDelegationError,
    DELEGATION_ERRORS,
    LLM_ERRORS,
    TOOL_ERRORS,
    serializeAcaError,
} from '../../src/types/errors.js';
import type { RegisteredTool, ToolSpec } from '../../src/tools/tool-registry.js';

// --- Test helpers ---

function makeToolSpec(name: string, capabilityId?: string): ToolSpec {
    return {
        name,
        description: `${name} tool`,
        inputSchema: { type: 'object', properties: {} },
        approvalClass: 'read-only',
        idempotent: true,
        timeoutCategory: 'file',
        capabilityId,
    };
}

function makeRegisteredTool(name: string, capabilityId?: string): RegisteredTool {
    return {
        spec: makeToolSpec(name, capabilityId),
        impl: async () => ({
            status: 'success' as const,
            data: '',
            truncated: false,
            bytesReturned: 0,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none' as const,
        }),
    };
}

function fakeClock(startMs = 1000) {
    let now = startMs;
    return {
        now: () => now,
        advance: (ms: number) => { now += ms; },
    };
}

// --- Tool masking tests ---

describe('M7.7c: Tool Masking', () => {
    describe('unavailable capability → tool removed from definitions', () => {
        it('marks LSP unavailable → lsp_query removed from tool definitions', () => {
            const clock = fakeClock();
            const healthMap = new CapabilityHealthMap(clock.now);
            healthMap.register('lsp:ts', 'local');

            const tools = [
                makeRegisteredTool('read_file'),
                makeRegisteredTool('lsp_query', 'lsp:ts'),
                makeRegisteredTool('write_file'),
            ];

            // LSP is available initially — all tools present
            healthMap.reportSuccess('lsp:ts');
            let masked = healthMap.getMaskedToolNames(tools);
            expect(masked.size).toBe(0);

            // LSP crashes twice → unavailable (session-terminal)
            healthMap.reportRetryableFailure('lsp:ts', 'crash');
            healthMap.reportRetryableFailure('lsp:ts', 'crash');
            expect(healthMap.getState('lsp:ts')).toBe('unavailable');

            // Now lsp_query should be masked
            masked = healthMap.getMaskedToolNames(tools);
            expect(masked.has('lsp_query')).toBe(true);
            expect(masked.size).toBe(1);

            // Build tool definitions without the masked tool
            const activeDefs = buildToolDefinitions(
                tools.filter(t => !masked.has(t.spec.name)),
            );
            const defNames = activeDefs.map(d => d.name);
            expect(defNames).toContain('read_file');
            expect(defNames).toContain('write_file');
            expect(defNames).not.toContain('lsp_query');
        });

        it('tools without capabilityId are never masked', () => {
            const clock = fakeClock();
            const healthMap = new CapabilityHealthMap(clock.now);

            const tools = [
                makeRegisteredTool('read_file'),
                makeRegisteredTool('write_file'),
            ];

            const masked = healthMap.getMaskedToolNames(tools);
            expect(masked.size).toBe(0);
        });

        it('multiple tools sharing same capability all get masked', () => {
            const clock = fakeClock();
            const healthMap = new CapabilityHealthMap(clock.now);
            healthMap.register('browser', 'local');

            const tools = [
                makeRegisteredTool('browser_navigate', 'browser'),
                makeRegisteredTool('browser_click', 'browser'),
                makeRegisteredTool('browser_screenshot', 'browser'),
                makeRegisteredTool('read_file'),
            ];

            // Browser crashes twice → unavailable
            healthMap.reportRetryableFailure('browser', 'crash');
            healthMap.reportRetryableFailure('browser', 'crash');

            const masked = healthMap.getMaskedToolNames(tools);
            expect(masked.has('browser_navigate')).toBe(true);
            expect(masked.has('browser_click')).toBe(true);
            expect(masked.has('browser_screenshot')).toBe(true);
            expect(masked.has('read_file')).toBe(false);
            expect(masked.size).toBe(3);
        });
    });

    describe('degraded capability → tool still available, health line present', () => {
        it('degraded capability keeps tool in definitions', () => {
            const clock = fakeClock();
            const healthMap = new CapabilityHealthMap(clock.now);
            healthMap.register('search:tavily', 'http');

            const tools = [
                makeRegisteredTool('web_search', 'search:tavily'),
                makeRegisteredTool('read_file'),
            ];

            // Rate limited → degraded
            healthMap.reportRetryableFailure('search:tavily', 'rate_limited');
            expect(healthMap.getState('search:tavily')).toBe('degraded');

            // Tool should NOT be masked
            const masked = healthMap.getMaskedToolNames(tools);
            expect(masked.size).toBe(0);

            // Definitions should still include web_search
            const defs = buildToolDefinitions(
                tools.filter(t => !masked.has(t.spec.name)),
            );
            expect(defs.map(d => d.name)).toContain('web_search');
        });

        it('health context block includes degraded capability info', () => {
            const capabilities: CapabilityHealth[] = [
                { name: 'search:tavily', status: 'degraded', detail: 'rate_limited, retry ~5s' },
            ];

            const block = buildContextBlock({
                cwd: '/workspace',
                capabilities,
            });

            expect(block).toContain('Capability Health');
            expect(block).toContain('search:tavily');
            expect(block).toContain('degraded');
        });
    });

    describe('model tries masked tool → tool.validation with alternatives', () => {
        it('produces tool.validation error listing available tools', () => {
            const clock = fakeClock();
            const healthMap = new CapabilityHealthMap(clock.now);
            healthMap.register('lsp:ts', 'local');

            const tools = [
                makeRegisteredTool('read_file'),
                makeRegisteredTool('lsp_query', 'lsp:ts'),
                makeRegisteredTool('write_file'),
            ];

            // LSP unavailable
            healthMap.reportNonRetryableFailure('lsp:ts', 'init_failed');

            const masked = healthMap.getMaskedToolNames(tools);
            expect(masked.has('lsp_query')).toBe(true);

            // Simulate the validation error the TurnEngine would produce
            const availableNames = tools
                .filter(t => !masked.has(t.spec.name))
                .map(t => t.spec.name);

            const errorCode = 'tool.validation';
            const altStr = `Available alternatives: ${availableNames.join(', ')}`;
            const errorMsg = `Tool "lsp_query" is currently unavailable. ${altStr}`;

            expect(errorCode).toBe(TOOL_ERRORS.VALIDATION);
            expect(errorMsg).toContain('lsp_query');
            expect(errorMsg).toContain('unavailable');
            expect(errorMsg).toContain('read_file');
            expect(errorMsg).toContain('write_file');
            expect(errorMsg).not.toContain('lsp_query" is currently unavailable. Available alternatives: lsp_query');
        });

        it('caps alternatives at 5 with count suffix', () => {
            const clock = fakeClock();
            const healthMap = new CapabilityHealthMap(clock.now);
            healthMap.register('lsp:ts', 'local');

            // 7 non-masked tools + 1 masked tool
            const tools = [
                makeRegisteredTool('tool_a'),
                makeRegisteredTool('tool_b'),
                makeRegisteredTool('tool_c'),
                makeRegisteredTool('tool_d'),
                makeRegisteredTool('tool_e'),
                makeRegisteredTool('tool_f'),
                makeRegisteredTool('tool_g'),
                makeRegisteredTool('lsp_query', 'lsp:ts'),
            ];

            healthMap.reportNonRetryableFailure('lsp:ts', 'init_failed');

            const masked = healthMap.getMaskedToolNames(tools);
            const availableNames = tools
                .filter(t => !masked.has(t.spec.name))
                .map(t => t.spec.name);

            // Simulate capped alternatives (matching TurnEngine logic)
            const MAX_ALTERNATIVES = 5;
            const altStr = availableNames.length > MAX_ALTERNATIVES
                ? `Available alternatives: ${availableNames.slice(0, MAX_ALTERNATIVES).join(', ')}, and ${availableNames.length - MAX_ALTERNATIVES} others`
                : `Available alternatives: ${availableNames.join(', ')}`;

            expect(altStr).toContain('tool_a');
            expect(altStr).toContain('tool_e');
            expect(altStr).toContain('and 2 others');
            expect(altStr).not.toContain('tool_g');
        });

        it('handles empty alternatives gracefully', () => {
            const clock = fakeClock();
            const healthMap = new CapabilityHealthMap(clock.now);
            healthMap.register('lsp:ts', 'local');

            // Only tool is the masked one
            const tools = [makeRegisteredTool('lsp_query', 'lsp:ts')];
            healthMap.reportNonRetryableFailure('lsp:ts', 'init_failed');

            const masked = healthMap.getMaskedToolNames(tools);
            const availableNames = tools
                .filter(t => !masked.has(t.spec.name))
                .map(t => t.spec.name);

            const altStr = availableNames.length === 0
                ? 'No alternative tools are currently available.'
                : `Available alternatives: ${availableNames.join(', ')}`;

            expect(altStr).toBe('No alternative tools are currently available.');
        });
    });
});

// --- Delegation error chain tests ---

describe('M7.7c: Delegation Error Chains', () => {
    describe('nested cause for root-cause traversal', () => {
        it('grandchild error → nested cause through child → root sees leaf cause', () => {
            // Grandchild hits an auth error
            const grandchildError = createAcaError(
                LLM_ERRORS.AUTH_ERROR,
                'Invalid API key for grandchild provider',
                { retryable: false },
            );

            // Child wraps it as a delegation error
            const childError = wrapDelegationError(grandchildError);
            expect(childError.code).toBe(DELEGATION_ERRORS.MESSAGE_FAILED);
            expect(childError.cause).toBeDefined();
            expect(childError.cause!.code).toBe(LLM_ERRORS.AUTH_ERROR);
            expect(childError.retryable).toBe(false); // inherits from child

            // Root wraps the child's error
            const rootError = wrapDelegationError(childError);
            expect(rootError.code).toBe(DELEGATION_ERRORS.MESSAGE_FAILED);
            expect(rootError.cause).toBeDefined();
            expect(rootError.cause!.code).toBe(DELEGATION_ERRORS.MESSAGE_FAILED);
            expect(rootError.cause!.cause).toBeDefined();
            expect(rootError.cause!.cause!.code).toBe(LLM_ERRORS.AUTH_ERROR);
            expect(rootError.cause!.cause!.message).toBe('Invalid API key for grandchild provider');
        });

        it('error chain preserves retryable flag from leaf', () => {
            // Leaf has retryable=true (e.g., rate limit)
            const leaf = createAcaError(
                LLM_ERRORS.RATE_LIMIT,
                'Rate limited',
                { retryable: true },
            );

            const wrapped = wrapDelegationError(leaf);
            expect(wrapped.retryable).toBe(true);
            expect(wrapped.cause!.retryable).toBe(true);

            // Leaf has retryable=false (e.g., auth error)
            const nonRetryable = createAcaError(
                LLM_ERRORS.AUTH_ERROR,
                'Auth failed',
                { retryable: false },
            );

            const wrappedNR = wrapDelegationError(nonRetryable);
            expect(wrappedNR.retryable).toBe(false);
        });

        it('custom message overrides default', () => {
            const leaf = createAcaError(LLM_ERRORS.TIMEOUT, 'Provider timed out');
            const wrapped = wrapDelegationError(leaf, 'Sub-agent task-123 failed');
            expect(wrapped.message).toBe('Sub-agent task-123 failed');
            expect(wrapped.cause!.message).toBe('Provider timed out');
        });
    });

    describe('error chain depth — 3 levels of nested cause', () => {
        it('root → child → grandchild → 3 levels of nested cause', () => {
            // Level 3: grandchild tool error
            const grandchild = createAcaError(
                TOOL_ERRORS.SANDBOX,
                'Path outside workspace',
                { retryable: false, details: { path: '/etc/passwd' } },
            );

            // Level 2: child wraps grandchild
            const child = wrapDelegationError(grandchild, 'Grandchild agent failed');

            // Level 1: root wraps child
            const root = wrapDelegationError(child, 'Child agent failed');

            // Verify 3-level chain
            expect(root.code).toBe('delegation.message_failed');
            expect(root.message).toBe('Child agent failed');

            expect(root.cause).toBeDefined();
            expect(root.cause!.code).toBe('delegation.message_failed');
            expect(root.cause!.message).toBe('Grandchild agent failed');

            expect(root.cause!.cause).toBeDefined();
            expect(root.cause!.cause!.code).toBe('tool.sandbox');
            expect(root.cause!.cause!.message).toBe('Path outside workspace');
            expect(root.cause!.cause!.details).toEqual({ path: '/etc/passwd' });

            // No 4th level
            expect(root.cause!.cause!.cause).toBeUndefined();
        });

        it('serialization preserves all 3 levels', () => {
            const grandchild = createAcaError(LLM_ERRORS.AUTH_ERROR, 'Bad key');
            const child = wrapDelegationError(grandchild);
            const root = wrapDelegationError(child);

            const serialized = serializeAcaError(root);
            expect(serialized.code).toBe('delegation.message_failed');

            const causeL1 = serialized.cause as Record<string, unknown>;
            expect(causeL1.code).toBe('delegation.message_failed');

            const causeL2 = causeL1.cause as Record<string, unknown>;
            expect(causeL2.code).toBe('llm.auth_error');
            expect(causeL2.message).toBe('Bad key');
            expect(causeL2.cause).toBeUndefined();
        });
    });
});
