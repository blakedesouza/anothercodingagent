import { Chalk } from 'chalk';
import { stripAnsi } from './output-channel.js';
import type { OutputChannel } from './output-channel.js';
import type { TerminalCapabilities } from './terminal-capabilities.js';

/** Braille spinner frames for unicode terminals. */
export const BRAILLE_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** ASCII spinner frames for non-unicode terminals. */
export const ASCII_FRAMES: readonly string[] = ['|', '/', '-', '\\'];

const SPINNER_DELAY_MS = 1000;
const SPINNER_INTERVAL_MS = 80;
const STATUS_INTERVAL_MS = 250;
const BAR_WIDTH = 20;

export interface ProgressOptions {
    output: OutputChannel;
    /** Injectable millisecond clock for testing elapsed time. Defaults to Date.now(). */
    now?: () => number;
}

function colorDepthToChalkLevel(depth: 0 | 4 | 8 | 24): 0 | 1 | 2 | 3 {
    switch (depth) {
        case 0: return 0;
        case 4: return 1;
        case 8: return 2;
        case 24: return 3;
    }
}

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '0ms';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function timestampPrefix(ms: number): string {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `[${hh}:${mm}:${ss}] `;
}

/**
 * Strip ANSI codes, newlines, and C0 control characters from a label.
 *
 * Prevents display corruption from characters that interfere with \r in-place
 * overwrites: \x07 (bell) causes audible beep on every spinner tick;
 * \x08 (backspace) corrupts the \r overwrite by deleting spinner frame characters.
 */
function sanitizeLabel(s: string): string {
    return stripAnsi(s)
        .replace(/[\r\n]+/g, ' ')
        // Strip C0 control characters (0x00-0x1F) except space/tab (0x20, 0x09),
        // and also strip DEL (0x7F). Tab is normalized to a space.
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/\t/g, ' ');
}

/**
 * Status line for LLM streaming.
 *
 * TTY: shows `Thinking... (0.0s)` with in-place \r update every 250ms.
 * Non-TTY: single static timestamp line at start, no further updates.
 */
export class StatusLine {
    private readonly output: OutputChannel;
    private readonly caps: TerminalCapabilities;
    private readonly chalk: InstanceType<typeof Chalk>;
    private readonly getNow: () => number;
    private startMs = 0;
    private interval: ReturnType<typeof setInterval> | null = null;
    private currentMessage = 'Thinking';

    constructor(options: ProgressOptions) {
        this.output = options.output;
        this.caps = options.output.getCapabilities();
        this.chalk = new Chalk({ level: colorDepthToChalkLevel(this.caps.stderr.colorDepth) });
        this.getNow = options.now ?? (() => Date.now());
    }

    /** Start showing the status line. */
    start(message = 'Thinking'): void {
        // Clear any existing interval before restarting to avoid timer leaks on double-start.
        if (this.interval !== null) {
            clearInterval(this.interval);
            this.interval = null;
        }
        this.currentMessage = sanitizeLabel(message);
        this.startMs = this.getNow();

        if (!this.caps.stderr.isTTY) {
            this.output.stderr(`${timestampPrefix(this.startMs)}${this.currentMessage}...\n`);
            return;
        }

        this.renderTTY();
        this.interval = setInterval(() => this.renderTTY(), STATUS_INTERVAL_MS);
    }

    /** Stop and clear the status line. */
    stop(): void {
        if (this.interval !== null) {
            clearInterval(this.interval);
            this.interval = null;
        }
        if (this.caps.stderr.isTTY) {
            this.output.stderr('\r\x1b[K');
        }
    }

    private renderTTY(): void {
        const elapsedMs = this.getNow() - this.startMs;
        const elapsed = (elapsedMs / 1000).toFixed(1);
        this.output.stderr(`\r${this.chalk.dim(`${this.currentMessage}... (${elapsed}s)`)}`);
    }
}

/**
 * Animated spinner for tool execution > 1s.
 *
 * After a 1s grace period, displays cycling braille (or ASCII) frames at 80ms.
 * Short operations that complete within 1s produce no TTY output.
 * On complete(): replaces spinner with a ✓ or ✗ line.
 *
 * Non-TTY: static timestamp lines at start and completion.
 */
export class Spinner {
    private readonly output: OutputChannel;
    private readonly caps: TerminalCapabilities;
    private readonly chalk: InstanceType<typeof Chalk>;
    private readonly getNow: () => number;
    private label = '';
    private startMs = 0;
    private frameIndex = 0;
    private delayTimeout: ReturnType<typeof setTimeout> | null = null;
    private tickInterval: ReturnType<typeof setInterval> | null = null;
    private spinning = false;

    constructor(options: ProgressOptions) {
        this.output = options.output;
        this.caps = options.output.getCapabilities();
        this.chalk = new Chalk({ level: colorDepthToChalkLevel(this.caps.stderr.colorDepth) });
        this.getNow = options.now ?? (() => Date.now());
    }

