import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    extractCodeIdentifiers,
    resolveSymbolLocations,
} from '../../src/consult/symbol-lookup.js';

const PROJECT_DIR = join(fileURLToPath(import.meta.url), '../../../');

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

// ─── Test 2: symbol resolution against real codebase ─────────────────────────

describe('resolveSymbolLocations', () => {
    it('finds countHardRejectedToolCalls in invoke-output-validation.ts at line 77', async () => {
        const locs = await resolveSymbolLocations(
            ['countHardRejectedToolCalls'],
            PROJECT_DIR,
        );
        expect(locs).toHaveLength(1);
        expect(locs[0].identifier).toBe('countHardRejectedToolCalls');
        expect(locs[0].file).toContain('invoke-output-validation.ts');
        expect(locs[0].line).toBe(77);
        expect(locs[0].snippet).toContain('countHardRejectedToolCalls');
    });

    it('finds buildContextRequestPrompt in context-request.ts at line 144', async () => {
        const locs = await resolveSymbolLocations(
            ['buildContextRequestPrompt'],
            PROJECT_DIR,
        );
        expect(locs).toHaveLength(1);
        expect(locs[0].file).toContain('context-request.ts');
        expect(locs[0].line).toBe(144);
    });

    it('returns empty array for a nonexistent identifier', async () => {
        const locs = await resolveSymbolLocations(
            ['nonExistentFunctionXyzAbcDef'],
            PROJECT_DIR,
        );
        expect(locs).toHaveLength(0);
    });
});

// ─── Test 3: prompt injection ─────────────────────────────────────────────────
// Import buildContextRequestPrompt and verify the <symbol_locations> block appears
// when symbolLocations are passed.

import { buildContextRequestPrompt } from '../../src/consult/context-request.js';

describe('buildContextRequestPrompt with symbol locations', () => {
    const limits = { maxSnippets: 5, maxLines: 100, maxBytes: 50000, maxRounds: 3 };

    it('includes symbol_locations block when locations are provided', () => {
        const prompt = buildContextRequestPrompt(
            'What does countHardRejectedToolCalls do?',
            limits,
            3,
            3,
            [{
                identifier: 'countHardRejectedToolCalls',
                file: 'src/cli/invoke-output-validation.ts',
                line: 77,
                snippet: 'export function countHardRejectedToolCalls(items: readonly ConversationItem[]): number {',
            }],
        );
        expect(prompt).toContain('symbol_locations');
        expect(prompt).toContain('countHardRejectedToolCalls');
        expect(prompt).toContain('src/cli/invoke-output-validation.ts');
        expect(prompt).toContain('line 77');
    });

    it('omits symbol_locations block when no locations are provided', () => {
        const prompt = buildContextRequestPrompt(
            'What does countHardRejectedToolCalls do?',
            limits,
            3,
            3,
        );
        expect(prompt).not.toContain('symbol_locations');
    });
});
