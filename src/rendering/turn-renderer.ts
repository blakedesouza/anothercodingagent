import type { ConversationItem, ToolOutput } from '../types/conversation.js';
import {
    Phase,
    type MutationRenderPreview,
    type ToolCompletedEvent,
    type ToolStartedEvent,
    type TurnEngine,
} from '../core/turn-engine.js';
import type { OutputChannel } from './output-channel.js';
import { DiffRenderer } from './diff-renderer.js';
import { MarkdownRenderer } from './markdown-renderer.js';
import { StatusLine, Spinner } from './progress.js';
import { Renderer } from './renderer.js';
import { SyntaxHighlighter } from './syntax-highlighter.js';

export interface TurnRendererOptions {
    output: OutputChannel;
    renderer: Renderer;
    verbose?: boolean;
}

export class TurnRenderer {
    private readonly output: OutputChannel;
    private readonly renderer: Renderer;
    private readonly verbose: boolean;
    private readonly statusLine: StatusLine;
    private readonly spinner: Spinner;
    private readonly markdownRenderer: MarkdownRenderer;
    private readonly diffRenderer: DiffRenderer;
    private boundEngine: TurnEngine | null = null;

    constructor(options: TurnRendererOptions) {
        this.output = options.output;
        this.renderer = options.renderer;
        this.verbose = options.verbose ?? false;
        const caps = this.output.getCapabilities();
        this.statusLine = new StatusLine({ output: this.output });
        this.spinner = new Spinner({ output: this.output });
        this.diffRenderer = new DiffRenderer(caps.stderr);
        this.markdownRenderer = new MarkdownRenderer({
            streamCaps: caps.stderr,
            unicode: caps.unicode,
            highlighter: new SyntaxHighlighter(caps.stderr),
        });
    }

    bind(engine: TurnEngine): void {
        this.unbind();
        this.boundEngine = engine;
        engine.on('phase', this.handlePhase);
        engine.on('tool.started', this.handleToolStarted);
        engine.on('tool.completed', this.handleToolCompleted);
    }

    unbind(): void {
        if (!this.boundEngine) return;
        this.boundEngine.off('phase', this.handlePhase);
        this.boundEngine.off('tool.started', this.handleToolStarted);
        this.boundEngine.off('tool.completed', this.handleToolCompleted);
        this.boundEngine = null;
        this.statusLine.stop();
        this.spinner.stop();
    }

    dispose(): void {
        this.unbind();
    }

    onTextDelta(text: string): void {
        this.statusLine.stop();
        this.output.stdout(text);
    }

    async renderAssistantMirror(items: readonly ConversationItem[]): Promise<void> {
        if (!this.verbose) return;
        const assistantText = extractAssistantText(items);
        if (assistantText.trim() === '') return;
        const rendered = await this.markdownRenderer.render(assistantText);
        this.output.stderr(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
    }

    private readonly handlePhase = (phase: Phase): void => {
        if (phase === Phase.CallLLM) {
            this.statusLine.start('Thinking');
            return;
        }
        this.statusLine.stop();
    };

    private readonly handleToolStarted = (event: ToolStartedEvent): void => {
        this.statusLine.stop();
        const argsSummary = summarizeToolArgs(event.arguments);
        this.renderer.toolStart({
            toolName: event.toolName,
            ...(argsSummary ? { args: argsSummary } : {}),
        });
        if (this.output.isTTY('stderr')) {
            this.spinner.start(buildToolLabel(event.toolName, argsSummary));
        }
    };

    private readonly handleToolCompleted = (event: ToolCompletedEvent): void => {
        this.statusLine.stop();
        if (this.output.isTTY('stderr')) {
            this.spinner.stop();
        }
        this.renderer.toolComplete({
            toolName: event.toolName,
            result: summarizeToolResult(event.toolName, event.output),
            durationMs: event.durationMs,
            success: event.output.status === 'success',
            detail: buildToolDetail(event.output),
        });
        if (event.renderPreview) {
            this.output.stderr(this.diffRenderer.render(toDiffRenderOptions(event.renderPreview)));
        }
    };
}

function extractAssistantText(items: readonly ConversationItem[]): string {
    let text = '';
    for (const item of items) {
        if (item.kind !== 'message' || item.role !== 'assistant') continue;
        for (const part of item.parts) {
            if (part.type === 'text') {
                text += part.text;
            }
        }
    }
    return text;
}

function buildToolLabel(toolName: string, argsSummary: string): string {
    return argsSummary.length > 0 ? `${toolName} ${argsSummary}` : toolName;
}

function summarizeToolArgs(args: Record<string, unknown>): string {
    const firstStringArg = ['path', 'command', 'url', 'query', 'stdin', 'target', 'name']
        .map((key) => args[key])
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (firstStringArg) {
        return truncateInline(firstStringArg);
    }
    const raw = JSON.stringify(args);
    return raw === '{}' ? '' : truncateInline(raw);
}

function summarizeToolResult(toolName: string, output: ToolOutput): string {
    if (output.status === 'error') {
        return output.error?.message ?? 'failed';
    }

    const parsed = tryParseJson(output.data);
    if (parsed) {
        switch (toolName) {
            case 'read_file':
                if (parsed.isBinary === true && typeof parsed.size === 'number') {
                    return `${parsed.size} bytes binary`;
                }
                if (typeof parsed.lineCount === 'number') {
                    return `${parsed.lineCount} line${parsed.lineCount === 1 ? '' : 's'}`;
                }
                break;
            case 'write_file':
                if (typeof parsed.bytes_written === 'number') {
                    return `${parsed.bytes_written} bytes written`;
                }
                break;
            case 'edit_file':
                if (typeof parsed.applied === 'number') {
                    const rejects = Array.isArray(parsed.rejects) ? parsed.rejects.length : 0;
                    return rejects > 0
                        ? `${parsed.applied} edits applied, ${rejects} rejected`
                        : `${parsed.applied} edits applied`;
                }
                break;
            case 'exec_command':
                if (typeof parsed.exit_code === 'number') {
                    return `exit ${parsed.exit_code}`;
                }
                break;
            case 'make_directory':
                if (typeof parsed.created === 'boolean') {
                    return parsed.created ? 'created' : 'already existed';
                }
                break;
        }
    }

    const compact = output.data.trim().split('\n')[0] ?? '';
    return compact.length > 0 ? truncateInline(compact) : 'ok';
}

function buildToolDetail(output: ToolOutput): string | undefined {
    if (output.status === 'error') {
        return output.error?.message;
    }
    const trimmed = output.data.trim();
    return trimmed.length > 0 ? truncateDetail(trimmed) : undefined;
}

function toDiffRenderOptions(preview: MutationRenderPreview): MutationRenderPreview {
    return preview;
}

function truncateInline(text: string, max = 120): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function truncateDetail(text: string, max = 400): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function tryParseJson(text: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(text) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return null;
    } catch {
        return null;
    }
}
