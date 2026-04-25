import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    SessionManager,
    deriveWorkspaceId,
} from '../../src/core/session-manager.js';
import { TypedError } from '../../src/types/errors.js';
import type { SessionId } from '../../src/types/ids.js';
import {
    createItem,
    createTurn,
    createStep,
    resetSeqCounter,
    resetStepCounter,
} from '../helpers/session-factory.js';
import { generateId } from '../../src/types/ids.js';
import type { TurnId } from '../../src/types/ids.js';
import type { MessageItem } from '../../src/types/conversation.js';

describe('M1.3 — Session Manager', () => {
    let tmpDir: string;
    let sessionsDir: string;
    let manager: SessionManager;

    beforeEach(() => {
        resetSeqCounter();
        resetStepCounter();
        tmpDir = mkdtempSync(join(tmpdir(), 'aca-session-test-'));
        sessionsDir = join(tmpDir, 'sessions');
        manager = new SessionManager(sessionsDir);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('Create session', () => {
        it('should create directory, valid manifest.json, and empty conversation.jsonl', () => {
            const projection = manager.create('/home/user/project');

            // Directory exists
            expect(existsSync(projection.sessionDir)).toBe(true);

            // manifest.json exists and is valid JSON
            const manifestPath = join(projection.sessionDir, 'manifest.json');
            expect(existsSync(manifestPath)).toBe(true);
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
            expect(manifest.sessionId).toMatch(/^ses_/);
            expect(manifest.workspaceId).toMatch(/^wrk_/);
            expect(manifest.status).toBe('active');
            expect(manifest.turnCount).toBe(0);
            expect(manifest.lastActivityTimestamp).toBeTruthy();
            expect(manifest.configSnapshot).toEqual({
                workspaceRoot: '/home/user/project',
            });
            expect(manifest.durableTaskState).toBeNull();
            expect(manifest.calibration).toBeNull();

            // conversation.jsonl exists and is empty
            const conversationPath = join(
                projection.sessionDir,
                'conversation.jsonl',
            );
            expect(existsSync(conversationPath)).toBe(true);
            expect(readFileSync(conversationPath, 'utf-8')).toBe('');

            // Projection state is clean
            expect(projection.items).toHaveLength(0);
            expect(projection.turns).toHaveLength(0);
            expect(projection.steps).toHaveLength(0);
            expect(projection.currentTurn).toBeNull();
            expect(projection.sequenceGenerator.value()).toBe(0);
        });

        it('preserves caller configSnapshot fields and adds workspaceRoot', () => {
            const projection = manager.create('/home/user/project', {
                model: 'qwen/qwen3-coder-next',
                provider: 'nanogpt',
            });

            expect(projection.manifest.configSnapshot).toEqual({
                model: 'qwen/qwen3-coder-next',
                provider: 'nanogpt',
                workspaceRoot: '/home/user/project',
            });
        });

        it('persists optional parent/root session lineage in the manifest', () => {
            const projection = manager.create(
                '/home/user/project',
                { mode: 'sub-agent' },
                {
                    parentSessionId: 'ses_PARENT0000000000000000000' as SessionId,
                    rootSessionId: 'ses_ROOT000000000000000000000' as SessionId,
                },
            );

            expect(projection.manifest.parentSessionId).toBe('ses_PARENT0000000000000000000');
            expect(projection.manifest.rootSessionId).toBe('ses_ROOT000000000000000000000');

            const manifestPath = join(projection.sessionDir, 'manifest.json');
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
            expect(manifest.parentSessionId).toBe('ses_PARENT0000000000000000000');
            expect(manifest.rootSessionId).toBe('ses_ROOT000000000000000000000');
        });
    });

    describe('Load session', () => {
        it('should rebuild in-memory state matching what was written', () => {
            const projection = manager.create('/home/user/project');
            const sessionId = projection.manifest.sessionId;

            // Write some items via the writer
            const userMsg = createItem('user', 'Hello');
            const assistantMsg = createItem('assistant', 'Hi there');
            projection.writer.writeItem(userMsg);
            projection.writer.writeItem(assistantMsg);

            // Write a turn record
            const { turn } = createTurn(sessionId, 1, {
                userMessage: 'Hello',
                assistantMessage: 'Hi there',
            });
            projection.writer.writeTurn(turn);

            // Write a step record
            const turnId = generateId('turn') as TurnId;
            const step = createStep(turnId, [1, 2], [3]);
            projection.writer.writeStep(step);

            // Load the session
            const loaded = manager.load(sessionId);

            // Manifest matches
            expect(loaded.manifest.sessionId).toBe(sessionId);
            expect(loaded.manifest.status).toBe('active');
            expect(loaded.manifest.turnCount).toBe(0);

            // Items rebuilt
            expect(loaded.items).toHaveLength(2);
            expect(loaded.items[0].kind).toBe('message');
            expect((loaded.items[0] as MessageItem).role).toBe('user');
            expect(loaded.items[1].kind).toBe('message');
            expect((loaded.items[1] as MessageItem).role).toBe('assistant');

            // Turns and steps rebuilt
            expect(loaded.turns).toHaveLength(1);
            expect(loaded.turns[0].id).toBe(turn.id);
            expect(loaded.steps).toHaveLength(1);
            expect(loaded.steps[0].id).toBe(step.id);

            // No warnings
            expect(loaded.warnings).toHaveLength(0);
        });

        it('coalesces duplicate turn records and prefers the latest status', () => {
            const projection = manager.create('/home/user/project');
            const sessionId = projection.manifest.sessionId;

            const { turn } = createTurn(sessionId, 1, {
                userMessage: 'Hello',
                assistantMessage: 'Hi there',
            });

            const activeTurn = {
                ...turn,
                status: 'active' as const,
                outcome: undefined,
                completedAt: undefined,
                steps: [],
            };
            const completedTurn = {
                ...turn,
                status: 'completed' as const,
            };

            projection.writer.writeTurn(activeTurn);
            projection.writer.writeTurn(completedTurn);

            const loaded = manager.load(sessionId);

            expect(loaded.turns).toHaveLength(1);
            expect(loaded.turns[0].id).toBe(turn.id);
            expect(loaded.turns[0].status).toBe('completed');
            expect(loaded.currentTurn).toBeNull();
        });
    });

    describe('Write items → save manifest → reload → match', () => {
        it('should round-trip items and manifest through save/reload', () => {
            const projection = manager.create('/home/user/project');
            const sessionId = projection.manifest.sessionId;

            // Write items
            const msg1 = createItem('user', 'First message');
            const msg2 = createItem('assistant', 'First response');
            projection.writer.writeItem(msg1);
            projection.writer.writeItem(msg2);

            // Update manifest state (simulating turn boundary)
            projection.manifest.turnCount = 1;
            projection.manifest.lastActivityTimestamp =
                new Date().toISOString();
            projection.manifest.status = 'active';
            manager.saveManifest(projection);

            // Reload
            const loaded = manager.load(sessionId);

            // Items match
            expect(loaded.items).toHaveLength(2);
            expect(loaded.items[0].id).toBe(msg1.id);
            expect(loaded.items[1].id).toBe(msg2.id);

            // Manifest matches updated values
            expect(loaded.manifest.turnCount).toBe(1);
            expect(loaded.manifest.status).toBe('active');

            // Sequence counter rebuilt from max seq
            const maxSeq = Math.max(msg1.seq, msg2.seq);
            expect(loaded.sequenceGenerator.value()).toBe(maxSeq);
            expect(loaded.sequenceGenerator.next()).toBe(maxSeq + 1);
        });
    });

    describe('workspaceId determinism', () => {
        it('should produce the same ID for the same path', () => {
            const id1 = deriveWorkspaceId('/home/user/project');
            const id2 = deriveWorkspaceId('/home/user/project');
            expect(id1).toBe(id2);
        });

        it('should produce different IDs for different paths', () => {
            const id1 = deriveWorkspaceId('/home/user/project-a');
            const id2 = deriveWorkspaceId('/home/user/project-b');
            expect(id1).not.toBe(id2);
        });

        it('should have wrk_ prefix', () => {
            const id = deriveWorkspaceId('/home/user/project');
            expect(id).toMatch(/^wrk_[0-9a-f]{64}$/);
        });
    });

    describe('workspaceId path normalization', () => {
        it('should normalize trailing slashes', () => {
            const id1 = deriveWorkspaceId('/home/user/project');
            const id2 = deriveWorkspaceId('/home/user/project/');
            expect(id1).toBe(id2);
        });

        it('should normalize dot components', () => {
            const id1 = deriveWorkspaceId('/home/user/project');
            const id2 = deriveWorkspaceId('/home/user/./project');
            expect(id1).toBe(id2);
        });

        it('should normalize double-dot components', () => {
            const id1 = deriveWorkspaceId('/home/user/project');
            const id2 = deriveWorkspaceId('/home/user/other/../project');
            expect(id1).toBe(id2);
        });

        it('should normalize Windows path casing and separators', () => {
            const id1 = deriveWorkspaceId('C:/Users/Blake/Project');
            const id2 = deriveWorkspaceId('c:\\users\\blake\\project\\');
            expect(id1).toBe(id2);
        });
    });

    describe('Loading nonexistent session throws typed error', () => {
        it('should throw TypedError with session.not_found code', () => {
            const fakeId = 'ses_01JQABCDEFGHJKMNPQRSTVWXYZ' as SessionId;

            expect(() => manager.load(fakeId)).toThrow(TypedError);

            try {
                manager.load(fakeId);
            } catch (err) {
                expect(err).toBeInstanceOf(TypedError);
                const typed = err as TypedError;
                expect(typed.code).toBe('session.not_found');
                expect(typed.retryable).toBe(false);
                expect(typed.message).toContain(fakeId);
                expect(typed.details).toHaveProperty('sessionId', fakeId);
            }
        });
    });

    describe('Corrupt manifest throws typed error', () => {
        it('should throw session.corrupt when manifest.json has invalid JSON', () => {
            const projection = manager.create('/home/user/project');
            const sessionId = projection.manifest.sessionId;

            // Corrupt the manifest
            writeFileSync(
                join(projection.sessionDir, 'manifest.json'),
                '{ bad json ]]]',
            );

            expect(() => manager.load(sessionId)).toThrow(TypedError);

            try {
                manager.load(sessionId);
            } catch (err) {
                const typed = err as TypedError;
                expect(typed.code).toBe('session.corrupt');
                expect(typed.retryable).toBe(false);
                expect(typed.message).toContain('corrupted');
            }
        });
    });

    describe('Invalid session ID format throws typed error', () => {
        it('should reject session IDs with path traversal characters', () => {
            const badId = 'ses_../../etc/passwd' as SessionId;

            expect(() => manager.load(badId)).toThrow(TypedError);

            try {
                manager.load(badId);
            } catch (err) {
                const typed = err as TypedError;
                expect(typed.code).toBe('session.invalid_id');
            }
        });
    });
});
