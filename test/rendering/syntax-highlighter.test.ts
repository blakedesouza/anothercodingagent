import { describe, it, expect, beforeAll } from 'vitest';
import { detectLanguage, SyntaxHighlighter } from '../../src/rendering/syntax-highlighter.js';
import type { StreamCapabilities } from '../../src/rendering/terminal-capabilities.js';

const TTY_CAPS: StreamCapabilities = { isTTY: true, colorDepth: 24, columns: 120 };
const NO_COLOR_CAPS: StreamCapabilities = { isTTY: false, colorDepth: 0, columns: 80 };

const ANSI_RE = /\x1b\[/;

// ---------------------------------------------------------------------------
// detectLanguage — pure function, no shiki needed
// ---------------------------------------------------------------------------

describe('detectLanguage', () => {
    it('returns language from explicit fence', () => {
        expect(detectLanguage('typescript')).toBe('typescript');
        expect(detectLanguage('python')).toBe('python');
        expect(detectLanguage('rust')).toBe('rust');
        expect(detectLanguage('go')).toBe('go');
    });

    it('normalises fence to lowercase', () => {
        expect(detectLanguage('TypeScript')).toBe('typescript');
        expect(detectLanguage('PYTHON')).toBe('python');
    });

    it('returns null for unsupported fence language', () => {
        expect(detectLanguage('cobol')).toBeNull();
        expect(detectLanguage('fortran')).toBeNull();
    });

    it('detects language from file extension', () => {
        expect(detectLanguage(undefined, '.ts')).toBe('typescript');
        expect(detectLanguage(undefined, 'ts')).toBe('typescript');
        expect(detectLanguage(undefined, '.py')).toBe('python');
        expect(detectLanguage(undefined, '.rs')).toBe('rust');
        expect(detectLanguage(undefined, '.go')).toBe('go');
        expect(detectLanguage(undefined, '.json')).toBe('json');
        expect(detectLanguage(undefined, '.sh')).toBe('bash');
        expect(detectLanguage(undefined, '.yaml')).toBe('yaml');
        expect(detectLanguage(undefined, '.yml')).toBe('yaml');
    });

    it('returns null for unknown file extension', () => {
        expect(detectLanguage(undefined, '.xyz')).toBeNull();
        expect(detectLanguage(undefined, '.blerg')).toBeNull();
    });

    it('detects language from shebang line', () => {
        expect(detectLanguage(undefined, undefined, '#!/usr/bin/env python')).toBe('python');
        expect(detectLanguage(undefined, undefined, '#!/usr/bin/env python3')).toBe('python');
        expect(detectLanguage(undefined, undefined, '#!/usr/bin/node')).toBe('javascript');
        expect(detectLanguage(undefined, undefined, '#!/bin/bash')).toBe('bash');
        expect(detectLanguage(undefined, undefined, '#!/bin/sh')).toBe('bash');
    });

    it('returns null for non-shebang first line', () => {
        expect(detectLanguage(undefined, undefined, 'const x = 1;')).toBeNull();
    });

    it('returns null when no hints are provided', () => {
        expect(detectLanguage()).toBeNull();
        expect(detectLanguage(undefined, undefined, undefined)).toBeNull();
    });

    it('fence takes priority over file extension and shebang', () => {
        expect(detectLanguage('rust', '.py', '#!/usr/bin/env python')).toBe('rust');
    });

    it('file extension takes priority over shebang', () => {
        expect(detectLanguage(undefined, '.go', '#!/usr/bin/env python')).toBe('go');
    });
});

// ---------------------------------------------------------------------------
// SyntaxHighlighter — integration tests with real shiki
// ---------------------------------------------------------------------------

describe('SyntaxHighlighter', () => {
    // Shared pre-warmed instance to avoid paying init cost in every test.
    let hl: SyntaxHighlighter;

    beforeAll(async () => {
        hl = new SyntaxHighlighter(TTY_CAPS);
        await hl.ensureInit();
    }, 10_000); // generous timeout for WASM load

    // -----------------------------------------------------------------------
    // Non-TTY / no color
    // -----------------------------------------------------------------------

    it('returns raw text when colorDepth is 0 (non-TTY)', async () => {
        const noColorHl = new SyntaxHighlighter(NO_COLOR_CAPS);
        const code = 'const x = 1;';
        const result = await noColorHl.highlight(code, { fence: 'typescript' });
        expect(result).toBe(code);
        expect(result).not.toMatch(ANSI_RE);
    });

    it('does not initialize shiki when disabled', async () => {
        const noColorHl = new SyntaxHighlighter(NO_COLOR_CAPS);
        await noColorHl.highlight('const x = 1;', { fence: 'typescript' });
        expect(noColorHl.isInitialized).toBe(false);
    });

    // -----------------------------------------------------------------------
    // Lazy loading
    // -----------------------------------------------------------------------

    it('is not initialized before first highlight call', () => {
        const fresh = new SyntaxHighlighter(TTY_CAPS);
        expect(fresh.isInitialized).toBe(false);
    });

    it('initializes on first call then caches the highlighter', async () => {
        const fresh = new SyntaxHighlighter(TTY_CAPS);
        await fresh.highlight('const x = 1;', { fence: 'typescript' });
        expect(fresh.isInitialized).toBe(true);

        // Second call should still be initialized (same instance, not reset)
        await fresh.highlight('const y = 2;', { fence: 'typescript' });
        expect(fresh.isInitialized).toBe(true);
    });

    it('concurrent calls share one init promise without double-loading', async () => {
        const fresh = new SyntaxHighlighter(TTY_CAPS);
        const [r1, r2] = await Promise.all([
            fresh.highlight('const x = 1;', { fence: 'typescript' }),
            fresh.highlight('const y = 2;', { fence: 'typescript' }),
        ]);
        expect(r1).toMatch(ANSI_RE);
        expect(r2).toMatch(ANSI_RE);
        expect(fresh.isInitialized).toBe(true);
    });

    // -----------------------------------------------------------------------
    // TypeScript snapshot
    // -----------------------------------------------------------------------

    it('highlights TypeScript code (snapshot)', async () => {
        const result = await hl.highlight('const x: number = 42;', { fence: 'typescript' });
        expect(result).toMatch(ANSI_RE);
        expect(result).toMatchSnapshot();
    });

    // -----------------------------------------------------------------------
    // Language-specific highlighting (parameterized)
    // -----------------------------------------------------------------------

    it.each([
        ['python', 'def foo():\n    return 42'],
        ['rust', 'fn main() {\n    println!("hello");\n}'],
        ['go', 'func main() {\n    fmt.Println("hello")\n}'],
    ])('highlights %s code with ANSI codes', async (lang, code) => {
        const result = await hl.highlight(code, { fence: lang });
        expect(result).toMatch(ANSI_RE);
    });

    // -----------------------------------------------------------------------
    // Unknown / unsupported language
    // -----------------------------------------------------------------------

    it('returns raw text for unsupported fence language, no error', async () => {
        const code = 'PROCEDURE DIVISION.';
        const result = await hl.highlight(code, { fence: 'cobol' });
        expect(result).toBe(code);
        expect(result).not.toMatch(ANSI_RE);
    });

    it('returns raw text for unknown file extension, no error', async () => {
        const code = 'x = 1';
        const result = await hl.highlight(code, { fileExt: '.xyz' });
        expect(result).toBe(code);
        expect(result).not.toMatch(ANSI_RE);
    });

    it('returns raw text when no language hint is provided', async () => {
        const code = 'x = 1';
        const result = await hl.highlight(code);
        expect(result).toBe(code);
    });

    // -----------------------------------------------------------------------
    // Shebang detection
    // -----------------------------------------------------------------------

    it('highlights python code via shebang detection', async () => {
        const code = '#!/usr/bin/env python\nprint("hello")';
        const result = await hl.highlight(code);
        expect(result).toMatch(ANSI_RE);
    });

    // -----------------------------------------------------------------------
    // File extension detection
    // -----------------------------------------------------------------------

    it('highlights typescript code via file extension', async () => {
        const result = await hl.highlight('const x = 1;', { fileExt: '.ts' });
        expect(result).toMatch(ANSI_RE);
    });
});
