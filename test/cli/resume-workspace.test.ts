import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveResumeWorkspaceContext } from '../../src/cli-main.js';
import { SessionManager } from '../../src/core/session-manager.js';

describe('resolveResumeWorkspaceContext', () => {
    let tmpDir: string;
    let sessionManager: SessionManager;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'aca-resume-workspace-'));
        sessionManager = new SessionManager(join(tmpDir, 'sessions'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('uses the resumed session workspace root when a specific session id is provided', () => {
        const projection = sessionManager.create('/repo/stored-workspace', {
            model: { default: 'nanogpt/gemma-4' },
        });

        const resolved = resolveResumeWorkspaceContext(
            sessionManager,
            '/repo/launch-directory',
            true,
            projection.manifest.sessionId,
        );

        expect(resolved.targetSessionId).toBe(projection.manifest.sessionId);
        expect(resolved.effectiveWorkspaceRoot).toBe('/repo/stored-workspace');
    });

    it('uses the latest session workspace root when resuming by workspace', () => {
        const older = sessionManager.create('/repo/current-workspace');
        older.manifest.lastActivityTimestamp = '2026-01-01T00:00:00.000Z';
        sessionManager.saveManifest(older);

        const newer = sessionManager.create('/repo/current-workspace');
        newer.manifest.lastActivityTimestamp = '2026-03-01T00:00:00.000Z';
        sessionManager.saveManifest(newer);

        const resolved = resolveResumeWorkspaceContext(
            sessionManager,
            '/repo/current-workspace',
            true,
        );

        expect(resolved.targetSessionId).toBe(newer.manifest.sessionId);
        expect(resolved.effectiveWorkspaceRoot).toBe('/repo/current-workspace');
    });
});
