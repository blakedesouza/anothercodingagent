import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
    createMcpServer,
    runAcaInvoke,
    parseInvokeOutput,
    buildSpawnArgs,
    MAX_CONCURRENT_AGENTS,
    type AcaInvokeResult,
} from '../../src/mcp/server.js';
import { CONTRACT_VERSION, SCHEMA_VERSION } from '../../src/cli/executor.js';
import { DEFAULT_API_TIMEOUT_MS } from '../../src/config/schema.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuccessResult(text: string, inputTokens = 100, outputTokens = 50): AcaInvokeResult {
    return {
        stdout: JSON.stringify({
            contract_version: CONTRACT_VERSION,
            schema_version: SCHEMA_VERSION,
            status: 'success',
            result: text,
            usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cost_usd: 0,
            },
        }),
        stderr: '',
        exitCode: 0,
    };
}

function makeSuccessResultWithSafety(text: string): AcaInvokeResult {
    return {
        stdout: JSON.stringify({
            contract_version: CONTRACT_VERSION,
            schema_version: SCHEMA_VERSION,
            status: 'success',
            result: text,
            usage: {
                input_tokens: 100,
                output_tokens: 50,
                cost_usd: 0,
            },
            safety: {
                outcome: 'assistant_final',
                steps: 2,
                estimated_input_tokens_max: 1000,
                accepted_tool_calls: 1,
                rejected_tool_calls: 1,
                accepted_tool_calls_by_name: { read_file: 1 },
                tool_result_bytes: 500,
                guardrails: ['max_tool_result_bytes'],
            },
        }),
        stderr: '',
        exitCode: 0,
    };
}

function makeErrorResult(code: string, message: string): AcaInvokeResult {
    return {
        stdout: JSON.stringify({
            contract_version: CONTRACT_VERSION,
            schema_version: SCHEMA_VERSION,
            status: 'error',
            errors: [{ code, message, retryable: false }],
        }),
        stderr: '',
        exitCode: 1,
    };
}

/**
 * Connect an MCP client to the server via in-memory transport.
 * Returns the client ready for tool listing/calling.
 */
async function connectClient(
    spawnFn: (requestJson: string, deadlineMs: number) => Promise<AcaInvokeResult>,
) {
    const server = createMcpServer(spawnFn);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'test-client', version: '1.0.0' });

    // Connect both sides
    await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
    ]);

    return client;
}

// ---------------------------------------------------------------------------
// Unit tests: parseInvokeOutput
// ---------------------------------------------------------------------------

describe('parseInvokeOutput', () => {
    it('parses valid success response', () => {
        const result = parseInvokeOutput(
            JSON.stringify({
                contract_version: CONTRACT_VERSION,
                schema_version: SCHEMA_VERSION,
                status: 'success',
                result: 'hello',
                usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0 },
            }),
            '',
            0,
        );
        expect(result.status).toBe('success');
        expect(result.result).toBe('hello');
        expect(result.usage?.input_tokens).toBe(10);
    });

    it('parses valid error response', () => {
        const result = parseInvokeOutput(
            JSON.stringify({
                contract_version: CONTRACT_VERSION,
                schema_version: SCHEMA_VERSION,
                status: 'error',
                errors: [{ code: 'llm.auth_error', message: 'bad key', retryable: false }],
            }),
            '',
            1,
        );
        expect(result.status).toBe('error');
        expect(result.errors?.[0].code).toBe('llm.auth_error');
    });

    it('returns error for empty stdout', () => {
        const result = parseInvokeOutput('', 'something went wrong', 1);
        expect(result.status).toBe('error');
        expect(result.errors?.[0].code).toBe('mcp.empty_response');
        expect(result.errors?.[0].message).toContain('something went wrong');
    });

    it('returns error for invalid JSON', () => {
        const result = parseInvokeOutput('not json', '', 1);
        expect(result.status).toBe('error');
        expect(result.errors?.[0].code).toBe('mcp.parse_error');
    });

    it('returns error for malformed response object', () => {
        const result = parseInvokeOutput(JSON.stringify({ foo: 'bar' }), '', 0);
        expect(result.status).toBe('error');
        expect(result.errors?.[0].code).toBe('mcp.malformed_response');
    });
});

