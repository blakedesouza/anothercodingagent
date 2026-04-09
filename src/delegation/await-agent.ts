/**
 * await_agent tool (Block 2, M7.1c).
 *
 * Waits for a sub-agent to complete or returns a progress snapshot.
 * timeout=0 polls without blocking; timeout>0 blocks up to N ms.
 */

import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from '../tools/tool-registry.js';
import type { DelegationTracker } from './spawn-agent.js';
import { DELEGATION_ERRORS, createAcaError } from '../types/errors.js';

// --- Tool spec ---

export const awaitAgentSpec: ToolSpec = {
    name: 'await_agent',
    description:
        'Wait for a sub-agent to complete or get a progress snapshot. ' +
        'timeout=0 polls (returns immediately), timeout>0 blocks up to N ms.',
    inputSchema: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', minLength: 1 },
            timeout: {
                oneOf: [
                    { type: 'number', minimum: 0 },
                    { type: 'string', pattern: '^[0-9]+$' },
                ],
            },
        },
        required: ['agent_id'],
        additionalProperties: false,
    },
    approvalClass: 'read-only',
    idempotent: true,
    timeoutCategory: 'delegation',
};

// --- Helpers ---

function errorOutput(code: string, message: string): ToolOutput {
    return {
        status: 'error',
        data: '',
        error: createAcaError(code, message),
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

// --- Dependencies ---

export interface AwaitAgentDeps {
    delegationTracker: DelegationTracker;
}

// --- Factory ---

/**
 * Create the await_agent tool implementation with injected dependencies.
 */
export function createAwaitAgentImpl(deps: AwaitAgentDeps): ToolImplementation {
    return async (
        args: Record<string, unknown>,
        context: ToolContext,
    ): Promise<ToolOutput> => {
        const requestedAgentId = args.agent_id as string;
        const rawTimeout = args.timeout;
        const timeout = typeof rawTimeout === 'string'
            ? Number.parseInt(rawTimeout, 10)
            : (rawTimeout as number | undefined) ?? 0;
        const { delegationTracker } = deps;
        const agentId = delegationTracker.resolveAgentReference(requestedAgentId, context.sessionId);

        if (!agentId) {
            return errorOutput(
                DELEGATION_ERRORS.MESSAGE_FAILED,
                `agent not found: ${requestedAgentId}`,
            );
        }

        const agent = delegationTracker.getAgent(agentId);

        // Agent not found
        if (!agent) {
            return errorOutput(
                DELEGATION_ERRORS.MESSAGE_FAILED,
                `agent not found: ${agentId}`,
            );
        }

        // Agent already completed — return final result
        if (agent.status !== 'active') {
            if (agent.result) {
                return successOutput({
                    ...agent.result,
                    agentId,
                });
            }
            // Completed but no structured result (shouldn't happen, but be safe)
            return successOutput({
                status: agent.status,
                agentId,
                output: '',
                tokenUsage: { input: 0, output: 0 },
                toolCallSummary: [],
            });
        }

        // Check for pending approval request
        if (agent.pendingApproval) {
            const approval = agent.pendingApproval;
            return successOutput({
                status: 'active',
                agentId,
                approval_required: {
                    type: approval.type,
                    toolCall: approval.toolCall,
                    reason: approval.reason,
                    childLineage: approval.childLineage,
                },
                phase: agent.phase,
                elapsedMs: Date.now() - agent.spawnedAt,
            });
        }

        // Poll mode (timeout=0) — return progress snapshot immediately
        if (timeout === 0) {
            const snapshot = delegationTracker.getProgressSnapshot(agentId);
            if (snapshot) {
                return successOutput({ ...snapshot, agentId });
            }
            // Fallback (should not happen for active agent)
            return successOutput({ status: agent.status, agentId, phase: agent.phase });
        }

        // Blocking mode — wait up to timeout ms for completion
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
            agent.completionPromise.then(() => 'completed' as const),
            new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeout); }),
        ]);
        if (timer !== undefined) clearTimeout(timer);

        if (result === 'completed') {
            // Re-fetch agent state after completion
            const completedAgent = delegationTracker.getAgent(agentId);
            if (completedAgent?.result) {
                return successOutput({
                    ...completedAgent.result,
                    agentId,
                });
            }
            return successOutput({
                status: completedAgent?.status ?? 'completed',
                agentId,
                output: '',
                tokenUsage: { input: 0, output: 0 },
                toolCallSummary: [],
            });
        }

        // Timed out — return progress snapshot
        // Re-check for pending approval that arrived during wait
        const freshAgent = delegationTracker.getAgent(agentId);
        if (freshAgent?.pendingApproval) {
            const approval = freshAgent.pendingApproval;
            return successOutput({
                status: 'active',
                agentId,
                approval_required: {
                    type: approval.type,
                    toolCall: approval.toolCall,
                    reason: approval.reason,
                    childLineage: approval.childLineage,
                },
                phase: freshAgent.phase,
                elapsedMs: Date.now() - freshAgent.spawnedAt,
            });
        }

        const snapshot = delegationTracker.getProgressSnapshot(agentId);
        if (snapshot) {
            return successOutput({ ...snapshot, agentId });
        }
        return successOutput({ status: 'active', agentId, phase: agent.phase });
    };
}
