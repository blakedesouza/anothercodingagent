/**
 * Durable task state (Block 7, M3.5).
 *
 * Structured session-level metadata stored in manifest.json that survives
 * conversation summarization. Updated at turn end via deterministic extraction
 * plus an optional LLM patch call.
 */

import type {
    ConversationItem,
    ToolCallPart,
    TextPart,
} from '../types/conversation.js';
import type { ProviderDriver, ModelRequest } from '../types/provider.js';
import { generateId } from '../types/ids.js';
import { normalizeTrackedPath, normalizeTrackedPaths } from './path-normalization.js';
import { sanitizeModelJson } from '../providers/tool-emulation.js';

// --- Types ---

export interface OpenLoop {
    id: string;
    text: string;
    status: 'open' | 'blocked' | 'waiting_user' | 'done';
    files?: string[];
}

export interface DurableTaskState {
    goal: string | null;
    constraints: string[];
    confirmedFacts: string[];
    decisions: string[];
    openLoops: OpenLoop[];
    blockers: string[];
    filesOfInterest: string[];
    revision: number;
    stale: boolean;
}

// --- Turn facts (inputs for deterministic update) ---

export interface TurnToolError {
    toolName: string;
    errorSummary: string;
    filePath?: string;
}

export interface TurnApprovalDenied {
    toolName: string;
    argsSummary: string;
}

export interface TurnFacts {
    modifiedFiles: string[];
    toolErrors: TurnToolError[];
    approvalsDenied: TurnApprovalDenied[];
    mentionedFiles: string[];
}

// --- LLM patch schema ---

export interface DurableStatePatch {
    goal?: string | null;
    constraintsAdd?: string[];
    constraintsRemove?: string[];
    confirmedFactsAdd?: string[];
    decisionsAdd?: string[];
    openLoopsUpdate?: Array<{ id: string; status: OpenLoop['status'] }>;
    openLoopsAdd?: OpenLoop[];
    blockersAdd?: string[];
    blockersRemove?: string[];
    filesOfInterestAdd?: string[];
}

function hasPatchFields(patch: DurableStatePatch): boolean {
    return Object.keys(patch).length > 0;
}

// --- Constants ---

// Tools whose successful execution means files were modified
const FILE_MODIFICATION_TOOLS = new Set(['write_file', 'edit_file', 'delete_path', 'move_path']);

// Match file paths in user messages: relative (src/foo.ts, ./foo/bar.ts, ../foo),
// or absolute (/foo/bar.ts). Negative lookbehind excludes URL segments (e.g. "://").
// Best-effort extraction — false negatives acceptable, false positives are low-risk.
const FILE_PATH_RE = /(?<![:/])((?:\/|\.\.?\/)?(?:[\w.-]+\/)+[\w.-]+\.\w{1,10})\b/g;

// Maximum number of files to track in filesOfInterest — prevents unbounded manifest growth
const MAX_FILES_OF_INTEREST = 50;

// Maximum number of open loops to retain — prevents unbounded state growth on long sessions.
// Done loops are pruned first; active loops kept up to this cap (newest wins).
const MAX_OPEN_LOOPS = 100;

const VALID_LOOP_STATUSES = new Set<string>(['open', 'blocked', 'waiting_user', 'done']);

// --- Helpers ---

function dedup(arr: string[]): string[] {
    return [...new Set(arr)];
}

function addUnique(arr: string[], items: string[]): string[] {
    return dedup([...arr, ...items]);
}

function shouldTrackToolError(
    toolName: string,
    errorCode: string | undefined,
    filePath: string | undefined,
    modifiedFilesThisTurn: ReadonlySet<string>,
): boolean {
    if (errorCode === 'tool.deferred') {
        return false;
    }
    if (
        errorCode === 'tool.validation'
        && toolName === 'read_file'
        && filePath !== undefined
        && modifiedFilesThisTurn.has(filePath)
    ) {
        return false;
    }
    return true;
}

// --- Initial State ---

export function createInitialDurableTaskState(): DurableTaskState {
    return {
        goal: null,
        constraints: [],
        confirmedFacts: [],
        decisions: [],
        openLoops: [],
        blockers: [],
        filesOfInterest: [],
        revision: 0,
        stale: false,
    };
}

// --- Extract Turn Facts ---

/**
 * Deterministically extract facts from a completed turn's conversation items.
 * No LLM call — pure data extraction from tool calls, tool results, and user messages.
 */
