/**
 * spawn_agent tool (Block 2, M7.1b).
 *
 * Spawns a scoped sub-agent with a dedicated child session. Enforces:
 * - Profile-based tool narrowing (allowed_tools ⊆ profile defaults)
 * - Authority narrowing (overrides may only restrict, never widen)
 * - Pre-authorization transport (narrowing-only)
 * - Hard limits: concurrent agents, delegation depth, total agents per session
 *
 * Approval class: external-effect (requires confirmation unless pre-authorized).
 */

import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from '../tools/tool-registry.js';
import type { AgentProfile, AgentIdentity, AgentPhase, ProgressSnapshot, AgentResult, ApprovalRequest } from '../types/agent.js';
import type { AgentId, SessionId } from '../types/ids.js';
import type { PreauthRule } from '../config/schema.js';
import type { AgentRegistry } from './agent-registry.js';
import { generateId } from '../types/ids.js';
import { DELEGATION_ERRORS, createAcaError } from '../types/errors.js';

// --- Tool spec ---

export const spawnAgentSpec: ToolSpec = {
    name: 'spawn_agent',
    description:
        'Start a scoped sub-agent for a specific task. ' +
        'Returns the agent ID and child session ID on success.',
    inputSchema: {
        type: 'object',
        properties: {
            agent_type: { type: 'string', minLength: 1 },
            task: { type: 'string', minLength: 1 },
            context: { type: 'string' },
            allowed_tools: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
            },
            authority: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        tool: { type: 'string' },
                        match: { type: 'object' },
                        decision: { type: 'string', enum: ['allow', 'deny'] },
                        scope: { type: 'string', enum: ['session', 'permanent'] },
                    },
                    required: ['id', 'tool', 'match', 'decision', 'scope'],
                },
            },
            label: { type: 'string' },
            preAuthorizedPatterns: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        tool: { type: 'string' },
                        match: { type: 'object' },
                        decision: { type: 'string', enum: ['allow', 'deny'] },
                        scope: { type: 'string', enum: ['session', 'permanent'] },
                    },
                    required: ['id', 'tool', 'match', 'decision', 'scope'],
                },
            },
        },
        required: ['agent_type', 'task'],
        additionalProperties: false,
    },
    approvalClass: 'external-effect',
    idempotent: false,
    timeoutCategory: 'delegation',
};

// --- Delegation limits ---

export interface DelegationLimits {
    maxConcurrentAgents: number;
    maxDelegationDepth: number;
    maxTotalAgents: number;
}

export const DEFAULT_DELEGATION_LIMITS: DelegationLimits = {
    maxConcurrentAgents: 4,
    maxDelegationDepth: 2,
    maxTotalAgents: 20,
};

export interface AuthorityRule {
    id: string;
    tool: string;
    match: Record<string, unknown>;
    decision: 'allow' | 'deny';
    scope: 'session' | 'permanent';
}

// --- Delegation tracker ---

export type AgentStatus = 'active' | 'completed' | 'failed' | 'cancelled';

export interface TrackedAgent {
    identity: AgentIdentity;
    parentSessionId: SessionId;
    childSessionId: SessionId;
    status: AgentStatus;
    tools: readonly string[];
    preAuthorizedPatterns: PreauthRule[];
    authority: AuthorityRule[];
    profileName: string;
    task: string;
    context: string;
    /** Current lifecycle phase (M7.1c). */
    phase: AgentPhase;
    /** Currently active tool name, or null. */
    activeTool: string | null;
    /** ISO timestamp of last event from this agent. */
    lastEventAt: string;
    /** Epoch ms when the agent was spawned (for elapsedMs calculation). */
    spawnedAt: number;
    /** Brief summary of what the agent is doing. */
    summary: string;
    /** Queued messages from the parent (M7.1c message_agent). */
    messageQueue: string[];
    /** Pending approval request waiting for parent response. */
    pendingApproval: ApprovalRequest | null;
    /** Final result set on completion. */
    result: AgentResult | null;
    /**
     * Completion promise for await_agent blocking. Always resolves (never rejects)
     * regardless of final status — callers must check agent.status/agent.result
     * after awaiting to determine success/failure/cancellation.
     */
    completionPromise: Promise<void>;
    completionResolve: () => void;
}

/**
 * Tracks spawned agents within a root session.
 * Enforces concurrent, depth, and total limits at spawn time.
 */
