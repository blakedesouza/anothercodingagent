/**
 * Context Assembly Algorithm (Block 7, M3.2).
 *
 * 7-step budget-first, newest-first packing algorithm that determines
 * compression tier, applies turn-boundary packing, and handles
 * oversized tool results via deterministic digests.
 */

import type {
    ConversationItem,
    ToolResultItem,
    ToolCallPart,
} from '../types/conversation.js';
import {
    estimateTextTokens,
    computeSafeInputBudget,
    MESSAGE_OVERHEAD,
    TOOL_CALL_OVERHEAD,
} from './token-estimator.js';
import type { ProjectSnapshot } from './project-awareness.js';
import { renderProjectContext } from './project-awareness.js';
import type { RegisteredTool } from '../tools/tool-registry.js';
import type { ToolDefinition } from '../types/provider.js';

// --- Types ---

export type CompressionTier = 'full' | 'medium' | 'aggressive' | 'emergency';

/** Options for the context assembly algorithm. */
export interface ContextAssemblyOptions {
    /** Model context window size in tokens. */
    contextLimit: number;
    /** Reserved tokens for model output (default: 4096). */
    reservedOutputTokens?: number;
    /** Per-model calibration multiplier (default: 1.0). */
    calibrationMultiplier?: number;
    /** Per-model bytes-per-token ratio (default: 3.0). */
    bytesPerToken?: number;
    /** Full conversation history (all items). */
    items: ConversationItem[];
    /**
     * Estimated tokens for always-pinned non-item sections:
     * system rules, tool signatures, context block, active errors.
     */
    alwaysPinnedTokens: number;
    /**
     * Estimated tokens for conditionally-pinned sections:
     * instruction summary + durable task state. Dropped in emergency tier.
     */
    conditionalPinnedTokens?: number;
}

/** Result of the context assembly algorithm. */
export interface ContextAssemblyResult {
    /** Compression tier applied. */
    tier: CompressionTier;
    /** Items included in the assembled context, in original order. */
    includedItems: ConversationItem[];
    /** Map of item ID → digest text for digested tool results. */
    digestOverrides: Map<string, string>;
    /** Estimated total tokens for the assembled request. */
    estimatedTokens: number;
    /** Safe input budget that was computed. */
    safeInputBudget: number;
    /** Number of history items included (excluding current turn). */
    historyItemCount: number;
    /** Number of history items dropped. */
    droppedItemCount: number;
    /** Number of items downgraded to digest. */
    digestedItemCount: number;
    /** Whether instruction summary is included. */
    instructionSummaryIncluded: boolean;
    /** Whether durable task state is included. */
    durableTaskStateIncluded: boolean;
    /** Warning message (set on emergency compression). */
    warning?: string;
}

// --- Tier detection ---

/**
 * Determine compression tier from the ratio estimatedTotal / contextLimit.
 * < 60% = full, >= 60% = medium, >= 80% = aggressive, >= 90% = emergency.
 */
export function determineTier(ratio: number): CompressionTier {
    if (ratio < 0.6) return 'full';
    if (ratio < 0.8) return 'medium';
    if (ratio < 0.9) return 'aggressive';
    return 'emergency';
}

/** Escalate to the next compression tier. */
export function escalateTier(tier: CompressionTier): CompressionTier {
    switch (tier) {
        case 'full': return 'medium';
        case 'medium': return 'aggressive';
        case 'aggressive': return 'emergency';
        case 'emergency': return 'emergency';
    }
}

// --- Tier action functions ---

/**
 * Maximum number of completed turns to keep verbatim at each tier.
 * Summarization (M3.4) handles the rest; until then, older turns are dropped.
 */
export function getVerbatimTurnLimit(tier: CompressionTier): number {
    switch (tier) {
        case 'full': return Infinity;
        case 'medium': return 6;
        case 'aggressive': return 3;
        case 'emergency': return 0;
    }
}

/** Warning message for emergency compression, to be emitted to stderr by the caller. */
export const EMERGENCY_WARNING_MESSAGE =
    'Context limit reached — operating with minimal history. Consider starting a new session or breaking the task into smaller pieces.';

