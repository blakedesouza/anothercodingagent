import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { movePathSpec, movePathImpl } from '../../src/tools/move-path.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

let tmpDir: string;
let registry: ToolRegistry;
let runner: ToolRunner;

let baseContext: { sessionId: string; workspaceRoot: string };

beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aca-move-path-'));
    baseContext = { sessionId: 'ses_test', workspaceRoot: tmpDir };
    registry = new ToolRegistry();
    registry.register(movePathSpec, movePathImpl);
    runner = new ToolRunner(registry);
});

beforeEach(async () => {
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

describe('move_path tool', () => {
    describe('spec', () => {
        it('has correct metadata', () => {
            expect(movePathSpec.name).toBe('move_path');
            expect(movePathSpec.approvalClass).toBe('workspace-write');
            expect(movePathSpec.idempotent).toBe(false);
            expect(movePathSpec.timeoutCategory).toBe('file');
        });
    });

    describe('rename file', () => {
        it('renames a file: old path gone, new path exists, conflict=false', async () => {
            const src = join(tmpDir, 'original.txt');
            const dst = join(tmpDir, 'renamed.txt');
            await writeFile(src, 'content');

            const result = await runner.execute('move_path', { source: src, destination: dst }, baseContext);
            expect(result.status).toBe('success');
            expect(result.mutationState).toBe('filesystem');

            const data = parseData(result);
            expect(data.result).toBe('moved');
            expect(data.conflict).toBe(false);

            expect(await pathExists(src)).toBe(false);
            expect(await pathExists(dst)).toBe(true);
        });
    });

    describe('move to existing path', () => {
        it('moves to an existing destination and sets conflict=true', async () => {
            const src = join(tmpDir, 'source.txt');
            const dst = join(tmpDir, 'destination.txt');
            await writeFile(src, 'source content');
            await writeFile(dst, 'existing content');

            const result = await runner.execute('move_path', { source: src, destination: dst }, baseContext);
            expect(result.status).toBe('success');

            const data = parseData(result);
            expect(data.result).toBe('moved');
            expect(data.conflict).toBe(true);

            expect(await pathExists(src)).toBe(false);
            expect(await pathExists(dst)).toBe(true);
        });
    });

    describe('cross-directory move', () => {
        it('moves a file across directories within the same filesystem', async () => {
            const subdir = join(tmpDir, 'subdir');
            await mkdir(subdir);

            const src = join(tmpDir, 'cross-dir.txt');
            const dst = join(subdir, 'moved.txt');
            await writeFile(src, 'moving across dirs');

            const result = await runner.execute('move_path', { source: src, destination: dst }, baseContext);
            expect(result.status).toBe('success');

            const data = parseData(result);
            expect(data.result).toBe('moved');

            expect(await pathExists(src)).toBe(false);
            expect(await pathExists(dst)).toBe(true);
        });
    });

    describe('error handling', () => {
        it('returns tool.not_found when source does not exist', async () => {
            const result = await runner.execute(
                'move_path',
                { source: join(tmpDir, 'ghost.txt'), destination: join(tmpDir, 'target.txt') },
                baseContext,
            );
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.not_found');
        });

        it('returns validation error when source is missing', async () => {
            const result = await runner.execute('move_path', { destination: join(tmpDir, 'dst.txt') }, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
