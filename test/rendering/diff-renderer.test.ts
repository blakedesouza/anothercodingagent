import { describe, it, expect } from 'vitest';
import { DiffRenderer } from '../../src/rendering/diff-renderer.js';
import type { StreamCapabilities } from '../../src/rendering/terminal-capabilities.js';

const TTY_CAPS: StreamCapabilities = { isTTY: true, colorDepth: 24, columns: 120 };
const NO_COLOR_CAPS: StreamCapabilities = { isTTY: false, colorDepth: 0, columns: 80 };
const FORCE_COLOR_CAPS: StreamCapabilities = { isTTY: false, colorDepth: 4, columns: 80 };

const ANSI_RE = /\x1b\[/;
function hasAnsi(text: string): boolean {
    return ANSI_RE.test(text);
}

// ---------------------------------------------------------------------------
// New file creation
// ---------------------------------------------------------------------------

describe('DiffRenderer — new file', () => {
    it('shows summary line for new file, not a diff', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        const result = renderer.render({
            filePath: 'src/new-file.ts',
            oldContent: '',
            newContent: 'const x = 1;\nconst y = 2;\n',
            isNewFile: true,
        });
        expect(result).toContain('Created');
        expect(result).toContain('src/new-file.ts');
        expect(result).not.toContain('@@');
    });

    it('shows correct line count in summary', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        const content = Array.from({ length: 42 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
        const result = renderer.render({
            filePath: 'src/thing.ts',
            oldContent: '',
            newContent: content,
            isNewFile: true,
        });
        expect(result).toContain('42 lines');
    });

    it('uses singular "line" when new file has 1 line', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        const result = renderer.render({
            filePath: 'src/one.ts',
            oldContent: '',
            newContent: 'export {};\n',
            isNewFile: true,
        });
        expect(result).toMatch(/\b1 line\b/);
    });

    it('shows + prefix colored green for new file', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        const result = renderer.render({
            filePath: 'src/new.ts',
            oldContent: '',
            newContent: 'export {};\n',
            isNewFile: true,
        });
        expect(result).toContain('\x1b[32m'); // green
    });
});

// ---------------------------------------------------------------------------
// Unified diff for edits
// ---------------------------------------------------------------------------

describe('DiffRenderer — unified diff', () => {
    it('renders a single line change with colors (snapshot)', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        const result = renderer.render({
            filePath: 'src/config.ts',
            oldContent: 'const x = 1;\nconst y = 2;\nconst z = 3;\n',
            newContent: 'const x = 1;\nconst y = 99;\nconst z = 3;\n',
        });
        expect(result).toMatch(ANSI_RE);
        expect(result).toMatchSnapshot();
    });

    it('shows addition lines in green', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        const result = renderer.render({
            filePath: 'src/file.ts',
            oldContent: 'const x = 1;\n',
            newContent: 'const x = 1;\nconst y = 2;\n',
        });
        expect(result).toContain('\x1b[32m'); // green
    });

    it('shows removal lines in red', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        const result = renderer.render({
            filePath: 'src/file.ts',
            oldContent: 'const x = 1;\nconst y = 2;\n',
            newContent: 'const x = 1;\n',
        });
        expect(result).toContain('\x1b[31m'); // red
    });

    it('shows hunk headers in cyan', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        const result = renderer.render({
            filePath: 'src/file.ts',
            oldContent: 'const x = 1;\n',
            newContent: 'const x = 99;\n',
        });
        expect(result).toContain('\x1b[36m'); // cyan
    });

    it('includes @@ hunk markers', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        const result = renderer.render({
            filePath: 'src/file.ts',
            oldContent: 'const x = 1;\n',
            newContent: 'const x = 99;\n',
        });
        expect(result).toContain('@@');
    });

    it('renders multiple hunks', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        // Changes at line 1 and line 20 are far enough apart (>6 lines) to produce 2 hunks
        const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
        const newLines = oldLines.replace('line 1\n', 'line one\n').replace('line 20\n', 'line twenty\n');
        const result = renderer.render({
            filePath: 'src/file.ts',
            oldContent: oldLines,
            newContent: newLines,
        });
        const hunkCount = (result.match(/@@/g) ?? []).length;
        expect(hunkCount).toBeGreaterThanOrEqual(2);
    });

    it('strips ANSI from file content lines to prevent injection', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        const result = renderer.render({
            filePath: 'src/file.ts',
            oldContent: '\x1b[2Jmalicious clear\n',
            newContent: '\x1b[2Jmalicious clear\nextra line\n',
        });
        expect(result).not.toContain('\x1b[2J');
        expect(result).toContain('malicious clear');
    });
});

