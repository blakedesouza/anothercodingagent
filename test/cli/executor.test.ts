import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
    CONTRACT_VERSION,
    SCHEMA_VERSION,
    buildDescriptor,
    runDescribe,
    checkVersionCompatibility,
    parseInvokeRequest,
    resolveInvokeWorkspaceRoot,
    buildErrorResponse,
    buildSuccessResponse,
    EXIT_SUCCESS,
    EXIT_RUNTIME,
    EXIT_PROTOCOL,
} from '../../src/cli/executor.js';
import type {
    CapabilityDescriptor,
} from '../../src/cli/executor.js';

const TOOL_NAMES = ['read_file', 'write_file', 'edit_file', 'exec_command'];

describe('Executor Mode', () => {
    // ---- aca describe ----

    describe('runDescribe', () => {
        it('returns valid JSON with contract_version, schema_version, name, description, input_schema, output_schema, constraints', () => {
            const output = runDescribe(TOOL_NAMES);
            const descriptor: CapabilityDescriptor = JSON.parse(output);

            expect(descriptor.contract_version).toBe(CONTRACT_VERSION);
            expect(descriptor.schema_version).toBe(SCHEMA_VERSION);
            expect(descriptor.name).toBe('aca');
            expect(typeof descriptor.description).toBe('string');
            expect(descriptor.description.length).toBeGreaterThan(0);
            expect(descriptor.input_schema).toBeDefined();
            expect(descriptor.input_schema.type).toBe('object');
            expect(descriptor.output_schema).toBeDefined();
            expect(descriptor.output_schema.type).toBe('object');
            expect(descriptor.constraints).toBeDefined();
            expect(descriptor.methods).toBeDefined();
        });

        it('includes constraints with expected fields', () => {
            const output = runDescribe(TOOL_NAMES);
            const descriptor: CapabilityDescriptor = JSON.parse(output);

            expect(descriptor.constraints.max_steps_per_turn).toBeNull();
            expect(descriptor.constraints.supports_streaming).toBe(false);
            expect(descriptor.constraints.ephemeral_sessions).toBe(true);
            expect(descriptor.constraints.supported_tools).toEqual(TOOL_NAMES);
            expect(descriptor.constraints.supported_profiles).toContain('rp-researcher');
            expect(Array.isArray(descriptor.methods.intents)).toBe(true);
            expect(descriptor.methods.methods.some(method => method.id === 'consult')).toBe(true);
            expect(descriptor.methods.methods.some(method => method.id === 'invoke.rp-researcher')).toBe(true);
        });

        it('input_schema requires task field', () => {
            const output = runDescribe(TOOL_NAMES);
            const descriptor: CapabilityDescriptor = JSON.parse(output);
            const schema = descriptor.input_schema as { required?: string[] };

            expect(schema.required).toContain('task');
        });

        it('input_schema documents context model and profile fields', () => {
            const output = runDescribe(TOOL_NAMES);
            const descriptor: CapabilityDescriptor = JSON.parse(output);
            const schema = descriptor.input_schema as {
                properties: { context: { properties: Record<string, unknown> } };
            };

            expect(schema.properties.context.properties).toHaveProperty('model');
            expect(schema.properties.context.properties).toHaveProperty('cwd');
            expect(schema.properties.context.properties).toHaveProperty('profile');
            expect(JSON.stringify(schema.properties.context.properties.profile)).toContain('rp-researcher');
            expect(schema.properties.context.properties).toHaveProperty('temperature');
            expect(schema.properties.context.properties).toHaveProperty('top_p');
            expect(schema.properties.context.properties).toHaveProperty('thinking');
            expect(schema.properties.context.properties).toHaveProperty('response_format');
            expect(schema.properties.context.properties).toHaveProperty('system_messages');
            expect(JSON.stringify(descriptor.input_schema)).toContain('required_output_paths');
            expect(JSON.stringify(descriptor.input_schema)).toContain('fail_on_rejected_tool_calls');
        });

        it('output_schema requires contract_version, schema_version, status', () => {
            const output = runDescribe(TOOL_NAMES);
            const descriptor: CapabilityDescriptor = JSON.parse(output);
            const schema = descriptor.output_schema as { required?: string[] };

            expect(schema.required).toContain('contract_version');
            expect(schema.required).toContain('schema_version');
            expect(schema.required).toContain('status');
        });

        it('is a pure function with no side effects (fast path)', () => {
            const start = Date.now();
            const output = runDescribe(TOOL_NAMES);
            const elapsed = Date.now() - start;

            // Should be near-instantaneous (< 100ms)
            expect(elapsed).toBeLessThan(100);
            expect(output.length).toBeGreaterThan(0);
        });
    });

    describe('buildDescriptor', () => {
        it('returns a CapabilityDescriptor with provided tool names', () => {
            const descriptor = buildDescriptor(['tool_a', 'tool_b']);
            expect(descriptor.constraints.supported_tools).toEqual(['tool_a', 'tool_b']);
        });

        it('handles empty tool list', () => {
            const descriptor = buildDescriptor([]);
            expect(descriptor.constraints.supported_tools).toEqual([]);
        });
    });

    // ---- Version compatibility ----

    describe('checkVersionCompatibility', () => {
        it('returns null when versions match', () => {
            expect(checkVersionCompatibility('1.0.0', '1.0.0')).toBeNull();
        });

        it('returns null when minor/patch differ (same major)', () => {
            expect(checkVersionCompatibility('1.2.3', '1.5.0')).toBeNull();
        });

        it('returns unsupported_version error on contract major mismatch', () => {
            const result = checkVersionCompatibility('2.0.0', '1.0.0');
            expect(result).not.toBeNull();
            expect(result!.status).toBe('error');
            expect(result!.errors![0].code).toBe('unsupported_version');
            expect(result!.errors![0].retryable).toBe(false);
            expect(result!.errors![0].details).toMatchObject({
                capability_id: 'aca',
                requested_contract_version: '2.0.0',
                supported_contract_version: CONTRACT_VERSION,
            });
        });

        it('returns unsupported_version error on schema major mismatch', () => {
            const result = checkVersionCompatibility('1.0.0', '3.0.0');
            expect(result).not.toBeNull();
            expect(result!.status).toBe('error');
            expect(result!.errors![0].code).toBe('unsupported_version');
            expect(result!.errors![0].details).toMatchObject({
                requested_schema_version: '3.0.0',
                supported_schema_version: SCHEMA_VERSION,
            });
        });

        it('returns error for invalid contract_version format', () => {
            const result = checkVersionCompatibility('abc', '1.0.0');
            expect(result).not.toBeNull();
            expect(result!.status).toBe('error');
        });

        it('returns error for empty version string', () => {
            const result = checkVersionCompatibility('', '1.0.0');
            expect(result).not.toBeNull();
            expect(result!.status).toBe('error');
        });
    });

    // ---- parseInvokeRequest ----

    describe('parseInvokeRequest', () => {
        it('parses valid request with all fields', () => {
            const raw = JSON.stringify({
                contract_version: '1.0.0',
                schema_version: '1.0.0',
                task: 'Fix the bug in auth.ts',
                input: { file: 'auth.ts' },
                context: {
                    project: 'myapp',
                    cwd: '/tmp/project-root',
                    profile: 'rp-researcher',
                    temperature: 1,
                    top_p: 0.95,
                    thinking: { type: 'enabled' },
                    response_format: { type: 'json_object' },
                    system_messages: [{ role: 'system', content: 'Return Markdown only.' }],
                },
                constraints: {
                    max_steps: 10,
                    max_tool_calls: 4,
                    max_tool_calls_by_name: { read_file: 1 },
                    max_tool_result_bytes: 12_000,
                    max_input_tokens: 30_000,
                    max_repeated_read_calls: 1,
                    max_total_tokens: 200_000,
                },
                authority: [{ tool: 'exec_command', decision: 'approve' }],
                deadline: 30000,
            });

            const result = parseInvokeRequest(raw);
            expect('request' in result).toBe(true);
            if ('request' in result) {
                const req = result.request;
                expect(req.task).toBe('Fix the bug in auth.ts');
                expect(req.input).toEqual({ file: 'auth.ts' });
                expect(req.context).toEqual({
                    project: 'myapp',
                    cwd: '/tmp/project-root',
                    profile: 'rp-researcher',
                    temperature: 1,
                    top_p: 0.95,
                    thinking: { type: 'enabled' },
                    response_format: { type: 'json_object' },
                    system_messages: [{ role: 'system', content: 'Return Markdown only.' }],
                });
                expect(req.constraints?.max_steps).toBe(10);
                expect(req.constraints?.max_tool_calls).toBe(4);
                expect(req.constraints?.max_tool_calls_by_name).toEqual({ read_file: 1 });
                expect(req.constraints?.max_tool_result_bytes).toBe(12_000);
                expect(req.constraints?.max_input_tokens).toBe(30_000);
                expect(req.constraints?.max_repeated_read_calls).toBe(1);
                expect(req.constraints?.max_total_tokens).toBe(200_000);
                expect(req.authority).toHaveLength(1);
                expect(req.authority![0].tool).toBe('exec_command');
                expect(req.authority![0].decision).toBe('approve');
                expect(req.deadline).toBe(30000);
            }
        });

        it('parses minimal valid request (only required fields)', () => {
            const raw = JSON.stringify({
                contract_version: '1.0.0',
                schema_version: '1.0.0',
                task: 'hello',
            });

            const result = parseInvokeRequest(raw);
            expect('request' in result).toBe(true);
            if ('request' in result) {
                expect(result.request.task).toBe('hello');
                expect(result.request.input).toBeUndefined();
                expect(result.request.constraints).toBeUndefined();
                expect(result.request.authority).toBeUndefined();
                expect(result.request.deadline).toBeUndefined();
            }
        });

        it('returns error for malformed JSON', () => {
            const result = parseInvokeRequest('not valid json {{{');
            expect('error' in result).toBe(true);
            if ('error' in result) {
                expect(result.exitCode).toBe(EXIT_PROTOCOL);
                expect(result.error.status).toBe('error');
                expect(result.error.errors![0].code).toBe('protocol.malformed_request');
                expect(result.error.errors![0].message).toContain('Invalid JSON');
            }
        });

        it('returns error for non-object JSON (array)', () => {
            const result = parseInvokeRequest('[1, 2, 3]');
            expect('error' in result).toBe(true);
            if ('error' in result) {
                expect(result.exitCode).toBe(EXIT_PROTOCOL);
                expect(result.error.errors![0].code).toBe('protocol.malformed_request');
            }
        });

        it('returns error for non-object JSON (string)', () => {
            const result = parseInvokeRequest('"hello"');
            expect('error' in result).toBe(true);
            if ('error' in result) {
                expect(result.exitCode).toBe(EXIT_PROTOCOL);
            }
        });

        it('returns error when contract_version is missing', () => {
            const raw = JSON.stringify({ schema_version: '1.0.0', task: 'hello' });
            const result = parseInvokeRequest(raw);
            expect('error' in result).toBe(true);
            if ('error' in result) {
                expect(result.exitCode).toBe(EXIT_PROTOCOL);
                expect(result.error.errors![0].message).toContain('contract_version');
            }
        });

        it('returns error when schema_version is missing', () => {
            const raw = JSON.stringify({ contract_version: '1.0.0', task: 'hello' });
            const result = parseInvokeRequest(raw);
            expect('error' in result).toBe(true);
            if ('error' in result) {
                expect(result.exitCode).toBe(EXIT_PROTOCOL);
                expect(result.error.errors![0].message).toContain('schema_version');
            }
        });

        it('returns version mismatch error for contract major mismatch', () => {
            const raw = JSON.stringify({
                contract_version: '2.0.0',
                schema_version: '1.0.0',
                task: 'hello',
            });
            const result = parseInvokeRequest(raw);
            expect('error' in result).toBe(true);
            if ('error' in result) {
                expect(result.exitCode).toBe(EXIT_PROTOCOL);
                expect(result.error.errors![0].code).toBe('unsupported_version');
            }
        });

        it('returns error when task is missing', () => {
            const raw = JSON.stringify({
                contract_version: '1.0.0',
                schema_version: '1.0.0',
            });
            const result = parseInvokeRequest(raw);
            expect('error' in result).toBe(true);
            if ('error' in result) {
                expect(result.exitCode).toBe(EXIT_PROTOCOL);
                expect(result.error.errors![0].message).toContain('task');
            }
        });

        it('returns error when task is empty string', () => {
            const raw = JSON.stringify({
                contract_version: '1.0.0',
                schema_version: '1.0.0',
                task: '   ',
            });
            const result = parseInvokeRequest(raw);
            expect('error' in result).toBe(true);
        });

        it('tolerates unknown fields in request (additive evolution)', () => {
            const raw = JSON.stringify({
                contract_version: '1.0.0',
                schema_version: '1.0.0',
                task: 'hello',
                future_field: 'should be ignored',
            });
            const result = parseInvokeRequest(raw);
            expect('request' in result).toBe(true);
            if ('request' in result) {
                expect(result.request.task).toBe('hello');
            }
        });

        it('parses constraints with allowed_tools and denied_tools', () => {
            const raw = JSON.stringify({
                contract_version: '1.0.0',
                schema_version: '1.0.0',
                task: 'hello',
                constraints: {
                    max_steps: 5,
                    max_tool_calls: 2,
                    max_tool_calls_by_name: { read_file: 1, search_text: 1 },
                    max_tool_result_bytes: 12_000,
                    max_input_tokens: 30_000,
                    max_repeated_read_calls: 1,
                    max_total_tokens: 50_000,
                    required_output_paths: ['world/setting.md', '', 42],
                    fail_on_rejected_tool_calls: true,
                    allowed_tools: ['read_file', 'write_file'],
                    denied_tools: ['exec_command'],
                },
            });
            const result = parseInvokeRequest(raw);
            expect('request' in result).toBe(true);
            if ('request' in result) {
                expect(result.request.constraints?.max_steps).toBe(5);
                expect(result.request.constraints?.max_tool_calls).toBe(2);
                expect(result.request.constraints?.max_tool_calls_by_name).toEqual({ read_file: 1, search_text: 1 });
                expect(result.request.constraints?.max_tool_result_bytes).toBe(12_000);
                expect(result.request.constraints?.max_input_tokens).toBe(30_000);
                expect(result.request.constraints?.max_repeated_read_calls).toBe(1);
                expect(result.request.constraints?.max_total_tokens).toBe(50_000);
                expect(result.request.constraints?.required_output_paths).toEqual(['world/setting.md']);
                expect(result.request.constraints?.fail_on_rejected_tool_calls).toBe(true);
                expect(result.request.constraints?.allowed_tools).toEqual(['read_file', 'write_file']);
                expect(result.request.constraints?.denied_tools).toEqual(['exec_command']);
            }
        });

        it('filters non-string values from authority array', () => {
            const raw = JSON.stringify({
                contract_version: '1.0.0',
                schema_version: '1.0.0',
                task: 'hello',
                authority: [
                    { tool: 'exec_command', decision: 'approve' },
                    { tool: 123, decision: 'approve' }, // invalid: tool not a string
                    { tool: 'write_file', decision: 'invalid' }, // invalid: bad decision
                    { tool: 'read_file', decision: 'deny' },
                ],
            });
            const result = parseInvokeRequest(raw);
            expect('request' in result).toBe(true);
            if ('request' in result) {
                expect(result.request.authority).toHaveLength(2);
                expect(result.request.authority![0].tool).toBe('exec_command');
                expect(result.request.authority![1].tool).toBe('read_file');
            }
        });
        it('rejects arrays for input field (typeof [] === "object")', () => {
            const raw = JSON.stringify({
                contract_version: '1.0.0',
                schema_version: '1.0.0',
                task: 'hello',
                input: [1, 2, 3],
            });
            const result = parseInvokeRequest(raw);
            expect('request' in result).toBe(true);
            if ('request' in result) {
                // Array should be dropped (treated as undefined), not passed through
                expect(result.request.input).toBeUndefined();
            }
        });

        it('rejects arrays for context field', () => {
            const raw = JSON.stringify({
                contract_version: '1.0.0',
                schema_version: '1.0.0',
                task: 'hello',
                context: ['a', 'b'],
            });
            const result = parseInvokeRequest(raw);
            expect('request' in result).toBe(true);
            if ('request' in result) {
                expect(result.request.context).toBeUndefined();
            }
        });

        it('preserves context.model for model override', () => {
            const raw = JSON.stringify({
                contract_version: '1.0.0',
                schema_version: '1.0.0',
                task: 'review this code',
                context: { model: 'minimax/minimax-m2.7' },
            });
            const result = parseInvokeRequest(raw);
            expect('request' in result).toBe(true);
            if ('request' in result) {
                expect(result.request.context).toBeDefined();
                expect(result.request.context!.model).toBe('minimax/minimax-m2.7');
            }
        });

        it('preserves context.cwd for workspace override', () => {
            const raw = JSON.stringify({
                contract_version: '1.0.0',
                schema_version: '1.0.0',
                task: 'review this code',
                context: { cwd: '/tmp/rp-project' },
            });
            const result = parseInvokeRequest(raw);
            expect('request' in result).toBe(true);
            if ('request' in result) {
                expect(result.request.context).toBeDefined();
                expect(result.request.context!.cwd).toBe('/tmp/rp-project');
            }
        });
    });

    describe('resolveInvokeWorkspaceRoot', () => {
        it('uses launch cwd when context.cwd is absent', () => {
            expect(resolveInvokeWorkspaceRoot('/tmp/base', undefined)).toEqual({
                workspaceRoot: '/tmp/base',
            });
        });

        it('resolves a relative context.cwd against launch cwd', () => {
            const root = mkdtempSync(join(tmpdir(), 'aca-invoke-root-'));
            try {
                const nested = join(root, 'rp-project');
                writeFileSync(join(root, 'marker.txt'), 'x');
                mkdirSync(nested);
                expect(resolveInvokeWorkspaceRoot(root, { cwd: 'rp-project' })).toEqual({
                    workspaceRoot: nested,
                });
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        it('returns protocol error for non-directory context.cwd', () => {
            const root = mkdtempSync(join(tmpdir(), 'aca-invoke-root-'));
            try {
                const filePath = join(root, 'not-a-dir.txt');
                writeFileSync(filePath, 'x');
                const result = resolveInvokeWorkspaceRoot(root, { cwd: filePath });
                expect('error' in result).toBe(true);
                if ('error' in result) {
                    expect(result.exitCode).toBe(EXIT_PROTOCOL);
                    expect(result.error.errors?.[0].code).toBe('protocol.invalid_context_cwd');
                }
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });

    // ---- Response builders ----

    describe('buildErrorResponse', () => {
        it('creates a well-formed error response', () => {
            const resp = buildErrorResponse('system.internal', 'Something broke', true);
            expect(resp.contract_version).toBe(CONTRACT_VERSION);
            expect(resp.schema_version).toBe(SCHEMA_VERSION);
            expect(resp.status).toBe('error');
            expect(resp.errors).toHaveLength(1);
            expect(resp.errors![0].code).toBe('system.internal');
            expect(resp.errors![0].message).toBe('Something broke');
            expect(resp.errors![0].retryable).toBe(true);
        });

        it('defaults retryable to false', () => {
            const resp = buildErrorResponse('protocol.malformed_request', 'bad');
            expect(resp.errors![0].retryable).toBe(false);
        });

        it('can include safety stats on guardrail errors', () => {
            const resp = buildErrorResponse('turn.max_tool_calls', 'capped', true, {
                outcome: 'max_tool_calls',
                steps: 2,
                accepted_tool_calls: 1,
                rejected_tool_calls: 1,
                accepted_tool_calls_by_name: { read_file: 1 },
                tool_result_bytes: 100,
                guardrails: ['max_tool_calls'],
            }, {
                input_tokens: 100,
                output_tokens: 20,
                cost_usd: 0,
            });
            expect(resp.status).toBe('error');
            expect(resp.safety?.outcome).toBe('max_tool_calls');
            expect(resp.safety?.accepted_tool_calls_by_name).toEqual({ read_file: 1 });
            expect(resp.usage?.input_tokens).toBe(100);
        });
    });

    describe('buildSuccessResponse', () => {
        it('creates a well-formed success response with usage stats', () => {
            const resp = buildSuccessResponse('Task completed', {
                input_tokens: 100,
                output_tokens: 50,
                cost_usd: 0.01,
            }, {
                outcome: 'assistant_final',
                steps: 2,
                estimated_input_tokens_max: 1234,
                accepted_tool_calls: 1,
                rejected_tool_calls: 0,
                accepted_tool_calls_by_name: { read_file: 1 },
                tool_result_bytes: 100,
                guardrails: [],
            });
            expect(resp.contract_version).toBe(CONTRACT_VERSION);
            expect(resp.schema_version).toBe(SCHEMA_VERSION);
            expect(resp.status).toBe('success');
            expect(resp.result).toBe('Task completed');
            expect(resp.usage?.input_tokens).toBe(100);
            expect(resp.usage?.output_tokens).toBe(50);
            expect(resp.usage?.cost_usd).toBe(0.01);
            expect(resp.safety?.accepted_tool_calls_by_name).toEqual({ read_file: 1 });
            expect(resp.errors).toBeUndefined();
        });
    });

    // ---- Exit code constants ----

    describe('exit codes', () => {
        it('has correct values', () => {
            expect(EXIT_SUCCESS).toBe(0);
            expect(EXIT_RUNTIME).toBe(1);
            expect(EXIT_PROTOCOL).toBe(5);
        });
    });

    // ---- No stderr in executor mode ----

    describe('no stderr contract', () => {
        it('runDescribe produces no side effects (pure function)', () => {
            // runDescribe is a pure function that returns a string.
            // No stderr writes, no process.exit, no I/O.
            const output = runDescribe(['read_file']);
            expect(typeof output).toBe('string');
            const parsed = JSON.parse(output);
            expect(parsed.name).toBe('aca');
        });
    });

    // ---- Ephemeral session contract ----

    describe('ephemeral session', () => {
        it('descriptor declares ephemeral_sessions: true', () => {
            const descriptor = buildDescriptor(TOOL_NAMES);
            expect(descriptor.constraints.ephemeral_sessions).toBe(true);
        });
    });

    // ---- Response envelope includes usage ----

    describe('response envelope', () => {
        it('success response includes token usage and cost', () => {
            const resp = buildSuccessResponse('done', {
                input_tokens: 200,
                output_tokens: 100,
                cost_usd: 0.005,
            });
            expect(resp.usage).toBeDefined();
            expect(resp.usage!.input_tokens).toBe(200);
            expect(resp.usage!.output_tokens).toBe(100);
            expect(resp.usage!.cost_usd).toBe(0.005);
        });
    });
});
