#!/usr/bin/env node

/**
 * ACA CLI entry point.
 *
 * Wires all modules together: config → secrets → provider → tools → sandbox →
 * approval → scrubber → renderer → event sink → cost tracker → REPL.
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

// --- Core ---
import { SessionManager } from './core/session-manager.js';
import { Repl } from './cli/repl.js';
import { validateRequiredOutputPaths } from './cli/invoke-output-validation.js';
import { TurnEngine } from './core/turn-engine.js';
import type { TurnEngineConfig } from './core/turn-engine.js';
import { buildInvokeSystemMessages } from './core/prompt-assembly.js';
import { buildProjectSnapshot } from './core/project-awareness.js';

// --- Config ---
import { loadConfig } from './config/loader.js';
import { loadSecrets } from './config/secrets.js';
import { serializeWitnessConfigs } from './config/witness-models.js';

// --- Providers ---
import { NanoGptDriver } from './providers/nanogpt-driver.js';
import { NanoGptCatalog, StaticCatalog } from './providers/model-catalog.js';

// --- Tools ---
import { ToolRegistry } from './tools/tool-registry.js';
import { readFileSpec, readFileImpl } from './tools/read-file.js';
import { writeFileSpec, writeFileImpl } from './tools/write-file.js';
import { editFileSpec, editFileImpl } from './tools/edit-file.js';
import { deletePathSpec, deletePathImpl } from './tools/delete-path.js';
import { movePathSpec, movePathImpl } from './tools/move-path.js';
import { makeDirectorySpec, makeDirectoryImpl } from './tools/make-directory.js';
import { statPathSpec, statPathImpl } from './tools/stat-path.js';
import { findPathsSpec, findPathsImpl } from './tools/find-paths.js';
import { searchTextSpec, searchTextImpl } from './tools/search-text.js';
import { execCommandSpec, execCommandImpl } from './tools/exec-command.js';
import { openSessionSpec, openSessionImpl } from './tools/open-session.js';
import { sessionIoSpec, sessionIoImpl } from './tools/session-io.js';
import { closeSessionSpec, closeSessionImpl } from './tools/close-session.js';
import { askUserSpec, askUserImpl } from './tools/ask-user.js';
import { confirmActionSpec, confirmActionImpl } from './tools/confirm-action.js';
import { estimateTokensSpec, estimateTokensImpl } from './tools/estimate-tokens.js';
import { searchSemanticSpec, createSearchSemanticImpl } from './tools/search-semantic.js';

// --- Indexing ---
import { EmbeddingModel } from './indexing/embedding.js';
import { IndexStore } from './indexing/index-store.js';
import { Indexer } from './indexing/indexer.js';
import { deriveWorkspaceId } from './core/session-manager.js';

// --- Checkpointing ---
import { CheckpointManager } from './checkpointing/checkpoint-manager.js';

// --- Error Recovery / Health ---
import { CapabilityHealthMap } from './core/capability-health.js';

// --- Delegation ---
import { AgentRegistry } from './delegation/agent-registry.js';
import {
    DelegationTracker,
    DEFAULT_DELEGATION_LIMITS,
    spawnAgentSpec,
    createSpawnAgentImpl,
} from './delegation/spawn-agent.js';
import type { SpawnCallerContext } from './delegation/spawn-agent.js';
import { messageAgentSpec, createMessageAgentImpl } from './delegation/message-agent.js';
import { awaitAgentSpec, createAwaitAgentImpl } from './delegation/await-agent.js';
import type { AgentIdentity } from './types/agent.js';
import type { AgentId } from './types/ids.js';
import { generateId } from './types/ids.js';

// --- LSP ---
import { LspManager } from './lsp/lsp-manager.js';
import { lspQuerySpec, createLspQueryImpl } from './tools/lsp-query.js';

// --- Browser ---
import { BrowserManager } from './browser/browser-manager.js';
import { BROWSER_TOOL_SPECS, createBrowserToolImpls } from './browser/browser-tools.js';

// --- Web Tools ---
import { webSearchSpec, createWebSearchImpl, TavilySearchProvider } from './tools/web-search.js';
import { fetchUrlSpec, createFetchUrlImpl } from './tools/fetch-url.js';
import {
    fetchMediaWikiPageSpec,
    fetchMediaWikiCategorySpec,
    createFetchMediaWikiPageImpl,
    createFetchMediaWikiCategoryImpl,
} from './tools/fetch-mediawiki-page.js';
import { lookupDocsSpec, createLookupDocsImpl } from './tools/lookup-docs.js';

// --- Rendering ---
import { detectCapabilities } from './rendering/terminal-capabilities.js';
import { OutputChannel } from './rendering/output-channel.js';
import { Renderer } from './rendering/renderer.js';

// --- Permissions ---
import { SecretScrubber } from './permissions/secret-scrubber.js';
import type { NetworkPolicy } from './permissions/network-policy.js';

// --- Observability ---
import { CostTracker } from './observability/cost-tracker.js';
import { SqliteStore } from './observability/sqlite-store.js';
import { BackgroundWriter } from './observability/background-writer.js';
import { JsonlEventSink, createEvent } from './core/event-sink.js';
import { TelemetryExporter, MetricsAccumulator } from './observability/telemetry.js';

// --- Providers ---
import { ProviderRegistry } from './providers/provider-registry.js';

// --- CLI commands ---
import { runStats } from './cli/stats.js';
import { runInit, runConfigure, runTrust, runUntrust } from './cli/setup.js';
import { runConsult } from './cli/consult.js';
import { startServer } from './mcp/server.js';
import {
    runDescribe,
    readStdin,
    parseInvokeRequest,
    buildErrorResponse,
    buildSuccessResponse,
    EXIT_SUCCESS,
    EXIT_RUNTIME,
    EXIT_PROTOCOL,
    type InvokeSafety,
} from './cli/executor.js';
import { createInterface } from 'node:readline';
import { SessionGrantStore } from './permissions/session-grants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
}

const program = new Command();

// --- Exit codes (Block 10) ---
const EXIT_ONESHOT_SUCCESS = 0;
const EXIT_ONESHOT_RUNTIME = 1;
const EXIT_ONESHOT_CANCELLED = 2;
const EXIT_ONESHOT_USAGE = 3;
const EXIT_ONESHOT_STARTUP = 4;

// --- Session ID pattern for resume disambiguation ---
const SESSION_ID_RE = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/i;

// --- TurnOutcome → exit code mapping ---
function outcomeToExitCode(outcome: string): number {
    switch (outcome) {
        case 'assistant_final':
        case 'awaiting_user':
            return EXIT_ONESHOT_SUCCESS;
        case 'cancelled':
            return EXIT_ONESHOT_CANCELLED;
        default:
            // aborted, max_steps, tool_error, budget_exceeded, etc.
            return EXIT_ONESHOT_RUNTIME;
    }
}

function finiteNumberInRange(value: unknown, min: number, max: number): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    if (value < min || value > max) return undefined;
    return value;
}

function parseThinkingMode(value: unknown): { type: 'enabled' | 'disabled' } | undefined {
    if (value === 'enabled' || value === 'disabled') return { type: value };
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const type = (value as { type?: unknown }).type;
        if (type === 'enabled' || type === 'disabled') return { type };
    }
    return undefined;
}

interface MainOptions {
    model: string;
    verbose: boolean;
    confirm: boolean; // Commander: --no-confirm sets this to false (default true)
    resume?: string | true;
}

program
    .name('aca')
    .description('Another Coding Agent — an AI-powered coding assistant')
    .version(getVersion())
    .option('--model <model>', 'Model to use', 'qwen/qwen3-coder-next')
    .option('--verbose', 'Enable debug output on stderr', false)
    .option('--no-confirm', 'Auto-approve confirmation prompts')
    .option('-r, --resume [session]', 'Resume session (latest for workspace, or specific ID)')
    .argument('[prompt]', 'One-shot prompt (non-interactive mode)')
    .action(async (prompt: string | undefined, options: MainOptions) => {
        const isTTY = process.stdin.isTTY ?? false;

        // --- Resolve --resume disambiguation ---
        // If --resume value doesn't match session ID pattern, treat it as the prompt
        let resumeSessionId: string | undefined;
        let resumeLatest = false;
        let task = prompt;

        if (options.resume !== undefined) {
            if (typeof options.resume === 'string') {
                if (SESSION_ID_RE.test(options.resume)) {
                    resumeSessionId = options.resume;
                } else {
                    // Not a session ID — treat as task prompt, resume latest
                    if (task !== undefined) {
                        process.stderr.write('Error: ambiguous — both --resume value and positional prompt provided\n');
                        process.exit(EXIT_ONESHOT_USAGE);
                    }
                    task = options.resume;
                    resumeLatest = true;
                }
            } else {
                // --resume with no value → resume latest
                resumeLatest = true;
            }
        }

        // --- Detect one-shot vs interactive ---
        const wantsResume = resumeLatest || resumeSessionId !== undefined;

        // Read piped input as task text (only when no positional prompt)
        if (!isTTY && task === undefined) {
            try {
                task = (await readStdin()).trim();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`Error reading stdin: ${msg}\n`);
                process.exit(EXIT_ONESHOT_USAGE);
            }
            if (!task) {
                process.stderr.write('Error: empty input from stdin\n');
                process.exit(EXIT_ONESHOT_USAGE);
            }
        }

        // No TTY, no task, resume without task → error
        if (!isTTY && !task && wantsResume) {
            process.stderr.write('Error: --resume without TTY requires a task (pipe or positional)\n');
            process.exit(EXIT_ONESHOT_USAGE);
        }

        const isOneShot = task !== undefined;

        const cwd = process.cwd();

        // --- Load config ---
        const configResult = await loadConfig({ workspaceRoot: cwd });
        const config = configResult.config;

        if (options.verbose && configResult.warnings.length > 0) {
            for (const w of configResult.warnings) {
                process.stderr.write(`[config] ${w}\n`);
            }
        }

        // --- Load secrets (env → ~/.aca/secrets.json → ~/.api_keys) ---
        const secretsResult = await loadSecrets();
        const apiKey = secretsResult.secrets.nanogpt;

        if (!apiKey || apiKey.trim() === '') {
            process.stderr.write(
                'Error: No NanoGPT API key found.\n' +
                'Set NANOGPT_API_KEY env var, add to ~/.aca/secrets.json, or add to ~/.api_keys\n',
            );
            process.exit(4);
        }

        if (secretsResult.warnings.length > 0) {
            for (const w of secretsResult.warnings) {
                process.stderr.write(`[secrets] ${w}\n`);
            }
        }

        // --- Create model catalog + provider + registry ---
        const catalog = new NanoGptCatalog({
            apiKey,
            fallback: new StaticCatalog(),
        });
        await catalog.fetch();
        const provider = new NanoGptDriver({ apiKey, timeout: config.apiTimeout, catalog });

        if (options.verbose) {
            const modelEntry = catalog.getModel(options.model);
            if (modelEntry) {
                process.stderr.write(
                    `[catalog] ${options.model}: context=${modelEntry.contextLength} maxOutput=${modelEntry.maxOutputTokens}\n`,
                );
            } else {
                process.stderr.write(
                    `[catalog] ${options.model}: not found in catalog, using static defaults\n`,
                );
            }
        }

        const providerRegistry = new ProviderRegistry();
        providerRegistry.register(provider, {
            name: 'nanogpt',
            driver: 'nanogpt',
            baseUrl: '',
            timeout: config.apiTimeout,
            priority: 1,
        });

        // --- Create scrubber ---
        const scrubber = new SecretScrubber(
            Object.values(secretsResult.secrets),
            config.scrubbing,
        );

        // --- Open SQLite observability store ---
        const dbPath = join(homedir(), '.aca', 'observability.db');
        mkdirSync(join(homedir(), '.aca'), { recursive: true });
        const sqliteStore = new SqliteStore(dbPath, (msg) => process.stderr.write(`[sqlite] ${msg}\n`));
        const sqliteOk = sqliteStore.open();
        if (!sqliteOk) {
            process.stderr.write(
                '[warn] SQLite observability store failed to open. ' +
                'Session analytics and daily budget tracking are unavailable.\n',
            );
        }

        // --- Network policy from config ---
        const networkPolicy: NetworkPolicy = {
            mode: config.network.mode,
            allowDomains: config.network.allowDomains,
            denyDomains: config.network.denyDomains,
            allowHttp: config.network.allowHttp,
        };

        // --- Capability health tracker (M7.13) ---
        const healthMap = new CapabilityHealthMap();

        // --- LSP Manager (M7.3) ---
        const lspManager = new LspManager({ workspaceRoot: cwd, healthMap });

        // --- Browser Manager (M7.4) ---
        const browserManager = new BrowserManager({ healthMap, networkPolicy });

        // --- Search provider (M7.5 — Tavily, optional) ---
        const tavilyKey = secretsResult.secrets.tavily;
        const searchProvider = tavilyKey ? new TavilySearchProvider(tavilyKey) : undefined;

        // --- Initialize indexing ---
        const workspaceId = deriveWorkspaceId(cwd);
        const indexDbPath = join(homedir(), '.aca', 'indexes', workspaceId, 'index.db');
        const indexStore = new IndexStore(indexDbPath, (msg) => process.stderr.write(`[index] ${msg}\n`));
        if (!indexStore.open()) {
            process.stderr.write(
                '[index] Warning: Could not open index database. ' +
                'Semantic search will be unavailable.\n',
            );
        }

        const embeddingModel = new EmbeddingModel();
        // Await embedding init so the indexer has real embeddings (not nulls)
        try {
            await embeddingModel.initialize();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[embedding] Init failed: ${msg}. Indexing will proceed without embeddings.\n`);
        }

        const indexer = new Indexer(cwd, indexStore, embeddingModel, undefined, (msg) => {
            if (options.verbose) process.stderr.write(`[indexer] ${msg}\n`);
        });

        // Kick off background indexing (non-blocking)
        indexer.buildIndexBackground().then(
            (result) => {
                if (options.verbose) {
                    process.stderr.write(
                        `[indexer] Index built: ${result.filesIndexed} files, ` +
                        `${result.warnings.length} warnings\n`,
                    );
                }
            },
            (err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[indexer] Background indexing failed: ${msg}\n`);
            },
        );

        // --- Register all tools ---
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(readFileSpec, readFileImpl);
        toolRegistry.register(writeFileSpec, writeFileImpl);
        toolRegistry.register(editFileSpec, editFileImpl);
        toolRegistry.register(deletePathSpec, deletePathImpl);
        toolRegistry.register(movePathSpec, movePathImpl);
        toolRegistry.register(makeDirectorySpec, makeDirectoryImpl);
        toolRegistry.register(statPathSpec, statPathImpl);
        toolRegistry.register(findPathsSpec, findPathsImpl);
        toolRegistry.register(searchTextSpec, searchTextImpl);
        toolRegistry.register(execCommandSpec, execCommandImpl);
        toolRegistry.register(openSessionSpec, openSessionImpl);
        toolRegistry.register(sessionIoSpec, sessionIoImpl);
        toolRegistry.register(closeSessionSpec, closeSessionImpl);
        toolRegistry.register(askUserSpec, askUserImpl);
        toolRegistry.register(confirmActionSpec, confirmActionImpl);
        toolRegistry.register(estimateTokensSpec, estimateTokensImpl);
        toolRegistry.register(searchSemanticSpec, createSearchSemanticImpl({
            indexer,
            store: indexStore,
            embedding: embeddingModel,
        }));

        // --- Register LSP tool (M7.3) ---
        toolRegistry.register(lspQuerySpec, createLspQueryImpl({ lspManager }));

        // --- Register browser tools (M7.4) ---
        const browserToolImpls = createBrowserToolImpls({ manager: browserManager, networkPolicy });
        for (const spec of BROWSER_TOOL_SPECS) {
            const impl = browserToolImpls.get(spec.name);
            if (impl) {
                toolRegistry.register(spec, impl);
            }
        }

        // --- Register web tools (M7.5) ---
        toolRegistry.register(webSearchSpec, createWebSearchImpl({ searchProvider, networkPolicy }));
        toolRegistry.register(fetchUrlSpec, createFetchUrlImpl({ networkPolicy, browserManager }));
        toolRegistry.register(fetchMediaWikiPageSpec, createFetchMediaWikiPageImpl({ networkPolicy }));
        toolRegistry.register(fetchMediaWikiCategorySpec, createFetchMediaWikiCategoryImpl({ networkPolicy }));
        toolRegistry.register(lookupDocsSpec, createLookupDocsImpl({ searchProvider, networkPolicy, browserManager }));

        // --- Agent Registry + Delegation (M7.1a-c, M7.2) ---
        const registryResult = AgentRegistry.resolve(toolRegistry);
        if (options.verbose && registryResult.warnings.length > 0) {
            for (const w of registryResult.warnings) {
                process.stderr.write(`[delegation] ${w}\n`);
            }
        }
        const agentRegistry = registryResult.registry;
        const delegationTracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);

        // --- Create or resume session ---
        const sessionsDir = join(homedir(), '.aca', 'sessions');
        mkdirSync(sessionsDir, { recursive: true });
        const sessionManager = new SessionManager(sessionsDir);

        let projection: import('./core/session-manager.js').SessionProjection;
        let existingItems: import('./types/conversation.js').ConversationItem[] = [];

        if (wantsResume) {
            let targetId = resumeSessionId;
            if (!targetId) {
                const latestId = sessionManager.findLatestForWorkspace(workspaceId);
                if (!latestId) {
                    process.stderr.write('Error: no previous session found for this workspace\n');
                    process.exit(EXIT_ONESHOT_STARTUP);
                }
                targetId = latestId;
            }
            try {
                const resumed = sessionManager.resume(targetId as import('./types/ids.js').SessionId);
                projection = resumed.projection;
                existingItems = [...projection.items];
                if (options.verbose) {
                    process.stderr.write(`[debug] Resumed session ${targetId}\n`);
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`Error: failed to resume session: ${msg}\n`);
                process.exit(EXIT_ONESHOT_STARTUP);
            }
        } else {
            projection = sessionManager.create(cwd, {
                model: options.model,
                verbose: options.verbose,
            });
        }

        // --- Register delegation tools (M7.1b, M7.1c) — needs sessionId ---
        const rootAgentId = generateId('agent') as AgentId;
        const rootIdentity: AgentIdentity = {
            id: rootAgentId,
            parentAgentId: null,
            rootAgentId,
            depth: 0,
            spawnIndex: 0,
            label: 'root',
        };
        const spawnCallerContext: SpawnCallerContext = {
            callerIdentity: rootIdentity,
            callerSessionId: projection.manifest.sessionId,
            rootSessionId: projection.manifest.sessionId,
            callerPreauths: config.permissions.preauth,
            callerAuthority: config.permissions.preauth,
            callerTools: toolRegistry.list().map(t => t.spec.name),
        };
        toolRegistry.register(
            spawnAgentSpec,
            createSpawnAgentImpl(
                {
                    agentRegistry,
                    delegationTracker,
                    limits: DEFAULT_DELEGATION_LIMITS,
                    createChildSession: () => {
                        const child = sessionManager.create(cwd, {
                            model: options.model,
                            mode: 'sub-agent',
                        });
                        return child.manifest.sessionId;
                    },
                },
                spawnCallerContext,
            ),
        );
        toolRegistry.register(messageAgentSpec, createMessageAgentImpl({ delegationTracker }));
        toolRegistry.register(awaitAgentSpec, createAwaitAgentImpl({ delegationTracker }));

        // --- Create cost tracker (with real daily baseline from SQLite) ---
        const dailyBaseline = sqliteStore.isOpen()
            ? sqliteStore.getDailyCostExcludingSession(projection.manifest.sessionId)
            : 0;
        const costTracker = new CostTracker(
            { ...config.budget },
            dailyBaseline,
            (msg: string) => process.stderr.write(`${msg}\n`),
        );

        // --- Wire event sinks (JSONL + SQLite background writer) ---
        const eventsPath = join(projection.sessionDir, 'events.jsonl');
        const jsonlSink = new JsonlEventSink(eventsPath);
        const bgWriter = new BackgroundWriter(sqliteStore);

        // Emit session.started event (used for both new and resumed sessions)
        const sessionStartEvent = createEvent(
            'session.started',
            projection.manifest.sessionId,
            0,
            'aca',
            {
                workspace_id: projection.manifest.workspaceId,
                model: options.model,
                provider: 'nanogpt',
            },
        );
        jsonlSink.emit(sessionStartEvent);
        bgWriter.emit(sessionStartEvent);

        // --- Wire metrics accumulator + telemetry exporter (opt-in) ---
        const metricsAccumulator = new MetricsAccumulator();
        const telemetryExporter = new TelemetryExporter(
            config.telemetry,
            () => metricsAccumulator.snapshot(),
            (text) => scrubber.scrub(text),
        );
        telemetryExporter.start();

        // --- Register signal handler for graceful shutdown ---
        const cleanupResources = async () => {
            try { telemetryExporter.stop(); } catch { /* best-effort */ }
            try { bgWriter.shutdown(); } catch { /* best-effort */ }
            await lspManager.dispose().catch(() => {});
            await browserManager.dispose().catch(() => {});
            await embeddingModel.dispose().catch(() => {});
            try { indexStore.close(); } catch { /* best-effort */ }
            try { sqliteStore.close(); } catch { /* best-effort */ }
        };
        const handleSignal = () => {
            cleanupResources().then(() => process.exit(0), () => process.exit(1));
        };
        process.on('SIGTERM', handleSignal);
        process.on('SIGINT', handleSignal);

        // --- Initialize checkpointing ---
        const checkpointManager = new CheckpointManager(cwd, projection.manifest.sessionId);
        try {
            await checkpointManager.init();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (options.verbose) {
                process.stderr.write(`[checkpoint] Init failed: ${msg}. Checkpointing disabled.\n`);
            }
        }

        if (isOneShot) {
            // =====================================================
            // ONE-SHOT MODE
            // =====================================================
            if (options.verbose) {
                process.stderr.write(`[one-shot] Task: ${task!.slice(0, 100)}${task!.length > 100 ? '...' : ''}\n`);
            }

            // Build promptUser for TTY-based approval prompts
            let promptUser: ((question: string, choices?: string[]) => Promise<string>) | undefined;
            if (isTTY) {
                promptUser = (question: string, choices?: string[]) => {
                    return new Promise((resolve) => {
                        const rl = createInterface({
                            input: process.stdin,
                            output: process.stderr,
                            terminal: true,
                        });
                        let resolved = false;
                        const done = (answer: string) => {
                            if (resolved) return;
                            resolved = true;
                            rl.close();
                            resolve(answer);
                        };
                        // Handle unexpected close (SIGINT, terminal hangup)
                        rl.on('close', () => done(''));
                        let prompt = question;
                        if (choices && choices.length > 0) {
                            prompt += ` (${choices.join('/')})`;
                        }
                        prompt += ' ';
                        rl.question(prompt, done);
                    });
                };
            }

            const engine = new TurnEngine(
                provider,
                toolRegistry,
                projection.writer,
                projection.sequenceGenerator,
                scrubber,
                providerRegistry,
                costTracker,
                networkPolicy,
                healthMap,
                checkpointManager,
                metricsAccumulator,
            );

            const turnConfig: TurnEngineConfig = {
                sessionId: projection.manifest.sessionId,
                model: options.model,
                provider: 'nanogpt',
                interactive: false, // 30-step limit, no consecutive tool cap
                autoConfirm: !options.confirm, // --no-confirm → confirm=false → autoConfirm=true
                isSubAgent: false,
                workspaceRoot: cwd,
                onTextDelta: (text: string) => {
                    process.stdout.write(text);
                },
                promptUser,
                extraTrustedRoots: config.sandbox?.extraTrustedRoots,
                resolvedConfig: config,
                sessionGrants: new SessionGrantStore(),
            };

            const startTime = Date.now();
            let exitCode = EXIT_ONESHOT_SUCCESS;
            let totalInputTokens = 0;
            let totalOutputTokens = 0;

            try {
                const result = await engine.executeTurn(turnConfig, task!, existingItems);

                // Ensure trailing newline after streamed output
                process.stdout.write('\n');

                exitCode = outcomeToExitCode(result.turn.outcome ?? 'assistant_final');

                // Accumulate token usage
                for (const step of result.steps) {
                    totalInputTokens += step.tokenUsage.inputTokens;
                    totalOutputTokens += step.tokenUsage.outputTokens;
                }

                if (options.verbose) {
                    process.stderr.write(
                        `[one-shot] outcome=${result.turn.outcome} steps=${result.steps.length} ` +
                        `tokens_in=${totalInputTokens} tokens_out=${totalOutputTokens}\n`,
                    );
                }

                // Non-success outcomes: write diagnostic to stderr
                if (result.turn.outcome === 'max_steps') {
                    process.stderr.write(`Error: step limit reached (${result.steps.length} steps)\n`);
                } else if (result.turn.outcome === 'budget_exceeded') {
                    process.stderr.write('Error: budget exceeded\n');
                } else if (result.turn.outcome === 'aborted') {
                    if (result.lastError?.code === 'llm.auth_error') {
                        process.stderr.write('Error: API key is invalid or unauthorized.\n');
                        exitCode = EXIT_ONESHOT_STARTUP;
                    } else {
                        process.stderr.write(
                            `Error: LLM request failed (${result.lastError?.code ?? 'unknown'}).` +
                            (options.verbose ? '' : ' Use --verbose for details.') + '\n',
                        );
                    }
                } else if (result.turn.outcome === 'cancelled') {
                    process.stderr.write('Cancelled\n');
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`Error: ${msg}\n`);
                exitCode = EXIT_ONESHOT_RUNTIME;
            } finally {
                // Always persist manifest and emit session.ended, even on error
                projection.manifest.turnCount = (projection.manifest.turnCount ?? 0) + 1;
                projection.manifest.lastActivityTimestamp = new Date().toISOString();
                try {
                    sessionManager.saveManifest(projection);
                } catch {
                    // Best-effort manifest save
                }

                const sessionEndEvent = createEvent(
                    'session.ended',
                    projection.manifest.sessionId,
                    0,
                    'aca',
                    {
                        total_turns: projection.manifest.turnCount,
                        total_tokens_in: totalInputTokens,
                        total_tokens_out: totalOutputTokens,
                        duration_ms: Date.now() - startTime,
                    },
                );
                jsonlSink.emit(sessionEndEvent);
                bgWriter.emit(sessionEndEvent);
            }

            await cleanupResources();
            process.exit(exitCode);
        } else {
            // =====================================================
            // INTERACTIVE MODE
            // =====================================================

            // --- Detect terminal capabilities ---
            const termCaps = detectCapabilities();
            const outputChannel = new OutputChannel({
                capabilities: termCaps,
                mode: 'interactive',
            });
            const renderer = new Renderer({ output: outputChannel, verbose: options.verbose });

            // --- Display startup status ---
            const version = getVersion();
            renderer.startup({
                version,
                model: options.model,
                provider: 'nanogpt',
                workspace: cwd,
            });

            if (options.verbose) {
                process.stderr.write(`[debug] Workspace: ${cwd}\n`);
                process.stderr.write(`[debug] Sessions dir: ${sessionsDir}\n`);
                process.stderr.write(`[debug] Config sources: user=${configResult.sources.user} project=${configResult.sources.project}\n`);
                process.stderr.write(`[debug] Tools: ${toolRegistry.list().map(t => t.spec.name).join(', ')}\n`);
            }

            // --- Enter REPL ---
            const repl = new Repl({
                projection,
                sessionManager,
                provider,
                toolRegistry,
                model: options.model,
                verbose: options.verbose,
                workspaceRoot: cwd,
                scrubber,
                costTracker,
                renderer,
                providerRegistry,
                networkPolicy,
                resolvedConfig: config,
                indexer,
                checkpointManager,
                healthMap,
                metricsAccumulator,
            });

            await repl.run();

            // --- Emit session.ended before cleanup ---
            const sessionEndEvent = createEvent(
                'session.ended',
                projection.manifest.sessionId,
                0,
                'aca',
                {
                    total_turns: projection.manifest.turnCount,
                    total_tokens_in: repl.getTotalInputTokens(),
                    total_tokens_out: repl.getTotalOutputTokens(),
                    duration_ms: repl.getDurationMs(),
                },
            );
            jsonlSink.emit(sessionEndEvent);
            bgWriter.emit(sessionEndEvent);

            // --- Cleanup on exit ---
            await cleanupResources();
        }
    });

