#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
    buildAdvisoryWitnessPrompt,
    buildContextRequestPrompt,
    buildContinuationPrompt,
    buildFinalizationPrompt,
    containsProtocolEnvelopeJson,
    containsPseudoToolCall,
    extractPromptGroundedFileSources,
    fulfillContextRequests,
    inspectContextRequests,
    stripBlockquoteMarkers,
    type ContextRequestLimits,
    type ContextSnippet,
} from '../src/consult/context-request.ts';
import { buildEvidencePack, appendEvidencePack } from '../src/consult/evidence-pack.ts';
import { extractCodeIdentifiers, resolveSymbolLocations } from '../src/consult/symbol-lookup.ts';
import { runAcaInvoke, parseInvokeOutput } from '../src/mcp/server.ts';
import { getModelHints } from '../src/prompts/model-hints.ts';
import { NO_NATIVE_FUNCTION_CALLING, NO_PROTOCOL_DELIBERATION } from '../src/prompts/prompt-guardrails.ts';
import type { InvokeResponse, InvokeSystemMessage } from '../src/cli/executor.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_INDEX = join(ROOT, 'src', 'index.ts');
const LIMITS: ContextRequestLimits = {
    maxSnippets: 4,
    maxLines: 160,
    maxBytes: 16_000,
    maxRounds: 2,
};

interface CandidateSummary {
    model: string;
    clean: number;
    degraded: number;
    total: number;
    taskResults: Array<{
        id: string;
        ok: boolean;
        status: 'ok' | 'error';
        error?: string;
        requestCount?: number;
        diagnostics?: string[];
        reportPreview?: string;
    }>;
}

function parseArgs(argv: string[]) {
    const options = {
        models: [
            'google/gemma-4-31b-it',
            'zai-org/glm-5',
            'mistralai/mistral-large-3-675b-instruct-2512',
            'mistralai/devstral-2-123b-instruct-2512',
        ],
        outDir: `/tmp/aca-consult-seat-bakeoff-${Date.now()}`,
        projectDir: ROOT,
        concurrency: 2,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--models') options.models = String(argv[++index] || '').split(',').map(item => item.trim()).filter(Boolean);
        else if (arg === '--out-dir') options.outDir = argv[++index] || options.outDir;
        else if (arg === '--project-dir') options.projectDir = resolve(argv[++index] || options.projectDir);
        else if (arg === '--concurrency') options.concurrency = Math.max(1, Math.min(3, Number.parseInt(argv[++index] || '2', 10) || 2));
        else if (arg === '--help') {
            process.stdout.write(`Usage: node --import tsx scripts/consult-seat-bakeoff.ts [options]

Options:
  --models <list>       Comma-separated candidate model IDs
  --out-dir <path>      Output directory
  --project-dir <path>  Project directory for grounded requests
  --concurrency <n>     Parallel model slots (default: 2, max: 3)
`);
            process.exit(0);
        }
    }

    return options;
}

function renderPrompt(question: string, mode: 'advisory' | 'review'): string {
    if (mode === 'advisory') {
        return `# ACA Consult

## Task
${question}

## Task Type
This is an advisory or analysis task, not necessarily a code bug hunt.

## Response Rules
- Answer the task directly and substantively.
- If repository context is irrelevant, say so briefly and then continue with the actual answer.
- Do not collapse to "No bug found" or "No issues found" for conceptual or advisory tasks.
`;
    }

    return `# ACA Consult

## Task
${question}

## Task Type
This is a repo/code review task.

## Review Rules
- Return concrete findings only.
- Include file paths and line numbers when possible.
- If no grounded issue is found, say that directly.
`;
}

