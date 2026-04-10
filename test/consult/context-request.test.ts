import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    appendSharedContextPack,
    buildContextRequestRetryPrompt,
    buildContextRequestPrompt,
    buildContinuationPrompt,
    buildFinalizationPrompt,
    buildFinalizationRetryPrompt,
    buildSharedContextRequestPrompt,
    fulfillContextRequests,
    renderContextSnippets,
    containsProtocolEnvelopeJson,
    containsPseudoToolCall,
    parseContextRequests,
    truncateUtf8,
    type ContextSnippet,
} from '../../src/consult/context-request.js';

describe('consult context requests', () => {
    it('parses and caps context requests', () => {
        const requests = parseContextRequests(
            '{"needs_context":[{"path":"src/index.ts","line_start":5,"line_end":500,"reason":"verify"}]}',
            { maxSnippets: 1, maxLines: 25, maxBytes: 1000, maxRounds: 1 },
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
        ], dir, { maxSnippets: 2, maxLines: 10, maxBytes: 3, maxRounds: 1 });

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
        expect(containsPseudoToolCall('<read_file><path>src/index.ts</path></read_file>')).toBe(true);
        expect(containsPseudoToolCall('read_file\n<arg_key>path</arg_key>\n<arg_value>src/index.ts</arg_value>')).toBe(true);
        expect(containsPseudoToolCall('```javascript\nread_file({ "path": "src/index.ts" })\n```')).toBe(true);
        expect(containsPseudoToolCall('[{"name":"read_file","arguments":{"absolute_path":"/tmp/x"}}]')).toBe(true);
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

        expect(contextPrompt).toContain('Tools are disabled in this pass');
        expect(contextPrompt).toContain('<invoke>');
        expect(contextPrompt).toContain('<parameter>');
        expect(contextPrompt).toContain('<minimax:tool_call>');
        expect(contextPrompt).toContain('needs_context');
        expect(contextPrompt).toContain('Assume you know nothing beyond the prompt text and any ACA-appended evidence');
        expect(contextPrompt).toContain('Missing snippets, ENOENT paths, or omitted files are not evidence');

        expect(finalPrompt).toContain('Tools are disabled in this pass');
        expect(finalPrompt).toContain('<invoke>');
        expect(finalPrompt).toContain('<parameter>');
        expect(finalPrompt).toContain('<minimax:tool_call>');
        expect(finalPrompt).toContain('Do not rely on remembered, hidden, or inferred repo contents');
        expect(finalPrompt).toContain('If a fulfilled snippet shows ERROR, ENOENT, or empty content');
        expect(finalPrompt).toContain('Do not claim a file, feature, or configuration is missing unless a provided snippet explicitly establishes that fact');
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
        expect(prompt).toContain('custom JSON object or unsupported schema');
        expect(prompt).toContain('Do not request more context');
        expect(prompt).toContain('Do not emit XML, function-call, tool-call, invoke, or parameter markup');
        expect(prompt).toContain('Do not return needs_context JSON or file-result JSON');
        expect(prompt).toContain('<tool_call>{"name":"read_file"}</tool_call>');
    });

    it('builds generic no-tools context-request retry prompts', () => {
        const prompt = buildContextRequestRetryPrompt(
            'Review the code.',
            '[TOOL_CALL] read_file [/TOOL_CALL]',
            { maxSnippets: 2, maxLines: 50, maxBytes: 1000, maxRounds: 1 },
        );

        expect(prompt).toContain('Invalid Previous Context Request');
        expect(prompt).toContain('return only the needs_context JSON object');
        expect(prompt).toContain('custom JSON object or unsupported schema');
        expect(prompt).toContain('Do not emit XML, function-call, tool-call, invoke, parameter, arg_key, arg_value, read_file, [TOOL_CALL], or "tool_calls" markup');
    });

    it('parses alternate file-list context requests from routed models', () => {
        const requests = parseContextRequests(
            '{"status":"success","data":{"files":[{"path":"src/providers/nanogpt-driver.ts","lines":"140-220"}]}}',
            { maxSnippets: 1, maxLines: 40, maxBytes: 1000, maxRounds: 1 },
        );

        expect(requests).toEqual([{
            path: 'src/providers/nanogpt-driver.ts',
            line_start: 140,
            line_end: 179,
            reason: 'model requested file range using alternate context-request JSON',
        }]);
    });

    it('detects context-request and tool-result JSON envelopes', () => {
        expect(containsProtocolEnvelopeJson('{"needs_context":[]}')).toBe(true);
        expect(containsProtocolEnvelopeJson('{"status":"success","data":{"files":[{"path":"src/index.ts","text":"code"}]}}')).toBe(true);
        expect(containsProtocolEnvelopeJson('{"status":"success","data":{"read":[{"path":"src/index.ts"}]}}')).toBe(true);
        expect(containsProtocolEnvelopeJson('{"status":"error","error":{"code":"tool.not_allowed"}}')).toBe(true);
        expect(containsProtocolEnvelopeJson('{"status":"success","summary":"no files"}')).toBe(false);
        expect(containsProtocolEnvelopeJson('Plain Markdown findings')).toBe(false);
    });

    it('builds shared context scout prompts that request ranges rather than summaries', () => {
        const prompt = buildSharedContextRequestPrompt('Review the code.', {
            maxSnippets: 4,
            maxLines: 80,
            maxBytes: 2000,
            maxRounds: 1,
        });

        expect(prompt).toContain('Shared Raw Evidence Scout Protocol');
        expect(prompt).toContain('Return only this JSON object');
        expect(prompt).toContain('Request at most 4 snippets');
        expect(prompt).toContain('at most 80 lines');
        expect(prompt).toContain('ACA will read accepted snippets directly from disk');
        expect(prompt).toContain('If the task asks for a concrete repo fact that is not already shown verbatim');
        expect(prompt).toContain('Do not return an empty needs_context list unless the prompt already contains enough quoted evidence');
        expect(prompt).toContain('Do not summarize findings or quote code yourself');
        expect(prompt).toContain('Avoid shotgun guesses across unrelated ecosystems or fallback docs');
        expect(prompt).toContain('Missing or ENOENT snippets are not positive evidence');
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

    // C11.7 — tree requests, multi-round prompts, continuation

    it('parses type:tree context request from witness JSON', () => {
        const requests = parseContextRequests(
            '{"needs_context":[{"type":"tree","path":"src/providers","line_start":0,"line_end":0,"reason":"find driver files"}]}',
            { maxSnippets: 2, maxLines: 100, maxBytes: 5000, maxRounds: 3 },
        );

        expect(requests).toHaveLength(1);
        expect(requests[0].type).toBe('tree');
        expect(requests[0].path).toBe('src/providers');
        expect(requests[0].line_start).toBe(0);
        expect(requests[0].line_end).toBe(0);
        expect(requests[0].reason).toBe('find driver files');
    });

    it('fulfills a tree request against a real temporary directory', () => {
        const dir = mkdtempSync(join(tmpdir(), 'aca-tree-'));
        mkdirSync(join(dir, 'src'));
        mkdirSync(join(dir, 'src', 'providers'));
        writeFileSync(join(dir, 'src', 'providers', 'nanogpt-driver.ts'), '// stub');
        writeFileSync(join(dir, 'src', 'providers', 'sse-parser.ts'), '// stub');

        const snippets = fulfillContextRequests([
            { type: 'tree', path: 'src/providers', line_start: 0, line_end: 0, reason: 'find drivers' },
        ], dir, { maxSnippets: 1, maxLines: 100, maxBytes: 10_000, maxRounds: 1 });

        expect(snippets).toHaveLength(1);
        expect(snippets[0].status).toBe('ok');
        expect(snippets[0].type).toBe('tree');
        expect(snippets[0].text).toContain('src/providers/');
        expect(snippets[0].text).toContain('nanogpt-driver.ts');
        expect(snippets[0].text).toContain('sse-parser.ts');
    });

    it('returns an error snippet for a tree request on a non-existent path', () => {
        const dir = mkdtempSync(join(tmpdir(), 'aca-tree-enoent-'));

        const snippets = fulfillContextRequests([
            { type: 'tree', path: 'src/nonexistent', line_start: 0, line_end: 0, reason: 'missing dir' },
        ], dir, { maxSnippets: 1, maxLines: 100, maxBytes: 10_000, maxRounds: 1 });

        expect(snippets).toHaveLength(1);
        expect(snippets[0].status).toBe('error');
        expect(snippets[0].error).toBeTruthy();
    });

    it('returns an error snippet for a tree request targeting a file (not a directory)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'aca-tree-notdir-'));
        writeFileSync(join(dir, 'somefile.ts'), '// content');

        const snippets = fulfillContextRequests([
            { type: 'tree', path: 'somefile.ts', line_start: 0, line_end: 0, reason: 'should be dir' },
        ], dir, { maxSnippets: 1, maxLines: 100, maxBytes: 10_000, maxRounds: 1 });

        expect(snippets).toHaveLength(1);
        expect(snippets[0].status).toBe('error');
        expect(snippets[0].error).toContain('not a directory');
    });

    it('root tree at default depth exposes files inside second-level subdirectories (depth-3 fix)', () => {
        // Regression: before the fix, a tree of "." only went 2 levels deep, so
        // src/cli/consult.ts was invisible — the model could see "src/cli/" as a
        // directory but not its contents.  With maxDepth=3 the file is now listed.
        const dir = mkdtempSync(join(tmpdir(), 'aca-tree-depth3-'));
        mkdirSync(join(dir, 'src'));
        mkdirSync(join(dir, 'src', 'cli'));
        mkdirSync(join(dir, 'src', 'consult'));
        writeFileSync(join(dir, 'src', 'cli', 'consult.ts'), '// stub');
        writeFileSync(join(dir, 'src', 'consult', 'context-request.ts'), '// stub');

        const snippets = fulfillContextRequests([
            { type: 'tree', path: '.', line_start: 0, line_end: 0, reason: 'explore root' },
        ], dir, { maxSnippets: 1, maxLines: 100, maxBytes: 50_000, maxRounds: 1 });

        expect(snippets).toHaveLength(1);
        expect(snippets[0].status).toBe('ok');
        // Both files must be visible directly in the root tree
        expect(snippets[0].text).toContain('consult.ts');           // src/cli/consult.ts
        expect(snippets[0].text).toContain('context-request.ts');   // src/consult/context-request.ts
    });

    it('root tree does not descend beyond 3 levels', () => {
        // walk depths: root=1, src=2, src/a=3 (visible), src/a/b=4 (blocked)
        const dir = mkdtempSync(join(tmpdir(), 'aca-tree-maxdepth-'));
        mkdirSync(join(dir, 'src', 'a', 'b'), { recursive: true });
        writeFileSync(join(dir, 'src', 'a', 'visible.ts'), '// depth-3');  // walk-depth 3 → visible
        writeFileSync(join(dir, 'src', 'a', 'b', 'hidden.ts'), '// depth-4'); // walk-depth 4 → blocked

        const snippets = fulfillContextRequests([
            { type: 'tree', path: '.', line_start: 0, line_end: 0, reason: 'depth cap test' },
        ], dir, { maxSnippets: 1, maxLines: 100, maxBytes: 50_000, maxRounds: 1 });

        expect(snippets[0].status).toBe('ok');
        // walk-depth 3 file (src/a/visible.ts) must appear
        expect(snippets[0].text).toContain('visible.ts');
        // walk-depth 4 file (src/a/b/hidden.ts) must NOT appear
        expect(snippets[0].text).not.toContain('hidden.ts');
    });

    it('renders tree snippets with ### tree: heading (no line range)', () => {
        const treeSnippet: ContextSnippet = {
            type: 'tree',
            path: 'src/providers',
            line_start: 0,
            line_end: 0,
            reason: 'directory listing',
            status: 'ok',
            error: null,
            bytes: 50,
            truncated: false,
            text: 'src/providers/\n  nanogpt-driver.ts\n  sse-parser.ts',
        };

        const rendered = renderContextSnippets([treeSnippet]);
        expect(rendered).toContain('### tree: src/providers');
        expect(rendered).not.toContain(':0-0');
        expect(rendered).toContain('nanogpt-driver.ts');
    });

    it('renders file snippets with line range in heading', () => {
        const fileSnippet: ContextSnippet = {
            type: 'file',
            path: 'src/index.ts',
            line_start: 1,
            line_end: 10,
            reason: 'check exports',
            status: 'ok',
            error: null,
            bytes: 80,
            truncated: false,
            text: 'export * from "./cli.js";',
        };

        const rendered = renderContextSnippets([fileSnippet]);
        expect(rendered).toContain('### src/index.ts:1-10');
    });

    it('buildContextRequestPrompt includes type:tree example and round status', () => {
        const prompt = buildContextRequestPrompt(
            'Analyze the providers.',
            { maxSnippets: 4, maxLines: 200, maxBytes: 16_000, maxRounds: 3 },
            3,
            3,
        );

        expect(prompt).toContain('"type": "tree"');
        expect(prompt).toContain('type: \'tree\'');
        expect(prompt).toContain('3');
        expect(prompt).toContain('directory');
        expect(prompt).toContain('Request at most 4 snippets');
        expect(prompt).toContain('Witness Context Request Protocol');
    });

    it('buildContextRequestPrompt shows final-round warning when roundsRemaining=0', () => {
        const prompt = buildContextRequestPrompt(
            'Analyze.',
            { maxSnippets: 4, maxLines: 200, maxBytes: 16_000, maxRounds: 3 },
            0,
            3,
        );

        expect(prompt).toContain('final context-request round');
        expect(prompt).toContain('produce your final answer');
    });

    it('buildContinuationPrompt shows prior snippets and remaining rounds', () => {
        const priorSnippet: ContextSnippet = {
            type: 'tree',
            path: 'src/providers',
            line_start: 0,
            line_end: 0,
            reason: 'find drivers',
            status: 'ok',
            error: null,
            bytes: 40,
            truncated: false,
            text: 'src/providers/\n  nanogpt-driver.ts',
        };

        const prompt = buildContinuationPrompt(
            'Review the drivers.',
            [priorSnippet],
            2,
            { maxSnippets: 4, maxLines: 200, maxBytes: 16_000, maxRounds: 3 },
        );

        expect(prompt).toContain('Review the drivers.');
        expect(prompt).toContain('Context Snippets From Prior Rounds');
        expect(prompt).toContain('### tree: src/providers');
        expect(prompt).toContain('nanogpt-driver.ts');
        expect(prompt).toContain('Witness Context Request Protocol (Continuation)');
        expect(prompt).toContain('2');
        expect(prompt).toContain('continuation round');
    });

    it('buildContinuationPrompt with roundsRemaining=0 shows final-round warning', () => {
        const prompt = buildContinuationPrompt(
            'Analyze.',
            [],
            0,
            { maxSnippets: 4, maxLines: 200, maxBytes: 16_000, maxRounds: 3 },
        );

        expect(prompt).toContain('final context-request round');
        expect(prompt).toContain('produce your final answer');
    });
});
