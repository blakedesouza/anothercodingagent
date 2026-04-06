import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { TurnEngine } from '../core/turn-engine.js';
import type { TurnEngineConfig } from '../core/turn-engine.js';
import type { SessionProjection } from '../core/session-manager.js';
import type { SessionManager } from '../core/session-manager.js';
import type { ProviderDriver } from '../types/provider.js';
import type { ConversationItem } from '../types/conversation.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { handleSlashCommand, isSlashCommand } from './commands.js';
import type { SlashCommandContext } from './commands.js';
import type { SecretScrubber } from '../permissions/secret-scrubber.js';
import type { CostTracker } from '../observability/cost-tracker.js';
import type { Renderer } from '../rendering/renderer.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';
import type { NetworkPolicy } from '../permissions/network-policy.js';
import type { ResolvedConfig } from '../config/schema.js';
import { SessionGrantStore } from '../permissions/session-grants.js';
import type { Indexer } from '../indexing/indexer.js';
import type { CheckpointManager } from '../checkpointing/checkpoint-manager.js';
import type { CapabilityHealthMap } from '../core/capability-health.js';
import type { MetricsAccumulator } from '../observability/telemetry.js';

export interface ReplOptions {
    projection: SessionProjection;
    sessionManager: SessionManager;
    provider: ProviderDriver;
    toolRegistry: ToolRegistry;
    model: string;
    verbose: boolean;
    workspaceRoot: string;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    stderrOutput?: NodeJS.WritableStream;
    scrubber?: SecretScrubber;
    costTracker?: CostTracker;
    renderer?: Renderer;
    providerRegistry?: ProviderRegistry;
    networkPolicy?: NetworkPolicy;
    resolvedConfig?: ResolvedConfig;
    indexer?: Indexer;
    checkpointManager?: CheckpointManager;
    healthMap?: CapabilityHealthMap;
    metricsAccumulator?: MetricsAccumulator;
}

export class Repl {
    private readonly projection: SessionProjection;
    private readonly sessionManager: SessionManager;
    private readonly provider: ProviderDriver;
    private readonly toolRegistry: ToolRegistry;
    private readonly model: string;
    private readonly verbose: boolean;
    private readonly workspaceRoot: string;
    private readonly stdout: NodeJS.WritableStream;
    private readonly stderr: NodeJS.WritableStream;
    private readonly scrubber?: SecretScrubber;
    private readonly costTracker?: CostTracker;
    private readonly rendererInstance?: Renderer;
    private readonly providerRegistry?: ProviderRegistry;
    private readonly networkPolicy?: NetworkPolicy;
    private readonly resolvedConfig?: ResolvedConfig;
    private readonly indexer?: Indexer;
    private readonly checkpointManager?: CheckpointManager;
    private readonly healthMap?: CapabilityHealthMap;
    private readonly metricsAccumulator?: MetricsAccumulator;
    private readonly sessionGrants = new SessionGrantStore();
    private rl: ReadlineInterface | null = null;
    private turnCount = 0;
    private totalInputTokens = 0;
    private totalOutputTokens = 0;
    private readonly startTime = Date.now();
    private items: ConversationItem[] = [];
    private activeTurn = false;
    private lastSigintTime = 0;
    private currentEngine: TurnEngine | null = null;
    private exitRequested = false;

    constructor(options: ReplOptions) {
        this.projection = options.projection;
        this.sessionManager = options.sessionManager;
        this.provider = options.provider;
        this.toolRegistry = options.toolRegistry;
        this.model = options.model;
        this.verbose = options.verbose;
        this.workspaceRoot = options.workspaceRoot;
        this.stdout = options.output ?? process.stdout;
        this.stderr = options.stderrOutput ?? process.stderr;
        this.scrubber = options.scrubber;
        this.costTracker = options.costTracker;
        this.rendererInstance = options.renderer;
        this.providerRegistry = options.providerRegistry;
        this.networkPolicy = options.networkPolicy;
        this.resolvedConfig = options.resolvedConfig;
        this.indexer = options.indexer;
        this.checkpointManager = options.checkpointManager;
        this.healthMap = options.healthMap;
        this.metricsAccumulator = options.metricsAccumulator;
    }

    async run(inputStream?: NodeJS.ReadableStream): Promise<void> {
        const input = inputStream ?? process.stdin;

        this.rl = createInterface({
            input,
            output: this.stderr,
            prompt: 'aca> ',
            terminal: (input as NodeJS.ReadStream).isTTY ?? false,
        });

        this.setupSigintHandler();

        this.rl.prompt();

        for await (const line of this.rl) {
            if (this.exitRequested) break;

            const trimmed = line.trim();
            if (trimmed === '') {
                this.rl.prompt();
                continue;
            }

            // Slash commands
            if (isSlashCommand(trimmed)) {
                const ctx = this.makeCommandContext();
                const maybeResult = handleSlashCommand(trimmed, ctx);
                if (maybeResult) {
                    const result = await maybeResult;
                    this.writeStderr(result.output + '\n');
                    if (result.shouldExit) break;
                } else {
                    this.writeStderr(`Unknown command: ${trimmed.split(/\s+/)[0]}\n`);
                }
                this.rl.prompt();
                continue;
            }

            // Execute turn
            await this.executeTurn(trimmed);

            if (this.exitRequested) break;
            this.rl.prompt();
        }

        // Clean exit on EOF or exit command
        this.cleanup();
    }

