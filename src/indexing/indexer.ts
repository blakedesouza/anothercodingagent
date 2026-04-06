/**
 * Project indexer (Block 20, M6.4).
 *
 * Walks the project tree, applies guardrails (gitignore, extension whitelist,
 * maxFileSize, maxFiles, binary/generated detection), chunks files, extracts
 * symbols, computes embeddings, and stores everything in IndexStore.
 *
 * Supports incremental updates via content-hash comparison and background
 * indexing for large projects (> 500 files).
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, lstatSync, existsSync, readFile } from 'node:fs';
import { join, relative, extname, resolve } from 'node:path';
import { promisify } from 'node:util';

import { chunkFile } from './chunker.js';
import { extractSymbols, detectLanguage } from './symbol-extractor.js';
import {
    IndexStore,
    embeddingToBuffer,
    type FileRecord,
    type ChunkRecord,
    type SymbolRecord,
} from './index-store.js';
import type { EmbeddingModel } from './embedding.js';

const readFileAsync = promisify(readFile);

// --- Constants ---

/** Default extension whitelist (Block 20). */
export const DEFAULT_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx',
    '.py', '.rs', '.go', '.java',
    '.c', '.cpp', '.h', '.hpp',
    '.cs', '.rb', '.php', '.swift',
    '.kt', '.scala',
    '.md',
    '.json', '.toml', '.yaml', '.yml',
]);

/** Directories always excluded from indexing. */
export const DEFAULT_EXCLUDES = new Set([
    'node_modules',
    'dist',
    'build',
    'vendor',
    '.venv',
    'coverage',
    '.git',
]);

/** Maximum file size in bytes (default 100KB). */
export const DEFAULT_MAX_FILE_SIZE = 102400;

/** Maximum files per project (default 5000). */
export const DEFAULT_MAX_FILES = 5000;

/** Files above this count trigger background indexing. */
export const BACKGROUND_THRESHOLD = 500;

/** Generated file markers. */
const GENERATED_MARKERS = ['// @generated', '# auto-generated'];

/** Package manifest filenames (only these .json files are indexed). */
const JSON_MANIFESTS = new Set([
    'package.json',
    'composer.json',
    'tsconfig.json',
    'jsconfig.json',
]);

/** Config file basenames (only these .yaml/.yml/.toml files are indexed). */
const CONFIG_BASENAMES = new Set([
    'docker-compose.yml',
    'docker-compose.yaml',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    '.prettierrc.yml',
    '.prettierrc.yaml',
    'pyproject.toml',
    'Cargo.toml',
]);

// --- Types ---

export interface IndexerConfig {
    maxFileSize: number;
    maxFiles: number;
    extensions: Set<string>;
    excludeDirs: Set<string>;
    gitignoreRules: GitignoreRule[];
}

export interface IndexerOptions {
    maxFileSize?: number;
    maxFiles?: number;
    extensions?: string[];
    extraExcludes?: string[];
}

export interface IndexResult {
    filesIndexed: number;
    filesSkipped: number;
    chunksCreated: number;
    symbolsExtracted: number;
    embeddingFailures: number;
    warnings: string[];
}

export type WarnFn = (message: string) => void;

// --- Gitignore parsing ---

export interface GitignoreRule {
    pattern: string;
    negation: boolean;
    dirOnly: boolean;
    regex: RegExp;
    basePath: string; // directory containing the .gitignore
}

/**
 * Parse a .gitignore file into rules.
 */
export function parseGitignore(content: string, basePath: string): GitignoreRule[] {
    const rules: GitignoreRule[] = [];

    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#')) continue;

        let pattern = line;
        let negation = false;

        if (pattern.startsWith('!')) {
            negation = true;
            pattern = pattern.slice(1);
        }

        // Remove trailing spaces (unless escaped)
        pattern = pattern.replace(/(?<!\\)\s+$/, '');
        if (pattern.length === 0) continue;

        const dirOnly = pattern.endsWith('/');
        if (dirOnly) {
            pattern = pattern.slice(0, -1);
        }

        const regex = gitignorePatternToRegex(pattern);

        rules.push({ pattern: line, negation, dirOnly, regex, basePath });
    }

    return rules;
}

