import { setTimeout as delay } from 'node:timers/promises';
import type { ToolImplementation } from '../tools/tool-registry.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { ProviderDriver } from '../types/provider.js';
import type { ConversationItem, ToolOutput } from '../types/conversation.js';
import type { SecretScrubber } from '../permissions/secret-scrubber.js';
import type { NetworkPolicy } from '../permissions/network-policy.js';
import type { CapabilityHealthMap } from '../core/capability-health.js';
import type { ResolvedConfig } from '../config/schema.js';
import type { SessionManager } from '../core/session-manager.js';
import type { SessionGrantStore } from '../permissions/session-grants.js';
import type { AgentResult, ApprovalRequest } from '../types/agent.js';
import type { SpawnAgentDeps, SpawnLaunchPayload, SpawnCallerContext } from './spawn-agent.js';
import { createSpawnAgentImpl, spawnAgentSpec, type AuthorityRule, type DelegationTracker } from './spawn-agent.js';
import { createMessageAgentImpl, messageAgentSpec } from './message-agent.js';
import { createAwaitAgentImpl, awaitAgentSpec } from './await-agent.js';
import { askUserSpec } from '../tools/ask-user.js';
import { confirmActionSpec } from '../tools/confirm-action.js';
import { TurnEngine } from '../core/turn-engine.js';
import { buildSystemMessagesForTier } from '../core/prompt-assembly.js';
import { prepareInvokeTurnConfig, finalizeInvokeTurnState } from '../cli/invoke-runtime-state.js';
import type { TurnEngineConfig } from '../core/turn-engine.js';

const DELEGATION_IDLE_WAIT_MS = 750;
const DELEGATION_POLL_MS = 50;

export interface DelegationRuntimeOptions {
    provider: ProviderDriver;
    providerName: string;
    model: string;
    autoConfirm: boolean;
    workspaceRoot: string;
    shell?: string;
    rootToolRegistry: ToolRegistry;
    sessionManager: SessionManager;
    scrubber?: SecretScrubber;
    networkPolicy: NetworkPolicy;
    healthMap: CapabilityHealthMap;
    resolvedConfig?: ResolvedConfig;
    sessionGrants: SessionGrantStore;
    extraTrustedRoots?: string[];
    spawnDepsFactory: (callerContext: SpawnCallerContext) => SpawnAgentDeps;
}

function flattenAssistantText(items: readonly ConversationItem[]): string {
    const parts: string[] = [];
    for (const item of items) {
        if (item.kind !== 'message' || item.role !== 'assistant') continue;
        for (const part of item.parts) {
            if (part.type === 'text') {
                parts.push(part.text);
            }
        }
    }
    return parts.join('').trim();
}

function summarizeToolCalls(items: readonly ConversationItem[]): AgentResult['toolCallSummary'] {
    const counts = new Map<string, number>();
    for (const item of items) {
        if (item.kind !== 'tool_result') continue;
        counts.set(item.toolName, (counts.get(item.toolName) ?? 0) + 1);
    }
    return [...counts.entries()].map(([tool, count]) => ({ tool, count }));
}

function mapAuthority(authority: readonly AuthorityRule[]): NonNullable<TurnEngineConfig['authority']> {
    return authority.map(rule => ({
        tool: rule.tool,
        args_match: rule.match,
        decision: rule.decision === 'allow' ? 'approve' : 'deny',
    }));
}

function mergeTask(task: string, contextText: string): string {
    if (!contextText.trim()) return task;
    return `${task}\n\nAdditional context:\n${contextText}`;
}

function buildApprovalRequest(
    payload: SpawnLaunchPayload,
    tool: 'ask_user' | 'confirm_action',
    args: Record<string, unknown>,
    reason: string,
    resolve: (answer: string) => void,
): ApprovalRequest {
    return {
        type: 'approval_required',
        toolCall: { tool, args },
        reason,
        childLineage: [{
            agentId: payload.identity.id,
            depth: payload.identity.depth,
            label: payload.identity.label,
        }],
        resolve,
    };
}

function parseApprovalLikeAnswer(answer: string): boolean {
    const normalized = answer.trim().toLowerCase();
    return ['y', 'yes', 'approve', 'approved', 'always', 'true'].includes(normalized);
}

function childAskUserImpl(
    payload: SpawnLaunchPayload,
    tracker: DelegationTracker,
): ToolImplementation {
    return async (args): Promise<ToolOutput> => {
        const question = typeof args.question === 'string' ? args.question : '';
        const choices = Array.isArray(args.choices) ? args.choices.filter((v): v is string => typeof v === 'string') : undefined;
        tracker.updatePhase(payload.identity.id, 'waiting', null, question || 'Waiting for parent response');
        const response = await new Promise<string>((resolve) => {
            tracker.setPendingApproval(
                payload.identity.id,
                buildApprovalRequest(
                    payload,
                    'ask_user',
                    {
                        question,
                        ...(choices && choices.length > 0 ? { choices } : {}),
                    },
                    question || 'ask_user requires parent response',
                    resolve,
                ),
            );
        });
        tracker.updatePhase(payload.identity.id, 'thinking', null, 'Resuming after parent response');
        const data = JSON.stringify({ response });
        return {
            status: 'success',
            data,
            truncated: false,
            bytesReturned: Buffer.byteLength(data, 'utf8'),
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        };
    };
}

