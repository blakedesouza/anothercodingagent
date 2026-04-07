import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { appendEvidencePack, buildEvidencePack, type EvidencePackSummary } from '../consult/evidence-pack.js';
import {
    appendSharedContextPack,
    buildContextRequestRetryPrompt,
    buildContextRequestPrompt,
    buildFinalizationPrompt,
    buildFinalizationRetryPrompt,
    buildSharedContextRequestPrompt,
    containsContextRequestLikeJson,
    containsPseudoToolCall,
    fulfillContextRequests,
    parseContextRequests,
    type ContextSnippet,
} from '../consult/context-request.js';
import { WITNESS_MODELS, type WitnessModelConfig } from '../config/witness-models.js';
import { parseInvokeOutput, runAcaInvoke } from '../mcp/server.js';
import type { InvokeResponse, InvokeSafety, InvokeUsage } from './executor.js';

export interface ConsultOptions {
    question?: string;
    promptFile?: string;
    projectDir?: string;
    witnesses?: string;
    packPath?: string[];
    packRepo?: boolean;
    packMaxFiles?: number;
    packMaxFileBytes?: number;
    packMaxTotalBytes?: number;
    maxContextSnippets?: number;
    maxContextLines?: number;
    maxContextBytes?: number;
    sharedContext?: boolean;
    sharedContextModel?: string;
    sharedContextMaxSnippets?: number;
    sharedContextMaxLines?: number;
    sharedContextMaxBytes?: number;
    skipTriage?: boolean;
    out?: string;
}

interface WitnessResult {
    name: string;
    model: string;
    status: 'ok' | 'error';
    error: string | null;
    response_path: string | null;
    raw_request_path: string | null;
    usage: InvokeUsage | null;
    safety: InvokeSafety | { context_request?: InvokeSafety; final?: InvokeSafety; final_retry?: InvokeSafety } | null;
    context_requests: ReturnType<typeof parseContextRequests>;
    context_snippets: Omit<ContextSnippet, 'text'>[];
}

interface ConsultResult {
    mode: 'context_request';
    success_count: number;
    total_witnesses: number;
    degraded: boolean;
    result_path: string;
    evidence_pack_summary?: EvidencePackSummary;
    shared_context?: {
        status: 'ok' | 'skipped' | 'error';
        model: string | null;
        request_path: string | null;
        error: string | null;
        usage: InvokeUsage | null;
        safety: InvokeSafety | null;
        context_requests: ReturnType<typeof parseContextRequests>;
        context_snippets: Omit<ContextSnippet, 'text'>[];
    };
    witnesses: Record<string, WitnessResult>;
    triage: {
        status: 'ok' | 'skipped' | 'error';
        model: string | null;
        path: string | null;
        error: string | null;
        usage: InvokeUsage | null;
        safety: InvokeSafety | null;
    };
}

const TRIAGE_MODEL = 'zai-org/glm-5';
const DEFAULT_SHARED_CONTEXT_SNIPPETS = 8;
const DEFAULT_SHARED_CONTEXT_LINES = 160;
const DEFAULT_SHARED_CONTEXT_BYTES = 16_000;

