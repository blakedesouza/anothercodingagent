import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { statPathSpec, statPathImpl } from '../../src/tools/stat-path.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

let tmpDir: string;
let registry: ToolRegistry;
let runner: ToolRunner;

let baseContext: { sessionId: string; workspaceRoot: string };

beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aca-stat-path-'));
    baseContext = { sessionId: 'ses_test', workspaceRoot: tmpDir };
    registry = new ToolRegistry();
    registry.register(statPathSpec, statPathImpl);
    runner = new ToolRunner(registry);

    await writeFile(join(tmpDir, 'regular.txt'), 'hello world');
    await mkdir(join(tmpDir, 'a-directory'));
});

afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

function parseData(result: { data: string }): Record<string, unknown> {
    return JSON.parse(result.data) as Record<string, unknown>;
}

describe('stat_path tool', () => {
    describe('spec', () => {
        it('has correct metadata', () => {
            expect(statPathSpec.name).toBe('stat_path');
            expect(statPathSpec.approvalClass).toBe('read-only');
            expect(statPathSpec.idempotent).toBe(true);
            expect(statPathSpec.timeoutCategory).toBe('file');
        });
    });

    describe('file stat', () => {
        it('returns correct metadata for a regular file', async () => {
            const result = await runner.execute(
                'stat_path',
                { path: join(tmpDir, 'regular.txt') },
                baseContext,
            );
            expect(result.status).toBe('success');
            expect(result.mutationState).toBe('none');

            const data = parseData(result);
            expect(data.exists).toBe(true);
            expect(data.kind).toBe('file');
            expect(data.size).toBe(Buffer.byteLength('hello world', 'utf8'));
            expect(typeof data.mtime).toBe('number');
            expect((data.mtime as number)).toBeGreaterThan(0);
            expect(typeof data.permissions).toBe('string');
            // permissions should be a 4-character octal string
            expect(/^\d{4}$/.test(data.permissions as string)).toBe(true);
        });
    });

    describe('directory stat', () => {
        it('returns kind=directory for a directory path', async () => {
            const result = await runner.execute(
                'stat_path',
                { path: join(tmpDir, 'a-directory') },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            expect(data.exists).toBe(true);
            expect(data.kind).toBe('directory');
        });
    });

    describe('nonexistent path', () => {
        it('returns exists=false without error for a nonexistent path', async () => {
            const result = await runner.execute(
                'stat_path',
                { path: join(tmpDir, 'ghost.txt') },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            expect(data.exists).toBe(false);
            // No other fields when path doesn't exist
            expect(data.kind).toBeUndefined();
            expect(data.size).toBeUndefined();
        });
    });

    describe('validation', () => {
        it('returns validation error when path is missing', async () => {
            const result = await runner.execute('stat_path', {}, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
