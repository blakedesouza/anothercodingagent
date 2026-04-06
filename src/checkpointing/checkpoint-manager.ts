/**
 * CheckpointManager — per-turn workspace snapshots using git shadow refs.
 *
 * Checkpoints live under `refs/aca/checkpoints/<session-id>/` and are invisible
 * to `git branch`, `git log`, and normal user workflows. Uses git plumbing
 * commands (write-tree, commit-tree, update-ref) with a temporary index to
 * avoid touching the user's staging area or HEAD.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { SessionId, TurnId } from '../types/ids.js';

const execFile = promisify(execFileCb);

// --- Public types ---

export interface CheckpointMetadata {
    turnId: TurnId;
    turnNumber: number;
    filesChanged: string[];
    hasExternalEffects: boolean;
    timestamp: string;
}

export interface CheckpointInfo {
    turnNumber: number;
    turnId: TurnId;
    beforeCommit: string;
    afterCommit: string | null;
    timestamp: string;
    message: string;
    hasExternalEffects: boolean;
}

export interface DivergenceResult {
    diverged: boolean;
    changedFiles: string[];
}

export interface UndoResult {
    success: boolean;
    turnsReverted: number;
    filesRestored: string[];
    warnings: string[];
}

export interface RestorePreview {
    checkpointId: string;
    diff: string;
    filesAdded: string[];
    filesModified: string[];
    filesDeleted: string[];
}

export interface RestoreResult {
    success: boolean;
    filesRestored: string[];
    warnings: string[];
}

// --- Internal helpers ---

/** Maximum time for a single git command (ms). */
const GIT_TIMEOUT = 15_000;

/** Ref prefix for all ACA checkpoints. */
function refPrefix(sessionId: SessionId): string {
    return `refs/aca/checkpoints/${sessionId}`;
}

function beforeRef(sessionId: SessionId, turnNumber: number): string {
    return `${refPrefix(sessionId)}/turn-${turnNumber}-before`;
}

function afterRef(sessionId: SessionId, turnNumber: number): string {
    return `${refPrefix(sessionId)}/turn-${turnNumber}-after`;
}

/** Parse a turn number from a ref name like `turn-5-before` or `turn-5-after`. */
function parseTurnNumber(refName: string): number | null {
    const m = refName.match(/turn-(\d+)-(before|after)$/);
    return m ? parseInt(m[1], 10) : null;
}

// --- CheckpointManager ---

export class CheckpointManager {
    private readonly workspaceRoot: string;
    private readonly sessionId: SessionId;
    private initialized = false;
    /** Metadata stored in memory for the current session's checkpoints. */
    private readonly metadataMap = new Map<number, CheckpointMetadata>();
    /** Set to true after a beforeTurn checkpoint is created for the current turn. */
    private currentTurnCheckpointed = false;

    constructor(workspaceRoot: string, sessionId: SessionId) {
        this.workspaceRoot = workspaceRoot;
        this.sessionId = sessionId;
    }

    // --- Initialization ---

    /**
     * Ensure the workspace has a git repo. If none exists, auto-init one.
     * Must be called before any other checkpoint operation.
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        // Check if git is available
        try {
            await this.git(['--version']);
        } catch {
            throw new Error('git is not available on PATH. Checkpointing requires git.');
        }

        // Check if workspace is a git repo
        try {
            await this.git(['rev-parse', '--git-dir']);
        } catch {
            // Auto-init git repo
            await this.git(['init']);
        }

        this.initialized = true;
    }

    // --- Per-turn checkpoint lifecycle ---

    /**
     * Called before the first workspace-mutating tool in a turn.
     * Creates a beforeTurn checkpoint capturing the current workspace state.
     */
    async createBeforeTurnCheckpoint(turnId: TurnId, turnNumber: number): Promise<void> {
        await this.init();

        this.currentTurnCheckpointed = true;

        const tree = await this.snapshotToTree();
        const message = `aca: beforeTurn ${turnNumber} (${turnId})`;
        const commit = await this.createCommit(tree, message);
        const ref = beforeRef(this.sessionId, turnNumber);
        await this.updateRef(ref, commit);
    }