export class DelegationTracker {
    private readonly agents = new Map<string, TrackedAgent>();
    private totalSpawned = 0;
    private readonly spawnCounters = new Map<string, number>();

    constructor(private readonly limits: DelegationLimits) {}

    /** Number of currently active (not completed/failed/cancelled) agents. */
    getActiveCount(): number {
        let count = 0;
        for (const agent of this.agents.values()) {
            if (agent.status === 'active') count++;
        }
        return count;
    }

    /** Total number of agents spawned in this session (including completed). */
    getTotalSpawned(): number {
        return this.totalSpawned;
    }

    /** Get the next spawn index for a parent agent (0-based, sequential per parent). */
    getNextSpawnIndex(parentId: string): number {
        const current = this.spawnCounters.get(parentId) ?? 0;
        return current;
    }

    /**
     * Check whether spawning a new agent is allowed given current state.
     * Returns null if allowed, or an error description if not.
     */
    checkLimits(callerDepth: number): { code: string; current: number; allowed: number; reason: string } | null {
        const activeCount = this.getActiveCount();
        if (activeCount >= this.limits.maxConcurrentAgents) {
            return {
                code: 'concurrent',
                current: activeCount,
                allowed: this.limits.maxConcurrentAgents,
                reason: `concurrent agent limit reached (${activeCount}/${this.limits.maxConcurrentAgents})`,
            };
        }

        const childDepth = callerDepth + 1;
        if (childDepth > this.limits.maxDelegationDepth) {
            return {
                code: 'depth',
                current: callerDepth,
                allowed: this.limits.maxDelegationDepth,
                reason: `delegation depth limit reached (caller depth ${callerDepth}, max ${this.limits.maxDelegationDepth})`,
            };
        }

        if (this.totalSpawned >= this.limits.maxTotalAgents) {
            return {
                code: 'total',
                current: this.totalSpawned,
                allowed: this.limits.maxTotalAgents,
                reason: `total agent limit reached (${this.totalSpawned}/${this.limits.maxTotalAgents})`,
            };
        }

        return null;
    }

    /** Register a newly spawned agent. Increments counters. */
    registerAgent(tracked: TrackedAgent): void {
        this.agents.set(tracked.identity.id, tracked);
        this.totalSpawned++;
        const parentId = tracked.identity.parentAgentId ?? tracked.identity.id;
        const current = this.spawnCounters.get(parentId) ?? 0;
        this.spawnCounters.set(parentId, current + 1);
    }

    /**
     * Mark an agent as completed/failed/cancelled. Sets phase to 'done',
     * clears pending approval, and resolves the completion promise.
     * Idempotent: no-op if the agent is already non-active.
     */
    markCompleted(agentId: string, status: 'completed' | 'failed' | 'cancelled', result?: AgentResult): void {
        const agent = this.agents.get(agentId);
        if (!agent || agent.status !== 'active') return;
        agent.status = status;
        agent.phase = 'done';
        agent.activeTool = null;
        agent.pendingApproval = null;
        if (result) {
            agent.result = result;
        }
        agent.completionResolve();
    }

    /** Get a tracked agent by ID. */
    getAgent(agentId: string): TrackedAgent | undefined {
        return this.agents.get(agentId);
    }

    /**
     * Resolve a model shorthand like "$spawn_agent" to the most recently spawned
     * child of the current caller session.
     */
    resolveAgentReference(agentId: string, parentSessionId: string): string | null {
        let latest: TrackedAgent | undefined;
        let labeled: TrackedAgent | undefined;
        for (const candidate of this.agents.values()) {
            if (candidate.parentSessionId !== parentSessionId) continue;
            if (!latest || candidate.spawnedAt > latest.spawnedAt) {
                latest = candidate;
            }
            if (candidate.identity.label === agentId) {
                labeled = candidate;
            }
        }

        if (agentId === '$spawn_agent') {
            return latest?.identity.id ?? null;
        }

        if (labeled) {
            return labeled.identity.id;
        }

        return agentId;
    }

    /** Update an agent's lifecycle phase. No-op if agent is not active (prevents done→active regression). */
    updatePhase(agentId: string, phase: AgentPhase, activeTool?: string | null, summary?: string): void {
        const agent = this.agents.get(agentId);
        if (!agent || agent.status !== 'active') return;
        agent.phase = phase;
        agent.lastEventAt = new Date().toISOString();
        if (activeTool !== undefined) agent.activeTool = activeTool;
        if (summary !== undefined) agent.summary = summary;
    }

