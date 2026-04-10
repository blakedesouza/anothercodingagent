import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRACT_VERSION, SCHEMA_VERSION } from '../../src/cli/executor.js';

const { runAcaInvokeMock } = vi.hoisted(() => ({
    runAcaInvokeMock: vi.fn(),
}));

vi.mock('../../src/mcp/server.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/mcp/server.js')>('../../src/mcp/server.js');
    return {
        ...actual,
        runAcaInvoke: runAcaInvokeMock,
    };
});

import { runConsult } from '../../src/cli/consult.js';

const VALID_TRIAGE_REPORT = `## Consensus Findings

No actionable issues.

## Dissent

None.

## Likely False Positives

None.

## Open Questions

None.
`;

function tmpProjectDir(): string {
    return mkdtempSync(join(tmpdir(), 'aca-consult-test-'));
}

function makeInvokeSuccess(result: string): { stdout: string; stderr: string; exitCode: number } {
    return {
        stdout: JSON.stringify({
            contract_version: CONTRACT_VERSION,
            schema_version: SCHEMA_VERSION,
            status: 'success',
            result,
        }),
        stderr: '',
        exitCode: 0,
    };
}

function makeInvokeError(code: string, message: string): { stdout: string; stderr: string; exitCode: number } {
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

describe('runConsult', () => {
    beforeEach(() => {
        runAcaInvokeMock.mockReset();
    });

    it('uses structured output only for shared-context acquisition', async () => {
        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Shared Raw Evidence Scout Protocol')) {
                return makeInvokeSuccess('{"needs_context":[]}');
            }
            if (task.includes('Witness Context Request Protocol')) {
                return makeInvokeSuccess('## Findings\n\nNo issues found.');
            }
            if (task.includes('# ACA Consult Triage')) {
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
            witnesses: 'deepseek',
            sharedContext: true,
            sharedContextModel: 'zai-org/glm-5',
        });

        expect(result.shared_context?.status).toBe('ok');
        expect(result.success_count).toBe(1);
        expect(result.witnesses.deepseek.raw_request_path).toBeTruthy();

        const sharedCall = runAcaInvokeMock.mock.calls.find(([task]) =>
            typeof task === 'string' && task.includes('Shared Raw Evidence Scout Protocol'),
        );
        const witnessCall = runAcaInvokeMock.mock.calls.find(([task]) =>
            typeof task === 'string' && task.includes('Witness Context Request Protocol'),
        );
        const triageCall = runAcaInvokeMock.mock.calls.find(([task]) =>
            typeof task === 'string' && task.includes('# ACA Consult Triage'),
        );

        const sharedOptions = sharedCall?.[1] as { responseFormat?: { type?: string }; systemMessages?: Array<{ content: string }> } | undefined;
        const witnessOptions = witnessCall?.[1] as { responseFormat?: unknown; systemMessages?: Array<{ content: string }> } | undefined;
        const triageOptions = triageCall?.[1] as { responseFormat?: unknown; systemMessages?: Array<{ content: string }> } | undefined;

        expect(sharedOptions?.responseFormat?.type).toBe('json_schema');
        expect(witnessOptions?.responseFormat).toBeUndefined();
        expect(triageOptions?.responseFormat).toBeUndefined();
        expect(sharedOptions?.systemMessages?.[0]?.content).toContain('shared raw evidence scout');
        expect(witnessOptions?.systemMessages?.[0]?.content).toContain('witness review pass');
        expect(triageOptions?.systemMessages?.[0]?.content).toContain('triage pass');
    });

    it('passes degraded witness output into triage without retrying the witness', async () => {
        let triagePrompt = '';

        runAcaInvokeMock.mockImplementation(async (task: string, options?: { model?: string }) => {
            if (task.includes('# ACA Consult Triage')) {
                triagePrompt = task;
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            if (options?.model === 'deepseek/deepseek-v3.2') {
                return makeInvokeSuccess('<tool_call>{"name":"read_file","arguments":{"path":"src/index.ts"}}</tool_call>');
            }
            if (options?.model === 'moonshotai/kimi-k2.5') {
                return makeInvokeSuccess('## Findings\n\nNo critical issues.');
            }
            throw new Error(`unexpected consult model: ${options?.model ?? 'unknown'}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
            witnesses: 'deepseek,kimi',
        });

        expect(result.success_count).toBe(1);
        expect(result.degraded).toBe(true);
        expect(result.triage.status).toBe('ok');
        expect(result.witnesses.deepseek.status).toBe('error');
        expect(result.witnesses.deepseek.triage_input_path).toBeTruthy();
        expect(triagePrompt).toContain('## deepseek (deepseek/deepseek-v3.2)');
        expect(triagePrompt).toContain('Status: degraded (pseudo-tool call emitted in no-tools context-request pass)');
        expect(triagePrompt).toContain('<tool_call>{"name":"read_file","arguments":{"path":"src/index.ts"}}</tool_call>');
        expect(triagePrompt).toContain('Do not promote claims based only on missing-file errors');

        const deepseekCalls = runAcaInvokeMock.mock.calls.filter(([, options]) =>
            (options as { model?: string } | undefined)?.model === 'deepseek/deepseek-v3.2',
        );
        expect(deepseekCalls).toHaveLength(1);
    });

    it('runs triage when only degraded witness evidence is available', async () => {
        let triagePrompt = '';

        runAcaInvokeMock.mockImplementation(async (task: string, options?: { model?: string }) => {
            if (task.includes('# ACA Consult Triage')) {
                triagePrompt = task;
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            if (options?.model === 'deepseek/deepseek-v3.2') {
                return makeInvokeSuccess('<tool_call>{"name":"read_file","arguments":{"path":"src/index.ts"}}</tool_call>');
            }
            throw new Error(`unexpected consult model: ${options?.model ?? 'unknown'}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
            witnesses: 'deepseek',
        });

        expect(result.success_count).toBe(0);
        expect(result.degraded).toBe(true);
        expect(result.triage.status).toBe('ok');
        expect(result.triage.error).toBeNull();
        expect(triagePrompt).toContain('Status: degraded (pseudo-tool call emitted in no-tools context-request pass)');
        expect(triagePrompt).toContain('<tool_call>{"name":"read_file","arguments":{"path":"src/index.ts"}}</tool_call>');
    });

    it('passes an empty structured final into triage as degraded witness evidence', async () => {
        let triagePrompt = '';

        runAcaInvokeMock.mockImplementation(async (task: string, options?: { model?: string }) => {
            if (task.includes('# ACA Consult Triage')) {
                triagePrompt = task;
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            if (options?.model === 'deepseek/deepseek-v3.2') {
                return makeInvokeSuccess('{"action":"final","findings_markdown":"","needs_context":[]}');
            }
            throw new Error(`unexpected consult model: ${options?.model ?? 'unknown'}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
            witnesses: 'deepseek',
        });

        expect(result.success_count).toBe(0);
        expect(result.degraded).toBe(true);
        expect(result.triage.status).toBe('ok');
        expect(result.witnesses.deepseek.status).toBe('error');
        expect(result.witnesses.deepseek.error).toBe('empty final report emitted in no-tools context-request pass');
        expect(result.witnesses.deepseek.triage_input_path).toBeTruthy();
        expect(triagePrompt).toContain('Status: degraded (empty final report emitted in no-tools context-request pass)');
        expect(triagePrompt).toContain('"action":"final"');
        expect(triagePrompt).toContain('"findings_markdown":""');
    });

    it('retries incomplete triage output once and accepts the repaired report', async () => {
        let triageAttempts = 0;

        runAcaInvokeMock.mockImplementation(async (task: string, options?: { model?: string }) => {
            if (task.includes('# ACA Consult Triage')) {
                triageAttempts += 1;
                if (triageAttempts === 1) {
                    return makeInvokeSuccess('## Consensus Findings\n\nThe no-tools detection covers `<invoke>`, `');
                }
                expect(task).toContain('Invalid Previous Triage Response');
                expect(task).toContain('Do not quote literal pseudo-tool markup such as <invoke> or <tool_call>');
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            if (options?.model === 'deepseek/deepseek-v3.2') {
                return makeInvokeSuccess('## Findings\n\nNo critical issues.');
            }
            throw new Error(`unexpected consult model: ${options?.model ?? 'unknown'}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
            witnesses: 'deepseek',
        });

        expect(triageAttempts).toBe(2);
        expect(result.success_count).toBe(1);
        expect(result.triage.status).toBe('ok');
        expect(result.triage.error).toBeNull();
        expect(result.triage.raw_path).toBeTruthy();
        expect(readFileSync(result.triage.raw_path!, 'utf8')).toContain('## Consensus Findings');
        expect(readFileSync(result.triage.raw_path!, 'utf8')).toContain('The no-tools detection covers `<invoke>`');
    });

    it('repairs a malformed first-pass custom JSON response into a valid needs_context flow', async () => {
        let contextRetries = 0;

        runAcaInvokeMock.mockImplementation(async (task: string, options?: { model?: string }) => {
            if (task.includes('Invalid Previous Context Request')) {
                contextRetries += 1;
                expect(task).toContain('custom JSON object or unsupported schema');
                return makeInvokeSuccess('{"needs_context":[{"path":"src/index.ts","line_start":1,"line_end":5,"reason":"verify"}]}');
            }
            if (task.includes('Witness Context Request Protocol')) {
                return makeInvokeSuccess('{"package_name":"anothercodingagent"}');
            }
            if (task.includes('## Finalization')) {
                return makeInvokeSuccess('## Findings\n\nVerified after retry.');
            }
            if (task.includes('# ACA Consult Triage')) {
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
            witnesses: 'deepseek',
            maxContextRounds: 1,
        });

        expect(contextRetries).toBe(1);
        expect(result.success_count).toBe(1);
        expect(result.witnesses.deepseek.status).toBe('ok');
        expect(result.witnesses.deepseek.context_requests).toEqual([{
            path: 'src/index.ts',
            line_start: 1,
            line_end: 5,
            reason: 'verify',
        }]);
        expect(result.witnesses.deepseek.raw_request_path).toBeTruthy();
    });

    it('repairs a malformed finalization custom JSON response into a Markdown report', async () => {
        let finalRetries = 0;

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Witness Context Request Protocol')) {
                return makeInvokeSuccess('{"needs_context":[{"path":"src/index.ts","line_start":1,"line_end":5,"reason":"verify"}]}');
            }
            if (task.includes('Invalid Previous Finalization')) {
                finalRetries += 1;
                expect(task).toContain('custom JSON object or unsupported schema');
                return makeInvokeSuccess('## Findings\n\nRepaired final report.');
            }
            if (task.includes('## Finalization')) {
                return makeInvokeSuccess('{"package_name":"anothercodingagent","canonical_witness_keys":["deepseek"]}');
            }
            if (task.includes('# ACA Consult Triage')) {
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
            witnesses: 'deepseek',
        });

        expect(finalRetries).toBe(1);
        expect(result.success_count).toBe(1);
        expect(result.witnesses.deepseek.status).toBe('ok');
        expect(result.witnesses.deepseek.response_path).toBeTruthy();
        expect(result.witnesses.deepseek.triage_input_path).toBe(result.witnesses.deepseek.response_path);
    });

    it('preserves the original malformed finalization artifact for triage when repair retry fails', async () => {
        let triagePrompt = '';

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Witness Context Request Protocol')) {
                return makeInvokeSuccess('{"needs_context":[{"path":"src/index.ts","line_start":1,"line_end":5,"reason":"verify"}]}');
            }
            if (task.includes('Invalid Previous Finalization')) {
                return makeInvokeSuccess('{"package_name":"anothercodingagent","canonical_witness_keys":["deepseek"]}');
            }
            if (task.includes('## Finalization')) {
                return makeInvokeSuccess('{"package_name":"anothercodingagent","canonical_witness_keys":["deepseek"]}');
            }
            if (task.includes('# ACA Consult Triage')) {
                triagePrompt = task;
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
            witnesses: 'deepseek',
        });

        expect(result.success_count).toBe(0);
        expect(result.witnesses.deepseek.status).toBe('error');
        expect(result.witnesses.deepseek.error).toBe('empty or non-report output emitted in no-tools finalization pass');
        expect(result.witnesses.deepseek.triage_input_path).toBeTruthy();
        const degradedBody = readFileSync(result.witnesses.deepseek.triage_input_path!, 'utf8');
        expect(degradedBody).toContain('"package_name":"anothercodingagent"');
        expect(triagePrompt).toContain('"canonical_witness_keys":["deepseek"]');
    });

    it('falls back to the next internal model when shared-context or triage default is unavailable', async () => {
        runAcaInvokeMock.mockImplementation(async (task: string, options?: { model?: string }) => {
            if (options?.model === 'zai-org/glm-5') {
                return makeInvokeError('protocol.invalid_model', 'Unknown model "zai-org/glm-5"');
            }
            if (task.includes('Shared Raw Evidence Scout Protocol')) {
                expect(options?.model).toBe('moonshotai/kimi-k2.5');
                return makeInvokeSuccess('{"needs_context":[]}');
            }
            if (task.includes('# ACA Consult Triage')) {
                expect(options?.model).toBe('moonshotai/kimi-k2.5');
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            if (options?.model === 'deepseek/deepseek-v3.2') {
                return makeInvokeSuccess('## Findings\n\nNo critical issues.');
            }
            throw new Error(`unexpected consult model: ${options?.model ?? 'unknown'}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
            witnesses: 'deepseek',
            sharedContext: true,
        });

        expect(result.shared_context?.status).toBe('ok');
        expect(result.shared_context?.model).toBe('moonshotai/kimi-k2.5');
        expect(result.triage.status).toBe('ok');
        expect(result.triage.model).toBe('moonshotai/kimi-k2.5');

        const failedGlmCalls = runAcaInvokeMock.mock.calls.filter(([, options]) =>
            (options as { model?: string } | undefined)?.model === 'zai-org/glm-5',
        );
        const kimiCalls = runAcaInvokeMock.mock.calls.filter(([, options]) =>
            (options as { model?: string } | undefined)?.model === 'moonshotai/kimi-k2.5',
        );
        expect(failedGlmCalls.length).toBeGreaterThanOrEqual(2);
        expect(kimiCalls.length).toBeGreaterThanOrEqual(2);
    });
});
