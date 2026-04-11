import { readFileSync, readdirSync, statSync } from 'node:fs';
import { sanitizeModelJson } from '../providers/tool-emulation.js';
import { resolve, isAbsolute, relative, join } from 'node:path';
import { NO_NATIVE_FUNCTION_CALLING, NO_PROTOCOL_DELIBERATION } from '../prompts/prompt-guardrails.js';
import { getModelHints } from '../prompts/model-hints.js';
import { IGNORE_DIRS } from './evidence-pack.js';
import type { SymbolLocation } from './symbol-lookup.js';

export interface ContextRequest {
    /** 'file' (default) reads line ranges; 'tree' returns a directory listing. */
    type?: 'file' | 'tree';
    path: string;
    line_start: number;
    line_end: number;
    reason: string;
}

export interface ContextSnippet {
    type?: 'file' | 'tree';
    path: string;
    line_start: number;
    line_end: number;
    reason: string;
    status: 'ok' | 'error';
    error: string | null;
    bytes: number;
    truncated: boolean;
    text: string;
}

export interface ContextRequestLimits {
    /** Max snippets (file or tree) per context-request round. */
    maxSnippets: number;
    maxLines: number;
    maxBytes: number;
    /** Max context-request rounds before forced finalization. The round count
     *  is the anti-runaway governor; snippet count is a per-round generosity cap. */
    maxRounds: number;
}

export const DEFAULT_CONTEXT_REQUEST_LIMITS: ContextRequestLimits = {
    maxSnippets: 8,    // per round — witnesses get the files they ask for
    maxLines: 300,     // full file coverage, not half a file
    maxBytes: 24_000,  // follows from maxLines
    maxRounds: 3,      // tree → files → one more if needed → finalize
};

function extractJsonPayload(text: string): string {
    const stripped = text.trim();
    if (stripped.startsWith('{')) return stripped;
    const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) return stripped.slice(start, end + 1);
    return stripped;
}

export function truncateUtf8(text: string, maxBytes: number): string {
    if (maxBytes <= 0) return '';
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    let result = '';
    let used = 0;
    for (const char of text) {
        const size = Buffer.byteLength(char, 'utf8');
        if (used + size > maxBytes) break;
        result += char;
        used += size;
    }
    return result;
}

function stripMarkdownCode(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`\n]*`/g, '');
}

function stripMarkdownBlockquotes(text: string): string {
    return text.split('\n').filter(line => !/^>/.test(line)).join('\n');
}

const ACA_TOOL_NAMES = 'read_file|write_file|edit_file|delete_path|move_path|make_directory|stat_path|find_paths|search_text|exec_command|open_session|session_io|close_session|ask_user|confirm_action|estimate_tokens|lsp_query|web_search|fetch_url|lookup_docs';

export function containsPseudoToolCall(text: string): boolean {
    if (containsActiveFencedToolCall(text) || containsToolCallJsonArray(text)) return true;
    const inspectableText = stripMarkdownCode(stripMarkdownBlockquotes(text));
    return /<\s*(?:[\w-]+:)?(tool_call|function_calls?|call)\b/i.test(inspectableText)
        || /\[\s*\/?\s*(?:[\w-]+:)?(tool_call|function_calls?|call)\s*\]/i.test(inspectableText)
        || /<\s*invoke\b/i.test(inspectableText)
        || /<\s*parameter\b/i.test(inspectableText)
        || /<\s*arg_(key|value)\b/i.test(inspectableText)
        || new RegExp(`<\\s*\\/?\\s*(${ACA_TOOL_NAMES})\\b`, 'i').test(inspectableText)
        || /"tool_calls"\s*:/i.test(inspectableText)
        || /"needs_tool"\s*:/i.test(inspectableText);
}

function containsActiveFencedToolCall(text: string): boolean {
    const toolName = new RegExp(`^\\s*(${ACA_TOOL_NAMES})\\s*[({]`, 'i');
    const fencedBlocks = text.matchAll(/```(?:\w+)?\s*([\s\S]*?)```/g);
    for (const block of fencedBlocks) {
        const body = block[1]?.trim() ?? '';
        if (toolName.test(body) || containsToolCallJsonArray(body)) return true;
    }
    return false;
}

