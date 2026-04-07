import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { writeFileSpec, writeFileImpl } from '../../src/tools/write-file.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

let tmpDir: string;
let registry: ToolRegistry;
let runner: ToolRunner;

let baseContext: { sessionId: string; workspaceRoot: string };

beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aca-write-file-'));
    baseContext = { sessionId: 'ses_test', workspaceRoot: tmpDir };
    registry = new ToolRegistry();
    registry.register(writeFileSpec, writeFileImpl);
    runner = new ToolRunner(registry);
});

afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

function parseData(result: { data: string }): Record<string, unknown> {
    return JSON.parse(result.data) as Record<string, unknown>;
}

describe('write_file tool', () => {
    describe('spec', () => {
        it('has correct metadata', () => {
            expect(writeFileSpec.name).toBe('write_file');
            expect(writeFileSpec.approvalClass).toBe('workspace-write');
            expect(writeFileSpec.idempotent).toBe(false);
            expect(writeFileSpec.timeoutCategory).toBe('file');
        });
    });

    describe('create new file', () => {
        it('creates a new file and returns bytes_written and sha256 hash', async () => {
            const filePath = join(tmpDir, 'new-file.txt');
            const content = 'Hello, world!';

            const result = await runner.execute('write_file', { path: filePath, content }, baseContext);
            expect(result.status).toBe('success');
            expect(result.mutationState).toBe('filesystem');

            const data = parseData(result);
            expect(data.bytes_written).toBe(Buffer.byteLength(content, 'utf8'));

            // Verify file actually exists with correct content
            const actual = await readFile(filePath, 'utf8');
            expect(actual).toBe(content);

            // Verify hash is correct sha256
            const expectedHash = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
            expect(data.hash).toBe(expectedHash);
        });

        it('resolves relative paths against workspaceRoot instead of process cwd', async () => {
            const content = 'relative file';

            const result = await runner.execute('write_file', { path: 'relative-new-file.txt', content }, baseContext);
            expect(result.status).toBe('success');

            const actual = await readFile(join(tmpDir, 'relative-new-file.txt'), 'utf8');
            expect(actual).toBe(content);
        });
    });

    describe('overwrite existing', () => {
        it('overwrites an existing file with new content', async () => {
            const filePath = join(tmpDir, 'overwrite-me.txt');

            // Create initial file
            await runner.execute('write_file', { path: filePath, content: 'original content' }, baseContext);

            // Overwrite it
            const result = await runner.execute('write_file', { path: filePath, content: 'replaced content' }, baseContext);
            expect(result.status).toBe('success');

            const actual = await readFile(filePath, 'utf8');
            expect(actual).toBe('replaced content');
        });
    });

    describe('parent directory creation', () => {
        it('creates nested parent directories when they do not exist', async () => {
            const filePath = join(tmpDir, 'deep', 'nested', 'dir', 'file.txt');
            const content = 'nested file';

            const result = await runner.execute('write_file', { path: filePath, content }, baseContext);
            expect(result.status).toBe('success');

            const actual = await readFile(filePath, 'utf8');
            expect(actual).toBe(content);

            // Parent dirs should exist
            const parentStat = await stat(join(tmpDir, 'deep', 'nested', 'dir'));
            expect(parentStat.isDirectory()).toBe(true);
        });
    });

    describe('mode=create', () => {
        it('returns tool.already_exists if file already exists in create mode', async () => {
            const filePath = join(tmpDir, 'existing-file.txt');

            // Create the file first
            await runner.execute('write_file', { path: filePath, content: 'original' }, baseContext);

            // Try to create it again in create mode
            const result = await runner.execute('write_file', { path: filePath, content: 'new', mode: 'create' }, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.already_exists');

            // Original content should be unchanged
            const actual = await readFile(filePath, 'utf8');
            expect(actual).toBe('original');
        });

        it('succeeds with mode=create when file does not exist', async () => {
            const filePath = join(tmpDir, 'create-mode-new.txt');

            const result = await runner.execute('write_file', { path: filePath, content: 'brand new', mode: 'create' }, baseContext);
            expect(result.status).toBe('success');

            const actual = await readFile(filePath, 'utf8');
            expect(actual).toBe('brand new');
        });
    });

    describe('validation', () => {
        it('returns validation error when path is missing', async () => {
            const result = await runner.execute('write_file', { content: 'foo' }, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });

        it('returns validation error when content is missing', async () => {
            const result = await runner.execute('write_file', { path: join(tmpDir, 'x.txt') }, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