// ---------------------------------------------------------------------------
// Unit tests: runAcaInvoke
// ---------------------------------------------------------------------------

describe('runAcaInvoke', () => {
    it('passes task and deadline to spawn function', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue(makeSuccessResult('done'));

        await runAcaInvoke('read file', { deadlineMs: 10000 }, spawnFn);

        expect(spawnFn).toHaveBeenCalledOnce();
        const [json, deadline] = spawnFn.mock.calls[0];
        const parsed = JSON.parse(json);
        expect(parsed.task).toBe('read file');
        expect(parsed.contract_version).toBe(CONTRACT_VERSION);
        expect(parsed.constraints.max_steps).toBe(50);
        expect(parsed.constraints.max_total_tokens).toBe(200000);
        expect(parsed.deadline).toBe(10000);
        expect(deadline).toBe(10000);
    });

    it('includes allowed_tools in constraints when provided', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue(makeSuccessResult('done'));

        await runAcaInvoke('task', { allowedTools: ['read_file', 'search_text'] }, spawnFn);

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.constraints.allowed_tools).toEqual(['read_file', 'search_text']);
    });

    it('includes model context when provided', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue(makeSuccessResult('done'));

        await runAcaInvoke('task', { model: 'minimax/minimax-m2.7' }, spawnFn);

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.context.model).toBe('minimax/minimax-m2.7');
    });

    it('includes profile context when provided', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue(makeSuccessResult('done'));

        await runAcaInvoke('task', { profile: 'rp-researcher' }, spawnFn);

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.context.profile).toBe('rp-researcher');
    });

    it('includes cwd context when provided', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue(makeSuccessResult('done'));

        await runAcaInvoke('task', { cwd: '/tmp/rpproject' }, spawnFn);

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.context.cwd).toBe('/tmp/rpproject');
    });

    it('includes response_format context when provided', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue(makeSuccessResult('done'));
        const responseFormat = {
            type: 'json_object' as const,
        };

        await runAcaInvoke('task', { responseFormat }, spawnFn);

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.context.response_format).toEqual(responseFormat);
    });

    it('includes system_messages context when provided', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue(makeSuccessResult('done'));
        const systemMessages = [
            { role: 'system' as const, content: 'Return Markdown only.' },
        ];

        await runAcaInvoke('task', { systemMessages }, spawnFn);

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.context.system_messages).toEqual(systemMessages);
    });

    it('includes explicit max_steps and max_total_tokens in constraints', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue(makeSuccessResult('done'));

        await runAcaInvoke('task', {
            maxSteps: 7,
            maxToolCalls: 3,
            maxToolCallsByName: { read_file: 1 },
            maxToolResultBytes: 12000,
            maxInputTokens: 30000,
            maxRepeatedReadCalls: 1,
            maxTotalTokens: 50000,
            requiredOutputPaths: ['world/setting.md'],
            failOnRejectedToolCalls: true,
        }, spawnFn);

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.constraints.max_steps).toBe(7);
        expect(parsed.constraints.max_tool_calls).toBe(3);
        expect(parsed.constraints.max_tool_calls_by_name).toEqual({ read_file: 1 });
        expect(parsed.constraints.max_tool_result_bytes).toBe(12000);
        expect(parsed.constraints.max_input_tokens).toBe(30000);
        expect(parsed.constraints.max_repeated_read_calls).toBe(1);
        expect(parsed.constraints.max_total_tokens).toBe(50000);
        expect(parsed.constraints.required_output_paths).toEqual(['world/setting.md']);
        expect(parsed.constraints.fail_on_rejected_tool_calls).toBe(true);
    });

    it('uses default deadline when not specified', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue(makeSuccessResult('done'));

        await runAcaInvoke('task', {}, spawnFn);

        const [, deadline] = spawnFn.mock.calls[0];
        expect(deadline).toBe(DEFAULT_API_TIMEOUT_MS); // pinned to the project-wide LLM timeout
    });

    it('falls back to the default deadline for non-positive values', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue(makeSuccessResult('done'));

        await runAcaInvoke('task', { deadlineMs: 0 }, spawnFn);

        const [json, deadline] = spawnFn.mock.calls[0];
        const parsed = JSON.parse(json);
        expect(parsed.deadline).toBe(DEFAULT_API_TIMEOUT_MS);
        expect(deadline).toBe(DEFAULT_API_TIMEOUT_MS);
    });

    it('keeps default budget constraints when no allowed_tools is provided', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue(makeSuccessResult('done'));

        await runAcaInvoke('task', {}, spawnFn);

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.constraints).toEqual({
            max_steps: 50,
            max_total_tokens: 200000,
        });
    });
});

