import { describe, it, expect, vi } from 'vitest';
import { handleSlashCommand } from '../../src/cli/commands.js';
import type { SlashCommandContext } from '../../src/cli/commands.js';
import type { CheckpointManager, CheckpointInfo, UndoResult, RestorePreview, RestoreResult } from '../../src/checkpointing/checkpoint-manager.js';
import type { SessionProjection, SessionManifest } from '../../src/core/session-manager.js';
import type { SessionId, WorkspaceId, TurnId } from '../../src/types/ids.js';

// --- Helpers ---

function makeManifest(): SessionManifest {
    return {
        sessionId: 'ses_TEST' as SessionId,
        workspaceId: 'wrk_TEST' as WorkspaceId,
        status: 'active',
        turnCount: 0,
        lastActivityTimestamp: new Date().toISOString(),
        configSnapshot: {},
        durableTaskState: null,
        fileActivityIndex: null,
        calibration: null,
    };
}

function makeCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
    return {
        projection: { manifest: makeManifest() } as SessionProjection,
        model: 'test-model',
        turnCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        exit: vi.fn(),
        ...overrides,
    };
}

function makeMockCheckpointManager(overrides: Partial<CheckpointManager> = {}): CheckpointManager {
    return {
        init: vi.fn(),
        createBeforeTurnCheckpoint: vi.fn(),
        createAfterTurnCheckpoint: vi.fn(),
        hasPendingCheckpoint: vi.fn().mockReturnValue(false),
        listCheckpoints: vi.fn().mockResolvedValue([]),
        detectDivergence: vi.fn().mockResolvedValue({ diverged: false, changedFiles: [] }),
        undoTurns: vi.fn().mockResolvedValue({ success: true, turnsReverted: 1, filesRestored: ['file.txt'], warnings: [] }),
        previewRestore: vi.fn().mockResolvedValue({ checkpointId: 'turn-1', diff: '', filesAdded: [], filesModified: ['file.txt'], filesDeleted: [] }),
        executeRestore: vi.fn().mockResolvedValue({ success: true, filesRestored: ['file.txt'], warnings: [] }),
        ...overrides,
    } as unknown as CheckpointManager;
}

describe('/undo command', () => {
    it('returns error when checkpointing is not available', async () => {
        const ctx = makeCtx();
        const result = await handleSlashCommand('/undo', ctx)!;
        expect(result.output).toContain('not available');
    });

    it('calls undoTurns with default count 1', async () => {
        const undoTurns = vi.fn().mockResolvedValue({
            success: true, turnsReverted: 1, filesRestored: ['a.txt'], warnings: [],
        } as UndoResult);
        const ctx = makeCtx({ checkpointManager: makeMockCheckpointManager({ undoTurns }) });
        const result = await handleSlashCommand('/undo', ctx)!;
        expect(undoTurns).toHaveBeenCalledWith(1, false);
        expect(result.output).toContain('Reverted 1');
    });

    it('passes count argument to undoTurns', async () => {
        const undoTurns = vi.fn().mockResolvedValue({
            success: true, turnsReverted: 3, filesRestored: ['a.txt'], warnings: [],
        } as UndoResult);
        const ctx = makeCtx({ checkpointManager: makeMockCheckpointManager({ undoTurns }) });
        const result = await handleSlashCommand('/undo 3', ctx)!;
        expect(undoTurns).toHaveBeenCalledWith(3, false);
        expect(result.output).toContain('Reverted 3');
    });

    it('shows failure message when undo fails', async () => {
        const undoTurns = vi.fn().mockResolvedValue({
            success: false, turnsReverted: 0, filesRestored: [], warnings: ['Manual edits detected'],
        } as UndoResult);
        const ctx = makeCtx({ checkpointManager: makeMockCheckpointManager({ undoTurns }) });
        const result = await handleSlashCommand('/undo', ctx)!;
        expect(result.output).toContain('Manual edits');
    });

    it('shows warnings about external effects', async () => {
        const undoTurns = vi.fn().mockResolvedValue({
            success: true, turnsReverted: 1, filesRestored: ['a.txt'],
            warnings: ['Turns 3 had external effects'],
        } as UndoResult);
        const ctx = makeCtx({ checkpointManager: makeMockCheckpointManager({ undoTurns }) });
        const result = await handleSlashCommand('/undo', ctx)!;
        expect(result.output).toContain('external effects');
    });
});

