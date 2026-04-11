/**
 * Summarization module (Block 7, M3.4).
 *
 * LLM-based summarization of oldest completed-turn prefix with
 * deterministic fallback, cost ceiling enforcement, coverage tracking,
 * and visible history filtering.
 */

import type {
    ConversationItem,
    SummaryItem,
    TextPart,
    ToolCallPart,
} from '../types/conversation.js';
import type { DurableTaskState, DurableStatePatch } from './durable-task-state.js';
import { normalizeDurableStatePatch } from './durable-task-state.js';
import type { ItemId } from '../types/ids.js';
import { generateId } from '../types/ids.js';
import type { ProviderDriver, StreamEvent, ModelRequest } from '../types/provider.js';
import { sanitizeModelJson } from '../providers/tool-emulation.js';
import {
    estimateItemTokens,
    findToolCallArgs,
    computeDigest,
} from './context-assembly.js';

// --- Constants ---

/** Cost ceiling ratio: summarization must cost < 40% of original tokens. */
const COST_CEILING_RATIO = 0.4;

/** Minimum estimated response tokens for cost calculation. */
const MIN_RESPONSE_ESTIMATE = 50;

/** Response token estimate as fraction of original tokens. */
const RESPONSE_ESTIMATE_RATIO = 0.1;

/** Default max turns per summarization chunk. */
const DEFAULT_MAX_TURNS_PER_CHUNK = 12;

/** Default max estimated tokens per summarization chunk. */
const DEFAULT_MAX_TOKENS_PER_CHUNK = 20_000;

// --- Coverage Map ---

/**
 * Build a coverage map from conversation items.
 * Maps each covered item's seq to the seq of the covering summary.
 * Later summaries override earlier ones for overlapping ranges,
 * enabling nested summaries (summary-of-summaries).
 */
export function buildCoverageMap(items: ConversationItem[]): Map<number, number> {
    const map = new Map<number, number>();
    for (const item of items) {
        if (item.kind === 'summary') {
            for (let seq = item.coversSeq.start; seq <= item.coversSeq.end; seq++) {
                map.set(seq, item.seq);
            }
        }
    }
    return map;
}

/**
 * Return visible history: items covered by summaries are skipped,
 * summaries covered by newer summaries are also skipped.
 * An item is visible iff its seq is NOT in the coverage map.
 */
export function visibleHistory(
    items: ConversationItem[],
    coverageMap: Map<number, number>,
): ConversationItem[] {
    return items.filter(item => !coverageMap.has(item.seq));
}

// --- Cost Ceiling ---

/**
 * Compute the cost ceiling for summarization: 40% of the original tokens.
 */
export function computeCostCeiling(originalTokens: number): number {
    return Math.floor(originalTokens * COST_CEILING_RATIO);
}

/**
 * Check whether summarization would exceed the 40% cost ceiling.
 *
 * The estimated cost is the likely response token count (the summary itself).
 * For small chunks, the response overhead exceeds the threshold,
 * triggering the deterministic fallback instead of an LLM call.
 */
export function exceedsCostCeiling(originalTokens: number): boolean {
    const ceiling = computeCostCeiling(originalTokens);
    const estimatedResponseTokens = Math.max(
        MIN_RESPONSE_ESTIMATE,
        Math.ceil(originalTokens * RESPONSE_ESTIMATE_RATIO),
    );
    return estimatedResponseTokens > ceiling;
}

// --- Deterministic Fallback ---

/**
 * Generate a deterministic summary without an LLM call.
 * Retains first and last items verbatim, extracts tool call digests
 * for middle items, and discards assistant filler text.
 */
export function deterministicFallback(
    chunkItems: ConversationItem[],
    allItems: ConversationItem[],
): string {
    if (chunkItems.length === 0) return '';
    if (chunkItems.length === 1) return renderItemCompact(chunkItems[0]);

    const parts: string[] = [];

    // First item verbatim
    parts.push(renderItemCompact(chunkItems[0]));

    // Middle items: only tool results get a digest
    for (let i = 1; i < chunkItems.length - 1; i++) {
        const item = chunkItems[i];
        if (item.kind === 'tool_result') {
            const args = findToolCallArgs(allItems, item.toolCallId);
            parts.push(computeDigest(item, args));
        }
    }

    // Last item verbatim
    parts.push(renderItemCompact(chunkItems[chunkItems.length - 1]));

    return parts.join('\n');
}

// --- Summarization ---

