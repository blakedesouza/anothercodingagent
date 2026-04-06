import { describe, it, expect } from 'vitest';
import { Renderer, classifyTool } from '../../src/rendering/renderer.js';
import type { ToolCategory } from '../../src/rendering/renderer.js';
import { OutputChannel } from '../../src/rendering/output-channel.js';
import type { TerminalCapabilities } from '../../src/rendering/terminal-capabilities.js';
import { PassThrough } from 'node:stream';

function captureStream(): { stream: PassThrough; output: () => string } {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    return {
        stream,
        output: () => Buffer.concat(chunks).toString('utf-8'),
    };
}

function makeCapabilities(overrides: Partial<{
    stdoutTTY: boolean;
    stderrTTY: boolean;
    stdoutColor: 0 | 4 | 8 | 24;
    stderrColor: 0 | 4 | 8 | 24;
    unicode: boolean;
}>): TerminalCapabilities {
    return {
        stdout: {
            isTTY: overrides.stdoutTTY ?? true,
            colorDepth: overrides.stdoutColor ?? 24,
            columns: 80,
        },
        stderr: {
            isTTY: overrides.stderrTTY ?? true,
            colorDepth: overrides.stderrColor ?? 24,
            columns: 80,
        },
        rows: 24,
        unicode: overrides.unicode ?? true,
    };
}

function createRenderer(
    opts: {
        stderrTTY?: boolean;
        stderrColor?: 0 | 4 | 8 | 24;
        unicode?: boolean;
        verbose?: boolean;
        now?: () => Date;
    } = {},
): { renderer: Renderer; stderr: () => string; stdout: () => string } {
    const out = captureStream();
    const err = captureStream();
    const caps = makeCapabilities({
        stderrTTY: opts.stderrTTY ?? true,
        stderrColor: opts.stderrColor ?? 24,
        unicode: opts.unicode ?? true,
    });
    const output = new OutputChannel({
        capabilities: caps,
        mode: 'interactive',
        stdoutStream: out.stream,
        stderrStream: err.stream,
    });
    const renderer = new Renderer({
        output,
        verbose: opts.verbose,
        now: opts.now,
    });
    return { renderer, stderr: err.output, stdout: out.output };
}

const FIXED_DATE = new Date(2026, 3, 2, 14, 30, 45); // 2026-04-02 14:30:45
const fixedNow = (): Date => FIXED_DATE;

