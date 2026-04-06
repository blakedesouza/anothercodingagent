/**
 * Per-project SQLite index store (Block 20, M6.3).
 *
 * Stores file metadata, text chunks with embeddings, and extracted symbols
 * for semantic code search. Each project gets its own database at
 * ~/.aca/indexes/<workspaceId>/index.db.
 *
 * Uses better-sqlite3 for synchronous reads/writes. Failures emit warnings
 * but never crash the agent.
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// --- Schema DDL ---

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    language TEXT,
    last_indexed TEXT NOT NULL,
    last_modified TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    embedding BLOB,
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS symbols (
    symbol_id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    parent_symbol_id TEXT,
    signature TEXT,
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE,
    FOREIGN KEY (parent_symbol_id) REFERENCES symbols(symbol_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
`;

// --- Types ---

export interface FileRecord {
    path: string;
    hash: string;
    size: number;
    language: string | null;
    last_indexed: string;
    last_modified: string;
}

export interface ChunkRecord {
    chunk_id: string;
    file_path: string;
    start_line: number;
    end_line: number;
    content_hash: string;
    embedding: Buffer | null;
}

export interface SymbolRecord {
    symbol_id: string;
    file_path: string;
    name: string;
    kind: string;
    start_line: number;
    end_line: number;
    parent_symbol_id: string | null;
    signature: string | null;
}

export interface MetadataRecord {
    key: string;
    value: string;
}

export type WarnFn = (message: string) => void;
const defaultWarn: WarnFn = () => {};

// --- Embedding helpers ---

/** Convert a Float32Array to a Buffer for SQLite BLOB storage (defensive copy). */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
    return Buffer.from(
        embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength),
    );
}

/** Convert a SQLite BLOB Buffer back to a Float32Array. Returns null if buffer is invalid. */
export function bufferToEmbedding(buf: Buffer): Float32Array | null {
    if (buf.length === 0 || buf.length % 4 !== 0) {
        return null;
    }
    // Copy into a properly aligned ArrayBuffer
    const ab = new ArrayBuffer(buf.length);
    const view = new Uint8Array(ab);
    view.set(buf);
    return new Float32Array(ab);
}

// --- Index Store ---

export class IndexStore {
    private db: DatabaseType | null = null;
    private readonly dbPath: string;
    private readonly warn: WarnFn;

    // Cached prepared statements
    private stmts: {
        upsertFile: Statement | null;
        getFile: Statement | null;
        getFileHash: Statement | null;
        deleteFile: Statement | null;
        getAllFiles: Statement | null;
        insertChunk: Statement | null;
        getChunksByFile: Statement | null;
        getAllChunks: Statement | null;
        deleteChunksByFile: Statement | null;
        insertSymbol: Statement | null;
        getSymbolsByFile: Statement | null;
        deleteSymbolsByFile: Statement | null;
        getMetadata: Statement | null;
        setMetadata: Statement | null;
        deleteMetadata: Statement | null;
    } = {
        upsertFile: null,
        getFile: null,
        getFileHash: null,
        deleteFile: null,
        getAllFiles: null,
        insertChunk: null,
        getChunksByFile: null,
        getAllChunks: null,
        deleteChunksByFile: null,
        insertSymbol: null,
        getSymbolsByFile: null,
        deleteSymbolsByFile: null,
        getMetadata: null,
        setMetadata: null,
        deleteMetadata: null,
    };

    constructor(dbPath: string, warn?: WarnFn) {
        this.dbPath = dbPath;
        this.warn = warn ?? defaultWarn;
    }

    /**
     * Open the database and ensure schema exists.
     * Creates parent directories if needed.
     * Returns false if the database could not be opened.
     */
    open(): boolean {
        if (this.db) return true;

        try {
            mkdirSync(dirname(this.dbPath), { recursive: true });
            this.db = new Database(this.dbPath);
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('foreign_keys = ON');
            this.db.exec(SCHEMA_DDL);
            this.prepareStatements();
            return true;
        } catch (err) {
            this.warn(`IndexStore open failed: ${(err as Error).message}`);
            this.db = null;
            return false;
        }
    }

    /** Close the database connection. */
    close(): void {
        this.clearStatements();
        try {
            this.db?.close();
        } catch {
            // Ignore close errors
        }
        this.db = null;
    }

    /** Returns true if the database is open. */
    isOpen(): boolean {
        return this.db !== null;
    }

    // --- File operations ---

    /** Insert or update a file record (atomic ON CONFLICT DO UPDATE). */
    upsertFile(file: FileRecord): void {
        if (!this.db) return;
        try {
            this.stmts.upsertFile!.run(
                file.path,
                file.hash,
                file.size,
                file.language ?? null,
                file.last_indexed,
                file.last_modified,
            );
        } catch (err) {
            this.warn(`IndexStore upsertFile failed: ${(err as Error).message}`);
        }
    }

    /** Get a file record by path. Returns null if not found. */
    getFile(path: string): FileRecord | null {
        if (!this.db) return null;
        try {
            const row = this.stmts.getFile!.get(path) as FileRecord | undefined;
            return row ?? null;
        } catch (err) {
            this.warn(`IndexStore getFile failed: ${(err as Error).message}`);
            return null;
        }
    }