    /**
     * Called after a turn completes (only if beforeTurn was created).
     * Creates an afterTurn checkpoint capturing post-mutation workspace state.
     */
    async createAfterTurnCheckpoint(metadata: CheckpointMetadata): Promise<void> {
        if (!this.currentTurnCheckpointed) return;
        await this.init();

        const tree = await this.snapshotToTree();
        const message = `aca: afterTurn ${metadata.turnNumber} (${metadata.turnId})`;
        const commit = await this.createCommit(tree, message);
        const ref = afterRef(this.sessionId, metadata.turnNumber);
        await this.updateRef(ref, commit);

        this.metadataMap.set(metadata.turnNumber, metadata);
        this.currentTurnCheckpointed = false;
    }

    /**
     * Whether a beforeTurn checkpoint was created for the current turn.
     */
    hasPendingCheckpoint(): boolean {
        return this.currentTurnCheckpointed;
    }

    // --- Listing checkpoints ---

    /**
     * List all checkpoints for this session, ordered by turn number descending.
     */
    async listCheckpoints(): Promise<CheckpointInfo[]> {
        await this.init();

        const prefix = refPrefix(this.sessionId) + '/';
        let output: string;
        try {
            output = (await this.git(['for-each-ref', '--format=%(refname) %(objectname)', prefix])).trim();
        } catch {
            return [];
        }

        if (!output) return [];

        // Parse refs into before/after pairs grouped by turn number
        const beforeCommits = new Map<number, string>();
        const afterCommits = new Map<number, string>();

        for (const line of output.split('\n')) {
            const [refName, sha] = line.split(' ');
            if (!refName || !sha) continue;
            const turn = parseTurnNumber(refName);
            if (turn === null) continue;

            if (refName.endsWith('-before')) {
                beforeCommits.set(turn, sha);
            } else if (refName.endsWith('-after')) {
                afterCommits.set(turn, sha);
            }
        }

        const checkpoints: CheckpointInfo[] = [];
        for (const [turnNumber, beforeCommit] of beforeCommits) {
            const meta = this.metadataMap.get(turnNumber);
            checkpoints.push({
                turnNumber,
                turnId: meta?.turnId ?? ('' as TurnId),
                beforeCommit,
                afterCommit: afterCommits.get(turnNumber) ?? null,
                timestamp: meta?.timestamp ?? '',
                message: `Turn ${turnNumber}`,
                hasExternalEffects: meta?.hasExternalEffects ?? false,
            });
        }

        // Sort descending by turn number (most recent first)
        checkpoints.sort((a, b) => b.turnNumber - a.turnNumber);
        return checkpoints;
    }

    // --- Divergence detection ---

    /**
     * Compare live workspace against the most recent afterTurn checkpoint.
     * Returns whether files have been modified outside of ACA.
     */
    async detectDivergence(): Promise<DivergenceResult> {
        await this.init();

        // Find the most recent afterTurn checkpoint
        const checkpoints = await this.listCheckpoints();
        const latest = checkpoints.find(c => c.afterCommit !== null);
        if (!latest || !latest.afterCommit) {
            return { diverged: false, changedFiles: [] };
        }

        return this.detectDivergenceAgainst(latest.afterCommit);
    }

    /**
     * Compare live workspace against a specific commit.
     */
    async detectDivergenceAgainst(commitSha: string): Promise<DivergenceResult> {
        const tree = await this.getTreeFromCommit(commitSha);
        if (!tree) return { diverged: false, changedFiles: [] };

        const currentTree = await this.snapshotToTree();
        if (currentTree === tree) {
            return { diverged: false, changedFiles: [] };
        }

        // Get the diff between the two trees
        const diff = await this.git(['diff-tree', '-r', '--name-status', tree, currentTree]);
        const changedFiles = diff
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(line => {
                const parts = line.split('\t');
                return parts[1] ?? parts[0];
            });

        return { diverged: changedFiles.length > 0, changedFiles };
    }

    // --- Undo ---

