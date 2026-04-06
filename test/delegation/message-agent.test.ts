/**
 * Tests for M7.1c: message_agent tool
 *
 * Covers:
 * - Message agent → child receives and processes
 * - message_agent with invalid/nonexistent agent ID → delegation.message_failed "agent not found"
 * - message_agent to completed/closed child → delegation.message_failed "agent terminated"
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { messageAgentSpec, createMessageAgentImpl } from '../../src/delegation/message-agent.js';
import type { MessageAgentDeps } from '../../src/delegation/message-agent.js';
import {
    DelegationTracker,
    DEFAULT_DELEGATION_LIMITS,
    createSpawnAgentImpl,
} from '../../src/delegation/spawn-agent.js';
import type { SpawnAgentDeps, SpawnCallerContext } from '../../src/delegation/spawn-agent.js';
import { AgentRegistry } from '../../src/delegation/agent-registry.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolSpec, ToolImplementation, ToolContext } from '../../src/tools/tool-registry.js';
import type { AgentIdentity } from '../../src/types/agent.js';
import type { AgentId, SessionId } from '../../src/types/ids.js';

// --- Test helpers ---

const noopImpl: ToolImplementation = async () => ({
    status: 'success' as const,
    data: '',
    truncated: false,
    bytesReturned: 0,
    bytesOmitted: 0,
    retryable: false,
    timedOut: false,
    mutationState: 'none' as const,
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

function buildTestToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(makeToolSpec('read_file', 'read-only'), noopImpl);
    registry.register(makeToolSpec('find_paths', 'read-only'), noopImpl);
    registry.register(makeToolSpec('search_text', 'read-only'), noopImpl);
    registry.register(makeToolSpec('stat_path', 'read-only'), noopImpl);
    registry.register(makeToolSpec('write_file', 'workspace-write'), noopImpl);
    registry.register(makeToolSpec('edit_file', 'workspace-write'), noopImpl);
    registry.register(makeToolSpec('exec_command', 'external-effect'), noopImpl);
    return registry;
}

const ROOT_AGENT_ID = 'agt_00000000000000000000000001' as AgentId;
const ROOT_SESSION_ID = 'ses_00000000000000000000000001' as SessionId;

function makeRootIdentity(): AgentIdentity {
    return {
        id: ROOT_AGENT_ID,
        parentAgentId: null,
        rootAgentId: ROOT_AGENT_ID,
        depth: 0,
        spawnIndex: 0,
        label: 'root',
    };
}

let childSessionCounter = 0;
function createMockChildSession(_parentSessionId: SessionId, _rootSessionId: SessionId): SessionId {
    childSessionCounter++;
    return `ses_child_${String(childSessionCounter).padStart(26, '0')}` as SessionId;
}

function makeCallerContext(): SpawnCallerContext {
    return {
        callerIdentity: makeRootIdentity(),
        callerSessionId: ROOT_SESSION_ID,
        rootSessionId: ROOT_SESSION_ID,
        callerPreauths: [],
        callerAuthority: [],
        callerTools: ['read_file', 'write_file', 'edit_file', 'find_paths', 'search_text', 'exec_command', 'spawn_agent'],
    };
}

const stubToolContext: ToolContext = {
    sessionId: ROOT_SESSION_ID,
    workspaceRoot: '/tmp/test-workspace',
    signal: AbortSignal.abort(),
};

function parseOutput(output: { status: string; data: string }): Record<string, unknown> {
    return JSON.parse(output.data) as Record<string, unknown>;
}

/** Spawn a test agent and return its agentId. */
async function spawnTestAgent(
    tracker: DelegationTracker,
    agentRegistry: AgentRegistry,
): Promise<string> {
    const deps: SpawnAgentDeps = {
        agentRegistry,
        delegationTracker: tracker,
        limits: DEFAULT_DELEGATION_LIMITS,
        createChildSession: createMockChildSession,
    };
    const impl = createSpawnAgentImpl(deps, makeCallerContext());
    const result = await impl({ agent_type: 'general', task: 'test task' }, stubToolContext);
    const data = parseOutput(result);
    return data.agentId as string;
}

