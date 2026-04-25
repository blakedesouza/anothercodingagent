/**
 * search_semantic tool (Block 20, M6.5).
 *
 * Embeds a natural-language query, computes cosine similarity against all
 * indexed chunks, and returns ranked results with file path, line range,
 * similarity score, snippet, and symbols.
 *
 * Approval class: read-only (no side effects, auto-approved).
 */

import { readFile } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { cosineSimilarity } from '../indexing/embedding.js';
import type { EmbeddingModel } from '../indexing/embedding.js';
import { bufferToEmbedding } from '../indexing/index-store.js';
import type { IndexStore, ChunkRecord, SymbolRecord } from '../indexing/index-store.js';
import type { Indexer } from '../indexing/indexer.js';
import { isPathWithin } from '../core/path-comparison.js';

// --- Constants ---

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const DEFAULT_MIN_SCORE = 0.3;
const SNIPPET_MAX_LINES = 5;

// --- Tool spec ---

export const searchSemanticSpec: ToolSpec = {
    name: 'search_semantic',
    description:
        'Find code chunks semantically similar to a natural-language query. ' +
        'Uses embedding-based cosine similarity against the project index.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', minLength: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            file_filter: { type: 'string', minLength: 1 },
            min_score: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['query'],
        additionalProperties: false,
    },
    approvalClass: 'read-only',
    idempotent: true,
    timeoutCategory: 'compute',
};

// --- Result type ---

export interface SemanticSearchResult {
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    symbols: string[];
}

// --- Helpers ---

function errorOutput(code: string, message: string, retryable = false): ToolOutput {
    return {
        status: 'error',
        data: '',
        error: { code, message, retryable },
        truncated: false,
        bytesReturned: 0,
        bytesOmitted: 0,
        retryable,
        timedOut: false,
        mutationState: 'none',
    };
}

/**
 * Convert a glob pattern to a RegExp for file path matching.
 * Supports *, **, and ? wildcards.
 */
function globToRegex(pattern: string): RegExp {
    let result = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*' && pattern[i + 1] === '*') {
            result += '.*';
            i += 2;
            if (pattern[i] === '/') i++;
        } else if (ch === '*') {
            result += '[^/]*';
            i++;
        } else if (ch === '?') {
            result += '[^/]';
            i++;
        } else if ('.+^${}()|[]\\'.includes(ch)) {
            result += '\\' + ch;
            i++;
        } else {
            result += ch;
            i++;
        }
    }
    return new RegExp(`^${result}$`);
}

/**
 * Test whether a relative path matches a glob pattern.
 * Patterns without a path separator are matched against the basename.
 */
function matchesGlob(relPath: string, pattern: string): boolean {
    const regex = globToRegex(pattern);
    if (!pattern.includes('/')) {
        return regex.test(basename(relPath));
    }
    return regex.test(relPath);
}

/**
 * Read snippet lines from a file. Returns first N lines of the chunk range.
 * Falls back to a line-range placeholder on any error or path traversal.
 */
async function readSnippet(
    workspaceRoot: string,
    relPath: string,
    startLine: number,
    endLine: number,
): Promise<string> {
    try {
        const fullPath = join(workspaceRoot, relPath);
        const resolvedPath = resolve(fullPath);

        // Defense-in-depth: ensure path stays within workspace
        if (!isPathWithin(workspaceRoot, resolvedPath)) {
            return `[Lines ${startLine}-${endLine}]`;
        }

        const content = await readFile(fullPath, 'utf-8');
        const lines = content.split('\n');
        // startLine is 1-indexed inclusive; endLine is 1-indexed inclusive.
        // slice() uses 0-indexed exclusive end, so endLine works directly.
        const sliceStart = startLine - 1;
        const sliceEnd = Math.min(sliceStart + SNIPPET_MAX_LINES, endLine);
        return lines.slice(sliceStart, sliceEnd).join('\n');
    } catch {
        return `[Lines ${startLine}-${endLine}]`;
    }
}

// --- Dependencies interface ---

/**
 * Dependencies injected into the search_semantic implementation.
 * Bound at tool registration time so the tool can access the index
 * without global state.
 */
export interface SearchSemanticDeps {
    indexer: Indexer;
    store: IndexStore;
    embedding: EmbeddingModel;
}

// --- Factory ---

/**
 * Create the search_semantic tool implementation with injected dependencies.
 */