function parseList(raw: string | undefined): string[] {
    return (raw ?? '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function selectWitnesses(raw: string | undefined): WitnessModelConfig[] {
    const names = parseList(raw);
    if (names.length === 0 || names.includes('all')) return [...WITNESS_MODELS];
    const selected: WitnessModelConfig[] = [];
    for (const name of names) {
        const witness = WITNESS_MODELS.find(item => item.name === name);
        if (!witness) throw new Error(`unknown witness: ${name}`);
        selected.push(witness);
    }
    return selected;
}

function usageOrNull(response: InvokeResponse): InvokeUsage | null {
    return response.usage ?? null;
}

function mergeUsage(...usages: Array<InvokeUsage | null | undefined>): InvokeUsage | null {
    const present = usages.filter((usage): usage is InvokeUsage => usage !== null && usage !== undefined);
    if (present.length === 0) return null;
    return {
        input_tokens: present.reduce((sum, usage) => sum + usage.input_tokens, 0),
        output_tokens: present.reduce((sum, usage) => sum + usage.output_tokens, 0),
        cost_usd: present.reduce((sum, usage) => sum + usage.cost_usd, 0),
    };
}

function errorMessage(response: InvokeResponse, stderr: string): string {
    if (response.errors?.length) return response.errors.map(error => `${error.code}: ${error.message}`).join('; ');
    return stderr.trim() || 'unknown invoke error';
}

function shouldRetryNoToolsFinalization(response: InvokeResponse): boolean {
    if (response.status === 'success') {
        const result = response.result ?? '';
        return containsPseudoToolCall(result) || containsContextRequestLikeJson(result);
    }
    return response.errors?.some(error => error.code === 'turn.max_steps' && error.retryable) ?? false;
}

function shouldRetryNoToolsContextRequest(response: InvokeResponse): boolean {
    if (response.status === 'success') return containsPseudoToolCall(response.result ?? '');
    return response.errors?.some(error => error.code === 'turn.max_steps' && error.retryable) ?? false;
}

function currentAcaCommand(): { command: string; args: string[] } {
    const entrypoint = process.argv[1] ?? 'aca';
    if (entrypoint.endsWith('.ts')) {
        return { command: 'npx', args: ['tsx', entrypoint] };
    }
    return { command: process.execPath, args: [entrypoint] };
}

function renderPrompt(question: string): string {
    return `# ACA Consult

## Task
${question}

## Review Rules
- Return concrete findings only.
- Include file paths and line numbers when possible.
- If no bug is found, say that directly.
`;
}

async function invoke(model: string, prompt: string, projectDir: string, options: {
    maxSteps: number;
    maxTotalTokens: number;
    outPath?: string;
}): Promise<{ response: InvokeResponse; stderr: string }> {
    const result = await runAcaInvoke(prompt, {
        model,
        allowedTools: [],
        maxSteps: options.maxSteps,
        maxToolCalls: 1,
        maxTotalTokens: options.maxTotalTokens,
        deadlineMs: 1_200_000,
    }, async (requestJson, deadlineMs) => {
        return await new Promise((resolvePromise, reject) => {
            const aca = currentAcaCommand();
            const child = spawn(aca.command, [...aca.args, 'invoke'], {
                cwd: projectDir,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env },
            });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            const timer = setTimeout(() => {
                child.kill('SIGTERM');
            }, deadlineMs + 5_000);
            child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
            child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
            child.on('error', error => {
                clearTimeout(timer);
                reject(error);
            });
            child.on('close', code => {
                clearTimeout(timer);
                resolvePromise({
                    stdout: Buffer.concat(stdout).toString('utf8'),
                    stderr: Buffer.concat(stderr).toString('utf8'),
                    exitCode: code ?? 1,
                });
            });
            child.stdin.end(requestJson);
        });
    });
    const response = parseInvokeOutput(result.stdout, result.stderr, result.exitCode);
    if (options.outPath && response.result) writeFileSync(options.outPath, response.result);
    return { response, stderr: result.stderr };
}