    /** Max queued messages per agent to prevent unbounded growth. */
    static readonly MAX_MESSAGE_QUEUE_SIZE = 100;

    /** Enqueue a message from the parent to a child agent. Returns false if agent not found, terminated, or queue full. */
    enqueueMessage(agentId: string, message: string): boolean {
        const agent = this.agents.get(agentId);
        if (!agent) return false;
        if (agent.status !== 'active') return false;
        if (agent.messageQueue.length >= DelegationTracker.MAX_MESSAGE_QUEUE_SIZE) return false;
        agent.messageQueue.push(message);
        return true;
    }

    /** Dequeue the next message for a child agent. Returns undefined if empty. */
    dequeueMessage(agentId: string): string | undefined {
        const agent = this.agents.get(agentId);
        if (!agent) return undefined;
        return agent.messageQueue.shift();
    }

    /** Set a pending approval request from a child agent. */
    setPendingApproval(agentId: string, request: ApprovalRequest): void {
        const agent = this.agents.get(agentId);
        if (agent) {
            agent.pendingApproval = request;
        }
    }

    /** Clear a pending approval request. */
    clearPendingApproval(agentId: string): void {
        const agent = this.agents.get(agentId);
        if (agent) {
            agent.pendingApproval = null;
        }
    }

    /** Build a progress snapshot for a running agent. */
    getProgressSnapshot(agentId: string): ProgressSnapshot | null {
        const agent = this.agents.get(agentId);
        if (!agent || agent.status !== 'active') return null;
        return {
            status: 'active',
            phase: agent.phase,
            activeTool: agent.activeTool,
            lastEventAt: agent.lastEventAt,
            elapsedMs: Date.now() - agent.spawnedAt,
            summary: agent.summary,
        };
    }
}

// --- Pre-auth narrowing validation ---

/**
 * Shallow structural equality for PreauthRule match objects.
 * Compares tool name, decision, and all match fields (commandRegex, cwdPattern).
 * A child pattern is considered narrowing-only if there exists a parent pattern
 * with the same tool+decision and identical or absent match fields.
 *
 * Regex containment is undecidable in the general case, so we require exact
 * match equality — the child can only pass through the parent's exact patterns
 * or omit match fields (which is strictly narrower since it matches nothing).
 */
function matchFieldsEqual(
    parentMatch: Record<string, unknown>,
    childMatch: Record<string, unknown>,
): boolean {
    const parentKeys = Object.keys(parentMatch).sort();
    const childKeys = Object.keys(childMatch).sort();
    if (parentKeys.length !== childKeys.length) return false;
    for (let i = 0; i < parentKeys.length; i++) {
        if (parentKeys[i] !== childKeys[i]) return false;
        if (parentMatch[parentKeys[i]] !== childMatch[childKeys[i]]) return false;
    }
    return true;
}

/**
 * Check if a child preauth rule is covered by any parent rule.
 * Requires: same tool, same decision, and identical match fields.
 */
function isRuleCoveredByParent(
    child: { tool: string; decision: string; match: Record<string, unknown> },
    parentRules: Array<{ tool: string; decision: string; match: Record<string, unknown> }>,
): boolean {
    return parentRules.some(parent =>
        parent.tool === child.tool &&
        parent.decision === child.decision &&
        matchFieldsEqual(
            parent.match as Record<string, unknown>,
            child.match as Record<string, unknown>,
        ),
    );
}

/**
 * Validate that child pre-auth patterns are a subset of the parent's authority.
 * Each child pattern must structurally match a parent preauth rule (same tool,
 * decision, and match fields). Returns rejected patterns the parent doesn't hold.
 */
export function validatePreauthNarrowing(
    parentPreauths: PreauthRule[],
    childPatterns: PreauthRule[],
): PreauthRule[] {
    if (childPatterns.length === 0) return [];
    return childPatterns.filter(cp => !isRuleCoveredByParent(cp, parentPreauths));
}

/**
 * Validate that authority overrides only narrow what the parent holds.
 * Each override rule must structurally match a parent authority rule.
 * Returns rejected rules that widen beyond parent's authority.
 */
export function validateAuthorityNarrowing(
    parentAuthority: AuthorityRule[],
    overrideAuthority: AuthorityRule[],
): AuthorityRule[] {
    if (overrideAuthority.length === 0) return [];
    return overrideAuthority.filter(or => !isRuleCoveredByParent(or, parentAuthority));
}