function containsToolCallJsonArray(text: string): boolean {
    let payload: unknown;
    try {
        const stripped = text.trim();
        payload = JSON.parse(stripped.startsWith('[') ? stripped : extractJsonPayload(text));
    } catch {
        return false;
    }
    if (!Array.isArray(payload)) return false;
    return payload.some(item => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
        const record = item as Record<string, unknown>;
        return typeof record.name === 'string'
            && new RegExp(`^(${ACA_TOOL_NAMES})$`, 'i').test(record.name)
            && record.arguments !== undefined;
    });
}

export function containsProtocolEnvelopeJson(text: string): boolean {
    let payload: unknown;
    try {
        payload = JSON.parse(extractJsonPayload(text));
    } catch {
        return false;
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.needs_context)) return true;
    if (Array.isArray(record.files)) return true;
    if (Array.isArray(record.read)) return true;
    if (typeof record.status === 'string' && (record.data !== undefined || record.error !== undefined)) return true;
    const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
        ? record.data as Record<string, unknown>
        : undefined;
    return Array.isArray(data?.files) || Array.isArray(data?.read);
}

export function buildContextRequestPrompt(
    prompt: string,
    limits: ContextRequestLimits = DEFAULT_CONTEXT_REQUEST_LIMITS,
    roundsRemaining?: number,
    totalRounds?: number,
    symbolLocations?: SymbolLocation[],
): string {
    const roundStatusLine = buildRoundStatusLine(roundsRemaining, totalRounds);
    const symbolBlock = symbolLocations && symbolLocations.length > 0
        ? `\n<symbol_locations>\nThe following code identifiers were found in the question. Their definition\nlocations in this project are pre-verified — use them as your starting point:\n\n${symbolLocations.map(loc => `- ${loc.identifier} → ${loc.file} line ${loc.line}`).join('\n')}\n</symbol_locations>\n`
        : '';
    return `${prompt.trimEnd()}
${symbolBlock}
## Witness Context Request Protocol

You are in ACA-native context-request mode.
${NO_NATIVE_FUNCTION_CALLING}
${NO_PROTOCOL_DELIBERATION}
${roundStatusLine}
First decide whether the available evidence is enough. If it is enough, return your final findings directly in Markdown.
Assume you know nothing beyond the prompt text and any ACA-appended evidence. If the task asks for a concrete repo fact that is not shown verbatim, request the minimal supporting snippet instead of guessing.
Missing snippets, ENOENT paths, or omitted files are not evidence that a file, feature, or configuration is absent.
If the available evidence cannot support a claim, request the most direct missing snippets or leave that point as an open question in the final report.

If one narrow follow-up is needed before finalizing, return only this JSON object and no Markdown:
\`\`\`json
{
  "needs_context": [
    {
      "type": "file",
      "path": "<real/repo/relative/path.ts>",
      "line_start": 1,
      "line_end": 120,
      "reason": "<your specific reason for needing this snippet>"
    }
  ]
}
\`\`\`
The angle-bracket values are placeholders — replace them with real values. Use a real repo-relative path from the symbol locations listed above or a prior tree response.

To explore a directory before requesting specific files, use \`"type": "tree"\` — ACA returns a 3-level listing:
\`\`\`json
{
  "needs_context": [
    { "type": "tree", "path": "<real/repo/relative/directory>", "line_start": 0, "line_end": 0, "reason": "<your reason for exploring this directory>" }
  ]
}
\`\`\`

If ACA enforces structured output for this request, return the same decision using this object shape:
\`\`\`json
{
  "action": "needs_context",
  "findings_markdown": "",
  "needs_context": []
}
\`\`\`
Use "action": "final" with an empty needs_context array when no follow-up is needed, and put the report in findings_markdown.
When in doubt, prefer the simple needs_context form. The structured action form is only required if ACA explicitly signals structured output for this request.

Limits:
- Request at most ${limits.maxSnippets} snippets per round.
- Each file snippet should be at most ${limits.maxLines} lines.
- Request only repo-relative paths.
- Use \`type: 'tree'\` for a 3-level directory listing when you are unsure of exact file names. Do not request whole-repo searches.
- If a domain-named directory (e.g., \`consult/\`) doesn't appear to contain the expected file, request a tree of sibling generically-named directories (\`cli/\`, \`cmd/\`, \`commands/\`, \`bin/\`) before concluding it is absent — entry-point orchestration code often lives in those directories and delegates to domain modules.
- Only request file paths that are explicitly mentioned in the provided evidence or clearly derivable from the task description. Do not infer paths from common project conventions or assumed directory structure — an ENOENT result wastes one of your ${limits.maxSnippets} context-request slots and provides no useful information.
- Tools are disabled in this pass. Do not emit tool-call markup or tool-call intent.
- Invalid examples include \`<tool_call>\`, \`<function_calls>\`, \`<call>\`, \`<invoke>\`, \`<parameter>\`, \`<arg_key>\`, \`<arg_value>\`, \`<read_file>\`, \`[TOOL_CALL]\`, \`"tool_calls"\`, and namespaced forms such as \`<minimax:tool_call>\`.
- If you need more context, use only the needs_context JSON object above. ACA will read accepted snippets deterministically.
`;
}