async function runWitness(witness: WitnessModelConfig, prompt: string, projectDir: string, suffix: string, limits: {
    maxContextSnippets: number;
    maxContextLines: number;
    maxContextBytes: number;
}): Promise<WitnessResult> {
    const responsePath = join(tmpdir(), `aca-consult-${witness.name}-response-${suffix}.md`);
    const requestPath = join(tmpdir(), `aca-consult-${witness.name}-context-request-${suffix}.md`);
    const firstPrompt = buildContextRequestPrompt(prompt, {
        maxSnippets: limits.maxContextSnippets,
        maxLines: limits.maxContextLines,
        maxBytes: limits.maxContextBytes,
    });
    const firstAttempt = await invoke(witness.model, firstPrompt, projectDir, { maxSteps: 1, maxTotalTokens: 30_000, outPath: requestPath });
    const firstRetry = shouldRetryNoToolsContextRequest(firstAttempt.response)
        ? await invoke(
            witness.model,
            buildContextRequestRetryPrompt(
                prompt,
                firstAttempt.response.result ?? errorMessage(firstAttempt.response, firstAttempt.stderr),
                {
                    maxSnippets: limits.maxContextSnippets,
                    maxLines: limits.maxContextLines,
                    maxBytes: limits.maxContextBytes,
                },
            ),
            projectDir,
            { maxSteps: 1, maxTotalTokens: 30_000, outPath: requestPath },
        )
        : null;
    const first = firstRetry ?? firstAttempt;
    if (first.response.status !== 'success') {
        return {
            name: witness.name,
            model: witness.model,
            status: 'error',
            error: errorMessage(first.response, first.stderr),
            response_path: null,
            raw_request_path: requestPath,
            usage: usageOrNull(first.response),
            safety: first.response.safety ?? null,
            context_requests: [],
            context_snippets: [],
        };
    }
    if (containsPseudoToolCall(first.response.result ?? '')) {
        return {
            name: witness.name,
            model: witness.model,
            status: 'error',
            error: 'pseudo-tool call emitted in no-tools context-request pass',
            response_path: null,
            raw_request_path: requestPath,
            usage: usageOrNull(first.response),
            safety: first.response.safety ?? null,
            context_requests: [],
            context_snippets: [],
        };
    }

    const requests = parseContextRequests(first.response.result ?? '', {
        maxSnippets: limits.maxContextSnippets,
        maxLines: limits.maxContextLines,
        maxBytes: limits.maxContextBytes,
    });
    if (requests.length === 0) {
        writeFileSync(responsePath, first.response.result ?? '');
        return {
            name: witness.name,
            model: witness.model,
            status: 'ok',
            error: null,
            response_path: responsePath,
            raw_request_path: null,
            usage: usageOrNull(first.response),
            safety: first.response.safety ?? null,
            context_requests: [],
            context_snippets: [],
        };
    }

    const snippets = fulfillContextRequests(requests, projectDir, {
        maxSnippets: limits.maxContextSnippets,
        maxLines: limits.maxContextLines,
        maxBytes: limits.maxContextBytes,
    });
    const finalPrompt = buildFinalizationPrompt(prompt, first.response.result ?? '', snippets);
    const final = await invoke(witness.model, finalPrompt, projectDir, { maxSteps: 1, maxTotalTokens: 30_000, outPath: responsePath });
    const retryFinalization = shouldRetryNoToolsFinalization(final.response);
    const finalRetry = retryFinalization
        ? await invoke(
            witness.model,
            buildFinalizationRetryPrompt(
                prompt,
                first.response.result ?? '',
                snippets,
                final.response.result ?? errorMessage(final.response, final.stderr),
            ),
            projectDir,
            { maxSteps: 1, maxTotalTokens: 30_000, outPath: responsePath },
        )
        : null;
    const finalResponse = finalRetry?.response ?? final.response;
    const finalStderr = finalRetry?.stderr ?? final.stderr;
    const finalRetryProtocolViolation = containsPseudoToolCall(finalResponse.result ?? '')
        || containsContextRequestLikeJson(finalResponse.result ?? '');
    return {
        name: witness.name,
        model: witness.model,
        status: finalResponse.status === 'success' && !finalRetryProtocolViolation ? 'ok' : 'error',
        error: finalResponse.status === 'success'
            ? (finalRetryProtocolViolation ? 'tool/context-request shaped output emitted in no-tools finalization pass after retry' : null)
            : errorMessage(finalResponse, finalStderr),
        response_path: finalResponse.status === 'success' && !finalRetryProtocolViolation ? responsePath : null,
        raw_request_path: requestPath,
        usage: mergeUsage(first.response.usage, final.response.usage, finalRetry?.response.usage),
        safety: {
            context_request: first.response.safety,
            final: final.response.safety,
            ...(finalRetry ? { final_retry: finalRetry.response.safety } : {}),
        },
        context_requests: requests,
        context_snippets: snippets.map(({ text: _text, ...snippet }) => snippet),
    };
}

