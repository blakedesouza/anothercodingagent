/**
 * Tests for indexer (Block 20, M6.4).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    symlinkSync,
    rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    parseGitignore,
    isGitignored,
    collectFiles,
    isBinaryContent,
    isGeneratedContent,
    hashContent,
    Indexer,
    DEFAULT_MAX_FILES,
    DEFAULT_MAX_FILE_SIZE,
    DEFAULT_EXTENSIONS,
    DEFAULT_EXCLUDES,
    type IndexerConfig,
} from '../../src/indexing/indexer.js';
import { IndexStore } from '../../src/indexing/index-store.js';

function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'aca-indexer-test-'));
}

function makeConfig(overrides?: Partial<IndexerConfig>): IndexerConfig {
    return {
        maxFileSize: DEFAULT_MAX_FILE_SIZE,
        maxFiles: DEFAULT_MAX_FILES,
        extensions: new Set(DEFAULT_EXTENSIONS),
        excludeDirs: new Set(DEFAULT_EXCLUDES),
        gitignoreRules: [],
        ...overrides,
    };
}

// --- .gitignore parsing ---

describe('parseGitignore', () => {
    it('parses directory pattern', () => {
        const rules = parseGitignore('build/', '/root');
        expect(rules).toHaveLength(1);
        expect(rules[0].dirOnly).toBe(true);
        expect(rules[0].negation).toBe(false);
    });

    it('parses extension pattern', () => {
        const rules = parseGitignore('*.log', '/root');
        expect(rules).toHaveLength(1);
        expect(rules[0].dirOnly).toBe(false);
    });

    it('parses negation pattern', () => {
        const rules = parseGitignore('!important.log', '/root');
        expect(rules).toHaveLength(1);
        expect(rules[0].negation).toBe(true);
    });

    it('skips comments and empty lines', () => {
        const rules = parseGitignore('# comment\n\n*.log\n', '/root');
        expect(rules).toHaveLength(1);
    });
});

describe('isGitignored', () => {
    it('directory pattern — all files under build/ skipped', () => {
        const rules = parseGitignore('build/', '/root');
        expect(isGitignored('build', true, rules, '/root')).toBe(true);
        expect(isGitignored('build/output.js', false, rules, '/root')).toBe(false);
        // build/ only applies to directories
        expect(isGitignored('build', false, rules, '/root')).toBe(false);
    });

    it('extension pattern — all .log files skipped', () => {
        const rules = parseGitignore('*.log', '/root');
        expect(isGitignored('app.log', false, rules, '/root')).toBe(true);
        expect(isGitignored('sub/app.log', false, rules, '/root')).toBe(true);
        expect(isGitignored('app.txt', false, rules, '/root')).toBe(false);
    });

    it('negation pattern — file included despite earlier exclusion', () => {
        const rules = parseGitignore('*.log\n!important.log', '/root');
        expect(isGitignored('app.log', false, rules, '/root')).toBe(true);
        expect(isGitignored('important.log', false, rules, '/root')).toBe(false);
    });

    it('nested .gitignore — both rules applied', () => {
        const rootRules = parseGitignore('*.tmp', '/root');
        const subRules = parseGitignore('local/', '/root/sub');
        const allRules = [...rootRules, ...subRules];
        // Root rule applies everywhere
        expect(isGitignored('sub/file.tmp', false, allRules, '/root')).toBe(true);
        // Sub rule only applies within sub/
        expect(isGitignored('sub/local', true, allRules, '/root')).toBe(true);
    });
});

// --- Content checks ---

describe('isBinaryContent', () => {
    it('detects null bytes as binary', () => {
        const buf = Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f]);
        expect(isBinaryContent(buf)).toBe(true);
    });

    it('allows text content', () => {
        const buf = Buffer.from('Hello world\n');
        expect(isBinaryContent(buf)).toBe(false);
    });
});

describe('isGeneratedContent', () => {
    it('detects // @generated marker', () => {
        expect(isGeneratedContent('// @generated\nconst x = 1;\n')).toBe(true);
    });

    it('detects # auto-generated marker', () => {
        expect(isGeneratedContent('# auto-generated\nsome content\n')).toBe(true);
    });

    it('non-generated file passes', () => {
        expect(isGeneratedContent('const x = 1;\n')).toBe(false);
    });
});

describe('hashContent', () => {
    it('returns consistent SHA-256', () => {
        const buf = Buffer.from('hello');
        const h1 = hashContent(buf);
        const h2 = hashContent(buf);
        expect(h1).toBe(h2);
        expect(h1).toHaveLength(64);
    });
});

// --- File collection ---

describe('collectFiles', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir();
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('collects .ts files', () => {
        writeFileSync(join(tmpDir, 'app.ts'), 'const x = 1;');
        const files = collectFiles(tmpDir, makeConfig());
        expect(files).toContain('app.ts');
    });

    it('node_modules/ skipped entirely', () => {
        mkdirSync(join(tmpDir, 'node_modules'));
        writeFileSync(join(tmpDir, 'node_modules', 'lib.ts'), 'const x = 1;');
        const files = collectFiles(tmpDir, makeConfig());
        expect(files).not.toContain('node_modules/lib.ts');
    });

    it('.git/ never indexed', () => {
        mkdirSync(join(tmpDir, '.git'));
        writeFileSync(join(tmpDir, '.git', 'config'), 'data');
        const files = collectFiles(tmpDir, makeConfig());
        expect(files.some(f => f.startsWith('.git'))).toBe(false);
    });

    it('unknown extension .xyz skipped (whitelist-only)', () => {
        writeFileSync(join(tmpDir, 'file.xyz'), 'data');
        const files = collectFiles(tmpDir, makeConfig());
        expect(files).not.toContain('file.xyz');
    });

    it('coverage/ directory skipped', () => {
        mkdirSync(join(tmpDir, 'coverage'));
        writeFileSync(join(tmpDir, 'coverage', 'lcov.ts'), 'data');
        const files = collectFiles(tmpDir, makeConfig());
        expect(files).not.toContain('coverage/lcov.ts');
    });

    it('file > 100KB skipped with warning', () => {
        const bigContent = 'x'.repeat(DEFAULT_MAX_FILE_SIZE + 1);
        writeFileSync(join(tmpDir, 'big.ts'), bigContent);
        const warnings: string[] = [];
        const files = collectFiles(tmpDir, makeConfig(), (msg) => warnings.push(msg));
        expect(files).not.toContain('big.ts');
        expect(warnings.some(w => w.includes('exceeds limit'))).toBe(true);
    });

    it('maxFiles cap with warning', () => {
        // Create 10 files, cap at 5
        for (let i = 0; i < 10; i++) {
            writeFileSync(join(tmpDir, `file${i}.ts`), `const x = ${i};`);
        }
        const warnings: string[] = [];
        const config = makeConfig({ maxFiles: 5 });
        const files = collectFiles(tmpDir, config, (msg) => warnings.push(msg));
        expect(files.length).toBe(5);
        expect(warnings.some(w => w.includes('maxFiles'))).toBe(true);
    });

    it('.gitignore patterns respected', () => {
        writeFileSync(join(tmpDir, '.gitignore'), '*.log\noutput/\n');
        writeFileSync(join(tmpDir, 'app.ts'), 'code');
        writeFileSync(join(tmpDir, 'debug.log'), 'log data');
        mkdirSync(join(tmpDir, 'output'));
        writeFileSync(join(tmpDir, 'output', 'result.ts'), 'code');
        const files = collectFiles(tmpDir, makeConfig());
        expect(files).toContain('app.ts');
        expect(files).not.toContain('debug.log');
        expect(files).not.toContain('output/result.ts');
    });

    it('vendor/ excluded by default', () => {
        mkdirSync(join(tmpDir, 'vendor'));
        writeFileSync(join(tmpDir, 'vendor', 'lib.ts'), 'code');
        const files = collectFiles(tmpDir, makeConfig());
        expect(files).not.toContain('vendor/lib.ts');
    });

    it('.venv/ excluded by default', () => {
        mkdirSync(join(tmpDir, '.venv'));
        writeFileSync(join(tmpDir, '.venv', 'lib.py'), 'code');
        const files = collectFiles(tmpDir, makeConfig());
        expect(files).not.toContain('.venv/lib.py');
    });
});

// --- Indexer class ---

describe('Indexer', () => {
    let tmpDir: string;
    let dbDir: string;
    let store: IndexStore;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        dbDir = makeTmpDir();
        store = new IndexStore(join(dbDir, 'index.db'));
        store.open();
    });

    afterEach(() => {
        store.close();
        rmSync(tmpDir, { recursive: true, force: true });
        rmSync(dbDir, { recursive: true, force: true });
    });

    it('indexes a TypeScript file with symbols and chunks', async () => {
        writeFileSync(join(tmpDir, 'app.ts'), [
            'function foo() {',
            '    return 1;',
            '}',
            '',
            'function bar() {',
            '    return 2;',
            '}',
        ].join('\n'));

        const indexer = new Indexer(tmpDir, store, null);
        const result = await indexer.buildIndex();

        expect(result.filesIndexed).toBe(1);
        expect(result.chunksCreated).toBeGreaterThanOrEqual(2);
        expect(result.symbolsExtracted).toBe(2);
    });

    it('skips binary file', async () => {
        // Write a file with null bytes
        writeFileSync(join(tmpDir, 'binary.ts'), Buffer.from([0x48, 0x00, 0x6c]));

        const indexer = new Indexer(tmpDir, store, null);
        const result = await indexer.buildIndex();

        expect(result.filesIndexed).toBe(0);
        expect(result.filesSkipped).toBe(1);
    });

    it('skips generated file with marker', async () => {
        writeFileSync(join(tmpDir, 'gen.ts'), '// @generated\nconst x = 1;\n');

        const indexer = new Indexer(tmpDir, store, null);
        const result = await indexer.buildIndex();

        expect(result.filesIndexed).toBe(0);
        expect(result.filesSkipped).toBe(1);
    });

    it('incremental: modify 1 of 10 files → only 1 re-indexed', async () => {
        // Create 10 files
        for (let i = 0; i < 10; i++) {
            writeFileSync(join(tmpDir, `file${i}.ts`), `const x${i} = ${i};`);
        }

        const indexer = new Indexer(tmpDir, store, null);
        await indexer.buildIndex();

        // Modify one file
        writeFileSync(join(tmpDir, 'file3.ts'), 'const x3 = 999;');

        const result = await indexer.incrementalUpdate();
        expect(result.filesIndexed).toBe(1);
        expect(result.filesSkipped).toBe(9);
    });

    it('buildIndex sets ready flag', async () => {
        writeFileSync(join(tmpDir, 'app.ts'), 'const x = 1;');
        const indexer = new Indexer(tmpDir, store, null);

        expect(indexer.ready).toBe(false);
        await indexer.buildIndex();
        expect(indexer.ready).toBe(true);
    });

    it('concurrent buildIndex returns same promise', async () => {
        writeFileSync(join(tmpDir, 'app.ts'), 'const x = 1;');
        const indexer = new Indexer(tmpDir, store, null);

        // Start first build
        const p1 = indexer.buildIndex();
        // Second call returns same promise (deduplication)
        const p2 = indexer.buildIndex();

        const [r1, r2] = await Promise.all([p1, p2]);
        // Both resolve to the same result
        expect(r1.filesIndexed).toBe(1);
        expect(r2.filesIndexed).toBe(1);
        expect(r1).toBe(r2); // Same object reference
    });

    it('handles Python files with class and methods', async () => {
        writeFileSync(join(tmpDir, 'app.py'), [
            'class Foo:',
            '    def method1(self):',
            '        pass',
            '',
            '    def method2(self):',
            '        pass',
            '',
            '    def method3(self):',
            '        pass',
        ].join('\n'));

        const indexer = new Indexer(tmpDir, store, null);
        const result = await indexer.buildIndex();

        expect(result.filesIndexed).toBe(1);
        // Class + 3 methods = 4 symbols
        expect(result.symbolsExtracted).toBeGreaterThanOrEqual(4);
    });

    it('respects maxFileSize option', async () => {
        writeFileSync(join(tmpDir, 'big.ts'), 'x'.repeat(200));
        const indexer = new Indexer(tmpDir, store, null, { maxFileSize: 100 });
        const result = await indexer.buildIndex();
        expect(result.filesIndexed).toBe(0);
    });

    it('stores file hash for incremental skip', async () => {
        writeFileSync(join(tmpDir, 'app.ts'), 'const x = 1;');
        const indexer = new Indexer(tmpDir, store, null);
        await indexer.buildIndex();

        // File record should exist in store
        const file = store.getFile('app.ts');
        expect(file).not.toBeNull();
        expect(file!.hash).toHaveLength(64);

        // Hash match → skip
        expect(store.hasMatchingHash('app.ts', file!.hash)).toBe(true);
    });
});

// --- M6 Post-Milestone Review Regression Tests ---

describe('M6 review: symlink loop detection', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = makeTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('skips symlinked directories to prevent infinite loops', () => {
        const srcDir = join(tmpDir, 'src');
        mkdirSync(srcDir);
        writeFileSync(join(srcDir, 'app.ts'), 'const x = 1;');
        // Create symlink that points back to parent (loop)
        symlinkSync(tmpDir, join(srcDir, 'loop'));

        const config = makeConfig({ maxFiles: 100 });
        const files = collectFiles(tmpDir, config);

        // Should find app.ts but NOT recurse into loop
        expect(files).toContain(join('src', 'app.ts'));
        expect(files.length).toBeLessThan(10);
    });
});

describe('M6 review: buildIndex concurrency guard', () => {
    let tmpDir: string;
    let store: IndexStore;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        writeFileSync(join(tmpDir, 'a.ts'), 'const a = 1;');
        store = new IndexStore(join(tmpDir, 'test-index.db'));
        store.open();
    });
    afterEach(() => { store.close(); rmSync(tmpDir, { recursive: true, force: true }); });

    it('buildIndex returns early when incrementalUpdate is in progress', async () => {
        const indexer = new Indexer(tmpDir, store, null);

        // Start incremental update
        const incPromise = indexer.incrementalUpdate();

        // Try buildIndex while incremental is running
        const buildResult = await indexer.buildIndex();

        // buildIndex should detect _indexing and return early
        expect(buildResult.warnings).toContain('Indexing already in progress');

        await incPromise;
    });
});

describe('M6 review: incrementalUpdate sets ready flag', () => {
    let tmpDir: string;
    let store: IndexStore;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        writeFileSync(join(tmpDir, 'a.ts'), 'const a = 1;');
        store = new IndexStore(join(tmpDir, 'test-index.db'));
        store.open();
    });
    afterEach(() => { store.close(); rmSync(tmpDir, { recursive: true, force: true }); });

    it('sets ready=true after successful incrementalUpdate with data', async () => {
        const indexer = new Indexer(tmpDir, store, null);

        // Initially not ready
        expect(indexer.ready).toBe(false);

        // Run incremental update
        const result = await indexer.incrementalUpdate();

        expect(result.filesIndexed).toBeGreaterThan(0);
        expect(indexer.ready).toBe(true);
    });
});

describe('M6 review: embeddingFailures tracking', () => {
    let tmpDir: string;
    let store: IndexStore;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        writeFileSync(join(tmpDir, 'a.ts'), 'const a = 1;');
        store = new IndexStore(join(tmpDir, 'test-index.db'));
        store.open();
    });
    afterEach(() => { store.close(); rmSync(tmpDir, { recursive: true, force: true }); });

    it('IndexResult includes embeddingFailures field', async () => {
        const indexer = new Indexer(tmpDir, store, null);
        const result = await indexer.buildIndex();

        expect(result).toHaveProperty('embeddingFailures');
        expect(typeof result.embeddingFailures).toBe('number');
        // No embedding model → no failures (embeddings skipped, not failed)
        expect(result.embeddingFailures).toBe(0);
    });
});
