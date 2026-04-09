import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getKnownModelIds } from '../../src/providers/model-registry.js';

const ROOT = join(import.meta.dirname, '..', '..');
const DIST_INDEX = join(ROOT, 'dist', 'index.js');

/**
 * Helper: run `node dist/index.js <args>` and return stdout/stderr/exit code.
 */
function runDist(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
    try {
        const stdout = execFileSync('node', [DIST_INDEX, ...args], {
            cwd: ROOT,
            encoding: 'utf-8',
            timeout: 10_000,
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
        });
        return { stdout, stderr: '', exitCode: 0 };
    } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return {
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? '',
            exitCode: e.status ?? 1,
        };
    }
}

describe('M8.1 — Build & Package', () => {
    beforeAll(() => {
        // Ensure build output exists (build should have been run before tests)
        if (!existsSync(DIST_INDEX)) {
            execFileSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 });
        }
    });

    it('dist/index.js exists and is non-empty', () => {
        expect(existsSync(DIST_INDEX)).toBe(true);
        const stat = statSync(DIST_INDEX);
        expect(stat.size).toBeGreaterThan(1000);
    });

    it('dist/index.js starts with a shebang', () => {
        const first = readFileSync(DIST_INDEX, 'utf-8').split('\n')[0];
        expect(first).toBe('#!/usr/bin/env node');
    });

    it('--version exits 0 and prints semver string', () => {
        const { stdout, exitCode } = runDist('--version');
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('--help exits 0 and prints usage text', () => {
        const { stdout, exitCode } = runDist('--help');
        expect(exitCode).toBe(0);
        expect(stdout).toContain('Usage:');
        expect(stdout).toContain('aca');
        expect(stdout).toContain('Options:');
        expect(stdout).toContain('rp-research');
    });

    it('describe outputs valid JSON matching CapabilityDescriptor schema', () => {
        const { stdout, exitCode } = runDist('describe');
        expect(exitCode).toBe(0);

        const descriptor = JSON.parse(stdout.trim());
        expect(descriptor.contract_version).toBeDefined();
        expect(descriptor.schema_version).toBeDefined();
        expect(descriptor.name).toBe('aca');
        expect(descriptor.input_schema).toBeDefined();
        expect(descriptor.input_schema.type).toBe('object');
        expect(descriptor.output_schema).toBeDefined();
        expect(descriptor.constraints).toBeDefined();
        expect(Array.isArray(descriptor.constraints.supported_tools)).toBe(true);
        expect(descriptor.constraints.supported_tools.length).toBeGreaterThan(10);
    });

    it('describe --json remains accepted as a backward-compatible alias', () => {
        const { stdout, exitCode } = runDist('describe', '--json');
        expect(exitCode).toBe(0);

        const descriptor = JSON.parse(stdout.trim());
        expect(descriptor.name).toBe('aca');
        expect(Array.isArray(descriptor.constraints.supported_tools)).toBe(true);
    });

    it('witnesses --json remains accepted as a backward-compatible alias', () => {
        const { stdout, exitCode } = runDist('witnesses', '--json');
        expect(exitCode).toBe(0);

        const witnesses = JSON.parse(stdout.trim());
        expect(Object.keys(witnesses)).toEqual(['deepseek', 'kimi', 'qwen', 'gemma']);
    });

    it('dev mode (tsx loader) also works with --version', () => {
        const srcIndex = join(ROOT, 'src', 'index.ts');
        try {
            const stdout = execFileSync('node', ['--import', 'tsx', srcIndex, '--version'], {
                cwd: ROOT,
                encoding: 'utf-8',
                timeout: 15_000,
                env: { ...process.env, NODE_NO_WARNINGS: '1' },
            });
            expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
        } catch (err: unknown) {
            const e = err as { stdout?: string; stderr?: string; status?: number };
            // The loader path should exit cleanly, but preserve the old leniency:
            // as long as version is in stdout, the dev entry is still working.
            if (e.stdout && /^\d+\.\d+\.\d+$/.test(e.stdout.trim())) {
                expect(e.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
            } else {
                throw err;
            }
        }
    });

    it('native module better-sqlite3 is resolvable', () => {
        // Verify the native module can be found from project root
        expect(() => require.resolve('better-sqlite3')).not.toThrow();
    });

    it('model registry data is populated (JSON inlined correctly)', () => {
        const ids = getKnownModelIds();
        expect(Array.isArray(ids)).toBe(true);
        expect(ids.length).toBeGreaterThan(0);
    });

    it('unknown option exits non-zero', () => {
        // Commander rejects unknown flags. Single-word args route to one-shot mode
        // (treated as prompts), so we test flags instead.
        const { stderr, exitCode } = runDist('--nonexistent-flag-xyz');
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("unknown option '--nonexistent-flag-xyz'");
    });
});