export function extractTurnFacts(turnItems: ConversationItem[], workspaceRoot?: string): TurnFacts {
    // Build a lookup: toolCallId → { toolName, args }
    const toolCallArgs = new Map<string, { toolName: string; args: Record<string, unknown> }>();
    for (const item of turnItems) {
        if (item.kind === 'message' && item.role === 'assistant') {
            for (const part of item.parts) {
                if (part.type === 'tool_call') {
                    const tc = part as ToolCallPart;
                    toolCallArgs.set(tc.toolCallId, { toolName: tc.toolName, args: tc.arguments });
                }
            }
        }
    }

    const modifiedFiles: string[] = [];
    const modifiedFilesThisTurn = new Set<string>();
    const toolErrors: TurnToolError[] = [];
    const approvalsDenied: TurnApprovalDenied[] = [];
    const mentionedFiles: string[] = [];

    for (const item of turnItems) {
        if (item.kind === 'tool_result') {
            const call = toolCallArgs.get(item.toolCallId);
            const args = call?.args ?? {};

            // Successful file modifications → modifiedFiles
            if (item.output.status === 'success' && FILE_MODIFICATION_TOOLS.has(item.toolName)) {
                if (typeof args.path === 'string') {
                    const path = String(args.path);
                    modifiedFiles.push(path);
                    const normalizedPath = normalizeTrackedPath(path, workspaceRoot);
                    if (normalizedPath) modifiedFilesThisTurn.add(normalizedPath);
                }
                if (typeof args.source === 'string') {
                    const source = String(args.source);
                    modifiedFiles.push(source);
                    const normalizedSource = normalizeTrackedPath(source, workspaceRoot);
                    if (normalizedSource) modifiedFilesThisTurn.add(normalizedSource);
                }
                if (typeof args.destination === 'string') {
                    const destination = String(args.destination);
                    modifiedFiles.push(destination);
                    const normalizedDestination = normalizeTrackedPath(destination, workspaceRoot);
                    if (normalizedDestination) modifiedFilesThisTurn.add(normalizedDestination);
                }
            }

            // Tool errors → toolErrors
            if (item.output.status === 'error') {
                const errorCode = item.output.error?.code;
                const errorSummary = item.output.error?.message ?? item.output.data.slice(0, 120);
                const filePathRaw =
                    typeof args.path === 'string' ? args.path :
                    typeof args.source === 'string' ? args.source :
                    undefined;
                const filePath = filePathRaw ? normalizeTrackedPath(filePathRaw, workspaceRoot) : undefined;
                if (shouldTrackToolError(item.toolName, errorCode, filePath, modifiedFilesThisTurn)) {
                    toolErrors.push({ toolName: item.toolName, errorSummary, filePath });
                }
            }

            // Approval denials — yieldOutcome fires for all confirm_action calls;
            // the actual denial is data.approved === false in the JSON payload.
            if (item.output.yieldOutcome === 'approval_required') {
                let isDenied = false;
                try {
                    const parsed = JSON.parse(item.output.data) as Record<string, unknown>;
                    isDenied = parsed.approved === false;
                } catch {
                    // Non-JSON data: cannot determine denial
                }
                if (isDenied) {
                    const argsSummary = Object.entries(args)
                        .slice(0, 3)
                        .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`)
                        .join(', ');
                    approvalsDenied.push({ toolName: item.toolName, argsSummary });
                }
            }
        } else if (item.kind === 'message' && item.role === 'user') {
            // Extract file paths from user message text
            for (const part of item.parts) {
                if (part.type === 'text') {
                    const text = (part as TextPart).text;
                    const matches = text.matchAll(FILE_PATH_RE);
                    for (const match of matches) {
                        mentionedFiles.push(match[1]);
                    }
                }
            }
        }
    }

    return {
        modifiedFiles: dedup(normalizeTrackedPaths(modifiedFiles, workspaceRoot)),
        toolErrors,
        approvalsDenied,
        mentionedFiles: dedup(normalizeTrackedPaths(mentionedFiles, workspaceRoot)),
    };
}

// --- Deterministic Updates ---

/**
 * Apply deterministic updates from turn runtime facts.
 * Pure function — returns a new state object. Always increments revision.
 */
export function applyDeterministicUpdates(
    state: DurableTaskState,
    facts: TurnFacts,
): DurableTaskState {
    let openLoops = [...state.openLoops];
    let blockers = [...state.blockers];
    let filesOfInterest = [...state.filesOfInterest];

    // Modified and mentioned files → filesOfInterest
    const allNewFiles = [...facts.modifiedFiles, ...facts.mentionedFiles];
    if (allNewFiles.length > 0) {
        filesOfInterest = addUnique(filesOfInterest, allNewFiles);
    }

    // Tool errors → open loops (+ file to filesOfInterest if identifiable)
    for (const err of facts.toolErrors) {
        openLoops.push({
            id: generateId('item'),
            text: `${err.toolName} failed: ${err.errorSummary}`,
            status: 'open',
            files: err.filePath ? [err.filePath] : undefined,
        });
        if (err.filePath) {
            filesOfInterest = addUnique(filesOfInterest, [err.filePath]);
        }
    }

    // Approval denials → blocked loops + blockers
    for (const denied of facts.approvalsDenied) {
        const text = `approval denied for ${denied.toolName}(${denied.argsSummary})`;
        openLoops.push({
            id: generateId('item'),
            text,
            status: 'blocked',
        });
        blockers = addUnique(blockers, [text]);
    }

    // Enforce filesOfInterest cap — keep most recent entries when limit exceeded
    if (filesOfInterest.length > MAX_FILES_OF_INTEREST) {
        filesOfInterest = filesOfInterest.slice(-MAX_FILES_OF_INTEREST);
    }

    // Enforce openLoops cap — prune done loops first, then oldest active loops
    if (openLoops.length > MAX_OPEN_LOOPS) {
        const active = openLoops.filter(l => l.status !== 'done');
        openLoops = active.length > MAX_OPEN_LOOPS ? active.slice(-MAX_OPEN_LOOPS) : active;
    }

    return {
        ...state,
        openLoops,
        blockers,
        filesOfInterest,
        revision: state.revision + 1,
        // Preserve stale — only a successful LLM patch may clear it
        stale: state.stale,
    };
}

// --- LLM Patch ---

/**
 * Apply a parsed LLM patch to the durable task state.
 * Pure function — returns a new state object.
 */
export function applyLlmPatch(
    state: DurableTaskState,
    patch: DurableStatePatch,
): DurableTaskState {
    let { goal, constraints, confirmedFacts, decisions, openLoops, blockers, filesOfInterest } = state;

    if ('goal' in patch) goal = patch.goal ?? null;

    if (patch.constraintsAdd?.length) constraints = addUnique(constraints, patch.constraintsAdd);
    if (patch.constraintsRemove?.length) {
        const removeSet = new Set(patch.constraintsRemove);
        constraints = constraints.filter(c => !removeSet.has(c));
    }

    if (patch.confirmedFactsAdd?.length) confirmedFacts = addUnique(confirmedFacts, patch.confirmedFactsAdd);
    if (patch.decisionsAdd?.length) decisions = addUnique(decisions, patch.decisionsAdd);
    if (patch.filesOfInterestAdd?.length) filesOfInterest = addUnique(filesOfInterest, patch.filesOfInterestAdd);

    if (patch.blockersAdd?.length) blockers = addUnique(blockers, patch.blockersAdd);
    if (patch.blockersRemove?.length) {
        const removeSet = new Set(patch.blockersRemove);
        blockers = blockers.filter(b => !removeSet.has(b));
    }

    if (patch.openLoopsAdd?.length) openLoops = [...openLoops, ...patch.openLoopsAdd];
    if (patch.openLoopsUpdate?.length) {
        const updates = new Map(patch.openLoopsUpdate.map(u => [u.id, u.status]));

        // When loops are marked done, remove their text from blockers — but only if no
        // OTHER blocked loop still uses that text (prevents cross-deletion when two
        // denials produce identical text).
        const doneIds = new Set(
            patch.openLoopsUpdate.filter(u => u.status === 'done').map(u => u.id),
        );
        if (doneIds.size > 0) {
            const doneTexts = new Set(
                state.openLoops.filter(l => doneIds.has(l.id)).map(l => l.text),
            );
            const remainingBlockedTexts = new Set(
                state.openLoops
                    .filter(l => !doneIds.has(l.id) && l.status === 'blocked')
                    .map(l => l.text),
            );
            blockers = blockers.filter(b => !doneTexts.has(b) || remainingBlockedTexts.has(b));
        }

        openLoops = openLoops.map(loop =>
            updates.has(loop.id) ? { ...loop, status: updates.get(loop.id)! } : loop,
        );
    }

    // Enforce caps — same as applyDeterministicUpdates to prevent LLM-driven unbounded growth
    if (filesOfInterest.length > MAX_FILES_OF_INTEREST) {
        filesOfInterest = filesOfInterest.slice(-MAX_FILES_OF_INTEREST);
    }
    if (openLoops.length > MAX_OPEN_LOOPS) {
        const active = openLoops.filter(l => l.status !== 'done');
        openLoops = active.length > MAX_OPEN_LOOPS ? active.slice(-MAX_OPEN_LOOPS) : active;
    }

    return { ...state, goal, constraints, confirmedFacts, decisions, openLoops, blockers, filesOfInterest };
}

export function applyDurableStatePatchUpdate(
    state: DurableTaskState,
    patch: DurableStatePatch,
): DurableTaskState {
    if (!hasPatchFields(patch)) {
        return state;
    }

    const updated = applyLlmPatch(state, patch);
    return {
        ...updated,
        revision: state.revision + 1,
        stale: false,
    };
}

// --- Internal LLM helpers ---

export function normalizeDurableStatePatch(raw: unknown): DurableStatePatch {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return {};
    }

    const obj = raw as Record<string, unknown>;
    const patch: DurableStatePatch = {};

    if ('goal' in obj) patch.goal = typeof obj.goal === 'string' ? obj.goal : null;

    const toStrArr = (v: unknown): string[] =>
        Array.isArray(v) ? (v as unknown[]).filter((s): s is string => typeof s === 'string') : [];

    if (obj.constraintsAdd) patch.constraintsAdd = toStrArr(obj.constraintsAdd);
    if (obj.constraintsRemove) patch.constraintsRemove = toStrArr(obj.constraintsRemove);
    if (obj.confirmedFactsAdd) patch.confirmedFactsAdd = toStrArr(obj.confirmedFactsAdd);
    if (obj.decisionsAdd) patch.decisionsAdd = toStrArr(obj.decisionsAdd);
    if (obj.filesOfInterestAdd) patch.filesOfInterestAdd = toStrArr(obj.filesOfInterestAdd);
    if (obj.blockersAdd) patch.blockersAdd = toStrArr(obj.blockersAdd);
    if (obj.blockersRemove) patch.blockersRemove = toStrArr(obj.blockersRemove);

    if (Array.isArray(obj.openLoopsAdd)) {
        patch.openLoopsAdd = (obj.openLoopsAdd as unknown[])
            .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
            .map(v => ({
                id: typeof v.id === 'string' ? v.id : generateId('item'),
                text: typeof v.text === 'string' ? v.text : '',
                status: VALID_LOOP_STATUSES.has(v.status as string)
                    ? v.status as OpenLoop['status']
                    : 'open',
                files: Array.isArray(v.files)
                    ? (v.files as unknown[]).filter((f): f is string => typeof f === 'string')
                    : undefined,
            }));
    }

    if (Array.isArray(obj.openLoopsUpdate)) {
        patch.openLoopsUpdate = (obj.openLoopsUpdate as unknown[])
            .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
            .map(v => ({
                id: typeof v.id === 'string' ? v.id : '',
                status: VALID_LOOP_STATUSES.has(v.status as string)
                    ? v.status as OpenLoop['status']
                    : 'open',
            }))
            .filter(u => u.id !== '');
    }

    return patch;
}

/** Parse an LLM patch JSON response. Returns empty patch on failure. */
function parseLlmPatchResponse(text: string): DurableStatePatch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    try {
        const raw = JSON.parse(sanitizeModelJson(jsonMatch[0])) as Record<string, unknown>;
        return normalizeDurableStatePatch(raw);
    } catch {
        return {};
    }
}

/** Build the LLM patch prompt (~2K tokens). */
function buildLlmPatchPrompt(
    state: DurableTaskState,
    turnItems: ConversationItem[],
    facts: TurnFacts,
): string {
    const lines: string[] = [
        'Update the durable task state based on this turn. Return a JSON patch with any of these fields:',
        '{ "goal": "...", "constraintsAdd": [...], "constraintsRemove": [...],',
        '  "confirmedFactsAdd": [...], "decisionsAdd": [...],',
        '  "openLoopsUpdate": [{"id":"...","status":"done"}],',
        '  "openLoopsAdd": [{"id":"...","text":"...","status":"open"}],',
        '  "blockersAdd": [...], "blockersRemove": [...], "filesOfInterestAdd": [...] }',
        '',
        'Only include fields that need to change. Return only the JSON object.',
        '',
        'Current state:',
        JSON.stringify({
            goal: state.goal,
            constraints: state.constraints,
            confirmedFacts: state.confirmedFacts.slice(0, 10),
            decisions: state.decisions.slice(0, 10),
            openLoops: state.openLoops.filter(l => l.status !== 'done').slice(0, 10),
            blockers: state.blockers,
        }, null, 2),
        '',
        'Runtime facts (from tool results):',
        `  Modified files: ${facts.modifiedFiles.join(', ') || '(none)'}`,
    ];

    if (facts.toolErrors.length > 0) {
        lines.push(`  Tool errors: ${facts.toolErrors.slice(0, 5).map(e => `${e.toolName}: ${e.errorSummary.slice(0, 80)}`).join('; ')}`);
    }
    if (facts.approvalsDenied.length > 0) {
        lines.push(`  Approval denials: ${facts.approvalsDenied.map(d => d.toolName).join(', ')}`);
    }

    lines.push('', 'Turn:');

    for (const item of turnItems) {
        if (item.kind === 'message' && (item.role === 'user' || item.role === 'assistant')) {
            const textParts = item.parts
                .filter(p => p.type === 'text')
                .map(p => (p as TextPart).text)
                .join(' ')
                .slice(0, 400);
            if (textParts) lines.push(`[${item.role}]: ${textParts}`);
        }
    }

    return lines.join('\n');
}

/** Make an LLM patch call. Throws on stream error or timeout. */
async function callLlmPatch(
    state: DurableTaskState,
    turnItems: ConversationItem[],
    facts: TurnFacts,
    provider: ProviderDriver,
    model: string,
): Promise<DurableStatePatch> {
    const prompt = buildLlmPatchPrompt(state, turnItems, facts);
    const request: ModelRequest = {
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
        temperature: 0,
    };

    let text = '';
    for await (const event of provider.stream(request)) {
        if (event.type === 'text_delta') {
            text += event.text;
        } else if (event.type === 'error') {
            throw new Error(`LLM patch error: ${event.error.message}`);
        }
    }

    return parseLlmPatchResponse(text);
}

// --- Full Update ---

/**
 * Full two-phase durable state update: deterministic + optional LLM patch.
 * Never throws — LLM patch failures set stale=true instead.
 * Always increments revision (via deterministic update).
 */
export async function updateDurableTaskState(
    state: DurableTaskState,
    facts: TurnFacts,
    turnItems: ConversationItem[],
    provider?: ProviderDriver,
    model?: string,
): Promise<DurableTaskState> {
    // Phase 1: deterministic (always runs, increments revision, clears stale)
    let updated = applyDeterministicUpdates(state, facts);

    // Phase 2: optional LLM patch
    if (provider != null && model != null) {
        try {
            const patch = await callLlmPatch(updated, turnItems, facts, provider, model);
            updated = { ...applyLlmPatch(updated, patch), stale: false };
        } catch {
            updated = { ...updated, stale: true };
        }
    }

    return updated;
}

// --- Rendering ---

/**
 * Render durable task state as compact text for LLM context injection.
 * Targets ~80-150 tokens. Includes goal, active blockers, open loops (up to 5),
 * and the 3 most recent confirmed facts.
 */
export function renderDurableTaskState(state: DurableTaskState): string {
    const contentLines: string[] = [];

    if (state.goal) contentLines.push(`Goal: ${state.goal}`);

    if (state.blockers.length > 0) {
        contentLines.push(`Blockers: ${state.blockers.slice(0, 3).join('; ')}`);
    }

    const activeLoops = state.openLoops
        .filter(l => l.status === 'open' || l.status === 'blocked')
        .slice(0, 5);
    for (const loop of activeLoops) {
        const statusTag = loop.status === 'blocked' ? ' (blocked)' : '';
        contentLines.push(`Open: ${loop.text}${statusTag}`);
    }

    if (state.confirmedFacts.length > 0) {
        contentLines.push(`Facts: ${state.confirmedFacts.slice(-3).join(' | ')}`);
    }

    if (state.stale) contentLines.push('[state may be stale]');

    if (contentLines.length === 0) return '';

    return ['Task State:', ...contentLines].join('\n');
}