/**
 * Render project snapshot with tier-appropriate detail.
 * - full: complete renderProjectContext output
 * - medium: root + stack + git only (no ignore paths, no index status)
 * - aggressive: stack one-liner + git branch only
 * - emergency: empty (dropped entirely)
 */
export function renderProjectForTier(
    tier: CompressionTier,
    snapshot: ProjectSnapshot,
): string {
    switch (tier) {
        case 'full':
            return renderProjectContext(snapshot);
        case 'medium': {
            const lines: string[] = [];
            lines.push(`Project root: ${snapshot.root}`);
            if (snapshot.stack.length > 0) {
                lines.push(`Stack: ${snapshot.stack.join(', ')}`);
            }
            if (snapshot.git) {
                lines.push(`Git: branch=${snapshot.git.branch}, ${snapshot.git.status}`);
            }
            return lines.join('\n');
        }
        case 'aggressive': {
            const lines: string[] = [];
            if (snapshot.stack.length > 0) {
                lines.push(`Stack: ${snapshot.stack.join(', ')}`);
            }
            if (snapshot.git) {
                lines.push(`Git: ${snapshot.git.branch}`);
            }
            return lines.join('\n');
        }
        case 'emergency':
            return '';
    }
}

/**
 * Build tool definitions with tier-appropriate verbosity.
 * - full/medium: complete definitions (name + description + full parameter schema)
 * - aggressive: short-form (name + first-sentence description + param names only)
 * - emergency: signatures only (name + full schema, no description)
 */
export function buildToolDefsForTier(
    tier: CompressionTier,
    tools: RegisteredTool[],
): ToolDefinition[] {
    switch (tier) {
        case 'full':
        case 'medium':
            return tools.map(t => ({
                name: t.spec.name,
                description: t.spec.description,
                parameters: t.spec.inputSchema,
            }));
        case 'aggressive':
            return tools.map(t => ({
                name: t.spec.name,
                description: getFirstSentence(t.spec.description),
                parameters: stripSchemaDescriptions(t.spec.inputSchema),
            }));
        case 'emergency':
            return tools.map(t => ({
                name: t.spec.name,
                description: '',
                parameters: t.spec.inputSchema,
            }));
    }
}

/** Context block section flags for each compression tier. */
export interface TierContextFlags {
    /** OS and shell information. */
    includeOsShell: boolean;
    /** Current working directory. */
    includeCwd: boolean;
    /** Project snapshot section (detail level determined by renderProjectForTier). */
    includeProjectSnapshot: boolean;
    /** Working set (active files) section. */
    includeWorkingSet: boolean;
    /** Capability health section. */
    includeCapabilityHealth: boolean;
    /** User/repo instruction text. */
    includeUserInstructions: boolean;
    /** Durable task state section. */
    includeDurableTaskState: boolean;
    // Active errors are always included — no flag needed.
}

/**
 * Get context block section inclusion flags for a compression tier.
 * Active errors are always included (no flag).
 */
export function getTierContextFlags(tier: CompressionTier): TierContextFlags {
    switch (tier) {
        case 'full':
        case 'medium':
            return {
                includeOsShell: true,
                includeCwd: true,
                includeProjectSnapshot: true,
                includeWorkingSet: true,
                includeCapabilityHealth: true,
                includeUserInstructions: true,
                includeDurableTaskState: true,
            };
        case 'aggressive':
            return {
                includeOsShell: false,
                includeCwd: true,
                includeProjectSnapshot: true,
                includeWorkingSet: false,
                includeCapabilityHealth: false,
                includeUserInstructions: true,
                includeDurableTaskState: true,
            };
        case 'emergency':
            return {
                includeOsShell: false,
                includeCwd: false,
                includeProjectSnapshot: false,
                includeWorkingSet: false,
                includeCapabilityHealth: false,
                includeUserInstructions: false,
                includeDurableTaskState: false,
            };
    }
}

// --- Tier action helpers (internal) ---

