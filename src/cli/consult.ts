import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { appendEvidencePack, buildEvidencePack, type EvidencePackSummary } from '../consult/evidence-pack.js';
import {
    appendSharedContextPack,
    buildContextRequestPrompt,
    buildContextRequestRetryPrompt,
    buildFinalizationPrompt,
    buildFinalizationRetryPrompt,
    buildSharedContextRequestPrompt,
    containsProtocolEnvelopeJson,
    containsPseudoToolCall,
    fulfillContextRequests,
    parseContextRequests,
    truncateUtf8,
    type ContextSnippet,
} from '../consult/context-request.js';
import { WITNESS_MODELS, type WitnessModelConfig } from '../config/witness-models.js';
import { parseInvokeOutput, runAcaInvoke } from '../mcp/server.js';
import type { InvokeResponse, InvokeSafety, InvokeSystemMessage, InvokeUsage } from './executor.js';
import type { ModelResponseFormat } from '../types/provider.js';

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
    triage_input_path: string | null;
    usage: InvokeUsage | null;
    safety: InvokeSafety | {
        context_request?: InvokeSafety;
        context_request_retry?: InvokeSafety;
        final?: InvokeSafety;
        final_retry?: InvokeSafety;
    } | null;
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
        raw_path: string | null;
        error: string | null;
        usage: InvokeUsage | null;
        safety: InvokeSafety | null;
    };
}

const TRIAGE_MODEL = 'zai-org/glm-5';
const TRIAGE_MODEL_CANDIDATES = [
    TRIAGE_MODEL,
    'moonshotai/kimi-k2.5',
    'qwen/qwen3-coder-next',
] as const;
const DEFAULT_SHARED_CONTEXT_SNIPPETS = 8;
const DEFAULT_SHARED_CONTEXT_LINES = 160;
const DEFAULT_SHARED_CONTEXT_BYTES = 16_000;
const REQUIRED_TRIAGE_SECTIONS = [
    'consensus findings',
    'dissent',
    'likely false positives',
    'open questions',
] as const;

const CONTEXT_SNIPPET_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        path: { type: 'string' },
        line_start: { type: 'number' },
        line_end: { type: 'number' },
        reason: { type: 'string' },
    },
    required: ['path', 'line_start', 'line_end', 'reason'],
    additionalProperties: false,
};

const SHARED_CONTEXT_RESPONSE_FORMAT: ModelResponseFormat = {
    type: 'json_schema',
    json_schema: {
        name: 'aca_shared_raw_context_ranges',
        strict: true,
        schema: {
            type: 'object',
            properties: {
                needs_context: {
                    type: 'array',
                    items: CONTEXT_SNIPPET_SCHEMA,
                },
            },
            required: ['needs_context'],
            additionalProperties: false,
        },
    },
};

function parseList(raw: string | undefined): string[] {
    return (raw ?? '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function uniqueModels(models: Array<string | null | undefined>): string[] {
    return [...new Set(models.filter((model): model is string => typeof model === 'string' && model.trim() !== ''))];
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

function isUnavailableModelFailure(response: InvokeResponse, stderr: string): boolean {
    if (response.errors?.some(error => error.code === 'protocol.invalid_model')) return true;
    const message = [
        stderr,
        response.result ?? '',
        ...(response.errors?.map(error => `${error.code}: ${error.message}`) ?? []),
    ].join('\n').toLowerCase();
    return message.includes('unknown model')
        || message.includes('unsupported model')
        || message.includes('model not found');
}

function extractJsonPayload(text: string): string {
    const stripped = text.trim();
    if (stripped.startsWith('{')) return stripped;
    const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) return stripped.slice(start, end + 1);
    return stripped;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(extractJsonPayload(text)) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Prompt-only fallback remains below for models that do not support response_format.
    }
    return null;
}

function extractMarkdownField(text: string): string | null {
    const parsed = parseJsonObject(text);
    if (typeof parsed?.markdown === 'string' && parsed.markdown.trim() !== '') return parsed.markdown;
    if (parsed?.action === 'final' && typeof parsed.findings_markdown === 'string' && parsed.findings_markdown.trim() !== '') {
        return parsed.findings_markdown;
    }
    return null;
}

