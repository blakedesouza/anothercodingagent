import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CheckpointManager } from '../../src/checkpointing/checkpoint-manager.js';
import type { SessionId, TurnId } from '../../src/types/ids.js';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const execFile = promisify(execFileCb);

// --- Test helpers ---

function tmpDir(): string {
    const dir = join(tmpdir(), `aca-ckpt-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

const SESSION_ID = 'ses_01TESTCHECKPOINT00000000000' as SessionId;
const TURN1_ID = 'turn_01TEST00000000000000000001' as TurnId;
const TURN2_ID = 'turn_01TEST00000000000000000002' as TurnId;
const TURN3_ID = 'turn_01TEST00000000000000000003' as TurnId;

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFile('git', args, { cwd });
    return stdout.trim();
}

async function initGitRepo(dir: string): Promise<void> {
    await git(dir, ['init']);
    await git(dir, ['config', 'user.email', 'test@test.com']);
    await git(dir, ['config', 'user.name', 'Test']);
}

// --- Tests ---

describe('CheckpointManager', () => {
    let workDir: string;
    let mgr: CheckpointManager;

    beforeEach(async () => {
        workDir = tmpDir();
        await initGitRepo(workDir);
        mgr = new CheckpointManager(workDir, SESSION_ID);
    });

    afterEach(() => {
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // --- 1. edit_file → checkpoint created with beforeTurn and afterTurn ---
    it('creates beforeTurn and afterTurn checkpoints', async () => {
        writeFileSync(join(workDir, 'hello.txt'), 'original');

        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);
        expect(mgr.hasPendingCheckpoint()).toBe(true);

        // Simulate file mutation
        writeFileSync(join(workDir, 'hello.txt'), 'modified');

        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID,
            turnNumber: 1,
            filesChanged: ['hello.txt'],
            hasExternalEffects: false,
            timestamp: new Date().toISOString(),
        });

        expect(mgr.hasPendingCheckpoint()).toBe(false);

        // Verify refs exist
        const refs = await git(workDir, ['for-each-ref', '--format=%(refname)', `refs/aca/checkpoints/${SESSION_ID}/`]);
        expect(refs).toContain('turn-1-before');
        expect(refs).toContain('turn-1-after');
    });

    // --- 2. /undo → files restored to beforeTurn state ---
    it('undo restores files to beforeTurn state', async () => {
        writeFileSync(join(workDir, 'file.txt'), 'before');
        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);

        writeFileSync(join(workDir, 'file.txt'), 'after-mutation');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['file.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        const result = await mgr.undoTurns(1);
        expect(result.success).toBe(true);
        expect(result.turnsReverted).toBe(1);
        expect(readFileSync(join(workDir, 'file.txt'), 'utf-8')).toBe('before');
    });

    // --- 3. /undo 3 → last 3 mutating turns reverted ---
    it('undo N reverts last N mutating turns', async () => {
        // Turn 1: create file
        writeFileSync(join(workDir, 'a.txt'), 'v0');
        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);
        writeFileSync(join(workDir, 'a.txt'), 'v1');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['a.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        // Turn 2: modify file
        await mgr.createBeforeTurnCheckpoint(TURN2_ID, 2);
        writeFileSync(join(workDir, 'a.txt'), 'v2');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN2_ID, turnNumber: 2, filesChanged: ['a.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        // Turn 3: add new file
        await mgr.createBeforeTurnCheckpoint(TURN3_ID, 3);
        writeFileSync(join(workDir, 'b.txt'), 'new');
        writeFileSync(join(workDir, 'a.txt'), 'v3');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN3_ID, turnNumber: 3, filesChanged: ['a.txt', 'b.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        // Undo all 3 turns → go back to turn 1's beforeTurn (v0)
        const result = await mgr.undoTurns(3);
        expect(result.success).toBe(true);
        expect(result.turnsReverted).toBe(3);
        expect(readFileSync(join(workDir, 'a.txt'), 'utf-8')).toBe('v0');
    });

    // --- 4. /restore preview: shows diff ---
    it('restore preview shows files that would change', async () => {
        writeFileSync(join(workDir, 'file.txt'), 'original');
        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);
        writeFileSync(join(workDir, 'file.txt'), 'changed');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['file.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        const preview = await mgr.previewRestore('turn-1');
        expect(preview.checkpointId).toBe('turn-1');
        expect(preview.filesModified.length + preview.filesAdded.length + preview.filesDeleted.length).toBeGreaterThan(0);
    });

    // --- 5. /restore confirmation: user must confirm after seeing preview (tested at command level) ---
    // This is tested in the /restore slash command test — the command calls previewRestore then promptUser.

    // --- 6. /restore to specific checkpoint → workspace matches ---
    it('restore to specific checkpoint matches that state', async () => {
        writeFileSync(join(workDir, 'data.txt'), 'state-A');
        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);
        writeFileSync(join(workDir, 'data.txt'), 'state-B');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['data.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        // More changes
        await mgr.createBeforeTurnCheckpoint(TURN2_ID, 2);
        writeFileSync(join(workDir, 'data.txt'), 'state-C');
        writeFileSync(join(workDir, 'extra.txt'), 'extra');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN2_ID, turnNumber: 2, filesChanged: ['data.txt', 'extra.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        // Restore to turn 1 → should have state-A
        const result = await mgr.executeRestore('turn-1', true);
        expect(result.success).toBe(true);
        expect(readFileSync(join(workDir, 'data.txt'), 'utf-8')).toBe('state-A');
    });

    // --- 7. Read-only turn → no checkpoint created ---
    it('no checkpoint if hasPendingCheckpoint is not triggered', async () => {
        // Just listing checkpoints without creating any
        const checkpoints = await mgr.listCheckpoints();
        expect(checkpoints).toHaveLength(0);
        expect(mgr.hasPendingCheckpoint()).toBe(false);
    });

    // --- 8. Manual edit between turns → divergence detected → undo blocked ---
    it('detects divergence and blocks undo', async () => {
        writeFileSync(join(workDir, 'file.txt'), 'before');
        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);
        writeFileSync(join(workDir, 'file.txt'), 'after-tool');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['file.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        // Simulate manual edit between turns
        writeFileSync(join(workDir, 'file.txt'), 'manual-edit');

        const divergence = await mgr.detectDivergence();
        expect(divergence.diverged).toBe(true);
        expect(divergence.changedFiles.length).toBeGreaterThan(0);

        // Undo should be blocked
        const result = await mgr.undoTurns(1, false);
        expect(result.success).toBe(false);
        expect(result.warnings[0]).toContain('Manual edits detected');
    });

    // --- 9. Force override → undo succeeds despite divergence ---
    it('force override bypasses divergence detection', async () => {
        writeFileSync(join(workDir, 'file.txt'), 'before');
        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);
        writeFileSync(join(workDir, 'file.txt'), 'after-tool');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['file.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        // Manual edit
        writeFileSync(join(workDir, 'file.txt'), 'manual-edit');

        const result = await mgr.undoTurns(1, true);
        expect(result.success).toBe(true);
        expect(readFileSync(join(workDir, 'file.txt'), 'utf-8')).toBe('before');
    });

    // --- 10. /restore with manual edits → divergence detected → restore blocked ---
    it('restore blocked on divergence without force', async () => {
        writeFileSync(join(workDir, 'file.txt'), 'checkpoint-state');
        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);
        writeFileSync(join(workDir, 'file.txt'), 'after');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['file.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        writeFileSync(join(workDir, 'file.txt'), 'manual-edit');

        const result = await mgr.executeRestore('turn-1', false);
        expect(result.success).toBe(false);
        expect(result.warnings[0]).toContain('Manual edits detected');
    });

    // --- 11. /restore --force with manual edits → succeeds ---
    it('restore with force bypasses divergence', async () => {
        writeFileSync(join(workDir, 'file.txt'), 'checkpoint-state');
        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);
        writeFileSync(join(workDir, 'file.txt'), 'after');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['file.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        writeFileSync(join(workDir, 'file.txt'), 'manual-edit');

        const result = await mgr.executeRestore('turn-1', true);
        expect(result.success).toBe(true);
        expect(readFileSync(join(workDir, 'file.txt'), 'utf-8')).toBe('checkpoint-state');
    });

    // --- 12. exec_command turn → undo restores files but warns about shell side effects ---
    it('undo warns about external effects', async () => {
        writeFileSync(join(workDir, 'file.txt'), 'before');
        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);
        writeFileSync(join(workDir, 'file.txt'), 'after');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['file.txt'],
            hasExternalEffects: true,
            timestamp: new Date().toISOString(),
        });

        const result = await mgr.undoTurns(1);
        expect(result.success).toBe(true);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0]).toContain('external effects');
    });

    // --- 13. /checkpoints → lists recent checkpoints with metadata ---
    it('lists checkpoints with metadata', async () => {
        writeFileSync(join(workDir, 'a.txt'), 'content');

        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);
        writeFileSync(join(workDir, 'a.txt'), 'v1');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['a.txt'],
            hasExternalEffects: false, timestamp: '2026-04-04T10:00:00Z',
        });

        await mgr.createBeforeTurnCheckpoint(TURN2_ID, 2);
        writeFileSync(join(workDir, 'a.txt'), 'v2');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN2_ID, turnNumber: 2, filesChanged: ['a.txt'],
            hasExternalEffects: true, timestamp: '2026-04-04T10:05:00Z',
        });

        const checkpoints = await mgr.listCheckpoints();
        expect(checkpoints).toHaveLength(2);

        // Most recent first
        expect(checkpoints[0].turnNumber).toBe(2);
        expect(checkpoints[0].hasExternalEffects).toBe(true);
        expect(checkpoints[0].timestamp).toBe('2026-04-04T10:05:00Z');

        expect(checkpoints[1].turnNumber).toBe(1);
        expect(checkpoints[1].hasExternalEffects).toBe(false);
    });

    // --- 14. Shadow refs invisible to git branch and git log ---
    it('shadow refs are invisible to git branch and git log', async () => {
        writeFileSync(join(workDir, 'file.txt'), 'content');

        // Create an initial commit so git log works
        await git(workDir, ['add', '-A']);
        await git(workDir, ['commit', '-m', 'initial']);

        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);
        writeFileSync(join(workDir, 'file.txt'), 'modified');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['file.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        // git branch should not show ACA refs
        const branches = await git(workDir, ['branch', '-a']);
        expect(branches).not.toContain('aca');
        expect(branches).not.toContain('checkpoint');

        // git log should not show ACA commits
        const log = await git(workDir, ['log', '--oneline']);
        expect(log).not.toContain('aca:');
        expect(log).toContain('initial');
    });

    // --- Edge cases ---

    it('auto-inits git repo if none exists', async () => {
        const bare = tmpDir(); // Not a git repo
        const freshMgr = new CheckpointManager(bare, SESSION_ID);

        await freshMgr.init();

        // Should now be a git repo
        const gitDir = await git(bare, ['rev-parse', '--git-dir']);
        expect(gitDir).toBe('.git');

        rmSync(bare, { recursive: true, force: true });
    });

    it('undo with count > available checkpoints returns failure', async () => {
        writeFileSync(join(workDir, 'file.txt'), 'content');
        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);
        writeFileSync(join(workDir, 'file.txt'), 'modified');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['file.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        const result = await mgr.undoTurns(5);
        expect(result.success).toBe(false);
        expect(result.warnings[0]).toContain('Only 1');
    });

    it('undo with count < 1 returns failure', async () => {
        const result = await mgr.undoTurns(0);
        expect(result.success).toBe(false);
    });

    it('invalid checkpoint ID throws', async () => {
        await expect(mgr.previewRestore('bad-id')).rejects.toThrow('Invalid checkpoint ID format');
    });

    it('restore nonexistent checkpoint throws', async () => {
        await expect(mgr.executeRestore('turn-999', true)).rejects.toThrow('Checkpoint not found');
    });

    it('no divergence when workspace matches last afterTurn', async () => {
        writeFileSync(join(workDir, 'file.txt'), 'content');
        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);
        writeFileSync(join(workDir, 'file.txt'), 'modified');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['file.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        // No manual edits — workspace matches afterTurn
        const divergence = await mgr.detectDivergence();
        expect(divergence.diverged).toBe(false);
        expect(divergence.changedFiles).toHaveLength(0);
    });

    it('undo handles file deletions correctly', async () => {
        // Before turn: no extra.txt
        writeFileSync(join(workDir, 'base.txt'), 'base');
        await mgr.createBeforeTurnCheckpoint(TURN1_ID, 1);

        // During turn: create a new file
        writeFileSync(join(workDir, 'extra.txt'), 'created during turn');
        await mgr.createAfterTurnCheckpoint({
            turnId: TURN1_ID, turnNumber: 1, filesChanged: ['extra.txt'],
            hasExternalEffects: false, timestamp: new Date().toISOString(),
        });

        // Undo should delete the file that didn't exist before
        const result = await mgr.undoTurns(1);
        expect(result.success).toBe(true);
        expect(existsSync(join(workDir, 'extra.txt'))).toBe(false);
        expect(existsSync(join(workDir, 'base.txt'))).toBe(true);
    });
});