    /** Begin tracking a named operation. Spinner appears after 1s on TTY. */
    start(label: string): void {
        // Cancel any existing timers before restarting to prevent timer leaks on double-start.
        this.cancel();
        this.label = sanitizeLabel(label);
        this.startMs = this.getNow();
        this.frameIndex = 0;
        this.spinning = false;

        if (!this.caps.stderr.isTTY) {
            this.output.stderr(`${timestampPrefix(this.startMs)}${this.label}...\n`);
            return;
        }

        this.delayTimeout = setTimeout(() => {
            this.delayTimeout = null;
            this.spinning = true;
            this.tick();
            this.tickInterval = setInterval(() => this.tick(), SPINNER_INTERVAL_MS);
        }, SPINNER_DELAY_MS);
    }

    /** Replace spinner with a ✓ or ✗ completion line. */
    complete(success: boolean, durationMs: number): void {
        const wasSpinning = this.spinning;
        this.cancel();

        const duration = formatDuration(durationMs);

        if (this.caps.stderr.isTTY) {
            const icon = success
                ? this.chalk.green(this.caps.unicode ? '✓' : '[OK]')
                : this.chalk.red(this.caps.unicode ? '✗' : '[FAIL]');
            // Use \r to overwrite the spinner line if one was showing.
            const cr = wasSpinning ? '\r' : '';
            this.output.stderr(`${cr}${icon} ${this.label} (${duration})\n`);
        } else {
            const ts = timestampPrefix(this.getNow());
            const status = success ? 'completed' : 'failed';
            this.output.stderr(`${ts}${this.label} ${status} (${duration})\n`);
        }
    }

    /** Cancel the spinner without printing a completion line. */
    stop(): void {
        const wasSpinning = this.spinning;
        this.cancel();
        if (this.caps.stderr.isTTY && wasSpinning) {
            this.output.stderr('\r\x1b[K');
        }
    }

    private cancel(): void {
        if (this.delayTimeout !== null) {
            clearTimeout(this.delayTimeout);
            this.delayTimeout = null;
        }
        if (this.tickInterval !== null) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        }
        this.spinning = false;
    }

    private tick(): void {
        const frames = this.caps.unicode ? BRAILLE_FRAMES : ASCII_FRAMES;
        const frame = frames[this.frameIndex % frames.length] ?? '|';
        this.frameIndex++;
        const elapsed = formatDuration(this.getNow() - this.startMs);
        this.output.stderr(`\r${this.chalk.cyan(frame)} ${this.label} (${elapsed})`);
    }
}

/**
 * Progress bar for multi-file operations with a known item count.
 * Format (TTY): `[████████░░░░░░░░░░░░] 3/10 files indexed` (in-place via \r)
 * Format (non-TTY): completion line only with the final bar state.
 */
export class ProgressBar {
    private readonly output: OutputChannel;
    private readonly caps: TerminalCapabilities;
    private readonly chalk: InstanceType<typeof Chalk>;
    private total = 0;
    private current = 0;
    private label = '';
    private active = false;

    constructor(options: ProgressOptions) {
        this.output = options.output;
        this.caps = options.output.getCapabilities();
        this.chalk = new Chalk({ level: colorDepthToChalkLevel(this.caps.stderr.colorDepth) });
    }

    /** Initialize the progress bar for `total` items. */
    start(label: string, total: number): void {
        this.label = sanitizeLabel(label);
        this.total = Math.max(0, total);
        this.current = 0;
        this.active = true;
        if (this.caps.stderr.isTTY) {
            this.renderTTY();
        }
    }

    /** Update to `current` completed items. */
    update(current: number): void {
        if (!this.active) return;
        this.current = Math.min(Math.max(0, current), this.total);
        if (this.caps.stderr.isTTY) {
            this.renderTTY();
        }
    }

    /** Mark the operation complete at 100%. */
    complete(): void {
        if (!this.active) return;
        this.current = this.total;
        this.active = false;
        if (this.caps.stderr.isTTY) {
            this.renderTTY();
            this.output.stderr('\n');
        } else {
            this.output.stderr(`${this.buildBarStr()} ${this.current}/${this.total} ${this.label}\n`);
        }
    }

    private buildBarStr(): string {
        const ratio = this.total > 0 ? this.current / this.total : 0;
        const filled = Math.round(ratio * BAR_WIDTH);
        const empty = BAR_WIDTH - filled;
        const fillChar = this.caps.unicode ? '█' : '#';
        const emptyChar = this.caps.unicode ? '░' : '.';
        const bar = fillChar.repeat(filled) + emptyChar.repeat(empty);
        return `[${this.chalk.cyan(bar)}]`;
    }

    private renderTTY(): void {
        this.output.stderr(`\r${this.buildBarStr()} ${this.current}/${this.total} ${this.label}`);
    }
}
