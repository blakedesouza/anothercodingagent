/**
 * File chunking for the indexer (Block 20, M6.4).
 *
 * Splits source files into chunks at semantic boundaries (function/class),
 * with sub-chunking for large blocks (50-line max, 10-line overlap).
 * Markdown files chunk at heading boundaries. Files without detected
 * boundaries fall back to fixed-size 50-line chunks with 10-line overlap.
 */

import { extractSymbols, type ExtractedSymbol } from './symbol-extractor.js';

// --- Constants ---

/** Default max lines per chunk (derived from embedding model token limit). */
export const MAX_CHUNK_LINES = 50;

/** Overlap lines between sub-chunks of a large block. */
export const OVERLAP_LINES = 10;

// --- Types ---

export interface Chunk {
    startLine: number; // 1-based, inclusive
    endLine: number;   // 1-based, inclusive
    content: string;
}

// --- Public API ---

/**
 * Chunk a file's content into pieces suitable for embedding.
 *
 * Strategy:
 * 1. Markdown files: split at heading boundaries
 * 2. Source files with detected symbols: split at symbol boundaries
 * 3. Fallback: fixed 50-line chunks with 10-line overlap
 *
 * Large blocks (> MAX_CHUNK_LINES) are sub-chunked with overlap.
 */
export function chunkFile(
    content: string,
    language: string | null,
    maxLines: number = MAX_CHUNK_LINES,
    overlap: number = OVERLAP_LINES,
): Chunk[] {
    if (content.length === 0) return [];

    const lines = content.split('\n');
    if (lines.length === 0) return [];

    // Markdown: chunk at headings
    if (language === 'markdown') {
        return chunkMarkdown(lines, maxLines, overlap);
    }

    // Source files: try symbol-based chunking
    if (language) {
        const symbols = extractSymbols(content, language);
        if (symbols.length > 0) {
            return chunkBySymbols(lines, symbols, maxLines, overlap);
        }
    }

    // Fallback: fixed-size chunks
    return chunkFixed(lines, maxLines, overlap);
}

// --- Markdown chunking ---

/**
 * Split markdown at heading boundaries (# through ######).
 * Each heading starts a new chunk. Content before the first heading
 * becomes its own chunk. Large sections get sub-chunked.
 */
function chunkMarkdown(
    lines: string[],
    maxLines: number,
    overlap: number,
): Chunk[] {
    const HEADING_RE = /^#{1,6}\s/;
    const boundaries: number[] = []; // 0-based line indices of headings

    for (let i = 0; i < lines.length; i++) {
        if (HEADING_RE.test(lines[i])) {
            boundaries.push(i);
        }
    }

    // No headings — fallback to fixed chunks
    if (boundaries.length === 0) {
        return chunkFixed(lines, maxLines, overlap);
    }

    const chunks: Chunk[] = [];

    // Content before first heading (if any)
    if (boundaries[0] > 0) {
        addChunksForRange(lines, 0, boundaries[0] - 1, maxLines, overlap, chunks);
    }

    // Each heading section
    for (let i = 0; i < boundaries.length; i++) {
        const start = boundaries[i];
        const end = i + 1 < boundaries.length ? boundaries[i + 1] - 1 : lines.length - 1;
        addChunksForRange(lines, start, end, maxLines, overlap, chunks);
    }

    return chunks;
}

// --- Symbol-based chunking ---

/**
 * Split source code at symbol boundaries (functions, classes, etc.).
 * Gaps between symbols become their own chunks. Large symbols are sub-chunked.
 */
function chunkBySymbols(
    lines: string[],
    symbols: ExtractedSymbol[],
    maxLines: number,
    overlap: number,
): Chunk[] {
    // Sort symbols by start line
    const sorted = [...symbols].sort((a, b) => a.startLine - b.startLine);

    // Merge overlapping symbol ranges to avoid duplicate content
    const ranges = mergeRanges(sorted.map(s => ({
        start: s.startLine - 1, // convert to 0-based
        end: s.endLine - 1,
    })));

    const chunks: Chunk[] = [];
    let cursor = 0; // 0-based

    for (const range of ranges) {
        // Gap before this symbol
        if (range.start > cursor) {
            addChunksForRange(lines, cursor, range.start - 1, maxLines, overlap, chunks);
        }

        // The symbol itself
        addChunksForRange(lines, range.start, range.end, maxLines, overlap, chunks);
        cursor = range.end + 1;
    }

    // Trailing content after last symbol
    if (cursor < lines.length) {
        addChunksForRange(lines, cursor, lines.length - 1, maxLines, overlap, chunks);
    }

    return chunks;
}

// --- Fixed-size chunking ---

/**
 * Split into fixed-size chunks with overlap.
 */
function chunkFixed(
    lines: string[],
    maxLines: number,
    overlap: number,
): Chunk[] {
    const chunks: Chunk[] = [];
    let start = 0;

    while (start < lines.length) {
        const end = Math.min(start + maxLines - 1, lines.length - 1);
        chunks.push({
            startLine: start + 1, // 1-based
            endLine: end + 1,
            content: lines.slice(start, end + 1).join('\n'),
        });
        const next = start + maxLines - overlap;
        if (next <= start) break; // prevent infinite loop
        start = next;
        if (start >= lines.length) break;
    }

    return chunks;
}

// --- Helpers ---

interface Range {
    start: number; // 0-based
    end: number;   // 0-based
}

/**
 * Merge overlapping or adjacent ranges.
 */
function mergeRanges(ranges: Range[]): Range[] {
    if (ranges.length === 0) return [];
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const merged: Range[] = [{ ...sorted[0] }];

    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1];
        if (sorted[i].start <= last.end + 1) {
            last.end = Math.max(last.end, sorted[i].end);
        } else {
            merged.push({ ...sorted[i] });
        }
    }

    return merged;
}

/**
 * Add chunks for a range of lines, sub-chunking if the range exceeds maxLines.
 */
function addChunksForRange(
    lines: string[],
    start: number,    // 0-based inclusive
    end: number,      // 0-based inclusive
    maxLines: number,
    overlap: number,
    out: Chunk[],
): void {
    // Skip empty ranges (all-blank lines)
    const rangeLines = lines.slice(start, end + 1);
    if (rangeLines.every(l => l.trim().length === 0)) return;

    const rangeSize = end - start + 1;

    if (rangeSize <= maxLines) {
        out.push({
            startLine: start + 1,
            endLine: end + 1,
            content: rangeLines.join('\n'),
        });
        return;
    }

    // Sub-chunk with overlap
    let cursor = start;
    while (cursor <= end) {
        const chunkEnd = Math.min(cursor + maxLines - 1, end);
        out.push({
            startLine: cursor + 1,
            endLine: chunkEnd + 1,
            content: lines.slice(cursor, chunkEnd + 1).join('\n'),
        });
        const next = cursor + maxLines - overlap;
        if (next <= cursor) break;
        cursor = next;
        if (cursor > end) break;
    }
}