// ---------------------------------------------------------------------------
// Integration tests: MCP server via in-memory transport
// ---------------------------------------------------------------------------

describe('MCP Server (in-memory transport)', () => {
    let spawnFn: ReturnType<typeof vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>>;

    beforeEach(() => {
        spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>();
    });

    it('tools/list includes aca_run with correct schema', async () => {
        spawnFn.mockResolvedValue(makeSuccessResult('unused'));
        const client = await connectClient(spawnFn);

        const result = await client.listTools();
        const acaRun = result.tools.find(t => t.name === 'aca_run');

        expect(acaRun).toBeDefined();
        expect(acaRun!.description).toContain('ACA');
        expect(acaRun!.inputSchema.properties).toHaveProperty('task');
        expect(acaRun!.inputSchema.properties).toHaveProperty('allowed_tools');
        expect(acaRun!.inputSchema.properties).toHaveProperty('denied_tools');
        expect(acaRun!.inputSchema.properties).toHaveProperty('max_steps');
        expect(acaRun!.inputSchema.properties).toHaveProperty('max_tool_calls');
        expect(acaRun!.inputSchema.properties).toHaveProperty('max_tool_calls_by_name');
        expect(acaRun!.inputSchema.properties).toHaveProperty('max_tool_result_bytes');
        expect(acaRun!.inputSchema.properties).toHaveProperty('max_input_tokens');
        expect(acaRun!.inputSchema.properties).toHaveProperty('max_repeated_read_calls');
        expect(acaRun!.inputSchema.properties).toHaveProperty('max_total_tokens');
        expect(acaRun!.inputSchema.properties).toHaveProperty('profile');
        expect(acaRun!.inputSchema.properties).toHaveProperty('model');
        expect(acaRun!.inputSchema.properties).toHaveProperty('temperature');
        expect(acaRun!.inputSchema.properties).toHaveProperty('top_p');
        expect(acaRun!.inputSchema.properties).toHaveProperty('thinking');
        expect(acaRun!.inputSchema.properties).toHaveProperty('timeout_ms');
        expect(acaRun!.inputSchema.properties.timeout_ms.description).toContain(
            String(DEFAULT_API_TIMEOUT_MS),
        );
        expect(acaRun!.inputSchema.required).toContain('task');

        await client.close();
    });

    it('aca_run with simple task returns result text', async () => {
        spawnFn.mockResolvedValue(makeSuccessResult('The project name is anothercodingagent'));
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'read package.json and tell me the project name' },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('anothercodingagent');

        // Verify spawn was called with correct request
        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.task).toBe('read package.json and tell me the project name');

        await client.close();
    });

    it('aca_run propagates timeout_ms as deadline', async () => {
        spawnFn.mockResolvedValue(makeSuccessResult('done'));
        const client = await connectClient(spawnFn);

        await client.callTool({
            name: 'aca_run',
            arguments: { task: 'some task', timeout_ms: 60000 },
        });

        const [json, deadline] = spawnFn.mock.calls[0];
        const parsed = JSON.parse(json);
        expect(parsed.deadline).toBe(60000);
        expect(deadline).toBe(60000);

        await client.close();
    });

    it('aca_run rejects non-positive timeout_ms before spawning', async () => {
        spawnFn.mockResolvedValue(makeSuccessResult('done'));
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'some task', timeout_ms: 0 },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('Input validation error');
        expect(text).toContain('timeout_ms');
        expect(spawnFn).not.toHaveBeenCalled();

        await client.close();
    });

    it('aca_run with bad task returns error', async () => {
        spawnFn.mockResolvedValue(makeErrorResult(
            'protocol.malformed_request',
            'Request must include a non-empty "task" string',
        ));
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'will-fail' },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('protocol.malformed_request');

        await client.close();
    });

    it('aca_run captures token usage from InvokeResponse', async () => {
        spawnFn.mockResolvedValue(makeSuccessResult('result text', 500, 200));
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'do something' },
        });

        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('500 input tokens');
        expect(text).toContain('200 output tokens');

        await client.close();
    });

    it('aca_run includes safety stats from InvokeResponse', async () => {
        spawnFn.mockResolvedValue(makeSuccessResultWithSafety('result text'));
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'do something' },
        });

        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('Safety: 2 steps');
        expect(text).toContain('1 accepted tool calls');
        expect(text).toContain('1 rejected tool calls');
        expect(text).toContain('max_tool_result_bytes');

        await client.close();
    });

    it('aca_run with allowed_tools and denied_tools passes constraints', async () => {
        spawnFn.mockResolvedValue(makeSuccessResult('done'));
        const client = await connectClient(spawnFn);

        await client.callTool({
            name: 'aca_run',
            arguments: {
                task: 'search the code',
                allowed_tools: ['read_file', 'search_text'],
                denied_tools: ['exec_command'],
            },
        });

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.constraints.allowed_tools).toEqual(['read_file', 'search_text']);
        expect(parsed.constraints.denied_tools).toEqual(['exec_command']);

        await client.close();
    });

    it('aca_run passes model, profile, and generation context', async () => {
        spawnFn.mockResolvedValue(makeSuccessResult('done'));
        const client = await connectClient(spawnFn);

        await client.callTool({
            name: 'aca_run',
            arguments: {
                task: 'research lore',
                model: 'zai-org/glm-5',
                profile: 'rp-researcher',
                temperature: 1,
                top_p: 0.95,
                thinking: 'enabled',
            },
        });

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.context).toEqual({
            model: 'zai-org/glm-5',
            profile: 'rp-researcher',
            temperature: 1,
            top_p: 0.95,
            thinking: 'enabled',
        });

        await client.close();
    });

    it('aca_run propagates explicit budget caps', async () => {
        spawnFn.mockResolvedValue(makeSuccessResult('done'));
        const client = await connectClient(spawnFn);

        await client.callTool({
            name: 'aca_run',
            arguments: {
                task: 'bounded task',
                max_steps: 7,
                max_tool_calls: 3,
                max_tool_calls_by_name: { read_file: 1 },
                max_tool_result_bytes: 12000,
                max_input_tokens: 30000,
                max_repeated_read_calls: 1,
                max_total_tokens: 50000,
                required_output_paths: ['world/setting.md'],
                fail_on_rejected_tool_calls: true,
            },
        });

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.constraints.max_steps).toBe(7);
        expect(parsed.constraints.max_tool_calls).toBe(3);
        expect(parsed.constraints.max_tool_calls_by_name).toEqual({ read_file: 1 });
        expect(parsed.constraints.max_tool_result_bytes).toBe(12000);
        expect(parsed.constraints.max_input_tokens).toBe(30000);
        expect(parsed.constraints.max_repeated_read_calls).toBe(1);
        expect(parsed.constraints.max_total_tokens).toBe(50000);
        expect(parsed.constraints.required_output_paths).toEqual(['world/setting.md']);
        expect(parsed.constraints.fail_on_rejected_tool_calls).toBe(true);

        await client.close();
    });

    it('aca_run handles spawn failure gracefully', async () => {
        spawnFn.mockRejectedValue(new Error('ENOENT: aca binary not found'));
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'anything' },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('Failed to invoke ACA');
        expect(text).toContain('ENOENT');

        await client.close();
    });

    it('aca_run handles empty stdout with stderr message', async () => {
        spawnFn.mockResolvedValue({
            stdout: '',
            stderr: 'Error: No NanoGPT API key found.',
            exitCode: 4,
        });
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'anything' },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('NanoGPT API key');

        await client.close();
    });
});

