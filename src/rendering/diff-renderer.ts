import { createTwoFilesPatch } from 'diff';
import { Chalk } from 'chalk';
import { stripAnsi } from './output-channel.js';
import type { StreamCapabilities } from './terminal-capabilities.js';

const MAX_DIFF_LINES = 100;
const SHOW_HEAD = 50;
const SHOW_TAIL = 10;

export interface DiffRenderOptions {
    /** Path of the file being changed (used in diff header and summary). */
    filePath: string;
    /** Content before mutation. Empty string for new files. */
    oldContent: string;
    /** Content after mutation. */
    newContent: string;
    /**
     * True when write_file is creating a new file — shows a summary line
     * (`+ Created path (N lines)`) instead of a diff.
     */
    isNewFile?: boolean;
}

/**
 * Renders unified diffs with coloring for file mutations.
 *
 * Shows a compact unified diff (3 lines of context) for edits,
 * or a summary line for new file creation.
 *
 * Adapts to terminal capabilities: colors are disabled when colorDepth is 0
 * (non-TTY without FORCE_COLOR).
 */
export class DiffRenderer {
    private readonly chalk: InstanceType<typeof Chalk>;

    constructor(streamCaps: StreamCapabilities) {
        this.chalk = new Chalk({ level: colorDepthToChalkLevel(streamCaps.colorDepth) });
    }

    /**
     * Render a file diff or creation summary as a string ready for terminal output.
     *
     * For new files (isNewFile=true): returns `+ Created path (N lines)\n`.
     * For edits: returns a colored unified diff, truncated if > 100 lines.
     */
    render(options: DiffRenderOptions): string {
        const { filePath, oldContent, newContent, isNewFile } = options;
        // Sanitize path to prevent ANSI injection via user-controlled file names.
        const safePath = stripAnsi(filePath);

        if (isNewFile) {
            const splitLines = newContent.split('\n');
            const lineCount = splitLines.at(-1) === '' ? splitLines.length - 1 : splitLines.length;
            const prefix = this.chalk.green('+');
            const msg = `Created ${safePath} (${lineCount} line${lineCount === 1 ? '' : 's'})`;
            return `${prefix} ${msg}\n`;
        }

        const patchStr = createTwoFilesPatch(
            `a/${safePath}`,
            `b/${safePath}`,
            oldContent,
            newContent,
            '',
            '',
            { context: 3 },
        );

        const lines = patchStr.split('\n');
        // createTwoFilesPatch always ends with a newline — drop the trailing empty element
        const trimmedLines = lines.at(-1) === '' ? lines.slice(0, -1) : lines;

        const displayLines = truncate(trimmedLines);
        return displayLines.map(line => this.colorLine(line)).join('\n') + '\n';
    }

    /** Apply color based on unified diff line prefix. */
    private colorLine(line: string): string {
        // Truncation indicator
        if (line.startsWith('...') && line.endsWith('...')) {
            return this.chalk.dim(stripAnsi(line));
        }
        // File headers (--- a/file, +++ b/file) — dim.
        // Match without trailing space to handle any format variation.
        // Must check before single-char + / - checks.
        if (line.startsWith('---') || line.startsWith('+++')) {
            return this.chalk.dim(stripAnsi(line));
        }
        // Hunk header — cyan
        if (line.startsWith('@@')) {
            return this.chalk.cyan(stripAnsi(line));
        }
        // Index / separator lines from createTwoFilesPatch
        if (line.startsWith('Index:') || line.startsWith('=====')) {
            return this.chalk.dim(stripAnsi(line));
        }
        // Addition — green
        if (line.startsWith('+')) {
            return this.chalk.green(`+${stripAnsi(line.slice(1))}`);
        }
        // Removal — red
        if (line.startsWith('-')) {
            return this.chalk.red(`-${stripAnsi(line.slice(1))}`);
        }
        // Context lines (space prefix) and "\ No newline at end of file" — dim to visually recede
        return this.chalk.dim(stripAnsi(line));
    }
}

/** Truncate diff lines if total exceeds MAX_DIFF_LINES. */
function truncate(lines: string[]): string[] {
    if (lines.length <= MAX_DIFF_LINES) return lines;
    const omitted = lines.length - SHOW_HEAD - SHOW_TAIL;
    return [
        ...lines.slice(0, SHOW_HEAD),
        `... ${omitted} lines omitted ...`,
        ...lines.slice(lines.length - SHOW_TAIL),
    ];
}

function colorDepthToChalkLevel(depth: 0 | 4 | 8 | 24): 0 | 1 | 2 | 3 {
    switch (depth) {
        case 0: return 0;
        case 4: return 1;
        case 8: return 2;
        case 24: return 3;
    }
}
