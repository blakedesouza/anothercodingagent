import { readFileSync } from 'node:fs';
import { resolve, isAbsolute, relative } from 'node:path';

export interface ContextRequest {
    path: string;
    line_start: number;
    line_end: number;
    reason: string;
}

export interface ContextSnippet {
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
    maxSnippets: number;
    maxLines: number;
    maxBytes: number;
}

export const DEFAULT_CONTEXT_REQUEST_LIMITS: ContextRequestLimits = {
    maxSnippets: 3,
    maxLines: 120,
    maxBytes: 8_000,
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

export function containsPseudoToolCall(text: string): boolean {
    const inspectableText = stripMarkdownCode(text);
    return /<\s*(?:[\w-]+:)?(tool_call|function_calls?|call)\b/i.test(inspectableText)
        || /<\s*invoke\b/i.test(inspectableText)
        || /<\s*parameter\b/i.test(inspectableText)
        || /"needs_tool"\s*:/i.test(inspectableText);
}

export function buildContextRequestPrompt(prompt: string, limits: ContextRequestLimits = DEFAULT_CONTEXT_REQUEST_LIMITS): string {
    return `${prompt.trimEnd()}

## Witness Context Request Protocol

You are in ACA-native context-request mode.

First decide whether the available evidence is enough. If it is enough, return your final findings directly in Markdown.

If one narrow follow-up is needed before finalizing, return only this JSON object and no Markdown:
\`\`\`json
{
  "needs_context": [
    {
      "path": "relative/path.ts",
      "line_start": 1,
      "line_end": 120,
      "reason": "short concrete reason"
    }
  ]
}
\`\`\`

Limits:
- Request at most ${limits.maxSnippets} snippets.
- Each snippet should be at most ${limits.maxLines} lines.
- Request only repo-relative paths.
- Do not request broad directories or whole-repo searches.
- Tools are disabled in this pass. Do not emit tool-call markup or tool-call intent.
- Invalid examples include <tool_call>, <function_calls>, <call>, <invoke>, <parameter>, and namespaced forms such as <minimax:tool_call>.
- If you need more context, use only the needs_context JSON object above. ACA will read accepted snippets deterministically.
`;
}

export function parseContextRequests(content: string, limits: ContextRequestLimits = DEFAULT_CONTEXT_REQUEST_LIMITS): ContextRequest[] {
    let payload: unknown;
    try {
        payload = JSON.parse(extractJsonPayload(content));
    } catch {
        return [];
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
    const rawRequests = (payload as { needs_context?: unknown }).needs_context;
    if (!Array.isArray(rawRequests)) return [];

    const requests: ContextRequest[] = [];
    for (const raw of rawRequests.slice(0, limits.maxSnippets)) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
        const record = raw as Record<string, unknown>;
        const path = typeof record.path === 'string' ? record.path.trim() : '';
        if (!path) continue;
        const rawStart = typeof record.line_start === 'number' ? record.line_start : Number(record.line_start ?? 1);
        const rawEnd = typeof record.line_end === 'number' ? record.line_end : Number(record.line_end ?? rawStart + limits.maxLines - 1);
        const lineStart = Number.isFinite(rawStart) ? Math.max(1, Math.floor(rawStart)) : 1;
        const proposedEnd = Number.isFinite(rawEnd) ? Math.floor(rawEnd) : lineStart + limits.maxLines - 1;
        const lineEnd = Math.max(lineStart, Math.min(proposedEnd, lineStart + limits.maxLines - 1));
        const reason = typeof record.reason === 'string' ? record.reason.trim().slice(0, 300) : '';
        requests.push({ path, line_start: lineStart, line_end: lineEnd, reason });
    }
    return requests;
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
        const heading = `### ${snippet.path}:${snippet.line_start}-${snippet.line_end}`;
        const reason = `Reason: ${snippet.reason || '(none provided)'}`;
        if (snippet.status === 'error') return `${heading}\n${reason}\n\nERROR: ${snippet.error}`;
        return `${heading}\n${reason}\n\n\`\`\`text\n${snippet.text}\n\`\`\`${snippet.truncated ? '\n\n[truncated]' : ''}`;
    }).join('\n\n');
}

export function buildFinalizationPrompt(originalPrompt: string, requestText: string, snippets: ContextSnippet[]): string {
    return `${originalPrompt.trimEnd()}

## Witness Context Request

The witness requested additional context:

\`\`\`json
${extractJsonPayload(requestText)}
\`\`\`

## Fulfilled Context Snippets

ACA read the accepted snippets deterministically. Tools are now disabled.

${renderContextSnippets(snippets)}

## Finalization

Return your final findings now. Do not request more context. Tools are disabled in this pass.
Do not emit tool-call markup or tool-call intent. Invalid examples include <tool_call>, <function_calls>, <call>, <invoke>, <parameter>, and namespaced forms such as <minimax:tool_call>.
`;
}
