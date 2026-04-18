import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { sanitizeModelJson } from '../providers/tool-emulation.js';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { appendEvidencePack, buildEvidencePack, type EvidencePackSummary } from '../consult/evidence-pack.js';
import {
    buildAdvisoryEmptyResponseLastChancePrompt,
    buildAdvisoryEmptyResponseRetryPrompt,
    annotateContextRequestsWithGrounding,
    appendSharedContextPack,
    buildAdvisoryWitnessLastChancePrompt,
    buildAdvisoryWitnessPrompt,
    buildContextRequestPrompt,
    buildContextRequestRetryPrompt,
    buildAdvisoryContextRequestRetryPrompt,
    buildContinuationPrompt,
    buildFinalizationPrompt,
    buildFinalizationLastChancePrompt,
    buildFinalizationRetryPrompt,
    buildSharedContextContinuationPrompt,
    buildSharedContextRequestPrompt,
    containsProtocolEnvelopeJson,
    containsPseudoToolCall,
    extractPromptGroundedFileSources,
    fulfillContextRequests,
    inspectContextRequests,
    parseContextRequests,
    stripBlockquoteMarkers,
    truncateUtf8,
    type ContextProvenance,
    type ContextRequestDiagnostic,
    type ContextRequest,
    type ContextRequestLimits,
    type ContextSnippet,
} from '../consult/context-request.js';
import { WITNESS_MODELS, type WitnessModelConfig } from '../config/witness-models.js';
import { parseInvokeOutput, runAcaInvoke } from '../mcp/server.js';
import type { InvokeResponse, InvokeSafety, InvokeSystemMessage, InvokeUsage } from './executor.js';
import type { ModelResponseFormat } from '../types/provider.js';
import { extractFindingsFromMarkdown } from '../review/markdown-adapter.js';
import { aggregateReviews } from '../review/aggregator.js';
import { buildReport, renderReportText } from '../review/report.js';
import { NO_NATIVE_FUNCTION_CALLING, NO_PROTOCOL_DELIBERATION } from '../prompts/prompt-guardrails.js';
import { extractCodeIdentifiers, resolveSymbolLocations } from '../consult/symbol-lookup.js';
import { obfuscateIdentifiers } from '../consult/identifier-obfuscation.js';
import { getModelHints } from '../prompts/model-hints.js';

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
    maxContextRounds?: number;
    sharedContext?: boolean;
    sharedContextModel?: string;
    sharedContextMaxSnippets?: number;
    sharedContextMaxLines?: number;
    sharedContextMaxBytes?: number;
    triage?: 'auto' | 'always' | 'never';
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
        final_last_chance?: InvokeSafety;
    } | null;
    context_attempt_diagnostics: WitnessContextAttemptDiagnostic[];
    finalization_diagnostics: FinalizationAttemptDiagnostic[];
    context_requests: ReturnType<typeof parseContextRequests>;
    context_request_diagnostics: ContextRequestDiagnostic[];
    context_snippets: Omit<ContextSnippet, 'text'>[];
}

interface WitnessContextAttemptDiagnostic {
    stage: 'initial' | 'initial_retry' | 'initial_last_chance' | 'continuation' | 'continuation_retry';
    round: number;
    outcome: 'report' | 'requests' | 'invalid' | 'invoke_error';
    error: string | null;
    request_count: number;
    diagnostic_count: number;
}

interface FinalizationAttemptDiagnostic {
    stage: 'final' | 'final_retry' | 'final_last_chance' | 'fallback';
    outcome: 'report' | 'invalid' | 'invoke_error' | 'generated';
    error: string | null;
    report_source?: 'markdown' | 'salvaged_structured';
}

interface SharedContextAttemptDiagnostic {
    stage: 'initial' | 'continuation';
    outcome: 'requests' | 'no_requests' | 'invalid' | 'invoke_error';
    error: string | null;
    request_count: number;
    diagnostic_count: number;
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
        triage_input_path: string | null;
        error: string | null;
        usage: InvokeUsage | null;
        safety: InvokeSafety | {
            context_request?: InvokeSafety;
            extra_rounds?: Array<{ context_request?: InvokeSafety }>;
        } | null;
        scout_attempt_diagnostics: SharedContextAttemptDiagnostic[];
        provenance_summary: string[];
        context_requests: ReturnType<typeof parseContextRequests>;
        context_request_diagnostics: ContextRequestDiagnostic[];
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
    structured_review: {
        status: 'ok';
        path: string;
        json_path: string;
        cluster_count: number;
        finding_count: number;
        disagreement_count: number;
    } | {
        status: 'error';
        error: string;
    } | null;
}

const TRIAGE_MODEL = 'zai-org/glm-5';
const TRIAGE_MODEL_CANDIDATES = [
    TRIAGE_MODEL,
    'moonshotai/kimi-k2.5',
] as const;
const DEFAULT_SHARED_CONTEXT_SNIPPETS = 8;
const DEFAULT_SHARED_CONTEXT_LINES = 160;
const DEFAULT_SHARED_CONTEXT_BYTES = 16_000;
const DEFAULT_CONSULT_WITNESS_NAMES = ['minimax', 'qwen'] as const;
const STRICT_ADVISORY_WITNESS_NAMES = new Set<string>(['minimax']);
const REQUIRED_TRIAGE_SECTIONS = [
    'consensus findings',
    'dissent',
    'likely false positives',
    'open questions',
] as const;
type ConsultTaskMode = 'review' | 'advisory';
type ConsultTriageMode = 'auto' | 'always' | 'never';

type AdvisoryWitnessClassification =
    | { status: 'report'; report: string }
    | { status: 'invalid'; error: string; retryable: boolean };

const CONTEXT_SNIPPET_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        type: { type: 'string', enum: ['file', 'tree'] },
        path: { type: 'string' },
        line_start: { type: 'number' },
        line_end: { type: 'number' },
        reason: { type: 'string' },
    },
    required: ['type', 'path', 'reason'],
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
    if (names.length === 0 || names.includes('default')) {
        return DEFAULT_CONSULT_WITNESS_NAMES.map(name => {
            const witness = WITNESS_MODELS.find(item => item.name === name);
            if (!witness) throw new Error(`unknown default witness: ${name}`);
            return witness;
        });
    }
    if (names.includes('all')) return [...WITNESS_MODELS];
    const selected: WitnessModelConfig[] = [];
    for (const name of names) {
        const canonicalName = name === 'deepseek' ? 'minimax' : name;
        const witness = WITNESS_MODELS.find(item => item.name === canonicalName);
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

function isEmptyInvokeErrorMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes('llm.empty')
        || normalized.includes('empty response')
        || normalized.includes('returned no text');
}

function hasExplicitAnswerFormat(taskText: string): boolean {
    return /\b(?:answer|respond|reply)\s+with\s+exactly\b/i.test(taskText)
        || /\bexactly\s*:\s*/i.test(taskText)
        || /\b(?:answer|respond|reply)\s+with\s+only\b/i.test(taskText)
        || /\bone sentence\b/i.test(taskText)
        || /\bone word\b/i.test(taskText);
}

function usesStrictAdvisoryRubric(witness: Pick<WitnessModelConfig, 'name' | 'model'>, taskText: string): boolean {
    if (hasExplicitAnswerFormat(taskText)) return false;
    return STRICT_ADVISORY_WITNESS_NAMES.has(witness.name)
        || witness.model.toLowerCase().includes('minimax/');
}

function resolveTriageMode(options: ConsultOptions): ConsultTriageMode {
    if (options.skipTriage) return 'never';
    const requested = options.triage ?? 'auto';
    if (requested === 'auto' || requested === 'always' || requested === 'never') return requested;
    throw new Error(`invalid triage mode: ${requested}`);
}

function shouldRunTriage(
    triageMode: ConsultTriageMode,
    triageableCount: number,
    witnessResults: Record<string, WitnessResult>,
    sharedContext: ConsultResult['shared_context'] | undefined,
    structuredReview: ConsultResult['structured_review'],
): boolean {
    if (triageMode === 'never' || triageableCount === 0) return false;
    if (triageMode === 'always') return true;

    const anyWitnessError = Object.values(witnessResults).some(result => result.status !== 'ok');
    const sharedContextError = sharedContext?.status === 'error';
    const structuredReviewNeedsJudge = structuredReview?.status === 'error'
        || (structuredReview?.status === 'ok' && structuredReview.disagreement_count > 0);
    return anyWitnessError || sharedContextError || structuredReviewNeedsJudge;
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
    // Blank out inline-code spans before scanning so braces inside backtick
    // literals (e.g. `Record<K,V> = {}`) don't fool the heuristic.  Spaces
    // preserve character positions so the slice below uses the original text.
    const searchable = stripped.replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));
    const start = searchable.indexOf('{');
    const end = searchable.lastIndexOf('}');
    if (start >= 0 && end > start) return stripped.slice(start, end + 1);
    return stripped;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(sanitizeModelJson(extractJsonPayload(text))) as unknown;
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

function extractSalvageableFinalReport(text: string): string | null {
    const parsed = parseJsonObject(text);
    if (!parsed || containsProtocolEnvelopeJson(text)) return null;

    const findings = collectStructuredReportLines(parsed, ['findings', 'issues', 'summary', 'observations', 'concerns']);
    const openQuestions = collectStructuredReportLines(parsed, ['open_questions', 'openQuestions', 'questions', 'unknowns']);
    if (findings.length === 0 && openQuestions.length === 0) return null;

    const findingLines = findings.length > 0 ? findings : ['No grounded findings.'];
    const questionLines = openQuestions.length > 0 ? openQuestions : ['None.'];

    return [
        '_ACA reformatted malformed structured finalization output into Markdown._',
        '',
        '## Findings',
        ...findingLines.map(line => `- ${line}`),
        '',
        '## Open Questions',
        ...questionLines.map(line => `- ${line}`),
    ].join('\n');
}

function collectStructuredReportLines(
    parsed: Record<string, unknown>,
    keys: string[],
): string[] {
    for (const key of keys) {
        const value = parsed[key];
        const lines = structuredValueToLines(value);
        if (lines.length > 0) return lines;
    }
    return [];
}

function structuredValueToLines(value: unknown, depth = 0): string[] {
    if (depth > 2) return [];
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed === '' ? [] : [trimmed];
    }
    if (Array.isArray(value)) {
        return value.flatMap(item => structuredValueToLines(item, depth + 1));
    }
    if (typeof value !== 'object' || value === null) return [];

    const objectValue = value as Record<string, unknown>;
    const pairedLine = combineStructuredReportFields(objectValue);
    if (pairedLine !== null) return [pairedLine];

    for (const key of ['text', 'message', 'content', 'finding', 'issue', 'question', 'summary']) {
        const lines = structuredValueToLines(objectValue[key], depth + 1);
        if (lines.length > 0) return lines;
    }

    return [];
}