export function createSearchSemanticImpl(deps: SearchSemanticDeps): ToolImplementation {
    return async (
        args: Record<string, unknown>,
        context: ToolContext,
    ): Promise<ToolOutput> => {
        const query = args.query as string;
        const limit = Math.min(
            (args.limit as number | undefined) ?? DEFAULT_LIMIT,
            MAX_LIMIT,
        );
        const fileFilter = args.file_filter as string | undefined;
        const minScore = (args.min_score as number | undefined) ?? DEFAULT_MIN_SCORE;

        // Check if indexer is ready
        if (deps.indexer.indexing) {
            return errorOutput(
                'indexing_in_progress',
                'The project index is still being built. Please retry shortly.',
                true,
            );
        }

        if (!deps.indexer.ready) {
            return errorOutput(
                'index_unavailable',
                'The project index is not available. It may not have been built yet.',
                true,
            );
        }

        // Verify embedding model is available
        if (!deps.embedding.available) {
            return errorOutput(
                'embeddings_unavailable',
                'Embedding model is not available. Semantic search requires embeddings.',
                false,
            );
        }

        // Embed the query
        let queryVec: Float32Array;
        try {
            queryVec = await deps.embedding.embed(query);
        } catch (err) {
            return errorOutput(
                'embedding_failed',
                `Failed to embed query: ${(err as Error).message}`,
                false,
            );
        }

        // Load all chunks from the store
        const allChunks = deps.store.getAllChunks();

        if (allChunks.length === 0) {
            const data = JSON.stringify({ results: [], totalChunks: 0 });
            return {
                status: 'success',
                data,
                truncated: false,
                bytesReturned: Buffer.byteLength(data, 'utf8'),
                bytesOmitted: 0,
                retryable: false,
                timedOut: false,
                mutationState: 'none',
            };
        }

        // Filter by file_filter glob if provided
        let filteredChunks: ChunkRecord[];
        if (fileFilter) {
            filteredChunks = allChunks.filter(c => matchesGlob(c.file_path, fileFilter));
        } else {
            filteredChunks = allChunks;
        }

        // Compute cosine similarity for each chunk with an embedding
        const scored: Array<{ chunk: ChunkRecord; score: number }> = [];
        for (let i = 0; i < filteredChunks.length; i++) {
            // Check for cancellation every 500 chunks
            if (i % 500 === 0 && i > 0 && context.signal.aborted) {
                return errorOutput(
                    'operation_cancelled',
                    'Semantic search was cancelled.',
                    false,
                );
            }

            const chunk = filteredChunks[i];
            if (!chunk.embedding) continue;

            const chunkVec = bufferToEmbedding(chunk.embedding as Buffer);
            if (!chunkVec) continue; // Skip corrupt/invalid embeddings
            const score = cosineSimilarity(queryVec, chunkVec);

            if (score >= minScore) {
                scored.push({ chunk, score });
            }
        }

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);

        // Take top N
        const topN = scored.slice(0, limit);

        // Build results with symbols and snippets
        const results: SemanticSearchResult[] = [];
        const symbolCache = new Map<string, SymbolRecord[]>();

        for (const { chunk, score } of topN) {
            // Get symbols for this file (cached)
            let fileSymbols = symbolCache.get(chunk.file_path);
            if (fileSymbols === undefined) {
                fileSymbols = deps.store.getSymbolsByFile(chunk.file_path);
                symbolCache.set(chunk.file_path, fileSymbols);
            }

            // Find symbols whose start_line falls within this chunk
            const chunkSymbols = fileSymbols
                .filter(s =>
                    s.start_line >= chunk.start_line && s.start_line <= chunk.end_line,
                )
                .map(s => s.name);

            // Read snippet (first 5 lines of the chunk range)
            const snippet = await readSnippet(
                context.workspaceRoot,
                chunk.file_path,
                chunk.start_line,
                chunk.end_line,
            );

            results.push({
                path: chunk.file_path,
                startLine: chunk.start_line,
                endLine: chunk.end_line,
                score: Math.round(score * 10000) / 10000,
                snippet,
                symbols: chunkSymbols,
            });
        }

        const data = JSON.stringify({ results, totalChunks: filteredChunks.length });
        return {
            status: 'success',
            data,
            truncated: scored.length > limit,
            bytesReturned: Buffer.byteLength(data, 'utf8'),
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        };
    };
}
