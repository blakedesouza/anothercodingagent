import { describe, it, expect } from 'vitest';
import { MarkdownRenderer } from '../../src/rendering/markdown-renderer.js';
import type { StreamCapabilities } from '../../src/rendering/terminal-capabilities.js';

// ---------------------------------------------------------------------------
// Capabilities fixtures
// ---------------------------------------------------------------------------

const TTY_CAPS: StreamCapabilities = { isTTY: true, colorDepth: 24, columns: 120 };
const NO_COLOR_CAPS: StreamCapabilities = { isTTY: false, colorDepth: 0, columns: 80 };
const FORCE_COLOR_CAPS: StreamCapabilities = { isTTY: false, colorDepth: 4, columns: 80 };

const ANSI_RE = /\x1b\[/;
function hasAnsi(text: string): boolean {
    return ANSI_RE.test(text);
}

// ---------------------------------------------------------------------------
// Bold
// ---------------------------------------------------------------------------

describe('MarkdownRenderer — bold', () => {
    it('applies chalk.bold to **text** (snapshot)', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('**bold text**');
        expect(result).toMatchSnapshot();
        // ANSI bold code \x1b[1m should be present
        expect(result).toContain('\x1b[1m');
        expect(result).toContain('bold text');
    });

    it('preserves surrounding text around bold', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('before **bold** after');
        expect(result).toContain('before');
        expect(result).toContain('after');
        expect(result).toContain('\x1b[1m');
    });

    it('strips ** markers without ANSI when colorDepth=0', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: NO_COLOR_CAPS });
        const result = await renderer.render('**bold text**');
        expect(hasAnsi(result)).toBe(false);
        expect(result).toContain('bold text');
        expect(result).not.toContain('**');
    });
});

// ---------------------------------------------------------------------------
// Italic
// ---------------------------------------------------------------------------

describe('MarkdownRenderer — italic', () => {
    it('applies chalk.italic to *text*', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('*italic text*');
        // chalk.italic uses ANSI code 3
        expect(result).toContain('\x1b[3m');
        expect(result).toContain('italic text');
    });

    it('applies chalk.italic to _text_', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('_italic text_');
        expect(result).toContain('\x1b[3m');
        expect(result).toContain('italic text');
    });

    it('does not confuse ** with italic *', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('**bold** and *italic*');
        expect(result).toContain('\x1b[1m'); // bold
        expect(result).toContain('\x1b[3m'); // italic
    });
});

// ---------------------------------------------------------------------------
// Inline code
// ---------------------------------------------------------------------------

describe('MarkdownRenderer — inline code', () => {
    it('applies chalk.inverse to `code`', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('use `inline` here');
        // chalk.inverse uses ANSI code 7
        expect(result).toContain('\x1b[7m');
        expect(result).toContain('inline');
    });

    it('adds padding around inline code content', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('`code`');
        // The rendered code content should have surrounding spaces
        expect(result).toContain(' code ');
    });

    it('does not apply bold/italic inside inline code', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        // The **bold** inside backticks should NOT be styled — it's code
        const result = await renderer.render('`**not bold**`');
        // Content should be literal **not bold** (inside inverse)
        expect(result).toContain('**not bold**');
    });

    it('produces no ANSI for inline code when colorDepth=0', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: NO_COLOR_CAPS });
        const result = await renderer.render('`code`');
        expect(hasAnsi(result)).toBe(false);
        expect(result).toContain('code');
    });
});

// ---------------------------------------------------------------------------
// Fenced code blocks
// ---------------------------------------------------------------------------

