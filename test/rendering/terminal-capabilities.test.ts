import { describe, it, expect } from 'vitest';
import { detectCapabilities } from '../../src/rendering/terminal-capabilities.js';

// Helper to create a mock WriteStream
function mockStream(overrides: {
    isTTY?: boolean;
    columns?: number;
    rows?: number;
    getColorDepth?: () => number;
} = {}): NodeJS.WriteStream {
    return {
        isTTY: overrides.isTTY ?? false,
        columns: overrides.columns ?? 80,
        rows: overrides.rows ?? 24,
        getColorDepth: overrides.getColorDepth,
        write: () => true,
        // Minimal stream interface to satisfy type
    } as unknown as NodeJS.WriteStream;
}

describe('TerminalCapabilities', () => {
    describe('detectCapabilities', () => {
        it('detects TTY stream as isTTY=true with colorDepth > 0', () => {
            const caps = detectCapabilities({
                env: { LANG: 'en_US.UTF-8' },
                stdoutStream: mockStream({ isTTY: true }),
                stderrStream: mockStream({ isTTY: true }),
            });
            expect(caps.stdout.isTTY).toBe(true);
            expect(caps.stderr.isTTY).toBe(true);
            expect(caps.stdout.colorDepth).toBeGreaterThan(0);
            expect(caps.stderr.colorDepth).toBeGreaterThan(0);
        });

        it('detects non-TTY stream as isTTY=false', () => {
            const caps = detectCapabilities({
                env: {},
                stdoutStream: mockStream({ isTTY: false }),
                stderrStream: mockStream({ isTTY: false }),
            });
            expect(caps.stdout.isTTY).toBe(false);
            expect(caps.stderr.isTTY).toBe(false);
        });

        it('NO_COLOR=1 forces colorDepth=0 even on TTY', () => {
            const caps = detectCapabilities({
                env: { NO_COLOR: '1' },
                stdoutStream: mockStream({ isTTY: true }),
                stderrStream: mockStream({ isTTY: true }),
            });
            expect(caps.stdout.colorDepth).toBe(0);
            expect(caps.stderr.colorDepth).toBe(0);
        });

        it('NO_COLOR with empty string still forces colorDepth=0', () => {
            const caps = detectCapabilities({
                env: { NO_COLOR: '' },
                stdoutStream: mockStream({ isTTY: true }),
                stderrStream: mockStream({ isTTY: true }),
            });
            expect(caps.stdout.colorDepth).toBe(0);
            expect(caps.stderr.colorDepth).toBe(0);
        });

        it('FORCE_COLOR=1 enables color on non-TTY', () => {
            const caps = detectCapabilities({
                env: { FORCE_COLOR: '1' },
                stdoutStream: mockStream({ isTTY: false }),
                stderrStream: mockStream({ isTTY: false }),
            });
            expect(caps.stdout.colorDepth).toBeGreaterThan(0);
            expect(caps.stderr.colorDepth).toBeGreaterThan(0);
        });

        it('FORCE_COLOR=3 enables truecolor on non-TTY', () => {
            const caps = detectCapabilities({
                env: { FORCE_COLOR: '3' },
                stdoutStream: mockStream({ isTTY: false }),
                stderrStream: mockStream({ isTTY: false }),
            });
            expect(caps.stdout.colorDepth).toBe(24);
            expect(caps.stderr.colorDepth).toBe(24);
        });

        it('FORCE_COLOR=2 enables 256-color on non-TTY', () => {
            const caps = detectCapabilities({
                env: { FORCE_COLOR: '2' },
                stdoutStream: mockStream({ isTTY: false }),
                stderrStream: mockStream({ isTTY: false }),
            });
            expect(caps.stdout.colorDepth).toBe(8);
            expect(caps.stderr.colorDepth).toBe(8);
        });

        it('FORCE_COLOR=0 with NO_COLOR absent still results in 0', () => {
            const caps = detectCapabilities({
                env: { FORCE_COLOR: '0' },
                stdoutStream: mockStream({ isTTY: false }),
                stderrStream: mockStream({ isTTY: false }),
            });
            expect(caps.stdout.colorDepth).toBe(0);
            expect(caps.stderr.colorDepth).toBe(0);
        });

        it('NO_COLOR takes priority over FORCE_COLOR', () => {
            const caps = detectCapabilities({
                env: { NO_COLOR: '1', FORCE_COLOR: '1' },
                stdoutStream: mockStream({ isTTY: true }),
                stderrStream: mockStream({ isTTY: true }),
            });
            expect(caps.stdout.colorDepth).toBe(0);
            expect(caps.stderr.colorDepth).toBe(0);
        });

        it('detects unicode=true from LANG=en_US.UTF-8', () => {
            const caps = detectCapabilities({
                env: { LANG: 'en_US.UTF-8' },
                stdoutStream: mockStream(),
                stderrStream: mockStream(),
            });
            expect(caps.unicode).toBe(true);
        });

        it('detects unicode=false from LANG=C', () => {
            const caps = detectCapabilities({
                env: { LANG: 'C' },
                stdoutStream: mockStream(),
                stderrStream: mockStream(),
            });
            expect(caps.unicode).toBe(false);
        });

        it('detects unicode=true from LC_ALL=en_US.utf8', () => {
            const caps = detectCapabilities({
                env: { LC_ALL: 'en_US.utf8' },
                stdoutStream: mockStream(),
                stderrStream: mockStream(),
            });
            expect(caps.unicode).toBe(true);
        });

        it('detects unicode=false when LANG and LC_ALL are missing', () => {
            const caps = detectCapabilities({
                env: {},
                stdoutStream: mockStream(),
                stderrStream: mockStream(),
            });
            expect(caps.unicode).toBe(false);
        });

        it('per-stream detection: piped stdout + TTY stderr', () => {
            const caps = detectCapabilities({
                env: { LANG: 'en_US.UTF-8' },
                stdoutStream: mockStream({ isTTY: false }),
                stderrStream: mockStream({ isTTY: true }),
            });
            expect(caps.stdout.isTTY).toBe(false);
            expect(caps.stdout.colorDepth).toBe(0);
            expect(caps.stderr.isTTY).toBe(true);
            expect(caps.stderr.colorDepth).toBeGreaterThan(0);
        });

        it('uses stream columns when available', () => {
            const caps = detectCapabilities({
                env: {},
                stdoutStream: mockStream({ columns: 120 }),
                stderrStream: mockStream({ columns: 200 }),
            });
            expect(caps.stdout.columns).toBe(120);
            expect(caps.stderr.columns).toBe(200);
        });

        it('defaults columns to 80 when stream has no columns property', () => {
            const stream = { write: () => true } as unknown as NodeJS.WriteStream;
            const caps = detectCapabilities({
                env: {},
                stdoutStream: stream,
                stderrStream: stream,
            });
            expect(caps.stdout.columns).toBe(80);
            expect(caps.stderr.columns).toBe(80);
        });

        it('uses stderr rows, falling back to stdout rows, then default 24', () => {
            const caps1 = detectCapabilities({
                env: {},
                stdoutStream: mockStream({ rows: 50 }),
                stderrStream: mockStream({ rows: 40 }),
            });
            expect(caps1.rows).toBe(40); // stderr takes priority

            const caps2 = detectCapabilities({
                env: {},
                stdoutStream: mockStream({ rows: 50 }),
                stderrStream: { write: () => true } as unknown as NodeJS.WriteStream,
            });
            expect(caps2.rows).toBe(50); // falls back to stdout
        });

        it('result object is frozen', () => {
            const caps = detectCapabilities({
                env: {},
                stdoutStream: mockStream(),
                stderrStream: mockStream(),
            });
            expect(Object.isFrozen(caps)).toBe(true);
            expect(Object.isFrozen(caps.stdout)).toBe(true);
            expect(Object.isFrozen(caps.stderr)).toBe(true);
        });

        it('detects COLORTERM=truecolor as 24-bit on TTY', () => {
            const caps = detectCapabilities({
                env: { COLORTERM: 'truecolor' },
                stdoutStream: mockStream({ isTTY: true }),
                stderrStream: mockStream({ isTTY: true }),
            });
            expect(caps.stdout.colorDepth).toBe(24);
            expect(caps.stderr.colorDepth).toBe(24);
        });

        it('detects TERM=xterm-256color as 8-bit on TTY', () => {
            const caps = detectCapabilities({
                env: { TERM: 'xterm-256color' },
                stdoutStream: mockStream({ isTTY: true }),
                stderrStream: mockStream({ isTTY: true }),
            });
            expect(caps.stdout.colorDepth).toBe(8);
            expect(caps.stderr.colorDepth).toBe(8);
        });

        it('non-TTY without FORCE_COLOR has colorDepth=0 regardless of COLORTERM', () => {
            const caps = detectCapabilities({
                env: { COLORTERM: 'truecolor' },
                stdoutStream: mockStream({ isTTY: false }),
                stderrStream: mockStream({ isTTY: false }),
            });
            expect(caps.stdout.colorDepth).toBe(0);
            expect(caps.stderr.colorDepth).toBe(0);
        });

        it('FORCE_COLOR overrides TTY detection (absolute override)', () => {
            // FORCE_COLOR=1 on a truecolor TTY → forced to 4 (16 colors)
            const caps = detectCapabilities({
                env: { FORCE_COLOR: '1' },
                stdoutStream: mockStream({
                    isTTY: true,
                    getColorDepth: () => 16777216,
                }),
                stderrStream: mockStream({
                    isTTY: true,
                    getColorDepth: () => 16777216,
                }),
            });
            expect(caps.stdout.colorDepth).toBe(4);
            expect(caps.stderr.colorDepth).toBe(4);
        });

        it('FORCE_COLOR=0 disables color even on TTY', () => {
            const caps = detectCapabilities({
                env: { FORCE_COLOR: '0' },
                stdoutStream: mockStream({ isTTY: true }),
                stderrStream: mockStream({ isTTY: true }),
            });
            expect(caps.stdout.colorDepth).toBe(0);
            expect(caps.stderr.colorDepth).toBe(0);
        });

        it('uses getColorDepth from stream when available on TTY', () => {
            const caps = detectCapabilities({
                env: {},
                stdoutStream: mockStream({
                    isTTY: true,
                    getColorDepth: () => 16777216,
                }),
                stderrStream: mockStream({
                    isTTY: true,
                    getColorDepth: () => 256,
                }),
            });
            expect(caps.stdout.colorDepth).toBe(24);
            expect(caps.stderr.colorDepth).toBe(8);
        });
    });
});
