/**
 * Tests for M7.2: Sub-Agent Approval Routing
 *
 * Covers:
 * - Child needs approval, parent has authority → auto-satisfied, no user prompt
 * - Child needs approval, parent lacks authority, parent is root → user prompted with child lineage
 * - Child needs approval, parent is depth 1, grandparent is root → bubbles twice, root prompts
 * - Session grant from root → child can reuse for matching actions
 * - Pre-authorized pattern at spawn → child auto-approves matching actions
 * - Subtree-scoped grant: grant given to child A → sibling child B cannot use it
 * - Whole-tree grant via [a] always: grant applies to entire agent tree
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    routeApproval,
    resolveRoutedApproval,
    formatRoutedPrompt,
    buildParentLookup,
} from '../../src/delegation/approval-routing.js';
import type { ApprovalRoutingDeps } from '../../src/delegation/approval-routing.js';
import {
    DelegationTracker,
    createSpawnAgentImpl,
} from '../../src/delegation/spawn-agent.js';
import type { SpawnAgentDeps, SpawnCallerContext } from '../../src/delegation/spawn-agent.js';
import { AgentRegistry } from '../../src/delegation/agent-registry.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolSpec, ToolImplementation, ToolContext } from '../../src/tools/tool-registry.js';
import { SessionGrantStore, isInSubtree } from '../../src/permissions/session-grants.js';
import type { ApprovalRequest, AgentIdentity } from '../../src/types/agent.js';
import type { AgentId, SessionId } from '../../src/types/ids.js';
import type { PreauthRule } from '../../src/config/schema.js';

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
    registry.register(makeToolSpec('write_file', 'workspace-write'), noopImpl);
    registry.register(makeToolSpec('exec_command', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('find_paths', 'read-only'), noopImpl);
    registry.register(makeToolSpec('search_text', 'read-only'), noopImpl);
    registry.register(makeToolSpec('stat_path', 'read-only'), noopImpl);
    registry.register(makeToolSpec('edit_file', 'workspace-write'), noopImpl);
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
function createMockChildSession(_p: SessionId, _r: SessionId): SessionId {
    childSessionCounter++;
    return `ses_child_${String(childSessionCounter).padStart(26, '0')}` as SessionId;
}

const stubToolContext: ToolContext = {
    sessionId: ROOT_SESSION_ID,
    workspaceRoot: '/tmp/test-workspace',
    signal: AbortSignal.abort(),
};

function parseOutput(output: { status: string; data: string }): Record<string, unknown> {
    return JSON.parse(output.data) as Record<string, unknown>;
}

/** Spawn a child agent from the root and return its agentId. */
async function spawnChild(
    tracker: DelegationTracker,
    agentRegistry: AgentRegistry,
    opts?: {
        callerIdentity?: AgentIdentity;
        callerSessionId?: SessionId;
        preauths?: PreauthRule[];
        callerPreauths?: PreauthRule[];
    },
): Promise<string> {
    const callerIdentity = opts?.callerIdentity ?? makeRootIdentity();
    const callerContext: SpawnCallerContext = {
        callerIdentity,
        callerSessionId: opts?.callerSessionId ?? ROOT_SESSION_ID,
        rootSessionId: ROOT_SESSION_ID,
        callerPreauths: opts?.callerPreauths ?? opts?.preauths ?? [],
        callerAuthority: [],
        callerTools: ['read_file', 'write_file', 'edit_file', 'find_paths', 'search_text', 'exec_command', 'spawn_agent'],
    };
    const deps: SpawnAgentDeps = {
        agentRegistry,
        delegationTracker: tracker,
        limits: { maxConcurrentAgents: 10, maxDelegationDepth: 3, maxTotalAgents: 50 },
        createChildSession: createMockChildSession,
    };
    const args: Record<string, unknown> = { agent_type: 'general', task: 'test task' };
    if (opts?.preauths && opts.preauths.length > 0) {
        args.preAuthorizedPatterns = opts.preauths;
    }
    const impl = createSpawnAgentImpl(deps, callerContext);
    const result = await impl(args, stubToolContext);
    return (parseOutput(result)).agentId as string;
}

