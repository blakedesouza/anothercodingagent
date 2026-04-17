import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    buildBraveLaunchCommand,
    detectTopLevelSubcommand,
    ensureDebugUiStarted,
    readDebugUiMetadata,
    resolveDebugUiMetadataPath,
    shouldAutoStartDebugUi,
} from '../../src/debug-ui/manager.js';

describe('debug-ui manager', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('detects known subcommands but treats prompts as the main interactive command', () => {
        expect(detectTopLevelSubcommand(['node', 'aca', 'invoke'])).toBe('invoke');
        expect(detectTopLevelSubcommand(['node', 'aca', '--verbose', 'stats'])).toBe('stats');
        expect(detectTopLevelSubcommand(['node', 'aca', 'fix', 'the', 'bug'])).toBeNull();
    });

    it('auto-starts for normal TTY runs but skips machine-facing commands and CI', () => {
        expect(shouldAutoStartDebugUi(
            ['node', 'aca', 'fix', 'the', 'bug'],
            { env: {}, stdoutIsTTY: true },
        )).toBe(true);

        expect(shouldAutoStartDebugUi(
            ['node', 'aca', 'invoke'],
            { env: {}, stdoutIsTTY: true },
        )).toBe(false);

        expect(shouldAutoStartDebugUi(
            ['node', 'aca', 'stats'],
            { env: { CI: 'true' }, stdoutIsTTY: true },
        )).toBe(false);

        expect(shouldAutoStartDebugUi(
            ['node', 'aca'],
            { env: {}, stdoutIsTTY: false },
        )).toBe(false);
    });

    it('parses valid metadata and rejects malformed payloads', () => {
        const dir = mkdtempSync(join(tmpdir(), 'aca-debug-ui-meta-'));
        const path = join(dir, 'debug-ui.json');

        writeFileSync(path, JSON.stringify({
            version: 1,
            host: '127.0.0.1',
            port: 4777,
            token: 'abc',
            pid: 123,
            url: 'http://127.0.0.1:4777/?token=abc',
            acaHome: dir,
            metadataPath: path,
            startedAt: '2026-04-16T00:00:00.000Z',
        }));
        expect(readDebugUiMetadata(path)?.port).toBe(4777);

        writeFileSync(path, JSON.stringify({ version: 1, host: '127.0.0.1' }));
        expect(readDebugUiMetadata(path)).toBeNull();

        rmSync(dir, { recursive: true, force: true });
    });

    it('builds a Windows Brave launch command when cmd.exe and brave.exe are available', () => {
        const launch = buildBraveLaunchCommand(
            'http://127.0.0.1:4777/?token=abc',
            {},
            (path) => path.includes('cmd.exe') || path.includes('Brave-Browser'),
        );

        expect(launch).not.toBeNull();
        expect(launch?.command).toContain('cmd.exe');
        expect(launch?.args).toContain('--new-tab');
    });

    it('reuses a healthy existing debug UI instance without spawning a second server', async () => {
        const acaHome = mkdtempSync(join(tmpdir(), 'aca-debug-ui-home-'));
        const env = { ACA_HOME: acaHome, PATH: '' };
        const metadataPath = resolveDebugUiMetadataPath(env);

        writeFileSync(metadataPath, JSON.stringify({
            version: 1,
            host: '127.0.0.1',
            port: 4777,
            token: 'abc',
            pid: 321,
            url: 'http://127.0.0.1:4777/?token=abc',
            acaHome,
            metadataPath,
            startedAt: '2026-04-16T00:00:00.000Z',
        }));

        const spawnImpl = vi.fn<typeof import('node:child_process').spawn>();
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
            JSON.stringify({ ok: true }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ));

        const result = await ensureDebugUiStarted({ env, fetchImpl, spawnImpl });

        expect(result.started).toBe(false);
        expect(result.browserOpened).toBe(false);
        expect(result.metadata?.token).toBe('abc');
        expect(spawnImpl).not.toHaveBeenCalled();

        rmSync(acaHome, { recursive: true, force: true });
    });
});