program
    .command('stats')
    .description('Show session analytics and usage statistics')
    .option('--session <id>', 'Show per-turn breakdown for a specific session')
    .option('--today', 'Show today\'s usage and remaining daily budget')
    .option('--json', 'Output as JSON')
    .action((options: { session?: string; today?: boolean; json?: boolean }) => {
        const output = runStats(options);
        process.stdout.write(output + '\n');
    });

program
    .command('init')
    .description('Initialize ~/.aca/ directory structure with config and secrets')
    .action(async () => {
        const result = await runInit();
        process.stdout.write(result.message + '\n');
        process.exit(result.success ? 0 : 1);
    });

program
    .command('configure')
    .description('Interactive configuration wizard')
    .action(async () => {
        try {
            const result = await runConfigure();
            process.stdout.write(result.message + '\n');
            process.exit(result.success ? 0 : 1);
        } catch (err: unknown) {
            if ((err as Error).name === 'ExitPromptError') {
                process.stderr.write('Configuration cancelled.\n');
                process.exit(2);
            }
            throw err;
        }
    });

program
    .command('trust [path]')
    .description('Mark a workspace as trusted')
    .action(async (path: string | undefined) => {
        const result = await runTrust(path);
        process.stdout.write(result.message + '\n');
        process.exit(result.success ? 0 : 1);
    });