describe('MarkdownRenderer — fenced code blocks', () => {
    it('passes code through when no highlighter provided', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('```typescript\nconst x = 1;\n```');
        expect(result).toContain('const x = 1;');
    });

    it('calls highlighter with fence language and code', async () => {
        let capturedCode = '';
        let capturedFence = '';
        // Minimal mock highlighter
        const mockHighlighter = {
            highlight: async (code: string, opts?: { fence?: string }) => {
                capturedCode = code;
                capturedFence = opts?.fence ?? '';
                return `[highlighted:${code}]`;
            },
        } as unknown as import('../../src/rendering/syntax-highlighter.js').SyntaxHighlighter;

        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS, highlighter: mockHighlighter });
        const result = await renderer.render('```typescript\nconst x = 1;\n```');
        expect(capturedFence).toBe('typescript');
        expect(capturedCode).toBe('const x = 1;');
        expect(result).toContain('[highlighted:const x = 1;]');
    });

    it('handles fenced block without language label', async () => {
        let capturedFence: string | undefined = 'sentinel';
        const mockHighlighter = {
            highlight: async (code: string, opts?: { fence?: string }) => {
                capturedFence = opts?.fence;
                return code;
            },
        } as unknown as import('../../src/rendering/syntax-highlighter.js').SyntaxHighlighter;

        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS, highlighter: mockHighlighter });
        await renderer.render('```\nsome code\n```');
        expect(capturedFence).toBeUndefined();
    });

    it('handles tilde fences (~~~)', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('~~~\nsome code\n~~~');
        expect(result).toContain('some code');
    });

    it('preserves multiline code block content', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('```\nline 1\nline 2\nline 3\n```');
        expect(result).toContain('line 1');
        expect(result).toContain('line 2');
        expect(result).toContain('line 3');
    });
});

// ---------------------------------------------------------------------------
// Blockquotes
// ---------------------------------------------------------------------------

describe('MarkdownRenderer — blockquotes', () => {
    it('applies gray │ prefix for unicode terminals', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS, unicode: true });
        const result = await renderer.render('> blockquote text');
        expect(result).toContain('│');
        expect(result).toContain('blockquote text');
        // gray = \x1b[90m
        expect(result).toContain('\x1b[90m');
    });

    it('uses | as fallback when unicode=false', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS, unicode: false });
        const result = await renderer.render('> blockquote text');
        // Should use ASCII pipe fallback
        expect(result).toMatch(/\|/);
        expect(result).toContain('blockquote text');
    });

    it('handles empty blockquote (> alone)', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS, unicode: true });
        const result = await renderer.render('>');
        expect(result).toContain('│');
    });

    it('still shows border without color when colorDepth=0', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: NO_COLOR_CAPS, unicode: true });
        const result = await renderer.render('> blockquote text');
        expect(hasAnsi(result)).toBe(false);
        expect(result).toContain('│');
        expect(result).toContain('blockquote text');
    });
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe('MarkdownRenderer — headers', () => {
    it('passes # header through as-is with text intact', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('# My Header');
        expect(result).toBe('# My Header');
    });

    it('passes ## through unchanged', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('## Sub-heading');
        expect(result).toBe('## Sub-heading');
    });

    it('passes h3 through h6 unchanged', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        for (const level of [3, 4, 5, 6]) {
            const header = `${'#'.repeat(level)} Heading ${level}`;
            const result = await renderer.render(header);
            expect(result).toBe(header);
        }
    });
});

// ---------------------------------------------------------------------------
// Horizontal rules
// ---------------------------------------------------------------------------

describe('MarkdownRenderer — horizontal rules', () => {
    it('passes --- through as visual separator', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('---');
        expect(result).toBe('---');
    });

    it('passes *** through unchanged', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('***');
        expect(result).toBe('***');
    });

    it('passes ___ through unchanged', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('___');
        expect(result).toBe('___');
    });
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

describe('MarkdownRenderer — links', () => {
    it('renders [text](url) as text (url)', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('[click here](https://example.com)');
        expect(result).toContain('click here (https://example.com)');
        expect(result).not.toContain('[click here]');
        expect(result).not.toContain('](');
    });

    it('handles links in the middle of text', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('See [docs](https://docs.example.com) for details');
        expect(result).toContain('See docs (https://docs.example.com) for details');
    });

    it('renders links correctly with no color (non-TTY)', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: NO_COLOR_CAPS });
        const result = await renderer.render('[text](url)');
        expect(result).toContain('text (url)');
        expect(hasAnsi(result)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

describe('MarkdownRenderer — tables', () => {
    it('passes table through as-is (columns preserved)', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const table = '| Col A | Col B |\n|-------|-------|\n| val 1 | val 2 |';
        const result = await renderer.render(table);
        expect(result).toBe(table);
    });

    it('does not modify table separator rows', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const separator = '|---|---|';
        const result = await renderer.render(separator);
        expect(result).toBe(separator);
    });
});

// ---------------------------------------------------------------------------
// HTML stripping
// ---------------------------------------------------------------------------

