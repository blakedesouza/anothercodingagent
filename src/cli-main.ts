#!/usr/bin/env node

/**
 * ACA CLI entry point.
 *
 * Wires all modules together: config → secrets → provider → tools → sandbox →
 * approval → scrubber → renderer → event sink → cost tracker → REPL.
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

// --- Core ---
import { SessionManager } from './core/session-manager.js';
import { Repl } from './cli/repl.js';
import {
    buildProfileCompletionRepairTask,
    buildRequiredOutputRepairTask,
    countHardRejectedToolCalls,
    validateProfileCompletion,
    validateRequiredOutputPaths,
} from './cli/invoke-output-validation.js';
import { TurnEngine } from './core/turn-engine.js';
import type { TurnEngineConfig } from './core/turn-engine.js';
import { buildSystemMessagesForTier } from './core/prompt-assembly.js';
import {
    applyRuntimeTurnState,
    buildRuntimePromptContext,
} from './core/runtime-turn-context.js';
import { summarizeHistoryBeforeTurn } from './core/pre-turn-summarization.js';
import type { ConversationItem } from './types/conversation.js';
import {
    finalizeInvokeTurnState,
    prepareInvokeTurnConfig,
} from './cli/invoke-runtime-state.js';

// --- Config ---
import { loadConfig } from './config/loader.js';
import { loadSecrets } from './config/secrets.js';
import { serializeWitnessConfigs } from './config/witness-models.js';
import type { ResolvedConfig } from './config/schema.js';

// --- Providers ---
import { AnthropicDriver } from './providers/anthropic-driver.js';
import { NanoGptDriver } from './providers/nanogpt-driver.js';
import { NanoGptCatalog, NanoGptCatalogError, StaticCatalog } from './providers/model-catalog.js';
import { OpenAiDriver } from './providers/openai-driver.js';

// --- Tools ---
import { ToolRegistry, type ToolImplementation } from './tools/tool-registry.js';
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

// --- Indexing ---
import type { Indexer } from './indexing/indexer.js';
import { refreshIndexAfterTurn } from './indexing/runtime-refresh.js';
import {
    ensureSemanticIndexReadyForTool,
    ensureSemanticIndexReadyForTurnRefresh,
} from './indexing/runtime-semantic.js';
import { deriveWorkspaceId } from './core/session-manager.js';

// --- Checkpointing ---
import { CheckpointManager } from './checkpointing/checkpoint-manager.js';

// --- Error Recovery / Health ---
import { CapabilityHealthMap } from './core/capability-health.js';

// --- Delegation ---
import { AgentRegistry, DELEGATION_TOOL_NAMES } from './delegation/agent-registry.js';
import {
    DelegationTracker,
    DEFAULT_DELEGATION_LIMITS,
    spawnAgentSpec,
    createSpawnAgentImpl,
} from './delegation/spawn-agent.js';
import type { SpawnCallerContext } from './delegation/spawn-agent.js';
import { messageAgentSpec, createMessageAgentImpl } from './delegation/message-agent.js';
import { awaitAgentSpec, createAwaitAgentImpl } from './delegation/await-agent.js';
import { createDelegationLaunchHandler } from './delegation/agent-runtime.js';
import type { AgentIdentity } from './types/agent.js';
import type { AgentId } from './types/ids.js';
import { generateId } from './types/ids.js';

// --- LSP ---
import type { LspManager } from './lsp/lsp-manager.js';

// --- Browser ---
import type { BrowserManager } from './browser/browser-manager.js';

// --- Web Tools ---
// --- Rendering ---
import { detectCapabilities } from './rendering/terminal-capabilities.js';
import { OutputChannel } from './rendering/output-channel.js';
import { Renderer } from './rendering/renderer.js';
import { TurnRenderer } from './rendering/turn-renderer.js';

// --- Permissions ---
import { SecretScrubber } from './permissions/secret-scrubber.js';
import type { NetworkPolicy } from './permissions/network-policy.js';

// --- Observability ---
import { CostTracker } from './observability/cost-tracker.js';
import { SqliteStore } from './observability/sqlite-store.js';
import { BackgroundWriter } from './observability/background-writer.js';
import { JsonlEventSink, createEvent } from './core/event-sink.js';
import { bindRuntimeObservability } from './observability/runtime-events.js';
import { TelemetryExporter, MetricsAccumulator } from './observability/telemetry.js';
import { runStartupObservabilityMaintenance } from './observability/runtime-startup.js';

// --- Providers ---
import { ProviderRegistry } from './providers/provider-registry.js';
import type { ModelResponseFormat, ProviderConfig, ProviderDriver, RequestMessage } from './types/provider.js';

// --- CLI commands ---
import { runStats } from './cli/stats.js';
import { runInit, runConfigure, runTrust, runUntrust } from './cli/setup.js';
import { runConsult } from './cli/consult.js';
import { formatRpResearchSummary, runRpResearchWorkflow, type RpNetworkMode, type RpSourceScope } from './cli/rp-research.js';
import { TOOL_NAMES } from './cli/tool-names.js';
import { startServer } from './mcp/server.js';
import {
    runDescribe,
    readStdin,
    parseInvokeRequest,
    resolveInvokeWorkspaceRoot,
    buildErrorResponse,
    buildSuccessResponse,
    EXIT_SUCCESS,
    EXIT_RUNTIME,
    EXIT_PROTOCOL,
    type InvokeSafety,
    type InvokeSystemMessage,
} from './cli/executor.js';
import { createInterface } from 'node:readline';
import { SessionGrantStore } from './permissions/session-grants.js';
import { maybeAutoStartDebugUi } from './debug-ui/manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
}

const program = new Command();
// Commander v13 will otherwise let root options like `--model` swallow
// identically named subcommand options that appear after the subcommand token.
// ACA relies on subcommand-local model overrides for workflows like
// `aca rp-research --model <id> ...`, so keep option parsing positional.
program.enablePositionalOptions();

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

function parseResponseFormat(value: unknown): ModelResponseFormat | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.type === 'text' || record.type === 'json_object') {
        return { type: record.type };
    }
    if (record.type !== 'json_schema') return undefined;
    const schemaRecord = typeof record.json_schema === 'object' && record.json_schema !== null && !Array.isArray(record.json_schema)
        ? record.json_schema as Record<string, unknown>
        : undefined;
    if (!schemaRecord || typeof schemaRecord.name !== 'string' || typeof schemaRecord.schema !== 'object' || schemaRecord.schema === null || Array.isArray(schemaRecord.schema)) {
        return undefined;
    }
    return {
        type: 'json_schema',
        json_schema: {
            name: schemaRecord.name,
            ...(typeof schemaRecord.strict === 'boolean' ? { strict: schemaRecord.strict } : {}),
            schema: schemaRecord.schema as Record<string, unknown>,
        },
    };
}

function parseSystemMessages(value: unknown): InvokeSystemMessage[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const messages: InvokeSystemMessage[] = [];
    for (const item of value) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
        const record = item as Record<string, unknown>;
        if (record.role !== 'system' || typeof record.content !== 'string') return undefined;
        messages.push({ role: 'system', content: record.content });
    }
    return messages.length > 0 ? messages : undefined;
}

type RuntimeProviderKind = 'nanogpt' | 'openai' | 'anthropic';

interface ActiveProviderRuntime {
    kind: RuntimeProviderKind;
    provider: ProviderDriver;
    providerConfig: ProviderConfig;
    catalog?: NanoGptCatalog;
    catalogProbe?: 'ok' | 'fallback';
}

const RP_RESEARCHER_MODEL_CANDIDATES = [
    'zai-org/glm-5',
    'moonshotai/kimi-k2.5',
] as const;

class ProviderBootstrapError extends Error {
    readonly code: 'missing_api_key' | 'auth_error' | 'unsupported_provider';
    readonly providerKind?: RuntimeProviderKind;

    constructor(
        code: 'missing_api_key' | 'auth_error' | 'unsupported_provider',
        message: string,
        providerKind?: RuntimeProviderKind,
    ) {
        super(message);
        this.name = 'ProviderBootstrapError';
        this.code = code;
        this.providerKind = providerKind;
    }
}

function resolveActiveProviderConfig(config: ResolvedConfig): ProviderConfig {
    const configured = config.providers.find(provider => provider.name === config.defaultProvider)
        ?? config.providers[0];
    const driver = configured?.driver ?? configured?.name;
    if (!configured || !driver || configured.baseUrl === null && driver !== 'nanogpt') {
        throw new ProviderBootstrapError(
            'unsupported_provider',
            `Unsupported or incomplete provider configuration for "${config.defaultProvider}"`,
        );
    }
    return {
        name: configured.name,
        driver,
        baseUrl: configured.baseUrl ?? '',
        timeout: configured.timeout,
        priority: configured.priority,
    };
}

function toRuntimeProviderKind(providerConfig: ProviderConfig): RuntimeProviderKind {
    switch (providerConfig.driver) {
        case 'nanogpt':
        case 'openai':
        case 'anthropic':
            return providerConfig.driver;
        default:
            throw new ProviderBootstrapError(
                'unsupported_provider',
                `Unsupported provider driver "${providerConfig.driver}"`,
            );
    }
}

function formatMissingApiKeyMessage(kind: RuntimeProviderKind): string {
    switch (kind) {
        case 'openai':
            return 'No OpenAI API key found.\nSet OPENAI_API_KEY env var, add to ~/.aca/secrets.json, or add to ~/.api_keys';
        case 'anthropic':
            return 'No Anthropic API key found.\nSet ANTHROPIC_API_KEY env var, add to ~/.aca/secrets.json, or add to ~/.api_keys';
        case 'nanogpt':
        default:
            return 'No NanoGPT API key found.\nSet NANOGPT_API_KEY env var, add to ~/.aca/secrets.json, or add to ~/.api_keys';
    }
}

function formatRejectedApiKeyMessage(kind: RuntimeProviderKind): string {
    switch (kind) {
        case 'openai':
            return 'OpenAI API key was rejected.\nCheck OPENAI_API_KEY, ~/.aca/secrets.json, or ~/.api_keys';
        case 'anthropic':
            return 'Anthropic API key was rejected.\nCheck ANTHROPIC_API_KEY, ~/.aca/secrets.json, or ~/.api_keys';
        case 'nanogpt':
        default:
            return 'NanoGPT API key was rejected.\nCheck NANOGPT_API_KEY, ~/.aca/secrets.json, or ~/.api_keys';
    }
}

function isUnknownModelError(error: unknown): boolean {
    return error instanceof Error
        && (error.message.includes('unsupported model') || error.message.includes('Unknown model'));
}

function providerSupportsModel(provider: ProviderDriver, model: string): boolean {
    try {
        provider.capabilities(model);
        return true;
    } catch (error) {
        if (isUnknownModelError(error)) {
            return false;
        }
        throw error;
    }
}

function isModelAvailableForAutoSelection(
    activeProvider: Pick<ActiveProviderRuntime, 'kind' | 'provider' | 'catalog'>,
    model: string,
): boolean {
    if (activeProvider.kind === 'nanogpt') {
        return activeProvider.catalog?.getModel(model) !== null;
    }
    return providerSupportsModel(activeProvider.provider, model);
}

export function resolveInvokeEffectiveModel(
    requestedModel: string,
    configuredDefaultModel: string,
    profileName: string | undefined,
    activeProvider: Pick<ActiveProviderRuntime, 'kind' | 'provider' | 'catalog'>,
): string {
    if (requestedModel) return requestedModel;
    if (profileName !== 'rp-researcher') return configuredDefaultModel;
    if (isModelAvailableForAutoSelection(activeProvider, configuredDefaultModel)) {
        return configuredDefaultModel;
    }
    for (const candidate of RP_RESEARCHER_MODEL_CANDIDATES) {
        if (isModelAvailableForAutoSelection(activeProvider, candidate)) {
            return candidate;
        }
    }
    return configuredDefaultModel;
}

async function createActiveProviderRuntime(
    config: ResolvedConfig,
    secrets: Record<string, string>,
): Promise<ActiveProviderRuntime> {
    const providerConfig = resolveActiveProviderConfig(config);
    const kind = toRuntimeProviderKind(providerConfig);
    const apiKey = secrets[kind];
    if (!apiKey || apiKey.trim() === '') {
        throw new ProviderBootstrapError(
            'missing_api_key',
            formatMissingApiKeyMessage(kind),
            kind,
        );
    }

    switch (kind) {
        case 'openai':
            return {
                kind,
                providerConfig,
                provider: new OpenAiDriver({
                    apiKey,
                    baseUrl: providerConfig.baseUrl || undefined,
                    timeout: providerConfig.timeout,
                }),
            };
        case 'anthropic':
            return {
                kind,
                providerConfig,
                provider: new AnthropicDriver({
                    apiKey,
                    baseUrl: providerConfig.baseUrl || undefined,
                    timeout: providerConfig.timeout,
                }),
            };
        case 'nanogpt':
        default: {
            const catalog = new NanoGptCatalog({
                apiKey,
                baseUrl: providerConfig.baseUrl || undefined,
                fallback: new StaticCatalog(),
            });
            try {
                const catalogProbe = await probeCatalogAccess(catalog);
                await catalog.fetch();
                return {
                    kind,
                    providerConfig,
                    provider: new NanoGptDriver({
                        apiKey,
                        baseUrl: providerConfig.baseUrl || undefined,
                        timeout: providerConfig.timeout,
                        catalog,
                    }),
                    catalog,
                    catalogProbe,
                };
            } catch (error) {
                if (error instanceof NanoGptCatalogError && error.code === 'auth_error') {
                    throw new ProviderBootstrapError(
                        'auth_error',
                        formatRejectedApiKeyMessage(kind),
                        kind,
                    );
                }
                throw error;
            }
        }
    }
}

async function loadRuntimeCapabilities() {
    const [
        { EmbeddingModel },
        { IndexStore },
        { BACKGROUND_THRESHOLD, Indexer },
        { searchSemanticSpec, createSearchSemanticImpl },
        { LspManager },
        { lspQuerySpec, createLspQueryImpl },
        { BrowserManager },
        { BROWSER_TOOL_SPECS, createBrowserToolImpls },
        { TavilySearchProvider, webSearchSpec, createWebSearchImpl },
        { fetchUrlSpec, createFetchUrlImpl },
        {
            fetchMediaWikiPageSpec,
            fetchMediaWikiCategorySpec,
            createFetchMediaWikiPageImpl,
            createFetchMediaWikiCategoryImpl,
        },
        { lookupDocsSpec, createLookupDocsImpl },
    ] = await Promise.all([
        import('./indexing/embedding.js'),
        import('./indexing/index-store.js'),
        import('./indexing/indexer.js'),
        import('./tools/search-semantic.js'),
        import('./lsp/lsp-manager.js'),
        import('./tools/lsp-query.js'),
        import('./browser/browser-manager.js'),
        import('./browser/browser-tools.js'),
        import('./tools/web-search.js'),
        import('./tools/fetch-url.js'),
        import('./tools/fetch-mediawiki-page.js'),
        import('./tools/lookup-docs.js'),
    ]);

    return {
        EmbeddingModel,
        IndexStore,
        BACKGROUND_THRESHOLD,
        Indexer,
        searchSemanticSpec,
        createSearchSemanticImpl,
        LspManager,
        lspQuerySpec,
        createLspQueryImpl,
        BrowserManager,
        BROWSER_TOOL_SPECS,
        createBrowserToolImpls,
        TavilySearchProvider,
        webSearchSpec,
        createWebSearchImpl,
        fetchUrlSpec,
        createFetchUrlImpl,
        fetchMediaWikiPageSpec,
        fetchMediaWikiCategorySpec,
        createFetchMediaWikiPageImpl,
        createFetchMediaWikiCategoryImpl,
        lookupDocsSpec,
        createLookupDocsImpl,
    };
}

async function probeCatalogAccess(catalog: NanoGptCatalog): Promise<'ok' | 'fallback'> {
    try {
        await catalog.probe();
        return 'ok';
    } catch (error) {
        if (error instanceof NanoGptCatalogError && error.code === 'auth_error') {
            throw error;
        }
        return 'fallback';
    }
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

function startBackgroundIndexing(
    indexer: Indexer,
    outputChannel: OutputChannel,
    verbose: boolean,
): void {
    indexer.buildIndexBackground().then(
        (result) => {
            if (verbose) {
                outputChannel.stderr(
                    `[indexer] Index built: ${result.filesIndexed} files, ` +
                    `${result.warnings.length} warnings\n`,
                );
            }
        },
        (err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            outputChannel.stderr(`[indexer] Background indexing failed: ${msg}\n`);
        },
    );
}

async function initializeStartupIndexing(
    indexer: Indexer | undefined,
    outputChannel: OutputChannel,
    verbose: boolean,
    backgroundThreshold: number,
): Promise<void> {
    if (!indexer) {
        return;
    }
    const fileCount = indexer.estimateFileCount();
    if (fileCount > backgroundThreshold) {
        startBackgroundIndexing(indexer, outputChannel, verbose);
        return;
    }

    try {
        const result = await indexer.buildIndex();
        if (verbose) {
            outputChannel.stderr(
                `[indexer] Index built: ${result.filesIndexed} files, ` +
                `${result.warnings.length} warnings\n`,
            );
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.stderr(`[indexer] Index build failed: ${msg}\n`);
    }
}

export const RP_RETRYABLE_ABORT_CODES = new Set([
    'llm.server_error',
    'llm.timeout',
    'llm.rate_limited',
    'llm.malformed',
]);
const DEFAULT_RP_MAX_TOOL_RESULT_BYTES = 200_000;
const RP_REPAIR_MAX_STEPS = 25;
export const RP_REPAIR_MAX_TOOL_CALLS = 40;

export function shouldRetryRpAbort(
    profileName: string | undefined,
    result: {
        turn: { outcome?: string | null };
        lastError?: { code: string } | undefined;
    },
): boolean {
    return profileName === 'rp-researcher'
        && result.turn.outcome === 'aborted'
        && result.lastError !== undefined
        && RP_RETRYABLE_ABORT_CODES.has(result.lastError.code);
}

export function buildRpRepairTurnConfig(constraints: {
    max_steps?: number;
    max_tool_calls?: number;
} | undefined): Pick<TurnEngineConfig, 'maxSteps' | 'maxToolCalls'> {
    return {
        maxSteps: Math.min(constraints?.max_steps ?? RP_REPAIR_MAX_STEPS, RP_REPAIR_MAX_STEPS),
        maxToolCalls: Math.min(constraints?.max_tool_calls ?? RP_REPAIR_MAX_TOOL_CALLS, RP_REPAIR_MAX_TOOL_CALLS),
    };
}

interface MainOptions {
    model: string | undefined;
    verbose: boolean;
    confirm: boolean; // Commander: --no-confirm sets this to false (default true)
    resume?: string | true;
}

program
    .name('aca')
    .description('Another Coding Agent — an AI-powered coding assistant')
    .version(getVersion())
    .option('--model <model>', 'Model to use')
    .option('--verbose', 'Enable debug output on stderr', false)
    .option('--no-confirm', 'Auto-approve confirmation prompts')
    .option('-r, --resume [session]', 'Resume session (latest for workspace, or specific ID)')
    .argument('[prompt]', 'One-shot prompt (non-interactive mode)')
    .action(async (prompt: string | undefined, options: MainOptions) => {
        const isTTY = process.stdin.isTTY ?? false;
        let runtimeOutputChannel: OutputChannel | undefined;
        const writeHumanStderr = (text: string): void => {
            if (runtimeOutputChannel) {
                runtimeOutputChannel.stderr(text);
            } else {
                process.stderr.write(text);
            }
        };

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
                        writeHumanStderr('Error: ambiguous — both --resume value and positional prompt provided\n');
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
                writeHumanStderr(`Error reading stdin: ${msg}\n`);
                process.exit(EXIT_ONESHOT_USAGE);
            }
            if (!task) {
                writeHumanStderr('Error: empty input from stdin\n');
                process.exit(EXIT_ONESHOT_USAGE);
            }
        }

        // No TTY, no task, resume without task → error
        if (!isTTY && !task && wantsResume) {
            writeHumanStderr('Error: --resume without TTY requires a task (pipe or positional)\n');
            process.exit(EXIT_ONESHOT_USAGE);
        }

        const isOneShot = task !== undefined;

        const cwd = process.cwd();

        // --- Load config ---
        const configResult = await loadConfig({ workspaceRoot: cwd });
        const config = configResult.config;

        // --- Resolve model: CLI flag > config model.default ---
        const effectiveModel = options.model ?? config.model?.default;
        if (!effectiveModel) {
            writeHumanStderr('Error: no model specified. Use --model <model> or set model.default in ~/.aca/config.json\n');
            process.exit(EXIT_ONESHOT_STARTUP);
        }

        if (options.verbose && configResult.warnings.length > 0) {
            for (const w of configResult.warnings) {
                writeHumanStderr(`[config] ${w}\n`);
            }
        }

        // --- Load secrets (env → ~/.aca/secrets.json → ~/.api_keys) ---
        const secretsResult = await loadSecrets();

        if (secretsResult.warnings.length > 0) {
            for (const w of secretsResult.warnings) {
                writeHumanStderr(`[secrets] ${w}\n`);
            }
        }

        // --- Create active provider + registry ---
        const activeProvider = await createActiveProviderRuntime(config, secretsResult.secrets).catch((error: unknown) => {
            if (error instanceof ProviderBootstrapError) {
                writeHumanStderr(`Error: ${error.message}\n`);
                process.exit(EXIT_ONESHOT_STARTUP);
            }
            throw error;
        });
        if (
            activeProvider.kind === 'nanogpt'
            && activeProvider.catalogProbe === 'ok'
            && !activeProvider.catalog?.getModel(effectiveModel)
        ) {
            writeHumanStderr(`Error: model not found: ${effectiveModel}\n`);
            process.exit(EXIT_ONESHOT_STARTUP);
        }
        if (
            activeProvider.kind !== 'nanogpt'
            && !providerSupportsModel(activeProvider.provider, effectiveModel)
        ) {
            writeHumanStderr(`Error: model not found: ${effectiveModel}\n`);
            process.exit(EXIT_ONESHOT_STARTUP);
        }

        if (options.verbose) {
            const caps = activeProvider.provider.capabilities(effectiveModel);
            writeHumanStderr(
                `[provider] ${activeProvider.providerConfig.name}:${effectiveModel} ` +
                `context=${caps.maxContext} maxOutput=${caps.maxOutput}\n`,
            );
        }

        const providerRegistry = new ProviderRegistry();
        providerRegistry.register(activeProvider.provider, activeProvider.providerConfig);

        // --- Create scrubber ---
        const scrubber = new SecretScrubber(
            Object.values(secretsResult.secrets),
            config.scrubbing,
        );

        // --- Open SQLite observability store ---
        const dbPath = join(homedir(), '.aca', 'observability.db');
        mkdirSync(join(homedir(), '.aca'), { recursive: true });
        const sqliteStore = new SqliteStore(dbPath, (msg) => writeHumanStderr(`[sqlite] ${msg}\n`));
        const sqliteOk = sqliteStore.open();
        if (!sqliteOk) {
            writeHumanStderr(
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
        const runtimeCaps = await loadRuntimeCapabilities();

        // --- Capability health tracker (M7.13) ---
        const healthMap = new CapabilityHealthMap();

        // --- LSP Manager (M7.3) ---
        const lspManager = new runtimeCaps.LspManager({ workspaceRoot: cwd, healthMap });

        // --- Browser Manager (M7.4) ---
        const browserManager = new runtimeCaps.BrowserManager({ healthMap, networkPolicy });

        // --- Search provider (M7.5 — Tavily, optional) ---
        const tavilyKey = secretsResult.secrets.tavily;
        const searchProvider = tavilyKey ? new runtimeCaps.TavilySearchProvider(tavilyKey) : undefined;

        // --- Lazy indexing/search_semantic initialization ---
        const workspaceId = deriveWorkspaceId(cwd);
        const indexDbPath = join(homedir(), '.aca', 'indexes', workspaceId, 'index.db');
        let indexStore: { close(): void } | undefined;
        let embeddingModel: { dispose(): Promise<void> } | undefined;
        let indexer: Indexer | undefined;
        let searchSemanticImpl: ToolImplementation | undefined;
        const getSearchSemanticImpl = async (): Promise<ToolImplementation> => {
            if (searchSemanticImpl) return searchSemanticImpl;

            const createdStore = new runtimeCaps.IndexStore(
                indexDbPath,
                (msg) => writeHumanStderr(`[index] ${msg}\n`),
            );
            if (!createdStore.open()) {
                writeHumanStderr(
                    '[index] Warning: Could not open index database. ' +
                    'Semantic search will be unavailable.\n',
                );
            }

            const createdEmbedding = new runtimeCaps.EmbeddingModel();
            const embeddingReady = await createdEmbedding.initialize();
            if (!embeddingReady) {
                writeHumanStderr(
                    '[embedding] Init failed. Indexing will proceed without embeddings.\n',
                );
            }

            const createdIndexer = new runtimeCaps.Indexer(
                cwd,
                createdStore,
                createdEmbedding,
                undefined,
                (msg) => {
                    if (options.verbose) writeHumanStderr(`[indexer] ${msg}\n`);
                },
            );

            indexStore = createdStore;
            embeddingModel = createdEmbedding;
            indexer = createdIndexer;
            searchSemanticImpl = runtimeCaps.createSearchSemanticImpl({
                indexer: createdIndexer,
                store: createdStore,
                embedding: createdEmbedding,
            });
            return searchSemanticImpl;
        };

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
        toolRegistry.register(runtimeCaps.searchSemanticSpec, async (args, context) => {
            const impl = await getSearchSemanticImpl();
            await ensureSemanticIndexReadyForTool(indexer, runtimeCaps.BACKGROUND_THRESHOLD);
            return impl(args, context);
        });

        // --- Register LSP tool (M7.3) ---
        toolRegistry.register(runtimeCaps.lspQuerySpec, runtimeCaps.createLspQueryImpl({ lspManager }));

        // --- Register browser tools (M7.4) ---
        const browserToolImpls = runtimeCaps.createBrowserToolImpls({ manager: browserManager, networkPolicy });
        for (const spec of runtimeCaps.BROWSER_TOOL_SPECS) {
            const impl = browserToolImpls.get(spec.name) as ToolImplementation | undefined;
            if (impl) {
                toolRegistry.register(spec, impl);
            }
        }

        // --- Register web tools (M7.5) ---
        toolRegistry.register(runtimeCaps.webSearchSpec, runtimeCaps.createWebSearchImpl({ searchProvider, networkPolicy }));
        toolRegistry.register(runtimeCaps.fetchUrlSpec, runtimeCaps.createFetchUrlImpl({ networkPolicy, browserManager }));
        toolRegistry.register(runtimeCaps.fetchMediaWikiPageSpec, runtimeCaps.createFetchMediaWikiPageImpl({ networkPolicy }));
        toolRegistry.register(runtimeCaps.fetchMediaWikiCategorySpec, runtimeCaps.createFetchMediaWikiCategoryImpl({ networkPolicy }));
        toolRegistry.register(runtimeCaps.lookupDocsSpec, runtimeCaps.createLookupDocsImpl({ searchProvider, networkPolicy, browserManager }));

        // --- Agent Registry + Delegation (M7.1a-c, M7.2) ---
        const registryResult = AgentRegistry.resolve(toolRegistry);
        if (options.verbose && registryResult.warnings.length > 0) {
            for (const w of registryResult.warnings) {
                writeHumanStderr(`[delegation] ${w}\n`);
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
                    writeHumanStderr('Error: no previous session found for this workspace\n');
                    process.exit(EXIT_ONESHOT_STARTUP);
                }
                targetId = latestId;
            }
            try {
                const resumed = sessionManager.resume(targetId as import('./types/ids.js').SessionId);
                projection = resumed.projection;
                projection.manifest.fileActivityIndex ??= resumed.fileActivityIndex.serialize();
                existingItems = [...projection.items];
                if (options.verbose) {
                    writeHumanStderr(`[debug] Resumed session ${targetId}\n`);
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                writeHumanStderr(`Error: failed to resume session: ${msg}\n`);
                process.exit(EXIT_ONESHOT_STARTUP);
            }
        } else {
            projection = sessionManager.create(cwd, {
                model: effectiveModel,
                verbose: options.verbose,
            });
        }

        const startupMaintenance = await runStartupObservabilityMaintenance({
            sessionsDir,
            store: sqliteOk ? sqliteStore : null,
            retention: config.retention,
            sessionId: projection.manifest.sessionId,
            sessionDir: projection.sessionDir,
            resumed: wantsResume,
            warn: (msg) => writeHumanStderr(`[observability] ${msg}\n`),
        });
        if (options.verbose && startupMaintenance.backfilled > 0) {
            writeHumanStderr(
                `[observability] Backfilled ${startupMaintenance.backfilled} missing SQLite events from JSONL.\n`,
            );
        }
        if (
            options.verbose
            && (startupMaintenance.retention.pruned > 0 || startupMaintenance.retention.compressed > 0)
        ) {
            writeHumanStderr(
                `[observability] Retention pruned ${startupMaintenance.retention.pruned} ` +
                `and compressed ${startupMaintenance.retention.compressed} sessions.\n`,
            );
        }
        const sessionGrants = new SessionGrantStore();

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
            callerTools: Array.from(new Set([
                ...toolRegistry.list().map(t => t.spec.name),
                ...DELEGATION_TOOL_NAMES,
            ])),
        };
        const buildSpawnDeps = (callerContext: SpawnCallerContext) => ({
            agentRegistry,
            delegationTracker,
            limits: DEFAULT_DELEGATION_LIMITS,
            createChildSession: (parentSessionId: import('./types/ids.js').SessionId, rootSessionId: import('./types/ids.js').SessionId) => {
                const child = sessionManager.create(
                    cwd,
                    {
                        model: effectiveModel,
                        mode: 'sub-agent',
                    },
                    {
                        parentSessionId,
                        rootSessionId,
                    },
                );
                return child.manifest.sessionId;
            },
            onSpawn: createDelegationLaunchHandler({
                provider: activeProvider.provider,
                providerName: activeProvider.providerConfig.name,
                model: effectiveModel,
                autoConfirm: !options.confirm,
                workspaceRoot: cwd,
                shell: process.env.SHELL,
                rootToolRegistry: toolRegistry,
                sessionManager,
                scrubber,
                networkPolicy,
                healthMap,
                resolvedConfig: config,
                sessionGrants,
                extraTrustedRoots: config.sandbox?.extraTrustedRoots,
                spawnDepsFactory: buildSpawnDeps,
            }),
        });
        toolRegistry.register(
            spawnAgentSpec,
            createSpawnAgentImpl(buildSpawnDeps(spawnCallerContext), spawnCallerContext),
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
            (msg: string) => writeHumanStderr(`${msg}\n`),
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
                model: effectiveModel,
                provider: activeProvider.providerConfig.name,
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
            await embeddingModel?.dispose().catch(() => {});
            try { indexStore?.close(); } catch { /* best-effort */ }
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
                writeHumanStderr(`[checkpoint] Init failed: ${msg}. Checkpointing disabled.\n`);
            }
        }

        if (isOneShot) {
            // =====================================================
            // ONE-SHOT MODE
            // =====================================================
            const termCaps = detectCapabilities();
            const outputChannel = new OutputChannel({
                capabilities: termCaps,
                mode: 'one-shot',
            });
            runtimeOutputChannel = outputChannel;
            const renderer = new Renderer({ output: outputChannel, verbose: options.verbose });
            outputChannel.stderr(`[aca] model: ${effectiveModel}\n`);
            if (options.verbose) {
                outputChannel.stderr(`[one-shot] Task: ${task!.slice(0, 100)}${task!.length > 100 ? '...' : ''}\n`);
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
                activeProvider.provider,
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
            const turnRenderer = new TurnRenderer({
                output: outputChannel,
                renderer,
                verbose: options.verbose,
            });
            turnRenderer.bind(engine);
            const runtimeEventBinding = bindRuntimeObservability({
                engine,
                sessionId: projection.manifest.sessionId,
                agentId: 'aca',
                sinks: [jsonlSink, bgWriter],
            });

            await summarizeHistoryBeforeTurn({
                historyItems: existingItems,
                pendingUserInput: task!,
                workspaceRoot: cwd,
                shell: process.env.SHELL,
                manifest: projection.manifest,
                writer: projection.writer,
                sequenceGenerator: projection.sequenceGenerator,
                provider: activeProvider.provider,
                model: effectiveModel,
                tools: toolRegistry.list(),
                healthMap,
            });

            const promptContext = buildRuntimePromptContext(cwd, projection.manifest, healthMap);
            const turnConfig: TurnEngineConfig = {
                sessionId: projection.manifest.sessionId,
                model: effectiveModel,
                provider: activeProvider.providerConfig.name,
                interactive: false, // 30-step limit, no consecutive tool cap
                autoConfirm: !options.confirm, // --no-confirm → confirm=false → autoConfirm=true
                isSubAgent: false,
                workspaceRoot: cwd,
                shell: process.env.SHELL,
                projectSnapshot: promptContext.projectSnapshot,
                workingSet: promptContext.workingSet,
                durableTaskState: promptContext.durableTaskState,
                capabilities: promptContext.capabilities,
                onTextDelta: (text: string) => {
                    turnRenderer.onTextDelta(text);
                },
                promptUser,
                extraTrustedRoots: config.sandbox?.extraTrustedRoots,
                resolvedConfig: config,
                sessionGrants,
            };

            const startTime = Date.now();
            let exitCode = EXIT_ONESHOT_SUCCESS;
            let totalInputTokens = 0;
            let totalOutputTokens = 0;

            try {
                const result = await engine.executeTurn(turnConfig, task!, existingItems);
                await applyRuntimeTurnState(projection.manifest, result.items, cwd);
                await ensureSemanticIndexReadyForTurnRefresh({
                    items: result.items,
                    getIndexer: () => indexer,
                    initializeRuntime: getSearchSemanticImpl,
                    backgroundThreshold: runtimeCaps.BACKGROUND_THRESHOLD,
                });
                await refreshIndexAfterTurn(indexer, result.items);
                await turnRenderer.renderAssistantMirror(result.items);

                // Ensure trailing newline after streamed output
                outputChannel.stdout('\n');

                exitCode = outcomeToExitCode(result.turn.outcome ?? 'assistant_final');

                // Accumulate token usage
                for (const step of result.steps) {
                    totalInputTokens += step.tokenUsage.inputTokens;
                    totalOutputTokens += step.tokenUsage.outputTokens;
                }

                if (options.verbose) {
                    outputChannel.stderr(
                        `[one-shot] outcome=${result.turn.outcome} steps=${result.steps.length} ` +
                        `tokens_in=${totalInputTokens} tokens_out=${totalOutputTokens}\n`,
                    );
                }

                // Non-success outcomes: write diagnostic to stderr
                if (result.turn.outcome === 'max_steps') {
                    outputChannel.stderr(`Error: step limit reached (${result.steps.length} steps)\n`);
                } else if (result.turn.outcome === 'budget_exceeded') {
                    outputChannel.stderr('Error: budget exceeded\n');
                } else if (result.turn.outcome === 'aborted') {
                    if (result.lastError?.code === 'llm.auth_error') {
                        outputChannel.stderr('Error: API key is invalid or unauthorized.\n');
                        exitCode = EXIT_ONESHOT_STARTUP;
                    } else {
                        outputChannel.stderr(
                            `Error: LLM request failed (${result.lastError?.code ?? 'unknown'}).` +
                            (options.verbose ? '' : ' Use --verbose for details.') + '\n',
                        );
                    }
                } else if (result.turn.outcome === 'cancelled') {
                    outputChannel.stderr('Cancelled\n');
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                outputChannel.stderr(`Error: ${msg}\n`);
                exitCode = EXIT_ONESHOT_RUNTIME;
            } finally {
                runtimeEventBinding.dispose();
                turnRenderer.dispose();
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
            runtimeOutputChannel = outputChannel;
            const renderer = new Renderer({ output: outputChannel, verbose: options.verbose });

            // --- Display startup status ---
            const version = getVersion();
            renderer.startup({
                version,
                model: effectiveModel,
                provider: activeProvider.providerConfig.name,
                workspace: cwd,
            });
            await getSearchSemanticImpl();
            await initializeStartupIndexing(
                indexer!,
                outputChannel,
                options.verbose,
                runtimeCaps.BACKGROUND_THRESHOLD,
            );

            if (options.verbose) {
                outputChannel.stderr(`[debug] Workspace: ${cwd}\n`);
                outputChannel.stderr(`[debug] Sessions dir: ${sessionsDir}\n`);
                outputChannel.stderr(`[debug] Config sources: user=${configResult.sources.user} project=${configResult.sources.project}\n`);
                outputChannel.stderr(`[debug] Tools: ${toolRegistry.list().map(t => t.spec.name).join(', ')}\n`);
            }

            // --- Enter REPL ---
            const repl = new Repl({
                projection,
                sessionManager,
                provider: activeProvider.provider,
                providerName: activeProvider.providerConfig.name,
                toolRegistry,
                model: effectiveModel,
                verbose: options.verbose,
                workspaceRoot: cwd,
                scrubber,
                costTracker,
                renderer,
                outputChannel,
                providerRegistry,
                networkPolicy,
                resolvedConfig: config,
                indexer,
                checkpointManager,
                healthMap,
                metricsAccumulator,
                eventSinks: [jsonlSink, bgWriter],
                sessionGrants,
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

program
    .command('serve')
    .description('Start ACA as an MCP server on stdio transport')
    .action(async () => {
        await startServer();
    });

program
    .command('describe')
    .description('Output capability descriptor as JSON (delegation contract)')
    .option('--json', 'Output JSON (default)')
    .action(() => {
        process.stdout.write(runDescribe(TOOL_NAMES) + '\n');
        process.exit(0);
    });

program
    .command('debug-ui')
    .description('Start the local ACA debug UI')
    .action(async () => {
        await import(pathToFileURL(join(__dirname, '..', 'scripts', 'aca-debug-ui-server.mjs')).href);
    });

program
    .command('witnesses')
    .description('Output witness model configurations as JSON')
    .option('--json', 'Output JSON (default)')
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
    .option('--max-context-snippets <n>', 'Maximum witness-requested snippets per round', value => Number(value), 8)
    .option('--max-context-lines <n>', 'Maximum lines per witness-requested snippet', value => Number(value), 300)
    .option('--max-context-bytes <n>', 'Maximum bytes per witness-requested snippet', value => Number(value), 24_000)
    .option('--max-context-rounds <n>', 'Maximum context-request rounds per witness before forced finalization', value => Number(value), 3)
    .option('--shared-context', 'Use a scout model to select shared raw snippets before witness invocation', false)
    .option('--shared-context-model <model>', 'Scout model for --shared-context', 'zai-org/glm-5')
    .option('--shared-context-max-snippets <n>', 'Maximum shared raw snippets selected by the scout', value => Number(value), 8)
    .option('--shared-context-max-lines <n>', 'Maximum lines per shared raw snippet', value => Number(value), 160)
    .option('--shared-context-max-bytes <n>', 'Maximum bytes per shared raw snippet', value => Number(value), 16_000)
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
        maxContextRounds: number;
        sharedContext: boolean;
        sharedContextModel: string;
        sharedContextMaxSnippets: number;
        sharedContextMaxLines: number;
        sharedContextMaxBytes: number;
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
    .command('rp-research <series...>')
    .description(
        'Full end-to-end RP knowledge-pack workflow: runs a discovery pass to enumerate cast, locations, and timeline options; ' +
        'pauses after discovery if multiple arcs are found and asks you to rerun with --timeline <id> or --blank-timeline; ' +
        'then generates world, location, and character files in parallel. ' +
        'Use --blank-timeline for neutral/early-anime packs that don\'t need a specific arc selected. ' +
        'Default model: zai-org/glm-5. Requires --network-mode open for Fandom/wiki lookups.',
    )
    .option('--project-root <path>', 'Override the RP project root')
    .option('--slug <slug>', 'Override the generated series slug')
    .option('--source-scope <scope>', 'Preferred canon scope: auto, anime, manga, light-novel, visual-novel', 'auto')
    .option('--timeline <id>', 'Choose a discovered timeline/arc id or label for final generation')
    .option('--blank-timeline', 'Generate a timeline-neutral pack after discovery', false)
    .option('--discover-only', 'Stop after discovery and manifest generation', false)
    .option('--refresh-discovery', 'Force a fresh discovery pass even if a manifest already exists', false)
    .option('--model <model>', 'Model to use for the RP research workflow (default: zai-org/glm-5)')
    .option('--network-mode <mode>', 'Temporarily set ACA_NETWORK_MODE for generated invoke runs (off, approved-only, open)')
    .option('--max-steps <n>', 'Override max steps for generated invoke runs', value => Number(value))
    .option('--max-tool-calls <n>', 'Override max accepted tool calls for generated invoke runs', value => Number(value))
    .option('--concurrency <n>', 'Max parallel invoke tasks per phase (1-8, default 4)', value => Number(value))
    .option('--json', 'Output the workflow summary as JSON', false)
    .action(async (
        seriesParts: string[],
        options: {
            projectRoot?: string;
            slug?: string;
            sourceScope: RpSourceScope;
            timeline?: string;
            blankTimeline: boolean;
            discoverOnly: boolean;
            refreshDiscovery: boolean;
            model: string | undefined;
            networkMode?: RpNetworkMode;
            maxSteps?: number;
            maxToolCalls?: number;
            concurrency?: number;
            json: boolean;
        },
    ) => {
        try {
            const configResult = await loadConfig({ workspaceRoot: process.cwd() }).catch(() => null);
            const configRpRoot = configResult?.config.rpProjectRoot ?? null;
            const effectiveModel = options.model ?? configResult?.config.rpModel ?? 'zai-org/glm-5';
            const summary = await runRpResearchWorkflow({
                series: seriesParts.join(' '),
                projectRoot: options.projectRoot ?? configRpRoot ?? undefined,
                slug: options.slug,
                sourceScope: options.sourceScope,
                timeline: options.timeline,
                blankTimeline: options.blankTimeline,
                discoverOnly: options.discoverOnly,
                refreshDiscovery: options.refreshDiscovery,
                model: effectiveModel,
                networkMode: options.networkMode,
                maxSteps: options.maxSteps,
                maxToolCalls: options.maxToolCalls,
                concurrency: options.concurrency,
            });
            if (options.json) {
                process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
            } else {
                process.stdout.write(formatRpResearchSummary(summary) + '\n');
            }
            process.exit(summary.status === 'timeline_required' ? EXIT_ONESHOT_USAGE : EXIT_ONESHOT_SUCCESS);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`rp-research failed: ${message}\n`);
            process.exit(EXIT_ONESHOT_RUNTIME);
        }
    });

program
    .command('invoke')
    .description('Execute structured task from stdin as JSON (delegation contract)')
    .option('--json', 'Structured JSON mode (default)')
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
        const launchCwd = process.cwd();
        const workspaceRootResult = resolveInvokeWorkspaceRoot(launchCwd, request.context);
        if ('error' in workspaceRootResult) {
            process.stdout.write(JSON.stringify(workspaceRootResult.error) + '\n');
            process.exit(workspaceRootResult.exitCode);
        }
        const cwd = workspaceRootResult.workspaceRoot;

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

        // --- Provider (with live catalog for real model limits when available) ---
        const activeProvider = await createActiveProviderRuntime(config, secretsResult.secrets).catch((error: unknown) => {
            if (error instanceof ProviderBootstrapError && error.code === 'missing_api_key') {
                process.stdout.write(JSON.stringify(
                    buildErrorResponse('system.config_error', error.message, false),
                ) + '\n');
                process.exit(EXIT_RUNTIME);
            }
            if (error instanceof ProviderBootstrapError && error.code === 'auth_error') {
                process.stdout.write(JSON.stringify(
                    buildErrorResponse('llm.auth_error', error.message, false),
                ) + '\n');
                process.exit(EXIT_RUNTIME);
            }
            throw error;
        });
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

        const healthMap = new CapabilityHealthMap();

        // --- Model override from request context ---
        const contextModel = typeof request.context?.model === 'string'
            ? request.context.model.trim() : '';
        const contextProfile = typeof request.context?.profile === 'string'
            ? request.context.profile.trim() : '';
        const configuredDefaultModel = config.model?.default ?? '';
        const effectiveModel = resolveInvokeEffectiveModel(
            contextModel,
            configuredDefaultModel,
            contextProfile,
            activeProvider,
        );
        if (!effectiveModel) {
            process.stdout.write(JSON.stringify(
                buildErrorResponse('system.config_error', 'No model specified. Set model.default in config or include model in request context.'),
            ) + '\n');
            process.exit(EXIT_RUNTIME);
        }
        const contextTemperature = finiteNumberInRange(request.context?.temperature, 0, 2);
        const contextTopP = finiteNumberInRange(
            request.context?.top_p ?? request.context?.topP,
            0,
            1,
        );
        const contextThinking = parseThinkingMode(request.context?.thinking);
        const contextResponseFormat = parseResponseFormat(
            request.context?.response_format ?? request.context?.responseFormat,
        );
        const contextSystemMessages = parseSystemMessages(
            request.context?.system_messages ?? request.context?.systemMessages,
        );
        if (
            activeProvider.kind === 'nanogpt'
            && activeProvider.catalogProbe === 'ok'
            && !activeProvider.catalog?.getModel(effectiveModel)
        ) {
            process.stdout.write(JSON.stringify(
                buildErrorResponse(
                    'protocol.invalid_model',
                    `Unknown model "${effectiveModel}"`,
                    false,
                ),
            ) + '\n');
            process.exit(EXIT_PROTOCOL);
        }
        if (
            activeProvider.kind !== 'nanogpt'
            && !providerSupportsModel(activeProvider.provider, effectiveModel)
        ) {
            process.stdout.write(JSON.stringify(
                buildErrorResponse(
                    'protocol.invalid_model',
                    `Unknown model "${effectiveModel}"`,
                    false,
                ),
            ) + '\n');
            process.exit(EXIT_PROTOCOL);
        }

        process.stderr.write(`[aca] model: ${effectiveModel}\n`);

        // --- Ephemeral session ---
        const sessionsDir = join(homedir(), '.aca', 'sessions');
        mkdirSync(sessionsDir, { recursive: true });
        const sessionManager = new SessionManager(sessionsDir);
        const projection = sessionManager.create(cwd, {
            model: effectiveModel,
            mode: 'executor',
            ...(process.env.ACA_SESSION_TAG ? { sessionTag: process.env.ACA_SESSION_TAG } : {}),
        });
        // Mark as ephemeral (not surfaced for resume)
        projection.manifest.ephemeral = true;
        sessionManager.saveManifest(projection);

        // --- Deadline enforcement ---
        const deadlineMs = request.deadline && Number.isFinite(request.deadline) && request.deadline > 0
            ? request.deadline
            : undefined;

        const invokeSessionGrants = new SessionGrantStore();
        const {
            registerInvokeRuntimeTools,
            mapInvokeAuthorityToDelegationAuthority,
            mapInvokeAuthorityToPreauths,
        } = await import('./cli/invoke-tooling.js');
        const {
            agentRegistry,
            rootCallerContext,
            refreshSemanticIndexAfterTurn,
        } = await registerInvokeRuntimeTools({
            cwd,
            model: effectiveModel,
            toolRegistry,
            networkPolicy,
            healthMap,
            tavilyApiKey: secretsResult.secrets.tavily,
            sessionManager,
            sessionId: projection.manifest.sessionId,
            delegationRuntime: {
                provider: activeProvider.provider,
                providerName: activeProvider.providerConfig.name,
                autoConfirm: true,
                scrubber,
                sessionGrants: invokeSessionGrants,
                resolvedConfig: config,
                shell: process.env.SHELL,
                extraTrustedRoots: config.sandbox?.extraTrustedRoots,
            },
        });

        // --- Build invoke system prompt (project context for delegated agents) ---
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
        rootCallerContext.callerTools = [...effectiveAllowedTools];
        rootCallerContext.callerAuthority = mapInvokeAuthorityToDelegationAuthority(request.authority);
        rootCallerContext.callerPreauths = mapInvokeAuthorityToPreauths(request.authority);
        const toolNames = toolRegistry.list()
            .map(t => t.spec.name)
            .filter(name => effectiveAllowedTools.includes(name));
        const initialPromptContext = buildRuntimePromptContext(cwd, projection.manifest, healthMap);
        const baseSystemMessages: RequestMessage[] = contextSystemMessages ?? buildSystemMessagesForTier(activeProfile?.promptTier, {
            cwd,
            toolNames,
            model: effectiveModel,
            profileName: activeProfile?.name,
            profilePrompt: activeProfile?.systemPrompt,
            projectSnapshot: initialPromptContext.projectSnapshot,
        });

        // --- Execute turn ---
        const engine = new TurnEngine(
            activeProvider.provider,
            toolRegistry,
            projection.writer,
            projection.sequenceGenerator,
            scrubber,
            undefined, // providerRegistry
            undefined, // costTracker
            networkPolicy,
            healthMap,
            undefined, // checkpointManager
            undefined, // metricsAccumulator — ephemeral executor mode
        );

        const baseTurnConfig: Omit<
            TurnEngineConfig,
            'projectSnapshot' | 'workingSet' | 'durableTaskState' | 'capabilities' | 'systemMessages'
        > = {
            sessionId: projection.manifest.sessionId,
            model: effectiveModel,
            provider: activeProvider.providerConfig.name,
            interactive: false,
            autoConfirm: true, // executor mode auto-approves (authority provides pre-auth)
            isSubAgent: true,  // executor is a callee — behaves like a sub-agent
            workspaceRoot: cwd,
            shell: process.env.SHELL,
            resolvedConfig: config,
            sessionGrants: invokeSessionGrants,
            allowedTools: effectiveAllowedTools,
            authority: request.authority,
            maxSteps: request.constraints?.max_steps,
            maxToolCalls: request.constraints?.max_tool_calls,
            maxToolCallsByName: request.constraints?.max_tool_calls_by_name,
            maxToolResultBytes: request.constraints?.max_tool_result_bytes
                ?? (contextProfile === 'rp-researcher' && request.constraints?.required_output_paths?.length
                    ? DEFAULT_RP_MAX_TOOL_RESULT_BYTES
                    : undefined),
            maxInputTokens: request.constraints?.max_input_tokens,
            maxRepeatedReadCalls: request.constraints?.max_repeated_read_calls,
            maxTotalTokens: request.constraints?.max_total_tokens,
            temperature: contextTemperature,
            topP: contextTopP,
            thinking: contextThinking,
            responseFormat: contextResponseFormat,
            extraTrustedRoots: config.sandbox?.extraTrustedRoots,
        };

        let resultText = '';
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        const invokeStartedAt = Date.now();
        const turnResults: Awaited<ReturnType<typeof engine.executeTurn>>[] = [];
        let conversationItems: ConversationItem[] = [];

        const runInvokeTurn = async (
            task: string,
            existingItems: ConversationItem[],
            configOverride: Omit<
                TurnEngineConfig,
                'projectSnapshot' | 'workingSet' | 'durableTaskState' | 'capabilities' | 'systemMessages'
            > = baseTurnConfig,
        ): Promise<Awaited<ReturnType<typeof engine.executeTurn>>> => {
            const remainingDeadlineMs = deadlineMs === undefined
                ? undefined
                : deadlineMs - (Date.now() - invokeStartedAt);
            if (remainingDeadlineMs !== undefined && remainingDeadlineMs <= 0) {
                throw new Error(`Deadline exceeded: ${deadlineMs}ms`);
            }
            const resolvedTurnConfig = await prepareInvokeTurnConfig({
                conversationItems: existingItems,
                task,
                projection,
                provider: activeProvider.provider,
                model: effectiveModel,
                tools: toolRegistry.list(),
                workspaceRoot: cwd,
                shell: process.env.SHELL,
                healthMap,
                baseConfig: configOverride,
                baseSystemMessages,
                includeRuntimeContextMessage: contextSystemMessages === undefined,
            });
            const turnPromise = engine.executeTurn(resolvedTurnConfig, task, existingItems);
            let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
            const executionPromise = remainingDeadlineMs
                ? Promise.race([
                    turnPromise,
                    new Promise<never>((_, reject) => {
                        deadlineTimer = setTimeout(
                            () => reject(new Error(`Deadline exceeded: ${deadlineMs}ms`)),
                            remainingDeadlineMs,
                        );
                    }),
                ])
                : turnPromise;
            try {
                const result = await executionPromise;
                await finalizeInvokeTurnState(sessionManager, projection, cwd, result.items);
                await refreshSemanticIndexAfterTurn(result.items);
                return result;
            } finally {
                if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
            }
        };

        const runInvokeTurnWithRpRetry = async (
            task: string,
            existingItems: ConversationItem[],
            configOverride: Omit<
                TurnEngineConfig,
                'projectSnapshot' | 'workingSet' | 'durableTaskState' | 'capabilities' | 'systemMessages'
            > = baseTurnConfig,
        ): Promise<{
            finalResult: Awaited<ReturnType<typeof engine.executeTurn>>;
            allResults: Array<Awaited<ReturnType<typeof engine.executeTurn>>>;
            allItems: ConversationItem[];
        }> => {
            const firstResult = await runInvokeTurn(task, existingItems, configOverride);
            const firstItems = [...existingItems, ...firstResult.items];
            if (!shouldRetryRpAbort(contextProfile, firstResult)) {
                return {
                    finalResult: firstResult,
                    allResults: [firstResult],
                    allItems: firstItems,
                };
            }

            const retryResult = await runInvokeTurn(task, firstItems, configOverride);
            return {
                finalResult: retryResult,
                allResults: [firstResult, retryResult],
                allItems: [...firstItems, ...retryResult.items],
            };
        };

        let turnResult: Awaited<ReturnType<typeof engine.executeTurn>>;
        try {
            const initialRun = await runInvokeTurnWithRpRetry(request.task, conversationItems);
            turnResult = initialRun.finalResult;
            turnResults.push(...initialRun.allResults);
            conversationItems = initialRun.allItems;

            const originalTotalToolCalls = turnResult.steps.reduce(
                (sum, step) => sum + (step.safetyStats?.acceptedToolCalls ?? 0),
                0,
            );
            const lastStepToolCalls = turnResult.steps[turnResult.steps.length - 1]?.safetyStats?.acceptedToolCalls ?? 0;
            let latestAcceptedToolCalls = originalTotalToolCalls;
            // Compute missing outputs early so validateProfileCompletion can detect
            // the "narrate-after-work" pattern (made calls in step N, narrated in last step).
            let missingRequiredOutputs = validateRequiredOutputPaths(cwd, request.constraints?.required_output_paths);
            const initialProfileCompletionIssue = validateProfileCompletion(
                contextProfile,
                latestAcceptedToolCalls,
                extractAssistantText(turnResult.items),
                lastStepToolCalls,
                missingRequiredOutputs,
            );
            const canRepairProfileCompletion = initialProfileCompletionIssue !== null
                && turnResult.turn.outcome === 'assistant_final'
                && effectiveAllowedTools.length > 0;

            if (canRepairProfileCompletion) {
                const repairTurnConfig: TurnEngineConfig = {
                    ...baseTurnConfig,
                    ...buildRpRepairTurnConfig(request.constraints),
                };
                const profileRepairRun = await runInvokeTurnWithRpRetry(
                    buildProfileCompletionRepairTask(
                        initialProfileCompletionIssue,
                        request.constraints?.required_output_paths,
                    ),
                    conversationItems,
                    repairTurnConfig,
                );
                turnResult = profileRepairRun.finalResult;
                turnResults.push(...profileRepairRun.allResults);
                conversationItems = profileRepairRun.allItems;
                latestAcceptedToolCalls = turnResult.steps.reduce(
                    (sum, step) => sum + (step.safetyStats?.acceptedToolCalls ?? 0),
                    0,
                );
            }

            missingRequiredOutputs = validateRequiredOutputPaths(cwd, request.constraints?.required_output_paths);
            // Use originalTotalToolCalls (not latestAcceptedToolCalls) so the output repair
            // still fires even when the profile-completion repair also narrated (0 calls).
            const canRepairMissingOutputs = missingRequiredOutputs.length > 0
                && turnResult.turn.outcome === 'assistant_final'
                && originalTotalToolCalls > 0
                && effectiveAllowedTools.includes('write_file');

            if (canRepairMissingOutputs) {
                const repairTurnConfig: TurnEngineConfig = {
                    ...baseTurnConfig,
                    ...buildRpRepairTurnConfig(request.constraints),
                };
                const outputRepairRun = await runInvokeTurnWithRpRetry(
                    buildRequiredOutputRepairTask(missingRequiredOutputs),
                    conversationItems,
                    repairTurnConfig,
                );
                turnResult = outputRepairRun.finalResult;
                turnResults.push(...outputRepairRun.allResults);
                conversationItems = outputRepairRun.allItems;
                missingRequiredOutputs = validateRequiredOutputPaths(cwd, request.constraints?.required_output_paths);
            }
        } catch (err: unknown) {
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
        }

        // Accumulate usage/safety before checking the final outcome so guardrail
        // errors like max_tool_calls still report the safety envelope that fired.
        const guardrails = new Set<string>();
        const acceptedToolCallsByName = new Map<string, number>();
        let acceptedToolCalls = 0;
        let rejectedToolCalls = 0;
        let toolResultBytes = 0;
        let estimatedInputTokensMax: number | undefined;
        for (const result of turnResults) {
            const perTurnAcceptedToolCallsByName = new Map<string, number>();
            for (const step of result.steps) {
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
                        perTurnAcceptedToolCallsByName.set(
                            name,
                            Math.max(perTurnAcceptedToolCallsByName.get(name) ?? 0, count),
                        );
                    }
                }
            }
            for (const [name, count] of perTurnAcceptedToolCallsByName) {
                acceptedToolCallsByName.set(name, (acceptedToolCallsByName.get(name) ?? 0) + count);
            }
        }
        const budgetExceededAfterCompletion = guardrails.has('budget_exceeded_after_completion');
        const safety: InvokeSafety = {
            outcome: turnResult.turn.outcome,
            steps: turnResults.reduce((sum, result) => sum + result.steps.length, 0),
            ...(estimatedInputTokensMax !== undefined ? { estimated_input_tokens_max: estimatedInputTokensMax } : {}),
            accepted_tool_calls: acceptedToolCalls,
            rejected_tool_calls: rejectedToolCalls,
            accepted_tool_calls_by_name: Object.fromEntries([...acceptedToolCallsByName.entries()].sort()),
            tool_result_bytes: toolResultBytes,
            guardrails: [...guardrails].sort(),
            ...(budgetExceededAfterCompletion ? { budget_exceeded: true } : {}),
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

        const hardRejectedToolCalls = countHardRejectedToolCalls(turnResult.items);
        const failOnRejectedToolCalls = request.constraints?.fail_on_rejected_tool_calls === true
            || contextProfile === 'rp-researcher';
        if (failOnRejectedToolCalls && hardRejectedToolCalls > 0) {
            process.stdout.write(JSON.stringify(
                buildErrorResponse(
                    'turn.rejected_tool_calls',
                    `Turn completed with ${hardRejectedToolCalls} hard rejected tool call(s); treating as degraded workflow failure`,
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

        resultText = extractAssistantText(turnResult.items);

        const profileCompletionIssue = validateProfileCompletion(contextProfile, acceptedToolCalls, resultText);
        if (profileCompletionIssue) {
            process.stdout.write(JSON.stringify(
                buildErrorResponse(
                    profileCompletionIssue.code,
                    profileCompletionIssue.message,
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

        const response = buildSuccessResponse(resultText, {
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            cost_usd: 0, // Cost calculation deferred to provider-specific logic
        }, safety);
        process.stdout.write(JSON.stringify(response) + '\n');
        process.exit(EXIT_SUCCESS);
    });

export async function runCli(argv: string[] = process.argv): Promise<void> {
    await maybeAutoStartDebugUi(argv);
    await program.parseAsync(argv);
}