// ---------------------------------------------------------------------------
// M9.2: Authority mapping — allowed_tools restricts ACA agent
// ---------------------------------------------------------------------------

describe('Authority mapping (M9.2)', () => {
    let spawnFn: ReturnType<typeof vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>>;

    beforeEach(() => {
        spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>();
    });

    it('allowed_tools: ["read_file", "search_text"] → constraints.allowed_tools propagated', async () => {
        spawnFn.mockResolvedValue(makeSuccessResult('found the code'));
        const client = await connectClient(spawnFn);

        await client.callTool({
            name: 'aca_run',
            arguments: {
                task: 'search for all TODO comments',
                allowed_tools: ['read_file', 'search_text'],
            },
        });

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.constraints).toBeDefined();
        expect(parsed.constraints.allowed_tools).toEqual(['read_file', 'search_text']);
        expect(parsed.constraints.max_steps).toBe(50);
        expect(parsed.constraints.max_total_tokens).toBe(200000);
        expect(parsed.constraints.denied_tools).toBeUndefined();

        await client.close();
    });

    it('omitting allowed_tools → default budget constraints only', async () => {
        spawnFn.mockResolvedValue(makeSuccessResult('done'));
        const client = await connectClient(spawnFn);

        await client.callTool({
            name: 'aca_run',
            arguments: { task: 'full access task' },
        });

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        expect(parsed.constraints).toEqual({
            max_steps: 50,
            max_total_tokens: 200000,
        });

        await client.close();
    });

    it('empty allowed_tools array → constraints with empty array (deny all tools)', async () => {
        spawnFn.mockResolvedValue(makeSuccessResult('done'));
        const client = await connectClient(spawnFn);

        await client.callTool({
            name: 'aca_run',
            arguments: {
                task: 'task with empty tools',
                allowed_tools: [],
            },
        });

        const parsed = JSON.parse(spawnFn.mock.calls[0][0]);
        // Empty array means "no tools allowed" — stricter than omitting
        expect(parsed.constraints).toBeDefined();
        expect(parsed.constraints.allowed_tools).toEqual([]);
        expect(parsed.constraints.max_steps).toBe(50);
        expect(parsed.constraints.max_total_tokens).toBe(200000);

        await client.close();
    });
});