    private async executeTurn(userInput: string): Promise<void> {
        this.activeTurn = true;
        const engine = new TurnEngine(
            this.provider,
            this.toolRegistry,
            this.projection.writer,
            this.projection.sequenceGenerator,
            this.scrubber,
            this.providerRegistry,
            this.costTracker,
            this.networkPolicy,
            this.healthMap,
            this.checkpointManager,
            this.metricsAccumulator,
        );
        this.currentEngine = engine;

        const config: TurnEngineConfig = {
            sessionId: this.projection.manifest.sessionId,
            model: this.model,
            provider: 'nanogpt',
            interactive: true,
            autoConfirm: false,
            isSubAgent: false,
            workspaceRoot: this.workspaceRoot,
            onTextDelta: (text: string) => {
                this.stdout.write(text);
            },
            promptUser: async (question: string, choices?: string[]): Promise<string> => {
                return this.promptUser(question, choices);
            },
            extraTrustedRoots: this.resolvedConfig?.sandbox.extraTrustedRoots,
            resolvedConfig: this.resolvedConfig,
            sessionGrants: this.sessionGrants,
        };

        try {
            const result = await engine.executeTurn(config, userInput, this.items);
            this.items.push(...result.items);
            this.turnCount++;

            // Accumulate token usage
            for (const step of result.steps) {
                this.totalInputTokens += step.tokenUsage.inputTokens;
                this.totalOutputTokens += step.tokenUsage.outputTokens;
            }

            // Persist manifest at turn boundary
            this.projection.manifest.turnCount = this.turnCount;
            this.projection.manifest.lastActivityTimestamp = new Date().toISOString();
            this.sessionManager.saveManifest(this.projection);

            // Ensure newline after streamed output
            this.stdout.write('\n');

            if (this.verbose) {
                this.writeStderr(
                    `[turn ${this.turnCount}] outcome=${result.turn.outcome} steps=${result.steps.length}\n`,
                );
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.writeStderr(`Error: ${msg}\n`);
        } finally {
            this.activeTurn = false;
            this.currentEngine = null;
        }
    }

    private promptUser(question: string, choices?: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.rl) {
                reject(new Error('REPL not active'));
                return;
            }
            let prompt = question;
            if (choices && choices.length > 0) {
                prompt += ` (${choices.join('/')})`;
            }
            prompt += ' ';
            this.rl.question(prompt, (answer: string) => {
                resolve(answer);
            });
        });
    }

    private setupSigintHandler(): void {
        if (!this.rl) return;
        this.rl.on('SIGINT', () => {
            const now = Date.now();
            if (this.activeTurn && this.currentEngine) {
                if (now - this.lastSigintTime < 2000) {
                    // Double SIGINT during turn → abort
                    this.currentEngine.interrupt('abort');
                    this.lastSigintTime = 0;
                } else {
                    // First SIGINT during turn → cancel
                    this.currentEngine.interrupt('cancel');
                    this.lastSigintTime = now;
                }
            } else if (this.rl) {
                // SIGINT during idle → clear line and re-prompt
                this.rl.write('', { ctrl: true, name: 'u' });
                this.writeStderr('\n');
                this.rl.prompt();
            }
        });
    }

    private makeCommandContext(): SlashCommandContext {
        return {
            projection: this.projection,
            model: this.model,
            turnCount: this.turnCount,
            totalInputTokens: this.totalInputTokens,
            totalOutputTokens: this.totalOutputTokens,
            exit: () => {
                this.exitRequested = true;
            },
            costTracker: this.costTracker,
            indexer: this.indexer,
            checkpointManager: this.checkpointManager,
            promptUser: (question: string) => this.promptUser(question),
        };
    }

    private writeStderr(text: string): void {
        this.stderr.write(text);
    }

    /** Total input tokens accumulated across all turns. */
    getTotalInputTokens(): number {
        return this.totalInputTokens;
    }

    /** Total output tokens accumulated across all turns. */
    getTotalOutputTokens(): number {
        return this.totalOutputTokens;
    }

    /** Session duration in milliseconds since REPL construction. */
    getDurationMs(): number {
        return Date.now() - this.startTime;
    }

    private cleanup(): void {
        if (this.rl) {
            this.rl.close();
            this.rl = null;
        }
    }
}
