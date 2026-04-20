import type { SessionProjection } from '../core/session-manager.js';
import type { CostTracker } from '../observability/cost-tracker.js';
import type { Indexer } from '../indexing/indexer.js';
import type { CheckpointManager } from '../checkpointing/checkpoint-manager.js';
import type { OutputChannel } from '../rendering/output-channel.js';
import { ProgressBar } from '../rendering/progress.js';
import pkg from '../../package.json' with { type: 'json' };

export interface SlashCommandContext {
    projection: SessionProjection;
    model: string;
    turnCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    exit: () => void;
    costTracker?: CostTracker;
    indexer?: Indexer;
    checkpointManager?: CheckpointManager;
    promptUser?: (question: string) => Promise<string>;
    outputChannel?: OutputChannel;
}

export interface SlashCommandResult {
    output: string;
    shouldExit: boolean;
}

type SlashCommandHandler = (ctx: SlashCommandContext, args: string) => SlashCommandResult | Promise<SlashCommandResult>;

interface ParsedSlashArgs {
    positional: string[];
    force: boolean;
    unknownFlags: string[];
}

function parseSlashArgs(args: string): ParsedSlashArgs {
    const tokens = args.trim() ? args.trim().split(/\s+/) : [];
    const positional: string[] = [];
    const unknownFlags: string[] = [];
    let force = false;

    for (const token of tokens) {
        if (token === '--force') {
            force = true;
            continue;
        }
        if (token.startsWith('-')) {
            unknownFlags.push(token);
            continue;
        }
        positional.push(token);
    }

    return { positional, force, unknownFlags };
}