/** Options for summarizing a single chunk. */
export interface SummarizeChunkOptions {
    /** Items in this chunk to summarize. */
    chunkItems: ConversationItem[];
    /** All conversation items (for tool call arg lookup and digests). */
    allItems: ConversationItem[];
    /** Provider driver for the LLM call. If undefined, fallback only. */
    provider?: ProviderDriver;
    /** Model name for the LLM call. Required if provider is set. */
    model?: string;
    /** Next available sequence number for the SummaryItem. */
    nextSeq: number;
    /** Bytes per token for estimation (default 3.0). */
    bytesPerToken?: number;
    /** Calibration multiplier (default 1.0). */
    calibrationMultiplier?: number;
    /** Current durable task state — included in prompt so summarizer avoids repeating known facts. */
    durableState?: DurableTaskState | null;
}

/** Result of summarizing a chunk. */
export interface SummarizeChunkResult {
    /** The created SummaryItem. */
    summary: SummaryItem;
    /** Whether the deterministic fallback was used. */
    usedFallback: boolean;
    /** Estimated tokens of the original items. */
    originalTokens: number;
    /** Optional durable-state update proposed by the summarizer. */
    durableStatePatch?: DurableStatePatch;
}

/**
 * Summarize a chunk of conversation items.
 * Checks cost ceiling first — uses deterministic fallback if exceeded
 * or if no provider is available. Falls back on LLM error.
 */
export async function summarizeChunk(
    options: SummarizeChunkOptions,
): Promise<SummarizeChunkResult> {
    const {
        chunkItems,
        allItems,
        provider,
        model,
        nextSeq,
        bytesPerToken = 3.0,
        calibrationMultiplier = 1.0,
    } = options;

    if (chunkItems.length === 0) {
        throw new Error('Cannot summarize empty chunk');
    }

    // Compute seq range from chunk items
    const seqs = chunkItems.map(item => item.seq);
    const coversSeq = { start: Math.min(...seqs), end: Math.max(...seqs) };

    // Estimate original tokens
    const originalTokens = chunkItems.reduce(
        (sum, item) => sum + estimateItemTokens(item, bytesPerToken, calibrationMultiplier),
        0,
    );

    let summaryText: string;
    let pinnedFacts: string[] | undefined;
    let durableStatePatch: DurableStatePatch | undefined;
    let usedFallback = true;

    const shouldUseLlm = provider != null && model != null && !exceedsCostCeiling(originalTokens);

    if (shouldUseLlm) {
        const prompt = buildSummarizationPrompt(chunkItems, options.durableState ?? null);
        const request: ModelRequest = {
            model: model!,
            messages: [{ role: 'user', content: prompt }],
            maxTokens: 1024,
            temperature: 0,
        };

        try {
            const { text } = await collectStreamText(provider!.stream(request));
            const parsed = parseSummarizationResponse(text);
            summaryText = parsed.summaryText;
            pinnedFacts = parsed.pinnedFacts.length > 0 ? parsed.pinnedFacts : undefined;
            durableStatePatch = parsed.durableStatePatch;
            usedFallback = false;
        } catch {
            // LLM call failed — fall back to deterministic
            summaryText = deterministicFallback(chunkItems, allItems);
        }
    } else {
        summaryText = deterministicFallback(chunkItems, allItems);
    }

    const summary: SummaryItem = {
        kind: 'summary',
        id: generateId('item') as ItemId,
        seq: nextSeq,
        text: summaryText,
        pinnedFacts,
        coversSeq,
        timestamp: new Date().toISOString(),
    };

    return { summary, usedFallback, originalTokens, durableStatePatch };
}

// --- Chunking ---

/**
 * Split turns into chunks for summarization.
 * Each chunk has at most maxTurns turns and maxTokens estimated tokens.
 * Returns arrays of flattened items per chunk.
 */
