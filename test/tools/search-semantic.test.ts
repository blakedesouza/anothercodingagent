import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
    searchSemanticSpec,
    createSearchSemanticImpl,
    type SearchSemanticDeps,
    type SemanticSearchResult,
} from '../../src/tools/search-semantic.js';
import { embeddingToBuffer } from '../../src/indexing/index-store.js';
import type { ChunkRecord, SymbolRecord } from '../../src/indexing/index-store.js';
import type { ToolContext } from '../../src/tools/tool-registry.js';
import type { ToolOutput } from '../../src/types/conversation.js';

// --- Helpers ---

function tmpDir(): string {
    const dir = join(tmpdir(), `aca-semantic-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

/** Build a normalized 384-dim vector from a seed number. */
function makeVector(seed: number): Float32Array {
    const vec = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
        vec[i] = Math.sin(seed * (i + 1));
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < 384; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < 384; i++) vec[i] /= norm;
    }
    return vec;
}

/** Build a vector that is very similar to another (high cosine similarity). */
function makeSimilarVector(base: Float32Array, noise = 0.05): Float32Array {
    const vec = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
        vec[i] = base[i] + (Math.random() - 0.5) * noise;
    }
    let norm = 0;
    for (let i = 0; i < 384; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < 384; i++) vec[i] /= norm;
    }
    return vec;
}

function makeChunk(
    filePath: string,
    startLine: number,
    endLine: number,
    embedding: Float32Array | null,
): ChunkRecord {
    return {
        chunk_id: `${filePath}:${startLine}-${endLine}`,
        file_path: filePath,
        start_line: startLine,
        end_line: endLine,
        content_hash: `hash-${filePath}-${startLine}`,
        embedding: embedding ? embeddingToBuffer(embedding) : null,
    };
}

function makeSymbol(
    filePath: string,
    name: string,
    kind: string,
    startLine: number,
    endLine: number,
): SymbolRecord {
    return {
        symbol_id: `${filePath}:sym:${name}`,
        file_path: filePath,
        name,
        kind,
        start_line: startLine,
        end_line: endLine,
        parent_symbol_id: null,
        signature: null,
    };
}

function makeContext(workspaceRoot: string): ToolContext {
    return {
        sessionId: 'test-session',
        workspaceRoot,
        signal: new AbortController().signal,
    };
}

function makeMockDeps(overrides?: Partial<SearchSemanticDeps>): SearchSemanticDeps {
    return {
        indexer: {
            indexing: false,
            ready: true,
        } as SearchSemanticDeps['indexer'],
        store: {
            getAllChunks: vi.fn(() => []),
            getSymbolsByFile: vi.fn(() => []),
        } as unknown as SearchSemanticDeps['store'],
        embedding: {
            available: true,
            embed: vi.fn(async () => makeVector(42)),
        } as unknown as SearchSemanticDeps['embedding'],
        ...overrides,
    };
}

function parseResults(output: ToolOutput): { results: SemanticSearchResult[]; totalChunks?: number } {
    return JSON.parse(output.data);
}

// --- Tests ---

describe('search_semantic', () => {
    describe('spec', () => {
        it('has correct name and approval class', () => {
            expect(searchSemanticSpec.name).toBe('search_semantic');
            expect(searchSemanticSpec.approvalClass).toBe('read-only');
            expect(searchSemanticSpec.idempotent).toBe(true);
            expect(searchSemanticSpec.timeoutCategory).toBe('compute');
        });

        it('requires query input', () => {
            const schema = searchSemanticSpec.inputSchema as Record<string, unknown>;
            expect(schema.required).toEqual(['query']);
        });
    });

    describe('result shape', () => {
        it('each result contains all 6 required fields', async () => {
            const workDir = tmpDir();
            // Create a source file so snippet can be read
            writeFileSync(join(workDir, 'auth.ts'), [
                'export function authenticate(user: string) {',
                '    // validate credentials',
                '    return true;',
                '}',
                '',
            ].join('\n'));

            const authVec = makeVector(10);
            const queryVec = makeSimilarVector(authVec, 0.01);

            const deps = makeMockDeps({
                store: {
                    getAllChunks: vi.fn(() => [
                        makeChunk('auth.ts', 1, 4, authVec),
                    ]),
                    getSymbolsByFile: vi.fn(() => [
                        makeSymbol('auth.ts', 'authenticate', 'function', 1, 4),
                    ]),
                } as unknown as SearchSemanticDeps['store'],
                embedding: {
                    available: true,
                    embed: vi.fn(async () => queryVec),
                } as unknown as SearchSemanticDeps['embedding'],
            });

            const impl = createSearchSemanticImpl(deps);
            const output = await impl({ query: 'authentication handler' }, makeContext(workDir));

            expect(output.status).toBe('success');
            const { results } = parseResults(output);
            expect(results.length).toBe(1);

            const r = results[0];
            // All 6 fields present
            expect(r).toHaveProperty('path');
            expect(r).toHaveProperty('startLine');
            expect(r).toHaveProperty('endLine');
            expect(r).toHaveProperty('score');
            expect(r).toHaveProperty('snippet');
            expect(r).toHaveProperty('symbols');

            // Type checks
            expect(typeof r.path).toBe('string');
            expect(typeof r.startLine).toBe('number');
            expect(typeof r.endLine).toBe('number');
            expect(typeof r.score).toBe('number');
            expect(typeof r.snippet).toBe('string');
            expect(Array.isArray(r.symbols)).toBe(true);

            // Value checks
            expect(r.path).toBe('auth.ts');
            expect(r.startLine).toBe(1);
            expect(r.endLine).toBe(4);
            expect(r.score).toBeGreaterThan(0);
            expect(r.score).toBeLessThanOrEqual(1);
            expect(r.snippet).toContain('authenticate');
            expect(r.symbols).toContain('authenticate');

            rmSync(workDir, { recursive: true, force: true });
        });
    });

    describe('ranking', () => {
        it('ranks more similar chunks higher', async () => {
            const workDir = tmpDir();
            writeFileSync(join(workDir, 'auth.ts'), 'function authenticate() {}\n');
            writeFileSync(join(workDir, 'utils.ts'), 'function formatDate() {}\n');

            // Both vectors have positive similarity with query, but auth is much closer
            const authVec = makeVector(10);
            const utilsVec = makeSimilarVector(authVec, 0.8); // moderate noise — still positive similarity
            const queryVec = makeSimilarVector(authVec, 0.01); // very close to authVec

            const deps = makeMockDeps({
                store: {
                    getAllChunks: vi.fn(() => [
                        makeChunk('utils.ts', 1, 1, utilsVec),
                        makeChunk('auth.ts', 1, 1, authVec),
                    ]),
                    getSymbolsByFile: vi.fn(() => []),
                } as unknown as SearchSemanticDeps['store'],
                embedding: {
                    available: true,
                    embed: vi.fn(async () => queryVec),
                } as unknown as SearchSemanticDeps['embedding'],
            });

            const impl = createSearchSemanticImpl(deps);
            const output = await impl(
                { query: 'authentication', min_score: 0 },
                makeContext(workDir),
            );

            const { results } = parseResults(output);
            expect(results.length).toBe(2);
            expect(results[0].path).toBe('auth.ts');
            expect(results[0].score).toBeGreaterThan(results[1].score);

            rmSync(workDir, { recursive: true, force: true });
        });
    });

    describe('file_filter', () => {
        it('filters results by glob pattern *.ts', async () => {
            const workDir = tmpDir();
            writeFileSync(join(workDir, 'auth.ts'), 'auth code\n');
            writeFileSync(join(workDir, 'auth.py'), 'auth code\n');

            const vec = makeVector(10);
            const queryVec = makeSimilarVector(vec, 0.01);

            const deps = makeMockDeps({
                store: {
                    getAllChunks: vi.fn(() => [
                        makeChunk('auth.ts', 1, 1, vec),
                        makeChunk('auth.py', 1, 1, vec),
                    ]),
                    getSymbolsByFile: vi.fn(() => []),
                } as unknown as SearchSemanticDeps['store'],
                embedding: {
                    available: true,
                    embed: vi.fn(async () => queryVec),
                } as unknown as SearchSemanticDeps['embedding'],
            });

            const impl = createSearchSemanticImpl(deps);
            const output = await impl(
                { query: 'auth', file_filter: '*.ts' },
                makeContext(workDir),
            );

            const { results } = parseResults(output);
            expect(results.length).toBe(1);
            expect(results[0].path).toBe('auth.ts');

            rmSync(workDir, { recursive: true, force: true });
        });
    });

    describe('min_score', () => {
        it('filters out low-scoring results', async () => {
            const workDir = tmpDir();
            writeFileSync(join(workDir, 'auth.ts'), 'auth\n');
            writeFileSync(join(workDir, 'utils.ts'), 'utils\n');

            const authVec = makeVector(10);
            const utilsVec = makeVector(999);
            const queryVec = makeSimilarVector(authVec, 0.01);

            const deps = makeMockDeps({
                store: {
                    getAllChunks: vi.fn(() => [
                        makeChunk('auth.ts', 1, 1, authVec),
                        makeChunk('utils.ts', 1, 1, utilsVec),
                    ]),
                    getSymbolsByFile: vi.fn(() => []),
                } as unknown as SearchSemanticDeps['store'],
                embedding: {
                    available: true,
                    embed: vi.fn(async () => queryVec),
                } as unknown as SearchSemanticDeps['embedding'],
            });

            const impl = createSearchSemanticImpl(deps);
            const output = await impl(
                { query: 'auth', min_score: 0.8 },
                makeContext(workDir),
            );

            const { results } = parseResults(output);
            // Only high-similarity results should pass
            for (const r of results) {
                expect(r.score).toBeGreaterThanOrEqual(0.8);
            }
            // The auth chunk (very similar) should be included
            expect(results.some(r => r.path === 'auth.ts')).toBe(true);

            rmSync(workDir, { recursive: true, force: true });
        });
    });

    describe('limit', () => {
        it('returns exactly limit results when more are available', async () => {
            const workDir = tmpDir();
            const chunks: ChunkRecord[] = [];
            for (let i = 0; i < 10; i++) {
                const fname = `file${i}.ts`;
                writeFileSync(join(workDir, fname), `content ${i}\n`);
                const vec = makeVector(10 + i * 0.001);
                chunks.push(makeChunk(fname, 1, 1, vec));
            }

            const queryVec = makeVector(10);

            const deps = makeMockDeps({
                store: {
                    getAllChunks: vi.fn(() => chunks),
                    getSymbolsByFile: vi.fn(() => []),
                } as unknown as SearchSemanticDeps['store'],
                embedding: {
                    available: true,
                    embed: vi.fn(async () => queryVec),
                } as unknown as SearchSemanticDeps['embedding'],
            });

            const impl = createSearchSemanticImpl(deps);
            const output = await impl(
                { query: 'test', limit: 3, min_score: 0 },
                makeContext(workDir),
            );

            const { results } = parseResults(output);
            expect(results.length).toBe(3);
            expect(output.truncated).toBe(true);

            rmSync(workDir, { recursive: true, force: true });
        });
    });

    describe('index not ready', () => {
        it('returns indexing_in_progress when index is building', async () => {
            const deps = makeMockDeps({
                indexer: { indexing: true, ready: false } as SearchSemanticDeps['indexer'],
            });

            const impl = createSearchSemanticImpl(deps);
            const output = await impl({ query: 'test' }, makeContext('/tmp'));

            expect(output.status).toBe('error');
            expect(output.error?.code).toBe('indexing_in_progress');
            expect(output.retryable).toBe(true);
        });

        it('returns index_unavailable when index not built yet', async () => {
            const deps = makeMockDeps({
                indexer: { indexing: false, ready: false } as SearchSemanticDeps['indexer'],
            });

            const impl = createSearchSemanticImpl(deps);
            const output = await impl({ query: 'test' }, makeContext('/tmp'));

            expect(output.status).toBe('error');
            expect(output.error?.code).toBe('index_unavailable');
            expect(output.retryable).toBe(true);
        });
    });

    describe('empty index', () => {
        it('returns empty results with zero totalChunks', async () => {
            const deps = makeMockDeps();

            const impl = createSearchSemanticImpl(deps);
            const output = await impl({ query: 'test' }, makeContext('/tmp'));

            expect(output.status).toBe('success');
            const parsed = parseResults(output);
            expect(parsed.results).toEqual([]);
            expect(parsed.totalChunks).toBe(0);
        });
    });

    describe('embeddings unavailable', () => {
        it('returns error when embedding model is not available', async () => {
            const deps = makeMockDeps({
                embedding: {
                    available: false,
                    embed: vi.fn(),
                } as unknown as SearchSemanticDeps['embedding'],
            });

            const impl = createSearchSemanticImpl(deps);
            const output = await impl({ query: 'test' }, makeContext('/tmp'));

            expect(output.status).toBe('error');
            expect(output.error?.code).toBe('embeddings_unavailable');
            expect(output.retryable).toBe(false);
        });
    });

    describe('snippet extraction', () => {
        it('returns first 5 lines of chunk as snippet', async () => {
            const workDir = tmpDir();
            const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
            writeFileSync(join(workDir, 'big.ts'), lines.join('\n') + '\n');

            const vec = makeVector(10);
            const queryVec = makeSimilarVector(vec, 0.01);

            const deps = makeMockDeps({
                store: {
                    getAllChunks: vi.fn(() => [
                        makeChunk('big.ts', 1, 20, vec),
                    ]),
                    getSymbolsByFile: vi.fn(() => []),
                } as unknown as SearchSemanticDeps['store'],
                embedding: {
                    available: true,
                    embed: vi.fn(async () => queryVec),
                } as unknown as SearchSemanticDeps['embedding'],
            });

            const impl = createSearchSemanticImpl(deps);
            const output = await impl({ query: 'test' }, makeContext(workDir));

            const { results } = parseResults(output);
            expect(results.length).toBe(1);
            const snippetLines = results[0].snippet.split('\n');
            expect(snippetLines.length).toBe(5);
            expect(snippetLines[0]).toBe('line 1');
            expect(snippetLines[4]).toBe('line 5');

            rmSync(workDir, { recursive: true, force: true });
        });

        it('falls back to line range when file is missing', async () => {
            const deps = makeMockDeps({
                store: {
                    getAllChunks: vi.fn(() => [
                        makeChunk('missing.ts', 5, 15, makeVector(10)),
                    ]),
                    getSymbolsByFile: vi.fn(() => []),
                } as unknown as SearchSemanticDeps['store'],
                embedding: {
                    available: true,
                    embed: vi.fn(async () => makeSimilarVector(makeVector(10), 0.01)),
                } as unknown as SearchSemanticDeps['embedding'],
            });

            const impl = createSearchSemanticImpl(deps);
            const output = await impl({ query: 'test' }, makeContext('/tmp/nonexistent'));

            const { results } = parseResults(output);
            expect(results.length).toBe(1);
            expect(results[0].snippet).toBe('[Lines 5-15]');
        });
    });

    describe('symbols in results', () => {
        it('includes symbols that fall within the chunk line range', async () => {
            const workDir = tmpDir();
            writeFileSync(join(workDir, 'module.ts'), [
                'class AuthService {',
                '    login() {}',
                '    logout() {}',
                '}',
                'function helper() {}',
            ].join('\n') + '\n');

            const vec = makeVector(10);
            const queryVec = makeSimilarVector(vec, 0.01);

            const deps = makeMockDeps({
                store: {
                    getAllChunks: vi.fn(() => [
                        makeChunk('module.ts', 1, 4, vec),
                    ]),
                    getSymbolsByFile: vi.fn(() => [
                        makeSymbol('module.ts', 'AuthService', 'class', 1, 4),
                        makeSymbol('module.ts', 'login', 'method', 2, 2),
                        makeSymbol('module.ts', 'logout', 'method', 3, 3),
                        makeSymbol('module.ts', 'helper', 'function', 5, 5),
                    ]),
                } as unknown as SearchSemanticDeps['store'],
                embedding: {
                    available: true,
                    embed: vi.fn(async () => queryVec),
                } as unknown as SearchSemanticDeps['embedding'],
            });

            const impl = createSearchSemanticImpl(deps);
            const output = await impl({ query: 'auth' }, makeContext(workDir));

            const { results } = parseResults(output);
            expect(results.length).toBe(1);
            // AuthService(1-4), login(2), logout(3) are within range 1-4
            expect(results[0].symbols).toContain('AuthService');
            expect(results[0].symbols).toContain('login');
            expect(results[0].symbols).toContain('logout');
            // helper is at line 5, outside chunk range 1-4
            expect(results[0].symbols).not.toContain('helper');
        });
    });

    describe('chunks without embeddings', () => {
        it('skips chunks that have no embedding', async () => {
            const workDir = tmpDir();
            writeFileSync(join(workDir, 'a.ts'), 'a\n');
            writeFileSync(join(workDir, 'b.ts'), 'b\n');

            const vec = makeVector(10);
            const queryVec = makeSimilarVector(vec, 0.01);

            const deps = makeMockDeps({
                store: {
                    getAllChunks: vi.fn(() => [
                        makeChunk('a.ts', 1, 1, vec),
                        makeChunk('b.ts', 1, 1, null), // no embedding
                    ]),
                    getSymbolsByFile: vi.fn(() => []),
                } as unknown as SearchSemanticDeps['store'],
                embedding: {
                    available: true,
                    embed: vi.fn(async () => queryVec),
                } as unknown as SearchSemanticDeps['embedding'],
            });

            const impl = createSearchSemanticImpl(deps);
            const output = await impl({ query: 'test', min_score: 0 }, makeContext(workDir));

            const { results } = parseResults(output);
            expect(results.length).toBe(1);
            expect(results[0].path).toBe('a.ts');
        });
    });

    describe('defaults', () => {
        it('uses default limit of 10 and min_score of 0.3', async () => {
            const workDir = tmpDir();
            const chunks: ChunkRecord[] = [];
            const baseVec = makeVector(42);

            // Create 15 chunks with high similarity
            for (let i = 0; i < 15; i++) {
                const fname = `f${i}.ts`;
                writeFileSync(join(workDir, fname), `x\n`);
                chunks.push(makeChunk(fname, 1, 1, makeSimilarVector(baseVec, 0.01)));
            }

            const deps = makeMockDeps({
                store: {
                    getAllChunks: vi.fn(() => chunks),
                    getSymbolsByFile: vi.fn(() => []),
                } as unknown as SearchSemanticDeps['store'],
                embedding: {
                    available: true,
                    embed: vi.fn(async () => baseVec),
                } as unknown as SearchSemanticDeps['embedding'],
            });

            const impl = createSearchSemanticImpl(deps);
            const output = await impl({ query: 'test' }, makeContext(workDir));

            const { results } = parseResults(output);
            // Default limit is 10
            expect(results.length).toBe(10);
            // All scores should be above default min_score 0.3
            for (const r of results) {
                expect(r.score).toBeGreaterThanOrEqual(0.3);
            }

            rmSync(workDir, { recursive: true, force: true });
        });
    });
});