function buildRoundStatusLine(roundsRemaining?: number, totalRounds?: number): string {
    if (roundsRemaining === undefined) return '';
    if (roundsRemaining <= 0) {
        return 'This is your final context-request round. After receiving snippets, produce your final answer immediately.\n';
    }
    const total = totalRounds !== undefined ? `/${totalRounds}` : '';
    return `You have ${roundsRemaining}${total} context-request round(s) remaining. Use an early round for directory exploration (\`type: "tree"\`) if unsure of file paths.\n`;
}

/**
 * Build the continuation prompt for rounds 2+. Shows the original task,
 * all snippets fulfilled so far, and the context-request protocol with
 * updated round status.
 */
export function buildContinuationPrompt(
    originalPrompt: string,
    priorSnippets: ContextSnippet[],
    roundsRemaining: number,
    limits: ContextRequestLimits,
    model?: string,
): string {
    const hints = model ? getModelHints(model) : [];
    const hintSection = hints.length > 0
        ? `\n<model_hints>\n${hints.join('\n')}\n</model_hints>\n`
        : '';
    const roundStatusLine = buildRoundStatusLine(roundsRemaining, limits.maxRounds);
    const snippetSection = priorSnippets.length > 0
        ? `\n## Context Snippets From Prior Rounds\n\nACA fulfilled your previous context request(s). The following snippets are available:\n\n${renderContextSnippets(priorSnippets)}\n`
        : '';

    return `${originalPrompt.trimEnd()}
${snippetSection}
## Witness Context Request Protocol (Continuation)

You are in ACA-native context-request mode — continuation round.
${NO_NATIVE_FUNCTION_CALLING}
${NO_PROTOCOL_DELIBERATION}
${hintSection}
${roundStatusLine}
Review the fulfilled snippets above and decide if you need more context or can finalize.
If the available snippets are sufficient, return your final findings directly in Markdown.
If the evidence cannot support a claim, leave it as an open question rather than guessing.

If additional context is still needed, return only this JSON object and no Markdown:
\`\`\`json
{
  "needs_context": [
    {
      "type": "file",
      "path": "<real/repo/relative/path.ts>",
      "line_start": 1,
      "line_end": 120,
      "reason": "<your specific reason for needing this snippet>"
    }
  ]
}
\`\`\`
The angle-bracket values are placeholders — replace them with real values. Use a real repo-relative path from fulfilled snippets or a prior tree response.

Use \`"type": "tree"\` for a directory listing if you still need to explore a directory.

Limits:
- Request at most ${limits.maxSnippets} snippets per round.
- Each file snippet should be at most ${limits.maxLines} lines.
- Request only repo-relative paths.
- Use \`type: 'tree'\` for 3-level directory listings. Do not request whole-repo searches.
- If a domain-named directory (e.g., \`consult/\`) doesn't contain the expected file, request a tree of sibling generically-named directories (\`cli/\`, \`cmd/\`, \`commands/\`, \`bin/\`) — entry-point code often lives there.
- Tools are disabled. Do not emit tool-call markup or tool-call intent.
`;
}