// --- Spawn result ---

/** Structured result for M7.1c await_agent to return to the parent. */
export interface SpawnResult {
    agentId: AgentId;
    childSessionId: SessionId;
    identity: AgentIdentity;
    tools: readonly string[];
    preAuthorizedPatterns: PreauthRule[];
    profile: AgentProfile;
}

export interface SpawnLaunchPayload extends SpawnResult {
    task: string;
    context: string;
    authority: AuthorityRule[];
    callerSessionId: SessionId;
    rootSessionId: SessionId;
}

// --- Dependencies ---

export interface SpawnAgentDeps {
    agentRegistry: AgentRegistry;
    delegationTracker: DelegationTracker;
    limits: DelegationLimits;
    /** Called to create the child session directory and manifest. */
    createChildSession: (parentSessionId: SessionId, rootSessionId: SessionId) => SessionId;
    /** Optional runtime hook that launches the spawned child agent. */
    onSpawn?: (payload: SpawnLaunchPayload) => void | Promise<void>;
}

/** Caller context injected per-call (varies by which agent is calling). */
export interface SpawnCallerContext {
    callerIdentity: AgentIdentity;
    callerSessionId: SessionId;
    rootSessionId: SessionId;
    callerPreauths: PreauthRule[];
    callerAuthority: AuthorityRule[];
    /** The caller's own active tool set. Child tools are intersected with this
     *  to prevent privilege escalation via profile selection. */
    callerTools: readonly string[];
}

// --- Helper ---

function errorOutput(code: string, message: string, details?: Record<string, unknown>): ToolOutput {
    return {
        status: 'error',
        data: '',
        error: createAcaError(code, message, { details }),
        truncated: false,
        bytesReturned: 0,
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    };
}