function buildSystemMessages(mode: 'witness', model: string): InvokeSystemMessage[] {
    const modeInstruction = 'You are a witness consult pass. Answer the supplied task using only the supplied context.';
    const hints = getModelHints(model);
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

async function spawnInvoke(requestJson: string, deadlineMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return await new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', SRC_INDEX, 'invoke'], {
            cwd: ROOT,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const timer = setTimeout(() => child.kill('SIGTERM'), deadlineMs + 5_000);
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
}

async function invokeModel(model: string, prompt: string, projectDir: string, maxTotalTokens = 30_000): Promise<InvokeResponse> {
    const result = await runAcaInvoke(prompt, {
        cwd: projectDir,
        model,
        allowedTools: [],
        maxSteps: 1,
        maxToolCalls: 1,
        maxTotalTokens,
        systemMessages: buildSystemMessages('witness', model),
    }, spawnInvoke);
    return parseInvokeOutput(result.stdout, result.stderr, result.exitCode);
}

function advisoryLeakReason(text: string): string | null {
    const normalized = stripBlockquoteMarkers(text).trim();
    if (normalized === '') return 'empty advisory output';
    if (containsPseudoToolCall(normalized)) return 'tool markup leaked into advisory output';
    if (containsProtocolEnvelopeJson(normalized)) return 'protocol envelope leaked into advisory output';
    const leakPatterns = [
        /\banalyze the request\b/i,
        /\bdetermine content\b/i,
        /\bformat output\b/i,
        /\bself-?correction\b/i,
        /\blet'?s assemble\b/i,
        /\binternal (?:reasoning|check|review)\b/i,
    ];
    if (leakPatterns.some(pattern => pattern.test(normalized))) {
        return 'prompt/protocol reflection leaked into advisory output';
    }
    return null;
}

function finalReportReason(text: string): string | null {
    const normalized = stripBlockquoteMarkers(text).trim();
    if (normalized === '') return 'empty final report';
    if (containsPseudoToolCall(normalized)) return 'tool markup leaked into final report';
    if (containsProtocolEnvelopeJson(normalized)) return 'protocol envelope leaked into final report';
    return null;
}

async function runAdvisoryTask(model: string, question: string, projectDir: string) {
    const prompt = renderPrompt(question, 'advisory');
    const response = await invokeModel(model, buildAdvisoryWitnessPrompt(prompt, false), projectDir, 20_000);
    if (response.status !== 'success') {
        return { ok: false, status: 'error' as const, error: response.error?.message ?? 'invoke failed' };
    }
    const reason = advisoryLeakReason(response.result ?? '');
    if (reason) {
        return { ok: false, status: 'error' as const, error: reason, reportPreview: (response.result ?? '').slice(0, 300) };
    }
    return { ok: true, status: 'ok' as const, reportPreview: stripBlockquoteMarkers(response.result ?? '').slice(0, 300) };
}

async function runContextTask(model: string, prompt: string, projectDir: string) {
    const identifiers = extractCodeIdentifiers(prompt);
    const symbolLocations = identifiers.length > 0 ? await resolveSymbolLocations(identifiers, projectDir) : [];
    const groundedDirectFileSources = extractPromptGroundedFileSources(prompt);

    const snippets: ContextSnippet[] = [];
    let lastRequestText = '';
    let requestCount = 0;
    let lastResponse: InvokeResponse | null = null;

    for (let round = 1; round <= LIMITS.maxRounds; round += 1) {
        const roundPrompt = round === 1
            ? buildContextRequestPrompt(prompt, LIMITS, LIMITS.maxRounds, LIMITS.maxRounds, symbolLocations.length > 0 ? symbolLocations : undefined, model)
            : buildContinuationPrompt(prompt, snippets, LIMITS.maxRounds - round + 1, LIMITS, model);
        const response = await invokeModel(model, roundPrompt, projectDir);
        lastResponse = response;
        if (response.status !== 'success') {
            return { ok: false, status: 'error' as const, error: response.error?.message ?? 'invoke failed', requestCount };
        }

        const inspected = inspectContextRequests(stripBlockquoteMarkers(response.result ?? ''), LIMITS, {
            symbolLocations,
            snippets,
            groundedDirectFileSources,
        });
        if (inspected.requests.length === 0) {
            const reason = finalReportReason(response.result ?? '');
            if (reason) {
                return { ok: false, status: 'error' as const, error: reason, requestCount, diagnostics: inspected.diagnostics.map(item => item.reason) };
            }
            return {
                ok: true,
                status: 'ok' as const,
                requestCount,
                diagnostics: inspected.diagnostics.map(item => item.reason),
                reportPreview: stripBlockquoteMarkers(response.result ?? '').slice(0, 300),
            };
        }

        lastRequestText = response.result ?? '';
        requestCount += inspected.requests.length;
        snippets.push(...fulfillContextRequests(inspected.requests, projectDir, LIMITS));
    }

    if (!lastRequestText || snippets.length === 0 || lastResponse?.status !== 'success') {
        return { ok: false, status: 'error' as const, error: 'context rounds exhausted without usable evidence', requestCount };
    }

    const finalResponse = await invokeModel(model, buildFinalizationPrompt(prompt, lastRequestText, snippets, model), projectDir);
    if (finalResponse.status !== 'success') {
        return { ok: false, status: 'error' as const, error: finalResponse.error?.message ?? 'finalization failed', requestCount };
    }
    const reason = finalReportReason(finalResponse.result ?? '');
    if (reason) {
        return { ok: false, status: 'error' as const, error: reason, requestCount, reportPreview: (finalResponse.result ?? '').slice(0, 300) };
    }
    return {
        ok: true,
        status: 'ok' as const,
        requestCount,
        reportPreview: stripBlockquoteMarkers(finalResponse.result ?? '').slice(0, 300),
    };
}

async function evaluateModel(model: string, projectDir: string): Promise<CandidateSummary> {
    const packedPrompt = appendEvidencePack(
        renderPrompt('Review the packed files for grounded correctness risks only. Do not guess.', 'review'),
        buildEvidencePack({
            projectDir,
            paths: ['src/cli/consult.ts', 'src/consult/context-request.ts'],
            maxFiles: 2,
            maxFileBytes: 8_000,
            maxTotalBytes: 48_000,
        }),
    );

    const tasks = [
        { id: 'exact_advisory', run: () => runAdvisoryTask(model, 'Answer with exactly: 4', projectDir) },
        { id: 'substantive_advisory', run: () => runAdvisoryTask(model, 'How should a manager build a workload driver template for capacity planning?', projectDir) },
        { id: 'repo_fact', run: () => runContextTask(model, renderPrompt('What is the package name declared in this repository? Do not guess.', 'review'), projectDir) },
        { id: 'packed_review', run: () => runContextTask(model, packedPrompt, projectDir) },
    ];

    const taskResults = [];
    for (const task of tasks) {
        taskResults.push({ id: task.id, ...(await task.run()) });
    }

    return {
        model,
        clean: taskResults.filter(item => item.ok).length,
        degraded: taskResults.filter(item => !item.ok).length,
        total: taskResults.length,
        taskResults,
    };
}

async function runQueue<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
    let nextIndex = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const current = items[nextIndex++];
            await worker(current);
        }
    });
    await Promise.all(runners);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    mkdirSync(options.outDir, { recursive: true });

    const summaries: CandidateSummary[] = [];
    await runQueue(options.models, options.concurrency, async model => {
        process.stderr.write(`Evaluating ${model}...\n`);
        const summary = await evaluateModel(model, options.projectDir);
        summaries.push(summary);
        writeFileSync(join(options.outDir, `${model.replace(/[/:]/g, '_')}.json`), JSON.stringify(summary, null, 2));
    });

    summaries.sort((left, right) => {
        if (right.clean !== left.clean) return right.clean - left.clean;
        return left.degraded - right.degraded;
    });

    const summaryPath = join(options.outDir, 'summary.json');
    writeFileSync(summaryPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        projectDir: options.projectDir,
        candidates: summaries,
    }, null, 2));
    process.stdout.write(`${summaryPath}\n`);
}

void main();
