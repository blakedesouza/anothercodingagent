import { Chalk } from 'chalk';
import type { OutputChannel } from './output-channel.js';
import { stripAnsi } from './output-channel.js';
import type { TerminalCapabilities } from './terminal-capabilities.js';

/**
 * Tool categories for color-coded status display.
 * file=blue, shell=yellow, web=magenta, lsp=cyan, delegation=green.
 */
export type ToolCategory = 'file' | 'shell' | 'web' | 'lsp' | 'delegation';

const TOOL_CATEGORY_MAP: Record<string, ToolCategory> = {
    read_file: 'file',
    write_file: 'file',
    edit_file: 'file',
    delete_path: 'file',
    move_path: 'file',
    make_directory: 'file',
    stat_path: 'file',
    find_paths: 'file',
    search_text: 'file',
    exec_command: 'shell',
    open_session: 'shell',
    session_io: 'shell',
    close_session: 'shell',
    web_fetch: 'web',
    web_search: 'web',
    lsp_query: 'lsp',
    spawn_agent: 'delegation',
    message_agent: 'delegation',
};

type ChalkColor = 'blue' | 'yellow' | 'magenta' | 'cyan' | 'green';

const CATEGORY_COLORS: Record<ToolCategory, ChalkColor> = {
    file: 'blue',
    shell: 'yellow',
    web: 'magenta',
    lsp: 'cyan',
    delegation: 'green',
};

/** Classify a tool name into its display category. Unknown tools default to 'file'. */
export function classifyTool(toolName: string): ToolCategory {
    return TOOL_CATEGORY_MAP[toolName] ?? 'file';
}

export interface ToolStartInfo {
    toolName: string;
    args?: string;
    category?: ToolCategory;
}

export interface ToolCompleteInfo {
    toolName: string;
    result: string;
    category?: ToolCategory;
    durationMs: number;
    success: boolean;
    detail?: string;
}

export interface ErrorInfo {
    code: string;
    message: string;
    detail?: string;
}

export interface StartupInfo {
    version: string;
    model: string;
    provider: string;
    workspace: string;
}

export interface RendererOptions {
    output: OutputChannel;
    verbose?: boolean;
    /** Injectable clock for testing. */
    now?: () => Date;
}

/**
 * Centralized renderer for all terminal output.
 * All ANSI escape codes are generated here — no other module writes them directly.
 * Adapts to terminal capabilities: TTY/non-TTY, color depth, unicode support.
 */
export class Renderer {
    private readonly output: OutputChannel;
    private readonly caps: TerminalCapabilities;
    private readonly chalk: InstanceType<typeof Chalk>;
    private readonly verbose: boolean;
    private readonly now: () => Date;

    constructor(options: RendererOptions) {
        this.output = options.output;
        this.caps = options.output.getCapabilities();
        this.verbose = options.verbose ?? false;
        this.now = options.now ?? (() => new Date());
        this.chalk = new Chalk({ level: colorDepthToChalkLevel(this.caps.stderr.colorDepth) });
    }

    /** Render tool start: `▶ tool_name args` */
    toolStart(info: ToolStartInfo): void {
        const category = info.category ?? classifyTool(info.toolName);
        const color = CATEGORY_COLORS[category];
        const icon = this.icon('\u25b6', '>');
        const name = this.chalk[color](info.toolName);
        const args = info.args ? ` ${stripAnsi(info.args)}` : '';
        this.output.stderr(`${this.timestamp()}${icon} ${name}${args}\n`);
    }

    /** Render tool completion: `✓ tool_name → result (time)` or `✗ tool_name failed (time)` */
    toolComplete(info: ToolCompleteInfo): void {
        const category = info.category ?? classifyTool(info.toolName);
        const color = CATEGORY_COLORS[category];
        const duration = formatDuration(info.durationMs);
        const name = this.chalk[color](info.toolName);
        const prefix = this.timestamp();
        const arrow = this.icon('\u2192', '->');

        if (info.success) {
            const icon = this.chalk.green(this.icon('\u2713', '[OK]'));
            this.output.stderr(`${prefix}${icon} ${name} ${arrow} ${stripAnsi(info.result)} (${duration})\n`);
        } else {
            const icon = this.chalk.red(this.icon('\u2717', '[FAIL]'));
            this.output.stderr(`${prefix}${icon} ${name} failed (${duration})\n`);
        }

        if (this.verbose && info.detail) {
            const lines = stripAnsi(info.detail).split('\n').map(line => `  ${line}\n`);
            this.output.stderr(lines.join(''));
        }
    }

    /** Render error: `! [error.code] message` with optional detail */
    error(info: ErrorInfo): void {
        const icon = this.chalk.red('!');
        const prefix = this.timestamp();
        this.output.stderr(`${prefix}${icon} [${stripAnsi(info.code)}] ${stripAnsi(info.message)}\n`);

        if (info.detail) {
            const lines = stripAnsi(info.detail).split('\n').map(line => `  ${this.chalk.red(line)}\n`);
            this.output.stderr(lines.join(''));
        }
    }

    /** Render startup status block on stderr. */
    startup(info: StartupInfo): void {
        const prefix = this.timestamp();
        const divider = this.caps.unicode ? '\u2500'.repeat(40) : '-'.repeat(40);
        this.output.stderr(`${prefix}${this.chalk.bold('ACA')} v${info.version}\n`);
        this.output.stderr(`${prefix}${this.chalk.dim(divider)}\n`);
        this.output.stderr(`${prefix}  Model:     ${info.model}\n`);
        this.output.stderr(`${prefix}  Provider:  ${info.provider}\n`);
        this.output.stderr(`${prefix}  Workspace: ${info.workspace}\n`);
        this.output.stderr(`${prefix}${this.chalk.dim(divider)}\n`);
    }

    /** Select unicode or ASCII icon based on terminal capabilities. */
    private icon(unicode: string, ascii: string): string {
        return this.caps.unicode ? unicode : ascii;
    }

    /** Return timestamp prefix for non-TTY output, empty string for TTY. */
    private timestamp(): string {
        if (this.caps.stderr.isTTY) return '';
        const d = this.now();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `[${hh}:${mm}:${ss}] `;
    }
}

/** Map our colorDepth (0|4|8|24) to chalk level (0|1|2|3). */
function colorDepthToChalkLevel(depth: 0 | 4 | 8 | 24): 0 | 1 | 2 | 3 {
    switch (depth) {
        case 0: return 0;
        case 4: return 1;
        case 8: return 2;
        case 24: return 3;
    }
}

/** Format milliseconds as human-readable duration. */
function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '0ms';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}
