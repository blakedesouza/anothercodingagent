import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findPathsSpec, findPathsImpl } from '../../src/tools/find-paths.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

let tmpDir: string;
let registry: ToolRegistry;
let runner: ToolRunner;

let baseContext: { sessionId: string; workspaceRoot: string };

beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aca-find-paths-'));
    baseContext = { sessionId: 'ses_test', workspaceRoot: tmpDir };
    registry = new ToolRegistry();
    registry.register(findPathsSpec, findPathsImpl);
    runner = new ToolRunner(registry);

    // Fixture layout:
    //   root/
    //     .gitignore        → ignores *.js
    //     alpha.ts
    //     beta.ts
    //     gamma.js          ← should be ignored by .gitignore
    //     sub/
    //       delta.ts
    //       epsilon.js      ← should be ignored by .gitignore
    //     node_modules/     ← excluded by .gitignore

    await writeFile(join(tmpDir, '.gitignore'), '*.js\nnode_modules/\n');
    await writeFile(join(tmpDir, 'alpha.ts'), 'export const a = 1;');
    await writeFile(join(tmpDir, 'beta.ts'), 'export const b = 2;');
    await writeFile(join(tmpDir, 'gamma.js'), 'const g = 3;');
    await mkdir(join(tmpDir, 'sub'));
    await writeFile(join(tmpDir, 'sub', 'delta.ts'), 'export const d = 4;');
    await writeFile(join(tmpDir, 'sub', 'epsilon.js'), 'const e = 5;');
    await mkdir(join(tmpDir, 'node_modules'));
    await writeFile(join(tmpDir, 'node_modules', 'pkg.ts'), 'ignored');
});

afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

function parseData(result: { data: string }): Record<string, unknown> {
    return JSON.parse(result.data) as Record<string, unknown>;
}

interface PathMatch {
    path: string;
    kind: string;
    size: number;
    mtime: number;
}

describe('find_paths tool', () => {
    describe('spec', () => {
        it('has correct metadata', () => {
            expect(findPathsSpec.name).toBe('find_paths');
            expect(findPathsSpec.approvalClass).toBe('read-only');
            expect(findPathsSpec.idempotent).toBe(true);
            expect(findPathsSpec.timeoutCategory).toBe('file');
        });
    });

    describe('glob pattern matching', () => {
        it('finds .ts files but not .js files with *.ts pattern', async () => {
            const result = await runner.execute(
                'find_paths',
                { root: tmpDir, pattern: '*.ts' },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as PathMatch[];

            // Should find alpha.ts, beta.ts, sub/delta.ts but NOT gamma.js or epsilon.js
            const names = matches.map(m => m.path.split('/').pop());
            expect(names).toContain('alpha.ts');
            expect(names).toContain('beta.ts');
            expect(names).toContain('delta.ts');
            expect(names).not.toContain('gamma.js');
            expect(names).not.toContain('epsilon.js');
        });

        it('returns correct kind, size, and mtime for each match', async () => {
            const result = await runner.execute(
                'find_paths',
                { root: tmpDir, pattern: 'alpha.ts' },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as PathMatch[];
            expect(matches).toHaveLength(1);
            expect(matches[0].kind).toBe('file');
            expect(matches[0].size).toBeGreaterThan(0);
            expect(matches[0].mtime).toBeGreaterThan(0);
        });
    });

    describe('limit enforcement', () => {
        it('returns exactly the number of results specified by limit', async () => {
            const result = await runner.execute(
                'find_paths',
                { root: tmpDir, pattern: '*.ts', limit: 2 },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as PathMatch[];
            expect(matches).toHaveLength(2);
            expect(data.truncated).toBe(true);
        });

        it('does not truncate when results are within the limit', async () => {
            const result = await runner.execute(
                'find_paths',
                { root: tmpDir, pattern: '*.ts', limit: 50 },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            expect(data.truncated).toBe(false);
        });
    });

    describe('.gitignore support', () => {
        it('excludes files matching .gitignore patterns', async () => {
            const result = await runner.execute(
                'find_paths',
                { root: tmpDir, pattern: '*' },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as PathMatch[];
            const names = matches.map(m => m.path.split('/').pop());

            // .js files should be excluded
            expect(names).not.toContain('gamma.js');
            expect(names).not.toContain('epsilon.js');
            // node_modules directory should be excluded
            expect(names).not.toContain('node_modules');
            expect(names).not.toContain('pkg.ts');
        });
    });

    describe('type filter', () => {
        it('returns only directories when type=directory', async () => {
            const result = await runner.execute(
                'find_paths',
                { root: tmpDir, pattern: '*', type: 'directory' },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as PathMatch[];
            expect(matches.every(m => m.kind === 'directory')).toBe(true);
            expect(matches.length).toBeGreaterThan(0);
        });

        it('returns only files when type=file', async () => {
            const result = await runner.execute(
                'find_paths',
                { root: tmpDir, pattern: '*.ts', type: 'file' },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as PathMatch[];
            expect(matches.every(m => m.kind === 'file')).toBe(true);
        });
    });

    describe('max 200 cap', () => {
        it('schema rejects limit > 200', async () => {
            const result = await runner.execute(
                'find_paths',
                { root: tmpDir, pattern: '*', limit: 250 },
                baseContext,
            );
            // Schema has maximum: 200, so ToolRunner validation catches this
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });

    describe('error handling', () => {
        it('returns tool.not_found when root does not exist', async () => {
            const result = await runner.execute(
                'find_paths',
                { root: join(tmpDir, 'nonexistent'), pattern: '*' },
                baseContext,
            );
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.not_found');
        });

        it('returns validation error when root is missing', async () => {
            const result = await runner.execute('find_paths', { pattern: '*.ts' }, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
