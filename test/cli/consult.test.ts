import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

function tmpProjectDirWithFiles(files: Record<string, string>): string {
    const dir = tmpProjectDir();
    for (const [relativePath, contents] of Object.entries(files)) {
        const absolutePath = join(dir, relativePath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, contents);
    }
    return dir;
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
            witnesses: 'minimax',
            sharedContext: true,
            sharedContextModel: 'zai-org/glm-5',
            triage: 'always',
        });

        expect(result.shared_context?.status).toBe('ok');
        expect(result.success_count).toBe(1);
        expect(result.witnesses.minimax.raw_request_path).toBeTruthy();

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
        expect(witnessOptions?.systemMessages?.[0]?.content).toContain('witness consult pass');
        expect(triageOptions?.systemMessages?.[0]?.content).toContain('triage pass');
    });

    it('rejects trivial no-bug answers for advisory prompts and retries for a substantive answer', async () => {
        let witnessPrompt = '';
        const projectDir = tmpProjectDir();

        runAcaInvokeMock.mockImplementation(async (task: string, options?: { model?: string }) => {
            if (task.includes('Invalid Previous Context Request')) {
                expect(task).toContain('No bug found.');
                expect(task).toContain('This task is advisory/conceptual, not a repo-inspection task.');
                expect(task).toContain('A bare response like "No bug found." or "No issues found." is invalid for this task.');
                expect(task).toContain('## Recommendation');
                return makeInvokeSuccess('## Recommendation\nUse effective capacity, recurring-work baselines, explicit buffers, and scenario ranges so the planning template distinguishes sustainable throughput from aspirational demand.\n\n## Why\nThat structure keeps recurring obligations visible, makes uncertainty explicit, and gives a manager a repeatable way to translate incoming demand into staffing pressure.\n\n## Tradeoffs\n- Heavier structure improves planning discipline, but it takes upkeep and can become stale if the workload drivers are not reviewed regularly.\n\n## Caveats\n- None.');
            }
            if (task.includes('Advisory Witness Direct-Answer Protocol')) {
                witnessPrompt = task;
                return makeInvokeSuccess('No bug found.');
            }
            throw new Error(`unexpected consult prompt/model: ${options?.model ?? 'unknown'}`);
        });

        const result = await runConsult({
            question: 'How should a manager build a workload driver template for capacity planning?',
            projectDir,
            witnesses: 'minimax',
            skipTriage: true,
        });

        expect(witnessPrompt).toContain('This is an advisory or analysis task');
        expect(witnessPrompt).toContain('Do not collapse to "No bug found" or "No issues found"');
        expect(witnessPrompt).toContain('## Recommendation');
        expect(witnessPrompt).toContain('## Tradeoffs');
        expect(witnessPrompt).not.toContain('If no grounded issue is found, say that directly.');
        expect(result.success_count).toBe(1);
        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.context_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                round: 1,
                outcome: 'invalid',
                error: 'low-value advisory report emitted in advisory direct-answer pass',
                request_count: 0,
                diagnostic_count: 0,
            },
            {
                stage: 'initial_retry',
                round: 1,
                outcome: 'report',
                error: null,
                request_count: 0,
                diagnostic_count: 0,
            },
        ]);
        expect(readFileSync(result.witnesses.minimax.response_path!, 'utf8')).toContain('effective capacity');
    });

    it('defaults to minimax and qwen, and auto-skips triage when the witnesses align', async () => {
        const invokedModels: string[] = [];

        runAcaInvokeMock.mockImplementation(async (_task: string, options?: { model?: string }) => {
            if (options?.model) invokedModels.push(options.model);
            if (options?.model === 'minimax/minimax-m2.7') {
                return makeInvokeSuccess('## Findings\n\nMiniMax witness report.');
            }
            if (options?.model === 'qwen/qwen3.5-397b-a17b') {
                return makeInvokeSuccess('## Findings\n\nQwen witness report.');
            }
            throw new Error(`unexpected consult model: ${options?.model ?? 'unknown'}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
        });

        expect(result.total_witnesses).toBe(2);
        expect(Object.keys(result.witnesses)).toEqual(['minimax', 'qwen']);
        expect(result.triage.status).toBe('skipped');
        expect(result.triage.error).toBe('skipped by triage=auto');
        expect(invokedModels).toEqual(['minimax/minimax-m2.7', 'qwen/qwen3.5-397b-a17b']);
    });

    it('rejects repo-context fishing for advisory prompts and retries for a direct answer', async () => {
        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Invalid Previous Context Request')) {
                expect(task).toContain('"type":"tree"');
                expect(task).toContain('repo-context request emitted in advisory direct-answer pass');
                expect(task).toContain('Do not request repository trees, files, symbols, or line snippets');
                return makeInvokeSuccess('## Recommendation\nSeparate recurring work from project work, allocate capacity by lane, and present commitments as operating ranges instead of a single precision number.\n\n## Why\nThat keeps operational load from being hidden inside project plans and gives leadership a planning model that reflects uncertainty rather than pretending it does not exist.\n\n## Tradeoffs\n- Capacity lanes improve clarity, but they can create political friction when leaders want every initiative treated as equally urgent.\n\n## Caveats\n- None.');
            }
            if (task.includes('Advisory Witness Direct-Answer Protocol')) {
                return makeInvokeSuccess('{"needs_context":[{"type":"tree","path":".","reason":"inspect repo for workload templates"}]}');
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'What framework should an operations lead use to separate recurring work from project work without creating false precision?',
            projectDir: tmpProjectDir(),
            witnesses: 'minimax',
            skipTriage: true,
        });

        expect(result.success_count).toBe(1);
        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.context_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                round: 1,
                outcome: 'invalid',
                error: 'repo-context request emitted in advisory direct-answer pass',
                request_count: 0,
                diagnostic_count: 0,
            },
            {
                stage: 'initial_retry',
                round: 1,
                outcome: 'report',
                error: null,
                request_count: 0,
                diagnostic_count: 0,
            },
        ]);
    });

    it('rejects under-specified advisory answers and retries for a richer structured answer', async () => {
        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Invalid Previous Context Request')) {
                expect(task).toContain('under-specified advisory report emitted in advisory direct-answer pass');
                expect(task).toContain('## Recommendation');
                return makeInvokeSuccess('## Recommendation\nUse a recurring-capacity model with explicit buffers and service classes so planning starts from what the team must absorb every week before any project promises are added.\n\n## Why\nThat gives the manager a stable baseline, makes variable demand visible, and creates a repeatable way to show when new commitments would crowd out operational work.\n\n## Tradeoffs\n- The model is more honest than a single forecast, but leaders may resist because it exposes uncertainty and forces prioritization conversations earlier.\n\n## Caveats\n- None.');
            }
            if (task.includes('Advisory Witness Direct-Answer Protocol')) {
                return makeInvokeSuccess('Use buffers and planning ranges.');
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'How should a manager build a workload driver template for capacity planning?',
            projectDir: tmpProjectDir(),
            witnesses: 'minimax',
            skipTriage: true,
        });

        expect(result.success_count).toBe(1);
        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.context_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                round: 1,
                outcome: 'invalid',
                error: 'under-specified advisory report emitted in advisory direct-answer pass',
                request_count: 0,
                diagnostic_count: 0,
            },
            {
                stage: 'initial_retry',
                round: 1,
                outcome: 'report',
                error: null,
                request_count: 0,
                diagnostic_count: 0,
            },
        ]);
    });

    it('uses advisory last-chance recovery when retry is still invalid', async () => {
        let lastChancePrompt = '';

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('## Advisory Recovery')) {
                lastChancePrompt = task;
                expect(task).toContain('low-value advisory report emitted in advisory direct-answer pass');
                expect(task).toContain('## Recommendation');
                return makeInvokeSuccess('## Recommendation\nFreeze new commitments, reset priorities, and move the team back to a sustainable baseline before adding more work.\n\n## Why\nThat reduces overload quickly, prevents burnout from compounding, and gives the manager room to distinguish real capacity problems from temporary spikes.\n\n## Tradeoffs\n- Pulling work out of flight may upset stakeholders, but continuing to overload the team will cost more through churn, errors, and attrition.\n\n## Caveats\n- None.');
            }
            if (task.includes('Invalid Previous Context Request')) {
                return makeInvokeSuccess('No issues found.');
            }
            if (task.includes('Advisory Witness Direct-Answer Protocol')) {
                return makeInvokeSuccess('No bug found.');
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'What staffing signals indicate a team is over capacity, and how should a manager respond?',
            projectDir: tmpProjectDir(),
            witnesses: 'minimax',
            skipTriage: true,
        });

        expect(lastChancePrompt).toContain('Return plain Markdown only using exactly this structure');
        expect(result.success_count).toBe(1);
        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.context_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                round: 1,
                outcome: 'invalid',
                error: 'low-value advisory report emitted in advisory direct-answer pass',
                request_count: 0,
                diagnostic_count: 0,
            },
            {
                stage: 'initial_retry',
                round: 1,
                outcome: 'invalid',
                error: 'low-value advisory report emitted in advisory direct-answer pass',
                request_count: 0,
                diagnostic_count: 0,
            },
            {
                stage: 'initial_last_chance',
                round: 1,
                outcome: 'report',
                error: null,
                request_count: 0,
                diagnostic_count: 0,
            },
        ]);
    });

    it('retries advisory empty responses with a minimal recovery prompt', async () => {
        let recoveryPrompt = '';

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('## Advisory Empty-Response Recovery')) {
                recoveryPrompt = task;
                expect(task).toContain('llm.empty: Model returned an empty response');
                expect(task).toContain('Return plain Markdown only using exactly this structure');
                expect(task).toContain('## Recommendation');
                return makeInvokeSuccess('## Recommendation\nUse ranges, explicit buffers, and recurring-work baselines so the team plans against likely throughput instead of a single fragile forecast.\n\n## Why\nThat gives the manager a stable operating baseline, exposes when new demand would exceed safe capacity, and keeps uncertainty visible instead of buried in optimistic commitments.\n\n## Tradeoffs\n- This improves resilience, but it can feel less decisive to executives who want one precise number for every commitment.\n\n## Caveats\n- None.');
            }
            if (task.includes('Advisory Witness Direct-Answer Protocol')) {
                return makeInvokeError('llm.empty', 'Model returned an empty response');
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'How should an operations manager plan capacity when incoming work is variable week to week?',
            projectDir: tmpProjectDir(),
            witnesses: 'minimax',
            skipTriage: true,
        });

        expect(recoveryPrompt).toContain('Answer from general reasoning in the prompt alone.');
        expect(result.success_count).toBe(1);
        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.context_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                round: 1,
                outcome: 'invoke_error',
                error: 'llm.empty: Model returned an empty response',
                request_count: 0,
                diagnostic_count: 0,
            },
            {
                stage: 'initial_retry',
                round: 1,
                outcome: 'report',
                error: null,
                request_count: 0,
                diagnostic_count: 0,
            },
        ]);
    });

    it('uses advisory empty-response last-chance recovery after repeated empty failures', async () => {
        let finalRecoveryPrompt = '';

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('## Advisory Final Recovery')) {
                finalRecoveryPrompt = task;
                expect(task).toContain('Attempt 1: llm.empty: Model returned an empty response');
                expect(task).toContain('Attempt 2: llm.empty: Model returned an empty response');
                expect(task).toContain('## Recommendation');
                return makeInvokeSuccess('## Recommendation\nTrack queue growth, aging work, and chronic spillover against available capacity, then reset commitments before overload compounds.\n\n## Why\nThose signals surface overload earlier than burnout symptoms alone and give the manager a practical basis for renegotiating scope before the team normalizes unsustainable effort.\n\n## Tradeoffs\n- Earlier escalation can create uncomfortable stakeholder conversations, but delaying it usually converts a planning issue into a morale and retention issue.\n\n## Caveats\n- This is a general management framework, not a repo-specific recommendation.');
            }
            if (task.includes('## Advisory Empty-Response Recovery')) {
                return makeInvokeError('llm.empty', 'Model returned an empty response');
            }
            if (task.includes('Advisory Witness Direct-Answer Protocol')) {
                return makeInvokeError('llm.empty', 'Model returned an empty response');
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'What signals should a manager watch to catch overload before the team burns out?',
            projectDir: tmpProjectDir(),
            witnesses: 'minimax',
            skipTriage: true,
        });

        expect(finalRecoveryPrompt).toContain('Use the prompt alone. Do not inspect or mention the repository');
        expect(result.success_count).toBe(1);
        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.context_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                round: 1,
                outcome: 'invoke_error',
                error: 'llm.empty: Model returned an empty response',
                request_count: 0,
                diagnostic_count: 0,
            },
            {
                stage: 'initial_retry',
                round: 1,
                outcome: 'invoke_error',
                error: 'llm.empty: Model returned an empty response',
                request_count: 0,
                diagnostic_count: 0,
            },
            {
                stage: 'initial_last_chance',
                round: 1,
                outcome: 'report',
                error: null,
                request_count: 0,
                diagnostic_count: 0,
            },
        ]);
    });

    it('keeps repo review prompts in review mode and still accepts clean no-issues reports', async () => {
        let witnessPrompt = '';

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Witness Context Request Protocol')) {
                witnessPrompt = task;
                return makeInvokeSuccess('## Findings\n\nNo issues found.');
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review src/index.ts for regressions.',
            projectDir: tmpProjectDir(),
            witnesses: 'minimax',
            skipTriage: true,
        });

        expect(witnessPrompt).toContain('This is a repo/code review task.');
        expect(witnessPrompt).toContain('If no grounded issue is found, say that directly.');
        expect(result.success_count).toBe(1);
        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.context_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                round: 1,
                outcome: 'report',
                error: null,
                request_count: 0,
                diagnostic_count: 0,
            },
        ]);
    });

    it('passes degraded witness output into triage without retrying the witness', async () => {
        let triagePrompt = '';

        runAcaInvokeMock.mockImplementation(async (task: string, options?: { model?: string }) => {
            if (task.includes('# ACA Consult Triage')) {
                triagePrompt = task;
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            if (options?.model === 'minimax/minimax-m2.7') {
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
            witnesses: 'minimax,kimi',
        });

        expect(result.success_count).toBe(1);
        expect(result.degraded).toBe(true);
        expect(result.triage.status).toBe('ok');
        expect(result.witnesses.minimax.status).toBe('error');
        expect(result.witnesses.minimax.triage_input_path).toBeTruthy();
        expect(triagePrompt).toContain('## minimax (minimax/minimax-m2.7)');
        expect(triagePrompt).toContain('Status: degraded (pseudo-tool call emitted in no-tools context-request pass)');
        expect(triagePrompt).toContain('<tool_call>{"name":"read_file","arguments":{"path":"src/index.ts"}}</tool_call>');
        expect(triagePrompt).toContain('Do not promote claims based only on missing-file errors');

        const deepseekCalls = runAcaInvokeMock.mock.calls.filter(([, options]) =>
            (options as { model?: string } | undefined)?.model === 'minimax/minimax-m2.7',
        );
        expect(deepseekCalls).toHaveLength(2); // first pass + retry (pseudo-tool-call is now retryable)
    });

    it('runs triage when only degraded witness evidence is available', async () => {
        let triagePrompt = '';

        runAcaInvokeMock.mockImplementation(async (task: string, options?: { model?: string }) => {
            if (task.includes('# ACA Consult Triage')) {
                triagePrompt = task;
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            if (options?.model === 'minimax/minimax-m2.7') {
                return makeInvokeSuccess('<tool_call>{"name":"read_file","arguments":{"path":"src/index.ts"}}</tool_call>');
            }
            throw new Error(`unexpected consult model: ${options?.model ?? 'unknown'}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
            witnesses: 'minimax',
            triage: 'always',
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
            if (options?.model === 'minimax/minimax-m2.7') {
                return makeInvokeSuccess('{"action":"final","findings_markdown":"","needs_context":[]}');
            }
            throw new Error(`unexpected consult model: ${options?.model ?? 'unknown'}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
            witnesses: 'minimax',
            triage: 'always',
        });

        expect(result.success_count).toBe(0);
        expect(result.degraded).toBe(true);
        expect(result.triage.status).toBe('ok');
        expect(result.witnesses.minimax.status).toBe('error');
        expect(result.witnesses.minimax.error).toBe('empty final report emitted in no-tools context-request pass');
        expect(result.witnesses.minimax.triage_input_path).toBeTruthy();
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
                expect(task).toContain('Do not quote literal pseudo-tool markup such as `<invoke>` or `<tool_call>`');
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            if (options?.model === 'minimax/minimax-m2.7') {
                return makeInvokeSuccess('## Findings\n\nNo critical issues.');
            }
            throw new Error(`unexpected consult model: ${options?.model ?? 'unknown'}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
            witnesses: 'minimax',
            triage: 'always',
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
        const projectDir = tmpProjectDirWithFiles({
            'src/index.ts': 'export const ok = true;\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string, options?: { model?: string }) => {
            if (task.includes('Invalid Previous Context Request')) {
                contextRetries += 1;
                expect(task).toContain('custom JSON object or unsupported schema');
                return makeInvokeSuccess('{"needs_context":[{"type":"tree","path":"src","reason":"find implementation files"}]}');
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
            projectDir,
            witnesses: 'minimax',
            maxContextRounds: 1,
        });

        expect(contextRetries).toBe(1);
        expect(result.success_count).toBe(1);
        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.context_requests).toEqual([{
            type: 'tree',
            path: 'src',
            line_start: 0,
            line_end: 0,
            reason: 'find implementation files',
        }]);
        expect(result.witnesses.minimax.raw_request_path).toBeTruthy();
    });

    it('preserves witness request diagnostics across a rejected first-pass request and retry', async () => {
        const projectDir = tmpProjectDirWithFiles({
            'src/index.ts': 'export const ok = true;\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Invalid Previous Context Request')) {
                return makeInvokeSuccess('## Findings\n\nRecovered after invalid request.');
            }
            if (task.includes('Witness Context Request Protocol')) {
                return makeInvokeSuccess('{"needs_context":[{"type":"file","path":"src/index.ts","line_start":250,"line_end":300,"reason":"guessing"}]}');
            }
            if (task.includes('# ACA Consult Triage')) {
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir,
            witnesses: 'minimax',
            maxContextRounds: 1,
        });

        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.context_requests).toEqual([]);
        expect(result.witnesses.minimax.context_request_diagnostics).toContainEqual({
            request_index: 0,
            reason: 'unsupported_anchored_file_range',
            message: 'witness file requests may not specify raw line ranges',
            type: 'file',
            path: 'src/index.ts',
        });
        expect(result.witnesses.minimax.context_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                round: 1,
                outcome: 'invalid',
                error: 'non-report output emitted in no-tools context-request pass',
                request_count: 0,
                diagnostic_count: 1,
            },
            {
                stage: 'initial_retry',
                round: 1,
                outcome: 'report',
                error: null,
                request_count: 0,
                diagnostic_count: 0,
            },
        ]);
    });

    it('records witness context attempt diagnostics across continuation retry recovery', async () => {
        const projectDir = tmpProjectDirWithFiles({
            'src/index.ts': 'export const ok = true;\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Invalid Previous Context Request')) {
                expect(task).toContain('{"package_name":"anothercodingagent"}');
                return makeInvokeSuccess('## Findings\n\nRecovered after continuation retry.');
            }
            if (task.includes('Witness Context Request Protocol (Continuation)')) {
                return makeInvokeSuccess('{"package_name":"anothercodingagent"}');
            }
            if (task.includes('Witness Context Request Protocol')) {
                return makeInvokeSuccess('{"needs_context":[{"type":"tree","path":"src","reason":"discover implementation files"}]}');
            }
            if (task.includes('# ACA Consult Triage')) {
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir,
            witnesses: 'minimax',
            maxContextRounds: 2,
        });

        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.context_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                round: 1,
                outcome: 'requests',
                error: null,
                request_count: 1,
                diagnostic_count: 0,
            },
            {
                stage: 'continuation',
                round: 2,
                outcome: 'invalid',
                error: 'non-report output emitted in no-tools context-request pass',
                request_count: 0,
                diagnostic_count: 0,
            },
            {
                stage: 'continuation_retry',
                round: 2,
                outcome: 'report',
                error: null,
                request_count: 0,
                diagnostic_count: 0,
            },
        ]);
    });

    it('records witness continuation invoke errors in context attempt diagnostics', async () => {
        const projectDir = tmpProjectDirWithFiles({
            'src/index.ts': 'export const ok = true;\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Witness Context Request Protocol (Continuation)')) {
                return makeInvokeError('llm.empty', 'Model returned an empty response');
            }
            if (task.includes('Witness Context Request Protocol')) {
                return makeInvokeSuccess('{"needs_context":[{"type":"tree","path":"src","reason":"discover implementation files"}]}');
            }
            if (task.includes('# ACA Consult Triage')) {
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir,
            witnesses: 'minimax',
            maxContextRounds: 2,
        });

        expect(result.witnesses.minimax.status).toBe('error');
        expect(result.witnesses.minimax.error).toBe('llm.empty: Model returned an empty response');
        expect(result.witnesses.minimax.context_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                round: 1,
                outcome: 'requests',
                error: null,
                request_count: 1,
                diagnostic_count: 0,
            },
            {
                stage: 'continuation',
                round: 2,
                outcome: 'invoke_error',
                error: 'llm.empty: Model returned an empty response',
                request_count: 0,
                diagnostic_count: 0,
            },
        ]);
    });

    it('repairs a malformed finalization custom JSON response into a Markdown report', async () => {
        let finalRetries = 0;
        const projectDir = tmpProjectDirWithFiles({
            'src/index.ts': 'export const ok = true;\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Witness Context Request Protocol')) {
                return makeInvokeSuccess('{"needs_context":[{"type":"tree","path":"src","reason":"find implementation files"}]}');
            }
            if (task.includes('Invalid Previous Finalization')) {
                finalRetries += 1;
                expect(task).toContain('custom JSON object or unsupported schema');
                return makeInvokeSuccess('## Findings\n\nRepaired final report.');
            }
            if (task.includes('## Finalization')) {
                return makeInvokeSuccess('{"package_name":"anothercodingagent","canonical_witness_keys":["minimax"]}');
            }
            if (task.includes('# ACA Consult Triage')) {
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir,
            witnesses: 'minimax',
        });

        expect(finalRetries).toBe(1);
        expect(result.success_count).toBe(1);
        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.response_path).toBeTruthy();
        expect(result.witnesses.minimax.triage_input_path).toBe(result.witnesses.minimax.response_path);
        expect(result.witnesses.minimax.finalization_diagnostics).toEqual([
            {
                stage: 'final',
                outcome: 'invalid',
                error: 'empty or non-report output emitted in no-tools finalization pass',
            },
            {
                stage: 'final_retry',
                outcome: 'report',
                error: null,
                report_source: 'markdown',
            },
        ]);
    });

    it('salvages structured last-chance finalization output into a valid witness report before falling back', async () => {
        let finalRetries = 0;
        let lastChanceCalls = 0;
        const projectDir = tmpProjectDirWithFiles({
            'src/index.ts': 'export const ok = true;\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Finalization Recovery')) {
                lastChanceCalls += 1;
                expect(task).toContain('Return plain Markdown only using exactly this structure');
                return makeInvokeSuccess('{"package_name":"anothercodingagent","findings":["Recovered on last chance."],"open_questions":["None."]}');
            }
            if (task.includes('Invalid Previous Finalization')) {
                finalRetries += 1;
                return makeInvokeSuccess('{"package_name":"anothercodingagent","canonical_witness_keys":["minimax"]}');
            }
            if (task.includes('Witness Context Request Protocol')) {
                return makeInvokeSuccess('{"needs_context":[{"type":"tree","path":"src","reason":"find implementation files"}]}');
            }
            if (task.includes('## Finalization')) {
                return makeInvokeSuccess('{"package_name":"anothercodingagent","canonical_witness_keys":["minimax"]}');
            }
            if (task.includes('# ACA Consult Triage')) {
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir,
            witnesses: 'minimax',
        });

        expect(finalRetries).toBe(1);
        expect(lastChanceCalls).toBe(1);
        expect(result.success_count).toBe(1);
        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.response_path).toBeTruthy();
        const recoveredBody = readFileSync(result.witnesses.minimax.response_path!, 'utf8');
        expect(recoveredBody).toContain('ACA reformatted malformed structured finalization output into Markdown.');
        expect(recoveredBody).toContain('Recovered on last chance');
    });

    it('salvages object-shaped findings and alternate question keys into a valid witness report', async () => {
        const projectDir = tmpProjectDirWithFiles({
            'src/index.ts': 'export const ok = true;\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Witness Context Request Protocol')) {
                return makeInvokeSuccess('{"needs_context":[{"type":"tree","path":"src","reason":"find implementation files"}]}');
            }
            if (task.includes('## Finalization')) {
                return makeInvokeSuccess('{"findings":[{"title":"Grounded concern","detail":"The witness recovered from object-shaped output."}],"questions":[{"message":"None."}]}');
            }
            if (task.includes('# ACA Consult Triage')) {
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir,
            witnesses: 'minimax',
        });

        expect(result.success_count).toBe(1);
        expect(result.witnesses.minimax.status).toBe('ok');
        const recoveredBody = readFileSync(result.witnesses.minimax.response_path!, 'utf8');
        expect(recoveredBody).toContain('ACA reformatted malformed structured finalization output into Markdown.');
        expect(recoveredBody).toContain('Grounded concern: The witness recovered from object-shaped output.');
        expect(recoveredBody).toContain('## Open Questions');
        expect(recoveredBody).toContain('- None.');
        expect(result.witnesses.minimax.finalization_diagnostics).toEqual([
            {
                stage: 'final',
                outcome: 'report',
                error: null,
                report_source: 'salvaged_structured',
            },
        ]);
    });

    it('builds a fallback witness report for triage when finalization repair retry fails after retrieval', async () => {
        const projectDir = tmpProjectDirWithFiles({
            'src/index.ts': 'export const ok = true;\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Witness Context Request Protocol')) {
                return makeInvokeSuccess('{"needs_context":[{"type":"tree","path":"src","reason":"find implementation files"}]}');
            }
            if (task.includes('Finalization Recovery')) {
                return makeInvokeSuccess('{"package_name":"anothercodingagent","canonical_witness_keys":["minimax"]}');
            }
            if (task.includes('Invalid Previous Finalization')) {
                return makeInvokeSuccess('{"package_name":"anothercodingagent","canonical_witness_keys":["minimax"]}');
            }
            if (task.includes('## Finalization')) {
                return makeInvokeSuccess('{"package_name":"anothercodingagent","canonical_witness_keys":["minimax"]}');
            }
            if (task.includes('# ACA Consult Triage')) {
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir,
            witnesses: 'minimax',
        });

        expect(result.success_count).toBe(0);
        expect(result.witnesses.minimax.status).toBe('error');
        expect(result.witnesses.minimax.error).toBe('empty or non-report output emitted in no-tools finalization pass');
        expect(result.witnesses.minimax.response_path).toBeTruthy();
        expect(result.witnesses.minimax.triage_input_path).toBeTruthy();
        const degradedBody = readFileSync(result.witnesses.minimax.triage_input_path!, 'utf8');
        expect(degradedBody).toContain('ACA generated this fallback witness note');
        expect(degradedBody).toContain('src/');
        expect(degradedBody).toContain('The witness finalization failed with: empty or non-report output emitted in no-tools finalization pass');
        expect(degradedBody).toContain('## Context Attempt Timeline');
        expect(degradedBody).toContain('- round 1 initial: requests (requests=1, diagnostics=0)');
        expect(degradedBody).toContain('## Finalization Timeline');
        expect(degradedBody).toContain('- final: invalid');
        expect(degradedBody).toContain('- final_retry: invalid');
        expect(degradedBody).toContain('- final_last_chance: invalid');
        expect(degradedBody).toContain('- fallback: generated');
        expect(result.witnesses.minimax.finalization_diagnostics).toEqual([
            {
                stage: 'final',
                outcome: 'invalid',
                error: 'empty or non-report output emitted in no-tools finalization pass',
            },
            {
                stage: 'final_retry',
                outcome: 'invalid',
                error: 'empty or non-report output emitted in no-tools finalization pass',
            },
            {
                stage: 'final_last_chance',
                outcome: 'invalid',
                error: 'empty or non-report output emitted in no-tools finalization pass',
            },
            {
                stage: 'fallback',
                outcome: 'generated',
                error: 'empty or non-report output emitted in no-tools finalization pass',
            },
        ]);
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
            if (options?.model === 'minimax/minimax-m2.7') {
                return makeInvokeSuccess('## Findings\n\nNo critical issues.');
            }
            throw new Error(`unexpected consult model: ${options?.model ?? 'unknown'}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir: tmpProjectDir(),
            witnesses: 'minimax',
            sharedContext: true,
            triage: 'always',
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

    it('shared-context scout can use tree discovery before requesting grounded files', async () => {
        const projectDir = tmpProjectDirWithFiles({
            'src/consult/context-request.ts': 'export const strictWitnessMode = true;\n',
        });
        let sharedCalls = 0;

        runAcaInvokeMock.mockImplementation(async (task: string, options?: { model?: string }) => {
            if (task.includes('Shared Raw Evidence Scout Protocol (Continuation)')) {
                sharedCalls += 1;
                expect(task).toContain('### tree: src');
                return makeInvokeSuccess(JSON.stringify({
                    needs_context: [{
                        type: 'file',
                        path: 'src/consult/context-request.ts',
                        reason: 'inspect grounded file after tree discovery',
                    }],
                }));
            }
            if (task.includes('Shared Raw Evidence Scout Protocol')) {
                sharedCalls += 1;
                return makeInvokeSuccess(JSON.stringify({
                    needs_context: [{
                        type: 'tree',
                        path: 'src',
                        line_start: 0,
                        line_end: 0,
                        reason: 'discover consult files',
                    }],
                }));
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
            projectDir,
            witnesses: 'minimax',
            sharedContext: true,
        });

        expect(sharedCalls).toBe(2);
        expect(result.shared_context?.status).toBe('ok');
        expect(result.shared_context?.scout_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                outcome: 'requests',
                error: null,
                request_count: 1,
                diagnostic_count: 0,
            },
            {
                stage: 'continuation',
                outcome: 'requests',
                error: null,
                request_count: 1,
                diagnostic_count: 0,
            },
        ]);
        expect(result.shared_context?.context_requests).toEqual([
            {
                type: 'tree',
                path: 'src',
                line_start: 0,
                line_end: 0,
                reason: 'discover consult files',
            },
            {
                type: 'file',
                path: 'src/consult/context-request.ts',
                line_start: 1,
                line_end: 160,
                reason: 'inspect grounded file after tree discovery',
                provenance: {
                    source_kind: 'tree',
                    source_ref: 'src',
                    window_source: 'aca_policy',
                    window_policy: 'file_open_head_v1',
                },
            },
        ]);
        expect(result.shared_context?.context_snippets).toHaveLength(2);
        expect(result.shared_context?.context_snippets[0].type).toBe('tree');
        expect(result.shared_context?.context_snippets[1].path).toBe('src/consult/context-request.ts');
        expect(result.shared_context?.context_snippets[1].provenance).toEqual({
            source_kind: 'tree',
            source_ref: 'src',
            window_source: 'aca_policy',
            window_policy: 'file_open_head_v1',
        });
    });

    it('preserves shared-context request diagnostics alongside accepted requests', async () => {
        const projectDir = tmpProjectDirWithFiles({
            'src/consult/context-request.ts': 'export const strictWitnessMode = true;\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Shared Raw Evidence Scout Protocol (Continuation)')) {
                return makeInvokeSuccess(JSON.stringify({
                    needs_context: [{
                        type: 'file',
                        path: 'src/consult/context-request.ts',
                        reason: 'inspect grounded file after tree discovery',
                    }],
                }));
            }
            if (task.includes('Shared Raw Evidence Scout Protocol')) {
                return makeInvokeSuccess(JSON.stringify({
                    needs_context: [
                        {
                            type: 'tree',
                            path: 'src',
                            line_start: 0,
                            line_end: 0,
                            reason: 'discover consult files',
                        },
                        {
                            type: 'file',
                            path: '<placeholder>',
                            line_start: 1,
                            line_end: 40,
                            reason: 'bad placeholder request',
                        },
                    ],
                }));
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
            projectDir,
            witnesses: 'minimax',
            sharedContext: true,
        });

        expect(result.shared_context?.status).toBe('ok');
        expect(result.shared_context?.context_requests[0]).toEqual({
            type: 'tree',
            path: 'src',
            line_start: 0,
            line_end: 0,
            reason: 'discover consult files',
        });
        expect(result.shared_context?.context_request_diagnostics).toContainEqual({
            request_index: 1,
            reason: 'placeholder_path',
            message: 'request path was empty or still contained placeholder markers',
            type: 'file',
            path: '<placeholder>',
        });
    });

    it('records scout attempt diagnostics when shared-context continuation emits pseudo-tool output', async () => {
        const projectDir = tmpProjectDirWithFiles({
            'src/consult/context-request.ts': 'export const strictWitnessMode = true;\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Shared Raw Evidence Scout Protocol (Continuation)')) {
                return makeInvokeSuccess('<tool_call name="read_file">bad</tool_call>');
            }
            if (task.includes('Shared Raw Evidence Scout Protocol')) {
                return makeInvokeSuccess(JSON.stringify({
                    needs_context: [{
                        type: 'tree',
                        path: 'src',
                        line_start: 0,
                        line_end: 0,
                        reason: 'discover consult files',
                    }],
                }));
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
            projectDir,
            witnesses: 'minimax',
            sharedContext: true,
        });

        expect(result.shared_context?.status).toBe('error');
        expect(result.shared_context?.error).toBe('pseudo-tool call emitted in shared raw context scout continuation pass');
        expect(result.shared_context?.triage_input_path).toBeTruthy();
        const degradedBody = readFileSync(result.shared_context?.triage_input_path!, 'utf8');
        expect(degradedBody).toContain('ACA generated this shared-context degraded note');
        expect(degradedBody).toContain('## Scout Attempt Timeline');
        expect(degradedBody).toContain('## Request Provenance');
        expect(degradedBody).toContain('`src/` — directory discovery request; fulfilled ok');
        expect(degradedBody).toContain('- initial: requests (requests=1, diagnostics=0)');
        expect(degradedBody).toContain('- continuation: invalid (requests=0, diagnostics=0) — pseudo-tool call emitted in shared raw context scout continuation pass');
        expect(result.shared_context?.provenance_summary).toEqual([
            '`src/` — directory discovery request; fulfilled ok',
        ]);
        expect(result.shared_context?.scout_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                outcome: 'requests',
                error: null,
                request_count: 1,
                diagnostic_count: 0,
            },
            {
                stage: 'continuation',
                outcome: 'invalid',
                error: 'pseudo-tool call emitted in shared raw context scout continuation pass',
                request_count: 0,
                diagnostic_count: 0,
            },
        ]);
    });

    it('rejects explicit shared-context initial file ranges and records scout diagnostics', async () => {
        const projectDir = tmpProjectDirWithFiles({
            'src/consult/context-request.ts': Array.from({ length: 240 }, (_, index) => `line ${index + 1}`).join('\n'),
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Shared Raw Evidence Scout Protocol')) {
                return makeInvokeSuccess(JSON.stringify({
                    needs_context: [{
                        type: 'file',
                        path: 'src/consult/context-request.ts',
                        line_start: 140,
                        line_end: 200,
                        reason: 'guess likely implementation block',
                    }],
                }));
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
            question: 'Review src/consult/context-request.ts lines 140-200 for consult pipeline changes.',
            projectDir,
            witnesses: 'minimax',
            sharedContext: true,
        });

        expect(result.shared_context?.status).toBe('ok');
        expect(result.shared_context?.context_requests).toEqual([]);
        expect(result.shared_context?.context_request_diagnostics).toEqual([{
            request_index: 0,
            reason: 'unsupported_shared_file_range',
            message: 'shared-context initial file requests may not specify raw line ranges',
            type: 'file',
            path: 'src/consult/context-request.ts',
        }]);
        expect(result.shared_context?.scout_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                outcome: 'no_requests',
                error: null,
                request_count: 0,
                diagnostic_count: 1,
            },
        ]);
    });

    it('rejects ungrounded initial shared-context path-only file requests and records scout diagnostics', async () => {
        const projectDir = tmpProjectDirWithFiles({
            'src/consult/context-request.ts': Array.from({ length: 240 }, (_, index) => `line ${index + 1}`).join('\n'),
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Shared Raw Evidence Scout Protocol')) {
                return makeInvokeSuccess(JSON.stringify({
                    needs_context: [{
                        type: 'file',
                        path: 'src/consult/context-request.ts',
                        reason: 'guess likely file head',
                    }],
                }));
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
            projectDir,
            witnesses: 'minimax',
            sharedContext: true,
        });

        expect(result.shared_context?.status).toBe('ok');
        expect(result.shared_context?.context_requests).toEqual([]);
        expect(result.shared_context?.context_request_diagnostics).toEqual([{
            request_index: 0,
            reason: 'file_not_prompt_grounded',
            message: 'shared-context initial file requests must use a file path already present in the task or ACA evidence',
            type: 'file',
            path: 'src/consult/context-request.ts',
        }]);
        expect(result.shared_context?.scout_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                outcome: 'no_requests',
                error: null,
                request_count: 0,
                diagnostic_count: 1,
            },
        ]);
    });

    it('accepts shared-context symbol requests in the initial scout pass', async () => {
        const projectDir = tmpProjectDirWithFiles({
            'src/consult/context-request.ts': [
                'export const helper = true;',
                '',
                'export function buildSharedContextRequestPrompt() {',
                '  return "ok";',
                '}',
            ].join('\n'),
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Shared Raw Evidence Scout Protocol')) {
                expect(task).toContain('<symbol_locations>');
                expect(task).toContain('buildSharedContextRequestPrompt → src/consult/context-request.ts');
                return makeInvokeSuccess(JSON.stringify({
                    needs_context: [{
                        type: 'symbol',
                        symbol: 'buildSharedContextRequestPrompt',
                        reason: 'inspect shared scout prompt implementation',
                    }],
                }));
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
            question: 'Review buildSharedContextRequestPrompt for shared-context scout behavior.',
            projectDir,
            witnesses: 'minimax',
            sharedContext: true,
        });

        expect(result.shared_context?.status).toBe('ok');
        expect(result.shared_context?.context_request_diagnostics).toEqual([]);
        expect(result.shared_context?.context_requests).toEqual([
            {
                type: 'file',
                path: 'src/consult/context-request.ts',
                line_start: 1,
                line_end: 123,
                reason: 'inspect shared scout prompt implementation',
                provenance: {
                    source_kind: 'symbol',
                    source_ref: 'buildSharedContextRequestPrompt',
                    anchor_line: 3,
                    window_before: 2,
                    window_after: 120,
                    window_source: 'aca_policy',
                    window_policy: 'symbol_window_v1',
                },
            },
        ]);
        expect(result.shared_context?.context_snippets[0]).toMatchObject({
            path: 'src/consult/context-request.ts',
            provenance: {
                source_kind: 'symbol',
                source_ref: 'buildSharedContextRequestPrompt',
                anchor_line: 3,
                window_source: 'aca_policy',
                window_policy: 'symbol_window_v1',
            },
        });
        expect(result.shared_context?.provenance_summary).toEqual([
            '`src/consult/context-request.ts:1-123` — symbol anchor `buildSharedContextRequestPrompt` at line 3 via ACA symbol window; fulfilled ok',
        ]);
        expect(result.shared_context?.scout_attempt_diagnostics).toEqual([
            {
                stage: 'initial',
                outcome: 'requests',
                error: null,
                request_count: 1,
                diagnostic_count: 0,
            },
        ]);
    });

    it('shared-context continuation accepts expand requests anchored to prior file snippets', async () => {
        const projectDir = tmpProjectDirWithFiles({
            'src/consult/context-request.ts': Array.from({ length: 240 }, (_, index) => `line ${index + 1}`).join('\n'),
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Shared Raw Evidence Scout Protocol (Continuation)')) {
                expect(task).toContain('Use `type: "expand"`');
                expect(task).toContain('### src/consult/context-request.ts:1-160');
                return makeInvokeSuccess(JSON.stringify({
                    needs_context: [{
                        type: 'expand',
                        path: 'src/consult/context-request.ts',
                        anchor_line: 120,
                        reason: 'read around previously exposed implementation',
                    }],
                }));
            }
            if (task.includes('Shared Raw Evidence Scout Protocol')) {
                return makeInvokeSuccess(JSON.stringify({
                    needs_context: [
                        {
                            type: 'tree',
                            path: 'src',
                            line_start: 0,
                            line_end: 0,
                            reason: 'discover consult files',
                        },
                        {
                            type: 'file',
                            path: 'src/consult/context-request.ts',
                            reason: 'inspect discovered file head',
                        },
                    ],
                }));
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
            question: 'Review src/consult/context-request.ts for the change.',
            projectDir,
            witnesses: 'minimax',
            sharedContext: true,
        });

        expect(result.shared_context?.status).toBe('ok');
        expect(result.shared_context?.context_request_diagnostics).toEqual([]);
        expect(result.shared_context?.context_requests).toEqual([
            {
                type: 'tree',
                path: 'src',
                line_start: 0,
                line_end: 0,
                reason: 'discover consult files',
            },
            {
                path: 'src/consult/context-request.ts',
                line_start: 1,
                line_end: 160,
                reason: 'inspect discovered file head',
                provenance: {
                    source_kind: 'direct',
                    source_ref: 'prompt_path:src/consult/context-request.ts',
                    window_source: 'aca_policy',
                    window_policy: 'file_open_head_v1',
                },
            },
            {
                type: 'file',
                path: 'src/consult/context-request.ts',
                line_start: 60,
                line_end: 219,
                reason: 'read around previously exposed implementation',
                provenance: {
                    source_kind: 'snippet',
                    source_ref: 'src/consult/context-request.ts:1-160',
                    anchor_line: 120,
                    window_before: 60,
                    window_after: 99,
                    window_source: 'aca_policy',
                    window_policy: 'expand_window_v1',
                },
            },
        ]);
        expect(result.shared_context?.provenance_summary).toEqual([
            '`src/` — directory discovery request; fulfilled ok',
            '`src/consult/context-request.ts:1-160` — task-mentioned path `src/consult/context-request.ts` via ACA-opened file head; fulfilled ok',
            '`src/consult/context-request.ts:60-219` — ACA snippet anchor `src/consult/context-request.ts:1-160` around line 120 via ACA expansion window; fulfilled ok',
        ]);
    });

    it('accepts witness file opens grounded by the ACA evidence pack', async () => {
        const projectDir = tmpProjectDirWithFiles({
            'src/consult/context-request.ts': '// packed witness fixture\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Witness Context Request Protocol (Continuation)')) {
                return makeInvokeSuccess('## Findings\n\nPacked witness review complete.');
            }
            if (task.includes('Witness Context Request Protocol')) {
                return makeInvokeSuccess(JSON.stringify({
                    needs_context: [{
                        type: 'file',
                        path: 'src/consult/context-request.ts',
                        reason: 'reopen the packed file head',
                    }],
                }));
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir,
            witnesses: 'minimax',
            packPath: ['src/consult/context-request.ts'],
        });

        expect(result.success_count).toBe(1);
        expect(result.triage.status).toBe('skipped');
        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.context_request_diagnostics).toEqual([]);
        expect(result.witnesses.minimax.context_requests).toEqual([{
            type: 'file',
            path: 'src/consult/context-request.ts',
            line_start: 1,
            line_end: 120,
            reason: 'reopen the packed file head',
            provenance: {
                source_kind: 'direct',
                source_ref: 'evidence_pack_path:src/consult/context-request.ts',
                window_source: 'aca_policy',
                window_policy: 'file_open_head_v1',
            },
        }]);
    });

    it('includes degraded shared-context notes in triage input', async () => {
        let triagePrompt = '';
        const projectDir = tmpProjectDirWithFiles({
            'src/consult/context-request.ts': 'export const strictWitnessMode = true;\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Shared Raw Evidence Scout Protocol (Continuation)')) {
                return makeInvokeSuccess('<tool_call name="read_file">bad</tool_call>');
            }
            if (task.includes('Shared Raw Evidence Scout Protocol')) {
                return makeInvokeSuccess(JSON.stringify({
                    needs_context: [{
                        type: 'tree',
                        path: 'src',
                        line_start: 0,
                        line_end: 0,
                        reason: 'discover consult files',
                    }],
                }));
            }
            if (task.includes('# ACA Consult Triage')) {
                triagePrompt = task;
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            if (task.includes('Witness Context Request Protocol')) {
                return makeInvokeSuccess('## Findings\n\nNo issues found.');
            }
            throw new Error(`unexpected consult prompt: ${task.slice(0, 120)}`);
        });

        const result = await runConsult({
            question: 'Review the change.',
            projectDir,
            witnesses: 'minimax',
            sharedContext: true,
        });

        expect(result.triage.status).toBe('ok');
        expect(result.shared_context?.status).toBe('error');
        expect(result.shared_context?.triage_input_path).toBeTruthy();
        expect(triagePrompt).toContain('## shared_context (zai-org/glm-5)');
        expect(triagePrompt).toContain('ACA generated this shared-context degraded note');
        expect(triagePrompt).toContain('## Scout Attempt Timeline');
        expect(triagePrompt).toContain('pseudo-tool call emitted in shared raw context scout continuation pass');
    });

    // C11.7 — multi-round context-request loop

    it('witness voluntarily finalizes in round 1 (backward compat)', async () => {
        let round1Calls = 0;

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Witness Context Request Protocol') && !task.includes('Continuation')) {
                round1Calls += 1;
                return makeInvokeSuccess('## Findings\n\nDirect finalization.');
            }
            if (task.includes('# ACA Consult Triage')) {
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected prompt: ${task.slice(0, 80)}`);
        });

        const result = await runConsult({
            question: 'What is the config schema?',
            projectDir: tmpProjectDir(),
            witnesses: 'minimax',
        });

        expect(round1Calls).toBe(1);
        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.context_requests).toHaveLength(0);
        expect(result.witnesses.minimax.context_snippets).toHaveLength(0);
    });

    it('multi-round: needs_context rounds 1+2, voluntary finalization on round 3', async () => {
        let round1Calls = 0;
        let continuationCalls = 0;
        const projectDir = tmpProjectDirWithFiles({
            'src/cli/consult.ts': 'export const consult = true;\n',
            'src/consult/context-request.ts': 'export const contextRequest = true;\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('Invalid Previous Context Request')) {
                throw new Error('unexpected retry in multi-round test');
            }
            if (task.includes('Witness Context Request Protocol (Continuation)')) {
                continuationCalls += 1;
                if (continuationCalls === 1) {
                    // Round 2: open a file that the prior tree listing exposed
                    return makeInvokeSuccess('{"needs_context":[{"type":"file","path":"src/cli/consult.ts","reason":"see imports"}]}');
                }
                // Round 3: finalize voluntarily
                return makeInvokeSuccess('## Findings\n\nFull analysis complete.');
            }
            if (task.includes('Witness Context Request Protocol')) {
                round1Calls += 1;
                // Round 1: discover the relevant directory first
                return makeInvokeSuccess('{"needs_context":[{"type":"tree","path":"src","reason":"discover consult files"}]}');
            }
            if (task.includes('# ACA Consult Triage')) {
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected prompt: ${task.slice(0, 100)}`);
        });

        const result = await runConsult({
            question: 'Explain the context-request pipeline.',
            projectDir,
            witnesses: 'minimax',
            maxContextRounds: 3,
        });

        expect(round1Calls).toBe(1);
        expect(continuationCalls).toBe(2);
        expect(result.witnesses.minimax.status).toBe('ok');
        // Both rounds' requests should be accumulated
        expect(result.witnesses.minimax.context_requests).toHaveLength(2);
        expect(result.witnesses.minimax.context_requests[1].provenance).toEqual({
            source_kind: 'tree',
            source_ref: 'src',
            window_source: 'aca_policy',
            window_policy: 'file_open_head_v1',
        });
    });

    it('round cap: witness keeps requesting past maxRounds → forced finalization', async () => {
        let contextRounds = 0;
        let finalizationCalls = 0;
        const projectDir = tmpProjectDirWithFiles({
            'src/index.ts': 'export const value = 1;\n',
        });

        runAcaInvokeMock.mockImplementation(async (task: string) => {
            if (task.includes('## Finalization')) {
                finalizationCalls += 1;
                return makeInvokeSuccess('## Findings\n\nForced finalization.');
            }
            if (task.includes('Witness Context Request Protocol')) {
                // Always request more context (never finalizes voluntarily)
                contextRounds += 1;
                return makeInvokeSuccess(`{"needs_context":[{"type":"tree","path":"src","reason":"round ${contextRounds}"}]}`);
            }
            if (task.includes('# ACA Consult Triage')) {
                return makeInvokeSuccess(VALID_TRIAGE_REPORT);
            }
            throw new Error(`unexpected prompt: ${task.slice(0, 80)}`);
        });

        const result = await runConsult({
            question: 'Analyze everything.',
            projectDir,
            witnesses: 'minimax',
            maxContextRounds: 2,
        });

        // 2 context-request rounds used, then forced finalization
        expect(contextRounds).toBe(2);
        expect(finalizationCalls).toBe(1);
        expect(result.witnesses.minimax.status).toBe('ok');
        expect(result.witnesses.minimax.context_requests).toHaveLength(2);
    });
});