// ---------------------------------------------------------------------------
// Size guard — truncation
// ---------------------------------------------------------------------------

describe('DiffRenderer — truncation', () => {
    it('truncates diff > 100 lines and shows omission indicator', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        const oldContent = Array.from({ length: 200 }, (_, i) => `old line ${i + 1}`).join('\n') + '\n';
        const newContent = Array.from({ length: 200 }, (_, i) => `new line ${i + 1}`).join('\n') + '\n';
        const result = renderer.render({
            filePath: 'src/big.ts',
            oldContent,
            newContent,
        });
        // 50 head + omission line + 10 tail = 61 non-empty lines
        const nonEmptyLines = result.split('\n').filter(l => l.length > 0);
        expect(nonEmptyLines.length).toBeLessThanOrEqual(62);
        expect(result).toContain('omitted');
    });

    it('shows first and last sections when truncated', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        const oldContent = Array.from({ length: 200 }, (_, i) => `old ${i + 1}`).join('\n') + '\n';
        const newContent = Array.from({ length: 200 }, (_, i) => `new ${i + 1}`).join('\n') + '\n';
        const result = renderer.render({
            filePath: 'src/big.ts',
            oldContent,
            newContent,
        });
        // The result should have content from both the head and tail sections
        expect(result).toContain('omitted');
        // Both head and tail portions should exist (not just one end)
        const lines = result.split('\n').filter(l => l.length > 0);
        const omissionIdx = lines.findIndex(l => l.includes('omitted'));
        expect(omissionIdx).toBeGreaterThan(0);
        expect(omissionIdx).toBeLessThan(lines.length - 1);
    });

    it('does not truncate diff <= 100 lines', () => {
        const renderer = new DiffRenderer(TTY_CAPS);
        const oldContent = 'const x = 1;\nconst y = 2;\n';
        const newContent = 'const x = 10;\nconst y = 2;\n';
        const result = renderer.render({
            filePath: 'src/small.ts',
            oldContent,
            newContent,
        });
        expect(result).not.toContain('omitted');
    });
});

// ---------------------------------------------------------------------------
// Non-TTY fallback
// ---------------------------------------------------------------------------

describe('DiffRenderer — non-TTY', () => {
    it('produces no ANSI codes when colorDepth is 0', () => {
        const renderer = new DiffRenderer(NO_COLOR_CAPS);
        const result = renderer.render({
            filePath: 'src/file.ts',
            oldContent: 'const x = 1;\n',
            newContent: 'const x = 99;\n',
        });
        expect(hasAnsi(result)).toBe(false);
    });

    it('non-TTY new file summary has no ANSI codes', () => {
        const renderer = new DiffRenderer(NO_COLOR_CAPS);
        const result = renderer.render({
            filePath: 'src/new.ts',
            oldContent: '',
            newContent: 'export {};\n',
            isNewFile: true,
        });
        expect(hasAnsi(result)).toBe(false);
    });

    it('restores diff coloring with FORCE_COLOR (non-TTY + colorDepth > 0)', () => {
        const renderer = new DiffRenderer(FORCE_COLOR_CAPS);
        const result = renderer.render({
            filePath: 'src/file.ts',
            oldContent: 'const x = 1;\n',
            newContent: 'const x = 99;\n',
        });
        expect(hasAnsi(result)).toBe(true);
    });

    it('still contains diff content when no color', () => {
        const renderer = new DiffRenderer(NO_COLOR_CAPS);
        const result = renderer.render({
            filePath: 'src/file.ts',
            oldContent: 'const x = 1;\n',
            newContent: 'const x = 99;\n',
        });
        expect(result).toContain('@@');
        expect(result).toContain('+');
        expect(result).toContain('-');
    });
});