program
    .command('untrust [path]')
    .description('Remove workspace trust')
    .action(async (path: string | undefined) => {
        const result = await runUntrust(path);
        process.stdout.write(result.message + '\n');
        process.exit(result.success ? 0 : 1);
    });

// --- Static tool names for describe (fast path — no registry loading needed) ---
const TOOL_NAMES = [
    'read_file', 'write_file', 'edit_file', 'delete_path', 'move_path',
    'make_directory', 'stat_path', 'find_paths', 'search_text',
    'exec_command', 'open_session', 'session_io', 'close_session',
    'ask_user', 'confirm_action', 'estimate_tokens', 'search_semantic',
    'lsp_query',
    'browser_navigate', 'browser_click', 'browser_type', 'browser_press',
    'browser_snapshot', 'browser_screenshot', 'browser_evaluate',
    'browser_extract', 'browser_wait', 'browser_close',
    'web_search', 'fetch_url', 'fetch_mediawiki_page', 'fetch_mediawiki_category', 'lookup_docs',
    'spawn_agent', 'message_agent', 'await_agent',
];

program
    .command('serve')
    .description('Start ACA as an MCP server on stdio transport')
    .action(async () => {
        await startServer();
    });

program
    .command('describe')
    .description('Output capability descriptor as JSON (delegation contract)')
    .action(() => {
        process.stdout.write(runDescribe(TOOL_NAMES) + '\n');
        process.exit(0);
    });

