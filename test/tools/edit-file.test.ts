import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { editFileSpec, editFileImpl } from '../../src/tools/edit-file.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

let tmpDir: string;
let registry: ToolRegistry;
let runner: ToolRunner;

let baseContext: { sessionId: string; workspaceRoot: string };

beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aca-edit-file-'));
    baseContext = { sessionId: 'ses_test', workspaceRoot: tmpDir };
    registry = new ToolRegistry();
    registry.register(editFileSpec, editFileImpl);
    runner = new ToolRunner(registry);
});

afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

function parseData(result: { data: string }): Record<string, unknown> {
    return JSON.parse(result.data) as Record<string, unknown>;
}

describe('edit_file tool', () => {
    describe('spec', () => {
        it('has correct metadata', () => {
            expect(editFileSpec.name).toBe('edit_file');
            expect(editFileSpec.approvalClass).toBe('workspace-write');
            expect(editFileSpec.idempotent).toBe(false);
            expect(editFileSpec.timeoutCategory).toBe('file');
        });
    });

    describe('single search/replace', () => {
        it('applies a single edit and returns applied=1, rejects=[]', async () => {
            const filePath = join(tmpDir, 'single-edit.txt');
            await writeFile(filePath, 'Hello world\nSecond line\n');

            const result = await runner.execute(
                'edit_file',
                { path: filePath, edits: [{ search: 'Hello world', replace: 'Hello ACA' }] },
                baseContext,
            );
            expect(result.status).toBe('success');
            expect(result.mutationState).toBe('filesystem');

            const data = parseData(result);
            expect(data.applied).toBe(1);
            expect(data.rejects).toEqual([]);

            const content = await readFile(filePath, 'utf8');
            expect(content).toBe('Hello ACA\nSecond line\n');
        });
    });

    describe('multiple edits', () => {
        it('applies multiple edits in order', async () => {
            const filePath = join(tmpDir, 'multi-edit.txt');
            await writeFile(filePath, 'foo bar baz');

            const result = await runner.execute(
                'edit_file',
                {
                    path: filePath,
                    edits: [
                        { search: 'foo', replace: 'FOO' },
                        { search: 'bar', replace: 'BAR' },
                        { search: 'baz', replace: 'BAZ' },
                    ],
                },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            expect(data.applied).toBe(3);
            expect(data.rejects).toEqual([]);

            const content = await readFile(filePath, 'utf8');
            expect(content).toBe('FOO BAR BAZ');
        });
    });

    describe('search string not found', () => {
        it('reports a reject when search string is not in file', async () => {
            const filePath = join(tmpDir, 'reject-edit.txt');
            await writeFile(filePath, 'original content');

            const result = await runner.execute(
                'edit_file',
                { path: filePath, edits: [{ search: 'nonexistent text', replace: 'replacement' }] },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            expect(data.applied).toBe(0);
            const rejects = data.rejects as Array<{ index: number; search: string; reason: string }>;
            expect(rejects).toHaveLength(1);
            expect(rejects[0].index).toBe(0);
            expect(rejects[0].search).toBe('nonexistent text');
            expect(rejects[0].reason).toContain('not found');

            // File should be unchanged
            const content = await readFile(filePath, 'utf8');
            expect(content).toBe('original content');
        });

        it('applies successful edits even when some reject', async () => {
            const filePath = join(tmpDir, 'partial-edit.txt');
            await writeFile(filePath, 'line one\nline two\n');

            const result = await runner.execute(
                'edit_file',
                {
                    path: filePath,
                    edits: [
                        { search: 'line one', replace: 'LINE ONE' },
                        { search: 'no match here', replace: 'whatever' },
                    ],
                },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            expect(data.applied).toBe(1);
            expect((data.rejects as unknown[]).length).toBe(1);

            const content = await readFile(filePath, 'utf8');
            expect(content).toBe('LINE ONE\nline two\n');
        });
    });

    describe('expectedHash', () => {
        it('rejects edit without modification when hash does not match', async () => {
            const filePath = join(tmpDir, 'hash-check.txt');
            const originalContent = 'content to edit';
            await writeFile(filePath, originalContent);

            const result = await runner.execute(
                'edit_file',
                {
                    path: filePath,
                    edits: [{ search: 'content', replace: 'REPLACED' }],
                    expectedHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
                },
                baseContext,
            );
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.hash_mismatch');

            // File should be unchanged
            const content = await readFile(filePath, 'utf8');
            expect(content).toBe(originalContent);
        });

        it('applies edit when hash matches', async () => {
            const filePath = join(tmpDir, 'hash-match.txt');
            const originalContent = 'correct content';
            const buf = Buffer.from(originalContent, 'utf8');
            const correctHash = createHash('sha256').update(buf).digest('hex');
            await writeFile(filePath, buf);

            const result = await runner.execute(
                'edit_file',
                {
                    path: filePath,
                    edits: [{ search: 'correct', replace: 'verified' }],
                    expectedHash: correctHash,
                },
                baseContext,
            );
            expect(result.status).toBe('success');
            const data = parseData(result);
            expect(data.applied).toBe(1);

            const content = await readFile(filePath, 'utf8');
            expect(content).toBe('verified content');
        });
    });

    describe('file permissions', () => {
        it('preserves file permissions after editing', async () => {
            const filePath = join(tmpDir, 'perm-test.txt');
            await writeFile(filePath, 'some content');
            await chmod(filePath, 0o644);

            const before = await stat(filePath);
            const originalMode = before.mode & 0o777;

            await runner.execute(
                'edit_file',
                { path: filePath, edits: [{ search: 'some', replace: 'other' }] },
                baseContext,
            );

            const after = await stat(filePath);
            expect(after.mode & 0o777).toBe(originalMode);
        });
    });

    describe('error handling', () => {
        it('returns tool.not_found for nonexistent file', async () => {
            const result = await runner.execute(
                'edit_file',
                { path: join(tmpDir, 'no-such-file.txt'), edits: [{ search: 'x', replace: 'y' }] },
                baseContext,
            );
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.not_found');
        });

        it('returns validation error when edits array is missing', async () => {
            const result = await runner.execute(
                'edit_file',
                { path: join(tmpDir, 'x.txt') },
                baseContext,
            );
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
