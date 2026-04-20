import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionId, AgentId } from '../types/ids.js';
import type { AgentIdentity } from '../types/agent.js';
import type { NetworkPolicy } from '../permissions/network-policy.js';
import { deriveWorkspaceId, SessionManager } from '../core/session-manager.js';
import { CapabilityHealthMap } from '../core/capability-health.js';
import { AgentRegistry, DELEGATION_TOOL_NAMES } from '../delegation/agent-registry.js';
import {
    createSpawnAgentImpl,
    DEFAULT_DELEGATION_LIMITS,
    DelegationTracker,
    type AuthorityRule,
    spawnAgentSpec,
} from '../delegation/spawn-agent.js';
import type { SpawnCallerContext } from '../delegation/spawn-agent.js';
import { createMessageAgentImpl, messageAgentSpec } from '../delegation/message-agent.js';
import { createAwaitAgentImpl, awaitAgentSpec } from '../delegation/await-agent.js';
import { generateId } from '../types/ids.js';
import { ToolRegistry, type ToolImplementation } from '../tools/tool-registry.js';
import type { AuthorityGrant } from './executor.js';
import type { PreauthRule } from '../config/schema.js';
import type { ConversationItem } from '../types/conversation.js';
import type { Indexer } from '../indexing/indexer.js';
import { refreshIndexAfterTurn, type IndexRefreshStatus } from '../indexing/runtime-refresh.js';
import { ensureSemanticIndexReadyForTurnRefresh } from '../indexing/runtime-semantic.js';
import { createDelegationLaunchHandler } from '../delegation/agent-runtime.js';
import type { ProviderDriver } from '../types/provider.js';
import type { SecretScrubber } from '../permissions/secret-scrubber.js';
import type { SessionGrantStore } from '../permissions/session-grants.js';
import type { ResolvedConfig } from '../config/schema.js';
import { buildSessionConfigSnapshot } from '../config/session-snapshot.js';

export interface RegisterInvokeRuntimeToolsOptions {
    cwd: string;
    model: string;
    toolRegistry: ToolRegistry;
    networkPolicy: NetworkPolicy;
    healthMap: CapabilityHealthMap;
    tavilyApiKey?: string;
    sessionManager: SessionManager;
    sessionId: SessionId;
    warn?: (message: string) => void;
    resolvedConfig?: ResolvedConfig;
    providerName?: string;
    delegationRuntime?: {
        provider: ProviderDriver;
        providerName: string;
        autoConfirm: boolean;
        scrubber?: SecretScrubber;
        sessionGrants: SessionGrantStore;
        resolvedConfig?: ResolvedConfig;
        shell?: string;
        extraTrustedRoots?: string[];
    };
}

