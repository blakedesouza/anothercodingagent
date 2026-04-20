import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { generateId } from '../types/ids.js';
import type { SessionId, WorkspaceId } from '../types/ids.js';
import type { SessionStatus } from '../types/session.js';
import type { ConversationItem } from '../types/conversation.js';
import type { TurnRecord, StepRecord } from '../types/session.js';
import { SequenceGenerator } from '../types/sequence.js';
import { TypedError } from '../types/errors.js';
import { ConversationWriter } from './conversation-writer.js';
import { readConversationLog } from './conversation-reader.js';
import type { ReadWarning } from './conversation-reader.js';
import type { DurableTaskState } from './durable-task-state.js';
import type { SerializedFileActivityIndex } from './file-activity-index.js';
import { FileActivityIndex, getActiveOpenLoopFiles } from './file-activity-index.js';
import { buildCoverageMap } from './summarizer.js';

// --- Manifest schema (on-disk format) ---

export interface SessionManifest {
    sessionId: SessionId;
    workspaceId: WorkspaceId;
    parentSessionId?: SessionId;
    rootSessionId?: SessionId;
    status: SessionStatus;
    turnCount: number;
    lastActivityTimestamp: string;
    configSnapshot: Record<string, unknown>;
    durableTaskState: DurableTaskState | null;
    fileActivityIndex: SerializedFileActivityIndex | null;
    calibration: Record<string, unknown> | null;
    /** Ephemeral sessions (executor mode) are not surfaced for resume. */
    ephemeral?: boolean;
}

// --- In-memory projection ---

export interface SessionProjection {
    manifest: SessionManifest;
    sessionDir: string;
    items: ConversationItem[];
    turns: TurnRecord[];
    steps: StepRecord[];
    sequenceGenerator: SequenceGenerator;
    currentTurn: TurnRecord | null;
    writer: ConversationWriter;
    warnings: ReadWarning[];
}

/**
 * Extended projection returned by resume(), including rebuilt derived state.
 */
export interface ResumeResult {
    projection: SessionProjection;
    coverageMap: Map<number, number>;
    fileActivityIndex: FileActivityIndex;
}

// --- Workspace ID derivation ---

/**
 * Derives a deterministic workspace ID from an absolute path.
 * Normalizes the path (resolves `.`, `..`, trailing slashes) before hashing.
 */
export function deriveWorkspaceId(workspaceRoot: string): WorkspaceId {
    const normalized = resolve(normalize(workspaceRoot));
    const hash = createHash('sha256').update(normalized).digest('hex');
    return `wrk_${hash}` as WorkspaceId;
}

// ULID charset: Crockford Base32 (0-9, A-Z excluding I, L, O, U)
const SESSION_ID_PATTERN = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/i;

// --- Session Manager ---

export class SessionManager {
    private readonly sessionsDir: string;

    constructor(sessionsDir: string) {
        this.sessionsDir = sessionsDir;
    }

    /**
     * Create a new session: generate ID, create directory, write initial manifest
     * and empty conversation.jsonl.
     */
    create(
        workspaceRoot: string,
        configSnapshot: Record<string, unknown> = {},
        lineage?: { parentSessionId?: SessionId; rootSessionId?: SessionId },
    ): SessionProjection {
        const sessionId = generateId('session') as SessionId;
        const workspaceId = deriveWorkspaceId(workspaceRoot);
        const sessionDir = join(this.sessionsDir, sessionId);

        mkdirSync(sessionDir, { recursive: true });

        const manifest: SessionManifest = {
            sessionId,
            workspaceId,
            ...(lineage?.parentSessionId ? { parentSessionId: lineage.parentSessionId } : {}),
            ...(lineage?.rootSessionId ? { rootSessionId: lineage.rootSessionId } : {}),
            status: 'active',
            turnCount: 0,
            lastActivityTimestamp: new Date().toISOString(),
            configSnapshot: {
                ...configSnapshot,
                workspaceRoot,
            },
            durableTaskState: null,
            fileActivityIndex: null,
            calibration: null,
        };

        this.atomicWriteJson(join(sessionDir, 'manifest.json'), manifest);

        const conversationPath = join(sessionDir, 'conversation.jsonl');
        writeFileSync(conversationPath, '');

        return {
            manifest,
            sessionDir,
            items: [],
            turns: [],
            steps: [],
            sequenceGenerator: new SequenceGenerator(0),
            currentTurn: null,
            writer: new ConversationWriter(conversationPath),
            warnings: [],
        };
    }

