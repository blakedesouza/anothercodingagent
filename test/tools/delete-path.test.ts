import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deletePathSpec, deletePathImpl } from '../../src/tools/delete-path.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

let tmpDir: string;
let registry: ToolRegistry;
let runner: ToolRunner;

let baseContext: { sessionId: string; workspaceRoot: string };

beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aca-delete-path-'));
    baseContext = { sessionId: 'ses_test', workspaceRoot: tmpDir };
    registry = new ToolRegistry();
    registry.register(deletePathSpec, deletePathImpl);
    runner = new ToolRunner(registry);
});

beforeEach(async () => {
    // Reset fixture directory state between tests
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
});

afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

function parseData(result: { data: string }): Record<string, unknown> {
    return JSON.parse(result.data) as Record<string, unknown>;
}

async function pathExists(p: string): Promise<boolean> {
    try {
        await stat(p);
        return true;
    } catch {
        return false;
    }
}

describe('delete_path tool', () => {
    describe('spec', () => {
        it('has correct metadata', () => {
            expect(deletePathSpec.name).toBe('delete_path');
            expect(deletePathSpec.approvalClass).toBe('workspace-write');
            expect(deletePathSpec.idempotent).toBe(false);
            expect(deletePathSpec.timeoutCategory).toBe('file');
        });
    });

    describe('delete file', () => {
        it('deletes a file and returns deleted=1', async () => {
            const filePath = join(tmpDir, 'to-delete.txt');
            await writeFile(filePath, 'bye');

            const result = await runner.execute('delete_path', { path: filePath }, baseContext);
            expect(result.status).toBe('success');
            expect(result.mutationState).toBe('filesystem');

            const data = parseData(result);
            expect(data.deleted).toBe(1);
            expect(await pathExists(filePath)).toBe(false);
        });
    });

    describe('delete empty directory', () => {
        it('deletes an empty directory and returns deleted=1', async () => {
            const dirPath = join(tmpDir, 'empty-dir');
            await mkdir(dirPath);

            const result = await runner.execute('delete_path', { path: dirPath }, baseContext);
            expect(result.status).toBe('success');

            const data = parseData(result);
            expect(data.deleted).toBe(1);
            expect(await pathExists(dirPath)).toBe(false);
        });
    });

    describe('non-empty directory without recursive', () => {
        it('returns tool.not_empty error for non-empty dir without recursive=true', async () => {
            const dirPath = join(tmpDir, 'non-empty-dir');
            await mkdir(dirPath);
            await writeFile(join(dirPath, 'child.txt'), 'content');

            const result = await runner.execute('delete_path', { path: dirPath }, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.not_empty');

            // Directory and its contents should still exist
            expect(await pathExists(dirPath)).toBe(true);
            expect(await pathExists(join(dirPath, 'child.txt'))).toBe(true);
        });
    });

    describe('recursive delete', () => {
        it('deletes a non-empty directory with recursive=true', async () => {
            const dirPath = join(tmpDir, 'tree');
            await mkdir(join(dirPath, 'subdir'), { recursive: true });
            await writeFile(join(dirPath, 'file1.txt'), 'a');
            await writeFile(join(dirPath, 'file2.txt'), 'b');
            await writeFile(join(dirPath, 'subdir', 'file3.txt'), 'c');

            const result = await runner.execute('delete_path', { path: dirPath, recursive: true }, baseContext);
            expect(result.status).toBe('success');

            const data = parseData(result);
            // tree/ + file1.txt + file2.txt + subdir/ + subdir/file3.txt = 5 items
            expect(data.deleted).toBe(5);
            expect(await pathExists(dirPath)).toBe(false);
        });
    });

    describe('delete nonexistent', () => {
        it('returns tool.not_found for a path that does not exist', async () => {
            const result = await runner.execute(
                'delete_path',
                { path: join(tmpDir, 'ghost.txt') },
                baseContext,
            );
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.not_found');
        });
    });

    describe('validation', () => {
        it('returns validation error when path is missing', async () => {
            const result = await runner.execute('delete_path', {}, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
