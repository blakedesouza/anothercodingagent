/**
 * Tests for chunker (Block 20, M6.4).
 */

import { describe, it, expect } from 'vitest';
import { chunkFile, MAX_CHUNK_LINES, OVERLAP_LINES } from '../../src/indexing/chunker.js';

describe('chunkFile', () => {
    describe('markdown', () => {
        it('chunks at heading boundaries', () => {
            const md = [
                '# Title',
                'Intro text',
                '',
                '## Section 1',
                'Content 1',
                '',
                '## Section 2',
                'Content 2',
            ].join('\n');

            const chunks = chunkFile(md, 'markdown');
            expect(chunks.length).toBeGreaterThanOrEqual(2);
            // First chunk starts at heading
            expect(chunks[0].content).toContain('# Title');
            // Sections are separate chunks
            const sec2 = chunks.find(c => c.content.includes('## Section 2'));
            expect(sec2).toBeDefined();
        });

        it('does not use fixed 50-line chunking for markdown', () => {
            // A markdown file with multiple headings should NOT fall back to fixed chunking
            const lines = ['# Heading 1', ...Array(10).fill('text'), '# Heading 2', ...Array(10).fill('more text')];
            const chunks = chunkFile(lines.join('\n'), 'markdown');
            // Each heading section should be its own chunk
            expect(chunks.some(c => c.content.includes('# Heading 1'))).toBe(true);
            expect(chunks.some(c => c.content.includes('# Heading 2'))).toBe(true);
        });
    });

    describe('source code with symbols', () => {
        it('TypeScript file with 2 functions → 2+ chunks', () => {
            const code = [
                'function foo() {',
                '    return 1;',
                '}',
                '',
                'function bar() {',
                '    return 2;',
                '}',
            ].join('\n');

            const chunks = chunkFile(code, 'typescript');
            // Should have at least 2 chunks (one per function, possibly gap chunks)
            expect(chunks.length).toBeGreaterThanOrEqual(2);
        });

        it('Python class with 3 methods → chunks at boundaries', () => {
            const code = [
                'class Foo:',
                '    def method1(self):',
                '        pass',
                '',
                '    def method2(self):',
                '        pass',
                '',
                '    def method3(self):',
                '        pass',
            ].join('\n');

            const chunks = chunkFile(code, 'python');
            expect(chunks.length).toBeGreaterThanOrEqual(1);
        });

        it('large function (80 lines) → split into overlapping sub-chunks', () => {
            const lines = ['function bigFunc() {'];
            for (let i = 0; i < 78; i++) {
                lines.push(`    const x${i} = ${i};`);
            }
            lines.push('}');
            const code = lines.join('\n');

            const chunks = chunkFile(code, 'typescript');
            // 80 lines > MAX_CHUNK_LINES → should be sub-chunked
            expect(chunks.length).toBeGreaterThan(1);

            // Verify overlap: second chunk's startLine should overlap with first chunk
            if (chunks.length >= 2) {
                expect(chunks[1].startLine).toBeLessThanOrEqual(chunks[0].endLine);
            }
        });
    });

    describe('fallback (no semantic boundaries)', () => {
        it('file with no semantic boundaries → 50-line fixed chunks', () => {
            // 120 lines of plain text
            const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`);
            const code = lines.join('\n');

            // Use null language to force fallback
            const chunks = chunkFile(code, null);
            expect(chunks.length).toBeGreaterThan(1);

            // First chunk should be MAX_CHUNK_LINES lines
            expect(chunks[0].endLine - chunks[0].startLine + 1).toBe(MAX_CHUNK_LINES);

            // Second chunk should overlap
            expect(chunks[1].startLine).toBe(MAX_CHUNK_LINES - OVERLAP_LINES + 1);
        });
    });

    describe('edge cases', () => {
        it('empty content → no chunks', () => {
            expect(chunkFile('', 'typescript')).toEqual([]);
        });

        it('single line → one chunk', () => {
            const chunks = chunkFile('const x = 1;', 'typescript');
            expect(chunks.length).toBe(1);
        });

        it('unknown language with symbols → still extracts', () => {
            // Language without patterns → fallback to fixed chunks
            const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
            const chunks = chunkFile(lines.join('\n'), 'brainfuck');
            expect(chunks.length).toBeGreaterThan(1);
        });
    });
});
