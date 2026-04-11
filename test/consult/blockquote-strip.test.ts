import { describe, it, expect } from 'vitest';
import {
    stripBlockquoteMarkers,
    parseContextRequests,
} from '../../src/consult/context-request.js';

const limits = { maxSnippets: 5, maxLines: 100, maxBytes: 50_000, maxRounds: 3 };

describe('stripBlockquoteMarkers', () => {
    it('strips > prefix from every line', () => {
        const input = '> line one\n> line two\n> line three';
        expect(stripBlockquoteMarkers(input)).toBe('line one\nline two\nline three');
    });

    it('handles qwen-style indented blockquote content', () => {
        // Qwen emits ">     {" — strip the "> " leaving "    {"
        const input = '>     {\n>       "key": "value"\n>     }';
        const stripped = stripBlockquoteMarkers(input);
        expect(stripped).toBe('    {\n      "key": "value"\n    }');
        // And the resulting JSON is parseable
        expect(() => JSON.parse(stripped.trim())).not.toThrow();
    });

    it('leaves non-blockquoted lines unchanged', () => {
        const input = 'normal line\n> blockquoted\nnormal again';
        expect(stripBlockquoteMarkers(input)).toBe('normal line\nblockquoted\nnormal again');
    });
});

describe('parseContextRequests with qwen-style blockquoted response', () => {
    it('extracts needs_context JSON buried in blockquoted deliberation', () => {
        // Mirrors the actual qwen response pattern observed in live testing 2026-04-10
        const qwenResponse = [
            '> 1. Analyze the request.',
            '> 2. I cannot see the function body. Need to read the file.',
            '>     {',
            '>       "needs_context": [',
            '>         {',
            '>           "type": "file",',
            '>           "path": "src/observability/telemetry.ts",',
            '>           "line_start": 256,',
            '>           "line_end": 290,',
            '>           "reason": "Inspect formatOtlpPayload implementation and return type"',
            '>         }',
            '>       ]',
            '>     }',
        ].join('\n');

        const stripped = stripBlockquoteMarkers(qwenResponse);
        const requests = parseContextRequests(stripped, limits);
        expect(requests).toHaveLength(1);
        expect(requests[0].path).toBe('src/observability/telemetry.ts');
        expect(requests[0].line_start).toBe(256);
        expect(requests[0].reason).toContain('formatOtlpPayload');
    });
});