export function buildContextRequestRetryPrompt(prompt: string, invalidResponse: string, limits: ContextRequestLimits = DEFAULT_CONTEXT_REQUEST_LIMITS): string {
    return `${buildContextRequestPrompt(prompt, limits)}

## Invalid Previous Context Request

Your previous response attempted to call tools, emitted tool-call markup, or failed to complete this one-step context-request pass. Tools are disabled here.

\`\`\`text
${truncateUtf8(invalidResponse, 4_000)}
\`\`\`

Try again now. If you need more context, return only the needs_context JSON object from the protocol above. If the evidence is enough, return final findings in Markdown.
If your previous response used a custom JSON object or unsupported schema, rewrite it using either the exact needs_context object above or plain Markdown final findings.
Do not emit XML, function-call, tool-call, invoke, parameter, arg_key, arg_value, read_file, [TOOL_CALL], or "tool_calls" markup.
`;
}

export function buildSharedContextRequestPrompt(prompt: string, limits: ContextRequestLimits = DEFAULT_CONTEXT_REQUEST_LIMITS): string {
    return `${prompt.trimEnd()}

## Shared Raw Evidence Scout Protocol

You are selecting raw code ranges for a shared witness evidence pack.
${NO_NATIVE_FUNCTION_CALLING}
${NO_PROTOCOL_DELIBERATION}
The final evidence pack will be assembled by ACA, not by you: ACA will read accepted snippets directly from disk after your response.
Assume you know nothing beyond the prompt text and any ACA-appended evidence.
If the task asks for a concrete repo fact that is not already shown verbatim, request the minimal supporting snippets needed to verify it.
Do not return an empty needs_context list unless the prompt already contains enough quoted evidence to answer the task.

Return only this JSON object and no Markdown:
\`\`\`json
{
  "needs_context": [
    {
      "path": "<real/repo/relative/path.ts>",
      "line_start": 1,
      "line_end": 120,
      "reason": "<your specific reason for needing this snippet>"
    }
  ]
}
\`\`\`
The angle-bracket values are placeholders — replace them with real values. Use a real repo-relative path from the task description or evidence.

Limits:
- Request at most ${limits.maxSnippets} snippets.
- Each snippet should be at most ${limits.maxLines} lines.
- Request only repo-relative paths.
- Prefer narrow ranges that satisfy all witnesses before their review.
- Request paths only when the prompt or current evidence concretely suggests them.
- Avoid shotgun guesses across unrelated ecosystems or fallback docs (for example Cargo.toml, pyproject.toml, or README.md) unless the task specifically points there.
- Prefer the most direct source or config files over generic entrypoints when identifying named settings or model lineups.
- Do not request broad directories or whole-repo searches.
- Do not summarize findings or quote code yourself.
- Missing or ENOENT snippets are not positive evidence; they only mean the requested path was unhelpful.
- Do not emit tool-call markup or tool-call intent. Invalid examples include \`<tool_call>\`, \`<function_calls>\`, \`<call>\`, \`<invoke>\`, \`<parameter>\`, \`<arg_key>\`, \`<arg_value>\`, \`<read_file>\`, \`[TOOL_CALL]\`, \`"tool_calls"\`, and namespaced forms such as \`<minimax:tool_call>\`.
`;
}

/**
 * Strips `> ` blockquote markers from the start of each line.
 * Used to recover parseable JSON from models (e.g. Qwen3) that wrap
 * their entire response in blockquote syntax via delta.content.
 */
