import { describe, it, expect, vi, afterEach } from 'vitest';
import { Spinner, ProgressBar, StatusLine, BRAILLE_FRAMES, ASCII_FRAMES } from '../../src/rendering/progress.js';
import { OutputChannel } from '../../src/rendering/output-channel.js';
import type { TerminalCapabilities } from '../../src/rendering/terminal-capabilities.js';
import { PassThrough } from 'node:stream';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function captureStream(): { stream: PassThrough; output: () => string; reset: () => void } {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    return {
        stream,
        output: () => Buffer.concat(chunks).toString('utf-8'),
        reset: () => { chunks.length = 0; },
    };
}

function makeCapabilities(overrides: Partial<{
    stderrTTY: boolean;
    stderrColor: 0 | 4 | 8 | 24;
    unicode: boolean;
}>): TerminalCapabilities {
    return {
        stdout: { isTTY: true, colorDepth: 24, columns: 80 },
        stderr: {
            isTTY: overrides.stderrTTY ?? true,
            colorDepth: overrides.stderrColor ?? 24,
            columns: 80,
        },
        rows: 24,
        unicode: overrides.unicode ?? true,
    };
}

function makeOutput(opts: {
    stderrTTY?: boolean;
    stderrColor?: 0 | 4 | 8 | 24;
    unicode?: boolean;
}): { output: OutputChannel; err: () => string; reset: () => void } {
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
    return { output, err: err.output, reset: err.reset };
}

const ANSI_RE = /\x1b\[/;
function hasAnsi(text: string): boolean { return ANSI_RE.test(text); }

// ---------------------------------------------------------------------------
// Spinner — timing (fake timers)
// ---------------------------------------------------------------------------

describe('Spinner — 1s delay', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('produces no output before 1s delay expires', () => {
        vi.useFakeTimers();
        const { output, err } = makeOutput({});
        const spinner = new Spinner({ output });

        spinner.start('building');
        expect(err()).toBe('');

        vi.advanceTimersByTime(999);
        expect(err()).toBe('');

        spinner.stop();
    });

    it('starts spinner at exactly 1s', () => {
        vi.useFakeTimers();
        const { output, err } = makeOutput({});
        const spinner = new Spinner({ output });

        spinner.start('building');
        vi.advanceTimersByTime(1000);

        expect(err()).not.toBe('');
        expect(err()).toContain('building');

        spinner.stop();
    });
});

describe('StatusLine', () => {
    it('stop before start emits no output', () => {
        const { output, err } = makeOutput({});
        const status = new StatusLine({ output });

        status.stop();

        expect(err()).toBe('');
    });
});

// ---------------------------------------------------------------------------
// Spinner — braille frame cycling
// ---------------------------------------------------------------------------

describe('Spinner — braille frame cycling', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('cycles through braille frames at 80ms intervals', () => {
        vi.useFakeTimers();
        let nowMs = 0;
        const { output, err, reset } = makeOutput({});
        const spinner = new Spinner({ output, now: () => nowMs });

        spinner.start('running');

        // Advance past the 1s delay — first tick fires immediately
        nowMs = 1000;
        vi.advanceTimersByTime(1000);
        expect(err()).toContain(BRAILLE_FRAMES[0]!); // ⠋
        reset();

        // Each 80ms interval advances to the next frame
        for (let i = 1; i < 6; i++) {
            nowMs = 1000 + i * SPINNER_INTERVAL_MS;
            vi.advanceTimersByTime(80);
            expect(err()).toContain(BRAILLE_FRAMES[i]!);
            reset();
        }

        spinner.stop();
    });

    it('wraps back to first frame after cycling all 10 braille frames', () => {
        vi.useFakeTimers();
        let nowMs = 0;
        const { output, err, reset } = makeOutput({});
        const spinner = new Spinner({ output, now: () => nowMs });

        spinner.start('running');

        // Advance past delay — first tick fires immediately (tick 0 → frame 0, frameIndex → 1)
        nowMs = 1000;
        vi.advanceTimersByTime(1000);
        reset();

        // Advance 9 more interval ticks (ticks 1-9, frames 1-9), consuming the remaining frames
        for (let i = 1; i <= 9; i++) {
            nowMs = 1000 + i * 80;
            vi.advanceTimersByTime(80);
            reset();
        }

        // Tick 10: frameIndex=10 → 10 % 10 === 0 → back to frame 0 (⠋)
        nowMs = 1000 + 10 * 80;
        vi.advanceTimersByTime(80);
        expect(err()).toContain(BRAILLE_FRAMES[0]!); // wrapped back to ⠋

        spinner.stop();
    });
});