/**
 * Convert a gitignore glob pattern to a RegExp.
 *
 * Gitignore rules:
 * - `*` matches anything except `/`
 * - `**` matches everything including `/`
 * - `?` matches a single character except `/`
 * - Leading `/` anchors to the base directory
 * - Pattern without `/` matches basename only
 * - Pattern with `/` (not leading) matches from base directory
 */
function gitignorePatternToRegex(pattern: string): RegExp {
    let anchored = false;

    // Leading slash anchors to base dir
    if (pattern.startsWith('/')) {
        anchored = true;
        pattern = pattern.slice(1);
    }

    // If pattern contains a slash (not leading), it's anchored
    if (pattern.includes('/')) {
        anchored = true;
    }

    // Escape regex special chars, then convert glob patterns
    let regexStr = '';
    let i = 0;
    while (i < pattern.length) {
        if (pattern[i] === '*' && pattern[i + 1] === '*') {
            if (pattern[i + 2] === '/') {
                regexStr += '(?:.+/)?';
                i += 3;
            } else {
                regexStr += '.*';
                i += 2;
            }
        } else if (pattern[i] === '*') {
            regexStr += '[^/]*';
            i++;
        } else if (pattern[i] === '?') {
            regexStr += '[^/]';
            i++;
        } else if ('.+^${}()|[]\\'.includes(pattern[i])) {
            regexStr += '\\' + pattern[i];
            i++;
        } else {
            regexStr += pattern[i];
            i++;
        }
    }

    if (anchored) {
        return new RegExp('^' + regexStr + '(?:/|$)');
    }
    // Unanchored: match basename or any path segment
    return new RegExp('(?:^|/)' + regexStr + '(?:/|$)');
}

/**
 * Check if a relative path is ignored by gitignore rules.
 * Returns true if the path should be ignored.
 */
export function isGitignored(
    relPath: string,
    isDir: boolean,
    rules: GitignoreRule[],
    rootDir: string,
): boolean {
    let ignored = false;

    for (const rule of rules) {
        // dirOnly rules only apply to directories
        if (rule.dirOnly && !isDir) continue;

        // Compute path relative to the .gitignore file's directory
        const ruleRelBase = relative(rootDir, rule.basePath);
        let testPath = relPath;
        if (ruleRelBase.length > 0) {
            if (!relPath.startsWith(ruleRelBase + '/') && relPath !== ruleRelBase) {
                continue; // Rule doesn't apply to this path
            }
            testPath = relPath.slice(ruleRelBase.length + 1);
        }

        if (rule.regex.test(testPath)) {
            ignored = !rule.negation;
        }
    }

    return ignored;
}

// --- File collection ---

/**
 * Collect all indexable files from the project root.
 * Respects gitignore, extension whitelist, size limits, and excluded directories.
 */
