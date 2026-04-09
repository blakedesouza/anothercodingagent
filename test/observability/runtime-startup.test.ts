import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SqliteStore } from '../../src/observability/sqlite-store.js';
import { runStartupObservabilityMaintenance } from '../../src/observability/runtime-startup.js';
import { createEvent } from '../../src/core/event-sink.js';
import type { SessionId } from '../../src/types/ids.js';

function tmpPath(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function makeSessionStarted(sessionId: SessionId) {
    return createEvent('session.started', sessionId, 0, 'aca', {
        workspace_id: 'wrk_test',
        model: 'zai-org/glm-5',
        provider: 'nanogpt',
    });
}

function makeLlmResponse(sessionId: SessionId, turnNumber = 1) {
    return createEvent('llm.response', sessionId, turnNumber, 'aca', {
        model: 'zai-org/glm-5',
        provider: 'nanogpt',
        tokens_in: 10,
        tokens_out: 5,
        latency_ms: 100,
        finish_reason: 'stop',
        cost_usd: 0.001,
    });
}

describe('runStartupObservabilityMaintenance', () => {
    let root: string;
    let sessionsDir: string;
    let store: SqliteStore;

    beforeEach(() => {
        root = tmpPath('aca-obs-startup-test');
        sessionsDir = join(root, 'sessions');
        mkdirSync(sessionsDir, { recursive: true });
        store = new SqliteStore(join(root, 'observability.db'));
        store.open();
    });

    afterEach(() => {
        store.close();
    });

    it('backfills missing JSONL events for resumed sessions', async () => {
        const sessionId = 'ses_RESUME00000000000000000001' as SessionId;
        const sessionDir = join(sessionsDir, sessionId);
        mkdirSync(sessionDir, { recursive: true });
        const manifest = {
            sessionId,
            workspaceId: 'wrk_test',
            status: 'active',
            turnCount: 1,
            lastActivityTimestamp: new Date().toISOString(),
            configSnapshot: {},
            durableTaskState: null,
            fileActivityIndex: null,
            calibration: null,
        };
        writeFileSync(join(sessionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

        const start = makeSessionStarted(sessionId);
        const response = makeLlmResponse(sessionId);
        writeFileSync(
            join(sessionDir, 'events.jsonl'),
            `${JSON.stringify(start)}\n${JSON.stringify(response)}\n`,
        );

        const result = await runStartupObservabilityMaintenance({
            sessionsDir,
            store,
            retention: { days: 30, maxSizeGb: 5 },
            sessionId,
            sessionDir,
            resumed: true,
        });

        expect(result.backfilled).toBe(2);
        expect(store.getEventsForSession(sessionId)).toHaveLength(2);
    });

    it('protects the active session from retention pruning', async () => {
        const activeId = 'ses_ACTIVE0000000000000000001' as SessionId;
        const expiredId = 'ses_EXPIRED00000000000000001' as SessionId;

        const activeDir = join(sessionsDir, activeId);
        mkdirSync(activeDir, { recursive: true });
        writeFileSync(join(activeDir, 'manifest.json'), JSON.stringify({
            sessionId: activeId,
            workspaceId: 'wrk_test',
            status: 'active',
            turnCount: 0,
            lastActivityTimestamp: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
            configSnapshot: {},
            durableTaskState: null,
            fileActivityIndex: null,
            calibration: null,
        }, null, 2));
        writeFileSync(join(activeDir, 'conversation.jsonl'), 'x');

        const expiredDir = join(sessionsDir, expiredId);
        mkdirSync(expiredDir, { recursive: true });
        writeFileSync(join(expiredDir, 'manifest.json'), JSON.stringify({
            sessionId: expiredId,
            workspaceId: 'wrk_test',
            status: 'ended',
            turnCount: 0,
            lastActivityTimestamp: new Date(Date.now() - 46 * 24 * 60 * 60 * 1000).toISOString(),
            configSnapshot: {},
            durableTaskState: null,
            fileActivityIndex: null,
            calibration: null,
        }, null, 2));
        writeFileSync(join(expiredDir, 'conversation.jsonl'), 'x');

        store.insertBatch([makeSessionStarted(activeId), makeSessionStarted(expiredId)]);

        const result = await runStartupObservabilityMaintenance({
            sessionsDir,
            store,
            retention: { days: 30, maxSizeGb: 5 },
            sessionId: activeId,
            sessionDir: activeDir,
            resumed: false,
        });

        expect(result.retention.pruned).toBe(1);
        expect(existsSync(activeDir)).toBe(true);
        expect(existsSync(expiredDir)).toBe(false);
    });
});
