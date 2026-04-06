/**
 * Tests for M7.1c: await_agent tool + lifecycle phases
 *
 * Covers:
 * - Await with timeout=0 → returns progress snapshot (status, phase, elapsed)
 * - Await with timeout=5000 → blocks up to 5s, returns result or snapshot
 * - Child completes → await returns final result with token usage
 * - Child uses ask_user → returns approval_required to parent. Question text preserved
 * - ask_user routing end-to-end: child asks → parent receives → parent answers → child receives
 * - Lifecycle phases transition correctly: booting → thinking → tool → thinking → done
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { awaitAgentSpec, createAwaitAgentImpl } from '../../src/delegation/await-agent.js';
import type { AwaitAgentDeps } from '../../src/delegation/await-agent.js';
import {
    DelegationTracker,
    DEFAULT_DELEGATION_LIMITS,
    createSpawnAgentImpl,
} from '../../src/delegation/spawn-agent.js';
import type { SpawnAgentDeps, SpawnCallerContext } from '../../src/delegation/spawn-agent.js';
import { AgentRegistry } from '../../src/delegation/agent-registry.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolSpec, ToolImplementation, ToolContext } from '../../src/tools/tool-registry.js';
import type { AgentIdentity, AgentResult, ApprovalRequest } from '../../src/types/agent.js';
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

describe('await_agent', () => {
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
            expect(awaitAgentSpec.name).toBe('await_agent');
            expect(awaitAgentSpec.approvalClass).toBe('read-only');
            expect(awaitAgentSpec.idempotent).toBe(true);
            const required = awaitAgentSpec.inputSchema.required as string[];
            expect(required).toContain('agent_id');
        });
    });

    describe('polling mode (timeout=0)', () => {
        it('await with timeout=0 → returns progress snapshot (status, phase, elapsed)', async () => {
            const agentId = await spawnTestAgent(tracker, agentRegistry);
            const deps: AwaitAgentDeps = { delegationTracker: tracker };
            const impl = createAwaitAgentImpl(deps);

            const result = await impl(
                { agent_id: agentId, timeout: 0 },
                stubToolContext,
            );

            expect(result.status).toBe('success');
            const data = parseOutput(result);
            expect(data.status).toBe('active');
            expect(data.phase).toBe('booting');
            expect(data.agentId).toBe(agentId);
            expect(typeof data.elapsedMs).toBe('number');
            expect(typeof data.lastEventAt).toBe('string');
            expect(typeof data.summary).toBe('string');
        });

        it('default timeout is 0 (poll) when omitted', async () => {
            const agentId = await spawnTestAgent(tracker, agentRegistry);
            const deps: AwaitAgentDeps = { delegationTracker: tracker };
            const impl = createAwaitAgentImpl(deps);

            const result = await impl(
                { agent_id: agentId },
                stubToolContext,
            );

            expect(result.status).toBe('success');
            const data = parseOutput(result);
            expect(data.status).toBe('active');
        });
    });

    describe('blocking mode', () => {
        it('await with timeout → blocks then returns snapshot if not completed', async () => {
            const agentId = await spawnTestAgent(tracker, agentRegistry);
            const deps: AwaitAgentDeps = { delegationTracker: tracker };
            const impl = createAwaitAgentImpl(deps);

            // Short timeout so test doesn't hang
            const start = Date.now();
            const result = await impl(
                { agent_id: agentId, timeout: 50 },
                stubToolContext,
            );
            const elapsed = Date.now() - start;

            expect(result.status).toBe('success');
            const data = parseOutput(result);
            expect(data.status).toBe('active');
            // Should have waited at least ~50ms (allow some margin)
            expect(elapsed).toBeGreaterThanOrEqual(30);
        });

        it('await with timeout → returns result immediately if agent completes during wait', async () => {
            const agentId = await spawnTestAgent(tracker, agentRegistry);
            const deps: AwaitAgentDeps = { delegationTracker: tracker };
            const impl = createAwaitAgentImpl(deps);

            // Complete the agent after 20ms
            const agentResult: AgentResult = {
                status: 'completed',
                output: 'Task done successfully',
                tokenUsage: { input: 150, output: 80 },
                toolCallSummary: [{ tool: 'read_file', count: 3 }],
            };
            setTimeout(() => {
                tracker.markCompleted(agentId, 'completed', agentResult);
            }, 20);

            const start = Date.now();
            const result = await impl(
                { agent_id: agentId, timeout: 5000 },
                stubToolContext,
            );
            const elapsed = Date.now() - start;

            expect(result.status).toBe('success');
            const data = parseOutput(result);
            expect(data.status).toBe('completed');
            expect(data.output).toBe('Task done successfully');
            expect(data.agentId).toBe(agentId);
            // Should have returned well before the 5s timeout
            expect(elapsed).toBeLessThan(1000);
        });
    });

    describe('final result', () => {
        it('child completes → await returns final result with token usage', async () => {
            const agentId = await spawnTestAgent(tracker, agentRegistry);

            const agentResult: AgentResult = {
                status: 'completed',
                output: 'Analysis complete: 3 issues found',
                tokenUsage: { input: 500, output: 200 },
                toolCallSummary: [
                    { tool: 'read_file', count: 5 },
                    { tool: 'search_text', count: 2 },
                ],
            };
            tracker.markCompleted(agentId, 'completed', agentResult);

            const deps: AwaitAgentDeps = { delegationTracker: tracker };
            const impl = createAwaitAgentImpl(deps);

            const result = await impl(
                { agent_id: agentId, timeout: 0 },
                stubToolContext,
            );

            expect(result.status).toBe('success');
            const data = parseOutput(result);
            expect(data.status).toBe('completed');
            expect(data.output).toBe('Analysis complete: 3 issues found');
            expect(data.agentId).toBe(agentId);
            const usage = data.tokenUsage as Record<string, number>;
            expect(usage.input).toBe(500);
            expect(usage.output).toBe(200);
            const summary = data.toolCallSummary as Array<{ tool: string; count: number }>;
            expect(summary).toHaveLength(2);
            expect(summary[0]).toEqual({ tool: 'read_file', count: 5 });
        });

        it('failed agent → returns failed status', async () => {
            const agentId = await spawnTestAgent(tracker, agentRegistry);

            const agentResult: AgentResult = {
                status: 'failed',
                output: 'Error: context length exceeded',
                tokenUsage: { input: 100, output: 10 },
                toolCallSummary: [],
            };
            tracker.markCompleted(agentId, 'failed', agentResult);

            const deps: AwaitAgentDeps = { delegationTracker: tracker };
            const impl = createAwaitAgentImpl(deps);

            const result = await impl({ agent_id: agentId }, stubToolContext);

            expect(result.status).toBe('success');
            const data = parseOutput(result);
            expect(data.status).toBe('failed');
            expect(data.output).toBe('Error: context length exceeded');
        });
    });

    describe('approval routing', () => {
        it('child uses ask_user → returns approval_required to parent with question text', async () => {
            const agentId = await spawnTestAgent(tracker, agentRegistry);

            // Simulate child setting a pending approval request
            const approvalRequest: ApprovalRequest = {
                type: 'approval_required',
                toolCall: { tool: 'ask_user', args: { question: 'Which DB?' } },
                reason: 'Sub-agent cannot prompt user directly',
                childLineage: [{
                    agentId,
                    depth: 1,
                    label: 'general-test',
                }],
                resolve: () => {},
            };
            tracker.setPendingApproval(agentId, approvalRequest);

            const deps: AwaitAgentDeps = { delegationTracker: tracker };
            const impl = createAwaitAgentImpl(deps);

            const result = await impl(
                { agent_id: agentId, timeout: 0 },
                stubToolContext,
            );

            expect(result.status).toBe('success');
            const data = parseOutput(result);
            expect(data.status).toBe('active');
            const approval = data.approval_required as Record<string, unknown>;
            expect(approval).toBeDefined();
            expect(approval.type).toBe('approval_required');
            const toolCall = approval.toolCall as Record<string, unknown>;
            expect(toolCall.tool).toBe('ask_user');
            const args = toolCall.args as Record<string, unknown>;
            expect(args.question).toBe('Which DB?');
            const lineage = approval.childLineage as Array<Record<string, unknown>>;
            expect(lineage).toHaveLength(1);
            expect(lineage[0].agentId).toBe(agentId);
            expect(lineage[0].depth).toBe(1);
        });

        it('ask_user routing end-to-end: child asks → parent receives → parent answers → child receives', async () => {
            const agentId = await spawnTestAgent(tracker, agentRegistry);

            // Set up the approval request with a real resolve function
            let childReceivedAnswer: string | undefined;
            const approvalRequest: ApprovalRequest = {
                type: 'approval_required',
                toolCall: { tool: 'ask_user', args: { question: 'Which DB?' } },
                reason: 'Sub-agent cannot prompt user directly',
                childLineage: [{ agentId, depth: 1, label: 'general-test' }],
                resolve: (answer: string) => { childReceivedAnswer = answer; },
            };
            tracker.setPendingApproval(agentId, approvalRequest);

            // Parent polls and sees the approval request
            const deps: AwaitAgentDeps = { delegationTracker: tracker };
            const impl = createAwaitAgentImpl(deps);
            const pollResult = await impl({ agent_id: agentId, timeout: 0 }, stubToolContext);
            const pollData = parseOutput(pollResult);
            expect((pollData.approval_required as Record<string, unknown>)).toBeDefined();

            // Parent retrieves the pending approval and resolves it
            const agent = tracker.getAgent(agentId)!;
            expect(agent.pendingApproval).not.toBeNull();
            agent.pendingApproval!.resolve('PostgreSQL');
            tracker.clearPendingApproval(agentId);

            // Verify child received the answer
            expect(childReceivedAnswer).toBe('PostgreSQL');

            // Next poll shows no pending approval
            const nextResult = await impl({ agent_id: agentId, timeout: 0 }, stubToolContext);
            const nextData = parseOutput(nextResult);
            expect(nextData.approval_required).toBeUndefined();
            expect(nextData.status).toBe('active');
        });
    });

    describe('lifecycle phases', () => {
        it('lifecycle phases transition correctly: booting → thinking → tool → thinking → done', async () => {
            const agentId = await spawnTestAgent(tracker, agentRegistry);
            const deps: AwaitAgentDeps = { delegationTracker: tracker };
            const impl = createAwaitAgentImpl(deps);

            // Initial phase is booting
            let result = await impl({ agent_id: agentId, timeout: 0 }, stubToolContext);
            let data = parseOutput(result);
            expect(data.phase).toBe('booting');

            // Transition to thinking
            tracker.updatePhase(agentId, 'thinking', null, 'Processing task');
            result = await impl({ agent_id: agentId, timeout: 0 }, stubToolContext);
            data = parseOutput(result);
            expect(data.phase).toBe('thinking');
            expect(data.activeTool).toBeNull();

            // Transition to tool
            tracker.updatePhase(agentId, 'tool', 'read_file', 'Reading src/index.ts');
            result = await impl({ agent_id: agentId, timeout: 0 }, stubToolContext);
            data = parseOutput(result);
            expect(data.phase).toBe('tool');
            expect(data.activeTool).toBe('read_file');
            expect(data.summary).toBe('Reading src/index.ts');

            // Back to thinking
            tracker.updatePhase(agentId, 'thinking', null, 'Analyzing results');
            result = await impl({ agent_id: agentId, timeout: 0 }, stubToolContext);
            data = parseOutput(result);
            expect(data.phase).toBe('thinking');

            // Complete
            const agentResult: AgentResult = {
                status: 'completed',
                output: 'Done',
                tokenUsage: { input: 100, output: 50 },
                toolCallSummary: [{ tool: 'read_file', count: 1 }],
            };
            tracker.markCompleted(agentId, 'completed', agentResult);

            result = await impl({ agent_id: agentId, timeout: 0 }, stubToolContext);
            data = parseOutput(result);
            expect(data.status).toBe('completed');
        });
    });

    describe('error cases', () => {
        it('await nonexistent agent → delegation.message_failed', async () => {
            const deps: AwaitAgentDeps = { delegationTracker: tracker };
            const impl = createAwaitAgentImpl(deps);

            const result = await impl(
                { agent_id: 'agt_nonexistent_00000000000000' },
                stubToolContext,
            );

            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('delegation.message_failed');
            expect(result.error!.message).toContain('agent not found');
        });
    });
});