// ---------------------------------------------------------------------------
// M9.2: Error propagation — ACA errors flow back as structured MCP errors
// ---------------------------------------------------------------------------

describe('Error propagation (M9.2)', () => {
    let spawnFn: ReturnType<typeof vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>>;

    beforeEach(() => {
        spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>();
    });

    it('ACA auth error → Claude sees structured error with code', async () => {
        spawnFn.mockResolvedValue(makeErrorResult('llm.auth_error', 'Invalid API key'));
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'do something' },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('llm.auth_error');
        expect(text).toContain('Invalid API key');

        await client.close();
    });

    it('ACA sandbox violation → error contains violation code', async () => {
        spawnFn.mockResolvedValue(makeErrorResult(
            'tool.sandbox',
            'Path /etc/passwd is outside workspace zone',
        ));
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'read /etc/passwd' },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('tool.sandbox');
        expect(text).toContain('outside workspace zone');

        await client.close();
    });

    it('ACA timeout (process killed) → error with empty stdout uses stderr', async () => {
        spawnFn.mockResolvedValue({
            stdout: '',
            stderr: 'Process timed out after 60000ms',
            exitCode: 1,
        });
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'slow task', timeout_ms: 60000 },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('timed out');

        await client.close();
    });

    it('ACA returns multiple errors → all error codes visible with retryable flag', async () => {
        spawnFn.mockResolvedValue({
            stdout: JSON.stringify({
                contract_version: CONTRACT_VERSION,
                schema_version: SCHEMA_VERSION,
                status: 'error',
                errors: [
                    { code: 'tool.timeout', message: 'Tool exec_command timed out', retryable: true },
                    { code: 'llm.confused', message: 'Agent gave up after 3 confusion errors', retryable: false },
                ],
            }),
            stderr: '',
            exitCode: 1,
        });
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'complex task' },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('tool.timeout');
        expect(text).toContain('llm.confused');
        // retryable flag preserved in error text
        expect(text).toContain('(retryable)');
        // Non-retryable errors should NOT have the retryable marker
        expect(text).not.toContain('llm.confused: Agent gave up after 3 confusion errors (retryable)');

        await client.close();
    });

    it('ACA subprocess spawn failure → graceful error, not crash', async () => {
        spawnFn.mockRejectedValue(new Error('spawn EACCES'));
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'anything' },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('Failed to invoke ACA');
        expect(text).toContain('EACCES');

        await client.close();
    });

    it('ACA success with retryable error field → not flagged as error', async () => {
        // Some responses may have status: success even with usage notes
        spawnFn.mockResolvedValue(makeSuccessResult('Task completed with warnings'));
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'task with warnings' },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('Task completed with warnings');

        await client.close();
    });
});