describe('/checkpoints command', () => {
    it('returns message when no checkpoints', async () => {
        const ctx = makeCtx({ checkpointManager: makeMockCheckpointManager() });
        const result = await handleSlashCommand('/checkpoints', ctx)!;
        expect(result.output).toContain('No checkpoints');
    });

    it('lists checkpoints with metadata', async () => {
        const listCheckpoints = vi.fn().mockResolvedValue([
            {
                turnNumber: 2, turnId: 'turn_2' as TurnId, beforeCommit: 'abc',
                afterCommit: 'def', timestamp: '2026-04-04T10:00:00Z',
                message: 'Turn 2', hasExternalEffects: true,
            },
            {
                turnNumber: 1, turnId: 'turn_1' as TurnId, beforeCommit: 'xyz',
                afterCommit: '123', timestamp: '2026-04-04T09:00:00Z',
                message: 'Turn 1', hasExternalEffects: false,
            },
        ] as CheckpointInfo[]);
        const ctx = makeCtx({ checkpointManager: makeMockCheckpointManager({ listCheckpoints }) });
        const result = await handleSlashCommand('/checkpoints', ctx)!;
        expect(result.output).toContain('2 checkpoint(s)');
        expect(result.output).toContain('turn-2');
        expect(result.output).toContain('external effects');
    });
});

describe('/restore command', () => {
    it('returns usage when no checkpoint ID provided', async () => {
        const ctx = makeCtx({ checkpointManager: makeMockCheckpointManager() });
        const result = await handleSlashCommand('/restore', ctx)!;
        expect(result.output).toContain('Usage');
    });

    it('shows preview and prompts for confirmation', async () => {
        const promptUser = vi.fn().mockResolvedValue('y');
        const executeRestore = vi.fn().mockResolvedValue({
            success: true, filesRestored: ['file.txt'], warnings: [],
        } as RestoreResult);
        const previewRestore = vi.fn().mockResolvedValue({
            checkpointId: 'turn-1', diff: '', filesAdded: [], filesModified: ['file.txt'], filesDeleted: [],
        } as RestorePreview);
        const ctx = makeCtx({
            checkpointManager: makeMockCheckpointManager({ previewRestore, executeRestore }),
            promptUser,
        });
        const result = await handleSlashCommand('/restore turn-1', ctx)!;
        expect(promptUser).toHaveBeenCalled();
        expect(executeRestore).toHaveBeenCalledWith('turn-1', false);
        expect(result.output).toContain('Restored');
    });

    it('cancels restore when user declines', async () => {
        const promptUser = vi.fn().mockResolvedValue('n');
        const executeRestore = vi.fn();
        const previewRestore = vi.fn().mockResolvedValue({
            checkpointId: 'turn-1', diff: '', filesAdded: [], filesModified: ['file.txt'], filesDeleted: [],
        } as RestorePreview);
        const ctx = makeCtx({
            checkpointManager: makeMockCheckpointManager({ previewRestore, executeRestore }),
            promptUser,
        });
        const result = await handleSlashCommand('/restore turn-1', ctx)!;
        expect(executeRestore).not.toHaveBeenCalled();
        expect(result.output).toContain('cancelled');
    });
});

describe('/help includes checkpoint commands', () => {
    it('lists undo, restore, and checkpoints', () => {
        const ctx = makeCtx();
        const result = handleSlashCommand('/help', ctx);
        expect(result).not.toBeNull();
        const output = (result as { output: string }).output;
        expect(output).toContain('/undo');
        expect(output).toContain('/restore');
        expect(output).toContain('/checkpoints');
    });
});