// ---------------------------------------------------------------------------
// Spinner — SPINNER_INTERVAL_MS constant check
// ---------------------------------------------------------------------------

const SPINNER_INTERVAL_MS = 80; // matches src constant for readability in tests

// ---------------------------------------------------------------------------
// Spinner — completion
// ---------------------------------------------------------------------------

describe('Spinner — completion', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('replaces spinner with ✓ line on success', () => {
        vi.useFakeTimers();
        let nowMs = 0;
        const { output, err } = makeOutput({ unicode: true });
        const spinner = new Spinner({ output, now: () => nowMs });

        spinner.start('npm install');
        nowMs = 1000;
        vi.advanceTimersByTime(1000);

        nowMs = 5000;
        spinner.complete(true, 4000);

        const out = err();
        expect(out).toContain('✓');
        expect(out).toContain('npm install');
        expect(out).toContain('4.0s');
        // Completion line ends with newline
        expect(out).toMatch(/\n$/);
    });

    it('replaces spinner with ✗ line on failure', () => {
        vi.useFakeTimers();
        let nowMs = 0;
        const { output, err } = makeOutput({ unicode: true });
        const spinner = new Spinner({ output, now: () => nowMs });

        spinner.start('npm test');
        nowMs = 1000;
        vi.advanceTimersByTime(1000);

        spinner.complete(false, 3100);

        const out = err();
        expect(out).toContain('✗');
        expect(out).toContain('npm test');
        expect(out).toContain('3.1s');
    });

    it('completes without spinner output when done before 1s delay', () => {
        vi.useFakeTimers();
        const { output, err } = makeOutput({});
        const spinner = new Spinner({ output });

        spinner.start('quick task');
        // Complete before the 1s delay fires
        spinner.complete(true, 500);

        const out = err();
        // No \r (no spinner was active)
        // But completion line should still appear
        expect(out).toContain('quick task');
        expect(out).toContain('500ms');
        expect(out).not.toContain('\r✓'); // no carriage return prefix (spinner wasn't active)
    });
});

// ---------------------------------------------------------------------------
// Spinner — non-TTY
// ---------------------------------------------------------------------------

describe('Spinner — non-TTY', () => {
    it('logs static start line with timestamp, no \\r updates', () => {
        const { output, err } = makeOutput({ stderrTTY: false, stderrColor: 0 });
        const nowMs = new Date(2026, 3, 3, 12, 34, 56).getTime();
        const spinner = new Spinner({ output, now: () => nowMs });

        spinner.start('npm install');

        const out = err();
        expect(out).toContain('npm install');
        expect(out).toContain('[12:34:56]');
        expect(out).not.toContain('\r');
        // No ANSI codes in non-color mode
        expect(hasAnsi(out)).toBe(false);
    });

    it('logs completion line with timestamp in non-TTY mode', () => {
        const { output, err } = makeOutput({ stderrTTY: false, stderrColor: 0 });
        let nowMs = new Date(2026, 3, 3, 12, 34, 56).getTime();
        const spinner = new Spinner({ output, now: () => nowMs });

        spinner.start('build');
        nowMs = new Date(2026, 3, 3, 12, 35, 10).getTime();
        spinner.complete(true, 14200);

        const out = err();
        expect(out).toContain('build completed');
        expect(out).toContain('14.2s');
        expect(out).not.toContain('\r');
    });

    it('non-TTY failure logs "failed" status', () => {
        const { output, err } = makeOutput({ stderrTTY: false, stderrColor: 0 });
        const spinner = new Spinner({ output });

        spinner.start('flaky test');
        spinner.complete(false, 2000);

        expect(err()).toContain('failed');
        expect(err()).toContain('flaky test');
    });
});

// ---------------------------------------------------------------------------
// Spinner — unicode=false ASCII fallback
// ---------------------------------------------------------------------------