function childConfirmActionImpl(
    payload: SpawnLaunchPayload,
    tracker: DelegationTracker,
): ToolImplementation {
    return async (args): Promise<ToolOutput> => {
        const action = typeof args.action === 'string' ? args.action : 'Confirm action';
        tracker.updatePhase(payload.identity.id, 'waiting', null, action);
        const response = await new Promise<string>((resolve) => {
            tracker.setPendingApproval(
                payload.identity.id,
                buildApprovalRequest(
                    payload,
                    'confirm_action',
                    args,
                    action,
                    resolve,
                ),
            );
        });
        tracker.updatePhase(payload.identity.id, 'thinking', null, 'Resuming after approval response');
        const approved = parseApprovalLikeAnswer(response);
        const data = JSON.stringify({ approved });
        return {
            status: 'success',
            data,
            truncated: false,
            bytesReturned: Buffer.byteLength(data, 'utf8'),
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        };
    };
}

function wrapToolImpl(
    agentId: string,
    tracker: DelegationTracker,
    impl: ToolImplementation,
    toolName: string,
): ToolImplementation {
    return async (args, context) => {
        tracker.updatePhase(agentId, 'tool', toolName, `Running ${toolName}`);
        try {
            return await impl(args, context);
        } finally {
            const current = tracker.getAgent(agentId);
            if (current?.status === 'active' && current.pendingApproval === null) {
                tracker.updatePhase(agentId, 'thinking', null, 'Continuing task');
            }
        }
    };
}

function buildChildToolRegistry(
    options: DelegationRuntimeOptions,
    payload: SpawnLaunchPayload,
    childCallerContext: SpawnCallerContext,
    childSpawnDeps: SpawnAgentDeps,
    tracker: DelegationTracker,
): ToolRegistry {
    const registry = new ToolRegistry();
    const messageImpl = createMessageAgentImpl({ delegationTracker: tracker });
    const awaitImpl = createAwaitAgentImpl({ delegationTracker: tracker });

    for (const tool of options.rootToolRegistry.list()) {
        if (tool.spec.name === spawnAgentSpec.name) {
            registry.register(spawnAgentSpec, createSpawnAgentImpl(childSpawnDeps, childCallerContext));
            continue;
        }
        if (tool.spec.name === messageAgentSpec.name) {
            registry.register(messageAgentSpec, messageImpl);
            continue;
        }
        if (tool.spec.name === awaitAgentSpec.name) {
            registry.register(awaitAgentSpec, awaitImpl);
            continue;
        }
        if (tool.spec.name === askUserSpec.name) {
            registry.register(askUserSpec, childAskUserImpl(payload, tracker));
            continue;
        }
        if (tool.spec.name === confirmActionSpec.name) {
            registry.register(confirmActionSpec, childConfirmActionImpl(payload, tracker));
            continue;
        }
        registry.register(
            tool.spec,
            wrapToolImpl(payload.identity.id, tracker, tool.impl, tool.spec.name),
        );
    }

    return registry;
}

async function waitForQueuedMessage(tracker: DelegationTracker, agentId: string): Promise<string | null> {
    const deadline = Date.now() + DELEGATION_IDLE_WAIT_MS;
    while (Date.now() < deadline) {
        const message = tracker.dequeueMessage(agentId);
        if (message) return message;
        await delay(DELEGATION_POLL_MS);
    }
    return tracker.dequeueMessage(agentId) ?? null;
}

