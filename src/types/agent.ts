/**
 * Agent identity and profile types for the delegation system (Block 2).
 */

import type { AgentId } from './ids.js';

/**
 * Identity metadata for a spawned agent.
 * The root agent (depth 0) has no parent.
 */
export interface AgentIdentity {
    id: AgentId;
    parentAgentId: AgentId | null;
    rootAgentId: AgentId;
    depth: number;
    spawnIndex: number;
    label: string;
}

/**
 * An agent profile defines the capabilities and constraints for an agent type.
 * Profiles are resolved once at session start and frozen for the session.
 */
export interface AgentProfile {
    /** Profile name used as the agent_type enum value. */
    name: string;
    /** Short system prompt overlay injected into the agent's context. */
    systemPrompt: string;
    /** Tool names this profile is permitted to use. */
    defaultTools: readonly string[];
    /** Whether this profile can use spawn_agent to delegate further. */
    canDelegate: boolean;
    /** Optional model override for this agent type. */
    defaultModel?: string;
}

// --- Agent lifecycle (M7.1c) ---

/** Lifecycle phases for a running agent. */
export type AgentPhase = 'booting' | 'thinking' | 'tool' | 'waiting' | 'done';

/** Progress snapshot returned by await_agent when the agent is still running. */
export interface ProgressSnapshot {
    status: 'active';
    phase: AgentPhase;
    activeTool: string | null;
    lastEventAt: string;
    elapsedMs: number;
    summary: string;
}

/** Final result returned by await_agent when the agent has completed. */
export interface AgentResult {
    status: 'completed' | 'failed' | 'cancelled';
    output: string;
    tokenUsage: { input: number; output: number };
    toolCallSummary: Array<{ tool: string; count: number }>;
}

/** Single entry in an approval request's lineage chain. */
export interface LineageEntry {
    agentId: string;
    depth: number;
    label: string;
}

/** Pending approval request from a child agent that cannot prompt the user directly. */
export interface ApprovalRequest {
    type: 'approval_required';
    toolCall: {
        tool: string;
        args: Record<string, unknown>;
        riskTier?: string;
        riskFacets?: string[];
    };
    reason: string;
    /**
     * Lineage chain from the requesting child up through intermediary agents.
     * First entry is the originating child; subsequent entries are added as the
     * request bubbles through parent agents.
     */
    childLineage: LineageEntry[];
    /** Resolve function to deliver the approval answer back to the child. */
    resolve: (answer: string) => void;
}
