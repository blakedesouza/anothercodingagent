import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/core/session-manager.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolImplementation, ToolSpec, ToolContext } from '../../src/tools/tool-registry.js';
import { AgentRegistry, DELEGATION_TOOL_NAMES } from '../../src/delegation/agent-registry.js';
import {
    DelegationTracker,
    DEFAULT_DELEGATION_LIMITS,
    createSpawnAgentImpl,
    spawnAgentSpec,
    type SpawnAgentDeps,
    type SpawnCallerContext,
} from '../../src/delegation/spawn-agent.js';
import { createMessageAgentImpl, messageAgentSpec } from '../../src/delegation/message-agent.js';
import { createAwaitAgentImpl, awaitAgentSpec } from '../../src/delegation/await-agent.js';
import { createDelegationLaunchHandler } from '../../src/delegation/agent-runtime.js';
import { SessionGrantStore } from '../../src/permissions/session-grants.js';
import { CapabilityHealthMap } from '../../src/core/capability-health.js';
import type { NetworkPolicy } from '../../src/permissions/network-policy.js';
import type { AgentIdentity } from '../../src/types/agent.js';
import type { AgentId, SessionId } from '../../src/types/ids.js';
import type {
    ModelCapabilities,
    ModelRequest,
    ProviderDriver,
    StreamEvent,
} from '../../src/types/provider.js';

const cleanupPaths: string[] = [];

afterEach(() => {
    while (cleanupPaths.length > 0) {
        const path = cleanupPaths.pop();
        if (path) rmSync(path, { recursive: true, force: true });
    }
});

const noopImpl: ToolImplementation = async () => ({
    status: 'success',
    data: '',
    truncated: false,
    bytesReturned: 0,
    bytesOmitted: 0,
    retryable: false,
    timedOut: false,
    mutationState: 'none',
});

function makeToolSpec(name: string, approvalClass: ToolSpec['approvalClass'] = 'read-only'): ToolSpec {
    return {
        name,
        description: `Test tool: ${name}`,
        inputSchema: {},
        approvalClass,
        idempotent: true,
        timeoutCategory: 'file',
    };
}

function createProvider(): ProviderDriver {
    const capabilities: ModelCapabilities = {
        maxContext: 32_000,
        maxOutput: 512,
        supportsTools: 'none',
        supportsVision: false,
        supportsStreaming: true,
        supportsPrefill: false,
        supportsEmbedding: false,
        embeddingModels: [],
        toolReliability: 'native',
        costPerMillion: { input: 0, output: 0 },
        specialFeatures: [],
        bytesPerToken: 3,
    };
    return {
        capabilities: () => capabilities,
        validate: () => ({ ok: true, value: undefined }),
        async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
            const userMessages = request.messages.filter(message => message.role === 'user');
            const lastUser = userMessages[userMessages.length - 1];
            const content = typeof lastUser?.content === 'string' ? lastUser.content : '';
            let text = 'CHILD_FALLBACK';
            if (content.includes('FOLLOW_UP_DONE')) {
                text = 'FOLLOW_UP_DONE';
            } else if (content.includes('CHILD_OK')) {
                text = 'CHILD_OK';
            } else if (content.includes('FIRST_DONE')) {
                text = 'FIRST_DONE';
            }
            yield { type: 'text_delta', text };
            yield {
                type: 'done',
                finishReason: 'stop',
                usage: { inputTokens: 20, outputTokens: 5 },
            };
        },
    };
}

function parseJson(data: string): Record<string, unknown> {
    return JSON.parse(data) as Record<string, unknown>;
}

function makeRootIdentity(): AgentIdentity {
    const rootAgentId = 'agt_00000000000000000000000001' as AgentId;
    return {
        id: rootAgentId,
        parentAgentId: null,
        rootAgentId,
        depth: 0,
        spawnIndex: 0,
        label: 'root',
    };
}

function makeStubContext(sessionId: SessionId, workspaceRoot: string): ToolContext {
    return {
        sessionId,
        workspaceRoot,
        signal: AbortSignal.timeout(5000),
    };
}

