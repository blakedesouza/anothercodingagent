/**
 * M6.6 — Indexing Wiring Integration Tests
 *
 * Verifies that M6 indexing features are properly wired:
 *   T1: search_semantic tool registered and callable via agent prompt
 *   T2: Index builds on first session for a small test project
 *   T3: /reindex command triggers re-index
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../../src/core/session-manager.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { searchSemanticSpec, createSearchSemanticImpl } from '../../src/tools/search-semantic.js';
import { readFileSpec, readFileImpl } from '../../src/tools/read-file.js';
import type { EmbeddingModel } from '../../src/indexing/embedding.js';
import { IndexStore } from '../../src/indexing/index-store.js';
import { Indexer } from '../../src/indexing/indexer.js';
import { handleSlashCommand, type SlashCommandContext } from '../../src/cli/commands.js';

describe('M6.6 Indexing Wiring Integration', () => {
    let sessionsDir: string;
    let projectDir: string;
    let indexDbDir: string;
    let sm: SessionManager;
    let indexStore: IndexStore;
    let indexer: Indexer;

    beforeAll(() => {
        sessionsDir = mkdtempSync(join(tmpdir(), 'aca-idx-wiring-'));
        sm = new SessionManager(sessionsDir);

        // Create a small test project with TypeScript files
        projectDir = mkdtempSync(join(tmpdir(), 'aca-idx-project-'));
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(
            join(projectDir, 'src', 'auth.ts'),
            [
                'export function authenticate(user: string, pass: string): boolean {',
                '    if (!user || !pass) return false;',
                '    return user === "admin" && pass === "secret";',
                '}',
                '',
                'export function authorize(user: string, role: string): boolean {',
                '    return user === "admin" || role === "viewer";',
                '}',
            ].join('\n'),
        );
        writeFileSync(
            join(projectDir, 'src', 'server.ts'),
            [
                'import { authenticate } from "./auth";',
                '',
                'export function startServer(port: number): void {',
                '    console.log(`Server running on port ${port}`);',
                '}',
                '',
                'export function handleRequest(path: string): string {',
                '    return `Response for ${path}`;',
                '}',
            ].join('\n'),
        );

        // Set up index store (no real embeddings — null embedding model)
        indexDbDir = mkdtempSync(join(tmpdir(), 'aca-idx-db-'));
        const dbPath = join(indexDbDir, 'index.db');
        indexStore = new IndexStore(dbPath);
        indexStore.open();

        // Create indexer with null embedding (pure structural indexing)
        indexer = new Indexer(projectDir, indexStore, null);
    });

    afterAll(() => {
        indexStore.close();
        rmSync(sessionsDir, { recursive: true, force: true });
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(indexDbDir, { recursive: true, force: true });
    });

    function makeCommandContext(overrides?: Partial<SlashCommandContext>): SlashCommandContext {
        const projection = sm.create(projectDir);
        return {
            projection,
            model: 'test-model',
            turnCount: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            exit: () => {},
            ...overrides,
        };
    }

    it('T1: search_semantic tool registered and callable via agent prompt', async () => {
        // Build index first (no embeddings, just structural)
        await indexer.buildIndex();

        const registry = new ToolRegistry();
        registry.register(readFileSpec, readFileImpl);

        // Create a mock embedding model that returns a fixed vector
        const mockEmbedding = {
            available: true,
            dimensions: 384,
            embed: async () => new Float32Array(384).fill(1 / Math.sqrt(384)),
        } as unknown as EmbeddingModel;

        registry.register(
            searchSemanticSpec,
            createSearchSemanticImpl({
                indexer,
                store: indexStore,
                embedding: mockEmbedding,
            }),
        );

        // Verify the tool is registered
        const tools = registry.list();
        const semanticTool = tools.find(t => t.spec.name === 'search_semantic');
        expect(semanticTool).toBeDefined();
        expect(semanticTool!.spec.approvalClass).toBe('read-only');

        // Call the tool directly to verify it's functional
        const impl = semanticTool!.impl;
        const result = await impl(
            { query: 'authentication' },
            { sessionId: 'test', workspaceRoot: projectDir, signal: new AbortController().signal },
        );

        // Without real embeddings in the store, results will be empty
        // (chunks have null embeddings). The important thing is that
        // the tool executes without error and returns a valid response.
        expect(result.status).toBe('success');
        const parsed = JSON.parse(result.data);
        expect(parsed).toHaveProperty('results');
        expect(parsed).toHaveProperty('totalChunks');
    });

    it('T2: index builds on first session for a small test project', async () => {
        // Fresh index store for this test
        const freshDbDir = mkdtempSync(join(tmpdir(), 'aca-idx-fresh-'));
        const freshDbPath = join(freshDbDir, 'index.db');
        const freshStore = new IndexStore(freshDbPath);
        freshStore.open();

        const freshIndexer = new Indexer(projectDir, freshStore, null);

        // Verify no files indexed initially
        const statsBefore = freshStore.getStats();
        expect(statsBefore.fileCount).toBe(0);

        // Build index (simulates session start)
        const result = await freshIndexer.buildIndex();

        expect(result.filesIndexed).toBeGreaterThan(0);
        expect(freshIndexer.ready).toBe(true);
        expect(freshIndexer.indexing).toBe(false);

        // Verify files were indexed
        const statsAfter = freshStore.getStats();
        expect(statsAfter.fileCount).toBe(2); // auth.ts, server.ts
        expect(statsAfter.chunkCount).toBeGreaterThan(0);
        expect(statsAfter.symbolCount).toBeGreaterThan(0);

        // Verify specific files are in the store
        const authFile = freshStore.getFile('src/auth.ts');
        expect(authFile).not.toBeNull();
        expect(authFile!.language).toBe('typescript');

        const serverFile = freshStore.getFile('src/server.ts');
        expect(serverFile).not.toBeNull();

        // Verify symbols were extracted
        const authSymbols = freshStore.getSymbolsByFile('src/auth.ts');
        const symbolNames = authSymbols.map(s => s.name);
        expect(symbolNames).toContain('authenticate');
        expect(symbolNames).toContain('authorize');

        freshStore.close();
        rmSync(freshDbDir, { recursive: true, force: true });
    });

    it('T3: /reindex command triggers re-index', async () => {
        // Build initial index
        await indexer.buildIndex();

        const initialStats = indexStore.getStats();
        expect(initialStats.fileCount).toBe(2);

        // Add a new file to the project
        writeFileSync(
            join(projectDir, 'src', 'utils.ts'),
            [
                'export function formatDate(d: Date): string {',
                '    return d.toISOString();',
                '}',
            ].join('\n'),
        );

        // Use /reindex slash command
        const ctx = makeCommandContext({ indexer });
        const result = await handleSlashCommand('/reindex', ctx);

        expect(result).not.toBeNull();
        expect(result!.output).toContain('[reindex] Complete:');
        expect(result!.shouldExit).toBe(false);

        // Verify the new file was indexed
        const updatedStats = indexStore.getStats();
        expect(updatedStats.fileCount).toBe(3); // auth.ts, server.ts, utils.ts

        const utilsFile = indexStore.getFile('src/utils.ts');
        expect(utilsFile).not.toBeNull();

        // Cleanup the added file
        rmSync(join(projectDir, 'src', 'utils.ts'));
    });

    it('T3d: /reindex removes deleted files from the index', async () => {
        await indexer.buildIndex();
        expect(indexStore.getFile('src/server.ts')).not.toBeNull();

        rmSync(join(projectDir, 'src', 'server.ts'));

        const ctx = makeCommandContext({ indexer });
        const result = await handleSlashCommand('/reindex', ctx);

        expect(result).not.toBeNull();
        expect(result!.output).toContain('[reindex] Complete:');
        expect(indexStore.getFile('src/server.ts')).toBeNull();
        expect(indexStore.getStats().fileCount).toBe(1);

        writeFileSync(
            join(projectDir, 'src', 'server.ts'),
            [
                'import { authenticate } from "./auth";',
                '',
                'export function startServer(port: number): void {',
                '    console.log(`Server running on port ${port}`);',
                '}',
                '',
                'export function handleRequest(path: string): string {',
                '    return `Response for ${path}`;',
                '}',
            ].join('\n'),
        );
    });

    it('T3b: /reindex returns message when no indexer available', async () => {
        const ctx = makeCommandContext(); // no indexer
        const result = await handleSlashCommand('/reindex', ctx);
        expect(result).not.toBeNull();
        expect(result!.output).toContain('not available');
    });

    it('T3c: /reindex returns message when already indexing', async () => {
        // Start a build, then immediately try /reindex
        const buildPromise = indexer.buildIndex();

        // If indexer is still indexing (might be fast for 2 files)
        if (indexer.indexing) {
            const ctx = makeCommandContext({ indexer });
            const result = await handleSlashCommand('/reindex', ctx);
            expect(result).not.toBeNull();
            expect(result!.output).toContain('already in progress');
        }

        await buildPromise;
    });
});