export function chunkForSummarization(
    turns: ConversationItem[][],
    bytesPerToken: number = 3.0,
    calibrationMultiplier: number = 1.0,
    maxTurns: number = DEFAULT_MAX_TURNS_PER_CHUNK,
    maxTokens: number = DEFAULT_MAX_TOKENS_PER_CHUNK,
): ConversationItem[][] {
    const chunks: ConversationItem[][] = [];
    let currentChunk: ConversationItem[] = [];
    let currentTurnCount = 0;
    let currentTokens = 0;

    for (const turn of turns) {
        const turnTokens = turn.reduce(
            (sum, item) => sum + estimateItemTokens(item, bytesPerToken, calibrationMultiplier),
            0,
        );

        // Start a new chunk if adding this turn would exceed limits
        if (currentTurnCount > 0 &&
            (currentTurnCount + 1 > maxTurns || currentTokens + turnTokens > maxTokens)) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTurnCount = 0;
            currentTokens = 0;
        }

        currentChunk.push(...turn);
        currentTurnCount++;
        currentTokens += turnTokens;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

// --- Internal helpers ---

/** Render a conversation item in compact text form for summaries. */
function renderItemCompact(item: ConversationItem): string {
    switch (item.kind) {
        case 'message': {
            const textParts: string[] = [];
            for (const p of item.parts) {
                if (p.type === 'text') {
                    textParts.push((p as TextPart).text);
                } else if (p.type === 'tool_call') {
                    textParts.push(`[called ${(p as ToolCallPart).toolName}]`);
                }
            }
            return `[${item.role}]: ${textParts.join(' ')}`;
        }
        case 'tool_result': {
            const preview = item.output.data.length > 200
                ? item.output.data.slice(0, 200) + '...'
                : item.output.data;
            return `[${item.toolName}]: ${item.output.status} — ${preview}`;
        }
        case 'summary':
            return item.text;
    }
}

/** Build the summarization prompt for a chunk of items. */
function buildSummarizationPrompt(items: ConversationItem[], durableState?: DurableTaskState | null): string {
    const lines: string[] = [
        'Summarize the following conversation segment. Return a JSON object with exactly these fields:',
        '{ "summaryText": "concise summary", "pinnedFacts": ["fact1", ...], "durableStatePatch": {} }',
        '',
        'Rules:',
        '- summaryText: confirmed facts, decisions, files changed, errors and resolutions, user preferences, unresolved problems',
        '- pinnedFacts: key facts to remember (file paths, decisions, constraints)',
        '- durableStatePatch: updates to task state (empty object if none)',
        '- No speculation, commentary, or narrative filler',
        '',
    ];

    if (durableState != null) {
        lines.push('Known task state (do not repeat these facts in summaryText):');
        if (durableState.goal) lines.push(`  Goal: ${durableState.goal}`);
        if (durableState.confirmedFacts.length > 0) lines.push(`  Facts: ${durableState.confirmedFacts.slice(0, 5).join('; ')}`);
        lines.push('');
    }

    lines.push('Conversation:');

    for (const item of items) {
        lines.push(renderItemForPrompt(item));
    }

    return lines.join('\n');
}

/** Render a conversation item for inclusion in the summarization prompt. */
function renderItemForPrompt(item: ConversationItem): string {
    switch (item.kind) {
        case 'message': {
            const textParts: string[] = [];
            for (const p of item.parts) {
                if (p.type === 'text') {
                    textParts.push((p as TextPart).text);
                } else if (p.type === 'tool_call') {
                    const tc = p as ToolCallPart;
                    textParts.push(`[tool_call: ${tc.toolName}(${JSON.stringify(tc.arguments)})]`);
                }
            }
            return `[${item.role}]: ${textParts.join(' ')}`;
        }
        case 'tool_result': {
            const data = item.output.data.length > 500
                ? item.output.data.slice(0, 500) + '...'
                : item.output.data;
            return `[tool_result: ${item.toolName}] ${item.output.status}: ${data}`;
        }
        case 'summary':
            return `[summary]: ${item.text}`;
    }
}

/** Collect all text from a provider stream. */
async function collectStreamText(
    stream: AsyncIterable<StreamEvent>,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of stream) {
        switch (event.type) {
            case 'text_delta':
                text += event.text;
                break;
            case 'done':
                inputTokens = event.usage.inputTokens;
                outputTokens = event.usage.outputTokens;
                break;
            case 'error':
                throw new Error(`Summarization error: ${event.error.message}`);
        }
    }

    return { text, inputTokens, outputTokens };
}

/** Parsed structured response from the summarization LLM call. */
interface SummarizationResponse {
    summaryText: string;
    pinnedFacts: string[];
    durableStatePatch?: DurableStatePatch;
}

/** Parse a JSON response from the summarization LLM call. */
function parseSummarizationResponse(text: string): SummarizationResponse {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        return { summaryText: text.trim(), pinnedFacts: [] };
    }

    try {
        const parsed = JSON.parse(sanitizeModelJson(jsonMatch[0])) as Record<string, unknown>;
        return {
            summaryText: typeof parsed.summaryText === 'string'
                ? parsed.summaryText
                : text.trim(),
            pinnedFacts: Array.isArray(parsed.pinnedFacts)
                ? (parsed.pinnedFacts as unknown[]).filter((f): f is string => typeof f === 'string')
                : [],
            durableStatePatch: normalizeDurableStatePatch(parsed.durableStatePatch),
        };
    } catch {
        return { summaryText: text.trim(), pinnedFacts: [] };
    }
}