/** Extract first sentence from description text. */
function getFirstSentence(text: string): string {
    if (!text) return '';
    const match = text.match(/^[^.!?]+[.!?]/);
    return match ? match[0].trim() : text.split('\n')[0].trim();
}

/**
 * Strip description and example fields from top-level JSON Schema properties.
 * Note: only strips from `properties.*` — nested descriptions inside `items`
 * or sub-`properties` survive. Sufficient for v1 (no current tools use nested
 * schemas). If nested schemas are added, make this recursive.
 */
function stripSchemaDescriptions(schema: Record<string, unknown>): Record<string, unknown> {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (!properties) return { ...schema };

    const stripped: Record<string, Record<string, unknown>> = {};
    for (const [name, prop] of Object.entries(properties)) {
        const slim: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(prop)) {
            if (key !== 'description' && key !== 'examples' && key !== 'example') {
                slim[key] = value;
            }
        }
        stripped[name] = slim;
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === 'properties') {
            result[key] = stripped;
        } else {
            result[key] = value;
        }
    }
    return result;
}

// --- Item token estimation ---

/**
 * Estimate token count for a single conversation item.
 * Uses the byte-based heuristic + structural overheads.
 */
export function estimateItemTokens(
    item: ConversationItem,
    bytesPerToken: number = 3.0,
    calibrationMultiplier: number = 1.0,
): number {
    let raw = 0;

    switch (item.kind) {
        case 'message': {
            raw += MESSAGE_OVERHEAD;
            for (const part of item.parts) {
                if (part.type === 'text') {
                    raw += estimateTextTokens(part.text, bytesPerToken);
                } else if (part.type === 'tool_call') {
                    const tc = part as ToolCallPart;
                    raw += TOOL_CALL_OVERHEAD;
                    if (tc.arguments) {
                        raw += estimateTextTokens(JSON.stringify(tc.arguments), bytesPerToken);
                    }
                }
            }
            break;
        }
        case 'tool_result': {
            raw += TOOL_CALL_OVERHEAD;
            const payload = JSON.stringify({
                status: item.output.status,
                data: item.output.data,
                error: item.output.error,
            });
            raw += estimateTextTokens(payload, bytesPerToken);
            break;
        }
        case 'summary': {
            raw += MESSAGE_OVERHEAD;
            raw += estimateTextTokens(
                `[Summary of earlier conversation]\n${item.text}`,
                bytesPerToken,
            );
            break;
        }
    }

    return Math.ceil(raw * calibrationMultiplier);
}

// --- Turn grouping ---

/**
 * Group conversation items into turns. A turn starts with a user message
 * and includes all subsequent items until the next user message.
 * Items before the first user message form a preamble group.
 */
export function groupIntoTurns(items: ConversationItem[]): ConversationItem[][] {
    if (items.length === 0) return [];

    const turns: ConversationItem[][] = [];
    let current: ConversationItem[] = [];

    for (const item of items) {
        if (item.kind === 'message' && item.role === 'user') {
            if (current.length > 0) {
                turns.push(current);
            }
            current = [item];
        } else {
            current.push(item);
        }
    }

    if (current.length > 0) {
        turns.push(current);
    }

    return turns;
}

// --- Digest computation ---

/**
 * Find tool call arguments by matching toolCallId across conversation items.
 */
export function findToolCallArgs(
    items: ConversationItem[],
    toolCallId: string,
): Record<string, unknown> | undefined {
    for (const item of items) {
        if (item.kind === 'message' && item.role === 'assistant') {
            for (const part of item.parts) {
                if (part.type === 'tool_call') {
                    const tc = part as ToolCallPart;
                    if (tc.toolCallId === toolCallId) {
                        return tc.arguments;
                    }
                }
            }
        }
    }
    return undefined;
}

/**
 * Compute a deterministic digest for a tool result item.
 * Digests are tool-specific and typically 50-150 tokens.
 */