export function collectFiles(
    rootDir: string,
    config: IndexerConfig,
    warn: WarnFn = () => {},
): string[] {
    const files: string[] = [];
    const allGitignoreRules = [...config.gitignoreRules];

    // Load root .gitignore
    const rootGitignore = join(rootDir, '.gitignore');
    if (existsSync(rootGitignore)) {
        try {
            const content = readFileSync(rootGitignore, 'utf-8');
            allGitignoreRules.push(...parseGitignore(content, rootDir));
        } catch {
            // Ignore read errors
        }
    }

    function walk(dir: string, localRules: GitignoreRule[]): void {
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return; // Skip unreadable directories
        }

        // Check for .gitignore in this directory
        const dirGitignore = join(dir, '.gitignore');
        let currentRules = localRules;
        if (dir !== rootDir && existsSync(dirGitignore)) {
            try {
                const content = readFileSync(dirGitignore, 'utf-8');
                currentRules = [...localRules, ...parseGitignore(content, dir)];
            } catch {
                // Ignore read errors
            }
        }

        for (const entry of entries) {
            if (files.length >= config.maxFiles) {
                warn(`maxFiles limit reached (${config.maxFiles}), stopping file collection`);
                return;
            }

            const fullPath = join(dir, entry);
            const relPath = relative(rootDir, fullPath);

            let stats;
            try {
                stats = lstatSync(fullPath);
            } catch {
                continue; // Skip stat errors
            }

            // Skip symlinks to prevent infinite loops
            if (stats.isSymbolicLink()) continue;

            if (stats.isDirectory()) {
                // Hard-block excluded directories
                if (config.excludeDirs.has(entry)) continue;

                // Check gitignore
                if (isGitignored(relPath, true, currentRules, rootDir)) continue;

                walk(fullPath, currentRules);
            } else if (stats.isFile()) {
                // Check gitignore
                if (isGitignored(relPath, false, currentRules, rootDir)) continue;

                // Extension whitelist
                const ext = extname(entry);
                if (!config.extensions.has(ext)) continue;

                // Special handling for .json/.yaml/.yml/.toml
                if (ext === '.json' && !JSON_MANIFESTS.has(entry)) continue;
                if ((ext === '.yaml' || ext === '.yml' || ext === '.toml') &&
                    !CONFIG_BASENAMES.has(entry)) continue;

                // File size limit
                if (stats.size > config.maxFileSize) {
                    warn(`Skipping ${relPath}: file size ${stats.size} exceeds limit ${config.maxFileSize}`);
                    continue;
                }

                files.push(relPath);
            }
        }
    }

    walk(rootDir, allGitignoreRules);
    return files;
}

// --- Content checks ---

/** Check if file content contains null bytes (binary detection). */
export function isBinaryContent(content: Buffer): boolean {
    // Check first 8KB for null bytes
    const checkLen = Math.min(content.length, 8192);
    for (let i = 0; i < checkLen; i++) {
        if (content[i] === 0) return true;
    }
    return false;
}

/** Check if file content has a generated marker in the first few lines. */
export function isGeneratedContent(content: string): boolean {
    // Only check first 5 lines for efficiency
    const firstLines = content.split('\n', 5).join('\n');
    return GENERATED_MARKERS.some(marker => firstLines.includes(marker));
}

/** Compute SHA-256 hash of content. */
export function hashContent(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex');
}

// --- Indexer class ---

export class Indexer {
    private readonly rootDir: string;
    private readonly store: IndexStore;
    private readonly embedding: EmbeddingModel | null;
    private readonly config: IndexerConfig;
    private readonly warn: WarnFn;
    private _indexing = false;
    private _ready = false;
    private _buildPromise: Promise<IndexResult> | null = null;

    constructor(
        rootDir: string,
        store: IndexStore,
        embedding: EmbeddingModel | null,
        options?: IndexerOptions,
        warn?: WarnFn,
    ) {
        this.rootDir = resolve(rootDir);
        this.store = store;
        this.embedding = embedding;
        this.warn = warn ?? (() => {});
        this.config = {
            maxFileSize: options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
            maxFiles: options?.maxFiles ?? DEFAULT_MAX_FILES,
            extensions: options?.extensions
                ? new Set(options.extensions)
                : new Set(DEFAULT_EXTENSIONS),
            excludeDirs: new Set([
                ...DEFAULT_EXCLUDES,
                ...(options?.extraExcludes ?? []),
            ]),
            gitignoreRules: [],
        };
    }

    get indexing(): boolean { return this._indexing; }
    get ready(): boolean { return this._ready; }

    /**
     * Run a full index build. For large projects (> BACKGROUND_THRESHOLD files),
     * this should be called in the background.
     * If a build is already running, returns the existing promise.
     */
    async buildIndex(): Promise<IndexResult> {
        if (this._buildPromise) {
            return this._buildPromise;
        }
        // Guard: prevent concurrent builds if incrementalUpdate is running
        if (this._indexing) {
            return {
                filesIndexed: 0,
                filesSkipped: 0,
                chunksCreated: 0,
                symbolsExtracted: 0,
                embeddingFailures: 0,
                warnings: ['Indexing already in progress'],
            };
        }

        this._buildPromise = this.doBuildIndex();
        try {
            return await this._buildPromise;
        } finally {
            this._buildPromise = null;
        }
    }

