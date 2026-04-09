import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ItemId } from '../../src/types/ids.js';
import type { TerminalCapabilities } from '../../src/rendering/terminal-capabilities.js';
import { OutputChannel } from '../../src/rendering/output-channel.js';
import { Renderer } from '../../src/rendering/renderer.js';
import { TurnRenderer } from '../../src/rendering/turn-renderer.js';
import {
    Phase,
    type ToolCompletedEvent,
    type ToolStartedEvent,
    type TurnEngine,
} from '../../src/core/turn-engine.js';

function captureStream(): { stream: PassThrough; output: () => string } {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    return {
        stream,
        output: () => Buffer.concat(chunks).toString('utf8'),
    };
}

function makeCapabilities(): TerminalCapabilities {
    return {
        stdout: { isTTY: true, colorDepth: 24, columns: 80 },
        stderr: { isTTY: true, colorDepth: 24, columns: 80 },
        rows: 24,
        unicode: true,
    };
}

function createTurnRenderer(verbose = false): {
    turnRenderer: TurnRenderer;
    stdout: () => string;
    stderr: () => string;
    engine: TurnEngine;
} {
    const out = captureStream();
    const err = captureStream();
    const output = new OutputChannel({
        capabilities: makeCapabilities(),
        mode: 'interactive',
        stdoutStream: out.stream,
        stderrStream: err.stream,
    });
    const renderer = new Renderer({ output, verbose });
    const turnRenderer = new TurnRenderer({ output, renderer, verbose });
    const engine = new EventEmitter() as TurnEngine;
    return {
        turnRenderer,
        stdout: out.output,
        stderr: err.output,
        engine,
    };
}

describe('TurnRenderer', () => {
    it('writes raw assistant deltas to stdout and mirrors rendered markdown to stderr in verbose mode', async () => {
        const { turnRenderer, stdout, stderr } = createTurnRenderer(true);

        turnRenderer.onTextDelta('**bold text**');
        await turnRenderer.renderAssistantMirror([
            {
                kind: 'message',
                id: 'itm_a1' as ItemId,
                seq: 1,
                role: 'assistant',
                parts: [{ type: 'text', text: '**bold text**' }],
                timestamp: new Date().toISOString(),
            },
        ]);

        expect(stdout()).toBe('**bold text**');
        expect(stderr()).toContain('\x1b[1m');
        expect(stderr()).toContain('bold text');
    });

    it('renders tool lifecycle lines and diff previews', () => {
        const { turnRenderer, stderr, engine } = createTurnRenderer(false);
        turnRenderer.bind(engine);

        engine.emit('phase', Phase.CallLLM);
        engine.emit('tool.started', {
            toolName: 'write_file',
            arguments: { path: 'note.txt', content: 'hello\n', mode: 'create' },
        } satisfies ToolStartedEvent);
        engine.emit('tool.completed', {
            toolName: 'write_file',
            arguments: { path: 'note.txt', content: 'hello\n', mode: 'create' },
            output: {
                status: 'success',
                data: JSON.stringify({ bytes_written: 6, hash: 'abc' }),
                truncated: false,
                bytesReturned: 32,
                bytesOmitted: 0,
                retryable: false,
                timedOut: false,
                mutationState: 'filesystem',
            },
            durationMs: 120,
            renderPreview: {
                filePath: 'note.txt',
                oldContent: '',
                newContent: 'hello\n',
                isNewFile: true,
            },
        } satisfies ToolCompletedEvent);

        const output = stderr();
        expect(output).toContain('write_file');
        expect(output).toContain('Created note.txt (1 line)');
    });
});