export function computeDigest(
    item: ToolResultItem,
    toolCallArgs?: Record<string, unknown>,
): string {
    const { toolName, output } = item;
    const args = toolCallArgs ?? {};

    switch (toolName) {
        case 'read_file': {
            const filePath = (args.file_path ?? args.path ?? 'unknown') as string;
            const startLine = (args.start_line ?? args.offset) as number | undefined;
            const endLine = (args.end_line ?? args.limit) as number | undefined;
            const lineRange = startLine != null && endLine != null
                ? `lines ${startLine}-${endLine}`
                : startLine != null
                    ? `from line ${startLine}`
                    : 'all lines';
            const totalLines = countLines(output.data);
            return `read_file: ${filePath} (${lineRange}, ${totalLines} lines total)\n[content omitted — use read_file to re-read]`;
        }
        case 'exec_command': {
            const command = (args.command ?? 'unknown command') as string;
            const parsed = tryParseJson(output.data);
            const exitCode = parsed?.exit_code ?? (output.status === 'error' ? 1 : 0);
            const stderr = parsed?.stderr as string | undefined;
            const stderrLine = stderr
                ? extractFirstLine(stderr)
                : undefined;
            let result = `exec_command: \`${command}\`\nExit code: ${exitCode}`;
            if (stderrLine) {
                result += `\nError: ${stderrLine}`;
            }
            if (output.bytesOmitted > 0) {
                result += `\n${output.bytesOmitted} bytes omitted`;
            }
            return result;
        }
        case 'search_text': {
            const query = (args.query ?? args.pattern ?? 'unknown') as string;
            const lines = extractNonEmptyLines(output.data);
            const matchCount = lines.length;
            const topPaths = lines.slice(0, 3).join(', ');
            let result = `search_text: "${query}" — ${matchCount} matches`;
            if (topPaths) result += `\nTop: ${topPaths}`;
            return result;
        }
        case 'find_paths': {
            const pattern = (args.pattern ?? args.glob ?? 'unknown') as string;
            const lines = extractNonEmptyLines(output.data);
            const matchCount = lines.length;
            const topPaths = lines.slice(0, 3).join(', ');
            let result = `find_paths: "${pattern}" — ${matchCount} matches`;
            if (topPaths) result += `\nTop: ${topPaths}`;
            return result;
        }
        case 'lsp_query': {
            const operation = (args.operation ?? 'unknown') as string;
            const target = (args.target ?? args.symbol ?? 'unknown') as string;
            const lines = extractNonEmptyLines(output.data);
            const resultCount = lines.length;
            let result = `lsp_query: ${operation} on ${target} — ${resultCount} results`;
            if (lines[0]) result += `\nFirst: ${lines[0]}`;
            return result;
        }
        default: {
            const size = output.bytesReturned + output.bytesOmitted;
            return `${toolName}: ${output.status} (${size} bytes)\n[result omitted]`;
        }
    }
}

// --- Digest helpers ---

function countLines(text: string): number {
    if (!text) return 0;
    return text.split('\n').length;
}

function extractNonEmptyLines(text: string): string[] {
    if (!text) return [];
    return text.split('\n').filter(l => l.trim().length > 0);
}

function extractFirstLine(text: string): string | undefined {
    if (!text) return undefined;
    const line = text.split('\n').find(l => l.trim().length > 0);
    return line?.trim();
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
    try {
        const parsed = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    } catch {
        return undefined;
    }
}

// --- Packing algorithm ---

interface PackResult {
    includedItems: ConversationItem[];
    digestOverrides: Map<string, string>;
    estimatedTokens: number;
    historyItemCount: number;
    droppedItemCount: number;
    digestedItemCount: number;
    instructionSummaryIncluded: boolean;
    durableTaskStateIncluded: boolean;
}

/**
 * Estimate tokens for a digest string (overhead + text).
 */
function estimateDigestTokens(digest: string, bytesPerToken: number, calibrationMultiplier: number): number {
    return Math.ceil((TOOL_CALL_OVERHEAD + estimateTextTokens(digest, bytesPerToken)) * calibrationMultiplier);
}

/**
 * Pack conversation items into the budget for a given tier.
 * Returns which items are included and any digest overrides.
 */