describe('Spinner — ASCII fallback (unicode=false)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('uses ASCII frames when unicode=false', () => {
        vi.useFakeTimers();
        let nowMs = 0;
        const { output, err, reset } = makeOutput({ unicode: false });
        const spinner = new Spinner({ output, now: () => nowMs });

        spinner.start('building');
        nowMs = 1000;
        vi.advanceTimersByTime(1000);

        // First ASCII frame: |
        expect(err()).toContain(ASCII_FRAMES[0]!); // '|'
        reset();

        // Second ASCII frame: /
        nowMs = 1080;
        vi.advanceTimersByTime(80);
        expect(err()).toContain(ASCII_FRAMES[1]!); // '/'

        spinner.stop();
    });

    it('uses [OK] instead of ✓ on success when unicode=false', () => {
        vi.useFakeTimers();
        let nowMs = 0;
        const { output, err } = makeOutput({ unicode: false });
        const spinner = new Spinner({ output, now: () => nowMs });

        spinner.start('build');
        nowMs = 1000;
        vi.advanceTimersByTime(1000);
        spinner.complete(true, 2000);

        const out = err();
        expect(out).toContain('[OK]');
        expect(out).not.toContain('✓');
    });

    it('uses [FAIL] instead of ✗ on failure when unicode=false', () => {
        vi.useFakeTimers();
        let nowMs = 0;
        const { output, err } = makeOutput({ unicode: false });
        const spinner = new Spinner({ output, now: () => nowMs });

        spinner.start('build');
        nowMs = 1000;
        vi.advanceTimersByTime(1000);
        spinner.complete(false, 2000);

        expect(err()).toContain('[FAIL]');
        expect(err()).not.toContain('✗');
    });
});

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

describe('ProgressBar — visual format', () => {
    it('shows visual bar at 30% when 3/10 complete', () => {
        const { output, err } = makeOutput({ unicode: true });
        const bar = new ProgressBar({ output });

        bar.start('files indexed', 10);
        bar.update(3);

        const out = err();
        expect(out).toContain('3/10');
        expect(out).toContain('files indexed');
        // 30% of 20 = 6 filled chars ─ verify bar bracket structure
        expect(out).toMatch(/\[.*\]/);
    });

    it('renders filled portion with █ and empty with ░ (unicode)', () => {
        const { output, err } = makeOutput({ unicode: true });
        const bar = new ProgressBar({ output });

        bar.start('indexing', 10);
        bar.update(5);

        // 50% = 10 filled, 10 empty
        const out = err();
        expect(out).toContain('█');
        expect(out).toContain('░');
    });

    it('uses # and . characters when unicode=false', () => {
        const { output, err } = makeOutput({ unicode: false });
        const bar = new ProgressBar({ output });

        bar.start('indexing', 10);
        bar.update(3);

        const out = err();
        expect(out).toContain('#');
        expect(out).toContain('.');
        expect(out).not.toContain('█');
        expect(out).not.toContain('░');
    });

    it('shows 0% bar at start before any updates', () => {
        const { output, err } = makeOutput({ unicode: true });
        const bar = new ProgressBar({ output });

        bar.start('files', 10);

        const out = err();
        expect(out).toContain('0/10');
    });

    it('shows 100% bar at complete()', () => {
        const { output, err } = makeOutput({ unicode: true });
        const bar = new ProgressBar({ output });

        bar.start('files', 5);
        bar.complete();

        const out = err();
        expect(out).toContain('5/5');
    });

    it('uses \\r for in-place updates on TTY', () => {
        const { output, err } = makeOutput({ stderrTTY: true });
        const bar = new ProgressBar({ output });

        bar.start('items', 10);
        bar.update(3);
        bar.update(7);

        expect(err()).toContain('\r');
    });

    it('complete() adds a newline to finalize the bar on TTY', () => {
        const { output, err } = makeOutput({ stderrTTY: true });
        const bar = new ProgressBar({ output });

        bar.start('files', 3);
        bar.complete();

        expect(err()).toMatch(/\n/);
    });

    it('non-TTY: only logs completion line (no \\r)', () => {
        const { output, err } = makeOutput({ stderrTTY: false, stderrColor: 0 });
        const bar = new ProgressBar({ output });

        bar.start('files', 5);
        bar.update(2); // should not log
        bar.complete(); // logs the final state

        const out = err();
        expect(out).toContain('5/5');
        expect(out).not.toContain('\r');
    });

    it('clear() removes an active TTY bar without logging completion', () => {
        const { output, err } = makeOutput({ stderrTTY: true });
        const bar = new ProgressBar({ output });

        bar.start('files', 5);
        bar.update(2);
        bar.clear();

        const out = err();
        expect(out).toContain('\r\x1b[K');
        expect(out).not.toContain('5/5');
    });
});