program
    .command('witnesses')
    .description('Output witness model configurations as JSON')
    .action(() => {
        process.stdout.write(serializeWitnessConfigs() + '\n');
        process.exit(0);
    });

program
    .command('consult')
    .description('Run ACA-native bounded witness consultation')
    .option('--question <question>', 'Question to ask witnesses')
    .option('--prompt-file <path>', 'Prompt file to use instead of --question')
    .option('--project-dir <path>', 'Project directory', process.cwd())
    .option('--witnesses <list>', 'Comma-separated witness list, or all', 'all')
    .option('--pack-repo', 'Build an evidence pack from the repo', false)
    .option('--pack-path <path>', 'File or directory to include in the evidence pack', (value, previous: string[]) => [...previous, value], [])
    .option('--pack-max-files <n>', 'Maximum evidence-pack files', value => Number(value), 5)
    .option('--pack-max-file-bytes <n>', 'Maximum bytes per packed file', value => Number(value), 8_000)
    .option('--pack-max-total-bytes <n>', 'Maximum total evidence-pack bytes', value => Number(value), 240_000)
    .option('--max-context-snippets <n>', 'Maximum witness-requested snippets', value => Number(value), 3)
    .option('--max-context-lines <n>', 'Maximum lines per witness-requested snippet', value => Number(value), 120)
    .option('--max-context-bytes <n>', 'Maximum bytes per witness-requested snippet', value => Number(value), 8_000)
    .option('--skip-triage', 'Skip triage aggregation', false)
    .option('--out <path>', 'Write result JSON to this path')
    .action(async (options: {
        question?: string;
        promptFile?: string;
        projectDir: string;
        witnesses: string;
        packRepo: boolean;
        packPath: string[];
        packMaxFiles: number;
        packMaxFileBytes: number;
        packMaxTotalBytes: number;
        maxContextSnippets: number;
        maxContextLines: number;
        maxContextBytes: number;
        skipTriage: boolean;
        out?: string;
    }) => {
        if (Boolean(options.question) === Boolean(options.promptFile)) {
            process.stderr.write('Pass exactly one of --question or --prompt-file\n');
            process.exit(EXIT_ONESHOT_USAGE);
        }
        try {
            const result = await runConsult(options);
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
            process.exit(result.degraded ? EXIT_ONESHOT_RUNTIME : EXIT_ONESHOT_SUCCESS);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`consult failed: ${message}\n`);
            process.exit(EXIT_ONESHOT_RUNTIME);
        }
    });