function extractFirstPassFinalMarkdown(text: string): string | null {
    const parsed = parseJsonObject(text);
    if (parsed?.action !== 'final') return null;
    return typeof parsed.findings_markdown === 'string' && parsed.findings_markdown.trim() !== ''
        ? parsed.findings_markdown
        : null;
}

function extractPlainMarkdownReport(text: string): string | null {
    if (text.trim() === '') return null;
    if (parseJsonObject(text)) return null;
    return text;
}

function containsEmptyStructuredFinal(text: string): boolean {
    const parsed = parseJsonObject(text);
    return parsed?.action === 'final'
        && typeof parsed.findings_markdown === 'string'
        && parsed.findings_markdown.trim() === '';
}

type WitnessFirstPassClassification =
    | { status: 'report'; report: string }
    | { status: 'needs_context'; requests: ReturnType<typeof parseContextRequests> }
    | { status: 'invalid'; error: string; retryable: boolean };

function classifyWitnessFirstPass(
    text: string,
    limits: { maxContextSnippets: number; maxContextLines: number; maxContextBytes: number },
): WitnessFirstPassClassification {
    if (containsPseudoToolCall(text)) {
        return {
            status: 'invalid',
            error: 'pseudo-tool call emitted in no-tools context-request pass',
            retryable: false,
        };
    }

    const firstPassMarkdown = extractFirstPassFinalMarkdown(text);
    if (firstPassMarkdown !== null) return { status: 'report', report: firstPassMarkdown };

    if (containsEmptyStructuredFinal(text)) {
        return {
            status: 'invalid',
            error: 'empty final report emitted in no-tools context-request pass',
            retryable: true,
        };
    }

    const requests = parseContextRequests(text, {
        maxSnippets: limits.maxContextSnippets,
        maxLines: limits.maxContextLines,
        maxBytes: limits.maxContextBytes,
    });
    if (requests.length > 0) return { status: 'needs_context', requests };

    const plainReport = extractPlainMarkdownReport(text);
    if (plainReport && !containsProtocolEnvelopeJson(text)) {
        return { status: 'report', report: plainReport };
    }

    return {
        status: 'invalid',
        error: 'non-report output emitted in no-tools context-request pass',
        retryable: true,
    };
}

type WitnessFinalClassification =
    | { status: 'report'; report: string }
    | { status: 'invalid'; error: string; retryable: boolean };

function classifyWitnessFinal(text: string): WitnessFinalClassification {
    const finalMarkdown = extractMarkdownField(text);
    if (finalMarkdown !== null) return { status: 'report', report: finalMarkdown };

    if (containsEmptyStructuredFinal(text)) {
        return {
            status: 'invalid',
            error: 'empty final report emitted in no-tools finalization pass',
            retryable: true,
        };
    }

    const plainReport = extractPlainMarkdownReport(text);
    if (plainReport !== null) return { status: 'report', report: plainReport };

    if (containsPseudoToolCall(text)) {
        return {
            status: 'invalid',
            error: 'tool/context-request shaped output emitted in no-tools finalization pass',
            retryable: false,
        };
    }

    if (containsProtocolEnvelopeJson(text)) {
        return {
            status: 'invalid',
            error: 'tool/context-request shaped output emitted in no-tools finalization pass',
            retryable: true,
        };
    }

    return {
        status: 'invalid',
        error: 'empty or non-report output emitted in no-tools finalization pass',
        retryable: true,
    };
}

function hasBalancedMarkdownBackticks(text: string): boolean {
    const runCounts = new Map<number, number>();
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== '`') continue;
        let end = index;
        while (end < text.length && text[end] === '`') end += 1;
        const runLength = end - index;
        runCounts.set(runLength, (runCounts.get(runLength) ?? 0) + 1);
        index = end - 1;
    }
    return [...runCounts.values()].every(count => count % 2 === 0);
}