// ---------------------------------------------------------------------------
// M9.3: Parallel invocation — multiple aca_run calls complete independently
// ---------------------------------------------------------------------------

describe('Parallel invocation (M9.3)', () => {
    let spawnFn: ReturnType<typeof vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>>;

    beforeEach(() => {
        spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>();
    });

    it('two concurrent aca_run calls each spawn their own subprocess', async () => {
        // Each call gets a unique response based on input
        spawnFn.mockImplementation(async (json: string) => {
            const parsed = JSON.parse(json);
            if (parsed.task.includes('task-A')) {
                return makeSuccessResult('Result from agent A', 100, 50);
            }
            return makeSuccessResult('Result from agent B', 200, 80);
        });

        const client = await connectClient(spawnFn);

        // Fire both calls concurrently (simulates Claude making parallel tool calls)
        const [resultA, resultB] = await Promise.all([
            client.callTool({ name: 'aca_run', arguments: { task: 'task-A: read src/' } }),
            client.callTool({ name: 'aca_run', arguments: { task: 'task-B: read test/' } }),
        ]);

        // Both calls succeeded independently
        expect(resultA.isError).toBeFalsy();
        expect(resultB.isError).toBeFalsy();

        const textA = (resultA.content as Array<{ type: string; text: string }>)[0].text;
        const textB = (resultB.content as Array<{ type: string; text: string }>)[0].text;

        // No cross-contamination — each got its own result
        expect(textA).toContain('Result from agent A');
        expect(textB).toContain('Result from agent B');
        expect(textA).not.toContain('agent B');
        expect(textB).not.toContain('agent A');

        // Spawn was called twice — one per invocation
        expect(spawnFn).toHaveBeenCalledTimes(2);

        await client.close();
    });

    it('parallel calls report independent token usage', async () => {
        spawnFn.mockImplementation(async (json: string) => {
            const parsed = JSON.parse(json);
            if (parsed.task.includes('task-A')) {
                return makeSuccessResult('A done', 500, 200);
            }
            return makeSuccessResult('B done', 1000, 400);
        });

        const client = await connectClient(spawnFn);

        const [resultA, resultB] = await Promise.all([
            client.callTool({ name: 'aca_run', arguments: { task: 'task-A' } }),
            client.callTool({ name: 'aca_run', arguments: { task: 'task-B' } }),
        ]);

        const textA = (resultA.content as Array<{ type: string; text: string }>)[0].text;
        const textB = (resultB.content as Array<{ type: string; text: string }>)[0].text;

        // Each reports its own usage — Claude can sum them for total delegation cost
        expect(textA).toContain('500 input tokens');
        expect(textA).toContain('200 output tokens');
        expect(textB).toContain('1000 input tokens');
        expect(textB).toContain('400 output tokens');

        await client.close();
    });

    it('one parallel call failing does not affect the other', async () => {
        spawnFn.mockImplementation(async (json: string) => {
            const parsed = JSON.parse(json);
            if (parsed.task.includes('will-fail')) {
                return makeErrorResult('llm.auth_error', 'Invalid API key');
            }
            return makeSuccessResult('Success from healthy agent', 100, 50);
        });

        const client = await connectClient(spawnFn);

        const [resultFail, resultOk] = await Promise.all([
            client.callTool({ name: 'aca_run', arguments: { task: 'will-fail task' } }),
            client.callTool({ name: 'aca_run', arguments: { task: 'healthy task' } }),
        ]);

        // Failed call returns error
        expect(resultFail.isError).toBe(true);
        const failText = (resultFail.content as Array<{ type: string; text: string }>)[0].text;
        expect(failText).toContain('llm.auth_error');

        // Successful call unaffected
        expect(resultOk.isError).toBeFalsy();
        const okText = (resultOk.content as Array<{ type: string; text: string }>)[0].text;
        expect(okText).toContain('Success from healthy agent');

        await client.close();
    });

    it('parallel calls with different allowed_tools get independent constraints', async () => {
        spawnFn.mockResolvedValue(makeSuccessResult('done'));
        const client = await connectClient(spawnFn);

        await Promise.all([
            client.callTool({
                name: 'aca_run',
                arguments: { task: 'read-only task', allowed_tools: ['read_file'] },
            }),
            client.callTool({
                name: 'aca_run',
                arguments: { task: 'full task', allowed_tools: ['read_file', 'write_file', 'exec_command'] },
            }),
        ]);

        expect(spawnFn).toHaveBeenCalledTimes(2);

        // Extract constraints from each call (order may vary due to concurrency)
        const calls = spawnFn.mock.calls.map(([json]) => JSON.parse(json));
        const readOnly = calls.find((c: Record<string, unknown>) => c.task === 'read-only task');
        const full = calls.find((c: Record<string, unknown>) => c.task === 'full task');

        expect(readOnly!.constraints.allowed_tools).toEqual(['read_file']);
        expect(full!.constraints.allowed_tools).toEqual(['read_file', 'write_file', 'exec_command']);

        await client.close();
    });

    it('parallel calls with different timeouts get independent deadlines', async () => {
        spawnFn.mockResolvedValue(makeSuccessResult('done'));
        const client = await connectClient(spawnFn);

        await Promise.all([
            client.callTool({
                name: 'aca_run',
                arguments: { task: 'quick', timeout_ms: 30000 },
            }),
            client.callTool({
                name: 'aca_run',
                arguments: { task: 'slow', timeout_ms: 300000 },
            }),
        ]);

        const calls = spawnFn.mock.calls;
        const quick = calls.find(([json]) => JSON.parse(json).task === 'quick');
        const slow = calls.find(([json]) => JSON.parse(json).task === 'slow');

        expect(quick![1]).toBe(30000);
        expect(slow![1]).toBe(300000);

        await client.close();
    });

    it('rejects calls beyond MAX_CONCURRENT_AGENTS limit', async () => {
        // Create a spawn function that blocks until we release it
        const barriers: Array<{ resolve: () => void }> = [];
        const blockingSpawnFn = vi.fn(async () => {
            await new Promise<void>(resolve => { barriers.push({ resolve }); });
            return makeSuccessResult('done');
        });

        const client = await connectClient(blockingSpawnFn);

        // Fire MAX_CONCURRENT_AGENTS calls — they'll all block on the barrier
        const maxCalls = Array.from({ length: MAX_CONCURRENT_AGENTS }, (_, i) =>
            client.callTool({ name: 'aca_run', arguments: { task: `task-${i}` } }),
        );

        // Wait a tick so all calls enter the handler
        await new Promise(resolve => setTimeout(resolve, 50));

        // Fire one more — should be rejected with concurrency error
        const overflowResult = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'overflow-task' },
        });

        expect(overflowResult.isError).toBe(true);
        const text = (overflowResult.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('mcp.concurrency_limit');
        expect(text).toContain(`max ${MAX_CONCURRENT_AGENTS}`);

        // The overflow call should NOT have triggered a spawn
        expect(blockingSpawnFn).toHaveBeenCalledTimes(MAX_CONCURRENT_AGENTS);

        // Release all blocked calls so they complete
        for (const b of barriers) b.resolve();
        await Promise.all(maxCalls);

        // After completing, a new call should succeed
        blockingSpawnFn.mockResolvedValue(makeSuccessResult('after-release'));
        const postResult = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'post-release-task' },
        });
        expect(postResult.isError).toBeFalsy();

        await client.close();
    });
});