async function buildSharedContext(prompt: string, projectDir: string, suffix: string, options: {
    model: string;
    maxSnippets: number;
    maxLines: number;
    maxBytes: number;
}): Promise<NonNullable<ConsultResult['shared_context']> & { snippetsWithText: ContextSnippet[] }> {
    const requestPath = join(tmpdir(), `aca-consult-shared-context-${suffix}.md`);
    const scoutPrompt = buildSharedContextRequestPrompt(prompt, {
        maxSnippets: options.maxSnippets,
        maxLines: options.maxLines,
        maxBytes: options.maxBytes,
    });
    const scout = await invoke(options.model, scoutPrompt, projectDir, {
        maxSteps: 1,
        maxTotalTokens: 30_000,
        outPath: requestPath,
    });

    if (scout.response.status !== 'success') {
        return {
            status: 'error',
            model: options.model,
            request_path: requestPath,
            error: errorMessage(scout.response, scout.stderr),
            usage: usageOrNull(scout.response),
            safety: scout.response.safety ?? null,
            context_requests: [],
            context_snippets: [],
            snippetsWithText: [],
        };
    }

    if (containsPseudoToolCall(scout.response.result ?? '')) {
        return {
            status: 'error',
            model: options.model,
            request_path: requestPath,
            error: 'pseudo-tool call emitted in shared raw context scout pass',
            usage: usageOrNull(scout.response),
            safety: scout.response.safety ?? null,
            context_requests: [],
            context_snippets: [],
            snippetsWithText: [],
        };
    }

    const requests = parseContextRequests(scout.response.result ?? '', {
        maxSnippets: options.maxSnippets,
        maxLines: options.maxLines,
        maxBytes: options.maxBytes,
    });
    const snippets = fulfillContextRequests(requests, projectDir, {
        maxSnippets: options.maxSnippets,
        maxLines: options.maxLines,
        maxBytes: options.maxBytes,
    });

    return {
        status: 'ok',
        model: options.model,
        request_path: requestPath,
        error: null,
        usage: usageOrNull(scout.response),
        safety: scout.response.safety ?? null,
        context_requests: requests,
        context_snippets: snippets.map(({ text: _text, ...snippet }) => snippet),
        snippetsWithText: snippets,
    };
}

function buildTriagePrompt(witnesses: Record<string, WitnessResult>): string {
    const sections = Object.values(witnesses).map(result => {
        const body = result.response_path ? readFileSync(result.response_path, 'utf8') : `(failed: ${result.error})`;
        return `## ${result.name} (${result.model})\n\nStatus: ${result.status}\n\n${body}`;
    }).join('\n\n---\n\n');
    return `# ACA Consult Triage

You are an aggregation-only triage pass. Tools are disabled.
The witness reports below are your only evidence. Do not do a fresh code review.
Do not request files, list directories, call tools, or emit XML/function/tool markup such as <call>, <tool_call>, <function_calls>, or <invoke>.
If evidence is missing, mark it as an open question instead of trying to fetch more context.

Return a concise Markdown report with:
- consensus findings
- dissent
- likely false positives
- open questions

${sections}
`;
}

function buildTriageRetryPrompt(witnesses: Record<string, WitnessResult>, invalidResponse: string): string {
    return `${buildTriagePrompt(witnesses)}

## Invalid Previous Triage Response

Your previous triage response attempted to call a tool or emitted tool-call markup. Tools are disabled in this pass, so that response is invalid.

\`\`\`text
${invalidResponse.slice(0, 4_000)}
\`\`\`

Produce the triage report now using only the witness reports above. Do not emit XML, function-call, tool-call, or invoke markup.
`;
}

