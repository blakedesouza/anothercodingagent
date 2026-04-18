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
    provenance?: ContextProvenance;
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
    provenance?: ContextProvenance;
}

export interface ContextProvenance {
    source_kind: 'symbol' | 'snippet' | 'tree' | 'direct';
    source_ref: string;
    anchor_line?: number;
    window_before?: number;
    window_after?: number;
    window_source?: 'aca_policy' | 'model_range';
    window_policy?: 'symbol_window_v1' | 'expand_window_v1' | 'file_open_head_v1' | 'explicit_range_v1';
}

export interface ContextRequestDiagnostic {
    request_index?: number;
    reason: string;
    message: string;
    type?: string;
    path?: string;
    symbol?: string;
    anchor_line?: number | null;
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

export interface ContextRequestAnchors {
    symbolLocations?: SymbolLocation[];
    priorSnippets?: ContextSnippet[];
    groundedDirectFileSources?: Map<string, string>;
}

interface ContextRequestParseOptions {
    disallowExplicitFileRanges?: boolean;
    symbolLocations?: SymbolLocation[];
    groundedDirectFileSources?: Map<string, string>;
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
Answer in English only.
First decide whether the available evidence is enough. If it is enough, return your final findings directly in Markdown.
Assume you know nothing beyond the prompt text and any ACA-appended evidence. If the task asks for a concrete repo fact that is not shown verbatim, request the minimal supporting snippet instead of guessing.
Missing snippets, ENOENT paths, or omitted files are not evidence that a file, feature, or configuration is absent.
If the available evidence cannot support a claim, request the most direct missing snippets or leave that point as an open question in the final report.
ACA rejects blind file line guesses. Do not invent raw line ranges such as 250-300.

If one narrow follow-up is needed before finalizing, return only this JSON object and no Markdown:
\`\`\`json
{
  "needs_context": [
    {
      "type": "symbol",
      "symbol": "<pre-verified identifier from symbol_locations>",
      "reason": "<your specific reason for needing code around this symbol>"
    }
  ]
}
\`\`\`
The angle-bracket values are placeholders — replace them with real values.
Use \`"type": "symbol"\` when one of the pre-verified symbol locations above is relevant.

To open a concrete file that ACA already exposed through a prior tree listing or prior snippet, use \`"type": "file"\` with a real repo-relative path and no line numbers — ACA chooses the window:
\`\`\`json
{
  "needs_context": [
    { "type": "file", "path": "<real/repo/relative/path.ts>", "reason": "<your reason for opening this known file>" }
  ]
}
\`\`\`

To expand around an anchor line ACA already exposed through a symbol location or prior snippet, use \`"type": "expand"\`:
\`\`\`json
{
  "needs_context": [
    { "type": "expand", "path": "<real/repo/relative/path.ts>", "anchor_line": 145, "reason": "<your reason for needing nearby lines>" }
  ]
}
\`\`\`

To explore a directory before requesting specific files, use \`"type": "tree"\` — ACA returns a 3-level listing:
\`\`\`json
{
  "needs_context": [
    { "type": "tree", "path": "<real/repo/relative/directory>", "reason": "<your reason for exploring this directory>" }
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
- Each fulfilled file snippet will be at most ${limits.maxLines} lines.
- Request only repo-relative paths.
- Do not request raw \`line_start\` / \`line_end\` ranges in witness mode. ACA chooses the snippet window for accepted file requests.
- \`anchor_line\` must be a JSON number. Do not put prose, explanations, placeholders, strings, or comments in numeric fields.
- If you do not have a verified anchor, request a narrow \`type: "tree"\` listing first or finalize with an open question.
- Use \`type: 'tree'\` for a 3-level directory listing when you are unsure of exact file names. Do not request whole-repo searches.
- Use \`type: 'symbol'\` only for identifiers listed in \`<symbol_locations>\` or otherwise explicitly cited in ACA-provided evidence.
- Use \`type: 'file'\` only for a path ACA already exposed via a prior tree listing or snippet.
- Use \`type: 'expand'\` only when ACA already exposed the file path and anchor line.
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
Answer in English only.
Review the fulfilled snippets above and decide if you need more context or can finalize.
If the available snippets are sufficient, return your final findings directly in Markdown.
If the evidence cannot support a claim, leave it as an open question rather than guessing.
ACA rejects blind file line guesses. Do not invent raw line ranges.

If additional context is still needed, return only this JSON object and no Markdown:
\`\`\`json
{
  "needs_context": [
    {
      "type": "expand",
      "path": "<real/repo/relative/path.ts>",
      "anchor_line": 145,
      "reason": "<your specific reason for needing nearby lines>"
    }
  ]
}
\`\`\`
The angle-bracket values are placeholders — replace them with real values. Use a real repo-relative path from fulfilled snippets or a prior tree response.
Use \`"type": "file"\` with only a path to open a file ACA already exposed via a prior tree listing.
Use \`"type": "expand"\` only around a line ACA already exposed via a symbol location or prior snippet.
Use \`"type": "symbol"\` only for a pre-verified identifier that ACA already listed.

Use \`"type": "tree"\` for a directory listing if you still need to explore a directory.

Limits:
- Request at most ${limits.maxSnippets} snippets per round.
- Each fulfilled file snippet will be at most ${limits.maxLines} lines.
- Request only repo-relative paths.
- Do not request raw \`line_start\` / \`line_end\` ranges in witness mode. ACA chooses the snippet window for accepted file requests.
- \`anchor_line\` must be a JSON number. Do not put prose, explanations, placeholders, strings, or comments in numeric fields.
- Use \`type: 'tree'\` for 3-level directory listings. Do not request whole-repo searches.
- Use \`type: 'file'\` only for a path ACA already exposed via a prior tree listing or snippet.
- Use \`type: 'expand'\` only when ACA already exposed the file path and anchor line.
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
Answer in English only. Do not request raw line ranges in witness mode. In needs_context JSON, \`anchor_line\` must be a JSON number when used, never prose or strings.
Do not emit XML, function-call, tool-call, invoke, parameter, arg_key, arg_value, read_file, [TOOL_CALL], or "tool_calls" markup.
`;
}

export function buildAdvisoryWitnessPrompt(prompt: string, strictRubric = false): string {
    return buildAdvisoryWitnessPromptWithRubric(prompt, strictRubric);
}

function buildAdvisoryRubricBlock(strictRubric: boolean): string {
    if (!strictRubric) {
        return 'Return a direct Markdown answer to the task now.';
    }
    return `Return plain Markdown only using exactly this structure:

\`\`\`markdown
## Recommendation
<2-4 sentences with a concrete recommendation or framework>

## Why
<2-4 sentences explaining why this approach fits the prompt>

## Tradeoffs
- <at least one concrete tradeoff, risk, or failure mode>

## Caveats
- <brief limitation or "None.">
\`\`\`

Do not omit or rename these sections.`;
}

function buildAdvisoryWitnessPromptWithRubric(prompt: string, strictRubric: boolean): string {
    return `${prompt.trimEnd()}

## Advisory Witness Direct-Answer Protocol

You are in ACA-native advisory witness mode.
${NO_NATIVE_FUNCTION_CALLING}
${NO_PROTOCOL_DELIBERATION}
Answer in English only.
This task is conceptual/advisory by default. Do not inspect the repository unless the prompt explicitly asks for a concrete repo fact.
${buildAdvisoryRubricBlock(strictRubric)}
Do not request repository trees, files, symbols, snippets, or line numbers unless the prompt explicitly asks for a concrete repo fact that cannot be answered from the prompt alone.
Do not collapse to "No bug found." or "No issues found." for advisory tasks.
Do not emit JSON, needs_context envelopes, tool-call markup, or tool-call intent.
`;
}

export function buildAdvisoryContextRequestRetryPrompt(
    prompt: string,
    invalidResponse: string,
    invalidReason: string,
    _limits: ContextRequestLimits = DEFAULT_CONTEXT_REQUEST_LIMITS,
    strictRubric = false,
): string {
    return `${buildAdvisoryWitnessPromptWithRubric(prompt, strictRubric)}

## Invalid Previous Context Request

Your previous response was invalid for this advisory task.

Reason:
- ${invalidReason}

\`\`\`text
${truncateUtf8(invalidResponse, 4_000)}
\`\`\`

Answer the question directly in Markdown using general reasoning from the prompt.
Do not restate the task, constraints, plan, checks, or protocol instructions.
Start with the final answer immediately; do not include internal analysis or self-critique before it.
`;
}

export function buildAdvisoryEmptyResponseRetryPrompt(
    prompt: string,
    failureReason: string,
    strictRubric = false,
): string {
    return `${prompt.trimEnd()}

## Advisory Empty-Response Recovery

Your previous attempt returned no usable answer.

Reason:
- ${failureReason}

Return plain Markdown only using exactly this structure:

\`\`\`markdown
${strictRubric
        ? `## Recommendation
<2-4 sentences with a concrete recommendation or framework>

## Why
<2-4 sentences explaining why this approach fits the prompt>

## Tradeoffs
- <at least one concrete tradeoff, risk, or failure mode>

## Caveats
- <brief limitation or "None.">`
        : `## Answer
<2-6 sentences directly answering the advisory question>

## Caveats
- <brief limitation or "None.">`}
\`\`\`

Rules:
- Answer from general reasoning in the prompt alone.
- Do not inspect the repository.
- Do not emit JSON, needs_context, tool calls, or markup about tools.
- Do not say only "No bug found." or "No issues found."
- If uncertainty remains, state it briefly inside Caveats and still answer the question.
`;
}

export function buildAdvisoryWitnessLastChancePrompt(
    prompt: string,
    invalidResponses: string[],
    invalidReason: string,
    strictRubric = false,
): string {
    const priorAttempts = invalidResponses
        .map((response, index) => `### Invalid Attempt ${index + 1}\n\n\`\`\`text\n${truncateUtf8(response, 2_000)}\n\`\`\``)
        .join('\n\n');
    return `${buildAdvisoryWitnessPromptWithRubric(prompt, strictRubric)}

## Advisory Recovery

Your previous advisory answers were invalid.

Reason:
- ${invalidReason}

${priorAttempts}

Return plain Markdown only using exactly this structure:

\`\`\`markdown
${strictRubric
        ? `## Recommendation
<2-4 sentences with a concrete recommendation or framework>

## Why
<2-4 sentences explaining why this approach fits the prompt>

## Tradeoffs
- <at least one concrete tradeoff, risk, or failure mode>

## Caveats
- <brief limitation or "None.">`
        : `## Answer
<direct substantive answer to the advisory task>

## Caveats
- <brief limitation or "None.">`}
\`\`\`

Rules:
- Do not emit JSON.
- Do not request repo context.
- Do not say only "No bug found." or "No issues found."
- If repository context is irrelevant, say so briefly inside the answer and continue with the substantive response.
`;
}

export function buildAdvisoryEmptyResponseLastChancePrompt(
    prompt: string,
    failureReasons: string[],
    strictRubric = false,
): string {
    const priorFailures = failureReasons
        .map((reason, index) => `- Attempt ${index + 1}: ${reason}`)
        .join('\n');
    return `${prompt.trimEnd()}

## Advisory Final Recovery

Your previous advisory attempts produced no usable answer.

Prior failures:
${priorFailures}

Return plain Markdown only using exactly this structure:

\`\`\`markdown
${strictRubric
        ? `## Recommendation
<2-4 sentences with a concrete recommendation or framework>

## Why
<2-4 sentences explaining why this approach fits the prompt>

## Tradeoffs
- <at least one concrete tradeoff, risk, or failure mode>

## Caveats
- <brief limitation or "None.">`
        : `## Answer
<3-5 concise sentences that directly answer the advisory task>

## Caveats
- <brief limitation or "None.">`}
\`\`\`

Rules:
- Use the prompt alone. Do not inspect or mention the repository unless the prompt explicitly asked for a repo fact.
- Do not emit JSON, needs_context, tool calls, XML, or code fences.
- Do not say only "No bug found." or "No issues found."
- If you are uncertain, give the best direct advisory answer you can and place the uncertainty in Caveats.
`;
}

export function buildSharedContextRequestPrompt(
    prompt: string,
    limits: ContextRequestLimits = DEFAULT_CONTEXT_REQUEST_LIMITS,
    symbolLocations?: SymbolLocation[],
): string {
    const symbolBlock = symbolLocations && symbolLocations.length > 0
        ? `\n<symbol_locations>\nThe following code identifiers were found in the task. Their definition\nlocations in this project are pre-verified — use them as your starting point when relevant:\n\n${symbolLocations.map(loc => `- ${loc.identifier} → ${loc.file} line ${loc.line}`).join('\n')}\n</symbol_locations>\n`
        : '';
    return `${prompt.trimEnd()}
${symbolBlock}

## Shared Raw Evidence Scout Protocol

You are selecting raw code ranges for a shared witness evidence pack.
${NO_NATIVE_FUNCTION_CALLING}
${NO_PROTOCOL_DELIBERATION}
The final evidence pack will be assembled by ACA, not by you: ACA will read accepted snippets directly from disk after your response.
Assume you know nothing beyond the prompt text and any ACA-appended evidence.
If the task asks for a concrete repo fact that is not already shown verbatim, request the minimal supporting snippets needed to verify it.
Answer in English only.
Do not return an empty needs_context list unless the prompt already contains enough quoted evidence to answer the task.
If exact file paths are unclear, request a narrow \`type: "tree"\` listing first instead of guessing likely filenames.

Return only this JSON object and no Markdown:
\`\`\`json
{
  "needs_context": [
    {
      "type": "file",
      "path": "<real/repo/relative/path.ts>",
      "reason": "<your specific reason for needing this snippet>"
    }
  ]
}
\`\`\`
The angle-bracket values are placeholders — replace them with real values. Use a real repo-relative path from the task description or evidence.
If you know the file path but not exact lines, omit \`line_start\` / \`line_end\` and ACA will open a bounded head window for you.
Do not request raw \`line_start\` / \`line_end\` ranges in the initial shared-context scout pass. Use path-only \`type: "file"\` or \`type: "tree"\`, and ACA will choose the window.
Only use path-only \`type: "file"\` when that exact repo-relative file path is already present in the task text or ACA evidence.
If one of the pre-verified symbol locations above is relevant, prefer \`"type": "symbol"\` and ACA will open a bounded window around that symbol:
\`\`\`json
{
  "needs_context": [
    { "type": "symbol", "symbol": "<pre-verified identifier from symbol_locations>", "reason": "<your reason for reviewing code around this symbol>" }
  ]
}
\`\`\`

To explore a directory before requesting specific files, use \`"type": "tree"\`:
\`\`\`json
{
  "needs_context": [
    { "type": "tree", "path": "<real/repo/relative/directory>", "line_start": 0, "line_end": 0, "reason": "<your reason for exploring this directory>" }
  ]
}
\`\`\`

Limits:
- Request at most ${limits.maxSnippets} snippets.
- Each snippet should be at most ${limits.maxLines} lines.
- Request only repo-relative paths.
- \`line_start\` and \`line_end\` are optional for \`type: "file"\` when you want ACA to open the file head. If you provide them, they must be JSON numbers with no prose, placeholders, strings, or comments.
- Use \`type: "tree"\` when you are unsure of exact file names or exact repo locations.
- Prefer narrow ranges that satisfy all witnesses before their review.
- Prefer path-only \`type: "file"\` requests when the path is known but the exact lines are not.
- Prefer \`type: "symbol"\` when a pre-verified symbol location above is directly relevant.
- Only use path-only \`type: "file"\` when the exact file path already appears in the task text or ACA evidence.
- Request paths only when the prompt or current evidence concretely suggests them.
- Avoid shotgun guesses across unrelated ecosystems or fallback docs (for example Cargo.toml, pyproject.toml, or README.md) unless the task specifically points there.
- Prefer the most direct source or config files over generic entrypoints when identifying named settings or model lineups.
- Do not request broad directories or whole-repo searches.
- Do not summarize findings or quote code yourself.
- Missing or ENOENT snippets are not positive evidence; they only mean the requested path was unhelpful.
- Do not emit tool-call markup or tool-call intent. Invalid examples include \`<tool_call>\`, \`<function_calls>\`, \`<call>\`, \`<invoke>\`, \`<parameter>\`, \`<arg_key>\`, \`<arg_value>\`, \`<read_file>\`, \`[TOOL_CALL]\`, \`"tool_calls"\`, and namespaced forms such as \`<minimax:tool_call>\`.
`;
}

export function buildSharedContextContinuationPrompt(
    originalPrompt: string,
    priorSnippets: ContextSnippet[],
    limits: ContextRequestLimits = DEFAULT_CONTEXT_REQUEST_LIMITS,
): string {
    const snippetSection = priorSnippets.length > 0
        ? `\n## Shared Context Snippets From Prior Round\n\nACA fulfilled your previous scout request(s):\n\n${renderContextSnippets(priorSnippets)}\n`
        : '';

    return `${originalPrompt.trimEnd()}
${snippetSection}
## Shared Raw Evidence Scout Protocol (Continuation)

You are selecting additional raw code ranges for a shared witness evidence pack.
${NO_NATIVE_FUNCTION_CALLING}
${NO_PROTOCOL_DELIBERATION}
ACA already fulfilled the snippets above directly from disk.
Use the tree listings and fulfilled snippets above as your grounding. Do not repeat the same unhelpful request.
If the existing snippets are already sufficient, return \`{"needs_context":[]}\`.
If exact file paths are still unclear, request another narrow \`type: "tree"\` listing instead of guessing filenames.
Answer in English only.

Return only this JSON object and no Markdown:
\`\`\`json
{
  "needs_context": [
    {
      "type": "file",
      "path": "<real/repo/relative/path.ts>",
      "reason": "<your specific reason for needing this snippet>"
    }
  ]
}
\`\`\`

Limits:
- Request at most ${limits.maxSnippets} snippets.
- Each snippet should be at most ${limits.maxLines} lines.
- Request only repo-relative paths.
- If the prior tree or snippet already exposed the file path but not exact lines, prefer path-only \`type: "file"\` and ACA will open a bounded head window.
- If ACA already exposed a file snippet and you need more nearby lines, use \`type: "expand"\` with a numeric \`anchor_line\` from that snippet.
- Do not request raw \`line_start\` / \`line_end\` ranges in shared-context continuation. ACA chooses the continuation window for anchored requests.
- Use \`type: "tree"\` for directory discovery when file names remain uncertain.
- Prefer path-only \`type: "file"\` requests when the prior tree or snippet already exposed the file path but not exact lines.
- Use \`type: "expand"\` only when ACA already exposed the file path and anchor line.
- Do not summarize findings or quote code yourself.
- Do not emit tool-call markup or tool-call intent.
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

export function parseContextRequests(
    content: string,
    limits: ContextRequestLimits = DEFAULT_CONTEXT_REQUEST_LIMITS,
    anchors?: ContextRequestAnchors,
): ContextRequest[] {
    return inspectContextRequests(content, limits, anchors).requests;
}

export function inspectContextRequests(
    content: string,
    limits: ContextRequestLimits = DEFAULT_CONTEXT_REQUEST_LIMITS,
    anchors?: ContextRequestAnchors,
    options: ContextRequestParseOptions = {},
): { requests: ContextRequest[]; diagnostics: ContextRequestDiagnostic[]; had_request_envelope: boolean } {
    let payload: unknown;
    try {
        payload = JSON.parse(sanitizeModelJson(extractJsonPayload(content)));
    } catch {
        return { requests: [], diagnostics: [], had_request_envelope: false };
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return { requests: [], diagnostics: [], had_request_envelope: false };
    }
    const rawRequests = (payload as { needs_context?: unknown }).needs_context;
    if (anchors) {
        if (!Array.isArray(rawRequests) || rawRequests.length === 0) {
            return { requests: [], diagnostics: [], had_request_envelope: Array.isArray(rawRequests) };
        }
        return normalizeAnchoredContextRequests(rawRequests, limits, anchors);
    }
    const alternateFileRequests = parseAlternateFileRequests(payload, limits, options);
    if (!Array.isArray(rawRequests)) return alternateFileRequests;
    if (rawRequests.length === 0) return alternateFileRequests;

    return normalizeContextRequests(rawRequests, limits, options);
}

export function annotateContextRequestsWithGrounding(
    requests: ContextRequest[],
    anchors: ContextRequestAnchors,
    limits?: Pick<ContextRequestLimits, 'maxLines'>,
): ContextRequest[] {
    return requests.map(request => {
        if (request.type === 'tree' || (request.provenance && request.provenance.source_kind !== 'direct')) return request;

        const fileProvenance = resolveFileRequestProvenance(request.path, anchors);
        if (fileProvenance) {
            const collapseToOpenHead = fileProvenance.source_kind === 'tree'
                && request.provenance?.window_policy === 'explicit_range_v1'
                && limits;
            return {
                ...request,
                line_start: collapseToOpenHead ? 1 : request.line_start,
                line_end: collapseToOpenHead ? Math.max(1, limits.maxLines) : request.line_end,
                provenance: collapseToOpenHead
                    ? {
                        ...fileProvenance,
                        window_source: 'aca_policy',
                        window_policy: 'file_open_head_v1',
                    }
                    : mergeWindowSelection(fileProvenance, request.provenance),
            };
        }

        const anchorLine = request.line_start;
        const expandProvenance = resolveExpandRequestProvenance(request.path, anchorLine, anchors);
        if (!expandProvenance) return request;

        return {
            ...request,
            provenance: mergeWindowSelection({
                ...expandProvenance,
                anchor_line: anchorLine,
                window_before: 0,
                window_after: Math.max(0, request.line_end - anchorLine),
            }, request.provenance),
        };
    });
}

function normalizeAnchoredContextRequests(
    rawRequests: unknown[],
    limits: ContextRequestLimits,
    anchors: ContextRequestAnchors,
): { requests: ContextRequest[]; diagnostics: ContextRequestDiagnostic[]; had_request_envelope: true } {
    if (!Array.isArray(rawRequests)) return { requests: [], diagnostics: [], had_request_envelope: true };

    const requests: ContextRequest[] = [];
    const diagnostics: ContextRequestDiagnostic[] = [];
    for (const [index, raw] of rawRequests.slice(0, limits.maxSnippets).entries()) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            diagnostics.push({
                request_index: index,
                reason: 'request_not_object',
                message: 'context request item must be a JSON object',
            });
            continue;
        }
        const record = raw as Record<string, unknown>;
        const reason = typeof record.reason === 'string' ? record.reason.trim().slice(0, 300) : '';
        const hasExplicitRange = record.line_start !== undefined || record.line_end !== undefined;
        const rawType = inferAnchoredRequestType(record);
        const requestIndex = index;

        if (rawType === 'symbol') {
            const symbol = typeof record.symbol === 'string' ? record.symbol.trim() : '';
            const location = symbol !== ''
                ? anchors.symbolLocations?.find(item => item.identifier === symbol)
                : undefined;
            if (!location) {
                diagnostics.push({
                    request_index: requestIndex,
                    reason: 'unknown_symbol',
                    message: 'symbol request did not match a pre-verified symbol location',
                    type: 'symbol',
                    symbol: symbol || undefined,
                });
                continue;
            }
            const range = windowAroundAnchor(location.line, limits.maxLines, 40, 120);
            requests.push({
                type: 'file',
                path: location.file,
                line_start: range.line_start,
                line_end: range.line_end,
                reason,
                provenance: buildAnchorProvenance(
                    'symbol',
                    location.identifier,
                    location.line,
                    range.line_start,
                    range.line_end,
                    'symbol_window_v1',
                ),
            });
            continue;
        }

        const path = typeof record.path === 'string' ? record.path.trim() : '';
        if (!path || path.includes('<') || path.includes('>')) {
            diagnostics.push({
                request_index: requestIndex,
                reason: 'placeholder_path',
                message: 'request path was empty or still contained placeholder markers',
                type: rawType ?? undefined,
                path: path || undefined,
            });
            continue;
        }

        if (rawType === 'tree') {
            requests.push({ type: 'tree', path, line_start: 0, line_end: 0, reason });
            continue;
        }

        if (rawType === 'file') {
            if (record.line_start !== undefined || record.line_end !== undefined) {
                diagnostics.push({
                    request_index: requestIndex,
                    reason: 'unsupported_anchored_file_range',
                    message: 'witness file requests may not specify raw line ranges',
                    type: 'file',
                    path,
                });
                continue;
            }
            const provenance = resolveFileRequestProvenance(path, anchors);
            if (!provenance) {
                diagnostics.push({
                    request_index: requestIndex,
                    reason: 'file_not_grounded',
                    message: 'file request path was not grounded by prior snippets, tree listings, or symbol locations',
                    type: 'file',
                    path,
                });
                continue;
            }
            requests.push({
                type: 'file',
                path,
                line_start: 1,
                line_end: Math.max(1, limits.maxLines),
                reason,
                provenance: {
                    ...provenance,
                    window_source: 'aca_policy',
                    window_policy: 'file_open_head_v1',
                },
            });
            continue;
        }

        if (rawType === 'expand') {
            const rawAnchorLine = numericField(record.anchor_line, NaN);
            if (rawAnchorLine === null || !Number.isFinite(rawAnchorLine)) {
                diagnostics.push({
                    request_index: requestIndex,
                    reason: 'invalid_anchor_line',
                    message: 'expand requests require a numeric anchor_line',
                    type: 'expand',
                    path,
                    anchor_line: typeof record.anchor_line === 'number' ? record.anchor_line : null,
                });
                continue;
            }
            const anchorLine = Math.max(1, Math.floor(rawAnchorLine));
            const provenance = resolveExpandRequestProvenance(path, anchorLine, anchors);
            if (!provenance) {
                diagnostics.push({
                    request_index: requestIndex,
                    reason: 'expand_anchor_not_exposed',
                    message: 'expand request anchor line was not previously exposed by ACA',
                    type: 'expand',
                    path,
                    anchor_line: anchorLine,
                });
                continue;
            }
            const range = windowAroundAnchor(anchorLine, limits.maxLines, 60, 140);
            requests.push({
                type: 'file',
                path,
                line_start: range.line_start,
                line_end: range.line_end,
                reason,
                provenance: {
                    ...provenance,
                    anchor_line: anchorLine,
                    window_before: anchorLine - range.line_start,
                    window_after: range.line_end - anchorLine,
                    window_source: 'aca_policy',
                    window_policy: 'expand_window_v1',
                },
            });
        }
    }
    return { requests, diagnostics, had_request_envelope: true };
}

function inferAnchoredRequestType(record: Record<string, unknown>): 'tree' | 'symbol' | 'file' | 'expand' | null {
    const explicitType = typeof record.type === 'string' ? record.type : undefined;
    if (explicitType === 'tree' || explicitType === 'symbol' || explicitType === 'file' || explicitType === 'expand') {
        return explicitType;
    }
    if (typeof record.symbol === 'string') return 'symbol';
    if (record.anchor_line !== undefined) return 'expand';
    if (typeof record.path === 'string') return 'file';
    return null;
}

function normalizeContextRequests(
    rawRequests: unknown[],
    limits: ContextRequestLimits,
    options: ContextRequestParseOptions = {},
): { requests: ContextRequest[]; diagnostics: ContextRequestDiagnostic[]; had_request_envelope: true } {
    if (!Array.isArray(rawRequests)) return { requests: [], diagnostics: [], had_request_envelope: true };

    const requests: ContextRequest[] = [];
    const diagnostics: ContextRequestDiagnostic[] = [];
    rawRequests.slice(0, limits.maxSnippets).forEach((raw, index) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            diagnostics.push({
                request_index: index,
                reason: 'request_not_object',
                message: 'context request item must be a JSON object',
            });
            return;
        }
        const record = raw as Record<string, unknown>;
        const rawType = typeof record.type === 'string' ? record.type : 'file';
        if (rawType === 'symbol') {
            const symbol = typeof record.symbol === 'string' ? record.symbol.trim() : '';
            const location = symbol !== ''
                ? options.symbolLocations?.find(item => item.identifier === symbol)
                : undefined;
            if (!location) {
                diagnostics.push({
                    request_index: index,
                    reason: 'unknown_symbol',
                    message: 'shared-context symbol request did not match a pre-verified symbol location',
                    type: 'symbol',
                    symbol: symbol || undefined,
                });
                return;
            }
            const range = windowAroundAnchor(location.line, limits.maxLines, 40, 120);
            requests.push({
                type: 'file',
                path: location.file,
                line_start: range.line_start,
                line_end: range.line_end,
                reason: typeof record.reason === 'string' ? record.reason.trim().slice(0, 300) : '',
                provenance: buildAnchorProvenance(
                    'symbol',
                    location.identifier,
                    location.line,
                    range.line_start,
                    range.line_end,
                    'symbol_window_v1',
                ),
            });
            return;
        }
        const path = typeof record.path === 'string' ? record.path.trim() : '';
        // Reject placeholder paths that were copied verbatim from the example JSON.
        if (!path || path.includes('<') || path.includes('>')) {
            diagnostics.push({
                request_index: index,
                reason: 'placeholder_path',
                message: 'request path was empty or still contained placeholder markers',
                type: rawType,
                path: path || undefined,
            });
            return;
        }
        const reason = typeof record.reason === 'string' ? record.reason.trim().slice(0, 300) : '';
        const hasExplicitRange = record.line_start !== undefined || record.line_end !== undefined;

        // Tree requests don't use line ranges.
        if (rawType === 'tree') {
            requests.push({ type: 'tree', path, line_start: 0, line_end: 0, reason });
            return;
        }
        const normalizedPath = normalizeRepoPath(path);
        const groundedDirectSource = options.groundedDirectFileSources?.get(normalizedPath);
        if (options.groundedDirectFileSources && !groundedDirectSource) {
            diagnostics.push({
                request_index: index,
                reason: 'file_not_prompt_grounded',
                message: 'shared-context initial file requests must use a file path already present in the task or ACA evidence',
                type: rawType,
                path,
            });
            return;
        }
        if (options.disallowExplicitFileRanges && hasExplicitNumericRange(record)) {
            diagnostics.push({
                request_index: index,
                reason: 'unsupported_shared_file_range',
                message: 'shared-context initial file requests may not specify raw line ranges',
                type: rawType,
                path,
            });
            return;
        }

        const rawStart = numericField(record.line_start, 1);
        if (rawStart === null) {
            diagnostics.push({
                request_index: index,
                reason: 'invalid_numeric_field',
                message: 'line_start must be a numeric JSON field',
                type: rawType,
                path,
            });
            return;
        }
        const rawEnd = numericField(record.line_end, rawStart + limits.maxLines - 1);
        if (rawEnd === null) {
            diagnostics.push({
                request_index: index,
                reason: 'invalid_numeric_field',
                message: 'line_end must be a numeric JSON field',
                type: rawType,
                path,
            });
            return;
        }
        const lineStart = Number.isFinite(rawStart) ? Math.max(1, Math.floor(rawStart)) : 1;
        const proposedEnd = Number.isFinite(rawEnd) ? Math.floor(rawEnd) : lineStart + limits.maxLines - 1;
        const lineEnd = Math.max(lineStart, Math.min(proposedEnd, lineStart + limits.maxLines - 1));
        requests.push({
            path,
            line_start: lineStart,
            line_end: lineEnd,
            reason,
            provenance: hasExplicitRange
                ? buildDirectRangeProvenance()
                : buildDirectOpenHeadProvenance(groundedDirectSource ?? 'model_request'),
        });
    });
    return { requests, diagnostics, had_request_envelope: true };
}

function numericField(value: unknown, fallback: number): number | null {
    if (value === undefined || value === null) return fallback;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function windowAroundAnchor(
    anchorLine: number,
    maxLines: number,
    linesBefore: number,
    linesAfter: number,
): { line_start: number; line_end: number } {
    const lineStart = Math.max(1, anchorLine - linesBefore);
    const proposedEnd = anchorLine + linesAfter;
    const lineEnd = Math.max(lineStart, Math.min(proposedEnd, lineStart + maxLines - 1));
    return { line_start: lineStart, line_end: lineEnd };
}

function normalizeRepoPath(value: string): string {
    const normalized = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
    if (normalized === '') return '.';
    return normalized.endsWith('/') && normalized !== '.' ? normalized.slice(0, -1) : normalized;
}

function resolveFileRequestProvenance(path: string, anchors: ContextRequestAnchors): ContextProvenance | null {
    const normalized = normalizeRepoPath(path);
    const symbolLocation = anchors.symbolLocations?.find(location => normalizeRepoPath(location.file) === normalized);
    if (symbolLocation) {
        return {
            source_kind: 'symbol',
            source_ref: symbolLocation.identifier,
            anchor_line: symbolLocation.line,
        };
    }

    const priorSnippet = anchors.priorSnippets?.find(snippet => normalizeRepoPath(snippet.path) === normalized);
    if (priorSnippet && priorSnippet.type !== 'tree') {
        return {
            source_kind: 'snippet',
            source_ref: `${priorSnippet.path}:${priorSnippet.line_start}-${priorSnippet.line_end}`,
            anchor_line: priorSnippet.line_start,
        };
    }

    const treeSnippet = anchors.priorSnippets?.find(snippet => treeSnippetContainsPath(snippet, normalized));
    if (treeSnippet && treeSnippet.type === 'tree') {
        return {
            source_kind: 'tree',
            source_ref: treeSnippet.path,
        };
    }

    const groundedDirectSource = anchors.groundedDirectFileSources?.get(normalized);
    if (groundedDirectSource) {
        return {
            source_kind: 'direct',
            source_ref: groundedDirectSource,
        };
    }

    return null;
}

function resolveExpandRequestProvenance(path: string, anchorLine: number, anchors: ContextRequestAnchors): ContextProvenance | null {
    const normalized = normalizeRepoPath(path);
    const symbolLocation = anchors.symbolLocations?.find(location =>
        normalizeRepoPath(location.file) === normalized && location.line === anchorLine,
    );
    if (symbolLocation) {
        return {
            source_kind: 'symbol',
            source_ref: symbolLocation.identifier,
        };
    }

    const snippetAnchor = anchors.priorSnippets?.find(snippet =>
        snippet.type !== 'tree'
        && normalizeRepoPath(snippet.path) === normalized
        && anchorLine >= snippet.line_start
        && anchorLine <= snippet.line_end,
    );
    if (snippetAnchor) {
        return {
            source_kind: 'snippet',
            source_ref: `${snippetAnchor.path}:${snippetAnchor.line_start}-${snippetAnchor.line_end}`,
        };
    }

    return null;
}

function treeSnippetContainsPath(snippet: ContextSnippet, candidatePath: string): boolean {
    if (snippet.type !== 'tree' || snippet.status !== 'ok') return false;
    const root = normalizeRepoPath(snippet.path);
    const target = normalizeRepoPath(candidatePath);
    const lines = snippet.text.split(/\r?\n/);
    const stack: string[] = [];

    for (const rawLine of lines.slice(1)) {
        const match = rawLine.match(/^( *)(.+)$/);
        if (!match) continue;
        const leadingSpaces = match[1].length;
        if (leadingSpaces < 2 || leadingSpaces % 2 !== 0) continue;
        const level = leadingSpaces / 2;
        const entry = match[2].trim();
        if (entry === '') continue;

        if (entry.endsWith('/')) {
            stack[level - 1] = entry.slice(0, -1);
            stack.length = level;
            if (joinRepoPath(root, ...stack) === target) return true;
            continue;
        }

        stack.length = Math.max(0, level - 1);
        if (joinRepoPath(root, ...stack, entry) === target) return true;
    }
    return false;
}

function joinRepoPath(root: string, ...parts: string[]): string {
    const filtered = [root === '.' ? '' : root, ...parts.filter(Boolean)]
        .filter(part => part !== '')
        .join('/');
    return normalizeRepoPath(filtered);
}

function buildAnchorProvenance(
    sourceKind: ContextProvenance['source_kind'],
    sourceRef: string,
    anchorLine: number,
    lineStart: number,
    lineEnd: number,
    windowPolicy: NonNullable<ContextProvenance['window_policy']>,
): ContextProvenance {
    return {
        source_kind: sourceKind,
        source_ref: sourceRef,
        anchor_line: anchorLine,
        window_before: anchorLine - lineStart,
        window_after: lineEnd - anchorLine,
        window_source: 'aca_policy',
        window_policy: windowPolicy,
    };
}

function buildDirectRangeProvenance(): ContextProvenance {
    return {
        source_kind: 'direct',
        source_ref: 'model_request',
        window_source: 'model_range',
        window_policy: 'explicit_range_v1',
    };
}

function buildDirectOpenHeadProvenance(sourceRef: string): ContextProvenance {
    return {
        source_kind: 'direct',
        source_ref: sourceRef,
        window_source: 'aca_policy',
        window_policy: 'file_open_head_v1',
    };
}

export function extractPromptGroundedFileSources(prompt: string): Map<string, string> {
    const sources = new Map<string, string>();
    const record = (rawPath: string, sourcePrefix: 'prompt_path' | 'evidence_pack_path'): void => {
        const cleaned = rawPath.replace(/[),.;:]+$/, '');
        const normalized = normalizeRepoPath(cleaned);
        if (!looksLikeRepoFilePath(normalized)) return;
        if (!sources.has(normalized)) sources.set(normalized, `${sourcePrefix}:${normalized}`);
    };

    const evidencePackHeader = /^## ([^\n]+)$/gm;
    for (const match of prompt.matchAll(evidencePackHeader)) {
        const candidate = match[1]?.trim();
        if (!candidate) continue;
        record(candidate, 'evidence_pack_path');
    }

    const pathPattern = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9_.-]+/g;
    for (const match of prompt.matchAll(pathPattern)) {
        const candidate = match[0]?.trim();
        if (!candidate || candidate.includes('://')) continue;
        record(candidate, 'prompt_path');
    }

    return sources;
}

function looksLikeRepoFilePath(path: string): boolean {
    if (path === '' || path.startsWith('/')) return false;
    const parts = path.split('/');
    const leaf = parts[parts.length - 1] ?? '';
    if (!leaf.includes('.')) return false;
    return /[A-Za-z]/.test(leaf);
}

function mergeWindowSelection(
    provenance: ContextProvenance,
    existing?: ContextProvenance,
): ContextProvenance {
    if (!existing) return provenance;
    return {
        ...provenance,
        window_source: existing.window_source ?? provenance.window_source,
        window_policy: existing.window_policy ?? provenance.window_policy,
    };
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

function parseAlternateFileRequests(
    payload: unknown,
    limits: ContextRequestLimits,
    options: ContextRequestParseOptions = {},
): { requests: ContextRequest[]; diagnostics: ContextRequestDiagnostic[]; had_request_envelope: boolean } {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return { requests: [], diagnostics: [], had_request_envelope: false };
    }
    const record = payload as Record<string, unknown>;
    const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
        ? record.data as Record<string, unknown>
        : undefined;
    const rawFiles = Array.isArray(record.files) ? record.files : (Array.isArray(data?.files) ? data.files : undefined);
    if (!rawFiles) return { requests: [], diagnostics: [], had_request_envelope: false };

    const requests: ContextRequest[] = [];
    const diagnostics: ContextRequestDiagnostic[] = [];
    for (const [index, raw] of rawFiles.slice(0, limits.maxSnippets).entries()) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            diagnostics.push({
                request_index: index,
                reason: 'request_not_object',
                message: 'alternate file request item must be a JSON object',
            });
            continue;
        }
        const file = raw as Record<string, unknown>;
        const path = typeof file.path === 'string' ? file.path.trim() : '';
        if (!path) {
            diagnostics.push({
                request_index: index,
                reason: 'placeholder_path',
                message: 'alternate file request path was empty',
            });
            continue;
        }
        const hasExplicitRange = hasExplicitNumericRange(file) || typeof file.lines === 'string';
        if (options.disallowExplicitFileRanges && hasExplicitRange) {
            diagnostics.push({
                request_index: index,
                reason: 'unsupported_shared_file_range',
                message: 'shared-context initial file requests may not specify raw line ranges',
                type: 'file',
                path,
            });
            continue;
        }
        const range = parseLineRange(file, limits);
        if (!range) {
            diagnostics.push({
                request_index: index,
                reason: 'invalid_numeric_field',
                message: 'alternate file request line range was not numeric',
                type: 'file',
                path,
            });
            continue;
        }
        const reason = typeof file.reason === 'string'
            ? file.reason.trim().slice(0, 300)
            : 'model requested file range using alternate context-request JSON';
        requests.push({
            path,
            line_start: range.lineStart,
            line_end: range.lineEnd,
            reason,
            provenance: hasExplicitRange ? buildDirectRangeProvenance() : buildDirectOpenHeadProvenance('model_request'),
        });
    }
    return { requests, diagnostics, had_request_envelope: true };
}

function hasExplicitNumericRange(record: Record<string, unknown>): boolean {
    return record.line_start !== undefined
        || record.line_end !== undefined
        || record.lineStart !== undefined
        || record.lineEnd !== undefined;
}

function parseLineRange(file: Record<string, unknown>, limits: ContextRequestLimits): { lineStart: number; lineEnd: number } | null {
    const hasExplicitStart = file.line_start !== undefined || file.lineStart !== undefined;
    const hasExplicitEnd = file.line_end !== undefined || file.lineEnd !== undefined;
    const lines = typeof file.lines === 'string' ? file.lines.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/) : null;
    const rawStart = hasExplicitStart
        ? numericField(file.line_start !== undefined ? file.line_start : file.lineStart, NaN)
        : NaN;
    const rawEnd = hasExplicitEnd
        ? numericField(file.line_end !== undefined ? file.line_end : file.lineEnd, NaN)
        : NaN;
    if ((rawStart === null || rawEnd === null) && !lines) return null;
    const lineStart = rawStart !== null && Number.isFinite(rawStart)
        ? Math.max(1, Math.floor(rawStart))
        : (lines ? Math.max(1, Number(lines[1])) : 1);
    const proposedEnd = rawEnd !== null && Number.isFinite(rawEnd)
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
            ? `\n\n[TRUNCATED — content exceeds the ${snippet.bytes}-byte limit. Use needs_context to request a validated file reopen or anchored expansion if more context is needed.]`
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

export function buildFinalizationLastChancePrompt(
    originalPrompt: string,
    requestText: string,
    snippets: ContextSnippet[],
    invalidResponses: string[],
    model?: string,
): string {
    const priorAttempts = invalidResponses
        .map((response, index) => `### Invalid Attempt ${index + 1}\n\n\`\`\`text\n${truncateUtf8(response, 2_000)}\n\`\`\``)
        .join('\n\n');
    return `${buildFinalizationPrompt(originalPrompt, requestText, snippets, model)}

## Finalization Recovery

Your previous finalization attempts were invalid. This is the last repair attempt before ACA degrades your witness output.

${priorAttempts}

Return plain Markdown only using exactly this structure:

\`\`\`markdown
## Findings
- <grounded finding or "No grounded findings.">

## Open Questions
- <remaining uncertainty tied to the provided snippets or "None.">
\`\`\`

Rules:
- Do not return JSON.
- Do not request more context.
- Do not emit tool-call markup.
- If the snippets are insufficient for a concrete bug claim, say "No grounded findings." and put the uncertainty under Open Questions.
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