program
    .command('invoke')
    .description('Execute structured task from stdin as JSON (delegation contract)')
    .action(async () => {
        // EPIPE handler: if the MCP server (pipe reader) dies, exit cleanly
        // instead of crashing with an unhandled 'error' event on stdout.
        process.stdout.on('error', () => process.exit(0));

        // Read all of stdin
        const raw = await readStdin().catch(() => null);
        if (raw === null) {
            process.stdout.write(JSON.stringify(
                buildErrorResponse('protocol.malformed_request', 'Failed to read stdin'),
            ) + '\n');
            process.exit(EXIT_PROTOCOL);
        }

        // Parse and validate the request
        const parsed = parseInvokeRequest(raw);
        if ('error' in parsed) {
            process.stdout.write(JSON.stringify(parsed.error) + '\n');
            process.exit(parsed.exitCode);
        }
        const request = parsed.request;

        // --- Minimal startup for invoke (no renderer, no REPL) ---
        const cwd = process.cwd();

        const configResult = await loadConfig({ workspaceRoot: cwd }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            process.stdout.write(JSON.stringify(
                buildErrorResponse('system.config_error', `Startup failed: ${msg}`),
            ) + '\n');
            process.exit(EXIT_RUNTIME);
        });
        const config = configResult.config;
        const secretsResult = await loadSecrets().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            process.stdout.write(JSON.stringify(
                buildErrorResponse('system.config_error', `Secrets loading failed: ${msg}`),
            ) + '\n');
            process.exit(EXIT_RUNTIME);
        });

        const apiKey = secretsResult.secrets.nanogpt;
        if (!apiKey || apiKey.trim() === '') {
            process.stdout.write(JSON.stringify(
                buildErrorResponse('system.config_error', 'No NanoGPT API key found'),
            ) + '\n');
            process.exit(EXIT_RUNTIME);
        }

        // --- Provider (with live catalog for real model limits) ---
        const catalog = new NanoGptCatalog({
            apiKey,
            fallback: new StaticCatalog(),
        });
        await catalog.fetch();
        const provider = new NanoGptDriver({ apiKey, timeout: config.apiTimeout, catalog });
        const scrubber = new SecretScrubber(
            Object.values(secretsResult.secrets),
            config.scrubbing,
        );

        // --- Tool registry ---
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(readFileSpec, readFileImpl);
        toolRegistry.register(writeFileSpec, writeFileImpl);
        toolRegistry.register(editFileSpec, editFileImpl);
        toolRegistry.register(deletePathSpec, deletePathImpl);
        toolRegistry.register(movePathSpec, movePathImpl);
        toolRegistry.register(makeDirectorySpec, makeDirectoryImpl);
        toolRegistry.register(statPathSpec, statPathImpl);
        toolRegistry.register(findPathsSpec, findPathsImpl);
        toolRegistry.register(searchTextSpec, searchTextImpl);
        toolRegistry.register(execCommandSpec, execCommandImpl);
        toolRegistry.register(openSessionSpec, openSessionImpl);
        toolRegistry.register(sessionIoSpec, sessionIoImpl);
        toolRegistry.register(closeSessionSpec, closeSessionImpl);
        toolRegistry.register(askUserSpec, askUserImpl);
        toolRegistry.register(confirmActionSpec, confirmActionImpl);
        toolRegistry.register(estimateTokensSpec, estimateTokensImpl);

        // --- Network policy ---
        const networkPolicy: NetworkPolicy = {
            mode: config.network.mode,
            allowDomains: config.network.allowDomains,
            denyDomains: config.network.denyDomains,
            allowHttp: config.network.allowHttp,
        };

        // Invoke mode is intentionally lighter than the interactive CLI, but it
        // still needs the read-only witness/triage tools advertised by the
        // delegation contract. Keep these dependencies minimal and lazy.
        const healthMap = new CapabilityHealthMap();
        const lspManager = new LspManager({ workspaceRoot: cwd, healthMap });
        const browserManager = new BrowserManager({ healthMap, networkPolicy });
        const tavilyKey = secretsResult.secrets.tavily;
        const searchProvider = tavilyKey ? new TavilySearchProvider(tavilyKey) : undefined;
        toolRegistry.register(lspQuerySpec, createLspQueryImpl({ lspManager }));
        toolRegistry.register(webSearchSpec, createWebSearchImpl({ searchProvider, networkPolicy }));
        toolRegistry.register(fetchUrlSpec, createFetchUrlImpl({ networkPolicy, browserManager }));
        toolRegistry.register(fetchMediaWikiPageSpec, createFetchMediaWikiPageImpl({ networkPolicy }));
        toolRegistry.register(fetchMediaWikiCategorySpec, createFetchMediaWikiCategoryImpl({ networkPolicy }));
        toolRegistry.register(lookupDocsSpec, createLookupDocsImpl({ searchProvider, networkPolicy, browserManager }));

        // --- Model override from request context ---
        const contextModel = typeof request.context?.model === 'string'
            ? request.context.model.trim() : '';
        const effectiveModel = contextModel || config.model?.default || 'qwen/qwen3-coder-next';
        const contextProfile = typeof request.context?.profile === 'string'
            ? request.context.profile.trim() : '';
        const contextTemperature = finiteNumberInRange(request.context?.temperature, 0, 2);
        const contextTopP = finiteNumberInRange(
            request.context?.top_p ?? request.context?.topP,
            0,
            1,
        );
        const contextThinking = parseThinkingMode(request.context?.thinking);

        // --- Ephemeral session ---
        const sessionsDir = join(homedir(), '.aca', 'sessions');
        mkdirSync(sessionsDir, { recursive: true });
        const sessionManager = new SessionManager(sessionsDir);
        const projection = sessionManager.create(cwd, {
            model: effectiveModel,
            mode: 'executor',
        });
        // Mark as ephemeral (not surfaced for resume)
        projection.manifest.ephemeral = true;
        sessionManager.saveManifest(projection);

        // --- Deadline enforcement ---
        const deadlineMs = request.deadline && Number.isFinite(request.deadline) && request.deadline > 0
            ? request.deadline
            : undefined;

        // --- Build invoke system prompt (project context for delegated agents) ---
        let projectSnapshot;
        try {
            projectSnapshot = buildProjectSnapshot(cwd);
        } catch {
            // Non-fatal: filesystem/git errors shouldn't crash invoke
            projectSnapshot = undefined;
        }
        const agentRegistryResult = AgentRegistry.resolve(toolRegistry);
        const agentRegistry = agentRegistryResult.registry;
        const activeProfile = contextProfile ? agentRegistry.getProfile(contextProfile) : undefined;
        if (contextProfile && !activeProfile) {
            process.stdout.write(JSON.stringify(
                buildErrorResponse(
                    'protocol.invalid_profile',
                    `Unknown profile "${contextProfile}". Available: ${agentRegistry.getProfileNames().join(', ')}`,
                    false,
                ),
            ) + '\n');
            process.exit(EXIT_PROTOCOL);
        }

        if (contextProfile && activeProfile && request.constraints?.allowed_tools) {
            const narrowing = agentRegistry.validateToolNarrowing(contextProfile, request.constraints.allowed_tools);
            if (!narrowing.valid) {
                process.stdout.write(JSON.stringify(
                    buildErrorResponse(
                        'protocol.invalid_allowed_tools',
                        `allowed_tools includes tools outside profile "${contextProfile}": ${narrowing.rejected.join(', ')}`,
                        false,
                    ),
                ) + '\n');
                process.exit(EXIT_PROTOCOL);
            }
        }

        const allRegisteredToolNames = toolRegistry.list().map(t => t.spec.name);
        const deniedToolSet = new Set(request.constraints?.denied_tools ?? []);
        const authorityDeniedToolSet = new Set(
            (request.authority ?? [])
                .filter(rule => rule.decision === 'deny' && rule.args_match === undefined)
                .map(rule => rule.tool),
        );
        const requestedAllowedTools = request.constraints?.allowed_tools;
        const allowedToolSet = requestedAllowedTools ? new Set(requestedAllowedTools) : null;
        const profileToolSet = activeProfile ? new Set(activeProfile.defaultTools) : null;
        const effectiveAllowedTools = allRegisteredToolNames
            .filter(name => profileToolSet === null || profileToolSet.has(name))
            .filter(name => allowedToolSet === null || allowedToolSet.has(name))
            .filter(name => !deniedToolSet.has(name))
            .filter(name => !authorityDeniedToolSet.has(name));
        const toolNames = toolRegistry.list()
            .map(t => t.spec.name)
            .filter(name => effectiveAllowedTools.includes(name));
        const systemMessages = buildInvokeSystemMessages({
            cwd,
            toolNames,
            profileName: activeProfile?.name,
            profilePrompt: activeProfile?.systemPrompt,
            projectSnapshot,
        });

        // --- Execute turn ---
        const engine = new TurnEngine(
            provider,
            toolRegistry,
            projection.writer,
            projection.sequenceGenerator,
            scrubber,
            undefined, // providerRegistry
            undefined, // costTracker
            networkPolicy,
            undefined, // healthMap
            undefined, // checkpointManager
            undefined, // metricsAccumulator — ephemeral executor mode
        );

        const turnConfig: TurnEngineConfig = {
            sessionId: projection.manifest.sessionId,
            model: effectiveModel,
            provider: 'nanogpt',
            interactive: false,
            autoConfirm: true, // executor mode auto-approves (authority provides pre-auth)
            isSubAgent: true,  // executor is a callee — behaves like a sub-agent
            workspaceRoot: cwd,
            resolvedConfig: config,
            sessionGrants: new SessionGrantStore(),
            allowedTools: effectiveAllowedTools,
            authority: request.authority,
            maxSteps: request.constraints?.max_steps,
            maxToolCalls: request.constraints?.max_tool_calls,
            maxToolCallsByName: request.constraints?.max_tool_calls_by_name,
            maxToolResultBytes: request.constraints?.max_tool_result_bytes,
            maxInputTokens: request.constraints?.max_input_tokens,
            maxRepeatedReadCalls: request.constraints?.max_repeated_read_calls,
            maxTotalTokens: request.constraints?.max_total_tokens,
            temperature: contextTemperature,
            topP: contextTopP,
            thinking: contextThinking,
            extraTrustedRoots: config.sandbox?.extraTrustedRoots,
            systemMessages,
        };

        let resultText = '';
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        // Build the turn promise, with optional deadline via Promise.race
        const turnPromise = engine.executeTurn(turnConfig, request.task, []);
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const executionPromise = deadlineMs
            ? Promise.race([
                turnPromise,
                new Promise<never>((_, reject) => {
                    deadlineTimer = setTimeout(
                        () => reject(new Error(`Deadline exceeded: ${deadlineMs}ms`)),
                        deadlineMs,
                    );
                }),
            ])
            : turnPromise;

        let turnResult: Awaited<ReturnType<typeof engine.executeTurn>>;
        try {
            turnResult = await executionPromise;
        } catch (err: unknown) {
            // Clear timer before exit — process.exit() skips finally
            if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
            const msg = err instanceof Error ? err.message : String(err);
            const isDeadline = msg.includes('Deadline exceeded');
            process.stdout.write(JSON.stringify(
                buildErrorResponse(
                    isDeadline ? 'delegation.timeout' : 'system.internal',
                    `Execution failed: ${msg}`,
                    isDeadline,
                ),
            ) + '\n');
            process.exit(EXIT_RUNTIME);
        } finally {
            if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        }

        // Accumulate usage/safety before checking the final outcome so guardrail
        // errors like max_tool_calls still report the safety envelope that fired.
        const guardrails = new Set<string>();
        const acceptedToolCallsByName = new Map<string, number>();
        let acceptedToolCalls = 0;
        let rejectedToolCalls = 0;
        let toolResultBytes = 0;
        let estimatedInputTokensMax: number | undefined;
        for (const step of turnResult.steps) {
            totalInputTokens += step.tokenUsage.inputTokens;
            totalOutputTokens += step.tokenUsage.outputTokens;
            if (step.safetyStats) {
                acceptedToolCalls += step.safetyStats.acceptedToolCalls ?? 0;
                rejectedToolCalls += step.safetyStats.rejectedToolCalls ?? 0;
                toolResultBytes += step.safetyStats.toolResultBytes ?? 0;
                if (step.safetyStats.guardrail) guardrails.add(step.safetyStats.guardrail);
                if (step.safetyStats.estimatedInputTokens !== undefined) {
                    estimatedInputTokensMax = Math.max(
                        estimatedInputTokensMax ?? 0,
                        step.safetyStats.estimatedInputTokens,
                    );
                }
                for (const [name, count] of Object.entries(step.safetyStats.acceptedToolCallsByName ?? {})) {
                    acceptedToolCallsByName.set(name, Math.max(acceptedToolCallsByName.get(name) ?? 0, count));
                }
            }
        }
        const safety: InvokeSafety = {
            outcome: turnResult.turn.outcome,
            steps: turnResult.steps.length,
            ...(estimatedInputTokensMax !== undefined ? { estimated_input_tokens_max: estimatedInputTokensMax } : {}),
            accepted_tool_calls: acceptedToolCalls,
            rejected_tool_calls: rejectedToolCalls,
            accepted_tool_calls_by_name: Object.fromEntries([...acceptedToolCallsByName.entries()].sort()),
            tool_result_bytes: toolResultBytes,
            guardrails: [...guardrails].sort(),
        };

        // Check for non-success outcomes before building response.
        // Success outcomes: assistant_final, awaiting_user, approval_required.
        // Error outcomes: aborted, tool_error, budget_exceeded, max_steps,
        // max_tool_calls, cancelled, max_consecutive_tools.
        const outcome = turnResult.turn.outcome;
        const ERROR_OUTCOMES = new Set([
            'aborted', 'tool_error', 'budget_exceeded',
            'max_steps', 'max_tool_calls', 'cancelled', 'max_consecutive_tools',
        ]);
        if (outcome && ERROR_OUTCOMES.has(outcome)) {
            const errorCode = turnResult.lastError?.code ?? `turn.${outcome}`;
            const errorMsg = turnResult.lastError?.message ?? `Turn ended with outcome: ${outcome}`;
            // tool_error and budget_exceeded are non-retryable (same request = same failure).
            // aborted (LLM transient errors) and max_steps (could succeed with more steps) are retryable.
            const retryable = outcome !== 'budget_exceeded' && outcome !== 'tool_error';
            process.stdout.write(JSON.stringify(
                buildErrorResponse(errorCode, errorMsg, retryable, safety, {
                    input_tokens: totalInputTokens,
                    output_tokens: totalOutputTokens,
                    cost_usd: 0,
                }),
            ) + '\n');
            process.exit(EXIT_RUNTIME);
        }

        const failOnRejectedToolCalls = request.constraints?.fail_on_rejected_tool_calls === true
            || contextProfile === 'rp-researcher';
        if (failOnRejectedToolCalls && rejectedToolCalls > 0) {
            process.stdout.write(JSON.stringify(
                buildErrorResponse(
                    'turn.rejected_tool_calls',
                    `Turn completed with ${rejectedToolCalls} rejected tool call(s); treating as degraded workflow failure`,
                    true,
                    safety,
                    {
                        input_tokens: totalInputTokens,
                        output_tokens: totalOutputTokens,
                        cost_usd: 0,
                    },
                ),
            ) + '\n');
            process.exit(EXIT_RUNTIME);
        }

        const missingRequiredOutputs = validateRequiredOutputPaths(cwd, request.constraints?.required_output_paths);
        if (missingRequiredOutputs.length > 0) {
            process.stdout.write(JSON.stringify(
                buildErrorResponse(
                    'turn.required_outputs_missing',
                    `Required output file(s) missing or empty: ${missingRequiredOutputs.join(', ')}`,
                    true,
                    safety,
                    {
                        input_tokens: totalInputTokens,
                        output_tokens: totalOutputTokens,
                        cost_usd: 0,
                    },
                ),
            ) + '\n');
            process.exit(EXIT_RUNTIME);
        }

        // Extract assistant text from turn items
        for (const item of turnResult.items) {
            if (item.kind === 'message' && item.role === 'assistant') {
                for (const part of item.parts) {
                    if (part.type === 'text') {
                        resultText += part.text;
                    }
                }
            }
        }

        const response = buildSuccessResponse(resultText, {
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            cost_usd: 0, // Cost calculation deferred to provider-specific logic
        }, safety);
        process.stdout.write(JSON.stringify(response) + '\n');
        process.exit(EXIT_SUCCESS);
    });

program.parse();