async function runChildAgent(
    options: DelegationRuntimeOptions,
    payload: SpawnLaunchPayload,
): Promise<void> {
    const childSpawnDeps = options.spawnDepsFactory({
        callerIdentity: payload.identity,
        callerSessionId: payload.childSessionId,
        rootSessionId: payload.rootSessionId,
        callerPreauths: payload.preAuthorizedPatterns,
        callerAuthority: payload.authority,
        callerTools: payload.tools,
    });
    const tracker = childSpawnDeps.delegationTracker;
    const projection = options.sessionManager.load(payload.childSessionId);
    const childCallerContext: SpawnCallerContext = {
        callerIdentity: payload.identity,
        callerSessionId: payload.childSessionId,
        rootSessionId: payload.rootSessionId,
        callerPreauths: payload.preAuthorizedPatterns,
        callerAuthority: payload.authority,
        callerTools: payload.tools,
    };
    const childToolRegistry = buildChildToolRegistry(options, payload, childCallerContext, childSpawnDeps, tracker);
    const engine = new TurnEngine(
        options.provider,
        childToolRegistry,
        projection.writer,
        projection.sequenceGenerator,
        options.scrubber,
        undefined,
        undefined,
        options.networkPolicy,
        options.healthMap,
        undefined,
        undefined,
    );

    let conversationItems = [...projection.items];
    let nextTask: string | null = mergeTask(payload.task, payload.context);
    let lastResult: Awaited<ReturnType<typeof engine.executeTurn>> | null = null;

    while (nextTask) {
        tracker.updatePhase(payload.identity.id, 'thinking', null, `Working on ${payload.profile.name} task`);
        const systemMessages = buildSystemMessagesForTier(payload.profile.promptTier, {
            cwd: options.workspaceRoot,
            toolNames: [...payload.tools],
            model: payload.profile.defaultModel ?? options.model,
            profileName: payload.profile.name,
            profilePrompt: payload.profile.systemPrompt,
        });
        const turnConfig = await prepareInvokeTurnConfig({
            conversationItems,
            task: nextTask,
            projection,
            provider: options.provider,
            model: payload.profile.defaultModel ?? options.model,
            tools: childToolRegistry.list(),
            workspaceRoot: options.workspaceRoot,
            shell: options.shell,
            healthMap: options.healthMap,
            baseConfig: {
                sessionId: payload.childSessionId,
                model: payload.profile.defaultModel ?? options.model,
                provider: options.providerName,
                interactive: false,
                autoConfirm: options.autoConfirm,
                isSubAgent: true,
                workspaceRoot: options.workspaceRoot,
                shell: options.shell,
                resolvedConfig: options.resolvedConfig,
                sessionGrants: options.sessionGrants,
                allowedTools: [...payload.tools],
                authority: mapAuthority(payload.authority),
                extraTrustedRoots: options.extraTrustedRoots,
                maxSteps: 25,
                maxToolCalls: 32,
            },
            baseSystemMessages: systemMessages,
            includeRuntimeContextMessage: true,
        });
        const result = await engine.executeTurn(turnConfig, nextTask, conversationItems);
        await finalizeInvokeTurnState(options.sessionManager, projection, options.workspaceRoot, result.items);
        conversationItems = [...conversationItems, ...result.items];
        lastResult = result;

        if (result.turn.outcome === 'cancelled') {
            tracker.markCompleted(payload.identity.id, 'cancelled', {
                status: 'cancelled',
                output: flattenAssistantText(result.items),
                tokenUsage: {
                    input: result.steps.reduce((sum, step) => sum + step.tokenUsage.inputTokens, 0),
                    output: result.steps.reduce((sum, step) => sum + step.tokenUsage.outputTokens, 0),
                },
                toolCallSummary: summarizeToolCalls(result.items),
            });
            return;
        }

        if (result.turn.outcome !== 'assistant_final') {
            tracker.markCompleted(payload.identity.id, 'failed', {
                status: 'failed',
                output: result.lastError?.message ?? `Child turn ended with ${result.turn.outcome ?? 'unknown outcome'}`,
                tokenUsage: {
                    input: result.steps.reduce((sum, step) => sum + step.tokenUsage.inputTokens, 0),
                    output: result.steps.reduce((sum, step) => sum + step.tokenUsage.outputTokens, 0),
                },
                toolCallSummary: summarizeToolCalls(result.items),
            });
            return;
        }

        tracker.updatePhase(payload.identity.id, 'waiting', null, 'Waiting for follow-up messages');
        nextTask = await waitForQueuedMessage(tracker, payload.identity.id);
    }

    const finalResult = lastResult;
    tracker.markCompleted(payload.identity.id, 'completed', {
        status: 'completed',
        output: finalResult ? flattenAssistantText(finalResult.items) : '',
        tokenUsage: {
            input: finalResult ? finalResult.steps.reduce((sum, step) => sum + step.tokenUsage.inputTokens, 0) : 0,
            output: finalResult ? finalResult.steps.reduce((sum, step) => sum + step.tokenUsage.outputTokens, 0) : 0,
        },
        toolCallSummary: finalResult ? summarizeToolCalls(finalResult.items) : [],
    });
}

export function createDelegationLaunchHandler(
    options: DelegationRuntimeOptions,
): (payload: SpawnLaunchPayload) => void {
    return (payload: SpawnLaunchPayload) => {
        void runChildAgent(options, payload).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            const tracker = options.spawnDepsFactory({
                callerIdentity: payload.identity,
                callerSessionId: payload.childSessionId,
                rootSessionId: payload.rootSessionId,
                callerPreauths: payload.preAuthorizedPatterns,
                callerAuthority: payload.authority,
                callerTools: payload.tools,
            }).delegationTracker;
            tracker.markCompleted(payload.identity.id, 'failed', {
                status: 'failed',
                output: `Child agent crashed: ${message}`,
                tokenUsage: { input: 0, output: 0 },
                toolCallSummary: [],
            });
        });
    };
}
