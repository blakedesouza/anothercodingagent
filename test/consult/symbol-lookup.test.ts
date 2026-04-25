import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    _parseSearchResultLine,
    extractCodeIdentifiers,
    resolveSymbolLocations,
} from '../../src/consult/symbol-lookup.js';

const PROJECT_DIR = join(fileURLToPath(import.meta.url), '../../../');

function escapeRegexLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findExportLine(relativeFile: string, identifier: string): number {
    const source = readFileSync(join(PROJECT_DIR, relativeFile), 'utf8');
    const exportPattern = new RegExp(
        `export\\s+(?:async\\s+)?function\\s+${escapeRegexLiteral(identifier)}\\b`
        + `|export\\s+(?:const|class|interface|type)\\s+${escapeRegexLiteral(identifier)}\\b`,
    );
    const lineIndex = source.split('\n').findIndex(line => exportPattern.test(line));
    expect(lineIndex).toBeGreaterThanOrEqual(0);
    return lineIndex + 1;
}

// ─── Test 1: identifier extraction ───────────────────────────────────────────

describe('extractCodeIdentifiers', () => {
    it('extracts a camelCase function name from a question', () => {
        const ids = extractCodeIdentifiers(
            'What does countHardRejectedToolCalls do and what file is it in?',
        );
        expect(ids).toContain('countHardRejectedToolCalls');
    });

    it('extracts a PascalCase type name from a question', () => {
        const ids = extractCodeIdentifiers(
            'Where is PrepareInvokeTurnConfigOptions defined?',
        );
        expect(ids).toContain('PrepareInvokeTurnConfigOptions');
    });

    it('does not extract short common words', () => {
        const ids = extractCodeIdentifiers(
            'What does the invoke pipeline do and how does it handle errors?',
        );
        // none of these are code identifiers — too short or plain English
        expect(ids).not.toContain('What');
        expect(ids).not.toContain('does');
        expect(ids).not.toContain('invoke');
        expect(ids).not.toContain('handle');
        expect(ids).not.toContain('errors');
    });

    it('caps output at 5 identifiers', () => {
        const ids = extractCodeIdentifiers(
            'findFooBar findBazQux findAlphaBeta findGammaTheta findDeltaSigma findEpsilonZeta',
        );
        expect(ids.length).toBeLessThanOrEqual(5);
    });
});

// ─── Test 2: result-line parsing ──────────────────────────────────────────────

describe('_parseSearchResultLine', () => {
    it('parses POSIX rg output', () => {
        expect(
            _parseSearchResultLine(
                '/repo/src/consult/context-request.ts:179:export function buildContextRequestPrompt(',
                '/repo',
            ),
        ).toEqual({
            file: 'src/consult/context-request.ts',
            line: 179,
            snippet: 'export function buildContextRequestPrompt(',
        });
    });

    it('parses Windows drive-letter rg output into portable relative paths', () => {
        expect(
            _parseSearchResultLine(
                'C:\\repo\\src\\cli\\invoke-output-validation.ts:131:export function countHardRejectedToolCalls(items: readonly ConversationItem[]): number {',
                'C:\\repo',
            ),
        ).toEqual({
            file: 'src/cli/invoke-output-validation.ts',
            line: 131,
            snippet: 'export function countHardRejectedToolCalls(items: readonly ConversationItem[]): number {',
        });
    });

    it('keeps colon-number-colon text inside the source snippet', () => {
        expect(
            _parseSearchResultLine(
                'C:\\repo\\src\\example.ts:12:export const url = "http://localhost:3000/path";',
                'C:\\repo',
            ),
        ).toEqual({
            file: 'src/example.ts',
            line: 12,
            snippet: 'export const url = "http://localhost:3000/path";',
        });
    });
});

// ─── Test 3: symbol resolution against real codebase ─────────────────────────

describe('resolveSymbolLocations', () => {
    it('finds countHardRejectedToolCalls in invoke-output-validation.ts', async () => {
        const expectedLine = findExportLine(
            'src/cli/invoke-output-validation.ts',
            'countHardRejectedToolCalls',
        );
        const locs = await resolveSymbolLocations(
            ['countHardRejectedToolCalls'],
            PROJECT_DIR,
        );
        expect(locs).toHaveLength(1);
        expect(locs[0].identifier).toBe('countHardRejectedToolCalls');
        expect(locs[0].file).toContain('invoke-output-validation.ts');
        expect(locs[0].line).toBe(expectedLine);
        expect(locs[0].snippet).toContain('countHardRejectedToolCalls');
    });

    it('finds buildContextRequestPrompt in context-request.ts', async () => {
        const expectedLine = findExportLine(
            'src/consult/context-request.ts',
            'buildContextRequestPrompt',
        );
        const locs = await resolveSymbolLocations(
            ['buildContextRequestPrompt'],
            PROJECT_DIR,
        );
        expect(locs).toHaveLength(1);
        expect(locs[0].file).toContain('context-request.ts');
        expect(locs[0].line).toBe(expectedLine);
    });

    it('returns empty array for a nonexistent identifier', async () => {
        const locs = await resolveSymbolLocations(
            ['nonExistentFunctionXyzAbcDef'],
            PROJECT_DIR,
        );
        expect(locs).toHaveLength(0);
    });
});

// ─── Test 4: prompt injection ─────────────────────────────────────────────────
// Import buildContextRequestPrompt and verify the <symbol_locations> block appears
// when symbolLocations are passed.

import { buildContextRequestPrompt } from '../../src/consult/context-request.js';

describe('buildContextRequestPrompt with symbol locations', () => {
    const limits = { maxSnippets: 5, maxLines: 100, maxBytes: 50000, maxRounds: 3 };

    it('includes symbol_locations block when locations are provided', () => {
        const line = findExportLine(
            'src/cli/invoke-output-validation.ts',
            'countHardRejectedToolCalls',
        );
        const prompt = buildContextRequestPrompt(
            'What does countHardRejectedToolCalls do?',
            limits,
            3,
            3,
            [{
                identifier: 'countHardRejectedToolCalls',
                file: 'src/cli/invoke-output-validation.ts',
                line,
                snippet: 'export function countHardRejectedToolCalls(items: readonly ConversationItem[]): number {',
            }],
        );
        expect(prompt).toContain('symbol_locations');
        expect(prompt).toContain('countHardRejectedToolCalls');
        expect(prompt).toContain('src/cli/invoke-output-validation.ts');
        expect(prompt).toContain(`line ${line}`);
    });

    it('omits symbol_locations block when no locations are provided', () => {
        const prompt = buildContextRequestPrompt(
            'What does countHardRejectedToolCalls do?',
            limits,
            3,
            3,
        );
        expect(prompt).not.toContain('The following code identifiers were found in the question.');
    });
});