// --- Tests ---

describe('message_agent', () => {
    let tracker: DelegationTracker;
    let agentRegistry: AgentRegistry;

    beforeEach(() => {
        childSessionCounter = 0;
        tracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
        const toolReg = buildTestToolRegistry();
        const { registry } = AgentRegistry.resolve(toolReg);
        agentRegistry = registry;
    });

    describe('tool spec', () => {
        it('has correct name and properties', () => {
            expect(messageAgentSpec.name).toBe('message_agent');
            expect(messageAgentSpec.approvalClass).toBe('read-only');
            expect(messageAgentSpec.timeoutCategory).toBe('delegation');
            const required = messageAgentSpec.inputSchema.required as string[];
            expect(required).toContain('agent_id');
            expect(required).toContain('message');
        });
    });

    describe('successful messaging', () => {
        it('message agent → child receives and processes', async () => {
            const agentId = await spawnTestAgent(tracker, agentRegistry);
            const deps: MessageAgentDeps = { delegationTracker: tracker };
            const impl = createMessageAgentImpl(deps);

            const result = await impl(
                { agent_id: agentId, message: 'Please focus on function X' },
                stubToolContext,
            );

            expect(result.status).toBe('success');
            const data = parseOutput(result);
            expect(data.acknowledged).toBe(true);
            expect(data.agentId).toBe(agentId);
            expect(data.status).toBe('active');

            // Verify message was enqueued
            const dequeued = tracker.dequeueMessage(agentId);
            expect(dequeued).toBe('Please focus on function X');
        });

        it('multiple messages are queued in order', async () => {
            const agentId = await spawnTestAgent(tracker, agentRegistry);
            const deps: MessageAgentDeps = { delegationTracker: tracker };
            const impl = createMessageAgentImpl(deps);

            await impl({ agent_id: agentId, message: 'first' }, stubToolContext);
            await impl({ agent_id: agentId, message: 'second' }, stubToolContext);
            await impl({ agent_id: agentId, message: 'third' }, stubToolContext);

            expect(tracker.dequeueMessage(agentId)).toBe('first');
            expect(tracker.dequeueMessage(agentId)).toBe('second');
            expect(tracker.dequeueMessage(agentId)).toBe('third');
            expect(tracker.dequeueMessage(agentId)).toBeUndefined();
        });
    });

    describe('error cases', () => {
        it('message_agent with invalid/nonexistent agent ID → delegation.message_failed "agent not found"', async () => {
            const deps: MessageAgentDeps = { delegationTracker: tracker };
            const impl = createMessageAgentImpl(deps);

            const result = await impl(
                { agent_id: 'agt_nonexistent_00000000000000', message: 'hello' },
                stubToolContext,
            );

            expect(result.status).toBe('error');
            expect(result.error).toBeDefined();
            expect(result.error!.code).toBe('delegation.message_failed');
            expect(result.error!.message).toContain('agent not found');
        });

        it('message_agent to completed/closed child → delegation.message_failed "agent terminated"', async () => {
            const agentId = await spawnTestAgent(tracker, agentRegistry);

            // Mark agent as completed
            tracker.markCompleted(agentId, 'completed');

            const deps: MessageAgentDeps = { delegationTracker: tracker };
            const impl = createMessageAgentImpl(deps);

            const result = await impl(
                { agent_id: agentId, message: 'hello' },
                stubToolContext,
            );

            expect(result.status).toBe('error');
            expect(result.error).toBeDefined();
            expect(result.error!.code).toBe('delegation.message_failed');
            expect(result.error!.message).toContain('agent terminated');
        });

        it('message_agent to failed child → delegation.message_failed "agent terminated"', async () => {
            const agentId = await spawnTestAgent(tracker, agentRegistry);
            tracker.markCompleted(agentId, 'failed');

            const deps: MessageAgentDeps = { delegationTracker: tracker };
            const impl = createMessageAgentImpl(deps);

            const result = await impl(
                { agent_id: agentId, message: 'hello' },
                stubToolContext,
            );

            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('delegation.message_failed');
            expect(result.error!.message).toContain('agent terminated');
        });
    });
});