    /**
     * Revert the last N mutating turns by restoring the workspace to
     * the beforeTurn state of the (latest - count + 1) turn.
     */
    async undoTurns(count: number, force = false): Promise<UndoResult> {
        await this.init();

        if (count < 1) {
            return { success: false, turnsReverted: 0, filesRestored: [], warnings: ['Count must be ≥ 1'] };
        }

        const checkpoints = await this.listCheckpoints();
        if (checkpoints.length === 0) {
            return { success: false, turnsReverted: 0, filesRestored: [], warnings: ['No checkpoints found'] };
        }

        if (count > checkpoints.length) {
            return {
                success: false,
                turnsReverted: 0,
                filesRestored: [],
                warnings: [`Only ${checkpoints.length} checkpointed turns available, requested ${count}`],
            };
        }

        // The target is the beforeTurn of the (count)th most recent checkpoint
        const target = checkpoints[count - 1];

        // Divergence check
        if (!force) {
            const divergence = await this.detectDivergence();
            if (divergence.diverged) {
                return {
                    success: false,
                    turnsReverted: 0,
                    filesRestored: [],
                    warnings: [
                        'Manual edits detected since last checkpoint. Files changed: ' +
                        divergence.changedFiles.join(', ') +
                        '. Use --force to override.',
                    ],
                };
            }
        }

        // Restore to the beforeTurn state of the target
        const filesRestored = await this.restoreFromCommit(target.beforeCommit);

        // Collect warnings about external effects
        const warnings: string[] = [];
        const externalTurns = checkpoints.slice(0, count).filter(c => c.hasExternalEffects);
        if (externalTurns.length > 0) {
            const turnNums = externalTurns.map(c => c.turnNumber).join(', ');
            warnings.push(
                `Turns ${turnNums} had external effects (shell commands, etc.) that cannot be undone. ` +
                'Check for side effects that may need manual reversal.',
            );
        }

        return {
            success: true,
            turnsReverted: count,
            filesRestored,
            warnings,
        };
    }

    // --- Restore ---

    /**
     * Preview what would change if we restored to a specific checkpoint.
     * checkpointId is "turn-N" (restores to beforeTurn of that turn).
     */
    async previewRestore(checkpointId: string): Promise<RestorePreview> {
        await this.init();

        const turnNumber = this.parseCheckpointId(checkpointId);
        const ref = beforeRef(this.sessionId, turnNumber);
        const commitSha = await this.resolveRef(ref);
        if (!commitSha) {
            throw new Error(`Checkpoint not found: ${checkpointId}`);
        }

        const targetTree = await this.getTreeFromCommit(commitSha);
        const currentTree = await this.snapshotToTree();

        if (!targetTree) throw new Error(`Cannot read tree for checkpoint ${checkpointId}`);

        // Generate a unified diff
        let diff: string;
        try {
            diff = await this.git(['diff', currentTree, targetTree]);
        } catch {
            diff = '(no diff available)';
        }

        // Classify file changes
        const statusOutput = await this.git(['diff-tree', '-r', '--name-status', currentTree, targetTree]);
        const filesAdded: string[] = [];
        const filesModified: string[] = [];
        const filesDeleted: string[] = [];

        for (const line of statusOutput.trim().split('\n').filter(Boolean)) {
            const [status, file] = line.split('\t');
            if (!file) continue;
            switch (status) {
                case 'A': filesAdded.push(file); break;
                case 'M': filesModified.push(file); break;
                case 'D': filesDeleted.push(file); break;
                default: filesModified.push(file); break;
            }
        }

        return { checkpointId, diff, filesAdded, filesModified, filesDeleted };
    }

    /**
     * Restore workspace to a specific checkpoint state.
     */
    async executeRestore(checkpointId: string, force = false): Promise<RestoreResult> {
        await this.init();

        const turnNumber = this.parseCheckpointId(checkpointId);
        const ref = beforeRef(this.sessionId, turnNumber);
        const commitSha = await this.resolveRef(ref);
        if (!commitSha) {
            throw new Error(`Checkpoint not found: ${checkpointId}`);
        }

        // Divergence check
        if (!force) {
            const divergence = await this.detectDivergence();
            if (divergence.diverged) {
                return {
                    success: false,
                    filesRestored: [],
                    warnings: [
                        'Manual edits detected since last checkpoint. Files changed: ' +
                        divergence.changedFiles.join(', ') +
                        '. Use --force to override.',
                    ],
                };
            }
        }

        const filesRestored = await this.restoreFromCommit(commitSha);

        // Check for external effects in turns between target and latest
        const warnings: string[] = [];
        const checkpoints = await this.listCheckpoints();
        const externalTurns = checkpoints
            .filter(c => c.turnNumber >= turnNumber && c.hasExternalEffects);
        if (externalTurns.length > 0) {
            const turnNums = externalTurns.map(c => c.turnNumber).join(', ');
            warnings.push(
                `Turns ${turnNums} had external effects (shell commands, etc.) that cannot be undone. ` +
                'Check for side effects that may need manual reversal.',
            );
        }

        return { success: true, filesRestored, warnings };
    }

