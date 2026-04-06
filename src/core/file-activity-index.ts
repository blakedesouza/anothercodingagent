/**
 * FileActivityIndex (Block 7, M3.6).
 *
 * In-memory map from file path to activity score, persisted in manifest.json.
 * Updated deterministically from tool call history. Used to build the per-turn
 * "active files" working set context for the LLM.
 */

import type {
    ConversationItem,
    ToolCallPart,
    TextPart,
} from '../types/conversation.js';
import type { TurnRecord } from '../types/session.js';
import type { DurableTaskState } from './durable-task-state.js';

// --- Types ---

export interface FileActivityEntry {
    score: number;
    turnsSinceLastTouch: number;
    role: string;
}

export type SerializedFileActivityIndex = Record<string, FileActivityEntry>;

// --- Constants ---

const SCORING_WEIGHTS: Record<string, number> = {
    edit_file: 30,
    write_file: 30,
    delete_path: 35,
    move_path: 35,
    read_file: 10,
    search_text: 5,
};

const TOOL_ROLES: Record<string, string> = {
    edit_file: 'editing',
    write_file: 'writing',
    delete_path: 'deleted',
    move_path: 'moved',
    read_file: 'reading',
    search_text: 'searched',
};

const USER_MENTION_WEIGHT = 25;
const USER_MENTION_ROLE = 'mentioned';
const DECAY_PER_TURN = 5;
const EVICTION_THRESHOLD = 8;
const TOP_FILES_COUNT = 5;

// Match file paths in user messages: relative (src/foo.ts, ./foo/bar.ts, ../foo),
// or absolute (/foo/bar.ts). Negative lookbehind excludes URL segments.
const FILE_PATH_RE = /(?<![:/])((?:\/|\.\.?\/)?(?:[\w.-]+\/)+[\w.-]+\.\w{1,10})\b/g;

// --- Helpers ---

/** Extract unique file paths from search_text JSON output. */
function extractSearchTextFiles(data: string): string[] {
    try {
        const parsed = JSON.parse(data) as { matches?: Array<{ file?: string }> };
        if (!Array.isArray(parsed.matches)) return [];
        const files = new Set<string>();
        for (const m of parsed.matches) {
            if (typeof m.file === 'string') files.add(m.file);
        }
        return [...files];
    } catch {
        return [];
    }
}

/** Extract file paths from a tool call's arguments. */
function extractToolCallFiles(toolName: string, args: Record<string, unknown>): string[] {
    const files: string[] = [];
    if (typeof args.path === 'string') files.push(args.path);
    if (toolName === 'move_path') {
        if (typeof args.source === 'string') files.push(args.source);
        if (typeof args.destination === 'string') files.push(args.destination);
    }
    return files;
}

// --- FileActivityIndex ---

export class FileActivityIndex {
    private entries: Map<string, FileActivityEntry>;

    constructor(serialized?: SerializedFileActivityIndex | null) {
        this.entries = new Map();
        if (serialized) {
            for (const [path, entry] of Object.entries(serialized)) {
                this.entries.set(path, { ...entry });
            }
        }
    }

