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
    buildFinalizationLastChancePrompt,
    buildFinalizationRetryPrompt,
    annotateContextRequestsWithGrounding,
    buildSharedContextContinuationPrompt,
    buildSharedContextRequestPrompt,
    extractPromptGroundedFileSources,
    fulfillContextRequests,
    inspectContextRequests,
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
            provenance: {
                source_kind: 'direct',
                source_ref: 'model_request',
                window_source: 'model_range',
                window_policy: 'explicit_range_v1',
            },
        }]);
    });

    it('rejects malformed numeric fields in needs_context requests', () => {
        const requests = parseContextRequests(
            JSON.stringify({
                needs_context: [{
                    type: 'file',
                    path: 'anti-drift.user.js',
                    line_start: 'ставить точные номера строк невозможно',
                    line_end: 500,
                    reason: 'need lines',
                }],
            }),
            { maxSnippets: 1, maxLines: 25, maxBytes: 1000, maxRounds: 1 },
        );

        expect(requests).toEqual([]);
    });

    it('rejects blind witness file-range guesses when anchor validation is enabled', () => {
        const requests = parseContextRequests(
            JSON.stringify({
                needs_context: [{
                    type: 'file',
                    path: 'src/index.ts',
                    line_start: 250,
                    line_end: 300,
                    reason: 'guessing',
                }],
            }),
            { maxSnippets: 1, maxLines: 80, maxBytes: 1000, maxRounds: 1 },
            { symbolLocations: [], priorSnippets: [] },
        );

        expect(requests).toEqual([]);
    });

    it('records diagnostics for rejected anchored witness requests', () => {
        const inspection = inspectContextRequests(
            JSON.stringify({
                needs_context: [{
                    type: 'file',
                    path: 'src/index.ts',
                    line_start: 250,
                    line_end: 300,
                    reason: 'guessing',
                }],
            }),
            { maxSnippets: 1, maxLines: 80, maxBytes: 1000, maxRounds: 1 },
            { symbolLocations: [], priorSnippets: [] },
        );

        expect(inspection.requests).toEqual([]);
        expect(inspection.had_request_envelope).toBe(true);
        expect(inspection.diagnostics).toEqual([{
            request_index: 0,
            reason: 'unsupported_anchored_file_range',
            message: 'witness file requests may not specify raw line ranges',
            type: 'file',
            path: 'src/index.ts',
        }]);
    });

    it('resolves a symbol-anchored witness request into an ACA-chosen file window', () => {
        const requests = parseContextRequests(
            JSON.stringify({
                needs_context: [{
                    type: 'symbol',
                    symbol: 'buildContextRequestPrompt',
                    reason: 'need surrounding implementation',
                }],
            }),
            { maxSnippets: 1, maxLines: 80, maxBytes: 1000, maxRounds: 1 },
            {
                symbolLocations: [{
                    identifier: 'buildContextRequestPrompt',
                    file: 'src/consult/context-request.ts',
                    line: 145,
                    snippet: 'export function buildContextRequestPrompt(...) {',
                }],
                priorSnippets: [],
            },
        );

        expect(requests).toEqual([{
            type: 'file',
            path: 'src/consult/context-request.ts',
            line_start: 105,
            line_end: 184,
            reason: 'need surrounding implementation',
            provenance: {
                source_kind: 'symbol',
                source_ref: 'buildContextRequestPrompt',
                anchor_line: 145,
                window_before: 40,
                window_after: 39,
                window_source: 'aca_policy',
                window_policy: 'symbol_window_v1',
            },
        }]);
    });

    it('opens a file only after a prior tree listing anchored the path', () => {
        const requests = parseContextRequests(
            JSON.stringify({
                needs_context: [{
                    type: 'file',
                    path: 'src/providers/nanogpt-driver.ts',
                    reason: 'open discovered file',
                }],
            }),
            { maxSnippets: 1, maxLines: 60, maxBytes: 1000, maxRounds: 1 },
            {
                symbolLocations: [],
                priorSnippets: [{
                    type: 'tree',
                    path: 'src/providers',
                    line_start: 0,
                    line_end: 0,
                    reason: 'discover files',
                    status: 'ok',
                    error: null,
                    bytes: 64,
                    truncated: false,
                    text: 'src/providers/\n  nanogpt-driver.ts\n  sse-parser.ts',
                }],
            },
        );

        expect(requests).toEqual([{
            type: 'file',
            path: 'src/providers/nanogpt-driver.ts',
            line_start: 1,
            line_end: 60,
            reason: 'open discovered file',
            provenance: {
                source_kind: 'tree',
                source_ref: 'src/providers',
                window_source: 'aca_policy',
                window_policy: 'file_open_head_v1',
            },
        }]);
    });

    it('expands only around a line ACA already exposed', () => {
        const requests = parseContextRequests(
            JSON.stringify({
                needs_context: [{
                    type: 'expand',
                    path: 'src/consult/context-request.ts',
                    anchor_line: 145,
                    reason: 'need nearby code',
                }],
            }),
            { maxSnippets: 1, maxLines: 100, maxBytes: 1000, maxRounds: 1 },
            {
                symbolLocations: [],
                priorSnippets: [{
                    type: 'file',
                    path: 'src/consult/context-request.ts',
                    line_start: 120,
                    line_end: 170,
                    reason: 'prior snippet',
                    status: 'ok',
                    error: null,
                    bytes: 128,
                    truncated: false,
                    text: '...',
                }],
            },
        );

        expect(requests).toEqual([{
            type: 'file',
            path: 'src/consult/context-request.ts',
            line_start: 85,
            line_end: 184,
            reason: 'need nearby code',
            provenance: {
                source_kind: 'snippet',
                source_ref: 'src/consult/context-request.ts:120-170',
                anchor_line: 145,
                window_before: 60,
                window_after: 39,
                window_source: 'aca_policy',
                window_policy: 'expand_window_v1',
            },
        }]);
    });

    it('rejects expand requests for unseen anchor lines', () => {
        const requests = parseContextRequests(
            JSON.stringify({
                needs_context: [{
                    type: 'expand',
                    path: 'src/consult/context-request.ts',
                    anchor_line: 250,
                    reason: 'blind expansion',
                }],
            }),
            { maxSnippets: 1, maxLines: 100, maxBytes: 1000, maxRounds: 1 },
            {
                symbolLocations: [],
                priorSnippets: [{
                    type: 'file',
                    path: 'src/consult/context-request.ts',
                    line_start: 120,
                    line_end: 170,
                    reason: 'prior snippet',
                    status: 'ok',
                    error: null,
                    bytes: 128,
                    truncated: false,
                    text: '...',
                }],
            },
        );

        expect(requests).toEqual([]);
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

    it('preserves request provenance on fulfilled snippets', () => {
        const dir = mkdtempSync(join(tmpdir(), 'aca-context-provenance-'));
        mkdirSync(join(dir, 'src'));
        writeFileSync(join(dir, 'src', 'file.ts'), 'one\ntwo\nthree\n');

        const snippets = fulfillContextRequests([
            {
                path: 'src/file.ts',
                line_start: 1,
                line_end: 2,
                reason: 'needed',
                provenance: {
                    source_kind: 'symbol',
                    source_ref: 'someSymbol',
                    anchor_line: 2,
                    window_before: 1,
                    window_after: 0,
                },
            },
        ], dir, { maxSnippets: 1, maxLines: 10, maxBytes: 100, maxRounds: 1 });

        expect(snippets[0].status).toBe('ok');
        expect(snippets[0].provenance).toEqual({
            source_kind: 'symbol',
            source_ref: 'someSymbol',
            anchor_line: 2,
            window_before: 1,
            window_after: 0,
        });
    });

    it('collapses tree-grounded shared-context follow-up ranges into ACA-opened head windows', () => {
        const requests = annotateContextRequestsWithGrounding([
            {
                path: 'src/consult/context-request.ts',
                line_start: 1,
                line_end: 80,
                reason: 'inspect discovered file',
                provenance: {
                    source_kind: 'direct',
                    source_ref: 'model_request',
                    window_source: 'model_range',
                    window_policy: 'explicit_range_v1',
                },
            },
        ], {
            priorSnippets: [{
                type: 'tree',
                path: 'src',
                line_start: 0,
                line_end: 0,
                reason: 'discover files',
                status: 'ok',
                error: null,
                bytes: 64,
                truncated: false,
                text: 'src/\n  consult/\n    context-request.ts',
            }],
        }, {
            maxLines: 160,
        });

        expect(requests).toEqual([{
            path: 'src/consult/context-request.ts',
            line_start: 1,
            line_end: 160,
            reason: 'inspect discovered file',
            provenance: {
                source_kind: 'tree',
                source_ref: 'src',
                window_source: 'aca_policy',
                window_policy: 'file_open_head_v1',
            },
        }]);
    });

    it('preserves explicit shared-context ranges when they expand a prior file snippet', () => {
        const requests = annotateContextRequestsWithGrounding([
            {
                path: 'src/consult/context-request.ts',
                line_start: 80,
                line_end: 120,
                reason: 'continue reading discovered file',
                provenance: {
                    source_kind: 'direct',
                    source_ref: 'model_request',
                    window_source: 'model_range',
                    window_policy: 'explicit_range_v1',
                },
            },
        ], {
            priorSnippets: [{
                type: 'file',
                path: 'src/consult/context-request.ts',
                line_start: 1,
                line_end: 160,
                reason: 'inspect discovered file',
                status: 'ok',
                error: null,
                bytes: 256,
                truncated: false,
                text: 'export const strictWitnessMode = true;\n',
            }],
        }, {
            maxLines: 160,
        });

        expect(requests).toEqual([{
            path: 'src/consult/context-request.ts',
            line_start: 80,
            line_end: 120,
            reason: 'continue reading discovered file',
            provenance: {
                source_kind: 'snippet',
                source_ref: 'src/consult/context-request.ts:1-160',
                anchor_line: 1,
                window_source: 'model_range',
                window_policy: 'explicit_range_v1',
            },
        }]);
    });

    it('treats prompt-grounded path-only shared-context file requests as ACA-opened head windows', () => {
        const inspection = inspectContextRequests(
            JSON.stringify({
                needs_context: [{
                    type: 'file',
                    path: 'src/consult/context-request.ts',
                    reason: 'open discovered file head',
                }],
            }),
            { maxSnippets: 1, maxLines: 40, maxBytes: 1000, maxRounds: 1 },
            undefined,
            {
                groundedDirectFileSources: extractPromptGroundedFileSources(
                    'Review src/consult/context-request.ts for scout changes.',
                ),
            },
        );

        expect(inspection.requests).toEqual([{
            path: 'src/consult/context-request.ts',
            line_start: 1,
            line_end: 40,
            reason: 'open discovered file head',
            provenance: {
                source_kind: 'direct',
                source_ref: 'prompt_path:src/consult/context-request.ts',
                window_source: 'aca_policy',
                window_policy: 'file_open_head_v1',
            },
        }]);
        expect(inspection.diagnostics).toEqual([]);
    });

    it('treats prompt-grounded witness file requests as ACA-opened head windows', () => {
        const inspection = inspectContextRequests(
            JSON.stringify({
                needs_context: [{
                    type: 'file',
                    path: 'src/consult/context-request.ts',
                    reason: 'reopen the packed file head',
                }],
            }),
            { maxSnippets: 1, maxLines: 40, maxBytes: 1000, maxRounds: 1 },
            {
                symbolLocations: [],
                priorSnippets: [],
                groundedDirectFileSources: extractPromptGroundedFileSources(
                    'Review src/consult/context-request.ts for witness changes.',
                ),
            },
        );

        expect(inspection.requests).toEqual([{
            type: 'file',
            path: 'src/consult/context-request.ts',
            line_start: 1,
            line_end: 40,
            reason: 'reopen the packed file head',
            provenance: {
                source_kind: 'direct',
                source_ref: 'prompt_path:src/consult/context-request.ts',
                window_source: 'aca_policy',
                window_policy: 'file_open_head_v1',
            },
        }]);
        expect(inspection.diagnostics).toEqual([]);
    });

    it('rejects ungrounded initial shared-context path-only file opens when grounding mode is enabled', () => {
        const inspection = inspectContextRequests(
            JSON.stringify({
                needs_context: [{
                    type: 'file',
                    path: 'src/consult/context-request.ts',
                    reason: 'open likely file head',
                }],
            }),
            { maxSnippets: 1, maxLines: 40, maxBytes: 1000, maxRounds: 1 },
            undefined,
            {
                groundedDirectFileSources: extractPromptGroundedFileSources('Review the change.'),
            },
        );

        expect(inspection.requests).toEqual([]);
        expect(inspection.diagnostics).toEqual([{
            request_index: 0,
            reason: 'file_not_prompt_grounded',
            message: 'shared-context initial file requests must use a file path already present in the task or ACA evidence',
            type: 'file',
            path: 'src/consult/context-request.ts',
        }]);
    });

    it('extracts grounded file sources from prompt text and evidence pack headings', () => {
        const sources = extractPromptGroundedFileSources(`Review src/consult/context-request.ts.

## Deterministic Evidence Pack

## package.json

\`\`\`text
{}
\`\`\`
`);

        expect(sources.get('src/consult/context-request.ts')).toBe('prompt_path:src/consult/context-request.ts');
        expect(sources.get('package.json')).toBe('evidence_pack_path:package.json');
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
        expect(contextPrompt).toContain('Answer in English only');
        expect(contextPrompt).toContain('anchor_line');
        expect(contextPrompt).toContain('Do not invent raw line ranges');
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

    it('builds last-chance finalization recovery prompts with a fixed Markdown scaffold', () => {
        const prompt = buildFinalizationLastChancePrompt(
            'Review the code.',
            '{"needs_context":[]}',
            [],
            ['{"package_name":"anothercodingagent"}', '{"status":"success"}'],
        );

        expect(prompt).toContain('Finalization Recovery');
        expect(prompt).toContain('This is the last repair attempt');
        expect(prompt).toContain('Return plain Markdown only using exactly this structure');
        expect(prompt).toContain('## Findings');
        expect(prompt).toContain('## Open Questions');
        expect(prompt).toContain('Do not return JSON');
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
        expect(prompt).toContain('Answer in English only');
        expect(prompt).toContain('Do not request raw line ranges in witness mode');
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
            provenance: {
                source_kind: 'direct',
                source_ref: 'model_request',
                window_source: 'model_range',
                window_policy: 'explicit_range_v1',
            },
        }]);
    });

    it('rejects malformed numeric fields in alternate file-list requests', () => {
        const requests = parseContextRequests(
            JSON.stringify({
                status: 'success',
                data: {
                    files: [{
                        path: 'anti-drift.user.js',
                        line_start: 'ставить точные номера строк невозможно',
                        line_end: 80,
                    }],
                },
            }),
            { maxSnippets: 1, maxLines: 40, maxBytes: 1000, maxRounds: 1 },
        );

        expect(requests).toEqual([]);
    });

    it('detects context-request and tool-result JSON envelopes', () => {
        expect(containsProtocolEnvelopeJson('{"needs_context":[]}')).toBe(true);
        expect(containsProtocolEnvelopeJson('{"status":"success","data":{"files":[{"path":"src/index.ts","text":"code"}]}}')).toBe(true);
        expect(containsProtocolEnvelopeJson('{"status":"success","data":{"read":[{"path":"src/index.ts"}]}}')).toBe(true);
        expect(containsProtocolEnvelopeJson('{"status":"error","error":{"code":"tool.not_allowed"}}')).toBe(true);
        expect(containsProtocolEnvelopeJson('{"status":"success","summary":"no files"}')).toBe(false);
        expect(containsProtocolEnvelopeJson('Plain Markdown findings')).toBe(false);
    });

    it('builds shared context scout prompts that prefer path-only file opens over invented ranges', () => {
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
        expect(prompt).toContain('Answer in English only');
        expect(prompt).toContain('Do not return an empty needs_context list unless the prompt already contains enough quoted evidence');
        expect(prompt).toContain('optional for `type: "file"` when you want ACA to open the file head');
        expect(prompt).toContain('Do not summarize findings or quote code yourself');
        expect(prompt).toContain('Prefer path-only `type: "file"` requests when the path is known but the exact lines are not');
        expect(prompt).toContain('Do not request raw `line_start` / `line_end` ranges in the initial shared-context scout pass');
        expect(prompt).toContain('Only use path-only `type: "file"` when that exact repo-relative file path is already present in the task text or ACA evidence');
        expect(prompt).toContain('Avoid shotgun guesses across unrelated ecosystems or fallback docs');
        expect(prompt).toContain('Missing or ENOENT snippets are not positive evidence');
        expect(prompt).toContain('<minimax:tool_call>');
    });

    it('rejects explicit shared-context initial file ranges when that mode is enabled', () => {
        const inspection = inspectContextRequests(
            JSON.stringify({
                needs_context: [{
                    type: 'file',
                    path: 'src/consult/context-request.ts',
                    line_start: 140,
                    line_end: 200,
                    reason: 'read likely implementation block',
                }],
            }),
            { maxSnippets: 1, maxLines: 80, maxBytes: 2000, maxRounds: 1 },
            undefined,
            { disallowExplicitFileRanges: true },
        );

        expect(inspection.requests).toEqual([]);
        expect(inspection.diagnostics).toEqual([{
            request_index: 0,
            reason: 'unsupported_shared_file_range',
            message: 'shared-context initial file requests may not specify raw line ranges',
            type: 'file',
            path: 'src/consult/context-request.ts',
        }]);
    });

    it('resolves shared-context symbol requests into ACA-chosen file windows', () => {
        const inspection = inspectContextRequests(
            JSON.stringify({
                needs_context: [{
                    type: 'symbol',
                    symbol: 'buildSharedContextRequestPrompt',
                    reason: 'inspect shared scout prompt implementation',
                }],
            }),
            { maxSnippets: 1, maxLines: 80, maxBytes: 2000, maxRounds: 1 },
            undefined,
            {
                symbolLocations: [{
                    identifier: 'buildSharedContextRequestPrompt',
                    file: 'src/consult/context-request.ts',
                    line: 371,
                    snippet: 'export function buildSharedContextRequestPrompt(...) {',
                }],
            },
        );

        expect(inspection.requests).toEqual([{
            type: 'file',
            path: 'src/consult/context-request.ts',
            line_start: 331,
            line_end: 410,
            reason: 'inspect shared scout prompt implementation',
            provenance: {
                source_kind: 'symbol',
                source_ref: 'buildSharedContextRequestPrompt',
                anchor_line: 371,
                window_before: 40,
                window_after: 39,
                window_source: 'aca_policy',
                window_policy: 'symbol_window_v1',
            },
        }]);
        expect(inspection.diagnostics).toEqual([]);
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
        expect(prompt).toContain('"type": "symbol"');
        expect(prompt).toContain('"type": "expand"');
        expect(prompt).toContain('type: \'tree\'');
        expect(prompt).toContain('3');
        expect(prompt).toContain('directory');
        expect(prompt).toContain('Request at most 4 snippets');
        expect(prompt).toContain('Witness Context Request Protocol');
        expect(prompt).toContain('Answer in English only');
        expect(prompt).toContain('Do not request raw `line_start` / `line_end` ranges');
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
        expect(prompt).toContain('Answer in English only');
        expect(prompt).toContain('anchor_line');
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

    it('buildSharedContextRequestPrompt includes tree discovery guidance', () => {
        const prompt = buildSharedContextRequestPrompt('Review the code.', {
            maxSnippets: 4,
            maxLines: 80,
            maxBytes: 2000,
            maxRounds: 1,
        });

        expect(prompt).toContain('"type": "tree"');
        expect(prompt).toContain('If exact file paths are unclear');
        expect(prompt).toContain('Use `type: "tree"` when you are unsure of exact file names or exact repo locations');
    });

    it('buildSharedContextRequestPrompt includes pre-verified symbol guidance when symbols exist', () => {
        const prompt = buildSharedContextRequestPrompt(
            'Review buildSharedContextRequestPrompt.',
            {
                maxSnippets: 4,
                maxLines: 80,
                maxBytes: 2000,
                maxRounds: 1,
            },
            [{
                identifier: 'buildSharedContextRequestPrompt',
                file: 'src/consult/context-request.ts',
                line: 371,
                snippet: 'export function buildSharedContextRequestPrompt(...) {',
            }],
        );

        expect(prompt).toContain('<symbol_locations>');
        expect(prompt).toContain('buildSharedContextRequestPrompt → src/consult/context-request.ts line 371');
        expect(prompt).toContain('"type": "symbol"');
        expect(prompt).toContain('prefer `"type": "symbol"`');
    });

    it('buildSharedContextContinuationPrompt reuses prior snippets and allows empty completion', () => {
        const prompt = buildSharedContextContinuationPrompt(
            'Review the code.',
            [{
                type: 'tree',
                path: 'src',
                line_start: 0,
                line_end: 0,
                reason: 'discover files',
                status: 'ok',
                error: null,
                bytes: 32,
                truncated: false,
                text: 'src/\n  consult/\n    context-request.ts',
            }],
            { maxSnippets: 4, maxLines: 80, maxBytes: 2000, maxRounds: 2 },
        );

        expect(prompt).toContain('Shared Raw Evidence Scout Protocol (Continuation)');
        expect(prompt).toContain('ACA fulfilled your previous scout request');
        expect(prompt).toContain('If the existing snippets are already sufficient, return `{"needs_context":[]}`');
        expect(prompt).toContain('### tree: src');
        expect(prompt).toContain('Do not request raw `line_start` / `line_end` ranges in shared-context continuation');
        expect(prompt).toContain('Prefer path-only `type: "file"` requests when the prior tree or snippet already exposed the file path but not exact lines.');
        expect(prompt).toContain('Use `type: "expand"` only when ACA already exposed the file path and anchor line.');
    });
});