    private async doBuildIndex(): Promise<IndexResult> {
        this._indexing = true;
        this._ready = false;
        const result: IndexResult = {
            filesIndexed: 0,
            filesSkipped: 0,
            chunksCreated: 0,
            symbolsExtracted: 0,
            embeddingFailures: 0,
            warnings: [],
        };

        try {
            if (!this.store.isOpen()) {
                if (!this.store.open()) {
                    result.warnings.push('Failed to open index store');
                    return result;
                }
            }

            const files = collectFiles(this.rootDir, this.config, (msg) => {
                result.warnings.push(msg);
                this.warn(msg);
            });

            if (files.length >= this.config.maxFiles) {
                result.warnings.push(
                    `File collection capped at ${this.config.maxFiles} files`,
                );
            }

            for (const relPath of files) {
                const fileResult = await this.indexFile(relPath);
                if (fileResult.status === 'indexed') {
                    result.filesIndexed++;
                } else {
                    result.filesSkipped++;
                }
                result.embeddingFailures += fileResult.embeddingFailures;
            }

            // Gather totals from store
            const stats = this.store.getStats();
            result.chunksCreated = stats.chunkCount;
            result.symbolsExtracted = stats.symbolCount;

            this.store.setMetadata('lastFullBuild', new Date().toISOString());
            this.store.setMetadata('fileCount', String(stats.fileCount));

            if (result.embeddingFailures > 0) {
                const msg = `${result.embeddingFailures} chunks failed embedding — semantic search may return incomplete results`;
                result.warnings.push(msg);
                this.warn(msg);
            }

            this._ready = true;
        } finally {
            this._indexing = false;
        }

        return result;
    }

    /**
     * Run a full index in the background (non-blocking).
     * Returns a promise that resolves when indexing completes.
     */
    async buildIndexBackground(): Promise<IndexResult> {
        // Callers can await this or fire-and-forget
        return this.buildIndex();
    }

    /**
     * Incremental update: re-index only changed files.
     * Compares content hashes against what's stored.
     */
    async incrementalUpdate(filePaths?: string[]): Promise<IndexResult> {
        if (this._indexing) {
            return {
                filesIndexed: 0,
                filesSkipped: 0,
                chunksCreated: 0,
                symbolsExtracted: 0,
                embeddingFailures: 0,
                warnings: ['Indexing already in progress'],
            };
        }

        this._indexing = true;
        const result: IndexResult = {
            filesIndexed: 0,
            filesSkipped: 0,
            chunksCreated: 0,
            symbolsExtracted: 0,
            embeddingFailures: 0,
            warnings: [],
        };

        try {
            const files = filePaths ?? collectFiles(this.rootDir, this.config, (msg) => {
                result.warnings.push(msg);
                this.warn(msg);
            });

            for (const relPath of files) {
                const fileResult = await this.indexFile(relPath);
                if (fileResult.status === 'indexed') {
                    result.filesIndexed++;
                } else {
                    result.filesSkipped++;
                }
                result.embeddingFailures += fileResult.embeddingFailures;
            }

            const stats = this.store.getStats();
            result.chunksCreated = stats.chunkCount;
            result.symbolsExtracted = stats.symbolCount;

            // Fix zombie state: set ready if store has data after successful update
            if (result.filesIndexed > 0 || stats.fileCount > 0) {
                this._ready = true;
            }
        } finally {
            this._indexing = false;
        }

        return result;
    }