function pack(
    tier: CompressionTier,
    budget: number,
    alwaysPinnedTokens: number,
    conditionalPinnedTokens: number,
    currentTurnItems: ConversationItem[],
    currentTurnTokens: number,
    completedTurns: Array<{ items: ConversationItem[]; tokens: number }>,
    bytesPerToken: number,
    calibrationMultiplier: number,
    allItems: ConversationItem[],
): PackResult {
    const digestOverrides = new Map<string, string>();
    let digestedItemCount = 0;

    // Emergency tier drops conditional pinned sections
    const includeConditional = tier !== 'emergency';
    const pinnedTokens = alwaysPinnedTokens + (includeConditional ? conditionalPinnedTokens : 0);

    // Budget available for all conversation items (guard against negative)
    const itemBudget = Math.max(0, budget - pinnedTokens);
    // 25% threshold for single-item guard (spec: "any item > 25% of remaining budget")
    const singleItemThreshold = itemBudget * 0.25;

    // Current turn is always included. Apply 25% guard at ALL tiers.
    let adjustedCurrentTurnTokens = currentTurnTokens;
    for (const item of currentTurnItems) {
        if (item.kind === 'tool_result') {
            const itemTokens = estimateItemTokens(item, bytesPerToken, calibrationMultiplier);
            if (itemTokens > singleItemThreshold) {
                const args = findToolCallArgs(allItems, item.toolCallId);
                const digest = computeDigest(item, args);
                digestOverrides.set(item.id, digest);
                digestedItemCount++;
                const digestTokens = estimateDigestTokens(digest, bytesPerToken, calibrationMultiplier);
                adjustedCurrentTurnTokens -= (itemTokens - digestTokens);
            }
        }
    }

    // Remaining budget for completed turn history
    let remainingBudget = itemBudget - adjustedCurrentTurnTokens;
    const includedHistoryTurns: ConversationItem[][] = [];
    let historyItemCount = 0;
    let droppedItemCount = 0;

    if (tier !== 'emergency') {
        const maxVerbatimTurns = getVerbatimTurnLimit(tier);
        let includedTurnCount = 0;
        // Pack completed turns newest-first
        for (let i = completedTurns.length - 1; i >= 0; i--) {
            const turn = completedTurns[i];

            // Enforce tier-specific verbatim turn limit
            if (includedTurnCount >= maxVerbatimTurns) {
                droppedItemCount += turn.items.length;
                continue;
            }

            // Check for oversized items within the turn.
            // Use dynamic threshold based on remaining budget (spec: ">25% of remaining budget").
            const turnItemThreshold = remainingBudget * 0.25;
            let adjustedTurnTokens = turn.tokens;
            const turnDigests: Array<{ id: string; digest: string; saved: number }> = [];

            for (const item of turn.items) {
                if (item.kind === 'tool_result') {
                    const itemTokens = estimateItemTokens(item, bytesPerToken, calibrationMultiplier);
                    if (itemTokens > turnItemThreshold) {
                        const args = findToolCallArgs(allItems, item.toolCallId);
                        const digest = computeDigest(item, args);
                        const digestTokens = estimateDigestTokens(digest, bytesPerToken, calibrationMultiplier);
                        const saved = itemTokens - digestTokens;
                        turnDigests.push({ id: item.id, digest, saved });
                        adjustedTurnTokens -= saved;
                    }
                }
            }

            // Turn boundary: include whole turn or none
            if (adjustedTurnTokens <= remainingBudget) {
                includedHistoryTurns.unshift(turn.items);
                remainingBudget -= adjustedTurnTokens;
                historyItemCount += turn.items.length;
                includedTurnCount++;
                for (const { id, digest } of turnDigests) {
                    digestOverrides.set(id, digest);
                    digestedItemCount++;
                }
            } else {
                droppedItemCount += turn.items.length;
            }
        }
    } else {
        // Emergency: all completed turns dropped
        for (const turn of completedTurns) {
            droppedItemCount += turn.items.length;
        }
    }

    // Build final included items in original order
    const includedItems: ConversationItem[] = [
        ...includedHistoryTurns.flat(),
        ...currentTurnItems,
    ];

    // Calculate total estimated tokens
    let historyTokens = 0;
    for (const item of includedHistoryTurns.flat()) {
        if (digestOverrides.has(item.id)) {
            historyTokens += estimateDigestTokens(digestOverrides.get(item.id)!, bytesPerToken, calibrationMultiplier);
        } else {
            historyTokens += estimateItemTokens(item, bytesPerToken, calibrationMultiplier);
        }
    }
    const estimatedTokens = pinnedTokens + adjustedCurrentTurnTokens + historyTokens;

    return {
        includedItems,
        digestOverrides,
        estimatedTokens,
        historyItemCount,
        droppedItemCount,
        digestedItemCount,
        instructionSummaryIncluded: includeConditional,
        durableTaskStateIncluded: includeConditional,
    };
}

