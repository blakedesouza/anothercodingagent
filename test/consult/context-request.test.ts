import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    appendSharedContextPack,
    buildContextRequestRetryPrompt,
    buildContextRequestPrompt,
    buildFinalizationPrompt,
    buildFinalizationRetryPrompt,
    buildSharedContextRequestPrompt,
    containsContextRequestLikeJson,
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
        expect(containsPseudoToolCall('read_file\n<arg_key>path</arg_key>\n<arg_value>src/index.ts</arg_value>')).toBe(true);
        expect(containsPseudoToolCall('[TOOL_CALL]\n{"tool":"read_file"}\n[/TOOL_CALL]')).toBe(true);
        expect(containsPseudoToolCall('{"tool_calls":[{"name":"read_file","arguments":{}}]}')).toBe(true);
        expect(containsPseudoToolCall('## Q1\nNo tool markup here.')).toBe(false);
    });

    it('allows cited pseudo-tool markup inside Markdown code', () => {
        expect(containsPseudoToolCall('The invalid example is `<minimax:tool_call><invoke name="read_file">`.')).toBe(false);
        expect(containsPseudoToolCall('The invalid example is `{"tool_calls":[{"name":"read_file"}]}`.')).toBe(false);
        expect(containsPseudoToolCall([
            'The guard detects this fixture:',
            '```xml',
            '<minimax:tool_call><invoke name="read_file"></invoke></minimax:tool_call>',
            '```',
            'No actual tool call was attempted.',
        ].join('\n'))).toBe(false);
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

    it('builds generic no-tools finalization retry prompts', () => {
        const prompt = buildFinalizationRetryPrompt(
            'Review the code.',
            '{"needs_context":[]}',
            [],
            '<tool_call>{"name":"read_file"}</tool_call>',
        );

        expect(prompt).toContain('Invalid Previous Finalization');
        expect(prompt).toContain('Tools are disabled in this pass');
        expect(prompt).toContain('Produce the final findings now');
        expect(prompt).toContain('Do not request more context');
        expect(prompt).toContain('Do not emit XML, function-call, tool-call, invoke, or parameter markup');
        expect(prompt).toContain('Do not return needs_context JSON or file-result JSON');
        expect(prompt).toContain('<tool_call>{"name":"read_file"}</tool_call>');
    });

    it('builds generic no-tools context-request retry prompts', () => {
        const prompt = buildContextRequestRetryPrompt(
            'Review the code.',
            '[TOOL_CALL] read_file [/TOOL_CALL]',
            { maxSnippets: 2, maxLines: 50, maxBytes: 1000 },
        );

        expect(prompt).toContain('Invalid Previous Context Request');
        expect(prompt).toContain('return only the needs_context JSON object');
        expect(prompt).toContain('Do not emit XML, function-call, tool-call, invoke, parameter, arg_key, arg_value, [TOOL_CALL], or "tool_calls" markup');
    });

    it('parses alternate file-list context requests from routed models', () => {
        const requests = parseContextRequests(
            '{"status":"success","data":{"files":[{"path":"src/providers/nanogpt-driver.ts","lines":"140-220"}]}}',
            { maxSnippets: 1, maxLines: 40, maxBytes: 1000 },
        );

        expect(requests).toEqual([{
            path: 'src/providers/nanogpt-driver.ts',
            line_start: 140,
            line_end: 179,
            reason: 'model requested file range using alternate context-request JSON',
        }]);
    });

    it('detects context-request-shaped JSON outputs', () => {
        expect(containsContextRequestLikeJson('{"needs_context":[]}')).toBe(true);
        expect(containsContextRequestLikeJson('{"status":"success","data":{"files":[{"path":"src/index.ts","text":"code"}]}}')).toBe(true);
        expect(containsContextRequestLikeJson('{"status":"success","summary":"no files"}')).toBe(false);
        expect(containsContextRequestLikeJson('Plain Markdown findings')).toBe(false);
    });

    it('builds shared context scout prompts that request ranges rather than summaries', () => {
        const prompt = buildSharedContextRequestPrompt('Review the code.', {
            maxSnippets: 4,
            maxLines: 80,
            maxBytes: 2000,
        });

        expect(prompt).toContain('Shared Raw Evidence Scout Protocol');
        expect(prompt).toContain('Return only this JSON object');
        expect(prompt).toContain('Request at most 4 snippets');
        expect(prompt).toContain('at most 80 lines');
        expect(prompt).toContain('ACA will read accepted snippets directly from disk');
        expect(prompt).toContain('Do not summarize findings or quote code yourself');
        expect(prompt).toContain('<minimax:tool_call>');
    });

    it('appends shared context as raw ACA-read evidence', () => {
        const packed = appendSharedContextPack('Review the code.', 'zai-org/glm-5', [{
            path: 'src/core/turn-engine.ts',
            line_start: 47,
            line_end: 55,
            reason: 'fallback trigger codes',
            status: 'ok',
            error: null,
            bytes: 85,
            truncated: false,
            text: "const FALLBACK_TRIGGER_CODES = new Set(['llm.rate_limit']);",
        }]);

        expect(packed).toContain('## Shared Raw Evidence Pack');
        expect(packed).toContain('scout model (zai-org/glm-5) selected the ranges');
        expect(packed).toContain('ACA read the file contents deterministically from disk');
        expect(packed).toContain('src/core/turn-engine.ts:47-55');
        expect(packed).toContain("const FALLBACK_TRIGGER_CODES = new Set(['llm.rate_limit']);");
    });
});
