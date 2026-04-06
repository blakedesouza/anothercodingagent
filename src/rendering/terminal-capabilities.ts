/**
 * Per-stream terminal capabilities.
 * Each of stdout/stderr gets its own detection since they may differ
 * (e.g., stdout piped to file while stderr is a TTY).
 */
export interface StreamCapabilities {
    isTTY: boolean;
    colorDepth: 0 | 4 | 8 | 24;
    columns: number;
}

/**
 * Full terminal capabilities, frozen at startup.
 * Combines per-stream detection with shared terminal properties.
 */
export interface TerminalCapabilities {
    stdout: StreamCapabilities;
    stderr: StreamCapabilities;
    rows: number;
    unicode: boolean;
}

export interface DetectOptions {
    env?: Record<string, string | undefined>;
    stdoutStream?: NodeJS.WriteStream;
    stderrStream?: NodeJS.WriteStream;
}

/**
 * Detect color depth for a stream, respecting NO_COLOR and FORCE_COLOR env vars.
 *
 * Priority:
 * 1. NO_COLOR (any value) → 0
 * 2. FORCE_COLOR (any value) → at least 4, or actual depth if TTY
 * 3. Non-TTY without FORCE_COLOR → 0
 * 4. TTY → detect from COLORTERM, TERM env vars
 */
function detectColorDepth(
    stream: NodeJS.WriteStream | undefined,
    env: Record<string, string | undefined>,
): 0 | 4 | 8 | 24 {
    // NO_COLOR takes highest priority (https://no-color.org/)
    if (env.NO_COLOR !== undefined) return 0;

    const isTTY = stream?.isTTY ?? false;

    // FORCE_COLOR is an absolute override (matches supports-color/chalk convention)
    if (env.FORCE_COLOR !== undefined) {
        const level = parseInt(env.FORCE_COLOR, 10);
        if (level === 0) return 0;
        if (level === 2) return 8;
        if (level >= 3) return 24;
        return 4; // FORCE_COLOR=1 or FORCE_COLOR=true or any other value
    }

    // Non-TTY without FORCE_COLOR → no color
    if (!isTTY) return 0;

    return ttyColorDepth(stream!, env);
}

/** Detect color depth from TTY stream and environment. */
function ttyColorDepth(
    stream: NodeJS.WriteStream,
    env: Record<string, string | undefined>,
): 0 | 4 | 8 | 24 {
    // COLORTERM=truecolor or COLORTERM=24bit → true color
    const colorterm = env.COLORTERM?.toLowerCase();
    if (colorterm === 'truecolor' || colorterm === '24bit') return 24;

    // Check TERM for 256-color support
    const term = env.TERM?.toLowerCase() ?? '';
    if (term.includes('256color')) return 8;

    // Node's built-in getColorDepth if available
    if (typeof stream.getColorDepth === 'function') {
        const depth = stream.getColorDepth();
        if (depth >= 16777216) return 24;
        if (depth >= 256) return 8;
        if (depth >= 16) return 4;
        return 0;
    }

    // Default for TTY: basic 16-color
    return 4;
}

/** Detect unicode support from LANG/LC_ALL environment variables. */
function detectUnicode(env: Record<string, string | undefined>): boolean {
    const lcAll = env.LC_ALL ?? '';
    const lang = env.LANG ?? '';
    const combined = `${lcAll} ${lang}`.toLowerCase();
    return combined.includes('utf-8') || combined.includes('utf8');
}

/** Detect stream capabilities for a single stream. */
function detectStreamCapabilities(
    stream: NodeJS.WriteStream | undefined,
    env: Record<string, string | undefined>,
    defaultColumns: number,
): StreamCapabilities {
    const isTTY = stream?.isTTY ?? false;
    return {
        isTTY,
        colorDepth: detectColorDepth(stream, env),
        columns: stream?.columns ?? defaultColumns,
    };
}

/**
 * Detect terminal capabilities. Called once at startup and frozen.
 *
 * Per-stream detection: stdout and stderr each get their own isTTY,
 * colorDepth, and columns. Shared: rows and unicode.
 */
export function detectCapabilities(options?: DetectOptions): TerminalCapabilities {
    const env = options?.env ?? process.env;
    const stdoutStream = options?.stdoutStream ?? (process.stdout as NodeJS.WriteStream);
    const stderrStream = options?.stderrStream ?? (process.stderr as NodeJS.WriteStream);
    const defaultColumns = 80;

    const stdout = detectStreamCapabilities(stdoutStream, env, defaultColumns);
    const stderr = detectStreamCapabilities(stderrStream, env, defaultColumns);

    const rows = stderrStream?.rows ?? stdoutStream?.rows ?? 24;
    const unicode = detectUnicode(env);

    return Object.freeze({
        stdout: Object.freeze(stdout),
        stderr: Object.freeze(stderr),
        rows,
        unicode,
    });
}