export async function runConsult(options: ConsultOptions): Promise<ConsultResult> {
    const projectDir = resolve(options.projectDir ?? process.cwd());
    const suffix = `${Date.now()}-${process.pid}`;
    const promptBase = options.promptFile
        ? readFileSync(options.promptFile, 'utf8')
        : renderPrompt(options.question ?? '');
    const pack = (options.packRepo || (options.packPath?.length ?? 0) > 0)
        ? buildEvidencePack({
            projectDir,
            paths: options.packPath,
            packRepo: options.packRepo,
            maxFiles: options.packMaxFiles,
            maxFileBytes: options.packMaxFileBytes,
            maxTotalBytes: options.packMaxTotalBytes,
        })
        : undefined;
    const prompt = pack ? appendEvidencePack(promptBase, pack) : promptBase;
    const sharedContext = options.sharedContext
        ? await buildSharedContext(prompt, projectDir, suffix, {
            model: options.sharedContextModel ?? TRIAGE_MODEL,
            maxSnippets: options.sharedContextMaxSnippets ?? DEFAULT_SHARED_CONTEXT_SNIPPETS,
            maxLines: options.sharedContextMaxLines ?? DEFAULT_SHARED_CONTEXT_LINES,
            maxBytes: options.sharedContextMaxBytes ?? DEFAULT_SHARED_CONTEXT_BYTES,
        })
        : undefined;
    const promptForWitnesses = sharedContext?.status === 'ok' && sharedContext.snippetsWithText.length > 0
        ? appendSharedContextPack(prompt, sharedContext.model ?? TRIAGE_MODEL, sharedContext.snippetsWithText)
        : prompt;
    const witnesses = selectWitnesses(options.witnesses);
    const limits = {
        maxContextSnippets: options.maxContextSnippets ?? 3,
        maxContextLines: options.maxContextLines ?? 120,
        maxContextBytes: options.maxContextBytes ?? 8_000,
    };
    const witnessEntries = await Promise.all(
        witnesses.map(async witness => [witness.name, await runWitness(witness, promptForWitnesses, projectDir, suffix, limits)] as const),
    );
    const witnessResults = Object.fromEntries(witnessEntries);
    const successCount = Object.values(witnessResults).filter(result => result.status === 'ok').length;

    let triage: ConsultResult['triage'] = {
        status: 'skipped',
        model: null,
        path: null,
        error: options.skipTriage ? 'skipped by --skip-triage' : 'no successful witnesses',
        usage: null,
        safety: null,
    };
    if (!options.skipTriage && successCount > 0) {
        const triagePath = join(tmpdir(), `aca-consult-triage-${suffix}.md`);
        const triageInvoke = await invoke(TRIAGE_MODEL, buildTriagePrompt(witnessResults), projectDir, {
            maxSteps: 1,
            maxTotalTokens: 30_000,
            outPath: triagePath,
        });
        const triagePseudoToolCall = containsPseudoToolCall(triageInvoke.response.result ?? '');
        const triageRetry = triageInvoke.response.status === 'success' && triagePseudoToolCall
            ? await invoke(TRIAGE_MODEL, buildTriageRetryPrompt(witnessResults, triageInvoke.response.result ?? ''), projectDir, {
                maxSteps: 1,
                maxTotalTokens: 30_000,
                outPath: triagePath,
            })
            : null;
        const finalTriageResponse = triageRetry?.response ?? triageInvoke.response;
        const finalTriageStderr = triageRetry?.stderr ?? triageInvoke.stderr;
        const finalTriagePseudoToolCall = containsPseudoToolCall(finalTriageResponse.result ?? '');
        triage = {
            status: finalTriageResponse.status === 'success' && !finalTriagePseudoToolCall ? 'ok' : 'error',
            model: TRIAGE_MODEL,
            path: finalTriageResponse.status === 'success' && !finalTriagePseudoToolCall ? triagePath : null,
            error: finalTriageResponse.status === 'success'
                ? (finalTriagePseudoToolCall ? 'pseudo-tool call emitted in no-tools triage pass after retry' : null)
                : errorMessage(finalTriageResponse, finalTriageStderr),
            usage: mergeUsage(triageInvoke.response.usage, triageRetry?.response.usage),
            safety: finalTriageResponse.safety ?? null,
        };
    }

    const resultPath = resolve(options.out ?? join(tmpdir(), `aca-consult-result-${suffix}.json`));
    mkdirSync(dirname(resultPath), { recursive: true });
    const result: ConsultResult = {
        mode: 'context_request',
        success_count: successCount,
        total_witnesses: witnesses.length,
        degraded: successCount !== witnesses.length || triage.status === 'error' || sharedContext?.status === 'error',
        result_path: resultPath,
        ...(pack ? { evidence_pack_summary: pack.summary } : {}),
        ...(sharedContext ? {
            shared_context: {
                status: sharedContext.status,
                model: sharedContext.model,
                request_path: sharedContext.request_path,
                error: sharedContext.error,
                usage: sharedContext.usage,
                safety: sharedContext.safety,
                context_requests: sharedContext.context_requests,
                context_snippets: sharedContext.context_snippets,
            },
        } : {}),
        witnesses: witnessResults,
        triage,
    };
    writeFileSync(resultPath, JSON.stringify(result, null, 2));
    return result;
}