export interface RegisterInvokeRuntimeToolsResult {
    agentRegistry: AgentRegistry;
    rootCallerContext: SpawnCallerContext;
    refreshSemanticIndexAfterTurn: (items: readonly ConversationItem[]) => Promise<IndexRefreshStatus>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canRepresentAsPreauthMatch(match: Record<string, unknown>): match is PreauthRule['match'] {
    const keys = Object.keys(match);
    return keys.every(key => key === 'commandRegex' || key === 'cwdPattern')
        && (match.commandRegex === undefined || typeof match.commandRegex === 'string')
        && (match.cwdPattern === undefined || typeof match.cwdPattern === 'string');
}

export function mapInvokeAuthorityToDelegationAuthority(
    authority: AuthorityGrant[] | undefined,
): AuthorityRule[] {
    return (authority ?? []).map((rule, index) => ({
        id: `invoke-authority-${index}`,
        tool: rule.tool,
        match: isRecord(rule.args_match) ? { ...rule.args_match } : {},
        decision: rule.decision === 'approve' ? 'allow' : 'deny',
        scope: 'session',
    }));
}

export function mapInvokeAuthorityToPreauths(
    authority: AuthorityGrant[] | undefined,
): PreauthRule[] {
    return mapInvokeAuthorityToDelegationAuthority(authority)
        .filter((rule): rule is AuthorityRule & { match: PreauthRule['match'] } => canRepresentAsPreauthMatch(rule.match))
        .map(rule => ({
            id: rule.id,
            tool: rule.tool,
            match: rule.match,
            decision: rule.decision,
            scope: rule.scope,
        }));
}

async function loadLspCapabilities() {
    const [
        { LspManager },
        { lspQuerySpec, createLspQueryImpl },
    ] = await Promise.all([
        import('../lsp/lsp-manager.js'),
        import('../tools/lsp-query.js'),
    ]);

    return {
        LspManager,
        lspQuerySpec,
        createLspQueryImpl,
    };
}

async function loadBrowserCapabilities() {
    const [
        { BrowserManager },
        { BROWSER_TOOL_SPECS, createBrowserToolImpls },
    ] = await Promise.all([
        import('../browser/browser-manager.js'),
        import('../browser/browser-tools.js'),
    ]);

    return {
        BrowserManager,
        BROWSER_TOOL_SPECS,
        createBrowserToolImpls,
    };
}

async function loadSearchCapabilities() {
    const { TavilySearchProvider, webSearchSpec, createWebSearchImpl } = await import('../tools/web-search.js');
    return {
        TavilySearchProvider,
        webSearchSpec,
        createWebSearchImpl,
    };
}

async function loadFetchUrlCapabilities() {
    const { fetchUrlSpec, createFetchUrlImpl } = await import('../tools/fetch-url.js');
    return { fetchUrlSpec, createFetchUrlImpl };
}

async function loadMediaWikiCapabilities() {
    const {
        fetchMediaWikiPageSpec,
        fetchMediaWikiCategorySpec,
        createFetchMediaWikiPageImpl,
        createFetchMediaWikiCategoryImpl,
    } = await import('../tools/fetch-mediawiki-page.js');

    return {
        fetchMediaWikiPageSpec,
        fetchMediaWikiCategorySpec,
        createFetchMediaWikiPageImpl,
        createFetchMediaWikiCategoryImpl,
    };
}

async function loadLookupDocsCapabilities() {
    const { lookupDocsSpec, createLookupDocsImpl } = await import('../tools/lookup-docs.js');
    return { lookupDocsSpec, createLookupDocsImpl };
}

function warnOptionalInvokeCapability(
    capability: string,
    error: unknown,
    warn?: (message: string) => void,
): void {
    if (!warn) return;
    const detail = error instanceof Error ? error.message : String(error);
    warn(`Optional capability "${capability}" is unavailable: ${detail}`);
}

export async function registerInvokeRuntimeTools(
    options: RegisterInvokeRuntimeToolsOptions,
): Promise<RegisterInvokeRuntimeToolsResult> {
    const {
        cwd,
        model,
        toolRegistry,
        networkPolicy,
        healthMap,
        tavilyApiKey,
        sessionManager,
        sessionId,
        warn,
        resolvedConfig,
        providerName,
        delegationRuntime,
    } = options;

    const lspCaps = await loadLspCapabilities().catch((error: unknown) => {
        warnOptionalInvokeCapability('lsp_query', error, warn);
        return undefined;
    });
    const browserCaps = await loadBrowserCapabilities().catch((error: unknown) => {
        warnOptionalInvokeCapability('browser tools', error, warn);
        return undefined;
    });
    const searchCaps = await loadSearchCapabilities().catch((error: unknown) => {
        warnOptionalInvokeCapability('web_search', error, warn);
        return undefined;
    });
    const fetchUrlCaps = await loadFetchUrlCapabilities().catch((error: unknown) => {
        warnOptionalInvokeCapability('fetch_url', error, warn);
        return undefined;
    });
    const mediaWikiCaps = await loadMediaWikiCapabilities().catch((error: unknown) => {
        warnOptionalInvokeCapability('fetch_mediawiki tools', error, warn);
        return undefined;
    });
    const lookupDocsCaps = await loadLookupDocsCapabilities().catch((error: unknown) => {
        warnOptionalInvokeCapability('lookup_docs', error, warn);
        return undefined;
    });

    const lspManager = lspCaps ? new lspCaps.LspManager({ workspaceRoot: cwd, healthMap }) : undefined;
    const browserManager = browserCaps ? new browserCaps.BrowserManager({ healthMap, networkPolicy }) : undefined;
    const searchProvider = (tavilyApiKey && searchCaps)
        ? new searchCaps.TavilySearchProvider(tavilyApiKey)
        : undefined;

    const workspaceId = deriveWorkspaceId(cwd);
    const indexDbPath = join(homedir(), '.aca', 'indexes', workspaceId, 'index.db');
    let indexer: Indexer | undefined;
    let backgroundThreshold = 0;
    let searchSemanticImpl: ToolImplementation | undefined;
    const getSearchSemanticImpl = async (): Promise<ToolImplementation> => {
        if (searchSemanticImpl) return searchSemanticImpl;

        const [
            { EmbeddingModel },
            { IndexStore },
            { BACKGROUND_THRESHOLD, Indexer: RuntimeIndexer },
            { createSearchSemanticImpl },
        ] = await Promise.all([
            import('../indexing/embedding.js'),
            import('../indexing/index-store.js'),
            import('../indexing/indexer.js'),
            import('../tools/search-semantic.js'),
        ]);

        const indexStore = new IndexStore(indexDbPath);
        indexStore.open();

        const embeddingModel = new EmbeddingModel();
        await embeddingModel.initialize();

        backgroundThreshold = BACKGROUND_THRESHOLD;
        const createdIndexer = new RuntimeIndexer(cwd, indexStore, embeddingModel);
        if (createdIndexer.estimateFileCount() > BACKGROUND_THRESHOLD) {
            void createdIndexer.buildIndexBackground().catch(() => {});
        } else {
            try {
                await createdIndexer.buildIndex();
            } catch {
                // search_semantic remains registered and reports index_unavailable when used
            }
        }

        indexer = createdIndexer;
        searchSemanticImpl = createSearchSemanticImpl({
            indexer: createdIndexer,
            store: indexStore,
            embedding: embeddingModel,
        });
        return searchSemanticImpl;
    };

    const { searchSemanticSpec } = await import('../tools/search-semantic.js');
    toolRegistry.register(searchSemanticSpec, async (args, context) => {
        const impl = await getSearchSemanticImpl();
        return impl(args, context);
    });
    if (lspCaps && lspManager) {
        toolRegistry.register(lspCaps.lspQuerySpec, lspCaps.createLspQueryImpl({ lspManager }));
    }

    if (browserCaps && browserManager) {
        const browserToolImpls = browserCaps.createBrowserToolImpls({ manager: browserManager, networkPolicy });
        for (const spec of browserCaps.BROWSER_TOOL_SPECS) {
            const impl = browserToolImpls.get(spec.name);
            if (impl) {
                toolRegistry.register(spec, impl);
            }
        }
    }

    if (searchCaps) {
        toolRegistry.register(searchCaps.webSearchSpec, searchCaps.createWebSearchImpl({ searchProvider, networkPolicy }));
    }
    if (fetchUrlCaps) {
        toolRegistry.register(fetchUrlCaps.fetchUrlSpec, fetchUrlCaps.createFetchUrlImpl({ networkPolicy, browserManager }));
    }
    if (mediaWikiCaps) {
        toolRegistry.register(mediaWikiCaps.fetchMediaWikiPageSpec, mediaWikiCaps.createFetchMediaWikiPageImpl({ networkPolicy }));
        toolRegistry.register(mediaWikiCaps.fetchMediaWikiCategorySpec, mediaWikiCaps.createFetchMediaWikiCategoryImpl({ networkPolicy }));
    }
    if (lookupDocsCaps) {
        toolRegistry.register(lookupDocsCaps.lookupDocsSpec, lookupDocsCaps.createLookupDocsImpl({ searchProvider, networkPolicy, browserManager }));
    }

    const refreshSemanticIndexForTurn = async (
        items: readonly ConversationItem[],
    ): Promise<IndexRefreshStatus> => {
        await ensureSemanticIndexReadyForTurnRefresh({
            items,
            getIndexer: () => indexer,
            initializeRuntime: getSearchSemanticImpl,
            backgroundThreshold,
        });
        return refreshIndexAfterTurn(indexer, items);
    };

    const agentRegistry = AgentRegistry.resolve(toolRegistry).registry;
    const delegationTracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
    const rootAgentId = generateId('agent') as AgentId;
    const rootIdentity: AgentIdentity = {
        id: rootAgentId,
        parentAgentId: null,
        rootAgentId,
        depth: 0,
        spawnIndex: 0,
        label: 'invoke-root',
    };
    const callerTools = Array.from(new Set([
        ...toolRegistry.list().map(tool => tool.spec.name),
        ...DELEGATION_TOOL_NAMES,
    ]));
    const rootCallerContext: SpawnCallerContext = {
        callerIdentity: rootIdentity,
        callerSessionId: sessionId,
        rootSessionId: sessionId,
        callerPreauths: [],
        callerAuthority: [],
        callerTools,
    };
    const buildSpawnDeps = (callerContext: SpawnCallerContext) => ({
        agentRegistry,
        delegationTracker,
        limits: DEFAULT_DELEGATION_LIMITS,
        createChildSession: (parentSessionId: SessionId, rootSessionId: SessionId) => {
            const child = sessionManager.create(
                cwd,
                resolvedConfig && providerName
                    ? buildSessionConfigSnapshot(resolvedConfig, {
                        workspaceRoot: cwd,
                        model,
                        provider: providerName,
                        mode: 'sub-agent',
                    })
                    : {
                        model,
                        mode: 'sub-agent',
                    },
                {
                    parentSessionId,
                    rootSessionId,
                },
            );
            return child.manifest.sessionId;
        },
        ...(delegationRuntime ? {
            onSpawn: createDelegationLaunchHandler({
                provider: delegationRuntime.provider,
                providerName: delegationRuntime.providerName,
                model,
                autoConfirm: delegationRuntime.autoConfirm,
                workspaceRoot: cwd,
                shell: delegationRuntime.shell,
                rootToolRegistry: toolRegistry,
                sessionManager,
                scrubber: delegationRuntime.scrubber,
                networkPolicy,
                healthMap,
                resolvedConfig: delegationRuntime.resolvedConfig,
                sessionGrants: delegationRuntime.sessionGrants,
                extraTrustedRoots: delegationRuntime.extraTrustedRoots,
                spawnDepsFactory: buildSpawnDeps,
            }),
        } : {}),
    });

    toolRegistry.register(
        spawnAgentSpec,
        createSpawnAgentImpl(buildSpawnDeps(rootCallerContext), rootCallerContext),
    );
    toolRegistry.register(messageAgentSpec, createMessageAgentImpl({ delegationTracker }));
    toolRegistry.register(awaitAgentSpec, createAwaitAgentImpl({ delegationTracker }));

    return {
        agentRegistry,
        rootCallerContext,
        refreshSemanticIndexAfterTurn: refreshSemanticIndexForTurn,
    };
}
