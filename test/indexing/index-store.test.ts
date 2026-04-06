/**
 * Tests for IndexStore (Block 20, M6.3).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
    IndexStore,
    embeddingToBuffer,
    bufferToEmbedding,
    type FileRecord,
    type ChunkRecord,
    type SymbolRecord,
} from '../../src/indexing/index-store.js';

function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), 'aca-index-test-'));
}

function makeFileRecord(path: string, hash = 'abc123'): FileRecord {
    return {
        path,
        hash,
        size: 1024,
        language: 'typescript',
        last_indexed: new Date().toISOString(),
        last_modified: new Date().toISOString(),
    };
}

function makeChunkRecord(filePath: string, chunkId: string, embedding?: Float32Array): ChunkRecord {
    return {
        chunk_id: chunkId,
        file_path: filePath,
        start_line: 1,
        end_line: 50,
        content_hash: 'chunk_hash_' + chunkId,
        embedding: embedding ? embeddingToBuffer(embedding) : null,
    };
}

function makeSymbolRecord(filePath: string, symbolId: string, parentId?: string): SymbolRecord {
    return {
        symbol_id: symbolId,
        file_path: filePath,
        name: 'testSymbol_' + symbolId,
        kind: 'function',
        start_line: 1,
        end_line: 10,
        parent_symbol_id: parentId ?? null,
        signature: 'function testSymbol(): void',
    };
}

describe('IndexStore', () => {
    let tmpDir: string;
    let dbPath: string;
    let store: IndexStore;
    const warnings: string[] = [];

    beforeEach(() => {
        tmpDir = makeTmpDir();
        dbPath = join(tmpDir, 'index.db');
        warnings.length = 0;
        store = new IndexStore(dbPath, (msg) => warnings.push(msg));
    });

    afterEach(() => {
        store.close();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    // --- Test 1: Create index → database file exists with correct tables ---

    describe('database creation', () => {
        it('creates database file with correct tables on open()', () => {
            const ok = store.open();
            expect(ok).toBe(true);
            expect(existsSync(dbPath)).toBe(true);

            // Verify tables exist by querying sqlite_master
            const db = new Database(dbPath, { readonly: true });
            const tables = db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            ).all() as Array<{ name: string }>;
            db.close();

            const tableNames = tables.map((t) => t.name);
            expect(tableNames).toContain('files');
            expect(tableNames).toContain('chunks');
            expect(tableNames).toContain('symbols');
            expect(tableNames).toContain('metadata');
        });

        it('returns true on second open() call (already open)', () => {
            store.open();
            expect(store.open()).toBe(true);
        });

        it('isOpen() reflects database state', () => {
            expect(store.isOpen()).toBe(false);
            store.open();
            expect(store.isOpen()).toBe(true);
            store.close();
            expect(store.isOpen()).toBe(false);
        });

        it('creates parent directories if they do not exist', () => {
            const nestedPath = join(tmpDir, 'a', 'b', 'c', 'index.db');
            const nestedStore = new IndexStore(nestedPath);
            const ok = nestedStore.open();
            expect(ok).toBe(true);
            expect(existsSync(nestedPath)).toBe(true);
            nestedStore.close();
        });

        it('enables WAL journal mode', () => {
            store.open();
            const db = new Database(dbPath, { readonly: true });
            const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
            db.close();
            expect(result[0].journal_mode).toBe('wal');
        });

        it('enables foreign keys', () => {
            store.open();
            const db = new Database(dbPath, { readonly: true });
            const result = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
            db.close();
            expect(result[0].foreign_keys).toBe(1);
        });
    });

    // --- Test 2: Insert file record → query back → matches ---

    describe('file operations', () => {
        beforeEach(() => store.open());

        it('inserts and retrieves a file record', () => {
            const file = makeFileRecord('src/main.ts');
            store.upsertFile(file);

            const retrieved = store.getFile('src/main.ts');
            expect(retrieved).not.toBeNull();
            expect(retrieved!.path).toBe(file.path);
            expect(retrieved!.hash).toBe(file.hash);
            expect(retrieved!.size).toBe(file.size);
            expect(retrieved!.language).toBe(file.language);
        });

        it('updates existing file record on upsert', () => {
            const file = makeFileRecord('src/main.ts', 'hash_v1');
            store.upsertFile(file);

            const updated = makeFileRecord('src/main.ts', 'hash_v2');
            updated.size = 2048;
            store.upsertFile(updated);

            const retrieved = store.getFile('src/main.ts');
            expect(retrieved!.hash).toBe('hash_v2');
            expect(retrieved!.size).toBe(2048);
        });

        it('returns null for non-existent file', () => {
            expect(store.getFile('no/such/file.ts')).toBeNull();
        });

        it('getAllFiles returns all inserted files', () => {
            store.upsertFile(makeFileRecord('a.ts'));
            store.upsertFile(makeFileRecord('b.ts'));
            store.upsertFile(makeFileRecord('c.ts'));

            const all = store.getAllFiles();
            expect(all).toHaveLength(3);
            expect(all.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
        });

        it('handles null language', () => {
            const file = makeFileRecord('data.bin');
            file.language = null;
            store.upsertFile(file);

            const retrieved = store.getFile('data.bin');
            expect(retrieved!.language).toBeNull();
        });
    });

    // --- Test 3: Insert chunk with embedding → retrieve → embedding matches ---

    describe('chunk operations with embeddings', () => {
        beforeEach(() => {
            store.open();
            store.upsertFile(makeFileRecord('src/index.ts'));
        });

        it('inserts chunk with embedding and retrieves it with matching values', () => {
            const dims = 384;
            const embedding = new Float32Array(dims);
            for (let i = 0; i < dims; i++) {
                embedding[i] = Math.random() * 2 - 1; // Random values in [-1, 1]
            }

            const chunk = makeChunkRecord('src/index.ts', 'chunk_1', embedding);
            store.insertChunk(chunk);

            const chunks = store.getChunksByFile('src/index.ts');
            expect(chunks).toHaveLength(1);
            expect(chunks[0].chunk_id).toBe('chunk_1');
            expect(chunks[0].file_path).toBe('src/index.ts');
            expect(chunks[0].start_line).toBe(1);
            expect(chunks[0].end_line).toBe(50);

            // Verify embedding round-trip
            expect(chunks[0].embedding).not.toBeNull();
            const recovered = bufferToEmbedding(chunks[0].embedding!)!;
            expect(recovered).not.toBeNull();
            expect(recovered.length).toBe(dims);
            for (let i = 0; i < dims; i++) {
                expect(recovered[i]).toBeCloseTo(embedding[i], 5);
            }
        });

        it('handles chunk with null embedding', () => {
            const chunk = makeChunkRecord('src/index.ts', 'chunk_no_embed');
            store.insertChunk(chunk);

            const chunks = store.getChunksByFile('src/index.ts');
            expect(chunks).toHaveLength(1);
            expect(chunks[0].embedding).toBeNull();
        });

        it('getAllChunks returns chunks across files', () => {
            store.upsertFile(makeFileRecord('src/a.ts'));
            store.upsertFile(makeFileRecord('src/b.ts'));

            store.insertChunk(makeChunkRecord('src/a.ts', 'c1'));
            store.insertChunk(makeChunkRecord('src/a.ts', 'c2'));
            store.insertChunk(makeChunkRecord('src/b.ts', 'c3'));

            const all = store.getAllChunks();
            expect(all).toHaveLength(3);
        });

        it('deleteChunksByFile removes only chunks for that file', () => {
            store.upsertFile(makeFileRecord('src/a.ts'));
            store.insertChunk(makeChunkRecord('src/index.ts', 'c1'));
            store.insertChunk(makeChunkRecord('src/a.ts', 'c2'));

            store.deleteChunksByFile('src/index.ts');

            expect(store.getChunksByFile('src/index.ts')).toHaveLength(0);
            expect(store.getChunksByFile('src/a.ts')).toHaveLength(1);
        });
    });

    // --- Test 4: Hash-based skip ---

    describe('hash-based skip', () => {
        beforeEach(() => store.open());

        it('returns true when hash matches (file unchanged, skip re-indexing)', () => {
            store.upsertFile(makeFileRecord('src/main.ts', 'sha256_abc'));

            expect(store.hasMatchingHash('src/main.ts', 'sha256_abc')).toBe(true);
        });

        it('returns false when hash differs (file changed, needs re-indexing)', () => {
            store.upsertFile(makeFileRecord('src/main.ts', 'sha256_abc'));

            expect(store.hasMatchingHash('src/main.ts', 'sha256_xyz')).toBe(false);
        });

        it('returns false for non-existent file', () => {
            expect(store.hasMatchingHash('no/such/file.ts', 'any_hash')).toBe(false);
        });
    });

    // --- Test 5: Delete file cascade ---

    describe('delete file cascade', () => {
        beforeEach(() => store.open());

        it('deletes file row, all chunk rows, and all symbol rows for that path', () => {
            // Insert file with chunks and symbols
            const file = makeFileRecord('src/target.ts');
            store.upsertFile(file);

            store.insertChunk(makeChunkRecord('src/target.ts', 'c1'));
            store.insertChunk(makeChunkRecord('src/target.ts', 'c2'));
            store.insertChunk(makeChunkRecord('src/target.ts', 'c3'));

            store.insertSymbol(makeSymbolRecord('src/target.ts', 's1'));
            store.insertSymbol(makeSymbolRecord('src/target.ts', 's2'));

            // Insert another file to verify isolation
            const otherFile = makeFileRecord('src/other.ts');
            store.upsertFile(otherFile);
            store.insertChunk(makeChunkRecord('src/other.ts', 'c4'));
            store.insertSymbol(makeSymbolRecord('src/other.ts', 's3'));

            // Delete target file
            store.deleteFile('src/target.ts');

            // Verify target is gone
            expect(store.getFile('src/target.ts')).toBeNull();
            expect(store.getChunksByFile('src/target.ts')).toHaveLength(0);
            expect(store.getSymbolsByFile('src/target.ts')).toHaveLength(0);

            // Verify other file is untouched
            expect(store.getFile('src/other.ts')).not.toBeNull();
            expect(store.getChunksByFile('src/other.ts')).toHaveLength(1);
            expect(store.getSymbolsByFile('src/other.ts')).toHaveLength(1);
        });
    });

    // --- Additional coverage ---

    describe('symbol operations', () => {
        beforeEach(() => {
            store.open();
            store.upsertFile(makeFileRecord('src/mod.ts'));
        });

        it('inserts and retrieves symbols', () => {
            store.insertSymbol(makeSymbolRecord('src/mod.ts', 'sym1'));
            store.insertSymbol(makeSymbolRecord('src/mod.ts', 'sym2'));

            const symbols = store.getSymbolsByFile('src/mod.ts');
            expect(symbols).toHaveLength(2);
            expect(symbols[0].name).toBe('testSymbol_sym1');
            expect(symbols[0].kind).toBe('function');
            expect(symbols[0].signature).toBe('function testSymbol(): void');
        });

        it('supports parent_symbol_id for hierarchy', () => {
            const parent = makeSymbolRecord('src/mod.ts', 'class1');
            parent.kind = 'class';
            parent.name = 'MyClass';
            store.insertSymbol(parent);

            const child = makeSymbolRecord('src/mod.ts', 'method1', 'class1');
            child.kind = 'method';
            child.name = 'myMethod';
            store.insertSymbol(child);

            const symbols = store.getSymbolsByFile('src/mod.ts');
            const method = symbols.find((s) => s.name === 'myMethod');
            expect(method).toBeDefined();
            expect(method!.parent_symbol_id).toBe('class1');
        });
    });

    describe('metadata operations', () => {
        beforeEach(() => store.open());

        it('sets and gets metadata', () => {
            store.setMetadata('schema_version', '1');
            store.setMetadata('model_name', 'Xenova/all-MiniLM-L6-v2');

            expect(store.getMetadata('schema_version')).toBe('1');
            expect(store.getMetadata('model_name')).toBe('Xenova/all-MiniLM-L6-v2');
        });

        it('upserts metadata on duplicate key', () => {
            store.setMetadata('file_count', '100');
            store.setMetadata('file_count', '200');

            expect(store.getMetadata('file_count')).toBe('200');
        });

        it('returns null for missing key', () => {
            expect(store.getMetadata('nonexistent')).toBeNull();
        });

        it('deletes metadata', () => {
            store.setMetadata('temp', 'value');
            store.deleteMetadata('temp');
            expect(store.getMetadata('temp')).toBeNull();
        });
    });

    describe('reindexFile', () => {
        beforeEach(() => store.open());

        it('atomically replaces chunks and symbols for a file', () => {
            const file = makeFileRecord('src/reindex.ts', 'hash_v1');
            store.upsertFile(file);
            store.insertChunk(makeChunkRecord('src/reindex.ts', 'old_c1'));
            store.insertChunk(makeChunkRecord('src/reindex.ts', 'old_c2'));
            store.insertSymbol(makeSymbolRecord('src/reindex.ts', 'old_s1'));

            // Reindex with new data
            const updatedFile = makeFileRecord('src/reindex.ts', 'hash_v2');
            const newChunks = [makeChunkRecord('src/reindex.ts', 'new_c1')];
            const newSymbols = [
                makeSymbolRecord('src/reindex.ts', 'new_s1'),
                makeSymbolRecord('src/reindex.ts', 'new_s2'),
            ];

            store.reindexFile(updatedFile, newChunks, newSymbols);

            // Verify old data is gone, new data is present
            const chunks = store.getChunksByFile('src/reindex.ts');
            expect(chunks).toHaveLength(1);
            expect(chunks[0].chunk_id).toBe('new_c1');

            const symbols = store.getSymbolsByFile('src/reindex.ts');
            expect(symbols).toHaveLength(2);

            const file2 = store.getFile('src/reindex.ts');
            expect(file2!.hash).toBe('hash_v2');
        });
    });

    describe('getStats', () => {
        beforeEach(() => store.open());

        it('returns correct counts', () => {
            store.upsertFile(makeFileRecord('a.ts'));
            store.upsertFile(makeFileRecord('b.ts'));
            store.insertChunk(makeChunkRecord('a.ts', 'c1'));
            store.insertChunk(makeChunkRecord('a.ts', 'c2'));
            store.insertChunk(makeChunkRecord('b.ts', 'c3'));
            store.insertSymbol(makeSymbolRecord('a.ts', 's1'));

            const stats = store.getStats();
            expect(stats.fileCount).toBe(2);
            expect(stats.chunkCount).toBe(3);
            expect(stats.symbolCount).toBe(1);
        });

        it('returns zeros for empty database', () => {
            const stats = store.getStats();
            expect(stats).toEqual({ fileCount: 0, chunkCount: 0, symbolCount: 0 });
        });
    });

    describe('embedding helpers', () => {
        it('embeddingToBuffer and bufferToEmbedding round-trip', () => {
            const original = new Float32Array([0.1, -0.5, 0.999, 0, -1.0]);
            const buf = embeddingToBuffer(original);
            const recovered = bufferToEmbedding(buf)!;

            expect(recovered).not.toBeNull();
            expect(recovered.length).toBe(original.length);
            for (let i = 0; i < original.length; i++) {
                expect(recovered[i]).toBeCloseTo(original[i], 6);
            }
        });

        it('handles 384-dim embedding', () => {
            const dims = 384;
            const original = new Float32Array(dims);
            for (let i = 0; i < dims; i++) original[i] = i / dims;

            const buf = embeddingToBuffer(original);
            expect(buf.length).toBe(dims * 4); // 4 bytes per float32

            const recovered = bufferToEmbedding(buf)!;
            expect(recovered).not.toBeNull();
            expect(recovered.length).toBe(dims);
            for (let i = 0; i < dims; i++) {
                expect(recovered[i]).toBeCloseTo(original[i], 6);
            }
        });
    });

    describe('graceful degradation', () => {
        it('operations return safe defaults when database is not open', () => {
            // Do NOT call store.open()
            expect(store.getFile('any')).toBeNull();
            expect(store.getAllFiles()).toEqual([]);
            expect(store.hasMatchingHash('any', 'hash')).toBe(false);
            expect(store.getChunksByFile('any')).toEqual([]);
            expect(store.getAllChunks()).toEqual([]);
            expect(store.getSymbolsByFile('any')).toEqual([]);
            expect(store.getMetadata('any')).toBeNull();
            expect(store.getStats()).toEqual({ fileCount: 0, chunkCount: 0, symbolCount: 0 });

            // Write operations should not throw
            store.upsertFile(makeFileRecord('a.ts'));
            store.insertChunk(makeChunkRecord('a.ts', 'c1'));
            store.insertSymbol(makeSymbolRecord('a.ts', 's1'));
            store.setMetadata('k', 'v');
            store.deleteFile('a.ts');
            store.deleteMetadata('k');
        });
    });
});

// --- M6 Post-Milestone Review Regression Tests ---

describe('M6 review: bufferToEmbedding validation', () => {
    it('returns null for empty buffer', () => {
        const result = bufferToEmbedding(Buffer.alloc(0));
        expect(result).toBeNull();
    });

    it('returns null for buffer not multiple of 4 bytes', () => {
        const result = bufferToEmbedding(Buffer.from([1, 2, 3]));
        expect(result).toBeNull();
    });

    it('returns Float32Array for valid buffer', () => {
        const original = new Float32Array([1.0, 2.0, 3.0]);
        const buf = embeddingToBuffer(original);
        const result = bufferToEmbedding(buf);
        expect(result).not.toBeNull();
        expect(result!.length).toBe(3);
        expect(result![0]).toBeCloseTo(1.0);
    });
});
