import type { TerminalCapabilities, StreamCapabilities } from './terminal-capabilities.js';

/**
 * Invocation mode determines output routing behavior.
 * - interactive: REPL session, human at the terminal
 * - one-shot: single task, same output rules as interactive
 * - executor: structured JSON only, stderr suppressed
 */
export type OutputMode = 'interactive' | 'one-shot' | 'executor';

export interface OutputChannelOptions {
    capabilities: TerminalCapabilities;
    mode: OutputMode;
    stdoutStream?: NodeJS.WritableStream;
    stderrStream?: NodeJS.WritableStream;
}

/**
 * Centralized output channel enforcing stdout/stderr split per Block 18 / Block 10.
 *
 * - stdout: assistant content (text responses, code) in interactive/one-shot; structured JSON in executor
 * - stderr: all human-facing chrome — prompts, status, progress, tool indicators, errors, diagnostics
 * - Executor mode: stderr fully suppressed (reserved for catastrophic failures only)
 * - Non-TTY: no ANSI codes unless FORCE_COLOR overrides
 */
export class OutputChannel {
    private readonly stdoutStream: NodeJS.WritableStream;
    private readonly stderrStream: NodeJS.WritableStream;
    private readonly mode: OutputMode;
    private readonly caps: TerminalCapabilities;

    constructor(options: OutputChannelOptions) {
        this.stdoutStream = options.stdoutStream ?? process.stdout;
        this.stderrStream = options.stderrStream ?? process.stderr;
        this.mode = options.mode;
        this.caps = options.capabilities;
    }

    /** Write assistant content to stdout. In all modes this is the content channel. */
    stdout(text: string): void {
        const output = this.shouldStripAnsi(this.caps.stdout) ? stripAnsi(text) : text;
        this.stdoutStream.write(output);
    }

    /**
     * Write human-facing chrome to stderr.
     * Suppressed entirely in executor mode (except catastrophic failures).
     */
    stderr(text: string): void {
        if (this.mode === 'executor') return;
        const output = this.shouldStripAnsi(this.caps.stderr) ? stripAnsi(text) : text;
        this.stderrStream.write(output);
    }

    /**
     * Write catastrophic failure to stderr. Always writes, even in executor mode.
     * ANSI stripping still applies based on stderr capabilities.
     */
    stderrFatal(text: string): void {
        const output = this.shouldStripAnsi(this.caps.stderr) ? stripAnsi(text) : text;
        this.stderrStream.write(output);
    }

    /** Returns true if running in executor mode. */
    isExecutor(): boolean {
        return this.mode === 'executor';
    }

    /** Returns true if the given stream is a TTY. */
    isTTY(stream: 'stdout' | 'stderr'): boolean {
        return this.caps[stream].isTTY;
    }

    /** Get the current output mode. */
    getMode(): OutputMode {
        return this.mode;
    }

    /** Get the underlying terminal capabilities. */
    getCapabilities(): TerminalCapabilities {
        return this.caps;
    }

    /** Whether ANSI codes should be stripped for the given stream capabilities. */
    private shouldStripAnsi(stream: StreamCapabilities): boolean {
        return stream.colorDepth === 0;
    }
}

// ANSI escape code stripper
// Covers:
//   CSI sequences (including private modes, colon-separated params e.g. \x1b[38:5:196m)
//   OSC sequences (BEL or ST terminated)
//   2-character escape sequences (e.g., ESC c = terminal reset, ESC M = reverse index)
const ANSI_REGEX = /\x1b\[[0-9;?:]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[A-Za-z]/g;

export function stripAnsi(text: string): string {
    return text.replace(ANSI_REGEX, '');
}
