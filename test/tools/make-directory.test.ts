import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeDirectorySpec, makeDirectoryImpl } from '../../src/tools/make-directory.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

let tmpDir: string;
let registry: ToolRegistry;
let runner: ToolRunner;

let baseContext: { sessionId: string; workspaceRoot: string };

beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aca-make-dir-'));
    baseContext = { sessionId: 'ses_test', workspaceRoot: tmpDir };
    registry = new ToolRegistry();
    registry.register(makeDirectorySpec, makeDirectoryImpl);
    runner = new ToolRunner(registry);
});

afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

function parseData(result: { data: string }): Record<string, unknown> {
    return JSON.parse(result.data) as Record<string, unknown>;
}

describe('make_directory tool', () => {
    describe('spec', () => {
        it('has correct metadata', () => {
            expect(makeDirectorySpec.name).toBe('make_directory');
            expect(makeDirectorySpec.approvalClass).toBe('workspace-write');
            expect(makeDirectorySpec.timeoutCategory).toBe('file');
        });
    });

    describe('create new directory', () => {
        it('creates a directory and returns created=true', async () => {
            const dirPath = join(tmpDir, 'brand-new-dir');

            const result = await runner.execute('make_directory', { path: dirPath }, baseContext);
            expect(result.status).toBe('success');
            expect(result.mutationState).toBe('filesystem');

            const data = parseData(result);
            expect(data.created).toBe(true);

            const s = await stat(dirPath);
            expect(s.isDirectory()).toBe(true);
        });
    });

    describe('already existing directory', () => {
        it('returns created=false without error when directory already exists', async () => {
            const dirPath = join(tmpDir, 'existing-dir');

            // Create it first
            await runner.execute('make_directory', { path: dirPath }, baseContext);

            // Create again
            const result = await runner.execute('make_directory', { path: dirPath }, baseContext);
            expect(result.status).toBe('success');
            expect(result.mutationState).toBe('none');

            const data = parseData(result);
            expect(data.created).toBe(false);
        });
    });

    describe('nested directory creation', () => {
        it('creates all parent directories in a deep path', async () => {
            const dirPath = join(tmpDir, 'a', 'b', 'c', 'd');

            const result = await runner.execute('make_directory', { path: dirPath }, baseContext);
            expect(result.status).toBe('success');

            const data = parseData(result);
            expect(data.created).toBe(true);

            // All levels should exist
            for (const subPath of [
                join(tmpDir, 'a'),
                join(tmpDir, 'a', 'b'),
                join(tmpDir, 'a', 'b', 'c'),
                join(tmpDir, 'a', 'b', 'c', 'd'),
            ]) {
                const s = await stat(subPath);
                expect(s.isDirectory()).toBe(true);
            }
        });
    });

    describe('validation', () => {
        it('returns validation error when path is missing', async () => {
            const result = await runner.execute('make_directory', {}, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