describe('delegation runtime', () => {
    it('spawn_agent launches a child runtime and await_agent returns the completed result', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'aca-agent-runtime-ws-'));
        const sessionsDir = mkdtempSync(join(tmpdir(), 'aca-agent-runtime-sessions-'));
        cleanupPaths.push(workspaceRoot, sessionsDir);

        const sessionManager = new SessionManager(sessionsDir);
        const projection = sessionManager.create(workspaceRoot, {
            model: 'mock-model',
        });
        const tracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
        const healthMap = new CapabilityHealthMap();
        const networkPolicy: NetworkPolicy = {
            mode: 'approved-only',
            allowDomains: [],
            denyDomains: [],
            allowHttp: false,
        };

        const toolRegistry = new ToolRegistry();
        toolRegistry.register(makeToolSpec('read_file'), noopImpl);
        const { registry: agentRegistry } = AgentRegistry.resolve(toolRegistry);
        const sessionGrants = new SessionGrantStore();
        const rootIdentity = makeRootIdentity();
        const rootCallerContext: SpawnCallerContext = {
            callerIdentity: rootIdentity,
            callerSessionId: projection.manifest.sessionId,
            rootSessionId: projection.manifest.sessionId,
            callerPreauths: [],
            callerAuthority: [],
            callerTools: Array.from(new Set([
                ...toolRegistry.list().map(tool => tool.spec.name),
                ...DELEGATION_TOOL_NAMES,
            ])),
        };
        const spawnDepsFactory = (callerContext: SpawnCallerContext): SpawnAgentDeps => ({
            agentRegistry,
            delegationTracker: tracker,
            limits: DEFAULT_DELEGATION_LIMITS,
            createChildSession: (parentSessionId, rootSessionId) => {
                const child = sessionManager.create(
                    workspaceRoot,
                    { model: 'mock-model', mode: 'sub-agent' },
                    { parentSessionId, rootSessionId },
                );
                return child.manifest.sessionId;
            },
            onSpawn: createDelegationLaunchHandler({
                provider: createProvider(),
                providerName: 'mock',
                model: 'mock-model',
                autoConfirm: true,
                workspaceRoot,
                rootToolRegistry: toolRegistry,
                sessionManager,
                networkPolicy,
                healthMap,
                sessionGrants,
                spawnDepsFactory,
            }),
        });

        toolRegistry.register(spawnAgentSpec, createSpawnAgentImpl(spawnDepsFactory(rootCallerContext), rootCallerContext));
        toolRegistry.register(messageAgentSpec, createMessageAgentImpl({ delegationTracker: tracker }));
        toolRegistry.register(awaitAgentSpec, createAwaitAgentImpl({ delegationTracker: tracker }));

        const spawnResult = await toolRegistry.lookup('spawn_agent')!.impl(
            {
                agent_type: 'general',
                task: 'Reply with exactly CHILD_OK and nothing else.',
            },
            makeStubContext(projection.manifest.sessionId, workspaceRoot),
        );

        expect(spawnResult.status).toBe('success');
        const spawnData = parseJson(spawnResult.data);
        const agentId = spawnData.agentId as string;

        const awaitResult = await toolRegistry.lookup('await_agent')!.impl(
            { agent_id: agentId, timeout: 5000 },
            makeStubContext(projection.manifest.sessionId, workspaceRoot),
        );

        expect(awaitResult.status).toBe('success');
        const awaitData = parseJson(awaitResult.data);
        expect(awaitData.status).toBe('completed');
        expect(awaitData.output).toBe('CHILD_OK');
    });

    it('message_agent follow-up is consumed by the child runtime before completion', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'aca-agent-runtime-ws-'));
        const sessionsDir = mkdtempSync(join(tmpdir(), 'aca-agent-runtime-sessions-'));
        cleanupPaths.push(workspaceRoot, sessionsDir);

        const sessionManager = new SessionManager(sessionsDir);
        const projection = sessionManager.create(workspaceRoot, {
            model: 'mock-model',
        });
        const tracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
        const healthMap = new CapabilityHealthMap();
        const networkPolicy: NetworkPolicy = {
            mode: 'approved-only',
            allowDomains: [],
            denyDomains: [],
            allowHttp: false,
        };

        const toolRegistry = new ToolRegistry();
        toolRegistry.register(makeToolSpec('read_file'), noopImpl);
        const { registry: agentRegistry } = AgentRegistry.resolve(toolRegistry);
        const sessionGrants = new SessionGrantStore();
        const rootIdentity = makeRootIdentity();
        const rootCallerContext: SpawnCallerContext = {
            callerIdentity: rootIdentity,
            callerSessionId: projection.manifest.sessionId,
            rootSessionId: projection.manifest.sessionId,
            callerPreauths: [],
            callerAuthority: [],
            callerTools: Array.from(new Set([
                ...toolRegistry.list().map(tool => tool.spec.name),
                ...DELEGATION_TOOL_NAMES,
            ])),
        };
        const spawnDepsFactory = (callerContext: SpawnCallerContext): SpawnAgentDeps => ({
            agentRegistry,
            delegationTracker: tracker,
            limits: DEFAULT_DELEGATION_LIMITS,
            createChildSession: (parentSessionId, rootSessionId) => {
                const child = sessionManager.create(
                    workspaceRoot,
                    { model: 'mock-model', mode: 'sub-agent' },
                    { parentSessionId, rootSessionId },
                );
                return child.manifest.sessionId;
            },
            onSpawn: createDelegationLaunchHandler({
                provider: createProvider(),
                providerName: 'mock',
                model: 'mock-model',
                autoConfirm: true,
                workspaceRoot,
                rootToolRegistry: toolRegistry,
                sessionManager,
                networkPolicy,
                healthMap,
                sessionGrants,
                spawnDepsFactory,
            }),
        });

        toolRegistry.register(spawnAgentSpec, createSpawnAgentImpl(spawnDepsFactory(rootCallerContext), rootCallerContext));
        toolRegistry.register(messageAgentSpec, createMessageAgentImpl({ delegationTracker: tracker }));
        toolRegistry.register(awaitAgentSpec, createAwaitAgentImpl({ delegationTracker: tracker }));

        const spawnResult = await toolRegistry.lookup('spawn_agent')!.impl(
            {
                agent_type: 'general',
                task: 'Reply with exactly FIRST_DONE and nothing else.',
            },
            makeStubContext(projection.manifest.sessionId, workspaceRoot),
        );
        const spawnData = parseJson(spawnResult.data);
        const agentId = spawnData.agentId as string;

        const messageResult = await toolRegistry.lookup('message_agent')!.impl(
            {
                agent_id: agentId,
                message: 'Reply with exactly FOLLOW_UP_DONE and nothing else.',
            },
            makeStubContext(projection.manifest.sessionId, workspaceRoot),
        );

        expect(messageResult.status).toBe('success');

        const awaitResult = await toolRegistry.lookup('await_agent')!.impl(
            { agent_id: agentId, timeout: 5000 },
            makeStubContext(projection.manifest.sessionId, workspaceRoot),
        );

        expect(awaitResult.status).toBe('success');
        const awaitData = parseJson(awaitResult.data);
        expect(awaitData.status).toBe('completed');
        expect(awaitData.output).toBe('FOLLOW_UP_DONE');
    });
});