    /** Get all file records. */
    getAllFiles(): FileRecord[] {
        if (!this.db) return [];
        try {
            return this.stmts.getAllFiles!.all() as FileRecord[];
        } catch (err) {
            this.warn(`IndexStore getAllFiles failed: ${(err as Error).message}`);
            return [];
        }
    }

    /**
     * Check if a file's content hash matches the indexed hash.
     * Returns true if the hash matches (file unchanged, skip re-indexing).
     */
    hasMatchingHash(path: string, hash: string): boolean {
        if (!this.db) return false;
        try {
            const row = this.stmts.getFileHash!.get(path) as { hash: string } | undefined;
            return row?.hash === hash;
        } catch (err) {
            this.warn(`IndexStore hasMatchingHash failed: ${(err as Error).message}`);
            return false;
        }
    }

    /**
     * Delete a file and all its associated chunks and symbols (cascade).
     * Uses a transaction to ensure atomicity.
     */
    deleteFile(path: string): void {
        if (!this.db) return;
        try {
            // Foreign key cascade handles chunks and symbols automatically
            this.stmts.deleteFile!.run(path);
        } catch (err) {
            this.warn(`IndexStore deleteFile failed: ${(err as Error).message}`);
        }
    }

    // --- Chunk operations ---

    /** Insert a chunk record. Embedding should be converted via embeddingToBuffer(). */
    insertChunk(chunk: ChunkRecord): void {
        if (!this.db) return;
        try {
            this.stmts.insertChunk!.run(
                chunk.chunk_id,
                chunk.file_path,
                chunk.start_line,
                chunk.end_line,
                chunk.content_hash,
                chunk.embedding,
            );
        } catch (err) {
            this.warn(`IndexStore insertChunk failed: ${(err as Error).message}`);
        }
    }

    /** Get all chunks for a file path. */
    getChunksByFile(filePath: string): ChunkRecord[] {
        if (!this.db) return [];
        try {
            return this.stmts.getChunksByFile!.all(filePath) as ChunkRecord[];
        } catch (err) {
            this.warn(`IndexStore getChunksByFile failed: ${(err as Error).message}`);
            return [];
        }
    }

    /** Get all chunks (for loading embeddings into memory at session start). */
    getAllChunks(): ChunkRecord[] {
        if (!this.db) return [];
        try {
            return this.stmts.getAllChunks!.all() as ChunkRecord[];
        } catch (err) {
            this.warn(`IndexStore getAllChunks failed: ${(err as Error).message}`);
            return [];
        }
    }

    /** Delete all chunks for a file path. */
    deleteChunksByFile(filePath: string): void {
        if (!this.db) return;
        try {
            this.stmts.deleteChunksByFile!.run(filePath);
        } catch (err) {
            this.warn(`IndexStore deleteChunksByFile failed: ${(err as Error).message}`);
        }
    }

    // --- Symbol operations ---

    /** Insert a symbol record. */
    insertSymbol(symbol: SymbolRecord): void {
        if (!this.db) return;
        try {
            this.stmts.insertSymbol!.run(
                symbol.symbol_id,
                symbol.file_path,
                symbol.name,
                symbol.kind,
                symbol.start_line,
                symbol.end_line,
                symbol.parent_symbol_id,
                symbol.signature,
            );
        } catch (err) {
            this.warn(`IndexStore insertSymbol failed: ${(err as Error).message}`);
        }
    }

    /** Get all symbols for a file path. */
    getSymbolsByFile(filePath: string): SymbolRecord[] {
        if (!this.db) return [];
        try {
            return this.stmts.getSymbolsByFile!.all(filePath) as SymbolRecord[];
        } catch (err) {
            this.warn(`IndexStore getSymbolsByFile failed: ${(err as Error).message}`);
            return [];
        }
    }

    /** Delete all symbols for a file path. */
    deleteSymbolsByFile(filePath: string): void {
        if (!this.db) return;
        try {
            this.stmts.deleteSymbolsByFile!.run(filePath);
        } catch (err) {
            this.warn(`IndexStore deleteSymbolsByFile failed: ${(err as Error).message}`);
        }
    }

    // --- Metadata operations ---

    /** Get a metadata value by key. Returns null if not found. */
    getMetadata(key: string): string | null {
        if (!this.db) return null;
        try {
            const row = this.stmts.getMetadata!.get(key) as MetadataRecord | undefined;
            return row?.value ?? null;
        } catch (err) {
            this.warn(`IndexStore getMetadata failed: ${(err as Error).message}`);
            return null;
        }
    }

    /** Set a metadata key/value pair (upsert). */
    setMetadata(key: string, value: string): void {
        if (!this.db) return;
        try {
            this.stmts.setMetadata!.run(key, value);
        } catch (err) {
            this.warn(`IndexStore setMetadata failed: ${(err as Error).message}`);
        }
    }

