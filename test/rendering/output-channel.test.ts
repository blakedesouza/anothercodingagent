import { describe, it, expect } from 'vitest';
import { OutputChannel, stripAnsi } from '../../src/rendering/output-channel.js';
import type { OutputMode } from '../../src/rendering/output-channel.js';
import type { TerminalCapabilities } from '../../src/rendering/terminal-capabilities.js';
import { PassThrough } from 'node:stream';

// Helper to create a writable that captures output
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

describe('OutputChannel', () => {
    describe('interactive mode', () => {
        it('writes assistant text to stdout', () => {
            const out = captureStream();
            const err = captureStream();
            const ch = new OutputChannel({
                capabilities: makeCapabilities({}),
                mode: 'interactive',
                stdoutStream: out.stream,
                stderrStream: err.stream,
            });

            ch.stdout('Hello, world!');
            expect(out.output()).toBe('Hello, world!');
            expect(err.output()).toBe('');
        });

        it('writes tool status to stderr', () => {
            const out = captureStream();
            const err = captureStream();
            const ch = new OutputChannel({
                capabilities: makeCapabilities({}),
                mode: 'interactive',
                stdoutStream: out.stream,
                stderrStream: err.stream,
            });

            ch.stderr('▶ read_file src/config.ts');
            expect(err.output()).toBe('▶ read_file src/config.ts');
            expect(out.output()).toBe('');
        });
    });

    describe('one-shot mode', () => {
        it('same split as interactive: text → stdout, chrome → stderr', () => {
            const out = captureStream();
            const err = captureStream();
            const ch = new OutputChannel({
                capabilities: makeCapabilities({}),
                mode: 'one-shot',
                stdoutStream: out.stream,
                stderrStream: err.stream,
            });

            ch.stdout('Result text');
            ch.stderr('Processing...');
            expect(out.output()).toBe('Result text');
            expect(err.output()).toBe('Processing...');
        });
    });

    describe('executor mode', () => {
        it('suppresses stderr output entirely', () => {
            const out = captureStream();
            const err = captureStream();
            const ch = new OutputChannel({
                capabilities: makeCapabilities({}),
                mode: 'executor',
                stdoutStream: out.stream,
                stderrStream: err.stream,
            });

            ch.stderr('This should not appear');
            expect(err.output()).toBe('');
        });

        it('still writes to stdout', () => {
            const out = captureStream();
            const err = captureStream();
            const ch = new OutputChannel({
                capabilities: makeCapabilities({}),
                mode: 'executor',
                stdoutStream: out.stream,
                stderrStream: err.stream,
            });

            ch.stdout('{"result": "ok"}');
            expect(out.output()).toBe('{"result": "ok"}');
        });

        it('allows fatal errors on stderr', () => {
            const out = captureStream();
            const err = captureStream();
            const ch = new OutputChannel({
                capabilities: makeCapabilities({}),
                mode: 'executor',
                stdoutStream: out.stream,
                stderrStream: err.stream,
            });

            ch.stderrFatal('FATAL: out of memory');
            expect(err.output()).toBe('FATAL: out of memory');
        });
    });

    describe('non-TTY ANSI stripping', () => {
        it('strips ANSI codes from stdout when non-TTY and no color', () => {
            const out = captureStream();
            const err = captureStream();
            const ch = new OutputChannel({
                capabilities: makeCapabilities({ stdoutTTY: false, stdoutColor: 0 }),
                mode: 'interactive',
                stdoutStream: out.stream,
                stderrStream: err.stream,
            });

            ch.stdout('\x1b[34mblue text\x1b[0m');
            expect(out.output()).toBe('blue text');
        });

        it('strips ANSI codes from stderr when non-TTY and no color', () => {
            const out = captureStream();
            const err = captureStream();
            const ch = new OutputChannel({
                capabilities: makeCapabilities({ stderrTTY: false, stderrColor: 0 }),
                mode: 'interactive',
                stdoutStream: out.stream,
                stderrStream: err.stream,
            });

            ch.stderr('\x1b[31merror\x1b[0m');
            expect(err.output()).toBe('error');
        });

        it('strips ANSI on TTY with NO_COLOR (colorDepth=0)', () => {
            const out = captureStream();
            const err = captureStream();
            // NO_COLOR on TTY: colorDepth=0 but isTTY=true
            const ch = new OutputChannel({
                capabilities: makeCapabilities({ stdoutTTY: true, stdoutColor: 0 }),
                mode: 'interactive',
                stdoutStream: out.stream,
                stderrStream: err.stream,
            });

            ch.stdout('\x1b[34mblue text\x1b[0m');
            expect(out.output()).toBe('blue text');
        });

        it('preserves ANSI codes on TTY stdout', () => {
            const out = captureStream();
            const err = captureStream();
            const ch = new OutputChannel({
                capabilities: makeCapabilities({ stdoutTTY: true, stdoutColor: 24 }),
                mode: 'interactive',
                stdoutStream: out.stream,
                stderrStream: err.stream,
            });

            const ansiText = '\x1b[34mblue text\x1b[0m';
            ch.stdout(ansiText);
            expect(out.output()).toBe(ansiText);
        });

        it('preserves ANSI when FORCE_COLOR is active (non-TTY with color)', () => {
            const out = captureStream();
            const err = captureStream();
            // FORCE_COLOR scenario: non-TTY but colorDepth > 0
            const ch = new OutputChannel({
                capabilities: makeCapabilities({ stdoutTTY: false, stdoutColor: 4 }),
                mode: 'interactive',
                stdoutStream: out.stream,
                stderrStream: err.stream,
            });

            const ansiText = '\x1b[34mblue text\x1b[0m';
            ch.stdout(ansiText);
            expect(out.output()).toBe(ansiText);
        });
    });

    describe('piped stdout with TTY stderr', () => {
        it('strips ANSI from stdout but preserves on stderr', () => {
            const out = captureStream();
            const err = captureStream();
            const ch = new OutputChannel({
                capabilities: makeCapabilities({
                    stdoutTTY: false,
                    stdoutColor: 0,
                    stderrTTY: true,
                    stderrColor: 24,
                }),
                mode: 'interactive',
                stdoutStream: out.stream,
                stderrStream: err.stream,
            });

            ch.stdout('\x1b[34mclean\x1b[0m');
            ch.stderr('\x1b[31mcolored\x1b[0m');
            expect(out.output()).toBe('clean');
            expect(err.output()).toBe('\x1b[31mcolored\x1b[0m');
        });
    });

    describe('isExecutor', () => {
        it('returns true for executor mode', () => {
            const ch = new OutputChannel({
                capabilities: makeCapabilities({}),
                mode: 'executor',
            });
            expect(ch.isExecutor()).toBe(true);
        });

        it('returns false for interactive mode', () => {
            const ch = new OutputChannel({
                capabilities: makeCapabilities({}),
                mode: 'interactive',
            });
            expect(ch.isExecutor()).toBe(false);
        });

        it('returns false for one-shot mode', () => {
            const ch = new OutputChannel({
                capabilities: makeCapabilities({}),
                mode: 'one-shot',
            });
            expect(ch.isExecutor()).toBe(false);
        });
    });

    describe('isTTY', () => {
        it('returns per-stream TTY status', () => {
            const ch = new OutputChannel({
                capabilities: makeCapabilities({ stdoutTTY: false, stderrTTY: true }),
                mode: 'interactive',
            });
            expect(ch.isTTY('stdout')).toBe(false);
            expect(ch.isTTY('stderr')).toBe(true);
        });
    });

    describe('getMode', () => {
        const modes: OutputMode[] = ['interactive', 'one-shot', 'executor'];
        for (const mode of modes) {
            it(`returns '${mode}'`, () => {
                const ch = new OutputChannel({
                    capabilities: makeCapabilities({}),
                    mode,
                });
                expect(ch.getMode()).toBe(mode);
            });
        }
    });
});