export function stripBlockquoteMarkers(text: string): string {
    return text
        .split('\n')
        .map(line => line.replace(/^> ?/, ''))
        .join('\n');
}

export function parseContextRequests(content: string, limits: ContextRequestLimits = DEFAULT_CONTEXT_REQUEST_LIMITS): ContextRequest[] {
    let payload: unknown;
    try {
        payload = JSON.parse(sanitizeModelJson(extractJsonPayload(content)));
    } catch {
        return [];
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
    const rawRequests = (payload as { needs_context?: unknown }).needs_context;
    const alternateFileRequests = parseAlternateFileRequests(payload, limits);
    if (!Array.isArray(rawRequests)) return alternateFileRequests;
    if (rawRequests.length === 0) return alternateFileRequests;

    return normalizeContextRequests(rawRequests, limits);
}

function normalizeContextRequests(rawRequests: unknown[], limits: ContextRequestLimits): ContextRequest[] {
    if (!Array.isArray(rawRequests)) return [];

    const requests: ContextRequest[] = [];
    for (const raw of rawRequests.slice(0, limits.maxSnippets)) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
        const record = raw as Record<string, unknown>;
        const path = typeof record.path === 'string' ? record.path.trim() : '';
        // Reject placeholder paths that were copied verbatim from the example JSON.
        if (!path || path.includes('<') || path.includes('>')) continue;
        const reason = typeof record.reason === 'string' ? record.reason.trim().slice(0, 300) : '';

        // Tree requests don't use line ranges.
        const rawType = typeof record.type === 'string' ? record.type : 'file';
        if (rawType === 'tree') {
            requests.push({ type: 'tree', path, line_start: 0, line_end: 0, reason });
            continue;
        }

        const rawStart = typeof record.line_start === 'number' ? record.line_start : Number(record.line_start ?? 1);
        const rawEnd = typeof record.line_end === 'number' ? record.line_end : Number(record.line_end ?? rawStart + limits.maxLines - 1);
        const lineStart = Number.isFinite(rawStart) ? Math.max(1, Math.floor(rawStart)) : 1;
        const proposedEnd = Number.isFinite(rawEnd) ? Math.floor(rawEnd) : lineStart + limits.maxLines - 1;
        const lineEnd = Math.max(lineStart, Math.min(proposedEnd, lineStart + limits.maxLines - 1));
        requests.push({ path, line_start: lineStart, line_end: lineEnd, reason });
    }
    return requests;
}

/**
 * Build a 2-level directory tree listing for a given path, skipping ignored
 * directories. Used to satisfy `type: "tree"` context requests so witnesses
 * can orient themselves before requesting specific files.
 */
function buildDirectoryTree(root: string, relPath: string, maxDepth = 3): string {
    const absPath = resolve(root, relPath);
    const lines: string[] = [`${relPath}/`];

    function walk(dir: string, depth: number, prefix: string): void {
        if (depth > maxDepth) return;
        let entries: string[];
        try {
            entries = readdirSync(dir).sort();
        } catch {
            return;
        }
        for (const entry of entries) {
            if (IGNORE_DIRS.has(entry) || entry.startsWith('bug-report-')) continue;
            const entryPath = join(dir, entry);
            let isDir = false;
            try {
                isDir = statSync(entryPath).isDirectory();
            } catch {
                continue;
            }
            if (isDir) {
                lines.push(`${prefix}  ${entry}/`);
                walk(entryPath, depth + 1, `${prefix}  `);
            } else {
                lines.push(`${prefix}  ${entry}`);
            }
        }
    }

    walk(absPath, 1, '');
    return lines.join('\n');
}

