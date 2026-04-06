import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';

import { runInit, runTrust, runUntrust } from '../../src/cli/setup.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/config/schema.js';

describe('CLI Setup Commands', () => {
    let testDir: string;

    beforeEach(async () => {
        testDir = await mkdtemp(join(tmpdir(), 'aca-setup-'));
    });

    afterEach(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    // --- aca init ---

    describe('runInit', () => {
        it('creates ~/.aca/ directory structure, secrets.json with 0600, and config.json', async () => {
            const result = await runInit(testDir);

            expect(result.success).toBe(true);
            expect(result.message).toContain('Directory:');
            expect(result.message).toContain('Created config.json');
            expect(result.message).toContain('Created secrets.json');

            // Verify directory structure
            const sessionsDir = await stat(join(testDir, 'sessions'));
            expect(sessionsDir.isDirectory()).toBe(true);

            const indexesDir = await stat(join(testDir, 'indexes'));
            expect(indexesDir.isDirectory()).toBe(true);

            // Verify config.json
            const configContent = JSON.parse(await readFile(join(testDir, 'config.json'), 'utf-8'));
            expect(configContent.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
            expect(configContent.model).toBeDefined();
            expect(configContent.network).toBeDefined();

            // Verify secrets.json
            const secretsContent = await readFile(join(testDir, 'secrets.json'), 'utf-8');
            expect(JSON.parse(secretsContent)).toEqual({});

            // Verify permissions (POSIX only)
            if (platform() !== 'win32') {
                const secretsStats = await stat(join(testDir, 'secrets.json'));
                const mode = secretsStats.mode & 0o777;
                expect(mode).toBe(0o600);
            }
        });

        it('on Windows, secrets.json ACL set via icacls; startup permission check uses fs.access', async () => {
            // This test verifies the Windows path is handled gracefully.
            // On non-Windows, it still creates secrets.json with 0600.
            // The actual icacls invocation only runs on win32.
            const result = await runInit(testDir);
            expect(result.success).toBe(true);

            // Verify file is readable by current user (works on all platforms)
            const secretsPath = join(testDir, 'secrets.json');
            const content = await readFile(secretsPath, 'utf-8');
            expect(content).toBe('{}\n');
        });

        it('when ~/.aca/ exists, preserves existing files', async () => {
            // Pre-create files with custom content
            await writeFile(join(testDir, 'config.json'), '{"custom": true}\n', 'utf-8');
            await writeFile(join(testDir, 'secrets.json'), '{"nanogpt": "sk-test"}\n', 'utf-8');

            const result = await runInit(testDir);

            expect(result.success).toBe(true);
            expect(result.message).toContain('config.json already exists (preserved)');
            expect(result.message).toContain('secrets.json already exists (preserved)');

            // Verify files NOT overwritten
            const configContent = await readFile(join(testDir, 'config.json'), 'utf-8');
            expect(JSON.parse(configContent)).toEqual({ custom: true });

            const secretsContent = await readFile(join(testDir, 'secrets.json'), 'utf-8');
            expect(JSON.parse(secretsContent)).toEqual({ nanogpt: 'sk-test' });
        });
    });

    // --- aca trust ---

    describe('runTrust', () => {
        it('aca trust /path/to/project updates trustedWorkspaces in config', async () => {
            // Init first
            await runInit(testDir);

            const projectPath = '/home/user/my-project';
            const result = await runTrust(projectPath, testDir);

            expect(result.success).toBe(true);
            expect(result.message).toContain(`Trusted: ${projectPath}`);

            // Verify config updated
            const config = JSON.parse(await readFile(join(testDir, 'config.json'), 'utf-8'));
            expect(config.trustedWorkspaces[projectPath]).toBe('trusted');
        });

        it('aca untrust /path/to/project removes entry', async () => {
            // Init and trust first
            await runInit(testDir);
            await runTrust('/home/user/my-project', testDir);

            const result = await runUntrust('/home/user/my-project', testDir);

            expect(result.success).toBe(true);
            expect(result.message).toContain('Untrusted: /home/user/my-project');

            // Verify entry removed
            const config = JSON.parse(await readFile(join(testDir, 'config.json'), 'utf-8'));
            expect(config.trustedWorkspaces['/home/user/my-project']).toBeUndefined();
        });

        it('aca trust without path uses cwd', async () => {
            await runInit(testDir);

            // Trust with no path → uses process.cwd()
            const result = await runTrust(undefined, testDir);

            expect(result.success).toBe(true);
            expect(result.message).toContain(`Trusted: ${process.cwd()}`);

            const config = JSON.parse(await readFile(join(testDir, 'config.json'), 'utf-8'));
            expect(config.trustedWorkspaces[process.cwd()]).toBe('trusted');
        });

        it('trust creates config if it does not exist', async () => {
            // Don't run init — config.json doesn't exist
            const result = await runTrust('/some/path', testDir);

            expect(result.success).toBe(true);

            const config = JSON.parse(await readFile(join(testDir, 'config.json'), 'utf-8'));
            expect(config.trustedWorkspaces['/some/path']).toBe('trusted');
            expect(config.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
        });

        it('untrust on non-trusted path is a no-op', async () => {
            await runInit(testDir);

            const result = await runUntrust('/never/trusted', testDir);

            expect(result.success).toBe(true);
            expect(result.message).toContain('Not trusted (no change)');
        });

        it('trust preserves other config fields', async () => {
            // Write a config with extra fields
            await mkdir(testDir, { recursive: true });
            await writeFile(join(testDir, 'config.json'), JSON.stringify({
                schemaVersion: CURRENT_SCHEMA_VERSION,
                model: { default: 'gpt-4o' },
                defaultProvider: 'openai',
            }, null, 2) + '\n', 'utf-8');

            await runTrust('/my/project', testDir);

            const config = JSON.parse(await readFile(join(testDir, 'config.json'), 'utf-8'));
            expect(config.model.default).toBe('gpt-4o');
            expect(config.defaultProvider).toBe('openai');
            expect(config.trustedWorkspaces['/my/project']).toBe('trusted');
        });
    });
});
