import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    buildContextRequestPrompt,
    buildFinalizationPrompt,
    fulfillContextRequests,
    containsPseudoToolCall,
    parseContextRequests,
    truncateUtf8,
} from '../../src/consult/context-request.js';

describe('consult context requests', () => {
    it('parses and caps context requests', () => {
        const requests = parseContextRequests(
            '{"needs_context":[{"path":"src/index.ts","line_start":5,"line_end":500,"reason":"verify"}]}',
            { maxSnippets: 1, maxLines: 25, maxBytes: 1000 },
        );

        expect(requests).toEqual([{
            path: 'src/index.ts',
            line_start: 5,
            line_end: 29,
            reason: 'verify',
        }]);
    });

    it('fulfills snippets inside the project only', () => {
        const dir = mkdtempSync(join(tmpdir(), 'aca-context-'));
        mkdirSync(join(dir, 'src'));
        writeFileSync(join(dir, 'src', 'file.ts'), 'one\néé\ntwo\n');

        const snippets = fulfillContextRequests([
            { path: 'src/file.ts', line_start: 2, line_end: 2, reason: 'needed' },
            { path: '../outside.ts', line_start: 1, line_end: 1, reason: 'escape' },
        ], dir, { maxSnippets: 2, maxLines: 10, maxBytes: 3 });

        expect(snippets[0].status).toBe('ok');
        expect(snippets[0].text).toBe('é');
        expect(snippets[0].bytes).toBe(2);
        expect(snippets[1].status).toBe('error');
        expect(snippets[1].error).toContain('outside project_dir');
    });

    it('truncates utf8 without exceeding the byte budget', () => {
        const text = truncateUtf8('éé', 3);
        expect(text).toBe('é');
        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(3);
    });

    it('detects pseudo-tool markup in no-tools consult responses', () => {
        expect(containsPseudoToolCall('<call type="tool" name="list_files">')).toBe(true);
        expect(containsPseudoToolCall('<function_calls><invoke name="read_file">')).toBe(true);
        expect(containsPseudoToolCall('<minimax:tool_call><invoke name="read_file">')).toBe(true);
        expect(containsPseudoToolCall('<parameter name="path">src/index.ts</parameter>')).toBe(true);
        expect(containsPseudoToolCall('## Q1\nNo tool markup here.')).toBe(false);
    });

    it('warns no-tools witnesses about native tool-call markup', () => {
        const contextPrompt = buildContextRequestPrompt('Review the code.');
        const finalPrompt = buildFinalizationPrompt('Review the code.', '{"needs_context":[]}', []);

        for (const prompt of [contextPrompt, finalPrompt]) {
            expect(prompt).toContain('Tools are disabled in this pass');
            expect(prompt).toContain('<invoke>');
            expect(prompt).toContain('<parameter>');
            expect(prompt).toContain('<minimax:tool_call>');
            expect(prompt).toContain('needs_context');
        }
    });
});