describe('stripAnsi', () => {
    it('strips CSI color codes', () => {
        expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    });

    it('strips multiple ANSI sequences', () => {
        expect(stripAnsi('\x1b[1m\x1b[34mbold blue\x1b[0m')).toBe('bold blue');
    });

    it('returns plain text unchanged', () => {
        expect(stripAnsi('plain text')).toBe('plain text');
    });

    it('strips cursor movement codes', () => {
        expect(stripAnsi('\x1b[2Amoved up\x1b[0K')).toBe('moved up');
    });

    it('handles empty string', () => {
        expect(stripAnsi('')).toBe('');
    });

    // --- Regression tests from M4 post-milestone bug hunt ---

    it('strips colon-separated SGR params (256-color via colon syntax)', () => {
        // \x1b[38:5:196m — 256-color foreground using colon separator
        expect(stripAnsi('\x1b[38:5:196mred\x1b[0m')).toBe('red');
    });

    it('strips truecolor colon-separated params', () => {
        // \x1b[38:2:255:128:0m — RGB truecolor using colon separator
        expect(stripAnsi('\x1b[38:2:255:128:0mred\x1b[0m')).toBe('red');
    });

    it('strips 2-char escape sequences (ESC c = terminal reset)', () => {
        expect(stripAnsi('\x1bcsome text')).toBe('some text');
    });

    it('strips 2-char escape sequences (ESC M = reverse index)', () => {
        expect(stripAnsi('\x1bMtext')).toBe('text');
    });

    it('strips mixed colon-param and 2-char sequences', () => {
        expect(stripAnsi('\x1bc\x1b[38:5:196mcolored\x1b[0m')).toBe('colored');
    });
});