function validateTriageReport(text: string): { report: string | null; errors: string[] } {
    const report = extractMarkdownField(text) ?? extractPlainMarkdownReport(text);
    if (report === null) {
        return { report: null, errors: ['empty or non-report output emitted in no-tools triage pass'] };
    }

    const errors: string[] = [];
    const missingSections = REQUIRED_TRIAGE_SECTIONS.filter(section => {
        const pattern = new RegExp(`\\b${section.replaceAll(' ', '\\s+')}\\b`, 'i');
        return !pattern.test(report);
    });
    if (missingSections.length > 0) {
        errors.push(`missing required triage sections: ${missingSections.join(', ')}`);
    }
    if (!hasBalancedMarkdownBackticks(report)) {
        errors.push('unbalanced Markdown code delimiters in triage report');
    }

    return { report, errors };
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

function buildNoToolsConsultSystemMessages(mode: 'witness' | 'shared_context' | 'triage'): InvokeSystemMessage[] {
    const modeInstruction = mode === 'shared_context'
        ? 'You are the shared raw evidence scout. Select raw snippets only. Do not produce review findings.'
        : mode === 'triage'
            ? 'You are the triage pass. Aggregate only the supplied witness evidence. Do not perform a fresh review.'
            : 'You are a witness review pass. Review the supplied task and context only.';
    return [{
        role: 'system',
        content: `You are running a bounded ACA consult pass, not the normal autonomous ACA invoke workflow.
Tools are unavailable for this request.
Do not call tools, ask to call tools, emit tool-call JSON, or emit XML/function markup such as <tool_call>, <call>, <function_calls>, or <invoke>.
Follow the user prompt's protocol exactly.
If the prompt asks for Markdown, return Markdown only.
If the prompt asks for JSON, return JSON only.
If more context is needed, use only the exact request format described in the prompt.
Do not add extra wrappers, agent narration, or next-step instructions outside the requested output.
${modeInstruction}`,
    }];
}

async function invoke(model: string, prompt: string, projectDir: string, options: {
    maxSteps: number;
    maxTotalTokens: number;
    outPath?: string;
    responseFormat?: ModelResponseFormat;
    systemMessages?: InvokeSystemMessage[];
}): Promise<{ response: InvokeResponse; stderr: string }> {
    const result = await runAcaInvoke(prompt, {
        model,
        allowedTools: [],
        maxSteps: options.maxSteps,
        maxToolCalls: 1,
        maxTotalTokens: options.maxTotalTokens,
        responseFormat: options.responseFormat,
        systemMessages: options.systemMessages,
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

async function invokeWithFallbackModels(models: string[], prompt: string, projectDir: string, options: {
    maxSteps: number;
    maxTotalTokens: number;
    outPath?: string;
    responseFormat?: ModelResponseFormat;
    systemMessages?: InvokeSystemMessage[];
}): Promise<{ response: InvokeResponse; stderr: string; model: string }> {
    const candidates = uniqueModels(models);
    if (candidates.length === 0) {
        throw new Error('no candidate models provided for consult invoke');
    }
    let lastAttempt: { response: InvokeResponse; stderr: string; model: string } | null = null;
    for (const model of candidates) {
        const attempt = await invoke(model, prompt, projectDir, options);
        const enriched = { ...attempt, model };
        if (attempt.response.status === 'success' || !isUnavailableModelFailure(attempt.response, attempt.stderr)) {
            return enriched;
        }
        lastAttempt = enriched;
    }
    return lastAttempt!;
}

async function runWitness(witness: WitnessModelConfig, prompt: string, projectDir: string, suffix: string, limits: {
    maxContextSnippets: number;
    maxContextLines: number;
    maxContextBytes: number;
}): Promise<WitnessResult> {
    const responsePath = join(tmpdir(), `aca-consult-${witness.name}-response-${suffix}.md`);
    const requestPath = join(tmpdir(), `aca-consult-${witness.name}-context-request-${suffix}.md`);
    const finalRawPath = join(tmpdir(), `aca-consult-${witness.name}-final-raw-${suffix}.md`);
    const firstPrompt = buildContextRequestPrompt(prompt, {
        maxSnippets: limits.maxContextSnippets,
        maxLines: limits.maxContextLines,
        maxBytes: limits.maxContextBytes,
    });
    const firstAttempt = await invoke(witness.model, firstPrompt, projectDir, {
        maxSteps: 1,
        maxTotalTokens: 30_000,
        outPath: requestPath,
        systemMessages: buildNoToolsConsultSystemMessages('witness'),
    });
    const first = firstAttempt;
    if (first.response.status !== 'success') {
        return {
            name: witness.name,
            model: witness.model,
            status: 'error',
            error: errorMessage(first.response, first.stderr),
            response_path: null,
            raw_request_path: requestPath,
            triage_input_path: null,
            usage: usageOrNull(first.response),
            safety: first.response.safety ?? null,
            context_requests: [],
            context_snippets: [],
        };
    }
    const firstClassification = classifyWitnessFirstPass(first.response.result ?? '', limits);
    let firstRetry: { response: InvokeResponse; stderr: string } | null = null;
    let effectiveFirst = first.response;
    if (firstClassification.status === 'invalid' && firstClassification.retryable) {
        firstRetry = await invoke(
            witness.model,
            buildContextRequestRetryPrompt(prompt, first.response.result ?? '', {
                maxSnippets: limits.maxContextSnippets,
                maxLines: limits.maxContextLines,
                maxBytes: limits.maxContextBytes,
            }),
            projectDir,
            {
                maxSteps: 1,
                maxTotalTokens: 30_000,
                systemMessages: buildNoToolsConsultSystemMessages('witness'),
            },
        );
        const retryClassification = firstRetry.response.status === 'success'
            ? classifyWitnessFirstPass(firstRetry.response.result ?? '', limits)
            : null;
        if (retryClassification?.status === 'report' || retryClassification?.status === 'needs_context') {
            effectiveFirst = firstRetry.response;
        }
    }

    const effectiveFirstClassification = classifyWitnessFirstPass(effectiveFirst.result ?? '', limits);
    if (effectiveFirstClassification.status === 'invalid') {
        const firstPassError = firstClassification.status === 'invalid'
            ? firstClassification.error
            : effectiveFirstClassification.error;
        return {
            name: witness.name,
            model: witness.model,
            status: 'error',
            error: firstPassError,
            response_path: null,
            raw_request_path: requestPath,
            triage_input_path: requestPath,
            usage: mergeUsage(first.response.usage, firstRetry?.response.usage),
            safety: {
                context_request: first.response.safety,
                context_request_retry: firstRetry?.response.safety,
            },
            context_requests: [],
            context_snippets: [],
        };
    }

    if (effectiveFirstClassification.status === 'report') {
        writeFileSync(responsePath, effectiveFirstClassification.report);
        return {
            name: witness.name,
            model: witness.model,
            status: 'ok',
            error: null,
            response_path: responsePath,
            raw_request_path: requestPath,
            triage_input_path: responsePath,
            usage: mergeUsage(first.response.usage, firstRetry?.response.usage),
            safety: {
                context_request: first.response.safety,
                context_request_retry: firstRetry?.response.safety,
            },
            context_requests: [],
            context_snippets: [],
        };
    }

    const requests = effectiveFirstClassification.requests;

    const snippets = fulfillContextRequests(requests, projectDir, {
        maxSnippets: limits.maxContextSnippets,
        maxLines: limits.maxContextLines,
        maxBytes: limits.maxContextBytes,
    });
    const finalPrompt = buildFinalizationPrompt(prompt, effectiveFirst.result ?? '', snippets);
    const final = await invoke(witness.model, finalPrompt, projectDir, {
        maxSteps: 1,
        maxTotalTokens: 30_000,
        outPath: finalRawPath,
        systemMessages: buildNoToolsConsultSystemMessages('witness'),
    });
    const finalResponse = final.response;
    const finalClassification = finalResponse.status === 'success'
        ? classifyWitnessFinal(finalResponse.result ?? '')
        : null;
    let finalRetry: { response: InvokeResponse; stderr: string } | null = null;
    let effectiveFinalClassification = finalClassification;
    if (finalResponse.status === 'success' && finalClassification?.status === 'invalid' && finalClassification.retryable) {
        finalRetry = await invoke(
            witness.model,
            buildFinalizationRetryPrompt(prompt, effectiveFirst.result ?? '', snippets, finalResponse.result ?? ''),
            projectDir,
            {
                maxSteps: 1,
                maxTotalTokens: 30_000,
                systemMessages: buildNoToolsConsultSystemMessages('witness'),
            },
        );
        if (finalRetry.response.status === 'success') {
            const retryClassification = classifyWitnessFinal(finalRetry.response.result ?? '');
            if (retryClassification.status === 'report') {
                effectiveFinalClassification = retryClassification;
                writeFileSync(responsePath, retryClassification.report);
            }
        }
    } else if (finalResponse.status === 'success' && finalClassification?.status === 'report') {
        writeFileSync(responsePath, finalClassification.report);
    }

    const finalSucceeded = finalResponse.status === 'success'
        && effectiveFinalClassification?.status === 'report';
    return {
        name: witness.name,
        model: witness.model,
        status: finalSucceeded ? 'ok' : 'error',
        error: finalSucceeded
            ? null
            : finalResponse.status === 'success'
            ? (finalClassification?.status === 'invalid' ? finalClassification.error : null)
            : errorMessage(finalResponse, final.stderr),
        response_path: finalSucceeded ? responsePath : null,
        raw_request_path: requestPath,
        triage_input_path: finalResponse.result ? (finalSucceeded ? responsePath : finalRawPath) : null,
        usage: mergeUsage(first.response.usage, firstRetry?.response.usage, final.response.usage, finalRetry?.response.usage),
        safety: {
            context_request: first.response.safety,
            context_request_retry: firstRetry?.response.safety,
            final: final.response.safety,
            final_retry: finalRetry?.response.safety,
        },
        context_requests: requests,
        context_snippets: snippets.map(({ text: _text, ...snippet }) => snippet),
    };
}

async function buildSharedContext(prompt: string, projectDir: string, suffix: string, options: {
    models: string[];
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
    const scout = await invokeWithFallbackModels(options.models, scoutPrompt, projectDir, {
        maxSteps: 1,
        maxTotalTokens: 30_000,
        outPath: requestPath,
        responseFormat: SHARED_CONTEXT_RESPONSE_FORMAT,
        systemMessages: buildNoToolsConsultSystemMessages('shared_context'),
    });

    if (scout.response.status !== 'success') {
        return {
            status: 'error',
            model: scout.model,
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
            model: scout.model,
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
        model: scout.model,
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
        const body = result.triage_input_path
            ? readFileSync(result.triage_input_path, 'utf8')
            : `(no witness output captured: ${result.error ?? 'unknown failure'})`;
        const status = result.status === 'ok'
            ? 'ok'
            : `degraded (${result.error ?? 'unknown failure'})`;
        return `## ${result.name} (${result.model})\n\nStatus: ${status}\n\n${body}`;
    }).join('\n\n---\n\n');
    return `# ACA Consult Triage

You are an aggregation-only triage pass. Tools are disabled.
The witness reports below are your only evidence. Do not do a fresh code review.
Do not request files, list directories, call tools, or emit XML/function/tool markup such as <call>, <tool_call>, <function_calls>, or <invoke>.
Do not quote or reproduce literal pseudo-tool markup from witness reports; refer to it generically as pseudo-tool-call markup.
If evidence is missing, mark it as an open question instead of trying to fetch more context.
Some witness sections may contain degraded raw output captured before ACA could normalize it into a clean report. Treat those sections as weak evidence, note uncertainty, and do not over-index on malformed markup.
Do not promote claims based only on missing-file errors, ENOENT snippets, or "not present in the provided evidence" language into consensus findings. Keep those as open questions or likely false positives unless a witness cites positive source evidence.

Return a concise Markdown report with:
- consensus findings
- dissent
- likely false positives
- open questions

If ACA enforces structured output for this request, put the Markdown report in the "markdown" field.

${sections}
`;
}

function buildTriageRetryPrompt(witnesses: Record<string, WitnessResult>, invalidResponse: string, reasons: string[]): string {
    const problems = reasons.map(reason => `- ${reason}`).join('\n');
    return `${buildTriagePrompt(witnesses)}

## Invalid Previous Triage Response

Your previous triage response was incomplete or malformed for ACA post-processing.

Detected problems:
${problems}

\`\`\`text
${truncateUtf8(invalidResponse, 4_000)}
\`\`\`

Retry the triage now.
Return complete Markdown with all four sections:
- Consensus Findings
- Dissent
- Likely False Positives
- Open Questions

Do not quote literal pseudo-tool markup such as <invoke> or <tool_call>; describe it generically instead.
Do not end mid-sentence or with unbalanced Markdown delimiters.
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
            models: options.sharedContextModel
                ? [options.sharedContextModel]
                : [...TRIAGE_MODEL_CANDIDATES],
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
    const triageableCount = Object.values(witnessResults).filter(result => result.triage_input_path !== null).length;

    let triage: ConsultResult['triage'] = {
        status: 'skipped',
        model: null,
        path: null,
        raw_path: null,
        error: options.skipTriage ? 'skipped by --skip-triage' : 'no triageable witness evidence',
        usage: null,
        safety: null,
    };
    if (!options.skipTriage && triageableCount > 0) {
        const triagePath = join(tmpdir(), `aca-consult-triage-${suffix}.md`);
        const triageRawPath = join(tmpdir(), `aca-consult-triage-raw-${suffix}.md`);
        const triageInvoke = await invokeWithFallbackModels([...TRIAGE_MODEL_CANDIDATES], buildTriagePrompt(witnessResults), projectDir, {
            maxSteps: 1,
            maxTotalTokens: 30_000,
            outPath: triageRawPath,
            systemMessages: buildNoToolsConsultSystemMessages('triage'),
        });
        const firstTriageValidation = validateTriageReport(triageInvoke.response.result ?? '');
        const firstTriagePseudoToolCall = containsPseudoToolCall(firstTriageValidation.report ?? triageInvoke.response.result ?? '');
        const triageRetry = triageInvoke.response.status === 'success'
            && (firstTriagePseudoToolCall || firstTriageValidation.errors.length > 0)
            ? await invokeWithFallbackModels(
                [triageInvoke.model],
                buildTriageRetryPrompt(
                    witnessResults,
                    triageInvoke.response.result ?? '',
                    firstTriagePseudoToolCall
                        ? ['pseudo-tool call emitted in no-tools triage pass', ...firstTriageValidation.errors]
                        : firstTriageValidation.errors,
                ),
                projectDir,
                {
                    maxSteps: 1,
                    maxTotalTokens: 30_000,
                    systemMessages: buildNoToolsConsultSystemMessages('triage'),
                },
            )
            : null;
        const finalTriageResponse = triageRetry?.response ?? triageInvoke.response;
        const finalTriageStderr = triageRetry?.stderr ?? triageInvoke.stderr;
        const finalTriageValidation = validateTriageReport(finalTriageResponse.result ?? '');
        const finalTriagePseudoToolCall = containsPseudoToolCall(finalTriageValidation.report ?? finalTriageResponse.result ?? '');
        const finalTriageErrors = finalTriagePseudoToolCall
            ? ['pseudo-tool call emitted in no-tools triage pass', ...finalTriageValidation.errors]
            : finalTriageValidation.errors;
        if (finalTriageResponse.status === 'success' && !finalTriagePseudoToolCall && finalTriageValidation.report !== null && finalTriageErrors.length === 0) {
            writeFileSync(triagePath, finalTriageValidation.report);
        }
        triage = {
            status: finalTriageResponse.status === 'success' && !finalTriagePseudoToolCall && finalTriageValidation.report !== null && finalTriageErrors.length === 0 ? 'ok' : 'error',
            model: triageRetry?.model ?? triageInvoke.model,
            path: finalTriageResponse.status === 'success' && !finalTriagePseudoToolCall && finalTriageValidation.report !== null && finalTriageErrors.length === 0 ? triagePath : null,
            raw_path: triageInvoke.response.result ? triageRawPath : null,
            error: finalTriageResponse.status === 'success'
                ? (finalTriageErrors.length > 0 ? finalTriageErrors.join('; ') : null)
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
