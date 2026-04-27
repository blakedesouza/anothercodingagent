import { existsSync, statSync } from 'node:fs';
import { isAbsolutePath, isPathWithin, resolvePathWithInputStyle } from '../core/path-comparison.js';
import { parseEmulatedToolCalls } from '../providers/tool-emulation.js';
import type { ConversationItem } from '../types/conversation.js';

function isWithinDirectory(parent: string, child: string): boolean {
    return isPathWithin(parent, child);
}

export function validateRequiredOutputPaths(workspaceRoot: string, paths: readonly string[] | undefined): string[] {
    if (!paths || paths.length === 0) return [];
    const root = resolvePathWithInputStyle(workspaceRoot);
    const missingOrEmpty: string[] = [];
    for (const rawPath of paths) {
        const trimmed = rawPath.trim();
        if (!trimmed) continue;
        const fullPath = isAbsolutePath(trimmed)
            ? resolvePathWithInputStyle(trimmed)
            : resolvePathWithInputStyle(root, trimmed);
        if (!isWithinDirectory(root, fullPath)) {
            missingOrEmpty.push(trimmed);
            continue;
        }
        try {
            const stat = existsSync(fullPath) ? statSync(fullPath) : undefined;
            if (!stat?.isFile() || stat.size <= 0) {
                missingOrEmpty.push(trimmed);
            }
        } catch {
            missingOrEmpty.push(trimmed);
        }
    }
    return missingOrEmpty;
}

export function buildRequiredOutputRepairTask(paths: readonly string[]): string {
    const normalized = paths.map(path => path.trim()).filter(Boolean);
    const quotedPaths = normalized.map(path => `"${path}"`).join(', ');
    return [
        `Required output file(s) are still missing or empty: ${quotedPaths}.`,
        'Continue from the existing context.',
        'Do not restate your plan, summarize progress, or say what you need to try next.',
        'Use tools immediately: inspect only what is still needed, create any missing parent directories, and write the required files now.',
        'Do not quote literal pseudo-tool markup such as `<tool_call>`, `<invoke>`, or function-call JSON. Your next assistant message must contain real tool calls or the actual written output path(s) being satisfied.',
        'If a source lookup failed earlier, either correct the next tool call or finish from the evidence already gathered. Do not stop because one lookup missed.',
        'Prefer the evidence already gathered. Only do additional reads/fetches if a specific missing detail blocks writing.',
        'When every required output path exists and is non-empty, stop.',
    ].join(' ');
}

export interface ProfileCompletionIssue {
    code: string;
    message: string;
}

export function buildProfileCompletionRepairTask(
    issue: ProfileCompletionIssue,
    requiredOutputPaths: readonly string[] | undefined,
): string {
    const normalizedPaths = (requiredOutputPaths ?? [])
        .map(path => path.trim())
        .filter(Boolean);
    const quotedPaths = normalizedPaths.map(path => `"${path}"`).join(', ');
    return [
        `Your previous response was invalid: ${issue.message}.`,
        'Continue from the existing context.',
        'Do not restate your plan, summarize progress, or say what you will do next.',
        'Your next assistant message must contain actual tool calls, not narration.',
        'Do not quote literal pseudo-tool markup such as `<tool_call>`, `<invoke>`, or function-call JSON.',
        'Use only the sources needed for the assigned task, then write the required output.',
        normalizedPaths.length > 0
            ? `The required output file(s) are: ${quotedPaths}.`
            : 'Complete the assigned output in this retry.',
        'If the output is not ready yet, make the next tool calls in that same assistant message.',
        'When the required output exists and is non-empty, stop.',
    ].join(' ');
}