    /**
     * Process a complete turn's items: score tool calls, score user mentions,
     * apply decay to untouched files, evict stale files.
     *
     * @param turnItems - All conversation items belonging to this turn
     * @param openLoopFiles - Files referenced by active open loops (exempt from eviction)
     */
    processTurn(
        turnItems: ConversationItem[],
        openLoopFiles?: Set<string>,
    ): void {
        const touchedFiles = new Set<string>();

        // Build toolCallId → { toolName, args } lookup from assistant messages
        const toolCallArgs = new Map<string, { toolName: string; args: Record<string, unknown> }>();
        for (const item of turnItems) {
            if (item.kind === 'message' && item.role === 'assistant') {
                for (const part of item.parts) {
                    if (part.type === 'tool_call') {
                        const tc = part as ToolCallPart;
                        toolCallArgs.set(tc.toolCallId, {
                            toolName: tc.toolName,
                            args: tc.arguments,
                        });
                    }
                }
            }
        }

        // Score successful tool results
        for (const item of turnItems) {
            if (item.kind !== 'tool_result' || item.output.status !== 'success') continue;

            const weight = SCORING_WEIGHTS[item.toolName];
            if (weight == null) continue;

            let filePaths: string[];
            if (item.toolName === 'search_text') {
                filePaths = extractSearchTextFiles(item.output.data);
            } else {
                const call = toolCallArgs.get(item.toolCallId);
                filePaths = call ? extractToolCallFiles(item.toolName, call.args) : [];
            }

            const role = TOOL_ROLES[item.toolName] ?? 'referenced';
            for (const path of filePaths) {
                const entry = this.entries.get(path) ?? { score: 0, turnsSinceLastTouch: 0, role: '' };
                entry.score += weight;
                entry.turnsSinceLastTouch = 0;
                entry.role = role;
                this.entries.set(path, entry);
                touchedFiles.add(path);
            }
        }

        // Score user-mentioned file paths (deduplicated per turn)
        const mentionedPaths = new Set<string>();
        for (const item of turnItems) {
            if (item.kind !== 'message' || item.role !== 'user') continue;
            for (const part of item.parts) {
                if (part.type !== 'text') continue;
                const text = (part as TextPart).text;
                for (const match of text.matchAll(FILE_PATH_RE)) {
                    mentionedPaths.add(match[1]);
                }
            }
        }
        for (const path of mentionedPaths) {
            const entry = this.entries.get(path) ?? { score: 0, turnsSinceLastTouch: 0, role: '' };
            entry.score += USER_MENTION_WEIGHT;
            entry.turnsSinceLastTouch = 0;
            // Only set role to 'mentioned' if the file hasn't been touched by a tool this turn
            if (!touchedFiles.has(path)) {
                entry.role = USER_MENTION_ROLE;
            }
            this.entries.set(path, entry);
            touchedFiles.add(path);
        }

        // Decay: untouched files lose score (floored at 0) and increment turnsSinceLastTouch
        for (const [path, entry] of this.entries) {
            if (!touchedFiles.has(path)) {
                entry.score = Math.max(0, entry.score - DECAY_PER_TURN);
                entry.turnsSinceLastTouch++;
            }
        }

        // Evict files inactive for >= EVICTION_THRESHOLD turns (unless in open loop)
        const exempt = openLoopFiles ?? new Set<string>();
        for (const [path, entry] of this.entries) {
            if (entry.turnsSinceLastTouch >= EVICTION_THRESHOLD && !exempt.has(path)) {
                this.entries.delete(path);
            }
        }
    }

    /**
     * Get top N files by score (positive scores only), sorted descending.
     */
    getTopFiles(n: number = TOP_FILES_COUNT): Array<{ path: string; score: number; role: string }> {
        return [...this.entries.entries()]
            .filter(([, entry]) => entry.score > 0)
            .sort((a, b) => b[1].score - a[1].score)
            .slice(0, n)
            .map(([path, entry]) => ({ path, score: entry.score, role: entry.role }));
    }

    /**
     * Render per-turn context: top 5 files with roles.
     * Returns empty string if no active files.
     */
    renderWorkingSet(): string {
        const top = this.getTopFiles();
        if (top.length === 0) return '';
        const items = top.map(f => `${f.path} (${f.role})`);
        return `Active files: ${items.join(', ')}`;
    }

    /** Serialize for manifest.json persistence. */
    serialize(): SerializedFileActivityIndex {
        const result: SerializedFileActivityIndex = {};
        for (const [path, entry] of this.entries) {
            result[path] = { score: entry.score, turnsSinceLastTouch: entry.turnsSinceLastTouch, role: entry.role };
        }
        return result;
    }

    /** Get entry for a specific path (for testing/debugging). */
    getEntry(path: string): FileActivityEntry | undefined {
        const entry = this.entries.get(path);
        return entry ? { ...entry } : undefined;
    }

    /** Number of tracked files. */
    get size(): number {
        return this.entries.size;
    }

    /**
     * Rebuild from conversation log by replaying completed turns.
     * Groups items by turn boundaries and processes each turn sequentially.
     */
    static rebuildFromLog(
        items: ConversationItem[],
        turns: TurnRecord[],
        openLoopFiles?: Set<string>,
    ): FileActivityIndex {
        const index = new FileActivityIndex();

        // Only replay completed turns, ordered by turn number
        const sortedTurns = [...turns]
            .filter(t => t.status === 'completed')
            .sort((a, b) => a.turnNumber - b.turnNumber);

        for (const turn of sortedTurns) {
            const turnItems = items.filter(
                item => item.seq >= turn.itemSeqStart && item.seq <= turn.itemSeqEnd,
            );
            // Pass openLoopFiles to all turns — conservative approximation since
            // we don't have historical open-loop state per turn. Prevents incorrect
            // eviction of files that are in the final open-loop set.
            index.processTurn(turnItems, openLoopFiles);
        }

        return index;
    }
}

// --- Helpers for DurableTaskState integration ---

/**
 * Extract file paths referenced by active (non-done) open loops.
 */
export function getActiveOpenLoopFiles(durableState: DurableTaskState | null): Set<string> {
    if (!durableState) return new Set();
    const files = new Set<string>();
    for (const loop of durableState.openLoops) {
        if (loop.status !== 'done' && loop.files) {
            for (const file of loop.files) {
                files.add(file);
            }
        }
    }
    return files;
}