// ---------------------------------------------------------------------------
// M10.1b: Spawn path hardening
// ---------------------------------------------------------------------------

describe('buildSpawnArgs (M10.1b)', () => {
    it('returns only the binary path and "invoke" — no extra flags', () => {
        const originalExecArgv = process.execArgv;
        Object.defineProperty(process, 'execArgv', {
            value: [],
            configurable: true,
        });
        try {
            const args = buildSpawnArgs('/path/to/dist/index.js');
            expect(args).toEqual(['/path/to/dist/index.js', 'invoke']);
        } finally {
            Object.defineProperty(process, 'execArgv', {
                value: originalExecArgv,
                configurable: true,
            });
        }
    });

    it('preserves loader/import flags needed for dev-mode subprocesses', () => {
        const originalExecArgv = process.execArgv;
        Object.defineProperty(process, 'execArgv', {
            value: ['--import', 'tsx', '--inspect', '--loader=custom-loader'],
            configurable: true,
        });
        try {
            const args = buildSpawnArgs('/path/to/src/index.ts');
            expect(args).toEqual([
                '--import',
                'tsx',
                '--loader=custom-loader',
                '/path/to/src/index.ts',
                'invoke',
            ]);
        } finally {
            Object.defineProperty(process, 'execArgv', {
                value: originalExecArgv,
                configurable: true,
            });
        }
    });

    it('does not include --no-confirm (Commander v13 rejects unknown subcommand options)', () => {
        const originalExecArgv = process.execArgv;
        Object.defineProperty(process, 'execArgv', {
            value: [],
            configurable: true,
        });
        try {
            const args = buildSpawnArgs('/any/path');
            expect(args).not.toContain('--no-confirm');
            expect(args).not.toContain('--json');
        } finally {
            Object.defineProperty(process, 'execArgv', {
                value: originalExecArgv,
                configurable: true,
            });
        }
    });
});