function makeApprovalRequest(
    childAgentId: string,
    tool: string,
    args: Record<string, unknown>,
    resolveFn?: (answer: string) => void,
): ApprovalRequest {
    return {
        type: 'approval_required',
        toolCall: { tool, args },
        reason: `${tool} requires confirmation`,
        childLineage: [{
            agentId: childAgentId,
            depth: 1,
            label: 'test-child',
        }],
        resolve: resolveFn ?? (() => {}),
    };
}

// --- Tests ---

describe('approval-routing', () => {
    let tracker: DelegationTracker;
    let agentRegistry: AgentRegistry;
    let sessionGrants: SessionGrantStore;

    beforeEach(() => {
        childSessionCounter = 0;
        tracker = new DelegationTracker(
            { maxConcurrentAgents: 10, maxDelegationDepth: 3, maxTotalAgents: 50 },
        );
        const toolReg = buildTestToolRegistry();
        const { registry } = AgentRegistry.resolve(toolReg);
        agentRegistry = registry;
        sessionGrants = new SessionGrantStore();
    });

    describe('pre-authorized patterns', () => {
        it('pre-authorized pattern at spawn → child auto-approves matching actions', async () => {
            const preauthRule: PreauthRule = {
                id: 'preauth-npm-test',
                tool: 'exec_command',
                match: { commandRegex: '^npm test$' },
                decision: 'allow',
                scope: 'session',
            };

            const childId = await spawnChild(tracker, agentRegistry, {
                preauths: [preauthRule],
                callerPreauths: [preauthRule],
            });

            const request = makeApprovalRequest(childId, 'exec_command', { command: 'npm test' });
            const deps: ApprovalRoutingDeps = { delegationTracker: tracker, sessionGrants };
            const result = routeApproval(request, makeRootIdentity(), childId, deps);

            expect(result.action).toBe('satisfied');
            if (result.action === 'satisfied') {
                expect(result.source).toBe('preauth');
            }
        });

        it('non-matching preauth pattern → not auto-approved', async () => {
            const preauthRule: PreauthRule = {
                id: 'preauth-npm-test',
                tool: 'exec_command',
                match: { commandRegex: '^npm test$' },
                decision: 'allow',
                scope: 'session',
            };

            const childId = await spawnChild(tracker, agentRegistry, {
                preauths: [preauthRule],
                callerPreauths: [preauthRule],
            });

            // Different command — should not match
            const request = makeApprovalRequest(childId, 'exec_command', { command: 'npm install lodash' });
            const deps: ApprovalRoutingDeps = { delegationTracker: tracker, sessionGrants };
            const result = routeApproval(request, makeRootIdentity(), childId, deps);

            expect(result.action).toBe('prompt_user');
        });
    });

    describe('parent authority satisfaction', () => {
        it('child needs approval, parent has session grant → auto-satisfied, no user prompt', async () => {
            const childId = await spawnChild(tracker, agentRegistry);

            // Parent (root) has a tree-wide grant for exec_command with matching command
            sessionGrants.addGrant('exec_command', 'npm test');

            const request = makeApprovalRequest(childId, 'exec_command', { command: 'npm test' });
            const deps: ApprovalRoutingDeps = { delegationTracker: tracker, sessionGrants };
            const result = routeApproval(request, makeRootIdentity(), childId, deps);

            expect(result.action).toBe('satisfied');
            if (result.action === 'satisfied') {
                expect(result.source).toBe('session_grant');
            }
        });
    });

    describe('root prompting', () => {
        it('child needs approval, parent lacks authority, parent is root → user prompted with child lineage', async () => {
            const childId = await spawnChild(tracker, agentRegistry);

            const request = makeApprovalRequest(childId, 'exec_command', { command: 'npm install lodash' });
            const deps: ApprovalRoutingDeps = { delegationTracker: tracker, sessionGrants };
            const result = routeApproval(request, makeRootIdentity(), childId, deps);

            expect(result.action).toBe('prompt_user');
            if (result.action === 'prompt_user') {
                expect(result.lineageChain).toHaveLength(1);
                expect(result.lineageChain[0].agentId).toBe(childId);
                expect(result.promptText).toContain('exec_command');
                expect(result.promptText).toContain('npm install lodash');
                expect(result.promptText).toContain('test-child');
            }
        });
    });

    describe('bubbling through depth', () => {
        it('child needs approval, parent is depth 1, grandparent is root → bubbles twice, root prompts', async () => {
            // Root spawns child (depth 1)
            const childId = await spawnChild(tracker, agentRegistry);
            const childAgent = tracker.getAgent(childId)!;

            // Child spawns grandchild (depth 2)
            const grandchildId = await spawnChild(tracker, agentRegistry, {
                callerIdentity: childAgent.identity,
                callerSessionId: childAgent.childSessionId,
            });

            // Grandchild needs approval
            const request: ApprovalRequest = {
                type: 'approval_required',
                toolCall: { tool: 'exec_command', args: { command: 'rm -rf dist' } },
                reason: 'exec_command requires confirmation',
                childLineage: [{
                    agentId: grandchildId,
                    depth: 2,
                    label: 'grandchild',
                }],
                resolve: () => {},
            };

            const deps: ApprovalRoutingDeps = { delegationTracker: tracker, sessionGrants };

            // Step 1: Child (depth 1) routes → should bubble
            const childResult = routeApproval(request, childAgent.identity, grandchildId, deps);
            expect(childResult.action).toBe('bubble');
            if (childResult.action !== 'bubble') throw new Error('expected bubble');

            // Lineage now includes grandchild + child
            expect(childResult.lineageChain).toHaveLength(2);
            expect(childResult.lineageChain[0].agentId).toBe(grandchildId);
            expect(childResult.lineageChain[1].agentId).toBe(childId);

            // Step 2: Root (depth 0) routes with extended lineage → should prompt user
            const bubbledRequest: ApprovalRequest = {
                ...request,
                childLineage: childResult.lineageChain,
            };
            const rootResult = routeApproval(bubbledRequest, makeRootIdentity(), grandchildId, deps);
            expect(rootResult.action).toBe('prompt_user');
            if (rootResult.action !== 'prompt_user') throw new Error('expected prompt_user');
            expect(rootResult.lineageChain).toHaveLength(2);
            expect(rootResult.promptText).toContain('grandchild');
        });
    });

    describe('session grant propagation', () => {
        it('session grant from root → child can reuse for matching actions', async () => {
            const childId = await spawnChild(tracker, agentRegistry);
            let resolvedAnswer: string | undefined;
            const request = makeApprovalRequest(
                childId,
                'exec_command',
                { command: 'npm test' },
                (answer) => { resolvedAnswer = answer; },
            );

            tracker.setPendingApproval(childId, request);
            const deps: ApprovalRoutingDeps = { delegationTracker: tracker, sessionGrants };

            // Resolve with 'approved' → creates subtree grant for child
            resolveRoutedApproval(request, childId, 'approved', deps);
            expect(resolvedAnswer).toBe('approved');

            // Next time child requests same action → auto-satisfied via session grant
            const request2 = makeApprovalRequest(childId, 'exec_command', { command: 'npm test' });
            const result = routeApproval(request2, makeRootIdentity(), childId, deps);
            expect(result.action).toBe('satisfied');
            if (result.action === 'satisfied') {
                expect(result.source).toBe('session_grant');
            }
        });

        it('subtree-scoped grant: grant given to child A → sibling child B cannot use it', async () => {
            const childA = await spawnChild(tracker, agentRegistry);
            const childB = await spawnChild(tracker, agentRegistry);

            // Create a subtree-scoped grant for childA with matching command
            sessionGrants.addSubtreeGrant('exec_command', 'npm test', childA);

            const deps: ApprovalRoutingDeps = { delegationTracker: tracker, sessionGrants };

            // childA can use it
            const requestA = makeApprovalRequest(childA, 'exec_command', { command: 'npm test' });
            const resultA = routeApproval(requestA, makeRootIdentity(), childA, deps);
            expect(resultA.action).toBe('satisfied');

            // childB cannot use it (sibling, not in childA's subtree)
            const requestB = makeApprovalRequest(childB, 'exec_command', { command: 'npm test' });
            const resultB = routeApproval(requestB, makeRootIdentity(), childB, deps);
            expect(resultB.action).toBe('prompt_user');
        });

        it('whole-tree grant via [a] always → grant applies to entire agent tree, sibling B can use it', async () => {
            const childA = await spawnChild(tracker, agentRegistry);
            const childB = await spawnChild(tracker, agentRegistry);

            let resolvedAnswer: string | undefined;
            const request = makeApprovalRequest(
                childA,
                'exec_command',
                { command: 'npm test' },
                (answer) => { resolvedAnswer = answer; },
            );
            tracker.setPendingApproval(childA, request);

            const deps: ApprovalRoutingDeps = { delegationTracker: tracker, sessionGrants };

            // User chooses [a] always → tree-wide grant
            resolveRoutedApproval(request, childA, 'always', deps);
            expect(resolvedAnswer).toBe('approved');

            // Sibling childB can now use the same grant
            const requestB = makeApprovalRequest(childB, 'exec_command', { command: 'npm test' });
            const resultB = routeApproval(requestB, makeRootIdentity(), childB, deps);
            expect(resultB.action).toBe('satisfied');
            if (resultB.action === 'satisfied') {
                expect(resultB.source).toBe('session_grant');
            }
        });
    });

    describe('resolveRoutedApproval', () => {
        it('denied → child receives denied, no grant created', async () => {
            const childId = await spawnChild(tracker, agentRegistry);
            let resolvedAnswer: string | undefined;
            const request = makeApprovalRequest(
                childId,
                'exec_command',
                { command: 'rm -rf /' },
                (answer) => { resolvedAnswer = answer; },
            );
            tracker.setPendingApproval(childId, request);

            const deps: ApprovalRoutingDeps = { delegationTracker: tracker, sessionGrants };
            resolveRoutedApproval(request, childId, 'denied', deps);

            expect(resolvedAnswer).toBe('denied');
            expect(tracker.getAgent(childId)!.pendingApproval).toBeNull();
            // No grant should have been created
            expect(sessionGrants.list()).toHaveLength(0);
        });

        it('approved → clears pending approval', async () => {
            const childId = await spawnChild(tracker, agentRegistry);
            const request = makeApprovalRequest(childId, 'write_file', { path: '/tmp/x' });
            tracker.setPendingApproval(childId, request);

            const deps: ApprovalRoutingDeps = { delegationTracker: tracker, sessionGrants };
            resolveRoutedApproval(request, childId, 'approved', deps);

            expect(tracker.getAgent(childId)!.pendingApproval).toBeNull();
        });
    });

    describe('formatRoutedPrompt', () => {
        it('includes tool name, command, and lineage in prompt text', () => {
            const request: ApprovalRequest = {
                type: 'approval_required',
                toolCall: {
                    tool: 'exec_command',
                    args: { command: 'npm install lodash' },
                    riskTier: 'high',
                    riskFacets: ['network_download', 'package_install'],
                },
                reason: 'exec_command requires confirmation',
                childLineage: [
                    { agentId: 'agt_child1', depth: 1, label: 'coder-agent' },
                    { agentId: 'agt_mid1', depth: 1, label: 'orchestrator' },
                ],
                resolve: () => {},
            };

            const text = formatRoutedPrompt(request);
            expect(text).toContain('exec_command');
            expect(text).toContain('npm install lodash');
            expect(text).toContain('high');
            expect(text).toContain('network_download');
            expect(text).toContain('coder-agent');
            expect(text).toContain('orchestrator');
            expect(text).toContain('[a] always');
        });
    });

    describe('isInSubtree helper', () => {
        it('agent is in its own subtree', () => {
            const lookup = (_id: string) => null;
            expect(isInSubtree('agt_A', 'agt_A', lookup)).toBe(true);
        });

        it('child is in parent subtree', () => {
            const lookup = (id: string) => id === 'agt_child' ? 'agt_parent' : null;
            expect(isInSubtree('agt_child', 'agt_parent', lookup)).toBe(true);
        });

        it('sibling is NOT in sibling subtree', () => {
            const lookup = (id: string) => {
                if (id === 'agt_A' || id === 'agt_B') return 'agt_root';
                return null;
            };
            expect(isInSubtree('agt_B', 'agt_A', lookup)).toBe(false);
        });

        it('guards against cycles with depth limit', () => {
            // Create a cycle: A → B → A
            const lookup = (id: string) => id === 'agt_A' ? 'agt_B' : 'agt_A';
            // Should not hang, returns false
            expect(isInSubtree('agt_A', 'agt_nonexistent', lookup)).toBe(false);
        });
    });

    describe('buildParentLookup', () => {
        it('returns parent ID for tracked agent', async () => {
            const childId = await spawnChild(tracker, agentRegistry);
            const lookup = buildParentLookup(tracker);
            expect(lookup(childId)).toBe(ROOT_AGENT_ID);
        });

        it('returns null for unknown agent', () => {
            const lookup = buildParentLookup(tracker);
            expect(lookup('agt_nonexistent')).toBeNull();
        });
    });

    describe('consultation fixes', () => {
        it('double resolution is idempotent — second call returns false', async () => {
            const childId = await spawnChild(tracker, agentRegistry);
            let callCount = 0;
            const request = makeApprovalRequest(
                childId,
                'exec_command',
                { command: 'npm test' },
                () => { callCount++; },
            );
            tracker.setPendingApproval(childId, request);

            const deps: ApprovalRoutingDeps = { delegationTracker: tracker, sessionGrants };
            const first = resolveRoutedApproval(request, childId, 'approved', deps);
            const second = resolveRoutedApproval(request, childId, 'approved', deps);

            expect(first).toBe(true);
            expect(second).toBe(false);
            expect(callCount).toBe(1); // resolve called only once
        });

        it('tree-wide grant created even when subtree-scoped grant exists for same tool+command', async () => {
            const childId = await spawnChild(tracker, agentRegistry);

            // First: subtree-scoped grant
            sessionGrants.addSubtreeGrant('exec_command', 'npm test', childId);
            expect(sessionGrants.list()).toHaveLength(1);

            // Second: tree-wide grant for same tool+command — should NOT be blocked
            sessionGrants.addGrant('exec_command', 'npm test');
            expect(sessionGrants.list()).toHaveLength(2);

            // Verify the tree-wide grant exists (no agentSubtreeRoot)
            const treeWide = sessionGrants.list().find(g => g.agentSubtreeRoot === undefined);
            expect(treeWide).toBeDefined();
            expect(treeWide!.toolName).toBe('exec_command');
        });

        it('preauth deny decision → returns denied action', async () => {
            const denyRule: PreauthRule = {
                id: 'deny-rm',
                tool: 'exec_command',
                match: { commandRegex: '^rm ' },
                decision: 'deny',
                scope: 'session',
            };

            const childId = await spawnChild(tracker, agentRegistry, {
                preauths: [denyRule],
                callerPreauths: [denyRule],
            });

            const request = makeApprovalRequest(childId, 'exec_command', { command: 'rm -rf /' });
            const deps: ApprovalRoutingDeps = { delegationTracker: tracker, sessionGrants };
            const result = routeApproval(request, makeRootIdentity(), childId, deps);

            expect(result.action).toBe('denied');
            if (result.action === 'denied') {
                expect(result.reason).toContain('deny-rm');
            }
        });
    });
});
