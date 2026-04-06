import { Chalk } from 'chalk';
import { stripAnsi } from './output-channel.js';
import type { StreamCapabilities } from './terminal-capabilities.js';
import type { SyntaxHighlighter } from './syntax-highlighter.js';

export interface MarkdownRendererOptions {
    /** Stream capabilities for color level detection. */
    streamCaps: StreamCapabilities;
    /** Whether unicode characters are supported (affects blockquote border). Default: false. */
    unicode?: boolean;
    /** Optional syntax highlighter for fenced code blocks. */
    highlighter?: SyntaxHighlighter;
}

/**
 * Selective markdown renderer for terminal output.
 *
 * Rendered elements (with styling):
 *   - Bold (`**text**`): chalk.bold
 *   - Italic (`*text*` / `_text_`): chalk.italic
 *   - Inline code (`` `code` ``): chalk.inverse with padding
 *   - Fenced code blocks: syntax-highlighted via SyntaxHighlighter
 *   - Lists (- / * / 1.): 2-space indent applied
 *   - Blockquotes (> text): gray │ prefix
 *
 * Passed through as-is:
 *   - Headers (#, ##, ...)
 *   - Tables (| ... |)
 *   - Horizontal rules (---, ***, ___)
 *
 * Structurally transformed:
 *   - Links [text](url) → `text (url)`
 *   - HTML tags: stripped
 *
 * When colorDepth=0 (non-TTY without FORCE_COLOR), chalk level is 0 so
 * no ANSI codes are emitted — structural transforms (links, HTML strip)
 * still apply.
 */
export class MarkdownRenderer {
    private readonly chalk: InstanceType<typeof Chalk>;
    private readonly unicode: boolean;
    private readonly highlighter: SyntaxHighlighter | undefined;

    constructor(options: MarkdownRendererOptions) {
        this.chalk = new Chalk({ level: colorDepthToChalkLevel(options.streamCaps.colorDepth) });
        this.unicode = options.unicode ?? false;
        this.highlighter = options.highlighter;
    }

    /**
     * Render a markdown string with selective formatting.
     * Async because fenced code blocks use the shiki highlighter.
     *
     * Input ANSI escape codes are stripped before processing to prevent
     * terminal injection (screen clearing, cursor control, OSC exfiltration)
     * from LLM-generated or user-controlled markdown content.
     */
    async render(text: string): Promise<string> {
        // Strip any pre-existing ANSI escape codes from input before processing.
        // We add our own chalk codes after; input codes are untrusted.
        const lines = stripAnsi(text).split('\n');
        const output: string[] = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];

            // Detect fenced code block start (``` or ~~~ with optional language label)
            const fenceMatch = line.match(/^(`{3,}|~{3,})([\w.-]*)\s*$/);
            if (fenceMatch) {
                const fenceOpen = fenceMatch[1];
                const lang = fenceMatch[2] || undefined;
                const codeLines: string[] = [];
                i++;

                // Collect until a matching closing fence
                while (i < lines.length) {
                    const closeMatch = lines[i].match(/^(`{3,}|~{3,})\s*$/);
                    if (
                        closeMatch &&
                        closeMatch[1][0] === fenceOpen[0] &&
                        closeMatch[1].length >= fenceOpen.length
                    ) {
                        i++; // consume closing fence
                        break;
                    }
                    codeLines.push(lines[i]);
                    i++;
                }

                const code = codeLines.join('\n');
                if (this.highlighter) {
                    output.push(await this.highlighter.highlight(code, { fence: lang }));
                } else {
                    output.push(code);
                }
                continue;
            }

            output.push(this.renderLine(line));
            i++;
        }

        return output.join('\n');
    }

    /** Render a single non-fenced line applying block-level rules. */
    private renderLine(line: string): string {
        // Headers: pass through as-is
        if (/^#{1,6}(\s|$)/.test(line)) {
            return line;
        }

        // Horizontal rule: pass through (--- / *** / ___ standing alone)
        if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
            return line;
        }

        // Blockquote: apply gray │ prefix, recursively render inline content
        if (line.startsWith('> ') || line === '>') {
            const content = line === '>' ? '' : this.renderInline(line.slice(2));
            const border = this.unicode ? '│' : '|';
            return this.chalk.gray(border) + ' ' + content;
        }

        // List items (- text, * text, + text, 1. text): add 2-space indent
        const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s(.*)$/);
        if (listMatch) {
            const [, indent, marker, content] = listMatch;
            return `  ${indent}${marker} ${this.renderInline(content)}`;
        }

        // Table rows: pass through (lines starting with |)
        if (line.trimStart().startsWith('|')) {
            return line;
        }

        // Regular paragraph line: apply inline rendering
        return this.renderInline(line);
    }

    /** Apply inline formatting (code, bold, italic, links, HTML strip) to a text segment. */
    private renderInline(text: string): string {
        return this.processCodeSegments(text);
    }

    /**
     * Split by inline code backticks, wrap code with chalk.inverse,
     * and apply other inline styles to non-code segments.
     */
    private processCodeSegments(text: string): string {
        const parts: string[] = [];
        let remaining = text;

        while (remaining.length > 0) {
            const btIdx = remaining.indexOf('`');
            if (btIdx === -1) {
                parts.push(this.applyInlineStyles(remaining));
                break;
            }

            // Plain text before the opening backtick
            if (btIdx > 0) {
                parts.push(this.applyInlineStyles(remaining.slice(0, btIdx)));
            }

            // Find the closing backtick
            const closeIdx = remaining.indexOf('`', btIdx + 1);
            if (closeIdx === -1) {
                // Unmatched backtick — treat rest as plain text
                parts.push(this.applyInlineStyles(remaining.slice(btIdx)));
                break;
            }

            // Inline code with padding (per spec)
            const codeContent = remaining.slice(btIdx + 1, closeIdx);
            parts.push(this.chalk.inverse(` ${codeContent} `));
            remaining = remaining.slice(closeIdx + 1);
        }

        return parts.join('');
    }

    /** Apply bold, italic, link transforms, and HTML stripping to plain text. */
    private applyInlineStyles(text: string): string {
        // 1. HTML tags: strip
        let result = text.replace(/<[^>]*>/g, '');

        // 2. Links: [text](url) → text (url)
        // Strip newlines/tabs from the URL to prevent layout-breaking injection.
        // (ANSI codes are already stripped at render() entry, but raw control chars may remain.)
        result = result.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, linkText: string, url: string) => {
            const safeUrl = url.replace(/[\r\n\t]/g, '');
            return `${linkText} (${safeUrl})`;
        });

        // 3. Bold: **text** (must be before italic to consume ** before *)
        result = result.replace(/\*\*(.+?)\*\*/g, (_m, content: string) => {
            return this.chalk.bold(content);
        });

        // 4. Italic: *text* (single *, not adjacent to another *; content must not cross * chars)
        result = result.replace(/(?<!\*)\*(?!\*)([^*]+?)(?<!\*)\*(?!\*)/g, (_m, content: string) => {
            return this.chalk.italic(content);
        });

        // 5. Italic: _text_ (underscore style)
        result = result.replace(/_([^_\s][^_]*?)_/g, (_m, content: string) => {
            return this.chalk.italic(content);
        });

        return result;
    }
}

function colorDepthToChalkLevel(depth: 0 | 4 | 8 | 24): 0 | 1 | 2 | 3 {
    switch (depth) {
        case 0: return 0;
        case 4: return 1;
        case 8: return 2;
        case 24: return 3;
    }
}