function parseAlternateFileRequests(payload: unknown, limits: ContextRequestLimits): ContextRequest[] {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
    const record = payload as Record<string, unknown>;
    const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
        ? record.data as Record<string, unknown>
        : undefined;
    const rawFiles = Array.isArray(record.files) ? record.files : (Array.isArray(data?.files) ? data.files : undefined);
    if (!rawFiles) return [];

    const requests: ContextRequest[] = [];
    for (const raw of rawFiles.slice(0, limits.maxSnippets)) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
        const file = raw as Record<string, unknown>;
        const path = typeof file.path === 'string' ? file.path.trim() : '';
        if (!path) continue;
        const { lineStart, lineEnd } = parseLineRange(file, limits);
        const reason = typeof file.reason === 'string'
            ? file.reason.trim().slice(0, 300)
            : 'model requested file range using alternate context-request JSON';
        requests.push({ path, line_start: lineStart, line_end: lineEnd, reason });
    }
    return requests;
}

function parseLineRange(file: Record<string, unknown>, limits: ContextRequestLimits): { lineStart: number; lineEnd: number } {
    const hasExplicitStart = file.line_start !== undefined || file.lineStart !== undefined;
    const hasExplicitEnd = file.line_end !== undefined || file.lineEnd !== undefined;
    const rawStart = hasExplicitStart
        ? (typeof file.line_start === 'number' ? file.line_start : Number(file.line_start ?? file.lineStart))
        : NaN;
    const rawEnd = hasExplicitEnd
        ? (typeof file.line_end === 'number' ? file.line_end : Number(file.line_end ?? file.lineEnd))
        : NaN;
    const lines = typeof file.lines === 'string' ? file.lines.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/) : null;
    const lineStart = Number.isFinite(rawStart)
        ? Math.max(1, Math.floor(rawStart))
        : (lines ? Math.max(1, Number(lines[1])) : 1);
    const proposedEnd = Number.isFinite(rawEnd)
        ? Math.floor(rawEnd)
        : (lines ? Number(lines[2]) : lineStart + limits.maxLines - 1);
    const lineEnd = Math.max(lineStart, Math.min(proposedEnd, lineStart + limits.maxLines - 1));
    return { lineStart, lineEnd };
}