describe('MarkdownRenderer — HTML stripping', () => {
    it('strips HTML tags, preserving inner text', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('<div>text content</div>');
        expect(result).toContain('text content');
        expect(result).not.toContain('<div>');
        expect(result).not.toContain('</div>');
    });

    it('strips inline tags like <em> and <strong>', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('hello <em>world</em> end');
        expect(result).toContain('hello');
        expect(result).toContain('world');
        expect(result).toContain('end');
        expect(result).not.toContain('<em>');
    });

    it('strips self-closing tags like <br/>', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('line one<br/>line two');
        expect(result).not.toContain('<br/>');
        expect(result).toContain('line one');
        expect(result).toContain('line two');
    });

    it('strips HTML even in non-TTY mode', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: NO_COLOR_CAPS });
        const result = await renderer.render('<div>text</div>');
        expect(result).not.toContain('<div>');
        expect(result).toContain('text');
        expect(hasAnsi(result)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Non-TTY fallback
// ---------------------------------------------------------------------------

describe('MarkdownRenderer — non-TTY', () => {
    it('produces no ANSI codes for bold when colorDepth=0', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: NO_COLOR_CAPS });
        const result = await renderer.render('**bold**');
        expect(hasAnsi(result)).toBe(false);
        expect(result).toContain('bold');
    });

    it('produces no ANSI codes for blockquote when colorDepth=0', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: NO_COLOR_CAPS, unicode: true });
        const result = await renderer.render('> quote text');
        expect(hasAnsi(result)).toBe(false);
    });

    it('produces no ANSI codes for inline code when colorDepth=0', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: NO_COLOR_CAPS });
        const result = await renderer.render('`code`');
        expect(hasAnsi(result)).toBe(false);
    });

    it('restores styling when FORCE_COLOR is active (colorDepth > 0)', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: FORCE_COLOR_CAPS });
        const result = await renderer.render('**bold**');
        expect(hasAnsi(result)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Security: ANSI injection prevention
// ---------------------------------------------------------------------------

describe('MarkdownRenderer — ANSI injection prevention', () => {
    it('strips ANSI escape sequences from raw input text', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('Normal text \x1b[2J\x1b[H injected');
        // The ANSI clear-screen sequence should be stripped from input
        expect(result).not.toContain('\x1b[2J');
        expect(result).toContain('Normal text');
        expect(result).toContain('injected');
    });

    it('strips ANSI from inline code content', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        // ANSI inside backticks should be stripped before chalk wraps it
        const result = await renderer.render('`\x1b[2Jclear screen`');
        expect(result).not.toContain('\x1b[2J');
        expect(result).toContain('clear screen');
    });

    it('strips OSC sequences from input', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        // OSC 0 sets terminal window title — should be stripped
        const result = await renderer.render('text \x1b]0;malicious title\x07 more text');
        expect(result).not.toContain('\x1b]');
        expect(result).toContain('text');
        expect(result).toContain('more text');
    });

    it('strips carriage returns from link URLs to prevent layout injection', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        // \r within a URL (single line) would break terminal line display; should be stripped
        const result = await renderer.render('[link](https://example.com\rinjected)');
        expect(result).not.toContain('\r');
        expect(result).toContain('link');
        expect(result).toContain('https://example.com');
    });

    it('strips tab characters from link URLs', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('[link](https://\texample.com)');
        expect(result).not.toContain('\t');
    });
});

// ---------------------------------------------------------------------------
// Multi-element rendering
// ---------------------------------------------------------------------------

describe('MarkdownRenderer — multi-element', () => {
    it('renders a mixed markdown block correctly', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS, unicode: true });
        const input = [
            '# Title',
            '',
            'Some **bold** and *italic* text.',
            '',
            '> A blockquote',
            '',
            '- Item one',
            '- Item two',
            '',
            '[link](https://example.com)',
            '',
            '---',
        ].join('\n');

        const result = await renderer.render(input);

        // Header passed through
        expect(result).toContain('# Title');
        // Bold applied
        expect(result).toContain('\x1b[1m');
        // Blockquote border
        expect(result).toContain('│');
        // List indented
        expect(result).toMatch(/  - Item one/);
        // Link transformed
        expect(result).toContain('link (https://example.com)');
        // HR passed through
        expect(result).toContain('---');
    });

    it('empty string renders to empty string', async () => {
        const renderer = new MarkdownRenderer({ streamCaps: TTY_CAPS });
        const result = await renderer.render('');
        expect(result).toBe('');
    });
});
