import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    SessionManager,
    deriveWorkspaceId,
} from '../../src/core/session-manager.js';
import { TypedError } from '../../src/types/errors.js';
import type { SessionId, ItemId } from '../../src/types/ids.js';
import { generateId } from '../../src/types/ids.js';
import type { ConversationItem, SummaryItem } from '../../src/types/conversation.js';
import { visibleHistory } from '../../src/core/summarizer.js';
import { detectConfigDrift } from '../../src/config/loader.js';
import type { ResolvedConfig } from '../../src/config/schema.js';
import {
    createTurn,
    resetSeqCounter,
    resetStepCounter,
} from '../helpers/session-factory.js';

describe('M3.7 — Session Resume', () => {
    let tmpDir: string;
    let sessionsDir: string;
    let manager: SessionManager;

    beforeEach(() => {
        resetSeqCounter();
        resetStepCounter();
        tmpDir = mkdtempSync(join(tmpdir(), 'aca-resume-test-'));
        sessionsDir = join(tmpDir, 'sessions');
        manager = new SessionManager(sessionsDir);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('Create session → exit → resume → in-memory state matches', () => {
        it('should rebuild items, turns, steps, and sequence counter on resume', () => {
            const projection = manager.create('/home/user/project');
            const sessionId = projection.manifest.sessionId;

            // Simulate a 2-turn session with tool calls
            const { turn: turn1, items: items1 } = createTurn(sessionId, 1, {
                userMessage: 'Read the file',
                assistantMessage: 'Here is the file content',
                toolCalls: [{ name: 'read_file', arguments: { path: 'src/main.ts' } }],
            });
            for (const item of items1) projection.writer.writeItem(item);
            projection.writer.writeTurn(turn1);

            const { turn: turn2, items: items2 } = createTurn(sessionId, 2, {
                userMessage: 'Edit it',
                assistantMessage: 'Done editing',
                toolCalls: [{ name: 'edit_file', arguments: { path: 'src/main.ts' } }],
            });
            for (const item of items2) projection.writer.writeItem(item);
            projection.writer.writeTurn(turn2);

            // Update and save manifest
            projection.manifest.turnCount = 2;
            projection.manifest.lastActivityTimestamp = new Date().toISOString();
            manager.saveManifest(projection);

            // Resume
            const result = manager.resume(sessionId);

            // Items match
            const allItems = [...items1, ...items2];
            expect(result.projection.items).toHaveLength(allItems.length);
            for (let i = 0; i < allItems.length; i++) {
                expect(result.projection.items[i].id).toBe(allItems[i].id);
            }

            // Turns match
            expect(result.projection.turns).toHaveLength(2);
            expect(result.projection.turns[0].id).toBe(turn1.id);
            expect(result.projection.turns[1].id).toBe(turn2.id);

            // Sequence counter rebuilt from max seq
            const maxSeq = Math.max(...allItems.map(i => i.seq));
            expect(result.projection.sequenceGenerator.value()).toBe(maxSeq);
            expect(result.projection.sequenceGenerator.next()).toBe(maxSeq + 1);

            // FileActivityIndex rebuilt from log — read_file and edit_file touched src/main.ts
            const entry = result.fileActivityIndex.getEntry('src/main.ts');
            expect(entry).toBeDefined();
            expect(entry!.score).toBeGreaterThan(0);

            // Coverage map is empty (no summaries written)
            expect(result.coverageMap.size).toBe(0);
        });
    });

    describe('Resume with config drift', () => {
        it('should detect model change as informational drift', () => {
            const projection = manager.create('/home/user/project', {
                model: { default: 'gpt-4' },
                defaultProvider: 'nanogpt',
            });

            // Save manifest with original config snapshot
            manager.saveManifest(projection);

            // Simulate current config with different model
            const currentConfig = {
                model: { default: 'claude-3-opus' },
                defaultProvider: 'nanogpt',
                permissions: { nonInteractive: false, blockedTools: [] },
                sandbox: { extraTrustedRoots: [] },
                network: { mode: 'auto', allowDomains: [], denyDomains: [], allowHttp: false },
                scrubbing: { enabled: true },
            } as unknown as ResolvedConfig;

            const drifts = detectConfigDrift(currentConfig, projection.manifest.configSnapshot);
            const modelDrift = drifts.find(d => d.field === 'model.default');

            expect(modelDrift).toBeDefined();
            expect(modelDrift!.previous).toBe('gpt-4');
            expect(modelDrift!.current).toBe('claude-3-opus');
            expect(modelDrift!.securityRelevant).toBe(false);
        });

        it('should detect security-relevant drift for permissions change', () => {
            const projection = manager.create('/home/user/project', {
                permissions: { nonInteractive: false },
            });
            manager.saveManifest(projection);

            const currentConfig = {
                model: {},
                defaultProvider: 'nanogpt',
                permissions: { nonInteractive: true, blockedTools: [] },
                sandbox: { extraTrustedRoots: [] },
                network: { mode: 'auto', allowDomains: [], denyDomains: [], allowHttp: false },
                scrubbing: { enabled: true },
            } as unknown as ResolvedConfig;

            const drifts = detectConfigDrift(currentConfig, projection.manifest.configSnapshot);
            const permDrift = drifts.find(d => d.field === 'permissions.nonInteractive');

            expect(permDrift).toBeDefined();
            expect(permDrift!.securityRelevant).toBe(true);
        });
    });

    describe('Resume nonexistent session', () => {
        it('should throw TypedError with session.not_found', () => {
            const fakeId = 'ses_01JQABCDEFGHJKMNPQRSTVWXYZ' as SessionId;

            expect(() => manager.resume(fakeId)).toThrow(TypedError);

            try {
                manager.resume(fakeId);
            } catch (err) {
                const typed = err as TypedError;
                expect(typed.code).toBe('session.not_found');
                expect(typed.retryable).toBe(false);
            }
        });
    });

    describe('findLatestForWorkspace', () => {
        it('should return the most recent session for a workspace', () => {
            const workspaceRoot = '/home/user/project';
            const workspaceId = deriveWorkspaceId(workspaceRoot);

            // Create 3 sessions with staggered timestamps
            const proj1 = manager.create(workspaceRoot);
            proj1.manifest.lastActivityTimestamp = '2026-01-01T00:00:00.000Z';
            manager.saveManifest(proj1);

            const proj2 = manager.create(workspaceRoot);
            proj2.manifest.lastActivityTimestamp = '2026-03-01T00:00:00.000Z';
            manager.saveManifest(proj2);

            const proj3 = manager.create(workspaceRoot);
            proj3.manifest.lastActivityTimestamp = '2026-02-01T00:00:00.000Z';
            manager.saveManifest(proj3);

            const latest = manager.findLatestForWorkspace(workspaceId);
            expect(latest).toBe(proj2.manifest.sessionId);
        });

        it('should return null when no sessions exist for workspace', () => {
            const workspaceId = deriveWorkspaceId('/nonexistent/path');
            const result = manager.findLatestForWorkspace(workspaceId);
            expect(result).toBeNull();
        });

        it('should return null when sessions dir does not exist', () => {
            const freshManager = new SessionManager(join(tmpDir, 'no-such-dir'));
            const workspaceId = deriveWorkspaceId('/home/user/project');
            expect(freshManager.findLatestForWorkspace(workspaceId)).toBeNull();
        });

        it('should ignore sessions for different workspaces', () => {
            const proj1 = manager.create('/home/user/project-a');
            proj1.manifest.lastActivityTimestamp = '2026-03-01T00:00:00.000Z';
            manager.saveManifest(proj1);

            const proj2 = manager.create('/home/user/project-b');
            proj2.manifest.lastActivityTimestamp = '2026-03-02T00:00:00.000Z';
            manager.saveManifest(proj2);

            const workspaceIdA = deriveWorkspaceId('/home/user/project-a');
            const latest = manager.findLatestForWorkspace(workspaceIdA);
            expect(latest).toBe(proj1.manifest.sessionId);
        });
    });

    describe('Projection rebuild with summaries → visibleHistory matches', () => {
        it('should rebuild coverage map so visibleHistory skips summarized items', () => {
            const projection = manager.create('/home/user/project');
            const sessionId = projection.manifest.sessionId;

            // Write 10 turns
            const allItems: ConversationItem[] = [];
            for (let i = 1; i <= 10; i++) {
                const { turn, items } = createTurn(sessionId, i, {
                    userMessage: `User message ${i}`,
                    assistantMessage: `Response ${i}`,
                });
                for (const item of items) projection.writer.writeItem(item);
                projection.writer.writeTurn(turn);
                allItems.push(...items);
            }

            // Write a summary covering turns 1-5 (seq range of their items)
            // createTurn without toolCalls produces 2 items per turn (user + assistant)
            const turn1Items = allItems.slice(0, 2);
            const turn5Items = allItems.slice(8, 10);
            const summarySeqStart = turn1Items[0].seq;
            const summarySeqEnd = turn5Items[turn5Items.length - 1].seq;

            const summary: SummaryItem = {
                kind: 'summary',
                id: generateId('item') as ItemId,
                seq: Math.max(...allItems.map(i => i.seq)) + 1,
                text: 'Summary of turns 1-5: user asked questions, agent responded.',
                coversSeq: { start: summarySeqStart, end: summarySeqEnd },
                timestamp: new Date().toISOString(),
            };
            projection.writer.writeItem(summary);

            // Update manifest
            projection.manifest.turnCount = 10;
            projection.manifest.lastActivityTimestamp = new Date().toISOString();
            manager.saveManifest(projection);

            // Resume
            const result = manager.resume(sessionId);

            // Coverage map should have entries for summarized items
            expect(result.coverageMap.size).toBeGreaterThan(0);

            // Verify that items covered by the summary have entries in coverageMap
            for (let seq = summarySeqStart; seq <= summarySeqEnd; seq++) {
                expect(result.coverageMap.has(seq)).toBe(true);
            }

            // visibleHistory should exclude covered items and include the summary
            const visible = visibleHistory(result.projection.items, result.coverageMap);
            const visibleSeqs = new Set(visible.map(v => v.seq));

            // Covered items should NOT be visible
            for (let seq = summarySeqStart; seq <= summarySeqEnd; seq++) {
                expect(visibleSeqs.has(seq)).toBe(false);
            }

            // Summary itself should be visible
            expect(visibleSeqs.has(summary.seq)).toBe(true);

            // Items from turns 6-10 should be visible
            const laterItems = allItems.slice(10); // Items after turn 5
            for (const item of laterItems) {
                expect(visibleSeqs.has(item.seq)).toBe(true);
            }

            // Total visible: summary (1) + turns 6-10 items (10)
            expect(visible.length).toBe(11);
        });
    });

    describe('Resume rebuilds FileActivityIndex from log', () => {
        it('should rebuild file scores from replayed tool calls', () => {
            const projection = manager.create('/home/user/project');
            const sessionId = projection.manifest.sessionId;

            // Turn 1: read_file on foo.ts
            const { turn: turn1, items: items1 } = createTurn(sessionId, 1, {
                userMessage: 'Read foo',
                assistantMessage: 'Here it is',
                toolCalls: [{ name: 'read_file', arguments: { path: 'foo.ts' } }],
            });
            for (const item of items1) projection.writer.writeItem(item);
            projection.writer.writeTurn(turn1);

            // Turn 2: edit_file on foo.ts
            const { turn: turn2, items: items2 } = createTurn(sessionId, 2, {
                userMessage: 'Edit foo',
                assistantMessage: 'Done',
                toolCalls: [{ name: 'edit_file', arguments: { path: 'foo.ts' } }],
            });
            for (const item of items2) projection.writer.writeItem(item);
            projection.writer.writeTurn(turn2);

            // Turn 3: write_file on bar.ts
            const { turn: turn3, items: items3 } = createTurn(sessionId, 3, {
                userMessage: 'Create bar',
                assistantMessage: 'Created',
                toolCalls: [{ name: 'write_file', arguments: { path: 'bar.ts' } }],
            });
            for (const item of items3) projection.writer.writeItem(item);
            projection.writer.writeTurn(turn3);

            projection.manifest.turnCount = 3;
            projection.manifest.lastActivityTimestamp = new Date().toISOString();
            manager.saveManifest(projection);

            // Resume
            const result = manager.resume(sessionId);

            // foo.ts: read_file(+10) + edit_file(+30) - decay(5 for 1 idle turn between t2 and t3) = 35
            const fooEntry = result.fileActivityIndex.getEntry('foo.ts');
            expect(fooEntry).toBeDefined();
            expect(fooEntry!.score).toBe(35); // 10 + 30 - 5 (decay in turn 3)

            // bar.ts: write_file(+30) = 30
            const barEntry = result.fileActivityIndex.getEntry('bar.ts');
            expect(barEntry).toBeDefined();
            expect(barEntry!.score).toBe(30);
        });
    });

    describe('Resume loads durable task state from manifest', () => {
        it('should preserve durable task state across resume', () => {
            const projection = manager.create('/home/user/project');

            // Set durable task state in manifest
            projection.manifest.durableTaskState = {
                goal: 'Fix the auth bug',
                constraints: ['use vitest'],
                confirmedFacts: ['auth uses JWT'],
                decisions: ['refactor token validation'],
                openLoops: [{ id: 'loop1', text: 'tests failing', status: 'open' }],
                blockers: [],
                filesOfInterest: ['src/auth.ts'],
                revision: 3,
                stale: false,
            };
            manager.saveManifest(projection);

            // Resume
            const result = manager.resume(projection.manifest.sessionId);
            const dts = result.projection.manifest.durableTaskState;

            expect(dts).not.toBeNull();
            expect(dts!.goal).toBe('Fix the auth bug');
            expect(dts!.constraints).toEqual(['use vitest']);
            expect(dts!.confirmedFacts).toEqual(['auth uses JWT']);
            expect(dts!.decisions).toEqual(['refactor token validation']);
            expect(dts!.openLoops).toHaveLength(1);
            expect(dts!.openLoops[0].text).toBe('tests failing');
            expect(dts!.filesOfInterest).toEqual(['src/auth.ts']);
            expect(dts!.revision).toBe(3);
            expect(dts!.stale).toBe(false);
        });
    });
});