    /**
     * Index a single file. Returns status and count of embedding failures.
     */
    async indexFile(relPath: string): Promise<{ status: 'indexed' | 'skipped' | 'error'; embeddingFailures: number }> {
        const fullPath = join(this.rootDir, relPath);

        // Read file
        let buf: Buffer;
        try {
            buf = await readFileAsync(fullPath);
        } catch (err) {
            this.warn(`Failed to read ${relPath}: ${(err as Error).message}`);
            return { status: 'error', embeddingFailures: 0 };
        }

        // Binary check
        if (isBinaryContent(buf)) {
            this.warn(`Skipping binary file: ${relPath}`);
            return { status: 'skipped', embeddingFailures: 0 };
        }

        const content = buf.toString('utf-8');

        // Generated file check
        if (isGeneratedContent(content)) {
            this.warn(`Skipping generated file: ${relPath}`);
            return { status: 'skipped', embeddingFailures: 0 };
        }

        // Hash check — skip if unchanged
        const hash = hashContent(buf);
        if (this.store.hasMatchingHash(relPath, hash)) {
            return { status: 'skipped', embeddingFailures: 0 };
        }

        // Detect language
        const ext = extname(relPath);
        const language = ext === '.md' ? 'markdown' : detectLanguage(ext);

        // Extract symbols
        const symbols = language ? extractSymbols(content, language) : [];

        // Chunk the file
        const chunks = chunkFile(content, language);

        // Compute embeddings
        const chunkRecords: ChunkRecord[] = [];
        let fileEmbeddingFailures = 0;
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const chunkHash = createHash('sha256').update(chunk.content).digest('hex');
            let embeddingBuf: Buffer | null = null;

            if (this.embedding?.available) {
                try {
                    const vec = await this.embedding.embed(chunk.content);
                    embeddingBuf = embeddingToBuffer(vec);
                } catch (err) {
                    fileEmbeddingFailures++;
                    this.warn(`Embedding failed for ${relPath} chunk ${i}: ${(err as Error).message}`);
                }
            }

            chunkRecords.push({
                chunk_id: `${relPath}:${chunk.startLine}-${chunk.endLine}`,
                file_path: relPath,
                start_line: chunk.startLine,
                end_line: chunk.endLine,
                content_hash: chunkHash,
                embedding: embeddingBuf,
            });
        }

        // Build symbol records
        const symbolRecords: SymbolRecord[] = symbols.map((sym, idx) => {
            let parentSymbolId: string | null = null;
            if (sym.parentName) {
                const parentIdx = symbols.findIndex(s =>
                    s.name === sym.parentName &&
                    s.startLine <= sym.startLine &&
                    s.endLine >= sym.endLine,
                );
                if (parentIdx >= 0) {
                    parentSymbolId = `${relPath}:sym:${parentIdx}`;
                }
            }
            return {
                symbol_id: `${relPath}:sym:${idx}`,
                file_path: relPath,
                name: sym.name,
                kind: sym.kind,
                start_line: sym.startLine,
                end_line: sym.endLine,
                parent_symbol_id: parentSymbolId,
                signature: sym.signature,
            };
        });

        // File record
        let lastModified: string;
        try {
            lastModified = statSync(fullPath).mtime.toISOString();
        } catch {
            lastModified = new Date().toISOString();
        }

        const fileRecord: FileRecord = {
            path: relPath,
            hash,
            size: buf.length,
            language: language ?? ext,
            last_indexed: new Date().toISOString(),
            last_modified: lastModified,
        };

        // Atomic reindex
        this.store.reindexFile(fileRecord, chunkRecords, symbolRecords);

        return { status: 'indexed', embeddingFailures: fileEmbeddingFailures };
    }
}

// --- Config builder ---

export function buildIndexerConfig(options?: IndexerOptions): IndexerConfig {
    return {
        maxFileSize: options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
        maxFiles: options?.maxFiles ?? DEFAULT_MAX_FILES,
        extensions: options?.extensions
            ? new Set(options.extensions)
            : new Set(DEFAULT_EXTENSIONS),
        excludeDirs: new Set([
            ...DEFAULT_EXCLUDES,
            ...(options?.extraExcludes ?? []),
        ]),
        gitignoreRules: [],
    };
}