// ANSI escape code detector
const ANSI_REGEX = /\x1b\[[0-9;?]*[@-~]/;
function hasAnsi(text: string): boolean {
    return ANSI_REGEX.test(text);
}

describe('Renderer', () => {
    describe('classifyTool', () => {
        it('classifies file tools', () => {
            expect(classifyTool('read_file')).toBe('file');
            expect(classifyTool('write_file')).toBe('file');
            expect(classifyTool('edit_file')).toBe('file');
        });

        it('classifies shell tools', () => {
            expect(classifyTool('exec_command')).toBe('shell');
            expect(classifyTool('open_session')).toBe('shell');
        });

        it('classifies web tools', () => {
            expect(classifyTool('web_fetch')).toBe('web');
            expect(classifyTool('web_search')).toBe('web');
        });

        it('classifies LSP tools', () => {
            expect(classifyTool('lsp_query')).toBe('lsp');
        });

        it('classifies delegation tools', () => {
            expect(classifyTool('spawn_agent')).toBe('delegation');
            expect(classifyTool('message_agent')).toBe('delegation');
        });

        it('defaults unknown tools to file', () => {
            expect(classifyTool('unknown_tool')).toBe('file');
        });
    });

    describe('tool category colors (parameterized)', () => {
        const cases: Array<{ toolName: string; category: ToolCategory; ansiCode: string; label: string }> = [
            { toolName: 'read_file', category: 'file', ansiCode: '\x1b[34m', label: 'file tools → blue' },
            { toolName: 'exec_command', category: 'shell', ansiCode: '\x1b[33m', label: 'shell tools → yellow' },
            { toolName: 'web_fetch', category: 'web', ansiCode: '\x1b[35m', label: 'web tools → magenta' },
            { toolName: 'lsp_query', category: 'lsp', ansiCode: '\x1b[36m', label: 'LSP tools → cyan' },
            { toolName: 'spawn_agent', category: 'delegation', ansiCode: '\x1b[32m', label: 'delegation tools → green' },
            { toolName: 'read_file', category: 'file', ansiCode: '\x1b[31m', label: 'error display → red (on failure)' },
        ];

        for (const { toolName, ansiCode, label } of cases) {
            it(label, () => {
                const { renderer, stderr } = createRenderer();

                if (label.includes('error display')) {
                    // Error case: toolComplete with success=false produces red icon
                    renderer.toolComplete({
                        toolName,
                        result: '',
                        durationMs: 100,
                        success: false,
                    });
                    expect(stderr()).toContain(ansiCode); // red for failure icon
                } else {
                    renderer.toolComplete({
                        toolName,
                        result: '234 lines',
                        durationMs: 100,
                        success: true,
                    });
                    expect(stderr()).toContain(ansiCode); // category color for tool name
                }
            });
        }
    });

    describe('toolStart', () => {
        it('renders start icon and tool name', () => {
            const { renderer, stderr } = createRenderer();
            renderer.toolStart({ toolName: 'read_file', args: 'src/config.ts' });
            const output = stderr();
            expect(output).toContain('\u25b6'); // ▶
            expect(output).toContain('read_file');
            expect(output).toContain('src/config.ts');
        });

        it('renders without args when none provided', () => {
            const { renderer, stderr } = createRenderer();
            renderer.toolStart({ toolName: 'read_file' });
            const output = stderr();
            expect(output).toContain('read_file');
            // Tool name is followed by ANSI reset code then newline (no trailing args)
            expect(output).not.toContain(' src/');
            expect(output).toContain('read_file');
        });

        it('uses explicit category over auto-classification', () => {
            const { renderer, stderr } = createRenderer();
            // read_file would auto-classify as file (blue), but override to shell (yellow)
            renderer.toolStart({ toolName: 'read_file', category: 'shell' });
            expect(stderr()).toContain('\x1b[33m'); // yellow
        });
    });

    describe('toolComplete', () => {
        it('renders success with checkmark, tool name, result, and duration', () => {
            const { renderer, stderr } = createRenderer();
            renderer.toolComplete({
                toolName: 'read_file',
                result: '234 lines',
                durationMs: 100,
                success: true,
            });
            const output = stderr();
            expect(output).toContain('\u2713'); // ✓
            expect(output).toContain('read_file');
            expect(output).toContain('234 lines');
            expect(output).toContain('100ms');
        });

        it('renders failure with cross, tool name, and duration', () => {
            const { renderer, stderr } = createRenderer();
            renderer.toolComplete({
                toolName: 'exec_command',
                result: '',
                durationMs: 3100,
                success: false,
            });
            const output = stderr();
            expect(output).toContain('\u2717'); // ✗
            expect(output).toContain('exec_command');
            expect(output).toContain('failed');
            expect(output).toContain('3.1s');
        });

        it('formats duration as milliseconds when < 1s', () => {
            const { renderer, stderr } = createRenderer();
            renderer.toolComplete({
                toolName: 'read_file',
                result: 'ok',
                durationMs: 42,
                success: true,
            });
            expect(stderr()).toContain('42ms');
        });

        it('formats duration as seconds when >= 1s', () => {
            const { renderer, stderr } = createRenderer();
            renderer.toolComplete({
                toolName: 'read_file',
                result: 'ok',
                durationMs: 14200,
                success: true,
            });
            expect(stderr()).toContain('14.2s');
        });
    });

    describe('error formatting', () => {
        it('renders with ! prefix and error code', () => {
            const { renderer, stderr } = createRenderer();
            renderer.error({ code: 'ENOENT', message: 'File not found' });
            const output = stderr();
            expect(output).toContain('!');
            expect(output).toContain('[ENOENT]');
            expect(output).toContain('File not found');
        });

        it('renders detail lines when provided', () => {
            const { renderer, stderr } = createRenderer();
            renderer.error({
                code: 'EPERM',
                message: 'Permission denied',
                detail: 'Cannot write to /etc/hosts\nCheck permissions',
            });
            const output = stderr();
            expect(output).toContain('[EPERM]');
            expect(output).toContain('Cannot write to /etc/hosts');
            expect(output).toContain('Check permissions');
        });

        it('uses red ANSI for error display', () => {
            const { renderer, stderr } = createRenderer();
            renderer.error({ code: 'ERR', message: 'Something broke' });
            expect(stderr()).toContain('\x1b[31m'); // red
        });
    });

    describe('non-TTY fallback', () => {
        it('produces no ANSI escape codes when no color', () => {
            const { renderer, stderr } = createRenderer({
                stderrTTY: false,
                stderrColor: 0,
                now: fixedNow,
            });

            renderer.toolStart({ toolName: 'read_file', args: 'src/config.ts' });
            renderer.toolComplete({
                toolName: 'read_file',
                result: '234 lines',
                durationMs: 100,
                success: true,
            });
            renderer.error({ code: 'ENOENT', message: 'File not found' });

            const output = stderr();
            expect(hasAnsi(output)).toBe(false);
        });

        it('includes timestamps when non-TTY', () => {
            const { renderer, stderr } = createRenderer({
                stderrTTY: false,
                stderrColor: 0,
                now: fixedNow,
            });

            renderer.toolStart({ toolName: 'read_file' });
            expect(stderr()).toContain('[14:30:45]');
        });

        it('omits timestamps when TTY', () => {
            const { renderer, stderr } = createRenderer({
                stderrTTY: true,
                now: fixedNow,
            });

            renderer.toolStart({ toolName: 'read_file' });
            expect(stderr()).not.toContain('[14:30:45]');
        });

        it('restores colors with FORCE_COLOR (non-TTY + colorDepth > 0)', () => {
            const { renderer, stderr } = createRenderer({
                stderrTTY: false,
                stderrColor: 4, // FORCE_COLOR scenario
                now: fixedNow,
            });

            renderer.toolStart({ toolName: 'read_file' });
            const output = stderr();
            // Has color (blue for file tools)
            expect(output).toContain('\x1b[34m');
            // Has timestamp (non-TTY)
            expect(output).toContain('[14:30:45]');
        });
    });

    describe('verbose mode', () => {
        it('shows detail lines when verbose and detail provided', () => {
            const { renderer, stderr } = createRenderer({ verbose: true });
            renderer.toolComplete({
                toolName: 'exec_command',
                result: 'exit 0',
                durationMs: 500,
                success: true,
                detail: 'cwd: /home/user\ntimeout: 30s',
            });
            const output = stderr();
            expect(output).toContain('cwd: /home/user');
            expect(output).toContain('timeout: 30s');
        });

        it('omits detail lines when not verbose', () => {
            const { renderer, stderr } = createRenderer({ verbose: false });
            renderer.toolComplete({
                toolName: 'exec_command',
                result: 'exit 0',
                durationMs: 500,
                success: true,
                detail: 'cwd: /home/user',
            });
            expect(stderr()).not.toContain('cwd: /home/user');
        });

        it('omits detail lines when verbose but no detail', () => {
            const { renderer, stderr } = createRenderer({ verbose: true });
            renderer.toolComplete({
                toolName: 'exec_command',
                result: 'exit 0',
                durationMs: 500,
                success: true,
            });
            // Only the status line, no extra detail lines
            const lines = stderr().trim().split('\n');
            expect(lines).toHaveLength(1);
        });
    });

    describe('unicode=false ASCII fallbacks', () => {
        it('uses > instead of ▶ for tool start', () => {
            const { renderer, stderr } = createRenderer({ unicode: false });
            renderer.toolStart({ toolName: 'read_file' });
            const output = stderr();
            expect(output).toContain('>');
            expect(output).not.toContain('\u25b6');
        });

        it('uses [OK] instead of ✓ for success', () => {
            const { renderer, stderr } = createRenderer({ unicode: false });
            renderer.toolComplete({
                toolName: 'read_file',
                result: 'ok',
                durationMs: 100,
                success: true,
            });
            const output = stderr();
            expect(output).toContain('[OK]');
            expect(output).not.toContain('\u2713');
        });

        it('uses [FAIL] instead of ✗ for failure', () => {
            const { renderer, stderr } = createRenderer({ unicode: false });
            renderer.toolComplete({
                toolName: 'read_file',
                result: '',
                durationMs: 100,
                success: false,
            });
            const output = stderr();
            expect(output).toContain('[FAIL]');
            expect(output).not.toContain('\u2717');
        });

        it('uses ASCII dividers in startup block', () => {
            const { renderer, stderr } = createRenderer({ unicode: false });
            renderer.startup({
                version: '0.1.0',
                model: 'test-model',
                provider: 'nanogpt',
                workspace: '/home/user/project',
            });
            const output = stderr();
            expect(output).toContain('----------');
            expect(output).not.toContain('\u2500');
        });
    });

    describe('startup', () => {
        it('renders startup status block on stderr', () => {
            const { renderer, stderr } = createRenderer();
            renderer.startup({
                version: '0.1.0',
                model: 'gpt-4o',
                provider: 'nanogpt',
                workspace: '/home/user/project',
            });
            const output = stderr();
            expect(output).toContain('ACA');
            expect(output).toContain('v0.1.0');
            expect(output).toContain('gpt-4o');
            expect(output).toContain('nanogpt');
            expect(output).toContain('/home/user/project');
        });

        it('renders with timestamps when non-TTY', () => {
            const { renderer, stderr } = createRenderer({
                stderrTTY: false,
                stderrColor: 0,
                now: fixedNow,
            });
            renderer.startup({
                version: '0.1.0',
                model: 'test',
                provider: 'test',
                workspace: '/tmp',
            });
            const output = stderr();
            expect(output).toContain('[14:30:45]');
            expect(hasAnsi(output)).toBe(false);
        });
    });

    describe('ANSI sanitization', () => {
        it('strips ANSI from tool args', () => {
            const { renderer, stderr } = createRenderer();
            renderer.toolStart({ toolName: 'read_file', args: '\x1b[2Jmalicious' });
            const output = stderr();
            expect(output).toContain('malicious');
            expect(output).not.toContain('\x1b[2J');
        });

        it('strips ANSI from tool result', () => {
            const { renderer, stderr } = createRenderer();
            renderer.toolComplete({
                toolName: 'read_file',
                result: '\x1b[31mfake red\x1b[0m',
                durationMs: 100,
                success: true,
            });
            const output = stderr();
            expect(output).toContain('fake red');
            // Only chalk-generated ANSI (blue for tool name, green for icon) should remain
            expect(output).not.toContain('\x1b[31mfake red');
        });

        it('strips ANSI from error message and detail', () => {
            const { renderer, stderr } = createRenderer();
            renderer.error({
                code: '\x1b[35mEVIL\x1b[0m',
                message: '\x1b[2Jclear screen',
                detail: '\x1b[Aup cursor',
            });
            const output = stderr();
            expect(output).toContain('EVIL');
            expect(output).toContain('clear screen');
            expect(output).toContain('up cursor');
            expect(output).not.toContain('\x1b[2J');
            expect(output).not.toContain('\x1b[A');
        });

        it('strips ANSI from verbose detail', () => {
            const { renderer, stderr } = createRenderer({ verbose: true });
            renderer.toolComplete({
                toolName: 'exec_command',
                result: 'exit 0',
                durationMs: 500,
                success: true,
                detail: '\x1b[31mred detail\x1b[0m',
            });
            const output = stderr();
            expect(output).toContain('red detail');
            expect(output).not.toContain('\x1b[31mred detail');
        });
    });

    describe('arrow ASCII fallback', () => {
        it('uses -> instead of → when unicode=false', () => {
            const { renderer, stderr } = createRenderer({ unicode: false });
            renderer.toolComplete({
                toolName: 'read_file',
                result: 'ok',
                durationMs: 100,
                success: true,
            });
            const output = stderr();
            expect(output).toContain('->');
            expect(output).not.toContain('\u2192');
        });

        it('uses → when unicode=true', () => {
            const { renderer, stderr } = createRenderer({ unicode: true });
            renderer.toolComplete({
                toolName: 'read_file',
                result: 'ok',
                durationMs: 100,
                success: true,
            });
            expect(stderr()).toContain('\u2192');
        });
    });

    describe('formatDuration edge cases', () => {
        it('handles negative duration', () => {
            const { renderer, stderr } = createRenderer();
            renderer.toolComplete({
                toolName: 'read_file',
                result: 'ok',
                durationMs: -500,
                success: true,
            });
            expect(stderr()).toContain('0ms');
            expect(stderr()).not.toContain('-500ms');
        });

        it('handles zero duration', () => {
            const { renderer, stderr } = createRenderer();
            renderer.toolComplete({
                toolName: 'read_file',
                result: 'ok',
                durationMs: 0,
                success: true,
            });
            expect(stderr()).toContain('0ms');
        });

        it('handles NaN duration', () => {
            const { renderer, stderr } = createRenderer();
            renderer.toolComplete({
                toolName: 'read_file',
                result: 'ok',
                durationMs: NaN,
                success: true,
            });
            expect(stderr()).toContain('0ms');
            expect(stderr()).not.toContain('NaN');
        });

        it('handles Infinity duration', () => {
            const { renderer, stderr } = createRenderer();
            renderer.toolComplete({
                toolName: 'read_file',
                result: 'ok',
                durationMs: Infinity,
                success: true,
            });
            expect(stderr()).toContain('0ms');
            expect(stderr()).not.toContain('Infinity');
        });
    });
});