function successOutput(data: Record<string, unknown>): ToolOutput {
    const json = JSON.stringify(data);
    return {
        status: 'success',
        data: json,
        truncated: false,
        bytesReturned: Buffer.byteLength(json, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    };
}

// --- Factory ---

/**
 * Create the spawn_agent tool implementation with injected dependencies.
 * The callerContext is per-invocation (different for root vs child agents).
 */
export function createSpawnAgentImpl(
    deps: SpawnAgentDeps,
    callerContext: SpawnCallerContext,
): ToolImplementation {
    return async (
        args: Record<string, unknown>,
        _context: ToolContext,
    ): Promise<ToolOutput> => {
        const agentType = args.agent_type as string;
        const task = args.task as string;
        const contextText = (args.context as string | undefined) ?? '';
        const allowedTools = args.allowed_tools as string[] | undefined;
        const authorityOverride = args.authority as AuthorityRule[] | undefined;
        const label = (args.label as string | undefined) ?? `${agentType}-${Date.now()}`;
        const preAuthPatterns = args.preAuthorizedPatterns as PreauthRule[] | undefined;

        const { agentRegistry, delegationTracker } = deps;
        const { callerIdentity, callerSessionId, rootSessionId, callerPreauths, callerAuthority } = callerContext;

        // 1. Check delegation permission
        const profile = agentRegistry.getProfile(agentType);
        if (!profile) {
            return errorOutput(
                DELEGATION_ERRORS.SPAWN_FAILED,
                `Unknown agent type: ${agentType}. Available: ${agentRegistry.getProfileNames().join(', ')}`,
            );
        }

        // Delegation permission is enforced by tool masking (M7.7c) — spawn_agent
        // is excluded from non-delegating profiles' tool sets.

        // 2. Check limits (no await between check and register — safe in single-threaded Node.js)
        const limitViolation = delegationTracker.checkLimits(callerIdentity.depth);
        if (limitViolation) {
            // Use DEPTH_EXCEEDED for depth violations, SPAWN_FAILED for concurrent/total
            const errorCode = limitViolation.code === 'depth'
                ? DELEGATION_ERRORS.DEPTH_EXCEEDED
                : DELEGATION_ERRORS.SPAWN_FAILED;
            return errorOutput(
                errorCode,
                limitViolation.reason,
                { current: limitViolation.current, allowed: limitViolation.allowed },
            );
        }

        // 3. Resolve tool set: profile defaults ∩ caller overrides ∩ caller's own tools.
        // The caller cannot grant tools it does not hold (privilege escalation prevention).
        const callerToolSet = new Set(callerContext.callerTools);
        let resolvedTools: readonly string[];
        if (allowedTools !== undefined) {
            const narrowing = agentRegistry.validateToolNarrowing(agentType, allowedTools);
            if (!narrowing.valid) {
                return errorOutput(
                    DELEGATION_ERRORS.SPAWN_FAILED,
                    `Tool narrowing rejected: [${narrowing.rejected.join(', ')}] not in ${agentType} profile defaults`,
                    { rejected: narrowing.rejected, profileTools: [...profile.defaultTools] },
                );
            }
            // Intersection: override ∩ profile defaults ∩ caller's tools
            const profileSet = new Set(profile.defaultTools);
            resolvedTools = allowedTools.filter(t => profileSet.has(t) && callerToolSet.has(t));
        } else {
            // No override: profile defaults ∩ caller's tools
            resolvedTools = [...profile.defaultTools].filter(t => callerToolSet.has(t));
        }

        // 4. Validate authority narrowing
        const resolvedAuthority = authorityOverride && authorityOverride.length > 0
            ? authorityOverride
            : callerAuthority;
        if (authorityOverride && authorityOverride.length > 0) {
            const rejected = validateAuthorityNarrowing(callerAuthority, authorityOverride);
            if (rejected.length > 0) {
                return errorOutput(
                    DELEGATION_ERRORS.SPAWN_FAILED,
                    `Authority widening rejected: cannot grant authority parent does not hold`,
                    { rejectedTools: rejected.map(r => r.tool) },
                );
            }
        }

        // 5. Validate pre-auth narrowing
        const resolvedPreauths: PreauthRule[] = [];
        if (preAuthPatterns && preAuthPatterns.length > 0) {
            const rejected = validatePreauthNarrowing(callerPreauths, preAuthPatterns);
            if (rejected.length > 0) {
                return errorOutput(
                    DELEGATION_ERRORS.SPAWN_FAILED,
                    `Pre-auth widening rejected: cannot grant pre-authorization parent does not hold`,
                    { rejectedTools: rejected.map(r => r.tool) },
                );
            }
            resolvedPreauths.push(...preAuthPatterns);
        }

        // 6. Create child identity
        const agentId = generateId('agent') as AgentId;
        const spawnIndex = delegationTracker.getNextSpawnIndex(callerIdentity.id);

        const childIdentity: AgentIdentity = {
            id: agentId,
            parentAgentId: callerIdentity.id,
            rootAgentId: callerIdentity.rootAgentId,
            depth: callerIdentity.depth + 1,
            spawnIndex,
            label,
        };

        // 7. Create child session
        const childSessionId = deps.createChildSession(callerSessionId, rootSessionId);

        // 8. Register with tracker (including lifecycle fields for M7.1c)
        let completionResolve: () => void = () => {};
        const completionPromise = new Promise<void>(resolve => { completionResolve = resolve; });
        delegationTracker.registerAgent({
            identity: childIdentity,
            parentSessionId: callerSessionId,
            childSessionId,
            status: 'active',
            tools: resolvedTools,
            preAuthorizedPatterns: resolvedPreauths,
            authority: resolvedAuthority,
            profileName: profile.name,
            task,
            context: contextText,
            phase: 'booting',
            activeTool: null,
            lastEventAt: new Date().toISOString(),
            spawnedAt: Date.now(),
            summary: `Starting task: ${task.slice(0, 100)}`,
            messageQueue: [],
            pendingApproval: null,
            result: null,
            completionPromise,
            completionResolve,
        });

        const launchPayload: SpawnLaunchPayload = {
            agentId,
            childSessionId,
            identity: childIdentity,
            tools: resolvedTools,
            preAuthorizedPatterns: resolvedPreauths,
            profile,
            task,
            context: contextText,
            authority: resolvedAuthority,
            callerSessionId,
            rootSessionId,
        };
        if (deps.onSpawn) {
            void Promise.resolve(deps.onSpawn(launchPayload)).catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                delegationTracker.markCompleted(agentId, 'failed', {
                    status: 'failed',
                    output: `Failed to launch child agent: ${message}`,
                    tokenUsage: { input: 0, output: 0 },
                    toolCallSummary: [],
                });
            });
        }

        // 9. Return success with agent ID and session ID
        return successOutput({
            agentId,
            childSessionId,
            agentType,
            label,
            depth: childIdentity.depth,
            tools: [...resolvedTools],
            task,
            context: contextText,
        });
    };
}