describe('Subprocess stderr handling (M10.1b)', () => {
    it('parseInvokeOutput surfaces stderr when stdout is empty (Commander error)', () => {
        const result = parseInvokeOutput(
            '',
            "error: unknown option '--no-confirm'",
            1,
        );
        expect(result.status).toBe('error');
        expect(result.errors?.[0].code).toBe('mcp.empty_response');
        expect(result.errors?.[0].message).toContain("unknown option '--no-confirm'");
    });

    it('parseInvokeOutput surfaces stderr when exit code is non-zero and stdout empty', () => {
        const result = parseInvokeOutput('', 'FATAL: config load failed', 1);
        expect(result.status).toBe('error');
        expect(result.errors?.[0].message).toContain('config load failed');
    });

    it('aca_run surfaces subprocess stderr through MCP error response', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue({
                stdout: '',
                stderr: "Error: Cannot find module '/bad/path/index.js'",
                exitCode: 1,
            });
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'any task' },
        });

        expect(result.isError).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('Cannot find module');

        await client.close();
    });

    it('subprocess completes successfully even with non-empty stderr (warnings)', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue({
                ...makeSuccessResult('task done'),
                stderr: '[warn] deprecated API usage',
            });
        const client = await connectClient(spawnFn);

        const result = await client.callTool({
            name: 'aca_run',
            arguments: { task: 'task with warnings' },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content as Array<{ type: string; text: string }>)[0].text;
        expect(text).toContain('task done');

        await client.close();
    });
});

describe('Environment propagation (M10.1b)', () => {
    it('runAcaInvoke passes complete InvokeRequest with deadline to spawn function', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue(makeSuccessResult('done'));

        await runAcaInvoke('read file.txt', { deadlineMs: 60000 }, spawnFn);

        const [json, deadline] = spawnFn.mock.calls[0];
        const parsed = JSON.parse(json);

        // Verify the InvokeRequest envelope is complete
        expect(parsed.contract_version).toBe(CONTRACT_VERSION);
        expect(parsed.schema_version).toBe(SCHEMA_VERSION);
        expect(parsed.task).toBe('read file.txt');
        expect(parsed.constraints.max_steps).toBe(50);
        expect(parsed.constraints.max_total_tokens).toBe(200000);
        expect(parsed.deadline).toBe(60000);
        expect(deadline).toBe(60000);
    });

    it('timeout propagates through the full MCP → spawn chain', async () => {
        const spawnFn = vi.fn<(json: string, deadline: number) => Promise<AcaInvokeResult>>()
            .mockResolvedValue(makeSuccessResult('done'));
        const client = await connectClient(spawnFn);

        await client.callTool({
            name: 'aca_run',
            arguments: { task: 'task', timeout_ms: 120000 },
        });

        const [json, deadline] = spawnFn.mock.calls[0];
        const parsed = JSON.parse(json);
        // Both the InvokeRequest deadline and the spawn deadline must match
        expect(parsed.deadline).toBe(120000);
        expect(deadline).toBe(120000);

        await client.close();
    });
});
