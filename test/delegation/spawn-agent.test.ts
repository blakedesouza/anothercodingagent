/**
 * Tests for M7.1b: spawn_agent Tool + Child Sessions
 *
 * Covers:
 * - Agent identity shape: agt_<ulid> format, parent/root lineage, depth, spawnIndex, label
 * - Spawn general agent → child session with correct lineage, profile tools
 * - Spawn with narrowing allowed_tools → tool set is intersection
 * - Spawn with widening allowed_tools → rejected (narrowing only)
 * - Limit: 5th concurrent → limit_exceeded
 * - Depth limit: depth 2 tries to spawn → limit_exceeded
 * - Total limit: 21st agent → limit_exceeded
 * - Child session has own ses_<ulid> with parentSessionId
 * - Pre-auth transport: parent passes pattern → child auto-approves
 * - Spawn with narrowing authority → child authority is intersection
 * - Spawn with widening authority → rejected
 * - Pre-auth widening: grant authority parent doesn't hold → rejected
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    spawnAgentSpec,
    createSpawnAgentImpl,
    DelegationTracker,
    DEFAULT_DELEGATION_LIMITS,
    validatePreauthNarrowing,
    validateAuthorityNarrowing,
} from '../../src/delegation/spawn-agent.js';
import type {
    AuthorityRule,
    SpawnAgentDeps,
    SpawnCallerContext,
    DelegationLimits,
} from '../../src/delegation/spawn-agent.js';
import { AgentRegistry } from '../../src/delegation/agent-registry.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolSpec, ToolImplementation, ToolContext } from '../../src/tools/tool-registry.js';
import type { AgentIdentity } from '../../src/types/agent.js';
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
    registry.register(makeToolSpec('find_paths', 'read-only'), noopImpl);
    registry.register(makeToolSpec('search_text', 'read-only'), noopImpl);
    registry.register(makeToolSpec('stat_path', 'read-only'), noopImpl);
    registry.register(makeToolSpec('write_file', 'workspace-write'), noopImpl);
    registry.register(makeToolSpec('edit_file', 'workspace-write'), noopImpl);
    registry.register(makeToolSpec('exec_command', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('fetch_url', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('lsp_query', 'read-only'), noopImpl);
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

function makeChildIdentity(parentId: AgentId, rootId: AgentId, depth: number): AgentIdentity {
    return {
        id: `agt_child_${depth}_${Date.now()}` as AgentId,
        parentAgentId: parentId,
        rootAgentId: rootId,
        depth,
        spawnIndex: 0,
        label: `child-depth-${depth}`,
    };
}

let childSessionCounter = 0;
function createMockChildSession(_parentSessionId: SessionId, _rootSessionId: SessionId): SessionId {
    childSessionCounter++;
    return `ses_child_${String(childSessionCounter).padStart(26, '0')}` as SessionId;
}

function makeDeps(
    agentRegistry: AgentRegistry,
    tracker?: DelegationTracker,
    limits?: DelegationLimits,
): SpawnAgentDeps {
    const effectiveLimits = limits ?? DEFAULT_DELEGATION_LIMITS;
    return {
        agentRegistry,
        delegationTracker: tracker ?? new DelegationTracker(effectiveLimits),
        limits: effectiveLimits,
        createChildSession: createMockChildSession,
    };
}

function makeCallerContext(overrides?: Partial<SpawnCallerContext>): SpawnCallerContext {
    return {
        callerIdentity: makeRootIdentity(),
        callerSessionId: ROOT_SESSION_ID,
        rootSessionId: ROOT_SESSION_ID,
        callerPreauths: [],
        callerAuthority: [],
        callerTools: ['read_file', 'write_file', 'edit_file', 'find_paths', 'search_text', 'exec_command', 'lsp_query', 'spawn_agent', 'message_agent', 'await_agent'],
        ...overrides,
    };
}

const stubToolContext: ToolContext = {
    sessionId: ROOT_SESSION_ID,
    workspaceRoot: '/tmp/test-workspace',
    signal: AbortSignal.abort(), // unused in spawn_agent
};

function parseOutput(output: { status: string; data: string }): Record<string, unknown> {
    return JSON.parse(output.data) as Record<string, unknown>;
}

// --- Tests ---

describe('spawn_agent', () => {
    beforeEach(() => {
        childSessionCounter = 0;
    });

    describe('tool spec', () => {
        it('has correct name and approval class', () => {
            expect(spawnAgentSpec.name).toBe('spawn_agent');
            expect(spawnAgentSpec.approvalClass).toBe('external-effect');
            expect(spawnAgentSpec.timeoutCategory).toBe('delegation');
            expect(spawnAgentSpec.idempotent).toBe(false);
        });

        it('requires agent_type and task', () => {
            const required = spawnAgentSpec.inputSchema.required as string[];
            expect(required).toContain('agent_type');
            expect(required).toContain('task');
        });
    });

    describe('agent identity shape', () => {
        it('spawned agent has agt_<ulid> format ID, correct lineage, depth, spawnIndex, label', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const tracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
            const deps = makeDeps(registry, tracker);
            const callerCtx = makeCallerContext();
            const impl = createSpawnAgentImpl(deps, callerCtx);

            const result = await impl(
                { agent_type: 'general', task: 'test task', label: 'my-agent' },
                stubToolContext,
            );

            expect(result.status).toBe('success');
            const data = parseOutput(result);

            // Agent ID format: agt_ + 26 alphanumeric chars (ULID)
            expect(data.agentId).toMatch(/^agt_[0-9A-HJKMNP-TV-Z]{26}$/i);
            expect(data.childSessionId).toMatch(/^ses_/);
            expect(data.agentType).toBe('general');
            expect(data.label).toBe('my-agent');
            expect(data.depth).toBe(1); // root is 0, child is 1

            // Verify tracker recorded identity
            const tracked = tracker.getAgent(data.agentId as string);
            expect(tracked).toBeDefined();
            expect(tracked!.identity.parentAgentId).toBe(ROOT_AGENT_ID);
            expect(tracked!.identity.rootAgentId).toBe(ROOT_AGENT_ID);
            expect(tracked!.identity.depth).toBe(1);
            expect(tracked!.identity.spawnIndex).toBe(0);
            expect(tracked!.identity.label).toBe('my-agent');
        });
    });

    describe('child session creation', () => {
        it('spawn general agent → child session with correct lineage, profile tools', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const deps = makeDeps(registry);
            const callerCtx = makeCallerContext();
            const impl = createSpawnAgentImpl(deps, callerCtx);

            const result = await impl(
                { agent_type: 'general', task: 'analyze code' },
                stubToolContext,
            );

            expect(result.status).toBe('success');
            const data = parseOutput(result);
            expect(data.childSessionId).toMatch(/^ses_/);
            expect(data.agentType).toBe('general');

            // General profile gets read-only + workspace-write tools
            const tools = data.tools as string[];
            expect(tools).toContain('read_file');
            expect(tools).toContain('write_file');
            expect(tools).not.toContain('exec_command'); // external-effect excluded from general
        });

        it('child session has own ses_<ulid> with parentSessionId set', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            let capturedParent: SessionId | undefined;
            let capturedRoot: SessionId | undefined;
            const createChild = (parent: SessionId, root: SessionId): SessionId => {
                capturedParent = parent;
                capturedRoot = root;
                return `ses_test_child_00000000000000000` as SessionId;
            };

            const deps: SpawnAgentDeps = {
                agentRegistry: registry,
                delegationTracker: new DelegationTracker(DEFAULT_DELEGATION_LIMITS),
                limits: DEFAULT_DELEGATION_LIMITS,
                createChildSession: createChild,
            };
            const callerCtx = makeCallerContext();
            const impl = createSpawnAgentImpl(deps, callerCtx);

            await impl({ agent_type: 'coder', task: 'fix bug' }, stubToolContext);

            expect(capturedParent).toBe(ROOT_SESSION_ID);
            expect(capturedRoot).toBe(ROOT_SESSION_ID);
        });
    });

    describe('tool narrowing', () => {
        it('spawn with narrowing allowed_tools → tool set is intersection', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const deps = makeDeps(registry);
            const callerCtx = makeCallerContext();
            const impl = createSpawnAgentImpl(deps, callerCtx);

            // Coder profile has: read_file, write_file, edit_file, find_paths, search_text, exec_command, lsp_query
            // Narrow to just read_file and write_file
            const result = await impl(
                { agent_type: 'coder', task: 'limited task', allowed_tools: ['read_file', 'write_file'] },
                stubToolContext,
            );

            expect(result.status).toBe('success');
            const data = parseOutput(result);
            const tools = data.tools as string[];
            expect(tools).toEqual(['read_file', 'write_file']);
        });

        it('spawn with explicit empty allowed_tools → child gets no tools', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const deps = makeDeps(registry);
            const callerCtx = makeCallerContext();
            const impl = createSpawnAgentImpl(deps, callerCtx);

            const result = await impl(
                { agent_type: 'coder', task: 'limited task', allowed_tools: [] },
                stubToolContext,
            );

            expect(result.status).toBe('success');
            const data = parseOutput(result);
            const tools = data.tools as string[];
            expect(tools).toEqual([]);
        });

        it('spawn with widening allowed_tools → rejected (narrowing only)', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const deps = makeDeps(registry);
            const callerCtx = makeCallerContext();
            const impl = createSpawnAgentImpl(deps, callerCtx);

            // Reviewer profile does NOT have write_file — trying to add it is widening
            const result = await impl(
                { agent_type: 'reviewer', task: 'review', allowed_tools: ['read_file', 'write_file'] },
                stubToolContext,
            );

            expect(result.status).toBe('error');
            expect(result.error).toBeDefined();
            expect(result.error!.code).toBe('delegation.spawn_failed');
            expect(result.error!.message).toContain('narrowing rejected');
            expect(result.error!.details).toBeDefined();
            expect((result.error!.details as Record<string, unknown>).rejected).toEqual(
                expect.arrayContaining(['write_file']),
            );
        });
    });

    describe('limits enforcement', () => {
        it('5th concurrent agent → limit_exceeded error with spawn_failed code', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const tracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
            const deps = makeDeps(registry, tracker);
            const callerCtx = makeCallerContext();
            const impl = createSpawnAgentImpl(deps, callerCtx);

            // Spawn 4 agents (max concurrent = 4)
            for (let i = 0; i < 4; i++) {
                const r = await impl({ agent_type: 'general', task: `task ${i}` }, stubToolContext);
                expect(r.status).toBe('success');
            }

            // 5th should fail with spawn_failed (not depth_exceeded)
            const result = await impl({ agent_type: 'general', task: 'overflow' }, stubToolContext);
            expect(result.status).toBe('error');
            expect(result.error).toBeDefined();
            expect(result.error!.code).toBe('delegation.spawn_failed');
            expect(result.error!.message).toContain('concurrent');
            expect(result.error!.details).toEqual(
                expect.objectContaining({ current: 4, allowed: 4 }),
            );
        });

        it('depth limit: grandchild at depth 2 tries to spawn → depth_exceeded', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const tracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
            const deps = makeDeps(registry, tracker);

            // Grandchild at depth 2 trying to spawn (would be depth 3, max is 2)
            const grandchildIdentity = makeChildIdentity(
                'agt_parent_00000000000000000001' as AgentId,
                ROOT_AGENT_ID,
                2,
            );
            const callerCtx = makeCallerContext({ callerIdentity: grandchildIdentity });
            const impl = createSpawnAgentImpl(deps, callerCtx);

            const result = await impl({ agent_type: 'general', task: 'too deep' }, stubToolContext);
            expect(result.status).toBe('error');
            expect(result.error).toBeDefined();
            expect(result.error!.code).toBe('delegation.depth_exceeded');
            expect(result.error!.message).toContain('depth');
            expect(result.error!.details).toEqual(
                expect.objectContaining({ current: 2, allowed: 2 }),
            );
        });

        it('root spawns child (depth=1) → succeeds; child spawns grandchild (depth=2) → succeeds', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const tracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
            const deps = makeDeps(registry, tracker);

            // Root (depth=0) spawns child → depth=1
            const rootCtx = makeCallerContext();
            const rootImpl = createSpawnAgentImpl(deps, rootCtx);
            const childResult = await rootImpl({ agent_type: 'coder', task: 'code' }, stubToolContext);
            expect(childResult.status).toBe('success');
            const childData = parseOutput(childResult);
            expect(childData.depth).toBe(1);

            // Child (depth=1) spawns grandchild → depth=2
            const childIdentity = makeChildIdentity(
                childData.agentId as AgentId,
                ROOT_AGENT_ID,
                1,
            );
            const childCtx = makeCallerContext({ callerIdentity: childIdentity });
            const childImpl = createSpawnAgentImpl(deps, childCtx);
            const grandchildResult = await childImpl({ agent_type: 'general', task: 'sub-task' }, stubToolContext);
            expect(grandchildResult.status).toBe('success');
            const gcData = parseOutput(grandchildResult);
            expect(gcData.depth).toBe(2);
        });

        it('21st agent in session → spawn_failed with total limit', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const tracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
            const deps = makeDeps(registry, tracker);
            const callerCtx = makeCallerContext();
            const impl = createSpawnAgentImpl(deps, callerCtx);

            // Spawn 20 agents, completing each so concurrent limit doesn't block
            for (let i = 0; i < 20; i++) {
                const r = await impl({ agent_type: 'general', task: `task ${i}` }, stubToolContext);
                expect(r.status).toBe('success');
                const data = parseOutput(r);
                tracker.markCompleted(data.agentId as string, 'completed');
            }

            // 21st should fail with spawn_failed (total limit)
            const result = await impl({ agent_type: 'general', task: 'too many' }, stubToolContext);
            expect(result.status).toBe('error');
            expect(result.error).toBeDefined();
            expect(result.error!.code).toBe('delegation.spawn_failed');
            expect(result.error!.message).toContain('total');
            expect(result.error!.details).toEqual(
                expect.objectContaining({ current: 20, allowed: 20 }),
            );
        });
    });

    describe('pre-auth transport', () => {
        it('parent passes preAuthorizedPatterns → child inherits them', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const tracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
            const deps = makeDeps(registry, tracker);

            const parentPreauths: PreauthRule[] = [
                { id: 'pre-1', tool: 'exec_command', match: { commandRegex: '^npm test$' }, decision: 'allow', scope: 'session' },
            ];
            const callerCtx = makeCallerContext({ callerPreauths: parentPreauths });
            const impl = createSpawnAgentImpl(deps, callerCtx);

            const result = await impl(
                {
                    agent_type: 'coder',
                    task: 'run tests',
                    preAuthorizedPatterns: [
                        { id: 'child-pre-1', tool: 'exec_command', match: { commandRegex: '^npm test$' }, decision: 'allow', scope: 'session' },
                    ],
                },
                stubToolContext,
            );

            expect(result.status).toBe('success');
            const data = parseOutput(result);
            const tracked = tracker.getAgent(data.agentId as string);
            expect(tracked).toBeDefined();
            expect(tracked!.preAuthorizedPatterns).toHaveLength(1);
            expect(tracked!.preAuthorizedPatterns[0].tool).toBe('exec_command');
        });

        it('pre-auth widening: parent tries to grant authority it doesn\'t hold → rejected', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const deps = makeDeps(registry);

            // Parent has NO preauths
            const callerCtx = makeCallerContext({ callerPreauths: [] });
            const impl = createSpawnAgentImpl(deps, callerCtx);

            const result = await impl(
                {
                    agent_type: 'coder',
                    task: 'do stuff',
                    preAuthorizedPatterns: [
                        { id: 'bad', tool: 'exec_command', match: { commandRegex: '.*' }, decision: 'allow', scope: 'session' },
                    ],
                },
                stubToolContext,
            );

            expect(result.status).toBe('error');
            expect(result.error).toBeDefined();
            expect(result.error!.code).toBe('delegation.spawn_failed');
            expect(result.error!.message).toContain('Pre-auth widening');
        });
    });

    describe('authority narrowing', () => {
        it('spawn with identical authority rule (structural match) → accepted', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const deps = makeDeps(registry);

            const parentAuthority: AuthorityRule[] = [
                { id: 'auth-1', tool: 'exec_command', match: { commandRegex: '^npm' }, decision: 'allow', scope: 'session' },
                { id: 'auth-2', tool: 'write_file', match: {}, decision: 'allow', scope: 'session' },
            ];
            const callerCtx = makeCallerContext({ callerAuthority: parentAuthority });
            const impl = createSpawnAgentImpl(deps, callerCtx);

            // Child passes through parent's exact exec_command rule (subset selection)
            const result = await impl(
                {
                    agent_type: 'coder',
                    task: 'run tests',
                    authority: [
                        { id: 'child-auth', tool: 'exec_command', match: { commandRegex: '^npm' }, decision: 'allow', scope: 'session' },
                    ],
                },
                stubToolContext,
            );

            expect(result.status).toBe('success');
        });

        it('spawn with different match pattern (same tool) → rejected (structural mismatch)', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const deps = makeDeps(registry);

            const parentAuthority: AuthorityRule[] = [
                { id: 'auth-1', tool: 'exec_command', match: { commandRegex: '^npm test$' }, decision: 'allow', scope: 'session' },
            ];
            const callerCtx = makeCallerContext({ callerAuthority: parentAuthority });
            const impl = createSpawnAgentImpl(deps, callerCtx);

            // Child tries different regex — structural mismatch even though same tool
            const result = await impl(
                {
                    agent_type: 'coder',
                    task: 'run any',
                    authority: [
                        { id: 'child-auth', tool: 'exec_command', match: { commandRegex: '.*' }, decision: 'allow', scope: 'session' },
                    ],
                },
                stubToolContext,
            );

            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('delegation.spawn_failed');
            expect(result.error!.message).toContain('Authority widening');
        });

        it('spawn with widening authority (new tool) → rejected', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const deps = makeDeps(registry);

            const parentAuthority: AuthorityRule[] = [
                { id: 'auth-1', tool: 'exec_command', match: {}, decision: 'allow', scope: 'session' },
            ];
            const callerCtx = makeCallerContext({ callerAuthority: parentAuthority });
            const impl = createSpawnAgentImpl(deps, callerCtx);

            // Try to grant write_file authority that parent doesn't hold
            const result = await impl(
                {
                    agent_type: 'coder',
                    task: 'write stuff',
                    authority: [
                        { id: 'bad-auth', tool: 'write_file', match: {}, decision: 'allow', scope: 'session' },
                    ],
                },
                stubToolContext,
            );

            expect(result.status).toBe('error');
            expect(result.error).toBeDefined();
            expect(result.error!.code).toBe('delegation.spawn_failed');
            expect(result.error!.message).toContain('Authority widening');
        });
    });

    describe('caller tool intersection (privilege escalation prevention)', () => {
        it('child with restricted tools cannot widen grandchild tools via profile', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const tracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
            const deps = makeDeps(registry, tracker);

            // Caller only has read_file and spawn_agent — should not be able to
            // give a child the full coder profile tools (write_file, exec_command, etc.)
            const restrictedCtx = makeCallerContext({
                callerTools: ['read_file', 'spawn_agent'],
            });
            const impl = createSpawnAgentImpl(deps, restrictedCtx);

            const result = await impl(
                { agent_type: 'coder', task: 'code stuff' },
                stubToolContext,
            );

            expect(result.status).toBe('success');
            const data = parseOutput(result);
            // Resolved tools must be intersection of coder profile ∩ caller's tools
            // Coder: read_file, write_file, edit_file, find_paths, search_text, exec_command, lsp_query, spawn_agent, message_agent, await_agent
            // Caller: read_file, spawn_agent
            // Intersection: read_file, spawn_agent
            expect(data.tools).toEqual(['read_file', 'spawn_agent']);
        });
    });

    describe('unknown agent type', () => {
        it('unknown agent_type → spawn_failed error', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const deps = makeDeps(registry);
            const callerCtx = makeCallerContext();
            const impl = createSpawnAgentImpl(deps, callerCtx);

            const result = await impl({ agent_type: 'nonexistent', task: 'fail' }, stubToolContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('delegation.spawn_failed');
            expect(result.error!.message).toContain('nonexistent');
        });
    });

    describe('spawnIndex tracking', () => {
        it('sequential spawns from same parent get incrementing spawnIndex', async () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);
            const tracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
            const deps = makeDeps(registry, tracker);
            const callerCtx = makeCallerContext();
            const impl = createSpawnAgentImpl(deps, callerCtx);

            const r1 = await impl({ agent_type: 'general', task: 'a' }, stubToolContext);
            const r2 = await impl({ agent_type: 'general', task: 'b' }, stubToolContext);
            const r3 = await impl({ agent_type: 'general', task: 'c' }, stubToolContext);

            const d1 = parseOutput(r1);
            const d2 = parseOutput(r2);
            const d3 = parseOutput(r3);

            const t1 = tracker.getAgent(d1.agentId as string)!;
            const t2 = tracker.getAgent(d2.agentId as string)!;
            const t3 = tracker.getAgent(d3.agentId as string)!;

            expect(t1.identity.spawnIndex).toBe(0);
            expect(t2.identity.spawnIndex).toBe(1);
            expect(t3.identity.spawnIndex).toBe(2);
        });
    });
});

describe('DelegationTracker', () => {
    it('starts with zero active and zero total', () => {
        const tracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
        expect(tracker.getActiveCount()).toBe(0);
        expect(tracker.getTotalSpawned()).toBe(0);
    });

    it('markCompleted reduces active count but not total', () => {
        const tracker = new DelegationTracker(DEFAULT_DELEGATION_LIMITS);
        const identity: AgentIdentity = {
            id: 'agt_test_00000000000000000001' as AgentId,
            parentAgentId: ROOT_AGENT_ID,
            rootAgentId: ROOT_AGENT_ID,
            depth: 1,
            spawnIndex: 0,
            label: 'test',
        };
        let resolve: () => void = () => {};
        const promise = new Promise<void>(r => { resolve = r; });
        tracker.registerAgent({
            identity,
            parentSessionId: ROOT_SESSION_ID,
            childSessionId: 'ses_test_00000000000000000001' as SessionId,
            status: 'active',
            tools: ['read_file'],
            preAuthorizedPatterns: [],
            authority: [],
            profileName: 'general',
            task: 'test',
            context: '',
            phase: 'booting',
            activeTool: null,
            lastEventAt: new Date().toISOString(),
            spawnedAt: Date.now(),
            summary: 'test',
            messageQueue: [],
            pendingApproval: null,
            result: null,
            completionPromise: promise,
            completionResolve: resolve,
        });

        expect(tracker.getActiveCount()).toBe(1);
        expect(tracker.getTotalSpawned()).toBe(1);

        tracker.markCompleted(identity.id, 'completed');
        expect(tracker.getActiveCount()).toBe(0);
        expect(tracker.getTotalSpawned()).toBe(1);
    });
});

describe('validatePreauthNarrowing', () => {
    it('returns empty when child uses identical match fields as parent', () => {
        const parent: PreauthRule[] = [
            { id: 'p1', tool: 'exec_command', match: { commandRegex: '^npm test$' }, decision: 'allow', scope: 'session' },
        ];
        const child: PreauthRule[] = [
            { id: 'c1', tool: 'exec_command', match: { commandRegex: '^npm test$' }, decision: 'allow', scope: 'session' },
        ];
        expect(validatePreauthNarrowing(parent, child)).toEqual([]);
    });

    it('returns rejected for different tool name', () => {
        const parent: PreauthRule[] = [
            { id: 'p1', tool: 'exec_command', match: {}, decision: 'allow', scope: 'session' },
        ];
        const child: PreauthRule[] = [
            { id: 'c1', tool: 'write_file', match: {}, decision: 'allow', scope: 'session' },
        ];
        const rejected = validatePreauthNarrowing(parent, child);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].tool).toBe('write_file');
    });

    it('returns rejected when match fields differ (structural check)', () => {
        const parent: PreauthRule[] = [
            { id: 'p1', tool: 'exec_command', match: { commandRegex: '^npm test$' }, decision: 'allow', scope: 'session' },
        ];
        const child: PreauthRule[] = [
            { id: 'c1', tool: 'exec_command', match: { commandRegex: '.*' }, decision: 'allow', scope: 'session' },
        ];
        const rejected = validatePreauthNarrowing(parent, child);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].tool).toBe('exec_command');
    });

    it('returns rejected when decision differs', () => {
        const parent: PreauthRule[] = [
            { id: 'p1', tool: 'exec_command', match: {}, decision: 'deny', scope: 'session' },
        ];
        const child: PreauthRule[] = [
            { id: 'c1', tool: 'exec_command', match: {}, decision: 'allow', scope: 'session' },
        ];
        const rejected = validatePreauthNarrowing(parent, child);
        expect(rejected).toHaveLength(1);
    });

    it('allows a permanent parent rule to cover a session-scoped child rule', () => {
        const parent: PreauthRule[] = [
            { id: 'p1', tool: 'exec_command', match: {}, decision: 'allow', scope: 'permanent' },
        ];
        const child: PreauthRule[] = [
            { id: 'c1', tool: 'exec_command', match: {}, decision: 'allow', scope: 'session' },
        ];
        expect(validatePreauthNarrowing(parent, child)).toEqual([]);
    });
});

describe('validateAuthorityNarrowing', () => {
    it('returns empty for structurally matching rule', () => {
        const parent: AuthorityRule[] = [
            { id: 'p1', tool: 'exec_command', match: { commandRegex: '^npm' }, decision: 'allow', scope: 'session' },
        ];
        const override: AuthorityRule[] = [
            { id: 'o1', tool: 'exec_command', match: { commandRegex: '^npm' }, decision: 'allow', scope: 'session' },
        ];
        expect(validateAuthorityNarrowing(parent, override)).toEqual([]);
    });

    it('returns rejected for widening (no parent authority)', () => {
        const parent: AuthorityRule[] = [];
        const override: AuthorityRule[] = [
            { id: 'o1', tool: 'exec_command', match: {}, decision: 'allow', scope: 'session' },
        ];
        const rejected = validateAuthorityNarrowing(parent, override);
        expect(rejected).toHaveLength(1);
    });

    it('returns rejected when match pattern differs', () => {
        const parent: AuthorityRule[] = [
            { id: 'p1', tool: 'exec_command', match: { commandRegex: '^npm test$' }, decision: 'allow', scope: 'session' },
        ];
        const override: AuthorityRule[] = [
            { id: 'o1', tool: 'exec_command', match: {}, decision: 'allow', scope: 'session' },
        ];
        const rejected = validateAuthorityNarrowing(parent, override);
        expect(rejected).toHaveLength(1);
    });

    it('rejects a permanent override when the parent only granted session scope', () => {
        const parent: AuthorityRule[] = [
            { id: 'p1', tool: 'exec_command', match: {}, decision: 'allow', scope: 'session' },
        ];
        const override: AuthorityRule[] = [
            { id: 'o1', tool: 'exec_command', match: {}, decision: 'allow', scope: 'permanent' },
        ];
        const rejected = validateAuthorityNarrowing(parent, override);
        expect(rejected).toHaveLength(1);
    });
});