    // --- Git plumbing helpers ---

    /**
     * Snapshot the entire workspace to a git tree object using a temporary index.
     * Does NOT touch the user's real index or staging area.
     */
    private async snapshotToTree(): Promise<string> {
        const tmpIndex = join(tmpdir(), `aca-idx-${randomUUID()}`);
        try {
            await this.git(['add', '-A'], { GIT_INDEX_FILE: tmpIndex });
            const tree = (await this.git(['write-tree'], { GIT_INDEX_FILE: tmpIndex })).trim();
            return tree;
        } finally {
            try { unlinkSync(tmpIndex); } catch { /* ignore */ }
        }
    }

    /** Create a parentless commit from a tree SHA. */
    private async createCommit(tree: string, message: string): Promise<string> {
        const sha = (await this.git(['commit-tree', tree, '-m', message])).trim();
        return sha;
    }

    /** Point a ref at a commit SHA. */
    private async updateRef(ref: string, commitSha: string): Promise<void> {
        await this.git(['update-ref', ref, commitSha]);
    }

    /** Resolve a ref to a commit SHA, or null if it doesn't exist. */
    private async resolveRef(ref: string): Promise<string | null> {
        try {
            return (await this.git(['rev-parse', '--verify', ref])).trim();
        } catch {
            return null;
        }
    }

    /** Get tree SHA from a commit. */
    private async getTreeFromCommit(commitSha: string): Promise<string | null> {
        try {
            return (await this.git(['rev-parse', `${commitSha}^{tree}`])).trim();
        } catch {
            return null;
        }
    }

    /**
     * Restore workspace files to match a specific commit's tree.
     * Uses a temp index to avoid touching the user's staging area.
     * Handles file additions, modifications, AND deletions.
     */
    private async restoreFromCommit(commitSha: string): Promise<string[]> {
        const targetTree = await this.getTreeFromCommit(commitSha);
        if (!targetTree) throw new Error(`Cannot read tree for commit ${commitSha}`);

        // Get current workspace tree for comparison
        const currentTree = await this.snapshotToTree();

        // Find files to delete (in current but not in target)
        const statusOutput = await this.git(['diff-tree', '-r', '--name-status', targetTree, currentTree]);
        const toDelete: string[] = [];
        const allChanged: string[] = [];

        for (const line of statusOutput.trim().split('\n').filter(Boolean)) {
            const [status, file] = line.split('\t');
            if (!file) continue;
            allChanged.push(file);
            if (status === 'A') {
                // File is Added in currentTree relative to targetTree → it should be deleted
                toDelete.push(file);
            }
        }

        // Restore files from target tree using temp index
        const tmpIndex = join(tmpdir(), `aca-restore-${randomUUID()}`);
        try {
            await this.git(['read-tree', targetTree], { GIT_INDEX_FILE: tmpIndex });
            await this.git(
                ['checkout-index', '-a', '-f', `--prefix=${this.workspaceRoot}/`],
                { GIT_INDEX_FILE: tmpIndex, GIT_WORK_TREE: this.workspaceRoot },
            );
        } finally {
            try { unlinkSync(tmpIndex); } catch { /* ignore */ }
        }

        // Delete files that shouldn't exist in the target state
        for (const file of toDelete) {
            const fullPath = join(this.workspaceRoot, file);
            try { unlinkSync(fullPath); } catch { /* file may already be gone */ }
        }

        return allChanged;
    }

    /** Parse "turn-N" checkpoint ID to turn number. */
    private parseCheckpointId(checkpointId: string): number {
        const m = checkpointId.match(/^turn-(\d+)$/);
        if (!m) throw new Error(`Invalid checkpoint ID format: ${checkpointId}. Expected "turn-N".`);
        return parseInt(m[1], 10);
    }

    /**
     * Execute a git command in the workspace directory.
     * Uses execFile (not exec) to prevent shell injection.
     */
    private async git(
        args: string[],
        extraEnv?: Record<string, string>,
    ): Promise<string> {
        const env = { ...process.env, ...extraEnv };
        const { stdout } = await execFile('git', args, {
            cwd: this.workspaceRoot,
            env,
            timeout: GIT_TIMEOUT,
            maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
        });
        return stdout;
    }
}