const FINAL_RESULT_PSEUDO_TOOL_PREFIX = /^(?:```(?:json|javascript)?\s*)?(?:\{\s*"tool_calls"\s*:|\[\s*\{\s*"name"\s*:|<\s*(?:[\w-]+:)?(?:tool_call|function_calls?|call)\b|<\s*invoke\b|<\s*parameter\b|<\s*arg_(?:key|value)\b|\[\s*(?:TOOL_CALL|tool_use\s*:)\s*)/i;
const FINAL_RESULT_PSEUDO_TOOL_ANYWHERE = /(?:\{\s*"tool_calls"\s*:|\[\s*tool_use\s*:|\[\s*调用\s+[\w-]+\]|(?:^|\n)\s*(?:Tool|Arguments):\s*)/i;
const FINAL_RESULT_TOOL_INTENT = /^(?:i(?:'ll| will| can| need(?: to)?| should| am going to)|let me|next|now|first|to continue|continuing|using(?: a)? tool|calling(?: a)? tool)\b/i;
const FINAL_RESULT_UNRESOLVED_TOOL_INTENT = /^(?:i(?:'ll| will| can| need(?: to)?| should| am going to)|let me|next|now|first)\b.{0,240}\b(?:tool|read|inspect|edit|fix|run|test|check|gather|context|project|source)\b/i;
const FINAL_RESULT_EXPLANATORY = /\b(example|invalid|literal|quoted|string|markup|json|schema|protocol|field|property|parser|response|output|emitted|returned|contains?)\b/i;

export function validateFinalResultText(resultText: string): ProfileCompletionIssue | null {
    const trimmed = resultText.trim();
    if (!trimmed) {
        return {
            code: 'turn.output_validation_failed',
            message: 'final response was empty instead of a completed outcome',
        };
    }

    if (FINAL_RESULT_PSEUDO_TOOL_PREFIX.test(trimmed)) {
        return {
            code: 'turn.output_validation_failed',
            message: 'final response leaked raw tool-call-shaped text instead of a plain-language completion',
        };
    }

    if (FINAL_RESULT_PSEUDO_TOOL_ANYWHERE.test(trimmed) && !FINAL_RESULT_EXPLANATORY.test(trimmed)) {
        return {
            code: 'turn.output_validation_failed',
            message: 'final response leaked embedded tool-call-shaped text instead of executing the tool call',
        };
    }

    if (FINAL_RESULT_UNRESOLVED_TOOL_INTENT.test(trimmed)) {
        return {
            code: 'turn.output_validation_failed',
            message: 'final response ended with unresolved tool-use intent instead of a completed outcome',
        };
    }

    const parsed = parseEmulatedToolCalls(trimmed);
    if (!parsed) return null;

    const compactPreamble = parsed.preamble.replace(/\s+/g, ' ').trim();
    if (!compactPreamble) {
        return {
            code: 'turn.output_validation_failed',
            message: 'final response ended as a bare emulated tool call instead of a plain-language completion',
        };
    }

    if (FINAL_RESULT_EXPLANATORY.test(compactPreamble)) {
        return null;
    }

    if (FINAL_RESULT_TOOL_INTENT.test(compactPreamble) || compactPreamble.length <= 24) {
        return {
            code: 'turn.output_validation_failed',
            message: 'final response leaked tool-call-shaped text after a short tool-intent preamble instead of a plain-language completion',
        };
    }

    return null;
}

const FINAL_RESULT_CONTRADICTORY_FAILURE =
    /\b(?:tool returned an error|could not complete|couldn't complete|unable to complete)\b/i;

export function validateContradictoryFinalResult(
    items: readonly ConversationItem[],
    resultText: string,
    missingRequiredPaths: readonly string[] = [],
    requiredOutputPaths: readonly string[] = [],
): ProfileCompletionIssue | null {
    const hasSuccessfulMutation = countFilesystemMutations(items) > 0;
    const requiredOutputsSatisfied = requiredOutputPaths.length > 0 && missingRequiredPaths.length === 0;
    if (!hasSuccessfulMutation && !requiredOutputsSatisfied) return null;

    if (!FINAL_RESULT_CONTRADICTORY_FAILURE.test(resultText)) return null;

    return {
        code: 'turn.output_validation_failed',
        message: 'final response claimed the task could not complete after successful work evidence',
    };
}

export function buildFinalResultRepairTask(issue: ProfileCompletionIssue): string {
    return [
        `Your previous final response was invalid: ${issue.message}.`,
        'Continue from the existing context.',
        'If the task is not fully completed and verified, make the next required tool call immediately in this response.',
        'Do not narrate planned tool use, ask to call a tool, or stop after saying what you will do.',
        'Do not emit raw tool-call JSON, XML/function markup, or quoted pseudo-tool-call text; use the real tool-call channel when tools are needed.',
        'If the work is already complete and verified, write a brief plain-language final answer that states the concrete outcome.',
        'If files were written, mention the path(s) plainly. If code changed, summarize the fix plainly.',
    ].join(' ');
}

const CODE_MUTATION_TOOLS = new Set(['edit_file', 'write_file', 'move_path', 'delete_path']);
const CODE_FIX_INTENT = /\b(?:fix|patch|repair|modify|edit|change|update|implement|resolve|failing|failure|bug|regression)\b/i;
const ADVISORY_INTENT = /\b(?:explain|describe|suggest|recommend|plan|review|how would|what would|tell me)\b/i;

export function countFilesystemMutations(items: readonly ConversationItem[]): number {
    return items.filter((item) =>
        item.kind === 'tool_result'
        && item.output.status === 'success'
        && (
            item.output.mutationState === 'filesystem'
            || CODE_MUTATION_TOOLS.has(item.toolName)
        ),
    ).length;
}

export function validateCodingCompletion(
    task: string,
    allowedTools: readonly string[],
    items: readonly ConversationItem[],
): ProfileCompletionIssue | null {
    const wantsCodeChange = CODE_FIX_INTENT.test(task) && !ADVISORY_INTENT.test(task);
    if (!wantsCodeChange) return null;

    const canEdit = allowedTools.some(tool => CODE_MUTATION_TOOLS.has(tool));
    if (!canEdit) return null;

    if (countFilesystemMutations(items) > 0) return null;

    return {
        code: 'turn.coding_completion_failed',
        message: 'coding task ended without any filesystem mutation; diagnosis-only text is not a completed fix',
    };
}

export function buildCodingCompletionRepairTask(issue: ProfileCompletionIssue): string {
    return [
        `Your previous final response was invalid: ${issue.message}.`,
        'Continue from the existing context.',
        'The task asks for an actual code change, not advice.',
        'Do not restate the diagnosis or explain the intended patch as final output.',
        'Make the minimal required filesystem edit now using edit_file or write_file.',
        'Then run the requested validation command if one was requested.',
        'Only finish after the file has been changed and validation has been run or clearly could not be run.',
    ].join(' ');
}

export function countHardRejectedToolCalls(items: readonly ConversationItem[]): number {
    return items.filter((item) =>
        item.kind === 'tool_result'
        && item.output.status === 'error'
        && item.output.error?.code === 'tool.max_tool_calls',
    ).length;
}

export function validateProfileCompletion(
    profileName: string | undefined,
    acceptedToolCalls: number,
    resultText: string,
    lastStepAcceptedToolCalls?: number,
    missingRequiredPaths?: readonly string[],
): ProfileCompletionIssue | null {
    if (profileName !== 'rp-researcher') return null;
    const compact = resultText.replace(/\s+/g, ' ').trim();
    const looksLikePlanOnly = /^(?:i['']?ll|i will|let me|first[, ]+i['']?ll|next[, ]+i|now[, ]+i|i(?: am|'m) going to)\b/i.test(compact);
    // Case 1: no tool calls at all: classic zero-call narration.
    if (acceptedToolCalls === 0) {
        return {
            code: 'turn.profile_validation_failed',
            message: looksLikePlanOnly
                ? 'rp-researcher run ended without any accepted tool calls; plan-only or intention-only research text is not a valid completion'
                : 'rp-researcher run ended without any accepted tool calls; RP research/write tasks must inspect sources or local files before completion',
        };
    }
    // Case 2: narrate-after-work: made calls in earlier steps, but the last step produced
    // only narration and required output files are still missing.
    if (
        lastStepAcceptedToolCalls !== undefined
        && lastStepAcceptedToolCalls === 0
        && missingRequiredPaths !== undefined
        && missingRequiredPaths.length > 0
    ) {
        return {
            code: 'turn.profile_validation_failed',
            message: looksLikePlanOnly
                ? 'rp-researcher last step narrated intent instead of calling tools; required output files were not written'
                : 'rp-researcher last step produced no tool calls; required output files are still missing',
        };
    }
    return null;
}
