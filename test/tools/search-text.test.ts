import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchTextSpec, searchTextImpl } from '../../src/tools/search-text.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

let tmpDir: string;
let registry: ToolRegistry;
let runner: ToolRunner;

let baseContext: { sessionId: string; workspaceRoot: string };

beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aca-search-text-'));
    baseContext = { sessionId: 'ses_test', workspaceRoot: tmpDir };
    registry = new ToolRegistry();
    registry.register(searchTextSpec, searchTextImpl);
    runner = new ToolRunner(registry);

    // Fixture layout:
    //   root/
    //     main.ts    → contains function definitions
    //     helper.ts  → contains helper code
    //     styles.css → CSS, non-TypeScript
    //     sub/
    //       util.ts  → utility code
    //     binary.bin → binary file (null bytes)

    await writeFile(join(tmpDir, 'main.ts'), [
        'import { helper } from "./helper";',
        '',
        'function main() {',
        '  const result = helper("world");',
        '  console.log(result);',
        '}',
        '',
        'main();',
    ].join('\n'));

    await writeFile(join(tmpDir, 'helper.ts'), [
        'export function helper(name: string): string {',
        '  return `Hello, ${name}!`;',
        '}',
    ].join('\n'));

    await writeFile(join(tmpDir, 'styles.css'), [
        '.container {',
        '  display: flex;',
        '  function: not-typescript;',
        '}',
    ].join('\n'));

    await mkdir(join(tmpDir, 'sub'));
    await writeFile(join(tmpDir, 'sub', 'util.ts'), [
        '// utility helpers',
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
    ].join('\n'));

    // Binary file with null bytes
    const binaryBuf = Buffer.alloc(64, 0);
    binaryBuf.write('not a text file');
    await writeFile(join(tmpDir, 'binary.bin'), binaryBuf);
});

afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

function parseData(result: { data: string }): Record<string, unknown> {
    return JSON.parse(result.data) as Record<string, unknown>;
}

interface SearchMatch {
    file: string;
    line: number;
    content: string;
    context_before: string[];
    context_after: string[];
}

describe('search_text tool', () => {
    describe('spec', () => {
        it('has correct metadata', () => {
            expect(searchTextSpec.name).toBe('search_text');
            expect(searchTextSpec.approvalClass).toBe('read-only');
            expect(searchTextSpec.idempotent).toBe(true);
            expect(searchTextSpec.timeoutCategory).toBe('file');
        });
    });

    describe('regex pattern matching', () => {
        it('finds all matches with correct line numbers', async () => {
            const result = await runner.execute(
                'search_text',
                { root: tmpDir, pattern: 'function' },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as SearchMatch[];
            expect(matches.length).toBeGreaterThan(0);

            // All matches should include 'function' in their content
            expect(matches.every(m => m.content.includes('function'))).toBe(true);
            // Line numbers should be 1-indexed
            expect(matches.every(m => m.line >= 1)).toBe(true);
        });

        it('returns context lines before and after the match', async () => {
            const result = await runner.execute(
                'search_text',
                { root: tmpDir, pattern: 'const result', context_lines: 1 },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as SearchMatch[];
            expect(matches.length).toBeGreaterThan(0);

            const match = matches[0];
            expect(match.context_before).toHaveLength(1);
            expect(match.context_after).toHaveLength(1);
        });

        it('returns empty context arrays when context_lines=0 (default)', async () => {
            const result = await runner.execute(
                'search_text',
                { root: tmpDir, pattern: 'main' },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as SearchMatch[];
            expect(matches.length).toBeGreaterThan(0);
            expect(matches[0].context_before).toEqual([]);
            expect(matches[0].context_after).toEqual([]);
        });

        it('resolves a relative root against workspaceRoot instead of process cwd', async () => {
            const result = await runner.execute(
                'search_text',
                { root: '.', pattern: 'export function helper' },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as SearchMatch[];
            expect(matches).toHaveLength(1);
            expect(matches[0].file.endsWith('helper.ts')).toBe(true);
        });
    });

    describe('exact match mode', () => {
        it('treats pattern as literal text in exact mode (special chars not escaped)', async () => {
            // In exact mode, '.' is literal not regex wildcard
            const result = await runner.execute(
                'search_text',
                { root: tmpDir, pattern: './helper', exact: true },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as SearchMatch[];
            // Should match the exact string './helper' in the import statement
            expect(matches.length).toBeGreaterThan(0);
            expect(matches.some(m => m.content.includes('./helper'))).toBe(true);
        });
    });

    describe('file glob filter', () => {
        it('restricts search to files matching file_globs', async () => {
            const result = await runner.execute(
                'search_text',
                { root: tmpDir, pattern: 'function', file_globs: ['*.ts'] },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as SearchMatch[];
            expect(matches.length).toBeGreaterThan(0);

            // All matches should be from .ts files only, not .css
            expect(matches.every(m => m.file.endsWith('.ts'))).toBe(true);
        });

        it('does not match files outside the glob filter', async () => {
            const result = await runner.execute(
                'search_text',
                { root: tmpDir, pattern: 'function', file_globs: ['*.css'] },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as SearchMatch[];
            // CSS file has 'function' but .ts files are excluded
            expect(matches.every(m => m.file.endsWith('.css'))).toBe(true);
        });
    });

    describe('limit enforcement', () => {
        it('stops at the specified limit and sets truncated=true', async () => {
            // 'function' appears in multiple files — limit to 1
            const result = await runner.execute(
                'search_text',
                { root: tmpDir, pattern: 'function', limit: 1 },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as SearchMatch[];
            expect(matches).toHaveLength(1);
            expect(data.truncated).toBe(true);
        });
    });

    describe('no matches', () => {
        it('returns an empty matches array when no files contain the pattern', async () => {
            const result = await runner.execute(
                'search_text',
                { root: tmpDir, pattern: 'THIS_PATTERN_DOES_NOT_EXIST_ANYWHERE' },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            expect(data.matches).toEqual([]);
            expect(data.truncated).toBe(false);
        });
    });

    describe('binary file handling', () => {
        it('skips binary files silently', async () => {
            const result = await runner.execute(
                'search_text',
                { root: tmpDir, pattern: 'text' },
                baseContext,
            );
            expect(result.status).toBe('success');

            const data = parseData(result);
            const matches = data.matches as SearchMatch[];
            // binary.bin should not appear in results
            expect(matches.every(m => !m.file.endsWith('.bin'))).toBe(true);
        });
    });

    describe('invalid regex', () => {
        it('returns tool.invalid_input for an invalid regex pattern', async () => {
            const result = await runner.execute(
                'search_text',
                { root: tmpDir, pattern: '[invalid' },
                baseContext,
            );
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.invalid_input');
        });
    });

    describe('validation', () => {
        it('returns validation error when root is missing', async () => {
            const result = await runner.execute('search_text', { pattern: 'foo' }, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });

        it('returns validation error when limit exceeds 200', async () => {
            const result = await runner.execute(
                'search_text',
                { root: tmpDir, pattern: 'foo', limit: 201 },
                baseContext,
            );
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