const commands: Record<string, SlashCommandHandler> = {
    '/version': () => ({
        output: `aca v${pkg.version}`,
        shouldExit: false,
    }),
    '/model': (ctx) => ({
        output: `Model: ${ctx.model}`,
        shouldExit: false,
    }),
    '/session': (ctx) => ({
        output: [
            `Session:     ${ctx.projection.manifest.sessionId}`,
            `Workspace:   ${ctx.projection.manifest.workspaceId}`,
            `Directory:   ${ctx.projection.sessionDir}`,
            `Status:      ${ctx.projection.manifest.status}`,
            `Last active: ${ctx.projection.manifest.lastActivityTimestamp}`,
        ].join('\n'),
        shouldExit: false,
    }),
    '/exit': (ctx) => {
        ctx.exit();
        return { output: 'Goodbye.', shouldExit: true };
    },
    '/quit': (ctx) => {
        ctx.exit();
        return { output: 'Goodbye.', shouldExit: true };
    },
    '/help': () => ({
        output: [
            'Available commands:',
            '  /help               — Show this help message',
            '  /model              — Show the current model name',
            '  /status             — Show session info, token usage, model',
            '  /undo [N]           — Revert last N mutating turns (default 1)',
            '  /restore <turn-N>   — Restore workspace to a specific checkpoint',
            '  /checkpoints        — List recent checkpoints',
            '  /budget extend <$>  — Extend session budget by amount',
            '  /reindex            — Rebuild the project search index',
            '  /exit               — Exit the REPL',
            '  /quit               — Exit the REPL (alias for /exit)',
        ].join('\n'),
        shouldExit: false,
    }),
    '/status': (ctx) => ({
        output: [
            `Session:  ${ctx.projection.manifest.sessionId}`,
            `Model:    ${ctx.model}`,
            `Turns:    ${ctx.turnCount}`,
            `Tokens:   ${ctx.totalInputTokens} in / ${ctx.totalOutputTokens} out`,
            ...(ctx.costTracker ? [
                `Cost:     $${ctx.costTracker.getSessionCost().toFixed(4)}`,
            ] : []),
        ].join('\n'),
        shouldExit: false,
    }),
    '/reindex': async (ctx) => {
        if (!ctx.indexer) {
            return { output: 'Project indexing is not available.', shouldExit: false };
        }
        if (ctx.indexer.indexing) {
            return { output: 'Indexing is already in progress.', shouldExit: false };
        }
        const progressBar = ctx.outputChannel ? new ProgressBar({ output: ctx.outputChannel }) : undefined;
        if (progressBar) {
            ctx.indexer.setProgressReporter(createProgressReporter(progressBar, 'files indexed'));
        }

        try {
            const result = await ctx.indexer.buildIndex();
            return {
                output:
                    `[reindex] Complete: ${result.filesIndexed} files indexed, ` +
                    `${result.filesSkipped} skipped` +
                    (result.warnings.length > 0 ? `, ${result.warnings.length} warnings` : ''),
                shouldExit: false,
            };
        } catch (err: unknown) {
            progressBar?.clear();
            const msg = err instanceof Error ? err.message : String(err);
            return { output: `[reindex] Failed: ${msg}`, shouldExit: false };
        } finally {
            ctx.indexer.setProgressReporter(undefined);
        }
    },
    '/undo': async (ctx, args) => {
        if (!ctx.checkpointManager) {
            return { output: 'Checkpointing is not available.', shouldExit: false };
        }
        const parsed = parseSlashArgs(args);
        if (parsed.unknownFlags.length > 0 || parsed.positional.length > 1) {
            return { output: 'Usage: /undo [N] [--force] — revert last N mutating turns (default 1)', shouldExit: false };
        }
        const rawCount = parsed.positional[0];
        const count = rawCount ? Number.parseInt(rawCount, 10) : 1;
        if (!Number.isInteger(count) || count < 1) {
            return { output: 'Usage: /undo [N] [--force] — revert last N mutating turns (default 1)', shouldExit: false };
        }
        try {
            const result = await ctx.checkpointManager.undoTurns(count, parsed.force);
            if (!result.success) {
                return { output: result.warnings.join('\n'), shouldExit: false };
            }
            const lines = [`Reverted ${result.turnsReverted} turn(s). Files restored: ${result.filesRestored.length}`];
            if (result.filesRestored.length > 0 && result.filesRestored.length <= 20) {
                lines.push(...result.filesRestored.map(f => `  ${f}`));
            }
            if (result.warnings.length > 0) {
                lines.push('', 'Warnings:');
                lines.push(...result.warnings.map(w => `  ⚠ ${w}`));
            }
            return { output: lines.join('\n'), shouldExit: false };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { output: `Undo failed: ${msg}`, shouldExit: false };
        }
    },
    '/restore': async (ctx, args) => {
        if (!ctx.checkpointManager) {
            return { output: 'Checkpointing is not available.', shouldExit: false };
        }
        const parsed = parseSlashArgs(args);
        if (parsed.unknownFlags.length > 0 || parsed.positional.length !== 1) {
            return { output: 'Usage: /restore <turn-N> [--force] — restore to a specific checkpoint', shouldExit: false };
        }
        const checkpointId = parsed.positional[0];
        try {
            // Preview first
            const preview = await ctx.checkpointManager.previewRestore(checkpointId);
            const totalChanges = preview.filesAdded.length + preview.filesModified.length + preview.filesDeleted.length;
            if (totalChanges === 0) {
                return { output: 'Workspace already matches the target checkpoint. Nothing to do.', shouldExit: false };
            }
            const previewLines = [`Restore to ${checkpointId} would change ${totalChanges} file(s):`];
            if (preview.filesAdded.length > 0) previewLines.push(`  Added:    ${preview.filesAdded.join(', ')}`);
            if (preview.filesModified.length > 0) previewLines.push(`  Modified: ${preview.filesModified.join(', ')}`);
            if (preview.filesDeleted.length > 0) previewLines.push(`  Deleted:  ${preview.filesDeleted.join(', ')}`);

            // Ask for confirmation
            if (ctx.promptUser && !parsed.force) {
                previewLines.push('', 'Apply these changes? (y/n)');
                const answer = await ctx.promptUser(previewLines.join('\n'));
                if (answer.trim().toLowerCase() !== 'y' && answer.trim().toLowerCase() !== 'yes') {
                    return { output: 'Restore cancelled.', shouldExit: false };
                }
            }

            const result = await ctx.checkpointManager.executeRestore(checkpointId, parsed.force);
            if (!result.success) {
                return { output: result.warnings.join('\n'), shouldExit: false };
            }
            const lines = [`Restored to ${checkpointId}. ${result.filesRestored.length} file(s) changed.`];
            if (result.warnings.length > 0) {
                lines.push('', 'Warnings:');
                lines.push(...result.warnings.map(w => `  ⚠ ${w}`));
            }
            return { output: lines.join('\n'), shouldExit: false };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { output: `Restore failed: ${msg}`, shouldExit: false };
        }
    },
    '/checkpoints': async (ctx) => {
        if (!ctx.checkpointManager) {
            return { output: 'Checkpointing is not available.', shouldExit: false };
        }
        try {
            const checkpoints = await ctx.checkpointManager.listCheckpoints();
            if (checkpoints.length === 0) {
                return { output: 'No checkpoints found. Checkpoints are created when workspace-mutating tools execute.', shouldExit: false };
            }
            const lines = [`${checkpoints.length} checkpoint(s):`];
            for (const cp of checkpoints) {
                const afterStatus = cp.afterCommit ? 'complete' : 'before-only';
                const effects = cp.hasExternalEffects ? ' [external effects]' : '';
                const ts = cp.timestamp ? ` (${cp.timestamp})` : '';
                lines.push(`  turn-${cp.turnNumber}: ${cp.message} [${afterStatus}]${effects}${ts}`);
            }
            lines.push('', 'Use /restore <turn-N> to restore to a specific checkpoint.');
            lines.push('Use /undo [N] to revert the last N mutating turns.');
            return { output: lines.join('\n'), shouldExit: false };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { output: `Failed to list checkpoints: ${msg}`, shouldExit: false };
        }
    },
    '/budget': (ctx, args) => {
        if (!ctx.costTracker) {
            return { output: 'No budget tracking active.', shouldExit: false };
        }
        const parts = args.trim().split(/\s+/);
        if (parts[0] === 'extend' && parts[1]) {
            const amount = parseFloat(parts[1]);
            if (isNaN(amount) || amount <= 0) {
                return { output: 'Usage: /budget extend <positive-number>', shouldExit: false };
            }
            ctx.costTracker.extendSessionBudget(amount);
            const budget = ctx.costTracker.getBudget();
            let output = `Session budget extended by $${amount.toFixed(2)}. New limit: $${budget.session?.toFixed(2) ?? 'none'}`;
            if (budget.daily !== null && ctx.costTracker.getDailyCost() >= budget.daily * 0.8) {
                output += `\nNote: Daily budget ($${budget.daily.toFixed(2)}) may still be the limiting factor.`;
            }
            return { output, shouldExit: false };
        }
        // Default: show budget status
        const budget = ctx.costTracker.getBudget();
        const sessionCost = ctx.costTracker.getSessionCost();
        const dailyCost = ctx.costTracker.getDailyCost();
        const lines = [
            `Session cost:  $${sessionCost.toFixed(4)}`,
            `Session limit: ${budget.session !== null ? '$' + budget.session.toFixed(2) : 'none'}`,
            `Daily cost:    $${dailyCost.toFixed(4)}`,
            `Daily limit:   ${budget.daily !== null ? '$' + budget.daily.toFixed(2) : 'none'}`,
        ];
        return { output: lines.join('\n'), shouldExit: false };
    },
};

/**
 * Try to handle a slash command. Returns null if the input is not a slash command.
 * May return a Promise for async commands (e.g., /undo, /restore, /checkpoints).
 */
export function handleSlashCommand(
    input: string,
    ctx: SlashCommandContext,
): SlashCommandResult | Promise<SlashCommandResult> | null {
    const trimmed = input.trim();
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const handler = commands[cmd];
    if (!handler) return null;
    const args = parts.slice(1).join(' ');
    return handler(ctx, args);
}

/**
 * Returns true if the input looks like a slash command (starts with /).
 */
export function isSlashCommand(input: string): boolean {
    return input.trim().startsWith('/');
}

function createProgressReporter(progressBar: ProgressBar, label: string): (current: number, total: number) => void {
    let active = false;
    return (current: number, total: number): void => {
        if (!active) {
            progressBar.start(label, total);
            active = true;
        }
        progressBar.update(current);
        if (current >= total) {
            progressBar.complete();
            active = false;
        }
    };
}
