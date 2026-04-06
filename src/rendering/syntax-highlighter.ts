import { Chalk } from 'chalk';
import type { StreamCapabilities } from './terminal-capabilities.js';

/** Languages preloaded when the highlighter initializes. */
const BUNDLED_LANGS = [
    'typescript', 'tsx', 'javascript', 'jsx',
    'python', 'rust', 'go', 'java', 'c', 'cpp',
    'json', 'yaml', 'markdown', 'bash',
    'html', 'css', 'sql', 'dockerfile', 'toml',
] as const;

/** Map file extensions to shiki language IDs. */
const EXT_LANG: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'jsx',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    h: 'cpp',
    hpp: 'cpp',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sh: 'bash',
    bash: 'bash',
    html: 'html',
    htm: 'html',
    css: 'css',
    sql: 'sql',
    toml: 'toml',
};

/** Shebang interpreter patterns mapped to language IDs. */
const SHEBANG_PATTERNS: Array<[RegExp, string]> = [
    [/python/, 'python'],
    [/node|nodejs/, 'javascript'],
    [/\bbash\b/, 'bash'],
    [/\bsh\b/, 'bash'],
    [/ruby/, 'ruby'],
    [/perl/, 'perl'],
];

const SUPPORTED_LANGS = new Set<string>(BUNDLED_LANGS);

/**
 * Detect which language to use for highlighting, in priority order:
 * 1. Explicit code fence label (e.g., ```typescript)
 * 2. File extension from surrounding context (e.g., .ts → typescript)
 * 3. Shebang on the first line (e.g., #!/usr/bin/env python)
 * 4. null — no highlighting
 *
 * Only returns languages from the supported set. Unknown fence labels
 * return null rather than falling through to extension/shebang detection.
 */
export function detectLanguage(
    fence?: string,
    fileExt?: string,
    firstLine?: string,
): string | null {
    // 1. Explicit fence — authoritative, but only if we support it
    if (fence) {
        const lang = fence.trim().toLowerCase();
        return SUPPORTED_LANGS.has(lang) ? lang : null;
    }

    // 2. File extension from context
    if (fileExt) {
        const ext = fileExt.replace(/^\./, '').toLowerCase();
        const lang = EXT_LANG[ext];
        if (lang) return lang;
    }

    // 3. Shebang — only return languages that are actually loaded
    if (firstLine?.startsWith('#!')) {
        for (const [pattern, lang] of SHEBANG_PATTERNS) {
            if (pattern.test(firstLine)) {
                return SUPPORTED_LANGS.has(lang) ? lang : null;
            }
        }
    }

    return null;
}

export interface HighlightOptions {
    /** Language from code fence (e.g., 'typescript'). */
    fence?: string;
    /** File extension for context-based detection (e.g., '.ts' or 'ts'). */
    fileExt?: string;
}

/**
 * Syntax highlighter using shiki with WASM (Oniguruma) engine.
 *
 * Lazy-loaded on first use: zero cost for sessions that never display code.
 * First call loads the WASM engine and bundled grammars (~150-200ms).
 * Subsequent calls reuse the cached highlighter instance.
 */
export class SyntaxHighlighter {
    private highlighter: import('shiki').Highlighter | null = null;
    private initPromise: Promise<void> | null = null;
    private initFailed = false;
    private readonly chalk: InstanceType<typeof Chalk>;
    private readonly enabled: boolean;

    /**
     * @param streamCaps - Capabilities of the output stream (stdout).
     *   Highlighting is disabled when colorDepth is 0 (non-TTY without FORCE_COLOR).
     */
    constructor(streamCaps: StreamCapabilities) {
        this.enabled = streamCaps.colorDepth > 0;
        this.chalk = new Chalk({ level: colorDepthToChalkLevel(streamCaps.colorDepth) });
    }

    /** Whether the shiki highlighter has been initialized. */
    get isInitialized(): boolean {
        return this.highlighter !== null;
    }

    /**
     * Highlight a code block, returning an ANSI-colored string.
     *
     * Returns raw text when:
     * - Stream has no color support (non-TTY, NO_COLOR)
     * - Language cannot be detected
     * - Shiki initialization failed
     */
    async highlight(code: string, options?: HighlightOptions): Promise<string> {
        if (!this.enabled || this.initFailed) return code;

        const nlIdx = code.indexOf('\n');
        const firstLine = nlIdx === -1 ? code : code.slice(0, nlIdx);
        const lang = detectLanguage(options?.fence, options?.fileExt, firstLine);
        if (!lang) return code;

        await this.ensureInit();
        if (!this.highlighter) return code;

        return this.tokensToAnsi(code, lang);
    }

    /**
     * Ensure the shiki highlighter is initialized.
     * Safe to call concurrently — shares one init promise.
     */
    async ensureInit(): Promise<void> {
        if (this.highlighter) return;
        if (!this.initPromise) {
            this.initPromise = this.loadHighlighter();
        }
        await this.initPromise;
    }

    private async loadHighlighter(): Promise<void> {
        try {
            const { createHighlighter } = await import('shiki');
            this.highlighter = await createHighlighter({
                themes: ['github-dark'],
                langs: [...BUNDLED_LANGS] as string[],
            });
        } catch {
            this.initFailed = true;
        }
    }

    /** Convert shiki token output to ANSI escape sequences via chalk. */
    private tokensToAnsi(code: string, lang: string): string {
        if (!this.highlighter) return code;
        try {
            const tokenLines = this.highlighter.codeToTokensBase(code, {
                // lang is validated against SUPPORTED_LANGS before reaching here
                lang: lang as Parameters<typeof this.highlighter.codeToTokensBase>[1]['lang'],
                theme: 'github-dark',
            });
            return tokenLines
                .map(line =>
                    line
                        .map(token =>
                            token.color
                                ? this.chalk.hex(token.color)(token.content)
                                : token.content,
                        )
                        .join(''),
                )
                .join('\n');
        } catch {
            return code;
        }
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