// ---------------------------------------------------------------------------
// StatusLine
// ---------------------------------------------------------------------------

describe('StatusLine', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows message with elapsed time on TTY', () => {
        vi.useFakeTimers();
        let nowMs = 0;
        const { output, err } = makeOutput({});
        const status = new StatusLine({ output, now: () => nowMs });

        status.start('Thinking');
        expect(err()).toContain('Thinking');
        expect(err()).toContain('0.0s');

        status.stop();
    });

    it('updates elapsed time at 250ms intervals on TTY', () => {
        vi.useFakeTimers();
        let nowMs = 0;
        const { output, err, reset } = makeOutput({});
        const status = new StatusLine({ output, now: () => nowMs });

        status.start();
        reset();

        nowMs = 1000;
        vi.advanceTimersByTime(1000); // four 250ms ticks

        // The most recent render should reflect elapsed ~1.0s
        const out = err();
        expect(out).toContain('1.0s');

        status.stop();
    });

    it('non-TTY: single static line with timestamp, no \\r', () => {
        const { output, err } = makeOutput({ stderrTTY: false, stderrColor: 0 });
        const nowMs = new Date(2026, 3, 3, 9, 15, 0).getTime();
        const status = new StatusLine({ output, now: () => nowMs });

        status.start('Thinking');

        const out = err();
        expect(out).toContain('[09:15:00]');
        expect(out).toContain('Thinking...');
        expect(out).not.toContain('\r');
    });

    it('stop() clears the line with \\r\\x1b[K on TTY', () => {
        vi.useFakeTimers();
        const { output, err } = makeOutput({});
        const status = new StatusLine({ output });

        status.start();
        const before = err();
        status.stop();
        const after = err();

        // Before stop: has content
        expect(before).not.toBe('');
        // After stop: clear sequence was written
        expect(after).toContain('\r\x1b[K');
    });
});

// ---------------------------------------------------------------------------
// Regression tests: label sanitization (M4 post-milestone bug hunt, Q7)
// ---------------------------------------------------------------------------

describe('Label sanitization — control character stripping', () => {
    it('Spinner: bell character in label does not appear in output', () => {
        vi.useFakeTimers();
        const { output, err, reset } = makeOutput({});
        const spinner = new Spinner({ output });

        spinner.start('loading\x07tool');
        vi.advanceTimersByTime(1500); // past 1s grace delay
        const out = err();
        reset();

        // The bell character must be stripped — it would beep every 80ms otherwise
        expect(out).not.toContain('\x07');
        expect(out).toContain('loadingtool');
        spinner.stop();
    });

    it('Spinner: backspace in label does not appear in output', () => {
        vi.useFakeTimers();
        const { output, err, reset } = makeOutput({});
        const spinner = new Spinner({ output });

        spinner.start('a\x08b');
        vi.advanceTimersByTime(1500);
        const out = err();
        reset();

        // Backspace would corrupt \r overwrite by deleting the spinner frame
        expect(out).not.toContain('\x08');
        expect(out).toContain('ab');
        spinner.stop();
    });

    it('Spinner: null bytes in label are stripped', () => {
        vi.useFakeTimers();
        const { output, err, reset } = makeOutput({});
        const spinner = new Spinner({ output });

        spinner.start('test\x00label');
        vi.advanceTimersByTime(1500);
        const out = err();
        reset();

        expect(out).not.toContain('\x00');
        spinner.stop();
    });

    it('Spinner: tab in label is normalized to space', () => {
        vi.useFakeTimers();
        const { output, err, reset } = makeOutput({});
        const spinner = new Spinner({ output });

        spinner.start('a\tb');
        vi.advanceTimersByTime(1500);
        const out = err();
        reset();

        expect(out).not.toContain('\t');
        expect(out).toContain('a b');
        spinner.stop();
    });
});