function combineStructuredReportFields(value: Record<string, unknown>): string | null {
    const title = firstStructuredScalar(value, ['title', 'label', 'name']);
    const detail = firstStructuredScalar(value, ['detail', 'details', 'explanation', 'reason', 'message', 'content', 'question']);
    if (title && detail) return `${title}: ${detail}`;
    return null;
}

function firstStructuredScalar(
    value: Record<string, unknown>,
    keys: string[],
): string | null {
    for (const key of keys) {
        const candidate = value[key];
        if (typeof candidate !== 'string') continue;
        const trimmed = candidate.trim();
        if (trimmed !== '') return trimmed;
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

function containsPromptReflectionLeak(text: string): boolean {
    const strongSignals = [
        /\banalyze the request\b/i,
        /\bdetermine the content\b/i,
        /\bdraft the response\b/i,
        /\brefine for constraints\b/i,
        /\bfinal review against constraints\b/i,
        /\bdo not show reasoning process\b/i,
        /\bdo not wrap output in blockquote syntax\b/i,
        /\boutput only:\s*(?:the )?`needs_context` json object\b/i,
    ];
    if (strongSignals.some(pattern => pattern.test(text))) return true;

    const weakSignals = [
        /\btask type:\b/i,
        /\breview rules:\b/i,
        /\bconstraints:\b/i,
        /\bthe prompt says\b/i,
        /\bi will output\b/i,
        /\bone more check\b/i,
        /\blet'?s write it\b/i,
    ];
    const weakMatches = weakSignals.filter(pattern => pattern.test(text)).length;
    return weakMatches >= 2;
}

function inferConsultTaskMode(taskText: string): ConsultTaskMode {
    const text = taskText.toLowerCase();
    const trimmed = taskText.trim();
    const reviewSignal = /\b(review|audit|bug|issue|problem|regression|fix|broken|failure|error|failing|crash|vulnerability|repo|repository|code|implementation|function|class|method|file|path|line|lines|snippet|test|tests|config|schema|protocol|pipeline|api|cli|context-request|shared-context)\b/.test(text)
        || /(?:^|[\s`(])(?:src|test|docs|scripts|package\.json|tsconfig\.json|vitest\.config\.ts|plan\.md)\b/.test(text)
        || /[A-Za-z0-9_/.-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|py|sh)\b/.test(text);
    if (reviewSignal) return 'review';
    if (hasExplicitAnswerFormat(taskText)) return 'advisory';
    const advisorySignal = /\b(manager|management|leadership|executive|operations|operational|capacity|planning|workload|template|framework|strategy|process|policy|governance|staffing|roadmap|prioritization|trade-?off|false precision)\b/.test(text);
    if (advisorySignal) return 'advisory';
    const questionLike = trimmed.endsWith('?')
        || /^(how|what|why|when|where|who|should|could|would|can|do|does|is|are)\b/i.test(trimmed);
    return questionLike ? 'advisory' : 'review';
}

function isLowValueAdvisoryReport(report: string, taskMode: ConsultTaskMode): boolean {
    if (taskMode !== 'advisory') return false;
    const normalized = report
        .toLowerCase()
        .replace(/[`*_>#-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (normalized === '') return true;
    const wordCount = normalized.split(' ').filter(Boolean).length;
    if (wordCount > 8) return false;
    return /^no (bug|bugs|issue|issues|problem|problems|finding|findings|grounded findings) found\.?$/.test(normalized)
        || normalized === 'no bug found.'
        || normalized === 'no bug found'
        || normalized === 'no issues found.'
        || normalized === 'no issues found';
}

function advisoryWordCount(text: string): number {
    return text
        .replace(/[`*_>#-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .length;
}

function parseMarkdownH2Sections(report: string): Map<string, string> {
    const sections = new Map<string, string>();
    const matches = [...report.matchAll(/^##\s+(.+?)\s*$/gm)];
    if (matches.length === 0) return sections;
    for (let index = 0; index < matches.length; index += 1) {
        const heading = matches[index][1].trim().toLowerCase();
        const bodyStart = matches[index].index! + matches[index][0].length;
        const bodyEnd = index + 1 < matches.length ? matches[index + 1].index! : report.length;
        sections.set(heading, report.slice(bodyStart, bodyEnd).trim());
    }
    return sections;
}

function advisoryQualityError(report: string, strictRubric: boolean): string | null {
    if (!strictRubric) return null;
    const sections = parseMarkdownH2Sections(report);
    const recommendation = sections.get('recommendation') ?? '';
    const why = sections.get('why') ?? '';
    const tradeoffs = sections.get('tradeoffs') ?? '';
    const caveats = sections.get('caveats') ?? '';

    if (!recommendation || !why || !tradeoffs || !caveats) {
        return 'under-specified advisory report emitted in advisory direct-answer pass';
    }
    if (advisoryWordCount(recommendation) < 12 || advisoryWordCount(why) < 12) {
        return 'under-specified advisory report emitted in advisory direct-answer pass';
    }

    const tradeoffLines = tradeoffs
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    const hasTradeoffBullet = tradeoffLines.some(line => /^[-*]\s+\S/.test(line));
    if (!hasTradeoffBullet && advisoryWordCount(tradeoffs) < 10) {
        return 'under-specified advisory report emitted in advisory direct-answer pass';
    }
    if (advisoryWordCount(caveats) < 1) {
        return 'under-specified advisory report emitted in advisory direct-answer pass';
    }
    return null;
}

function classifyAdvisoryWitnessAnswer(text: string, strictRubric = false): AdvisoryWitnessClassification {
    if (containsPseudoToolCall(text)) {
        return {
            status: 'invalid',
            error: 'pseudo-tool call emitted in advisory direct-answer pass',
            retryable: true,
        };
    }
    if (containsPromptReflectionLeak(text)) {
        return {
            status: 'invalid',
            error: 'protocol deliberation leaked into advisory direct-answer pass',
            retryable: true,
        };
    }

    const markdownField = extractMarkdownField(text);
    if (markdownField !== null) {
        if (isLowValueAdvisoryReport(markdownField, 'advisory')) {
            return {
                status: 'invalid',
                error: 'low-value advisory report emitted in advisory direct-answer pass',
                retryable: true,
            };
        }
        const qualityError = advisoryQualityError(markdownField, strictRubric);
        if (qualityError !== null) {
            return {
                status: 'invalid',
                error: qualityError,
                retryable: true,
            };
        }
        return { status: 'report', report: markdownField };
    }

    if (containsEmptyStructuredFinal(text)) {
        return {
            status: 'invalid',
            error: 'empty advisory report emitted in advisory direct-answer pass',
            retryable: true,
        };
    }

    if (containsProtocolEnvelopeJson(text)) {
        return {
            status: 'invalid',
            error: 'repo-context request emitted in advisory direct-answer pass',
            retryable: true,
        };
    }

    const plainReport = extractPlainMarkdownReport(text);
    if (plainReport !== null) {
        if (isLowValueAdvisoryReport(plainReport, 'advisory')) {
            return {
                status: 'invalid',
                error: 'low-value advisory report emitted in advisory direct-answer pass',
                retryable: true,
            };
        }
        const qualityError = advisoryQualityError(plainReport, strictRubric);
        if (qualityError !== null) {
            return {
                status: 'invalid',
                error: qualityError,
                retryable: true,
            };
        }
        return { status: 'report', report: plainReport };
    }

    return {
        status: 'invalid',
        error: 'empty or non-report output emitted in advisory direct-answer pass',
        retryable: true,
    };
}

function containsEmptyStructuredFinal(text: string): boolean {
    const parsed = parseJsonObject(text);
    return parsed?.action === 'final'
        && typeof parsed.findings_markdown === 'string'
        && parsed.findings_markdown.trim() === '';
}

type WitnessFirstPassClassification =
    | { status: 'report'; report: string }
    | { status: 'needs_context'; requests: ReturnType<typeof parseContextRequests>; diagnostics: ContextRequestDiagnostic[] }
    | { status: 'invalid'; error: string; retryable: boolean; diagnostics: ContextRequestDiagnostic[] };

function classifyWitnessFirstPass(
    text: string,
    limits: { maxContextSnippets: number; maxContextLines: number; maxContextBytes: number },
    anchors?: Parameters<typeof parseContextRequests>[2],
    taskMode: ConsultTaskMode = 'review',
): WitnessFirstPassClassification {
    if (containsPseudoToolCall(text)) {
        return {
            status: 'invalid',
            error: 'pseudo-tool call emitted in no-tools context-request pass',
            retryable: true,
            diagnostics: [],
        };
    }

    const firstPassMarkdown = extractFirstPassFinalMarkdown(text);
    if (firstPassMarkdown !== null) {
        if (isLowValueAdvisoryReport(firstPassMarkdown, taskMode)) {
            return {
                status: 'invalid',
                error: 'low-value advisory report emitted in no-tools context-request pass',
                retryable: true,
                diagnostics: [],
            };
        }
        return { status: 'report', report: firstPassMarkdown };
    }

    if (containsEmptyStructuredFinal(text)) {
        return {
            status: 'invalid',
            error: 'empty final report emitted in no-tools context-request pass',
            retryable: true,
            diagnostics: [],
        };
    }

    const inspection = inspectContextRequests(text, {
        maxSnippets: limits.maxContextSnippets,
        maxLines: limits.maxContextLines,
        maxBytes: limits.maxContextBytes,
        maxRounds: 1,
    }, anchors);
    if (inspection.requests.length > 0) {
        if (taskMode === 'advisory') {
            return {
                status: 'invalid',
                error: 'repo-context request emitted in advisory consult pass',
                retryable: true,
                diagnostics: inspection.diagnostics,
            };
        }
        return { status: 'needs_context', requests: inspection.requests, diagnostics: inspection.diagnostics };
    }

    const plainReport = extractPlainMarkdownReport(text);
    if (plainReport && !containsProtocolEnvelopeJson(text)) {
        if (isLowValueAdvisoryReport(plainReport, taskMode)) {
            return {
                status: 'invalid',
                error: 'low-value advisory report emitted in no-tools context-request pass',
                retryable: true,
                diagnostics: [],
            };
        }
        return { status: 'report', report: plainReport };
    }

    return {
        status: 'invalid',
        error: 'non-report output emitted in no-tools context-request pass',
        retryable: true,
        diagnostics: inspection.diagnostics,
    };
}

type WitnessFinalClassification =
    | { status: 'report'; report: string; source: 'markdown' | 'salvaged_structured' }
    | { status: 'invalid'; error: string; retryable: boolean };

function classifyWitnessFinal(text: string): WitnessFinalClassification {
    const finalMarkdown = extractMarkdownField(text);
    if (finalMarkdown !== null) return { status: 'report', report: finalMarkdown, source: 'markdown' };

    const salvagedReport = extractSalvageableFinalReport(text);
    if (salvagedReport !== null) return { status: 'report', report: salvagedReport, source: 'salvaged_structured' };

    if (containsEmptyStructuredFinal(text)) {
        return {
            status: 'invalid',
            error: 'empty final report emitted in no-tools finalization pass',
            retryable: true,
        };
    }

    const plainReport = extractPlainMarkdownReport(text);
    if (plainReport !== null) return { status: 'report', report: plainReport, source: 'markdown' };

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

function buildWitnessContextAttemptDiagnostic(params: {
    stage: WitnessContextAttemptDiagnostic['stage'];
    round: number;
    classification: WitnessFirstPassClassification;
}): WitnessContextAttemptDiagnostic {
    return {
        stage: params.stage,
        round: params.round,
        outcome: params.classification.status === 'report'
            ? 'report'
            : params.classification.status === 'needs_context'
                ? 'requests'
                : 'invalid',
        error: params.classification.status === 'invalid' ? params.classification.error : null,
        request_count: params.classification.status === 'needs_context' ? params.classification.requests.length : 0,
        diagnostic_count: 'diagnostics' in params.classification ? params.classification.diagnostics.length : 0,
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

function buildWitnessFallbackReport(params: {
    error: string;
    requests: ContextRequest[];
    snippets: ContextSnippet[];
    diagnostics: ContextRequestDiagnostic[];
    contextAttemptDiagnostics: WitnessContextAttemptDiagnostic[];
    finalizationDiagnostics: FinalizationAttemptDiagnostic[];
}): string {
    const requestLines = params.requests.length > 0
        ? params.requests.map(request => {
            const suffix = request.type === 'tree'
                ? `${request.path}/`
                : `${request.path}:${request.line_start}-${request.line_end}`;
            return `- \`${suffix}\` — ${request.reason || 'no reason provided'}`;
        }).join('\n')
        : '- No accepted context requests were fulfilled.';
    const snippetLines = params.snippets.length > 0
        ? params.snippets.map(snippet => {
            const suffix = snippet.type === 'tree'
                ? `${snippet.path}/`
                : `${snippet.path}:${snippet.line_start}-${snippet.line_end}`;
            const status = snippet.status === 'ok' ? 'ok' : `error: ${snippet.error ?? 'unknown'}`;
            return `- \`${suffix}\` — ${status}`;
        }).join('\n')
        : '- No snippets were fulfilled.';
    const diagnosticLines = params.diagnostics.length > 0
        ? params.diagnostics.map(diagnostic => `- ${diagnostic.reason}: ${diagnostic.message}`).join('\n')
        : '- None.';
    const contextAttemptLines = params.contextAttemptDiagnostics.length > 0
        ? params.contextAttemptDiagnostics.map(diagnostic => {
            const error = diagnostic.error ? ` — ${diagnostic.error}` : '';
            return `- round ${diagnostic.round} ${diagnostic.stage}: ${diagnostic.outcome} (requests=${diagnostic.request_count}, diagnostics=${diagnostic.diagnostic_count})${error}`;
        }).join('\n')
        : '- None.';
    const finalizationLines = params.finalizationDiagnostics.length > 0
        ? params.finalizationDiagnostics.map(diagnostic => {
            const source = diagnostic.report_source ? ` (${diagnostic.report_source})` : '';
            const error = diagnostic.error ? ` — ${diagnostic.error}` : '';
            return `- ${diagnostic.stage}: ${diagnostic.outcome}${source}${error}`;
        }).join('\n')
        : '- None.';

    return `## Findings

ACA generated this fallback witness note because the witness retrieved context but did not produce a valid no-tools final report.

## Retrieved Requests

${requestLines}

## Retrieved Snippets

${snippetLines}

## Request Diagnostics

${diagnosticLines}

## Context Attempt Timeline

${contextAttemptLines}

## Finalization Timeline

${finalizationLines}

## Open Questions

- The witness finalization failed with: ${params.error}
- Treat this as degraded witness evidence. Rely on the ACA-read snippets above, not on a model-authored conclusion.
`;
}

function buildSharedContextFallbackReport(params: {
    error: string;
    requests: ContextRequest[];
    snippets: ContextSnippet[];
    diagnostics: ContextRequestDiagnostic[];
    scoutAttemptDiagnostics: SharedContextAttemptDiagnostic[];
    provenanceSummary: string[];
}): string {
    const requestLines = params.requests.length > 0
        ? params.requests.map(request => {
            const suffix = request.type === 'tree'
                ? `${request.path}/`
                : `${request.path}:${request.line_start}-${request.line_end}`;
            return `- \`${suffix}\` — ${request.reason || 'no reason provided'}`;
        }).join('\n')
        : '- No shared-context requests were accepted.';
    const snippetLines = params.snippets.length > 0
        ? params.snippets.map(snippet => {
            const suffix = snippet.type === 'tree'
                ? `${snippet.path}/`
                : `${snippet.path}:${snippet.line_start}-${snippet.line_end}`;
            const status = snippet.status === 'ok' ? 'ok' : `error: ${snippet.error ?? 'unknown'}`;
            return `- \`${suffix}\` — ${status}`;
        }).join('\n')
        : '- No shared-context snippets were fulfilled.';
    const diagnosticLines = params.diagnostics.length > 0
        ? params.diagnostics.map(diagnostic => `- ${diagnostic.reason}: ${diagnostic.message}`).join('\n')
        : '- None.';
    const attemptLines = params.scoutAttemptDiagnostics.length > 0
        ? params.scoutAttemptDiagnostics.map(diagnostic => {
            const error = diagnostic.error ? ` — ${diagnostic.error}` : '';
            return `- ${diagnostic.stage}: ${diagnostic.outcome} (requests=${diagnostic.request_count}, diagnostics=${diagnostic.diagnostic_count})${error}`;
        }).join('\n')
        : '- None.';
    const provenanceLines = params.provenanceSummary.length > 0
        ? params.provenanceSummary.map(line => `- ${line}`).join('\n')
        : '- None.';

    return `## Findings

ACA generated this shared-context degraded note because the scout did not complete a clean raw-evidence pass.

## Retrieved Requests

${requestLines}

## Retrieved Snippets

${snippetLines}

## Request Diagnostics

${diagnosticLines}

## Scout Attempt Timeline

${attemptLines}

## Request Provenance

${provenanceLines}

## Open Questions

- The shared-context scout failed with: ${params.error}
- Treat this as weak retrieval evidence. Prefer ACA-read snippets above over any missing-evidence inference.
`;
}

function formatContextTarget(item: Pick<ContextRequest | ContextSnippet, 'type' | 'path' | 'line_start' | 'line_end'>): string {
    if (item.type === 'tree') return `${item.path}/`;
    return `${item.path}:${item.line_start}-${item.line_end}`;
}

function describeWindowPolicy(provenance: ContextProvenance | undefined): string {
    switch (provenance?.window_policy) {
        case 'symbol_window_v1':
            return 'ACA symbol window';
        case 'expand_window_v1':
            return 'ACA expansion window';
        case 'file_open_head_v1':
            return 'ACA-opened file head';
        case 'explicit_range_v1':
            return 'model-specified range';
        default:
            return 'unspecified window';
    }
}

function describeSharedContextProvenance(provenance: ContextProvenance | undefined, item: Pick<ContextRequest | ContextSnippet, 'type' | 'path'>): string {
    if (item.type === 'tree') return 'directory discovery request';
    if (!provenance) return 'no recorded provenance';
    const window = describeWindowPolicy(provenance);
    switch (provenance.source_kind) {
        case 'symbol':
            return `symbol anchor \`${provenance.source_ref}\` at line ${provenance.anchor_line ?? 'unknown'} via ${window}`;
        case 'snippet':
            return `ACA snippet anchor \`${provenance.source_ref}\`${provenance.anchor_line ? ` around line ${provenance.anchor_line}` : ''} via ${window}`;
        case 'tree':
            return `tree listing \`${provenance.source_ref}\` via ${window}`;
        case 'direct':
            if (provenance.source_ref.startsWith('prompt_path:')) {
                return `task-mentioned path \`${provenance.source_ref.slice('prompt_path:'.length)}\` via ${window}`;
            }
            if (provenance.source_ref.startsWith('evidence_pack_path:')) {
                return `ACA evidence path \`${provenance.source_ref.slice('evidence_pack_path:'.length)}\` via ${window}`;
            }
            return `direct scout request \`${provenance.source_ref}\` via ${window}`;
        default:
            return `unknown provenance via ${window}`;
    }
}

function buildSharedContextProvenanceSummary(requests: ContextRequest[], snippets: ContextSnippet[]): string[] {
    const count = Math.max(requests.length, snippets.length);
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) {
        const request = requests[index];
        const snippet = snippets[index];
        const item = snippet ?? request;
        if (!item) continue;
        const target = formatContextTarget(item);
        const provenance = snippet?.provenance ?? request?.provenance;
        const summary = describeSharedContextProvenance(provenance, item);
        const status = snippet
            ? (snippet.status === 'ok' ? 'fulfilled ok' : `fulfilled error: ${snippet.error ?? 'unknown'}`)
            : 'not fulfilled';
        lines.push(`\`${target}\` — ${summary}; ${status}`);
    }
    return lines;
}

function currentAcaCommand(): { command: string; args: string[] } {
    const entrypoint = process.argv[1] ?? 'aca';
    if (entrypoint.endsWith('.ts')) {
        return { command: 'npx', args: ['tsx', entrypoint] };
    }
    return { command: process.execPath, args: [entrypoint] };
}

function renderPrompt(question: string, taskMode: ConsultTaskMode): string {
    const taskTypeSection = taskMode === 'review'
        ? `## Task Type
This is a repo/code review task.

## Review Rules
- Return concrete findings only.
- Include file paths and line numbers when possible.
- If no grounded issue is found, say that directly.`
        : `## Task Type
This is an advisory or analysis task, not necessarily a code bug hunt.

## Response Rules
- Answer the task directly and substantively.
- If repository context is irrelevant, say so briefly and then continue with the actual answer.
- Do not collapse to "No bug found" or "No issues found" for conceptual or advisory tasks.`;
    return `# ACA Consult

## Task
${question}

${taskTypeSection}
`;
}

function buildNoToolsConsultSystemMessages(mode: 'witness' | 'shared_context' | 'triage', model?: string): InvokeSystemMessage[] {
    const modeInstruction = mode === 'shared_context'
        ? 'You are the shared raw evidence scout. Select raw snippets only. Do not produce review findings.'
        : mode === 'triage'
            ? 'You are the triage pass. Aggregate only the supplied witness evidence. Do not perform a fresh review.'
            : 'You are a witness consult pass. Answer the supplied task using only the supplied context.';
    const hints = model ? getModelHints(model) : [];
    const hintSection = hints.length > 0
        ? `\n<model_hints>\n${hints.join('\n')}\n</model_hints>`
        : '';
    return [{
        role: 'system',
        content: `You are running a bounded ACA consult pass, not the normal autonomous ACA invoke workflow.
${NO_NATIVE_FUNCTION_CALLING}
${NO_PROTOCOL_DELIBERATION}
Answer in English only.
Do not call tools, ask to call tools, emit tool-call JSON, or emit XML/function markup such as \`<tool_call>\`, \`<call>\`, \`<function_calls>\`, or \`<invoke>\`.
Follow the user prompt's protocol exactly.
If the prompt asks for Markdown, return Markdown only.
If the prompt asks for JSON, return JSON only.
If more context is needed, use only the exact request format described in the prompt.
In context-request JSON, numeric fields such as \`line_start\` and \`line_end\` must be JSON numbers, not strings, prose, explanations, placeholders, or comments.
Do not add extra wrappers, agent narration, or next-step instructions outside the requested output.
${modeInstruction}${hintSection}`,
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
    maxContextRounds: number;
}, taskMode: ConsultTaskMode): Promise<WitnessResult> {
    const responsePath = join(tmpdir(), `aca-consult-${witness.name}-response-${suffix}.md`);
    const requestPath = join(tmpdir(), `aca-consult-${witness.name}-context-request-${suffix}.md`);
    const finalRawPath = join(tmpdir(), `aca-consult-${witness.name}-final-raw-${suffix}.md`);
    const sentinelPath = join(tmpdir(), `aca-consult-${witness.name}-pending-${suffix}.md`);
    writeFileSync(sentinelPath, `# ${witness.name} — waiting for model response\n\nStarted: ${new Date().toISOString()}\nSuffix: ${suffix}\n`);
    const removeSentinel = (): void => {
        try { unlinkSync(sentinelPath); } catch { /* already removed */ }
    };
    const limitsObj: ContextRequestLimits = {
        maxSnippets: limits.maxContextSnippets,
        maxLines: limits.maxContextLines,
        maxBytes: limits.maxContextBytes,
        maxRounds: limits.maxContextRounds,
    };
    const maxRounds = limits.maxContextRounds;

    // Accumulated state across rounds.
    const allSnippets: ContextSnippet[] = [];
    const allRequests: ContextRequest[] = [];
    const allRequestDiagnostics: ContextRequestDiagnostic[] = [];
    const contextAttemptDiagnostics: WitnessContextAttemptDiagnostic[] = [];
    const finalizationDiagnostics: FinalizationAttemptDiagnostic[] = [];
    const roundSafeties: Array<{ context_request?: InvokeSafety; context_request_retry?: InvokeSafety }> = [];
    const allInvokeResponses: Array<InvokeResponse | undefined> = [];

    // Pre-locate any code identifiers mentioned in the question so witnesses
    // don't need to navigate to find them.
    const identifiers = extractCodeIdentifiers(prompt);
    const symbolLocations = identifiers.length > 0
        ? await resolveSymbolLocations(identifiers, projectDir)
        : [];
    const groundedDirectFileSources = extractPromptGroundedFileSources(prompt);

    if (taskMode === 'advisory') {
        const strictAdvisoryRubric = usesStrictAdvisoryRubric(witness, prompt);
        const firstPrompt = buildAdvisoryWitnessPrompt(prompt, strictAdvisoryRubric);
        const firstAttempt = await invoke(witness.model, firstPrompt, projectDir, {
            maxSteps: 1,
            maxTotalTokens: 30_000,
            outPath: requestPath,
            systemMessages: buildNoToolsConsultSystemMessages('witness', witness.model),
        });
        allInvokeResponses.push(firstAttempt.response);

        if (firstAttempt.response.status !== 'success') {
            const firstError = errorMessage(firstAttempt.response, firstAttempt.stderr);
            contextAttemptDiagnostics.push({
                stage: 'initial',
                round: 1,
                outcome: 'invoke_error',
                error: firstError,
                request_count: 0,
                diagnostic_count: 0,
            });
            if (isEmptyInvokeErrorMessage(firstError)) {
                const emptyRetryPrompt = buildAdvisoryEmptyResponseRetryPrompt(prompt, firstError, strictAdvisoryRubric);
                const retryAttempt = await invoke(witness.model, emptyRetryPrompt, projectDir, {
                    maxSteps: 1,
                    maxTotalTokens: 12_000,
                    systemMessages: buildNoToolsConsultSystemMessages('witness', witness.model),
                });
                allInvokeResponses.push(retryAttempt.response);

                if (retryAttempt.response.status === 'success') {
                    const retryClass = classifyAdvisoryWitnessAnswer(stripBlockquoteMarkers(retryAttempt.response.result ?? ''), strictAdvisoryRubric);
                    contextAttemptDiagnostics.push({
                        stage: 'initial_retry',
                        round: 1,
                        outcome: retryClass.status === 'report' ? 'report' : 'invalid',
                        error: retryClass.status === 'invalid' ? retryClass.error : null,
                        request_count: 0,
                        diagnostic_count: 0,
                    });
                    if (retryClass.status === 'report') {
                        writeFileSync(responsePath, retryClass.report);
                        removeSentinel();
                        return {
                            name: witness.name,
                            model: witness.model,
                            status: 'ok',
                            error: null,
                            response_path: responsePath,
                            raw_request_path: requestPath,
                            triage_input_path: responsePath,
                            usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
                            safety: {
                                context_request: firstAttempt.response.safety,
                                context_request_retry: retryAttempt.response.safety,
                            },
                            context_attempt_diagnostics: contextAttemptDiagnostics,
                            finalization_diagnostics: finalizationDiagnostics,
                            context_requests: [],
                            context_request_diagnostics: [],
                            context_snippets: [],
                        };
                    }

                    const lastChancePrompt = buildAdvisoryEmptyResponseLastChancePrompt(
                        prompt,
                        [firstError, retryClass.error],
                        strictAdvisoryRubric,
                    );
                    const lastChanceAttempt = await invoke(witness.model, lastChancePrompt, projectDir, {
                        maxSteps: 1,
                        maxTotalTokens: 12_000,
                        systemMessages: buildNoToolsConsultSystemMessages('witness', witness.model),
                    });
                    allInvokeResponses.push(lastChanceAttempt.response);
                    if (lastChanceAttempt.response.status === 'success') {
                        const lastChanceClass = classifyAdvisoryWitnessAnswer(stripBlockquoteMarkers(lastChanceAttempt.response.result ?? ''), strictAdvisoryRubric);
                        contextAttemptDiagnostics.push({
                            stage: 'initial_last_chance',
                            round: 1,
                            outcome: lastChanceClass.status === 'report' ? 'report' : 'invalid',
                            error: lastChanceClass.status === 'invalid' ? lastChanceClass.error : null,
                            request_count: 0,
                            diagnostic_count: 0,
                        });
                        if (lastChanceClass.status === 'report') {
                            writeFileSync(responsePath, lastChanceClass.report);
                            removeSentinel();
                            return {
                                name: witness.name,
                                model: witness.model,
                                status: 'ok',
                                error: null,
                                response_path: responsePath,
                                raw_request_path: requestPath,
                                triage_input_path: responsePath,
                                usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
                                safety: {
                                    context_request: firstAttempt.response.safety,
                                    context_request_retry: retryAttempt.response.safety,
                                    final_last_chance: lastChanceAttempt.response.safety,
                                },
                                context_attempt_diagnostics: contextAttemptDiagnostics,
                                finalization_diagnostics: finalizationDiagnostics,
                                context_requests: [],
                                context_request_diagnostics: [],
                                context_snippets: [],
                            };
                        }

                        removeSentinel();
                        return {
                            name: witness.name,
                            model: witness.model,
                            status: 'error',
                            error: lastChanceClass.error,
                            response_path: null,
                            raw_request_path: requestPath,
                            triage_input_path: null,
                            usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
                            safety: {
                                context_request: firstAttempt.response.safety,
                                context_request_retry: retryAttempt.response.safety,
                                final_last_chance: lastChanceAttempt.response.safety,
                            },
                            context_attempt_diagnostics: contextAttemptDiagnostics,
                            finalization_diagnostics: [],
                            context_requests: [],
                            context_request_diagnostics: [],
                            context_snippets: [],
                        };
                    }

                    const lastChanceError = errorMessage(lastChanceAttempt.response, lastChanceAttempt.stderr);
                    contextAttemptDiagnostics.push({
                        stage: 'initial_last_chance',
                        round: 1,
                        outcome: 'invoke_error',
                        error: lastChanceError,
                        request_count: 0,
                        diagnostic_count: 0,
                    });
                    removeSentinel();
                    return {
                        name: witness.name,
                        model: witness.model,
                        status: 'error',
                        error: lastChanceError,
                        response_path: null,
                        raw_request_path: requestPath,
                        triage_input_path: null,
                        usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
                        safety: {
                            context_request: firstAttempt.response.safety,
                            context_request_retry: retryAttempt.response.safety,
                            final_last_chance: lastChanceAttempt.response.safety,
                        },
                        context_attempt_diagnostics: contextAttemptDiagnostics,
                        finalization_diagnostics: [],
                        context_requests: [],
                        context_request_diagnostics: [],
                        context_snippets: [],
                    };
                }

                const retryError = errorMessage(retryAttempt.response, retryAttempt.stderr);
                contextAttemptDiagnostics.push({
                    stage: 'initial_retry',
                    round: 1,
                    outcome: 'invoke_error',
                    error: retryError,
                    request_count: 0,
                    diagnostic_count: 0,
                });
                const lastChancePrompt = buildAdvisoryEmptyResponseLastChancePrompt(prompt, [firstError, retryError], strictAdvisoryRubric);
                const lastChanceAttempt = await invoke(witness.model, lastChancePrompt, projectDir, {
                    maxSteps: 1,
                    maxTotalTokens: 12_000,
                    systemMessages: buildNoToolsConsultSystemMessages('witness', witness.model),
                });
                allInvokeResponses.push(lastChanceAttempt.response);
                if (lastChanceAttempt.response.status === 'success') {
                    const lastChanceClass = classifyAdvisoryWitnessAnswer(stripBlockquoteMarkers(lastChanceAttempt.response.result ?? ''), strictAdvisoryRubric);
                    contextAttemptDiagnostics.push({
                        stage: 'initial_last_chance',
                        round: 1,
                        outcome: lastChanceClass.status === 'report' ? 'report' : 'invalid',
                        error: lastChanceClass.status === 'invalid' ? lastChanceClass.error : null,
                        request_count: 0,
                        diagnostic_count: 0,
                    });
                    if (lastChanceClass.status === 'report') {
                        writeFileSync(responsePath, lastChanceClass.report);
                        removeSentinel();
                        return {
                            name: witness.name,
                            model: witness.model,
                            status: 'ok',
                            error: null,
                            response_path: responsePath,
                            raw_request_path: requestPath,
                            triage_input_path: responsePath,
                            usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
                            safety: {
                                context_request: firstAttempt.response.safety,
                                context_request_retry: retryAttempt.response.safety,
                                final_last_chance: lastChanceAttempt.response.safety,
                            },
                            context_attempt_diagnostics: contextAttemptDiagnostics,
                            finalization_diagnostics: finalizationDiagnostics,
                            context_requests: [],
                            context_request_diagnostics: [],
                            context_snippets: [],
                        };
                    }

                    removeSentinel();
                    return {
                        name: witness.name,
                        model: witness.model,
                        status: 'error',
                        error: lastChanceClass.error,
                        response_path: null,
                        raw_request_path: requestPath,
                        triage_input_path: null,
                        usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
                        safety: {
                            context_request: firstAttempt.response.safety,
                            context_request_retry: retryAttempt.response.safety,
                            final_last_chance: lastChanceAttempt.response.safety,
                        },
                        context_attempt_diagnostics: contextAttemptDiagnostics,
                        finalization_diagnostics: [],
                        context_requests: [],
                        context_request_diagnostics: [],
                        context_snippets: [],
                    };
                }

                const lastChanceError = errorMessage(lastChanceAttempt.response, lastChanceAttempt.stderr);
                contextAttemptDiagnostics.push({
                    stage: 'initial_last_chance',
                    round: 1,
                    outcome: 'invoke_error',
                    error: lastChanceError,
                    request_count: 0,
                    diagnostic_count: 0,
                });
                removeSentinel();
                return {
                    name: witness.name,
                    model: witness.model,
                    status: 'error',
                    error: lastChanceError,
                    response_path: null,
                    raw_request_path: requestPath,
                    triage_input_path: null,
                    usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
                    safety: {
                        context_request: firstAttempt.response.safety,
                        context_request_retry: retryAttempt.response.safety,
                        final_last_chance: lastChanceAttempt.response.safety,
                    },
                    context_attempt_diagnostics: contextAttemptDiagnostics,
                    finalization_diagnostics: [],
                    context_requests: [],
                    context_request_diagnostics: [],
                    context_snippets: [],
                };
            }
            removeSentinel();
            return {
                name: witness.name,
                model: witness.model,
                status: 'error',
                error: firstError,
                response_path: null,
                raw_request_path: requestPath,
                triage_input_path: null,
                usage: usageOrNull(firstAttempt.response),
                safety: firstAttempt.response.safety ?? null,
                context_attempt_diagnostics: contextAttemptDiagnostics,
                finalization_diagnostics: [],
                context_requests: [],
                context_request_diagnostics: [],
                context_snippets: [],
            };
        }

        const firstClass = classifyAdvisoryWitnessAnswer(stripBlockquoteMarkers(firstAttempt.response.result ?? ''), strictAdvisoryRubric);
        contextAttemptDiagnostics.push({
            stage: 'initial',
            round: 1,
            outcome: firstClass.status === 'report' ? 'report' : 'invalid',
            error: firstClass.status === 'invalid' ? firstClass.error : null,
            request_count: 0,
            diagnostic_count: 0,
        });
        if (firstClass.status === 'report') {
            writeFileSync(responsePath, firstClass.report);
            removeSentinel();
            return {
                name: witness.name,
                model: witness.model,
                status: 'ok',
                error: null,
                response_path: responsePath,
                raw_request_path: requestPath,
                triage_input_path: responsePath,
                usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
                safety: firstAttempt.response.safety ?? null,
                context_attempt_diagnostics: contextAttemptDiagnostics,
                finalization_diagnostics: finalizationDiagnostics,
                context_requests: [],
                context_request_diagnostics: [],
                context_snippets: [],
            };
        }

        const retryPrompt = buildAdvisoryContextRequestRetryPrompt(
            prompt,
            firstAttempt.response.result ?? '',
            firstClass.error,
            limitsObj,
            strictAdvisoryRubric,
        );
        const retryAttempt = await invoke(witness.model, retryPrompt, projectDir, {
            maxSteps: 1,
            maxTotalTokens: 30_000,
            systemMessages: buildNoToolsConsultSystemMessages('witness', witness.model),
        });
        allInvokeResponses.push(retryAttempt.response);

        if (retryAttempt.response.status === 'success') {
            const retryClass = classifyAdvisoryWitnessAnswer(stripBlockquoteMarkers(retryAttempt.response.result ?? ''), strictAdvisoryRubric);
            contextAttemptDiagnostics.push({
                stage: 'initial_retry',
                round: 1,
                outcome: retryClass.status === 'report' ? 'report' : 'invalid',
                error: retryClass.status === 'invalid' ? retryClass.error : null,
                request_count: 0,
                diagnostic_count: 0,
            });
            if (retryClass.status === 'report') {
                writeFileSync(responsePath, retryClass.report);
                removeSentinel();
                return {
                    name: witness.name,
                    model: witness.model,
                    status: 'ok',
                    error: null,
                    response_path: responsePath,
                    raw_request_path: requestPath,
                    triage_input_path: responsePath,
                    usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
                    safety: {
                        context_request: firstAttempt.response.safety,
                        context_request_retry: retryAttempt.response.safety,
                    },
                    context_attempt_diagnostics: contextAttemptDiagnostics,
                    finalization_diagnostics: finalizationDiagnostics,
                    context_requests: [],
                    context_request_diagnostics: [],
                    context_snippets: [],
                };
            }

            const lastChancePrompt = buildAdvisoryWitnessLastChancePrompt(
                prompt,
                [firstAttempt.response.result ?? '', retryAttempt.response.result ?? ''],
                retryClass.error,
                strictAdvisoryRubric,
            );
            const lastChanceAttempt = await invoke(witness.model, lastChancePrompt, projectDir, {
                maxSteps: 1,
                maxTotalTokens: 30_000,
                systemMessages: buildNoToolsConsultSystemMessages('witness', witness.model),
            });
            allInvokeResponses.push(lastChanceAttempt.response);
            if (lastChanceAttempt.response.status === 'success') {
                const lastChanceClass = classifyAdvisoryWitnessAnswer(stripBlockquoteMarkers(lastChanceAttempt.response.result ?? ''), strictAdvisoryRubric);
                contextAttemptDiagnostics.push({
                    stage: 'initial_last_chance',
                    round: 1,
                    outcome: lastChanceClass.status === 'report' ? 'report' : 'invalid',
                    error: lastChanceClass.status === 'invalid' ? lastChanceClass.error : null,
                    request_count: 0,
                    diagnostic_count: 0,
                });
                if (lastChanceClass.status === 'report') {
                    writeFileSync(responsePath, lastChanceClass.report);
                    removeSentinel();
                    return {
                        name: witness.name,
                        model: witness.model,
                        status: 'ok',
                        error: null,
                        response_path: responsePath,
                        raw_request_path: requestPath,
                        triage_input_path: responsePath,
                        usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
                        safety: {
                            context_request: firstAttempt.response.safety,
                            context_request_retry: retryAttempt.response.safety,
                            final_last_chance: lastChanceAttempt.response.safety,
                        },
                        context_attempt_diagnostics: contextAttemptDiagnostics,
                        finalization_diagnostics: finalizationDiagnostics,
                        context_requests: [],
                        context_request_diagnostics: [],
                        context_snippets: [],
                    };
                }
            } else {
                contextAttemptDiagnostics.push({
                    stage: 'initial_last_chance',
                    round: 1,
                    outcome: 'invoke_error',
                    error: errorMessage(lastChanceAttempt.response, lastChanceAttempt.stderr),
                    request_count: 0,
                    diagnostic_count: 0,
                });
            }
        } else {
            contextAttemptDiagnostics.push({
                stage: 'initial_retry',
                round: 1,
                outcome: 'invoke_error',
                error: errorMessage(retryAttempt.response, retryAttempt.stderr),
                request_count: 0,
                diagnostic_count: 0,
            });
        }

        removeSentinel();
        return {
            name: witness.name,
            model: witness.model,
            status: 'error',
            error: firstClass.error,
            response_path: null,
            raw_request_path: requestPath,
            triage_input_path: requestPath,
            usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
            safety: {
                context_request: firstAttempt.response.safety,
                context_request_retry: retryAttempt.response.safety,
            },
            context_attempt_diagnostics: contextAttemptDiagnostics,
            finalization_diagnostics: finalizationDiagnostics,
            context_requests: [],
            context_request_diagnostics: [],
            context_snippets: [],
        };
    }

    // Build and issue the round-1 context-request prompt.
    const firstPrompt = buildContextRequestPrompt(
        prompt, limitsObj, maxRounds, maxRounds,
        symbolLocations.length > 0 ? symbolLocations : undefined,
    );
    const firstAttempt = await invoke(witness.model, firstPrompt, projectDir, {
        maxSteps: 1,
        maxTotalTokens: 30_000,
        outPath: requestPath,
        systemMessages: buildNoToolsConsultSystemMessages('witness', witness.model),
    });
    allInvokeResponses.push(firstAttempt.response);

    if (firstAttempt.response.status !== 'success') {
        contextAttemptDiagnostics.push({
            stage: 'initial',
            round: 1,
            outcome: 'invoke_error',
            error: errorMessage(firstAttempt.response, firstAttempt.stderr),
            request_count: 0,
            diagnostic_count: 0,
        });
        removeSentinel();
        return {
            name: witness.name,
            model: witness.model,
            status: 'error',
            error: errorMessage(firstAttempt.response, firstAttempt.stderr),
            response_path: null,
            raw_request_path: requestPath,
            triage_input_path: null,
            usage: usageOrNull(firstAttempt.response),
            safety: firstAttempt.response.safety ?? null,
            context_attempt_diagnostics: contextAttemptDiagnostics,
            finalization_diagnostics: [],
            context_requests: [],
            context_request_diagnostics: [],
            context_snippets: [],
        };
    }

    // The multi-round loop.  Each iteration:
    //   1. Classify the current response.
    //   2. If invalid+retryable, one retry per round.
    //   3. If report → break (voluntary finalization).
    //   4. If invalid (unrecoverable) → break and return error.
    //   5. If needs_context → fulfill snippets, push to allSnippets/allRequests.
    //   6. If rounds remain → build continuation prompt and continue.
    //   7. If rounds exhausted → break and fall through to forced finalization.
    let roundsUsed = 0;
    let currentResponse = firstAttempt.response;
    let lastEffectiveResponseText = currentResponse.result ?? '';
    let lastClassification: WitnessFirstPassClassification | null = null;

    while (roundsUsed < maxRounds) {
        roundsUsed++;
        const roundText = currentResponse.result ?? '';
        const requestAnchors = {
            symbolLocations,
            priorSnippets: allSnippets,
            groundedDirectFileSources,
        };
        const attemptStage = roundsUsed === 1 ? 'initial' : 'continuation';
        const retryStage = roundsUsed === 1 ? 'initial_retry' : 'continuation_retry';

        let classification = classifyWitnessFirstPass(stripBlockquoteMarkers(roundText), limits, requestAnchors, taskMode);
        let retryResponse: { response: InvokeResponse; stderr: string } | null = null;
        if ('diagnostics' in classification) {
            allRequestDiagnostics.push(...classification.diagnostics);
        }
        contextAttemptDiagnostics.push(buildWitnessContextAttemptDiagnostic({
            stage: attemptStage,
            round: roundsUsed,
            classification,
        }));

        if (classification.status === 'invalid' && classification.retryable) {
            const retryPrompt = buildContextRequestRetryPrompt(prompt, roundText, limitsObj);
            retryResponse = await invoke(witness.model, retryPrompt, projectDir, {
                maxSteps: 1,
                maxTotalTokens: 30_000,
                systemMessages: buildNoToolsConsultSystemMessages('witness', witness.model),
            });
            allInvokeResponses.push(retryResponse.response);
            if (retryResponse.response.status === 'success') {
                const retryClass = classifyWitnessFirstPass(stripBlockquoteMarkers(retryResponse.response.result ?? ''), limits, requestAnchors, taskMode);
                if ('diagnostics' in retryClass) {
                    allRequestDiagnostics.push(...retryClass.diagnostics);
                }
                contextAttemptDiagnostics.push(buildWitnessContextAttemptDiagnostic({
                    stage: retryStage,
                    round: roundsUsed,
                    classification: retryClass,
                }));
                if (retryClass.status === 'report' || retryClass.status === 'needs_context') {
                    classification = retryClass;
                    lastEffectiveResponseText = retryResponse.response.result ?? '';
                }
            } else {
                contextAttemptDiagnostics.push({
                    stage: retryStage,
                    round: roundsUsed,
                    outcome: 'invoke_error',
                    error: errorMessage(retryResponse.response, retryResponse.stderr),
                    request_count: 0,
                    diagnostic_count: 0,
                });
            }
        } else {
            lastEffectiveResponseText = roundText;
        }

        roundSafeties.push({
            context_request: currentResponse.safety,
            context_request_retry: retryResponse?.response.safety,
        });

        lastClassification = classification;

        if (classification.status === 'report') {
            writeFileSync(responsePath, classification.report);
            break;
        }

        if (classification.status === 'invalid') {
            // Unrecoverable — report error immediately.
            removeSentinel();
            return {
                name: witness.name,
                model: witness.model,
                status: 'error',
                error: classification.error,
                response_path: null,
                raw_request_path: requestPath,
                triage_input_path: requestPath,
                usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
                safety: buildRoundSafeties(roundSafeties),
                context_attempt_diagnostics: contextAttemptDiagnostics,
                finalization_diagnostics: finalizationDiagnostics,
                context_requests: allRequests,
                context_request_diagnostics: allRequestDiagnostics,
                context_snippets: allSnippets.map(({ text: _text, ...snippet }) => snippet),
            };
        }

        // needs_context: fulfill and accumulate.
        const roundRequests = classification.requests;
        allRequests.push(...roundRequests);
        const roundSnippets = fulfillContextRequests(roundRequests, projectDir, limitsObj);
        allSnippets.push(...roundSnippets);

        if (roundsUsed >= maxRounds) {
            // All context-request rounds exhausted — fall through to forced finalization.
            break;
        }

        // Build continuation prompt for the next round.
        const roundsRemaining = maxRounds - roundsUsed;
        const continuationPrompt = buildContinuationPrompt(prompt, allSnippets, roundsRemaining, limitsObj, witness.model);
        const nextAttempt = await invoke(witness.model, continuationPrompt, projectDir, {
            maxSteps: 1,
            maxTotalTokens: 30_000,
            systemMessages: buildNoToolsConsultSystemMessages('witness', witness.model),
        });
        allInvokeResponses.push(nextAttempt.response);

        // Persist each continuation round's raw response for post-mortem debugging.
        // Round 1 is already written via outPath on the initial context-request invoke.
        if (nextAttempt.response.result) {
            const roundPath = join(tmpdir(), `aca-consult-${witness.name}-round-${roundsUsed + 1}-${suffix}.md`);
            writeFileSync(roundPath, nextAttempt.response.result);
        }

        if (nextAttempt.response.status !== 'success') {
            // Provider error in continuation — return error immediately.
            contextAttemptDiagnostics.push({
                stage: 'continuation',
                round: roundsUsed + 1,
                outcome: 'invoke_error',
                error: errorMessage(nextAttempt.response, nextAttempt.stderr),
                request_count: 0,
                diagnostic_count: 0,
            });
            removeSentinel();
            return {
                name: witness.name,
                model: witness.model,
                status: 'error',
                error: errorMessage(nextAttempt.response, nextAttempt.stderr),
                response_path: null,
                raw_request_path: requestPath,
                triage_input_path: null,
                usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
                safety: buildRoundSafeties(roundSafeties),
                context_attempt_diagnostics: contextAttemptDiagnostics,
                finalization_diagnostics: finalizationDiagnostics,
                context_requests: allRequests,
                context_request_diagnostics: allRequestDiagnostics,
                context_snippets: allSnippets.map(({ text: _text, ...snippet }) => snippet),
            };
        }

        currentResponse = nextAttempt.response;
    }

    // If the witness finalized voluntarily, return immediately.
    if (lastClassification?.status === 'report') {
        removeSentinel();
        return {
            name: witness.name,
            model: witness.model,
            status: 'ok',
            error: null,
            response_path: responsePath,
            raw_request_path: requestPath,
            triage_input_path: responsePath,
            usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
            safety: buildRoundSafeties(roundSafeties),
            context_attempt_diagnostics: contextAttemptDiagnostics,
            finalization_diagnostics: finalizationDiagnostics,
            context_requests: allRequests,
            context_request_diagnostics: allRequestDiagnostics,
            context_snippets: allSnippets.map(({ text: _text, ...snippet }) => snippet),
        };
    }

    // Witness kept requesting context until rounds were exhausted — force finalization.
    const finalPrompt = buildFinalizationPrompt(prompt, lastEffectiveResponseText, allSnippets, witness.model);
    const final = await invoke(witness.model, finalPrompt, projectDir, {
        maxSteps: 1,
        maxTotalTokens: 30_000,
        outPath: finalRawPath,
        systemMessages: buildNoToolsConsultSystemMessages('witness', witness.model),
    });
    allInvokeResponses.push(final.response);
    const finalResponse = final.response;
    const finalClassification = finalResponse.status === 'success'
        ? classifyWitnessFinal(finalResponse.result ?? '')
        : null;
    finalizationDiagnostics.push(finalResponse.status === 'success'
        ? finalClassification?.status === 'report'
            ? { stage: 'final', outcome: 'report', error: null, report_source: finalClassification.source }
            : { stage: 'final', outcome: 'invalid', error: finalClassification?.error ?? 'unknown finalization classification failure' }
        : { stage: 'final', outcome: 'invoke_error', error: errorMessage(finalResponse, final.stderr) });
    let finalRetry: { response: InvokeResponse; stderr: string } | null = null;
    let finalLastChance: { response: InvokeResponse; stderr: string } | null = null;
    let effectiveFinalClassification = finalClassification;
    if (finalResponse.status === 'success' && finalClassification?.status === 'invalid' && finalClassification.retryable) {
        finalRetry = await invoke(
            witness.model,
            buildFinalizationRetryPrompt(prompt, lastEffectiveResponseText, allSnippets, finalResponse.result ?? '', witness.model),
            projectDir,
            {
                maxSteps: 1,
                maxTotalTokens: 30_000,
                systemMessages: buildNoToolsConsultSystemMessages('witness', witness.model),
            },
        );
        allInvokeResponses.push(finalRetry.response);
        if (finalRetry.response.status === 'success') {
            const retryClass = classifyWitnessFinal(finalRetry.response.result ?? '');
            finalizationDiagnostics.push(retryClass.status === 'report'
                ? { stage: 'final_retry', outcome: 'report', error: null, report_source: retryClass.source }
                : { stage: 'final_retry', outcome: 'invalid', error: retryClass.error });
            if (retryClass.status === 'report') {
                effectiveFinalClassification = retryClass;
                writeFileSync(responsePath, retryClass.report);
            } else if (retryClass.status === 'invalid' && allSnippets.length > 0) {
                finalLastChance = await invoke(
                    witness.model,
                    buildFinalizationLastChancePrompt(
                        prompt,
                        lastEffectiveResponseText,
                        allSnippets,
                        [finalResponse.result ?? '', finalRetry.response.result ?? ''],
                        witness.model,
                    ),
                    projectDir,
                    {
                        maxSteps: 1,
                        maxTotalTokens: 30_000,
                        systemMessages: buildNoToolsConsultSystemMessages('witness', witness.model),
                    },
                );
                allInvokeResponses.push(finalLastChance.response);
                if (finalLastChance.response.status === 'success') {
                    const lastChanceClass = classifyWitnessFinal(finalLastChance.response.result ?? '');
                    finalizationDiagnostics.push(lastChanceClass.status === 'report'
                        ? { stage: 'final_last_chance', outcome: 'report', error: null, report_source: lastChanceClass.source }
                        : { stage: 'final_last_chance', outcome: 'invalid', error: lastChanceClass.error });
                    if (lastChanceClass.status === 'report') {
                        effectiveFinalClassification = lastChanceClass;
                        writeFileSync(responsePath, lastChanceClass.report);
                    }
                } else {
                    finalizationDiagnostics.push({
                        stage: 'final_last_chance',
                        outcome: 'invoke_error',
                        error: errorMessage(finalLastChance.response, finalLastChance.stderr),
                    });
                }
            }
        } else {
            finalizationDiagnostics.push({
                stage: 'final_retry',
                outcome: 'invoke_error',
                error: errorMessage(finalRetry.response, finalRetry.stderr),
            });
        }
    } else if (finalResponse.status === 'success' && finalClassification?.status === 'report') {
        writeFileSync(responsePath, finalClassification.report);
    }

    const finalSucceeded = finalResponse.status === 'success'
        && effectiveFinalClassification?.status === 'report';
    const finalError = finalSucceeded
        ? null
        : finalResponse.status === 'success'
        ? (finalClassification?.status === 'invalid' ? finalClassification.error : null)
        : errorMessage(finalResponse, final.stderr);
    const roundsSafety = buildRoundSafeties(roundSafeties);
    const finalSafety = typeof roundsSafety === 'object' && roundsSafety !== null && 'context_request' in roundsSafety
        ? { ...roundsSafety, final: final.response.safety, final_retry: finalRetry?.response.safety, final_last_chance: finalLastChance?.response.safety }
        : { context_request: undefined, final: final.response.safety, final_retry: finalRetry?.response.safety, final_last_chance: finalLastChance?.response.safety };
    let fallbackResponsePath: string | null = null;
    if (!finalSucceeded && allSnippets.length > 0 && finalError) {
        fallbackResponsePath = join(tmpdir(), `aca-consult-${witness.name}-fallback-${suffix}.md`);
        finalizationDiagnostics.push({
            stage: 'fallback',
            outcome: 'generated',
            error: finalError,
        });
        writeFileSync(fallbackResponsePath, buildWitnessFallbackReport({
            error: finalError,
            requests: allRequests,
            snippets: allSnippets,
            diagnostics: allRequestDiagnostics,
            contextAttemptDiagnostics,
            finalizationDiagnostics,
        }));
    }

    removeSentinel();
    return {
        name: witness.name,
        model: witness.model,
        status: finalSucceeded ? 'ok' : 'error',
        error: finalError,
        response_path: finalSucceeded ? responsePath : fallbackResponsePath,
        raw_request_path: requestPath,
        triage_input_path: finalSucceeded
            ? responsePath
            : fallbackResponsePath ?? (finalResponse.result ? finalRawPath : null),
        usage: mergeUsage(...allInvokeResponses.map(r => r?.usage)),
        safety: finalSafety,
        context_attempt_diagnostics: contextAttemptDiagnostics,
        finalization_diagnostics: finalizationDiagnostics,
        context_requests: allRequests,
        context_request_diagnostics: allRequestDiagnostics,
        context_snippets: allSnippets.map(({ text: _text, ...snippet }) => snippet),
    };
}

/**
 * Build a safety record from per-round safety data. For single-round runs,
 * preserves the original `context_request`/`context_request_retry` shape for
 * backward compatibility. For multi-round, adds `extra_rounds` for rounds 2+.
 */
function buildRoundSafeties(
    roundSafeties: Array<{ context_request?: InvokeSafety; context_request_retry?: InvokeSafety }>,
): WitnessResult['safety'] {
    if (roundSafeties.length === 0) return null;
    const [first, ...extra] = roundSafeties;
    const result: WitnessResult['safety'] & { extra_rounds?: typeof extra } = {
        context_request: first.context_request,
        context_request_retry: first.context_request_retry,
    };
    if (extra.length > 0) {
        (result as Record<string, unknown>)['extra_rounds'] = extra;
    }
    return result;
}

async function buildSharedContext(prompt: string, projectDir: string, suffix: string, options: {
    models: string[];
    maxSnippets: number;
    maxLines: number;
    maxBytes: number;
}): Promise<NonNullable<ConsultResult['shared_context']> & { snippetsWithText: ContextSnippet[] }> {
    const requestPath = join(tmpdir(), `aca-consult-shared-context-${suffix}.md`);
    const fallbackPath = join(tmpdir(), `aca-consult-shared-context-fallback-${suffix}.md`);
    const attemptDiagnostics: SharedContextAttemptDiagnostic[] = [];
    const summarizeProvenance = (requests: ContextRequest[], snippets: ContextSnippet[]): string[] =>
        buildSharedContextProvenanceSummary(requests, snippets);
    const writeFallback = (error: string, requests: ContextRequest[], diagnostics: ContextRequestDiagnostic[], snippets: ContextSnippet[]): string => {
        const provenanceSummary = summarizeProvenance(requests, snippets);
        writeFileSync(fallbackPath, buildSharedContextFallbackReport({
            error,
            requests,
            snippets,
            diagnostics,
            scoutAttemptDiagnostics: attemptDiagnostics,
            provenanceSummary,
        }));
        return fallbackPath;
    };
    const identifiers = extractCodeIdentifiers(prompt);
    const symbolLocations = identifiers.length > 0
        ? await resolveSymbolLocations(identifiers, projectDir)
        : [];
    const groundedDirectFileSources = extractPromptGroundedFileSources(prompt);
    const scoutPrompt = buildSharedContextRequestPrompt(prompt, {
        maxSnippets: options.maxSnippets,
        maxLines: options.maxLines,
        maxBytes: options.maxBytes,
        maxRounds: 1,
    }, symbolLocations.length > 0 ? symbolLocations : undefined);
    const scout = await invokeWithFallbackModels(options.models, scoutPrompt, projectDir, {
        maxSteps: 1,
        maxTotalTokens: 30_000,
        outPath: requestPath,
        responseFormat: SHARED_CONTEXT_RESPONSE_FORMAT,
        systemMessages: buildNoToolsConsultSystemMessages('shared_context'),
    });

    if (scout.response.status !== 'success') {
        attemptDiagnostics.push({
            stage: 'initial',
            outcome: 'invoke_error',
            error: errorMessage(scout.response, scout.stderr),
            request_count: 0,
            diagnostic_count: 0,
        });
        const triageInputPath = writeFallback(errorMessage(scout.response, scout.stderr), [], [], []);
        return {
            status: 'error',
            model: scout.model,
            request_path: requestPath,
            triage_input_path: triageInputPath,
            error: errorMessage(scout.response, scout.stderr),
            usage: usageOrNull(scout.response),
            safety: scout.response.safety ?? null,
            scout_attempt_diagnostics: attemptDiagnostics,
            provenance_summary: [],
            context_requests: [],
            context_request_diagnostics: [],
            context_snippets: [],
            snippetsWithText: [],
        };
    }

    if (containsPseudoToolCall(scout.response.result ?? '')) {
        attemptDiagnostics.push({
            stage: 'initial',
            outcome: 'invalid',
            error: 'pseudo-tool call emitted in shared raw context scout pass',
            request_count: 0,
            diagnostic_count: 0,
        });
        const triageInputPath = writeFallback('pseudo-tool call emitted in shared raw context scout pass', [], [], []);
        return {
            status: 'error',
            model: scout.model,
            request_path: requestPath,
            triage_input_path: triageInputPath,
            error: 'pseudo-tool call emitted in shared raw context scout pass',
            usage: usageOrNull(scout.response),
            safety: scout.response.safety ?? null,
            scout_attempt_diagnostics: attemptDiagnostics,
            provenance_summary: [],
            context_requests: [],
            context_request_diagnostics: [],
            context_snippets: [],
            snippetsWithText: [],
        };
    }

    const firstInspection = inspectContextRequests(scout.response.result ?? '', {
        maxSnippets: options.maxSnippets,
        maxLines: options.maxLines,
        maxBytes: options.maxBytes,
        maxRounds: 1,
    }, undefined, {
        disallowExplicitFileRanges: true,
        symbolLocations: symbolLocations.length > 0 ? symbolLocations : undefined,
        groundedDirectFileSources,
    });
    attemptDiagnostics.push({
        stage: 'initial',
        outcome: firstInspection.requests.length > 0 ? 'requests' : 'no_requests',
        error: null,
        request_count: firstInspection.requests.length,
        diagnostic_count: firstInspection.diagnostics.length,
    });
    const firstRequests = firstInspection.requests;
    const firstSnippets = fulfillContextRequests(firstRequests, projectDir, {
        maxSnippets: options.maxSnippets,
        maxLines: options.maxLines,
        maxBytes: options.maxBytes,
        maxRounds: 1,
    });
    const needsFollowUp = firstRequests.some(request => request.type === 'tree')
        || firstSnippets.some(snippet => snippet.status === 'error');

    let requests = [...firstRequests];
    let diagnostics = [...firstInspection.diagnostics];
    let snippets = [...firstSnippets];
    let safety: InvokeSafety | { context_request?: InvokeSafety; extra_rounds?: Array<{ context_request?: InvokeSafety }> } | null = scout.response.safety ?? null;
    let usage = usageOrNull(scout.response);

    if (needsFollowUp) {
        const continuationPrompt = buildSharedContextContinuationPrompt(prompt, firstSnippets, {
            maxSnippets: options.maxSnippets,
            maxLines: options.maxLines,
            maxBytes: options.maxBytes,
            maxRounds: 2,
        });
        const continuation = await invokeWithFallbackModels([scout.model], continuationPrompt, projectDir, {
            maxSteps: 1,
            maxTotalTokens: 30_000,
            systemMessages: buildNoToolsConsultSystemMessages('shared_context'),
        });
        if (continuation.response.result) {
            appendFileSync(
                requestPath,
                `\n\n## Shared Scout Continuation Raw Response\n\n${continuation.response.result}\n`,
            );
        }
        if (continuation.response.status !== 'success') {
            attemptDiagnostics.push({
                stage: 'continuation',
                outcome: 'invoke_error',
                error: errorMessage(continuation.response, continuation.stderr),
                request_count: 0,
                diagnostic_count: 0,
            });
            const triageInputPath = writeFallback(
                errorMessage(continuation.response, continuation.stderr),
                requests,
                diagnostics,
                snippets,
            );
            return {
                status: 'error',
                model: continuation.model,
                request_path: requestPath,
                triage_input_path: triageInputPath,
                error: errorMessage(continuation.response, continuation.stderr),
                usage: mergeUsage(usage, usageOrNull(continuation.response)),
                safety: {
                    context_request: scout.response.safety,
                    extra_rounds: [{ context_request: continuation.response.safety }],
                },
                scout_attempt_diagnostics: attemptDiagnostics,
                provenance_summary: summarizeProvenance(requests, snippets),
                context_requests: requests,
                context_request_diagnostics: diagnostics,
                context_snippets: snippets.map(({ text: _text, ...snippet }) => snippet),
                snippetsWithText: snippets,
            };
        }
        if (containsPseudoToolCall(continuation.response.result ?? '')) {
            attemptDiagnostics.push({
                stage: 'continuation',
                outcome: 'invalid',
                error: 'pseudo-tool call emitted in shared raw context scout continuation pass',
                request_count: 0,
                diagnostic_count: 0,
            });
            const triageInputPath = writeFallback(
                'pseudo-tool call emitted in shared raw context scout continuation pass',
                requests,
                diagnostics,
                snippets,
            );
            return {
                status: 'error',
                model: continuation.model,
                request_path: requestPath,
                triage_input_path: triageInputPath,
                error: 'pseudo-tool call emitted in shared raw context scout continuation pass',
                usage: mergeUsage(usage, usageOrNull(continuation.response)),
                safety: {
                    context_request: scout.response.safety,
                    extra_rounds: [{ context_request: continuation.response.safety }],
                },
                scout_attempt_diagnostics: attemptDiagnostics,
                provenance_summary: summarizeProvenance(requests, snippets),
                context_requests: requests,
                context_request_diagnostics: diagnostics,
                context_snippets: snippets.map(({ text: _text, ...snippet }) => snippet),
                snippetsWithText: snippets,
            };
        }

        const secondInspection = inspectContextRequests(continuation.response.result ?? '', {
            maxSnippets: options.maxSnippets,
            maxLines: options.maxLines,
            maxBytes: options.maxBytes,
            maxRounds: 1,
        }, {
            priorSnippets: firstSnippets,
        });
        attemptDiagnostics.push({
            stage: 'continuation',
            outcome: secondInspection.requests.length > 0 ? 'requests' : 'no_requests',
            error: null,
            request_count: secondInspection.requests.length,
            diagnostic_count: secondInspection.diagnostics.length,
        });
        diagnostics = [...diagnostics, ...secondInspection.diagnostics];
        const groundedSecondRequests = secondInspection.requests;
        const secondSnippets = fulfillContextRequests(groundedSecondRequests, projectDir, {
            maxSnippets: options.maxSnippets,
            maxLines: options.maxLines,
            maxBytes: options.maxBytes,
            maxRounds: 1,
        });
        requests = [...requests, ...groundedSecondRequests];
        snippets = [...snippets, ...secondSnippets];
        usage = mergeUsage(usage, usageOrNull(continuation.response));
        safety = {
            context_request: scout.response.safety,
            extra_rounds: [{ context_request: continuation.response.safety }],
        };
    }

    return {
        status: 'ok',
        model: scout.model,
        request_path: requestPath,
        triage_input_path: null,
        error: null,
        usage,
        safety,
        scout_attempt_diagnostics: attemptDiagnostics,
        provenance_summary: summarizeProvenance(requests, snippets),
        context_requests: requests,
        context_request_diagnostics: diagnostics,
        context_snippets: snippets.map(({ text: _text, ...snippet }) => snippet),
        snippetsWithText: snippets,
    };
}

function buildTriagePrompt(
    witnesses: Record<string, WitnessResult>,
    sharedContext?: NonNullable<ConsultResult['shared_context']>,
): string {
    const sharedSection = sharedContext?.triage_input_path
        ? `## shared_context (${sharedContext.model ?? 'unknown'})\n\nStatus: degraded (${sharedContext.error ?? 'unknown failure'})\n\n${readFileSync(sharedContext.triage_input_path, 'utf8')}`
        : null;
    const sections = Object.values(witnesses).map(result => {
        const body = result.triage_input_path
            ? readFileSync(result.triage_input_path, 'utf8')
            : `(no witness output captured: ${result.error ?? 'unknown failure'})`;
        const status = result.status === 'ok'
            ? 'ok'
            : `degraded (${result.error ?? 'unknown failure'})`;
        return `## ${result.name} (${result.model})\n\nStatus: ${status}\n\n${body}`;
    });
    const combinedSections = sharedSection ? [sharedSection, ...sections] : sections;
    return `# ACA Consult Triage

You are an aggregation-only triage pass.
${NO_NATIVE_FUNCTION_CALLING}
${NO_PROTOCOL_DELIBERATION}
The witness reports and shared scout note below are your only evidence. Do not do a fresh code review.
Do not request files, list directories, call tools, or emit XML/function/tool markup such as \`<call>\`, \`<tool_call>\`, \`<function_calls>\`, or \`<invoke>\`.
Do not quote or reproduce literal pseudo-tool markup from witness reports; refer to it generically as pseudo-tool-call markup.
If evidence is missing, mark it as an open question instead of trying to fetch more context.
Some witness sections may contain degraded raw output captured before ACA could normalize it into a clean report. Treat those sections as weak evidence, note uncertainty, and do not over-index on malformed markup.
Do not promote claims based only on missing-file errors, ENOENT snippets, or "not present in the provided evidence" language into consensus findings. Keep those as open questions or likely false positives unless a witness cites positive source evidence.
A witness claiming "X is not implemented", "X is absent", "X is missing", or "X is not present" without quoting explicit positive source evidence (exact file path + line numbers, or a filled snippet confirming the gap) is an un-evidenced absence claim — classify it as a likely false positive or open question, not a consensus finding, unless at least two independent witnesses independently cite direct evidence.

Return a concise Markdown report with:
- consensus findings
- dissent
- likely false positives
- open questions

If ACA enforces structured output for this request, put the Markdown report in the "markdown" field.

${combinedSections.join('\n\n---\n\n')}
`;
}

function buildTriageRetryPrompt(
    witnesses: Record<string, WitnessResult>,
    sharedContext: NonNullable<ConsultResult['shared_context']> | undefined,
    invalidResponse: string,
    reasons: string[],
): string {
    const problems = reasons.map(reason => `- ${reason}`).join('\n');
    return `${buildTriagePrompt(witnesses, sharedContext)}

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

Do not quote literal pseudo-tool markup such as \`<invoke>\` or \`<tool_call>\`; describe it generically instead.
Do not end mid-sentence or with unbalanced Markdown delimiters.
`;
}

export async function runConsult(options: ConsultOptions): Promise<ConsultResult> {
    const projectDir = resolve(options.projectDir ?? process.cwd());
    const suffix = `${Date.now()}-${process.pid}`;
    const rawQuestion = options.question ?? '';
    const { obfuscated: obfuscatedQuestion, legend } = obfuscateIdentifiers(rawQuestion);
    const questionForPrompt = legend ? `${legend}\n\n${obfuscatedQuestion}` : obfuscatedQuestion;
    const promptSource = options.promptFile
        ? readFileSync(options.promptFile, 'utf8')
        : rawQuestion;
    const taskMode = inferConsultTaskMode(promptSource);
    const promptBase = options.promptFile
        ? promptSource
        : renderPrompt(questionForPrompt, taskMode);
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
    const triageMode = resolveTriageMode(options);
    const limits = {
        maxContextSnippets: options.maxContextSnippets ?? 3,
        maxContextLines: options.maxContextLines ?? 120,
        maxContextBytes: options.maxContextBytes ?? 8_000,
        maxContextRounds: options.maxContextRounds ?? 3,
    };
    const witnessEntries = await Promise.all(
        witnesses.map(async witness => [witness.name, await runWitness(witness, promptForWitnesses, projectDir, suffix, limits, taskMode)] as const),
    );
    const witnessResults = Object.fromEntries(witnessEntries);
    const successCount = Object.values(witnessResults).filter(result => result.status === 'ok').length;
    const triageableCount = Object.values(witnessResults).filter(result => result.triage_input_path !== null).length
        + (sharedContext?.triage_input_path ? 1 : 0);

    // --- Structured review aggregation (M7A.5 pipeline) ---
    // Runs deterministic Jaccard-clustering aggregation on witness markdown output.
    // Additive artifact — does not replace or affect the LLM triage pass below.
    let structuredReview: ConsultResult['structured_review'] = null;
    try {
        const reviews = Object.entries(witnessResults)
            .filter(([, result]) => result.triage_input_path !== null)
            .map(([name, result]) => {
                const markdown = readFileSync(result.triage_input_path!, 'utf8');
                return extractFindingsFromMarkdown(name, result.model, markdown);
            });
        if (reviews.length > 0) {
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);
            const reportText = renderReportText(report);
            const reportPath = join(tmpdir(), `aca-consult-structured-review-${suffix}.md`);
            const reportJsonPath = join(tmpdir(), `aca-consult-structured-review-${suffix}.json`);
            writeFileSync(reportPath, reportText, 'utf8');
            writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
            structuredReview = {
                status: 'ok',
                path: reportPath,
                json_path: reportJsonPath,
                cluster_count: aggregated.clusters.length,
                finding_count: aggregated.totalFindings,
                disagreement_count: aggregated.disagreements.length,
            };
        }
    } catch (err) {
        structuredReview = {
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
        };
    }

    let triage: ConsultResult['triage'] = {
        status: 'skipped',
        model: null,
        path: null,
        raw_path: null,
        error: triageMode === 'never'
            ? 'skipped by triage=never'
            : triageableCount === 0
                ? 'no triageable witness evidence'
                : 'skipped by triage=auto',
        usage: null,
        safety: null,
    };
    if (shouldRunTriage(triageMode, triageableCount, witnessResults, sharedContext, structuredReview)) {
        const triagePath = join(tmpdir(), `aca-consult-triage-${suffix}.md`);
        const triageRawPath = join(tmpdir(), `aca-consult-triage-raw-${suffix}.md`);
        const triageInvoke = await invokeWithFallbackModels([...TRIAGE_MODEL_CANDIDATES], buildTriagePrompt(witnessResults, sharedContext), projectDir, {
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
                    sharedContext,
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
                triage_input_path: sharedContext.triage_input_path,
                error: sharedContext.error,
                usage: sharedContext.usage,
                safety: sharedContext.safety,
                scout_attempt_diagnostics: sharedContext.scout_attempt_diagnostics,
                provenance_summary: sharedContext.provenance_summary,
                context_requests: sharedContext.context_requests,
                context_request_diagnostics: sharedContext.context_request_diagnostics,
                context_snippets: sharedContext.context_snippets,
            },
        } : {}),
        witnesses: witnessResults,
        triage,
        structured_review: structuredReview,
    };
    writeFileSync(resultPath, JSON.stringify(result, null, 2));
    return result;
}