function isInside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function fulfillContextRequests(
    requests: ContextRequest[],
    projectDir: string,
    limits: ContextRequestLimits = DEFAULT_CONTEXT_REQUEST_LIMITS,
): ContextSnippet[] {
    const root = resolve(projectDir);
    const snippets: ContextSnippet[] = [];
    for (const request of requests.slice(0, limits.maxSnippets)) {
        const resolved = resolve(root, request.path);
        if (!isInside(root, resolved)) {
            snippets.push({
                ...request,
                status: 'error',
                error: 'path outside project_dir',
                bytes: 0,
                truncated: false,
                text: '',
            });
            continue;
        }

        // Tree request: return a 2-level directory listing instead of file lines.
        if (request.type === 'tree') {
            try {
                const stat = statSync(resolved);
                if (!stat.isDirectory()) {
                    snippets.push({
                        ...request,
                        status: 'error',
                        error: 'path is not a directory',
                        bytes: 0,
                        truncated: false,
                        text: '',
                    });
                } else {
                    const text = buildDirectoryTree(root, request.path);
                    snippets.push({
                        ...request,
                        status: 'ok',
                        error: null,
                        bytes: Buffer.byteLength(text, 'utf8'),
                        truncated: false,
                        text,
                    });
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                snippets.push({
                    ...request,
                    status: 'error',
                    error: message.slice(0, 300),
                    bytes: 0,
                    truncated: false,
                    text: '',
                });
            }
            continue;
        }

        try {
            const lines = readFileSync(resolved, 'utf8').split(/\r?\n/);
            const start = request.line_start;
            const end = Math.min(request.line_end, lines.length);
            const rawText = start > lines.length ? '' : lines.slice(start - 1, end).join('\n');
            const text = truncateUtf8(rawText, limits.maxBytes);
            snippets.push({
                ...request,
                status: 'ok',
                error: null,
                bytes: Buffer.byteLength(text, 'utf8'),
                truncated: text !== rawText,
                text,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            snippets.push({
                ...request,
                status: 'error',
                error: message.slice(0, 300),
                bytes: 0,
                truncated: false,
                text: '',
            });
        }
    }
    return snippets;
}

export function renderContextSnippets(snippets: ContextSnippet[]): string {
    return snippets.map(snippet => {
        const isTree = snippet.type === 'tree';
        const heading = isTree
            ? `### tree: ${snippet.path}`
            : `### ${snippet.path}:${snippet.line_start}-${snippet.line_end}`;
        const reason = `Reason: ${snippet.reason || '(none provided)'}`;
        if (snippet.status === 'error') return `${heading}\n${reason}\n\nERROR: ${snippet.error}`;
        const truncationNote = snippet.truncated
            ? `\n\n[TRUNCATED — content exceeds the ${snippet.bytes}-byte limit. Use needs_context to request specific line ranges from this file if more context is needed.]`
            : '';
        return `${heading}\n${reason}\n\n\`\`\`text\n${snippet.text}\n\`\`\`${truncationNote}`;
    }).join('\n\n');
}

export function buildFinalizationPrompt(originalPrompt: string, requestText: string, snippets: ContextSnippet[], model?: string): string {
    const hints = model ? getModelHints(model) : [];
    const hintSection = hints.length > 0
        ? `\n<model_hints>\n${hints.join('\n')}\n</model_hints>\n`
        : '';
    return `${originalPrompt.trimEnd()}

## Witness Context Request

The witness requested additional context:

\`\`\`json
${extractJsonPayload(requestText)}
\`\`\`

## Fulfilled Context Snippets

ACA read the accepted snippets deterministically.
${NO_NATIVE_FUNCTION_CALLING}
${NO_PROTOCOL_DELIBERATION}
${hintSection}
${renderContextSnippets(snippets)}

## Finalization

Return your final findings now. Do not request more context. Tools are disabled in this pass.
Use only the exact prompt and fulfilled snippets shown above. Do not rely on remembered, hidden, or inferred repo contents.
If a fulfilled snippet shows ERROR, ENOENT, or empty content, treat that as missing evidence, not evidence of absence.
Do not claim a file, feature, or configuration is missing unless a provided snippet explicitly establishes that fact. Otherwise record an open question.
If ACA enforces structured output for this request, put the final Markdown report in the "markdown" field.
Do not emit tool-call markup or tool-call intent. Invalid examples include \`<tool_call>\`, \`<function_calls>\`, \`<call>\`, \`<invoke>\`, \`<parameter>\`, \`<arg_key>\`, \`<arg_value>\`, \`<read_file>\`, \`[TOOL_CALL]\`, \`"tool_calls"\`, and namespaced forms such as \`<minimax:tool_call>\`.
`;
}

export function buildFinalizationRetryPrompt(originalPrompt: string, requestText: string, snippets: ContextSnippet[], invalidResponse: string, model?: string): string {
    return `${buildFinalizationPrompt(originalPrompt, requestText, snippets, model)}

## Invalid Previous Finalization

Your previous finalization attempted to call tools or emitted tool-call markup. Tools are disabled in this pass, so that response is invalid.

\`\`\`text
${truncateUtf8(invalidResponse, 4_000)}
\`\`\`

Produce the final findings now using only the original prompt, the shared evidence pack, and the fulfilled context snippets above.
If your previous response used a custom JSON object or unsupported schema, rewrite it as plain Markdown findings instead of JSON.
Do not request more context. Do not emit XML, function-call, tool-call, invoke, or parameter markup.
Do not return needs_context JSON or file-result JSON such as {"status":"success","data":{"files":[]}}.
If ACA enforces structured output for this request, put the final Markdown report in the "markdown" field.
`;
}

export function appendSharedContextPack(prompt: string, scoutModel: string, snippets: ContextSnippet[]): string {
    if (snippets.length === 0) return prompt;
    return `${prompt.trimEnd()}

## Shared Raw Evidence Pack

ACA assembled the following raw snippets before witness invocation.
The scout model (${scoutModel}) selected the ranges, but ACA read the file contents deterministically from disk.
Treat these snippets as shared evidence, not as a model summary.

${renderContextSnippets(snippets)}
`;
}