// --- Main algorithm ---

/**
 * Context Assembly Algorithm (7 steps).
 *
 * 1. Compute safe input budget
 * 2. Identify turns and pinned sections
 * 3. Estimate full uncompressed request → determine tier
 * 4. Apply tier actions (emergency drops conditional pinned)
 * 5. Pack history newest-first by turn boundary
 * 6. Single-item budget guard (>25% → digest)
 * 7. Verify fit → escalate if needed
 */
export function assembleContext(options: ContextAssemblyOptions): ContextAssemblyResult {
    const {
        contextLimit,
        reservedOutputTokens = 4096,
        calibrationMultiplier = 1.0,
        bytesPerToken = 3.0,
        items,
        alwaysPinnedTokens,
        conditionalPinnedTokens = 0,
    } = options;

    // Step 1: Compute safe input budget
    const safeInputBudget = computeSafeInputBudget(contextLimit, reservedOutputTokens);

    // Step 2: Identify turns
    const turns = groupIntoTurns(items);
    const currentTurnItems = turns.length > 0 ? turns[turns.length - 1] : [];
    const completedTurns = turns.length > 1 ? turns.slice(0, -1) : [];

    // Estimate per-turn tokens
    const currentTurnTokens = currentTurnItems.reduce(
        (sum, item) => sum + estimateItemTokens(item, bytesPerToken, calibrationMultiplier), 0,
    );
    const completedTurnEstimates = completedTurns.map(turnItems => ({
        items: turnItems,
        tokens: turnItems.reduce(
            (sum, item) => sum + estimateItemTokens(item, bytesPerToken, calibrationMultiplier), 0,
        ),
    }));
    const totalCompletedTokens = completedTurnEstimates.reduce((sum, t) => sum + t.tokens, 0);

    // Step 3: Estimate full uncompressed request and determine initial tier
    const fullEstimate = alwaysPinnedTokens + conditionalPinnedTokens + currentTurnTokens + totalCompletedTokens;
    const ratio = fullEstimate / contextLimit;
    let tier = determineTier(ratio);

    // Steps 4-6: Pack with current tier
    let result = pack(
        tier, safeInputBudget, alwaysPinnedTokens, conditionalPinnedTokens,
        currentTurnItems, currentTurnTokens, completedTurnEstimates,
        bytesPerToken, calibrationMultiplier, items,
    );

    // Step 7: Verify fit → escalate if needed
    while (result.estimatedTokens > safeInputBudget && tier !== 'emergency') {
        tier = escalateTier(tier);
        result = pack(
            tier, safeInputBudget, alwaysPinnedTokens, conditionalPinnedTokens,
            currentTurnItems, currentTurnTokens, completedTurnEstimates,
            bytesPerToken, calibrationMultiplier, items,
        );
    }

    const warning = tier === 'emergency' ? 'emergency_compression' : undefined;

    return {
        tier,
        includedItems: result.includedItems,
        digestOverrides: result.digestOverrides,
        estimatedTokens: result.estimatedTokens,
        safeInputBudget,
        historyItemCount: result.historyItemCount,
        droppedItemCount: result.droppedItemCount,
        digestedItemCount: result.digestedItemCount,
        instructionSummaryIncluded: result.instructionSummaryIncluded,
        durableTaskStateIncluded: result.durableTaskStateIncluded,
        warning,
    };
}