    /** Delete a metadata key. */
    deleteMetadata(key: string): void {
        if (!this.db) return;
        try {
            this.stmts.deleteMetadata!.run(key);
        } catch (err) {
            this.warn(`IndexStore deleteMetadata failed: ${(err as Error).message}`);
        }
    }

    // --- Bulk operations ---

    /**
     * Re-index a file: delete old chunks/symbols, insert new ones.
     * Runs in a single transaction for atomicity.
     */
    reindexFile(
        file: FileRecord,
        chunks: ChunkRecord[],
        symbols: SymbolRecord[],
    ): void {
        if (!this.db) return;
        try {
            const runReindex = this.db.transaction(() => {
                // Delete old data (cascade via FK would work on file delete,
                // but here we keep the file row and replace children)
                this.stmts.deleteChunksByFile!.run(file.path);
                this.stmts.deleteSymbolsByFile!.run(file.path);

                // Upsert file record (atomic ON CONFLICT DO UPDATE)
                this.stmts.upsertFile!.run(
                    file.path,
                    file.hash,
                    file.size,
                    file.language ?? null,
                    file.last_indexed,
                    file.last_modified,
                );

                // Insert new chunks
                for (const chunk of chunks) {
                    this.stmts.insertChunk!.run(
                        chunk.chunk_id,
                        chunk.file_path,
                        chunk.start_line,
                        chunk.end_line,
                        chunk.content_hash,
                        chunk.embedding,
                    );
                }

                // Insert new symbols
                for (const symbol of symbols) {
                    this.stmts.insertSymbol!.run(
                        symbol.symbol_id,
                        symbol.file_path,
                        symbol.name,
                        symbol.kind,
                        symbol.start_line,
                        symbol.end_line,
                        symbol.parent_symbol_id,
                        symbol.signature,
                    );
                }
            });

            runReindex();
        } catch (err) {
            this.warn(`IndexStore reindexFile failed: ${(err as Error).message}`);
        }
    }

    /**
     * Get index statistics (file count, chunk count, symbol count).
     */
    getStats(): { fileCount: number; chunkCount: number; symbolCount: number } {
        if (!this.db) return { fileCount: 0, chunkCount: 0, symbolCount: 0 };
        try {
            const files = this.db.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number };
            const chunks = this.db.prepare('SELECT COUNT(*) AS count FROM chunks').get() as { count: number };
            const symbols = this.db.prepare('SELECT COUNT(*) AS count FROM symbols').get() as { count: number };
            return {
                fileCount: files.count,
                chunkCount: chunks.count,
                symbolCount: symbols.count,
            };
        } catch (err) {
            this.warn(`IndexStore getStats failed: ${(err as Error).message}`);
            return { fileCount: 0, chunkCount: 0, symbolCount: 0 };
        }
    }

    // --- Private ---

    private prepareStatements(): void {
        if (!this.db) return;

        this.stmts = {
            upsertFile: this.db.prepare(
                `INSERT INTO files (path, hash, size, language, last_indexed, last_modified) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, size = excluded.size, language = excluded.language, last_indexed = excluded.last_indexed, last_modified = excluded.last_modified`,
            ),
            getFile: this.db.prepare('SELECT * FROM files WHERE path = ?'),
            getFileHash: this.db.prepare('SELECT hash FROM files WHERE path = ?'),
            deleteFile: this.db.prepare('DELETE FROM files WHERE path = ?'),
            getAllFiles: this.db.prepare('SELECT * FROM files ORDER BY path'),
            insertChunk: this.db.prepare(
                'INSERT INTO chunks (chunk_id, file_path, start_line, end_line, content_hash, embedding) VALUES (?, ?, ?, ?, ?, ?)',
            ),
            getChunksByFile: this.db.prepare('SELECT * FROM chunks WHERE file_path = ? ORDER BY start_line'),
            getAllChunks: this.db.prepare('SELECT * FROM chunks ORDER BY file_path, start_line'),
            deleteChunksByFile: this.db.prepare('DELETE FROM chunks WHERE file_path = ?'),
            insertSymbol: this.db.prepare(
                'INSERT INTO symbols (symbol_id, file_path, name, kind, start_line, end_line, parent_symbol_id, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            ),
            getSymbolsByFile: this.db.prepare('SELECT * FROM symbols WHERE file_path = ? ORDER BY start_line'),
            deleteSymbolsByFile: this.db.prepare('DELETE FROM symbols WHERE file_path = ?'),
            getMetadata: this.db.prepare('SELECT * FROM metadata WHERE key = ?'),
            setMetadata: this.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)'),
            deleteMetadata: this.db.prepare('DELETE FROM metadata WHERE key = ?'),
        };
    }

    private clearStatements(): void {
        this.stmts = {
            upsertFile: null,
            getFile: null,
            getFileHash: null,
            deleteFile: null,
            getAllFiles: null,
            insertChunk: null,
            getChunksByFile: null,
            getAllChunks: null,
            deleteChunksByFile: null,
            insertSymbol: null,
            getSymbolsByFile: null,
            deleteSymbolsByFile: null,
            getMetadata: null,
            setMetadata: null,
            deleteMetadata: null,
        };
    }
}
