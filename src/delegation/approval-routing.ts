/**
 * Sub-Agent Approval Routing (Block 8, M7.2).
 *
 * Routes approval requests from child agents through the agent tree.
 * The algorithm is recursive and uniform across all depths:
 *
 * 1. Check child's pre-authorized patterns → auto-approve if match
 * 2. Check session grants (subtree-scoped) → auto-approve if match
 * 3. No match + caller is root (depth 0) → prompt user
 * 4. No match + caller is non-root → bubble up to parent
 *
 * Session grants from [a] always are tree-wide. Grants from parent
 * satisfaction are subtree-scoped to the requesting child.
 */

import type { ApprovalRequest, AgentIdentity, LineageEntry } from '../types/agent.js';
import type { DelegationTracker } from './spawn-agent.js';
import type { SessionGrantStore, ParentLookup } from '../permissions/session-grants.js';
import { matchPreauthRules } from '../permissions/preauth.js';

// --- Result types ---

export type RoutingAction =
    | { action: 'satisfied'; source: 'preauth' | 'session_grant' }
    | { action: 'prompt_user'; lineageChain: LineageEntry[]; promptText: string }
    | { action: 'bubble'; lineageChain: LineageEntry[] }
    | { action: 'denied'; reason: string };

// --- Dependencies ---

export interface ApprovalRoutingDeps {
    delegationTracker: DelegationTracker;
    sessionGrants: SessionGrantStore;
}

// --- Helpers ---

/** Extract a command string from tool args for grant matching. */
function extractCommandForGrant(tool: string, args: Record<string, unknown>): string | undefined {
    if (tool === 'exec_command' || tool === 'open_session') {
        const cmd = typeof args.command === 'string' ? args.command : undefined;
        return cmd && cmd.length > 0 ? cmd : undefined;
    }
    if (tool === 'session_io') {
        const stdin = typeof args.stdin === 'string' ? args.stdin : undefined;
        return stdin && stdin.length > 0 ? stdin : undefined;
    }
    return undefined;
}

/** Build a parent lookup function from the DelegationTracker. */
export function buildParentLookup(tracker: DelegationTracker): ParentLookup {
    return (agentId: string): string | null => {
        const agent = tracker.getAgent(agentId);
        return agent?.identity.parentAgentId ?? null;
    };
}

/**
 * Format a user-facing approval prompt with the full lineage chain.
 * Shows which sub-agent requested the action and the chain of agents it bubbled through.
 */
export function formatRoutedPrompt(request: ApprovalRequest): string {
    const { toolCall, reason, childLineage } = request;
    const lines: string[] = [];

    lines.push(`⚠ Sub-agent approval required`);
    lines.push(`  Tool: ${toolCall.tool}`);

    const command = extractCommandForGrant(toolCall.tool, toolCall.args);
    if (command) {
        lines.push(`  Command: ${command}`);
    }

    if (toolCall.riskTier && toolCall.riskTier !== 'normal') {
        lines.push(`  Risk: ${toolCall.riskTier}`);
    }
    if (toolCall.riskFacets && toolCall.riskFacets.length > 0) {
        lines.push(`  Facets: ${toolCall.riskFacets.join(', ')}`);
    }

    lines.push(`  Reason: ${reason}`);
    lines.push('');

    // Show lineage chain (most recent first for readability)
    lines.push('  Lineage:');
    for (let i = 0; i < childLineage.length; i++) {
        const entry = childLineage[i];
        const indent = '    ' + '  '.repeat(i);
        const prefix = i === 0 ? '→ ' : '↳ ';
        lines.push(`${indent}${prefix}${entry.label} (depth ${entry.depth}, ${entry.agentId})`);
    }

    lines.push('');
    lines.push('  [y] approve    [n] deny    [a] always (all agents, this session)');
    return lines.join('\n');
}

// --- Main routing function ---

/**
 * Route an approval request from a child agent.
 *
 * @param request - The approval request from the child (surfaced via await_agent)
 * @param callerIdentity - The identity of the agent handling this request
 * @param childAgentId - The ID of the child that originally set the pendingApproval
 * @param deps - Injected dependencies
 * @returns The routing action to take
 */
export function routeApproval(
    request: ApprovalRequest,
    callerIdentity: AgentIdentity,
    childAgentId: string,
    deps: ApprovalRoutingDeps,
): RoutingAction {
    const { delegationTracker, sessionGrants } = deps;
    const { toolCall } = request;
    const command = extractCommandForGrant(toolCall.tool, toolCall.args);

    // 1. Check child's pre-authorized patterns
    const child = delegationTracker.getAgent(childAgentId);
    if (child && child.preAuthorizedPatterns.length > 0) {
        const match = matchPreauthRules(child.preAuthorizedPatterns, {
            toolName: toolCall.tool,
            command,
        });
        if (match) {
            if (match.decision === 'allow') {
                return { action: 'satisfied', source: 'preauth' };
            }
            if (match.decision === 'deny') {
                return { action: 'denied', reason: `denied by preauth rule: ${match.id}` };
            }
        }
    }

    // 2. Check session grants (subtree-aware)
    const parentLookup = buildParentLookup(delegationTracker);
    if (sessionGrants.hasGrantForAgent(toolCall.tool, command, childAgentId, parentLookup)) {
        return { action: 'satisfied', source: 'session_grant' };
    }

    // 3. No pre-auth or grant — decide based on caller depth
    if (callerIdentity.depth === 0) {
        // Root agent: prompt user
        const promptText = formatRoutedPrompt(request);
        return {
            action: 'prompt_user',
            lineageChain: request.childLineage,
            promptText,
        };
    }

    // 4. Non-root: bubble up by appending caller's lineage
    const extendedLineage: LineageEntry[] = [
        ...request.childLineage,
        {
            agentId: callerIdentity.id,
            depth: callerIdentity.depth,
            label: callerIdentity.label,
        },
    ];
    return { action: 'bubble', lineageChain: extendedLineage };
}

/** Track already-resolved requests to prevent double resolution. */
const resolvedRequests = new WeakSet<ApprovalRequest>();

/**
 * Resolve a routed approval: call the request's resolve callback,
 * clear the pending approval, and optionally create a session grant.
 *
 * Idempotent: calling twice on the same request is a no-op on the second call.
 *
 * @param request - The original ApprovalRequest
 * @param childAgentId - The child agent that originated the request
 * @param answer - 'approved' | 'denied' | 'always'
 * @param deps - Injected dependencies
 * @returns true if resolved, false if already resolved (duplicate call)
 */
export function resolveRoutedApproval(
    request: ApprovalRequest,
    childAgentId: string,
    answer: 'approved' | 'denied' | 'always',
    deps: ApprovalRoutingDeps,
): boolean {
    if (resolvedRequests.has(request)) return false;
    resolvedRequests.add(request);

    const { delegationTracker, sessionGrants } = deps;
    const { toolCall } = request;
    const command = extractCommandForGrant(toolCall.tool, toolCall.args);

    if (answer === 'approved') {
        // Subtree-scoped grant: only the requesting child and its descendants
        sessionGrants.addSubtreeGrant(toolCall.tool, command, childAgentId);
        request.resolve('approved');
    } else if (answer === 'always') {
        // Tree-wide grant: all agents in the session
        sessionGrants.addGrant(toolCall.tool, command);
        request.resolve('approved');
    } else {
        request.resolve('denied');
    }

    delegationTracker.clearPendingApproval(childAgentId);
    return true;
}
