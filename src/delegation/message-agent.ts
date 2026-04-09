/**
 * message_agent tool (Block 2, M7.1c).
 *
 * Sends a follow-up message to a running sub-agent.
 * Returns ack/status or an error if the agent is not found or has terminated.
 */

import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from '../tools/tool-registry.js';
import type { DelegationTracker } from './spawn-agent.js';
import { DELEGATION_ERRORS, createAcaError } from '../types/errors.js';

// --- Tool spec ---

export const messageAgentSpec: ToolSpec = {
    name: 'message_agent',
    description:
        'Send a follow-up message to a running sub-agent. ' +
        'Returns ack with agent status, or error if agent not found/terminated.',
    inputSchema: {
        type: 'object',
        properties: {
            agent_id: { type: 'string', minLength: 1 },
            message: { type: 'string', minLength: 1 },
        },
        required: ['agent_id', 'message'],
        additionalProperties: false,
    },
    approvalClass: 'read-only',
    idempotent: false,
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

export interface MessageAgentDeps {
    delegationTracker: DelegationTracker;
}

// --- Factory ---

/**
 * Create the message_agent tool implementation with injected dependencies.
 */
export function createMessageAgentImpl(deps: MessageAgentDeps): ToolImplementation {
    return async (
        args: Record<string, unknown>,
        context: ToolContext,
    ): Promise<ToolOutput> => {
        const requestedAgentId = args.agent_id as string;
        const message = args.message as string;
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

        // Agent already terminated
        if (agent.status !== 'active') {
            return errorOutput(
                DELEGATION_ERRORS.MESSAGE_FAILED,
                `agent terminated: ${agentId} (status: ${agent.status})`,
            );
        }

        if (agent.pendingApproval) {
            agent.pendingApproval.resolve(message);
            deps.delegationTracker.clearPendingApproval(agentId);
            deps.delegationTracker.updatePhase(agentId, 'thinking', null, 'Resuming after parent response');
            return successOutput({
                acknowledged: true,
                agentId,
                status: agent.status,
                phase: agent.phase,
                resolvedPendingApproval: true,
            });
        }

        // Enqueue the message for the child agent
        delegationTracker.enqueueMessage(agentId, message);

        return successOutput({
            acknowledged: true,
            agentId,
            status: agent.status,
            phase: agent.phase,
        });
    };
}