    /**
     * Load an existing session: read manifest.json, replay conversation.jsonl
     * to rebuild the in-memory projection.
     */
    load(sessionId: SessionId): SessionProjection {
        if (!SESSION_ID_PATTERN.test(sessionId)) {
            throw new TypedError({
                code: 'session.invalid_id',
                message: `Invalid session ID format: ${sessionId}`,
                retryable: false,
                details: { sessionId },
            });
        }

        const sessionDir = join(this.sessionsDir, sessionId);
        const manifest = this.readManifest(sessionId);

        const conversationPath = join(sessionDir, 'conversation.jsonl');
        const { records, warnings } = readConversationLog(conversationPath);

        // Rebuild projection from records
        const items: ConversationItem[] = [];
        const turns: TurnRecord[] = [];
        const steps: StepRecord[] = [];
        const turnIndexById = new Map<string, number>();
        let maxSeq = 0;

        for (const { recordType, record } of records) {
            if (
                recordType === 'message' ||
                recordType === 'tool_result' ||
                recordType === 'summary'
            ) {
                const item = record as ConversationItem;
                items.push(item);
                if (item.seq > maxSeq) maxSeq = item.seq;
            } else if (recordType === 'turn') {
                const turn = record as TurnRecord;
                const existingIndex = turnIndexById.get(turn.id);
                if (existingIndex === undefined) {
                    turnIndexById.set(turn.id, turns.length);
                    turns.push(turn);
                } else {
                    turns[existingIndex] = turn;
                }
            } else if (recordType === 'step') {
                steps.push(record as StepRecord);
            }
        }

        // Current turn = most recent active turn (if any)
        let currentTurn: TurnRecord | null = null;
        for (let i = turns.length - 1; i >= 0; i--) {
            if (turns[i].status === 'active') {
                currentTurn = turns[i];
                break;
            }
        }

        return {
            manifest,
            sessionDir,
            items,
            turns,
            steps,
            sequenceGenerator: new SequenceGenerator(maxSeq),
            currentTurn,
            writer: new ConversationWriter(conversationPath),
            warnings,
        };
    }

    readManifest(sessionId: SessionId): SessionManifest {
        if (!SESSION_ID_PATTERN.test(sessionId)) {
            throw new TypedError({
                code: 'session.invalid_id',
                message: `Invalid session ID format: ${sessionId}`,
                retryable: false,
                details: { sessionId },
            });
        }

        const sessionDir = join(this.sessionsDir, sessionId);
        if (!existsSync(sessionDir)) {
            throw new TypedError({
                code: 'session.not_found',
                message: `Session not found: ${sessionId}`,
                retryable: false,
                details: { sessionId },
            });
        }

        const manifestPath = join(sessionDir, 'manifest.json');
        if (!existsSync(manifestPath)) {
            throw new TypedError({
                code: 'session.corrupt',
                message: `Session manifest missing: ${sessionId}`,
                retryable: false,
                details: { sessionId, path: manifestPath },
            });
        }

        try {
            return JSON.parse(readFileSync(manifestPath, 'utf-8')) as SessionManifest;
        } catch (err) {
            if (err instanceof SyntaxError) {
                throw new TypedError({
                    code: 'session.corrupt',
                    message: `Session manifest corrupted (invalid JSON): ${sessionId}`,
                    retryable: false,
                    details: { sessionId, path: manifestPath },
                }, err);
            }
            throw err;
        }
    }

    /**
     * Overwrite manifest.json with current state.
     * Called at each turn boundary (not per-step).
     * Uses write-to-temp-then-rename for crash safety.
     */
    saveManifest(projection: SessionProjection): void {
        const manifestPath = join(projection.sessionDir, 'manifest.json');
        this.atomicWriteJson(manifestPath, projection.manifest);
    }

    /**
     * Find the most recent session for a workspace by scanning manifest files.
     * Returns null if no sessions exist for the workspace.
     */
    findLatestForWorkspace(workspaceId: WorkspaceId): SessionId | null {
        if (!existsSync(this.sessionsDir)) return null;

        let latestId: SessionId | null = null;
        let latestTime = 0;

        const entries = readdirSync(this.sessionsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name)) continue;

            const manifestPath = join(this.sessionsDir, entry.name, 'manifest.json');
            if (!existsSync(manifestPath)) continue;

            try {
                const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
                if (raw.workspaceId === workspaceId && !raw.ephemeral) {
                    const ts = typeof raw.lastActivityTimestamp === 'string'
                        ? new Date(raw.lastActivityTimestamp).getTime()
                        : 0;
                    if (!isNaN(ts) && ts > latestTime) {
                        latestTime = ts;
                        latestId = entry.name as SessionId;
                    }
                }
            } catch {
                // Skip unreadable manifests
            }
        }

        return latestId;
    }

    /**
     * Resume a session: load projection + rebuild derived state
     * (coverage map, FileActivityIndex from conversation log replay).
     */
    resume(sessionId: SessionId): ResumeResult {
        const projection = this.load(sessionId);

        // Rebuild coverage map from summary items
        const coverageMap = buildCoverageMap(projection.items);

        // Rebuild FileActivityIndex from conversation log replay
        const openLoopFiles = getActiveOpenLoopFiles(projection.manifest.durableTaskState);
        const workspaceRoot = typeof projection.manifest.configSnapshot.workspaceRoot === 'string'
            ? projection.manifest.configSnapshot.workspaceRoot
            : undefined;
        const fileActivityIndex = FileActivityIndex.rebuildFromLog(
            projection.items,
            projection.turns,
            openLoopFiles,
            workspaceRoot,
        );

        return { projection, coverageMap, fileActivityIndex };
    }

    /**
     * Atomic JSON write: write to temp file, then rename.
     * renameSync is atomic on POSIX (same filesystem).
     */
    private atomicWriteJson(targetPath: string, data: unknown): void {
        const tmpPath = `${targetPath}.${process.pid}.tmp`;
        try {
            writeFileSync(tmpPath, JSON.stringify(data, null, 2));
            renameSync(tmpPath, targetPath);
        } catch (err) {
            try {
                unlinkSync(tmpPath);
            } catch {
                // Ignore cleanup failure
            }
            throw err;
        }
    }
}
