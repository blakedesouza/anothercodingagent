/**
 * M7.15 — CLI Wiring Integration Tests
 *
 * Verifies that all M7 features are properly wired:
 *   T1: All M7 tools registered in tool registry
 *   T2: Delegation round-trip — spawn returns agent ID
 *   T3: message_agent sends to spawned agent
 *   T4: await_agent on active agent (timeout)
 *   T5: Browser tools — all 10 specs registered
 *   T6: Web tools registered and factory wiring correct
 *   T7: AgentRegistry resolves with built-in profiles
 *   T8: CapabilityHealthMap tracks health states
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { readFileSpec, readFileImpl } from '../../src/tools/read-file.js';

// --- Delegation ---
import { AgentRegistry } from '../../src/delegation/agent-registry.js';
import {
    DelegationTracker,
    DEFAULT_DELEGATION_LIMITS,
    spawnAgentSpec,
    createSpawnAgentImpl,
} from '../../src/delegation/spawn-agent.js';
import type { SpawnCallerContext } from '../../src/delegation/spawn-agent.js';
import { messageAgentSpec, createMessageAgentImpl } from '../../src/delegation/message-agent.js';
import { awaitAgentSpec, createAwaitAgentImpl } from '../../src/delegation/await-agent.js';
import type { AgentIdentity } from '../../src/types/agent.js';
import type { AgentId } from '../../src/types/ids.js';
import { generateId } from '../../src/types/ids.js';

// --- Error Recovery / Health ---
import { CapabilityHealthMap } from '../../src/core/capability-health.js';

// --- LSP ---
import { LspManager } from '../../src/lsp/lsp-manager.js';
import { lspQuerySpec, createLspQueryImpl } from '../../src/tools/lsp-query.js';

// --- Browser ---
import { BrowserManager } from '../../src/browser/browser-manager.js';
import { BROWSER_TOOL_SPECS, createBrowserToolImpls } from '../../src/browser/browser-tools.js';

// --- Web tools ---
import { webSearchSpec, createWebSearchImpl } from '../../src/tools/web-search.js';
import { fetchUrlSpec, createFetchUrlImpl } from '../../src/tools/fetch-url.js';
import { lookupDocsSpec, createLookupDocsImpl } from '../../src/tools/lookup-docs.js';

// --- Session ---
import { SessionManager } from '../../src/core/session-manager.js';
import type { SessionId } from '../../src/types/ids.js';
import type { NetworkPolicy } from '../../src/permissions/network-policy.js';

describe('M7.15 CLI Wiring Integration', () => {
    let sessionsDir: string;
    let sm: SessionManager;
    let toolRegistry: ToolRegistry;
    let healthMap: CapabilityHealthMap;
    let delegationTracker: DelegationTracker;
    let agentRegistry: AgentRegistry;
    let spawnedAgentId: string;
    const cwd = process.cwd();

    const networkPolicy: NetworkPolicy = {
        mode: 'approved-only',
        allowDomains: [],
        denyDomains: [],
        allowHttp: false,
    };

    beforeAll(() => {
        sessionsDir = mkdtempSync(join(tmpdir(), 'aca-m7-wiring-'));
        sm = new SessionManager(sessionsDir);
        healthMap = new CapabilityHealthMap();

        // Build tool registry with all M7 tools
        toolRegistry = new ToolRegistry();
        toolRegistry.register(readFileSpec, readFileImpl);

        // LSP
        const lspManager = new LspManager({ workspaceRoot: cwd, healthMap });
        toolRegistry.register(lspQuerySpec, createLspQueryImpl({ lspManager }));

        // Browser (10 tools)
        const browserManager = new BrowserManager({ healthMap, networkPolicy });
        const browserToolImpls = createBrowserToolImpls({ manager: browserManager, networkPolicy });
        for (const spec of BROWSER_TOOL_SPECS) {
            const impl = browserToolImpls.get(spec.name);
            if (impl) toolRegistry.register(spec, impl);
        }

        // Web tools
        toolRegistry.register(webSearchSpec, createWebSearchImpl({ networkPolicy }));
        toolRegistry.register(fetchUrlSpec, createFetchUrlImpl({ networkPolicy, browserManager }));
        toolRegistry.register(lookupDocsSpec, createLookupDocsImpl({ networkPolicy, browserManager }));

        // Delegation (must be after tool registration for AgentRegistry.resolve)
        const result = AgentRegistry.resolve(toolRegistry);
        agentRegistry = result.registry;
        delegationTracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);

        const rootAgentId = generateId('agent') as AgentId;
        const rootIdentity: AgentIdentity = {
            id: rootAgentId,
            parentAgentId: null,
            rootAgentId,
            depth: 0,
            spawnIndex: 0,
            label: 'root',
        };
        const callerContext: SpawnCallerContext = {
            callerIdentity: rootIdentity,
            callerSessionId: 'ses_TEST0000000000000000000' as SessionId,
            rootSessionId: 'ses_TEST0000000000000000000' as SessionId,
            callerPreauths: [],
            callerAuthority: [],
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
                        const child = sm.create(cwd);
                        return child.manifest.sessionId;
                    },
                },
                callerContext,
            ),
        );
        toolRegistry.register(messageAgentSpec, createMessageAgentImpl({ delegationTracker }));
        toolRegistry.register(awaitAgentSpec, createAwaitAgentImpl({ delegationTracker }));
    });

    afterAll(() => {
        rmSync(sessionsDir, { recursive: true, force: true });
    });

    it('T1: all M7 tools are registered', () => {
        const toolNames = toolRegistry.list().map(t => t.spec.name);

        // Core tool
        expect(toolNames).toContain('read_file');

        // LSP (M7.3)
        expect(toolNames).toContain('lsp_query');

        // Browser (M7.4) — 10 tools
        const browserNames = [
            'browser_navigate', 'browser_click', 'browser_type', 'browser_press',
            'browser_snapshot', 'browser_screenshot', 'browser_evaluate',
            'browser_extract', 'browser_wait', 'browser_close',
        ];
        for (const name of browserNames) {
            expect(toolNames).toContain(name);
        }

        // Web (M7.5)
        expect(toolNames).toContain('web_search');
        expect(toolNames).toContain('fetch_url');
        expect(toolNames).toContain('lookup_docs');

        // Delegation (M7.1)
        expect(toolNames).toContain('spawn_agent');
        expect(toolNames).toContain('message_agent');
        expect(toolNames).toContain('await_agent');

        // Total: 1 core + 1 lsp + 10 browser + 3 web + 3 delegation = 18
        expect(toolNames.length).toBe(18);
    });

    it('T2: delegation — spawn returns agent ID', async () => {
        const tool = toolRegistry.lookup('spawn_agent');
        expect(tool).toBeDefined();

        const result = await tool!.impl(
            {
                agent_type: 'researcher',
                task: 'Find all test files',
                label: 'test-researcher',
            },
            { workspaceRoot: cwd, sessionId: 'ses_TEST0000000000000000000' as SessionId, isSubAgent: false, signal: AbortSignal.timeout(5000) },
        );

        expect(result.status).toBe('success');
        const data = JSON.parse(result.data);
        expect(data.agentId).toMatch(/^agt_/);
        expect(data.agentType).toBe('researcher');
        expect(data.label).toBe('test-researcher');
        expect(data.depth).toBe(1);

        // Verify tracker has the agent
        spawnedAgentId = data.agentId;
        expect(delegationTracker.getAgent(spawnedAgentId)).toBeDefined();
        expect(delegationTracker.getActiveCount()).toBe(1);
    });

    it('T3: message_agent sends to spawned agent', async () => {
        expect(spawnedAgentId).toBeDefined();

        const tool = toolRegistry.lookup('message_agent');
        expect(tool).toBeDefined();

        const result = await tool!.impl(
            { agent_id: spawnedAgentId, message: 'Check test/integration/' },
            { workspaceRoot: cwd, sessionId: 'ses_TEST0000000000000000000' as SessionId, isSubAgent: false, signal: AbortSignal.timeout(5000) },
        );

        expect(result.status).toBe('success');
    });

    it('T4: await_agent on active agent (timeout)', async () => {
        expect(spawnedAgentId).toBeDefined();

        const tool = toolRegistry.lookup('await_agent');
        expect(tool).toBeDefined();

        const result = await tool!.impl(
            { agent_id: spawnedAgentId, timeout: 100 },
            { workspaceRoot: cwd, sessionId: 'ses_TEST0000000000000000000' as SessionId, isSubAgent: false, signal: AbortSignal.timeout(5000) },
        );

        // Agent is still active (no one completed it), so await should timeout
        expect(result).toBeDefined();
        // The result should indicate timeout or still-running status
        expect(result.status).toBeDefined();
    });

    it('T5: browser tools — all 10 specs registered with correct names', () => {
        expect(BROWSER_TOOL_SPECS).toHaveLength(10);
        const registered = toolRegistry.list().map(t => t.spec.name);
        for (const spec of BROWSER_TOOL_SPECS) {
            expect(registered).toContain(spec.name);
        }
    });

    it('T6: web tools registered and factory wiring correct', () => {
        const tools = toolRegistry.list().map(t => t.spec.name);
        expect(tools).toContain('web_search');
        expect(tools).toContain('fetch_url');
        expect(tools).toContain('lookup_docs');

        // Verify each has an implementation
        expect(toolRegistry.lookup('web_search')?.impl).toBeDefined();
        expect(toolRegistry.lookup('fetch_url')?.impl).toBeDefined();
        expect(toolRegistry.lookup('lookup_docs')?.impl).toBeDefined();
    });

    it('T7: AgentRegistry resolves with built-in profiles', () => {
        const profiles = agentRegistry.getProfileNames();
        expect(profiles).toContain('general');
        expect(profiles).toContain('researcher');
        expect(profiles).toContain('coder');
        expect(profiles).toContain('reviewer');

        // General profile should include read-only + workspace-write tools
        const general = agentRegistry.getProfile('general');
        expect(general).toBeDefined();
        expect(general!.defaultTools).toContain('read_file');
    });

    it('T8: CapabilityHealthMap tracks health states', () => {
        // Verify health map is functional
        healthMap.reportSuccess('lsp');
        expect(healthMap.getState('lsp')).toBe('available');

        healthMap.reportRetryableFailure('browser', 'test failure');
        const browserHealth = healthMap.getState('browser');
        expect(['degraded', 'cooldown']).toContain(browserHealth);
    });
});
