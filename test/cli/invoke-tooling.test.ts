import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    mapInvokeAuthorityToDelegationAuthority,
    mapInvokeAuthorityToPreauths,
    registerInvokeRuntimeTools,
} from '../../src/cli/invoke-tooling.js';
import { SessionManager } from '../../src/core/session-manager.js';
import { CapabilityHealthMap } from '../../src/core/capability-health.js';
import { deriveWorkspaceId } from '../../src/core/session-manager.js';
import type { ItemId, SessionId } from '../../src/types/ids.js';
import type { NetworkPolicy } from '../../src/permissions/network-policy.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { readFileSpec, readFileImpl } from '../../src/tools/read-file.js';
import { writeFileSpec, writeFileImpl } from '../../src/tools/write-file.js';
import { editFileSpec, editFileImpl } from '../../src/tools/edit-file.js';
import { deletePathSpec, deletePathImpl } from '../../src/tools/delete-path.js';
import { movePathSpec, movePathImpl } from '../../src/tools/move-path.js';
import { makeDirectorySpec, makeDirectoryImpl } from '../../src/tools/make-directory.js';
import { statPathSpec, statPathImpl } from '../../src/tools/stat-path.js';
import { findPathsSpec, findPathsImpl } from '../../src/tools/find-paths.js';
import { searchTextSpec, searchTextImpl } from '../../src/tools/search-text.js';
import { execCommandSpec, execCommandImpl } from '../../src/tools/exec-command.js';
import { openSessionSpec, openSessionImpl } from '../../src/tools/open-session.js';
import { sessionIoSpec, sessionIoImpl } from '../../src/tools/session-io.js';
import { closeSessionSpec, closeSessionImpl } from '../../src/tools/close-session.js';
import { askUserSpec, askUserImpl } from '../../src/tools/ask-user.js';
import { confirmActionSpec, confirmActionImpl } from '../../src/tools/confirm-action.js';
import { estimateTokensSpec, estimateTokensImpl } from '../../src/tools/estimate-tokens.js';
import { IndexStore } from '../../src/indexing/index-store.js';

function buildInvokeBaseRegistry(): ToolRegistry {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(readFileSpec, readFileImpl);
    toolRegistry.register(writeFileSpec, writeFileImpl);
    toolRegistry.register(editFileSpec, editFileImpl);
    toolRegistry.register(deletePathSpec, deletePathImpl);
    toolRegistry.register(movePathSpec, movePathImpl);
    toolRegistry.register(makeDirectorySpec, makeDirectoryImpl);
    toolRegistry.register(statPathSpec, statPathImpl);
    toolRegistry.register(findPathsSpec, findPathsImpl);
    toolRegistry.register(searchTextSpec, searchTextImpl);
    toolRegistry.register(execCommandSpec, execCommandImpl);
    toolRegistry.register(openSessionSpec, openSessionImpl);
    toolRegistry.register(sessionIoSpec, sessionIoImpl);
    toolRegistry.register(closeSessionSpec, closeSessionImpl);
    toolRegistry.register(askUserSpec, askUserImpl);
    toolRegistry.register(confirmActionSpec, confirmActionImpl);
    toolRegistry.register(estimateTokensSpec, estimateTokensImpl);
    return toolRegistry;
}

describe('registerInvokeRuntimeTools', () => {
    const cleanupPaths: string[] = [];

    afterEach(() => {
        while (cleanupPaths.length > 0) {
            const path = cleanupPaths.pop();
            if (path) rmSync(path, { recursive: true, force: true });
        }
    });

    it('registers the full invoke tool surface and preserves recursive delegation lineage', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'aca-invoke-workspace-'));
        const sessionsDir = mkdtempSync(join(tmpdir(), 'aca-invoke-sessions-'));
        cleanupPaths.push(workspaceRoot, sessionsDir);
        writeFileSync(join(workspaceRoot, 'sample.ts'), 'export const value = 1;\n');

        const sessionManager = new SessionManager(sessionsDir);
        const projection = sessionManager.create(workspaceRoot, {
            model: 'qwen/qwen3-coder-next',
            mode: 'executor',
        });
        const toolRegistry = buildInvokeBaseRegistry();
        const healthMap = new CapabilityHealthMap();
        const networkPolicy: NetworkPolicy = {
            mode: 'approved-only',
            allowDomains: [],
            denyDomains: [],
            allowHttp: false,
        };

        const { agentRegistry, rootCallerContext } = await registerInvokeRuntimeTools({
            cwd: workspaceRoot,
            model: 'qwen/qwen3-coder-next',
            toolRegistry,
            networkPolicy,
            healthMap,
            sessionManager,
            sessionId: projection.manifest.sessionId,
        });

        const toolNames = toolRegistry.list().map(tool => tool.spec.name);
        expect(toolNames).toContain('search_semantic');
        expect(toolNames).toContain('browser_navigate');
        expect(toolNames).toContain('web_search');
        expect(toolNames).toContain('lookup_docs');
        expect(toolNames).toContain('spawn_agent');
        expect(toolNames).toContain('message_agent');
        expect(toolNames).toContain('await_agent');

        const coder = agentRegistry.getProfile('coder');
        expect(coder).toBeDefined();
        expect(coder!.defaultTools).toContain('spawn_agent');
        expect(coder!.defaultTools).toContain('message_agent');
        expect(coder!.defaultTools).toContain('await_agent');

        const spawn = toolRegistry.lookup('spawn_agent');
        expect(spawn).toBeDefined();

        const result = await spawn!.impl(
            {
                agent_type: 'coder',
                task: 'Coordinate a nested fix',
                label: 'invoke-coder',
            },
            {
                workspaceRoot,
                sessionId: projection.manifest.sessionId as SessionId,
                isSubAgent: true,
                signal: AbortSignal.timeout(5000),
            },
        );

        expect(result.status).toBe('success');
        const data = JSON.parse(result.data) as { childSessionId: string; tools: string[] };
        expect(data.tools).toContain('spawn_agent');
        expect(data.tools).toContain('message_agent');
        expect(data.tools).toContain('await_agent');

        const manifest = JSON.parse(
            readFileSync(join(sessionsDir, data.childSessionId, 'manifest.json'), 'utf-8'),
        ) as {
            parentSessionId?: string;
            rootSessionId?: string;
        };
        expect(manifest.parentSessionId).toBe(projection.manifest.sessionId);
        expect(manifest.rootSessionId).toBe(projection.manifest.sessionId);

        rootCallerContext.callerTools = ['read_file', 'spawn_agent'];
        const narrowedResult = await spawn!.impl(
            {
                agent_type: 'coder',
                task: 'Coordinate a nested fix with restricted tools',
                label: 'invoke-coder-restricted',
            },
            {
                workspaceRoot,
                sessionId: projection.manifest.sessionId as SessionId,
                isSubAgent: true,
                signal: AbortSignal.timeout(5000),
            },
        );

        expect(narrowedResult.status).toBe('success');
        const narrowedData = JSON.parse(narrowedResult.data) as { tools: string[] };
        expect(narrowedData.tools).toEqual(['read_file', 'spawn_agent']);
    });

    it('maps invoke authority into delegation-safe authority and preauth rules', () => {
        const authority = [
            {
                tool: 'exec_command',
                args_match: { commandRegex: '^npm test$', cwdPattern: '/repo' },
                decision: 'approve' as const,
            },
            {
                tool: 'read_file',
                args_match: { path: 'secret.txt' },
                decision: 'deny' as const,
            },
        ];

        expect(mapInvokeAuthorityToDelegationAuthority(authority)).toEqual([
            {
                id: 'invoke-authority-0',
                tool: 'exec_command',
                match: { commandRegex: '^npm test$', cwdPattern: '/repo' },
                decision: 'allow',
                scope: 'session',
            },
            {
                id: 'invoke-authority-1',
                tool: 'read_file',
                match: { path: 'secret.txt' },
                decision: 'deny',
                scope: 'session',
            },
        ]);

        expect(mapInvokeAuthorityToPreauths(authority)).toEqual([
            {
                id: 'invoke-authority-0',
                tool: 'exec_command',
                match: { commandRegex: '^npm test$', cwdPattern: '/repo' },
                decision: 'allow',
                scope: 'session',
            },
        ]);
    });

    it('lets invoke-root pass identical authority and preauth rules through spawn_agent', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'aca-invoke-authority-'));
        const sessionsDir = mkdtempSync(join(tmpdir(), 'aca-invoke-authority-sessions-'));
        cleanupPaths.push(workspaceRoot, sessionsDir);

        const sessionManager = new SessionManager(sessionsDir);
        const projection = sessionManager.create(workspaceRoot, {
            model: 'qwen/qwen3-coder-next',
            mode: 'executor',
        });
        const toolRegistry = buildInvokeBaseRegistry();
        const healthMap = new CapabilityHealthMap();
        const networkPolicy: NetworkPolicy = {
            mode: 'approved-only',
            allowDomains: [],
            denyDomains: [],
            allowHttp: false,
        };

        const { rootCallerContext } = await registerInvokeRuntimeTools({
            cwd: workspaceRoot,
            model: 'qwen/qwen3-coder-next',
            toolRegistry,
            networkPolicy,
            healthMap,
            sessionManager,
            sessionId: projection.manifest.sessionId,
        });
        const spawn = toolRegistry.lookup('spawn_agent');
        expect(spawn).toBeDefined();

        const authority = [{
            tool: 'exec_command',
            args_match: { commandRegex: '^npm test$' },
            decision: 'approve' as const,
        }];
        rootCallerContext.callerAuthority = mapInvokeAuthorityToDelegationAuthority(authority);
        rootCallerContext.callerPreauths = mapInvokeAuthorityToPreauths(authority);

        const result = await spawn!.impl(
            {
                agent_type: 'coder',
                task: 'Run tests',
                authority: [{
                    id: 'child-authority',
                    tool: 'exec_command',
                    match: { commandRegex: '^npm test$' },
                    decision: 'allow',
                    scope: 'session',
                }],
                preAuthorizedPatterns: [{
                    id: 'child-preauth',
                    tool: 'exec_command',
                    match: { commandRegex: '^npm test$' },
                    decision: 'allow',
                    scope: 'session',
                }],
            },
            {
                workspaceRoot,
                sessionId: projection.manifest.sessionId as SessionId,
                isSubAgent: true,
                signal: AbortSignal.timeout(5000),
            },
        );

        expect(result.status).toBe('success');
    });

    it('refreshes the semantic index after a mutation even before search_semantic is used', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'aca-invoke-semantic-'));
        const sessionsDir = mkdtempSync(join(tmpdir(), 'aca-invoke-semantic-sessions-'));
        cleanupPaths.push(workspaceRoot, sessionsDir);
        const indexDir = join(process.env.HOME ?? '', '.aca', 'indexes', deriveWorkspaceId(workspaceRoot));
        cleanupPaths.push(indexDir);

        writeFileSync(join(workspaceRoot, 'auth.ts'), 'export const authToken = "abc";\n');

        const sessionManager = new SessionManager(sessionsDir);
        const projection = sessionManager.create(workspaceRoot, {
            model: 'qwen/qwen3-coder-next',
            mode: 'executor',
        });
        const toolRegistry = buildInvokeBaseRegistry();
        const healthMap = new CapabilityHealthMap();
        const networkPolicy: NetworkPolicy = {
            mode: 'open',
            allowDomains: [],
            denyDomains: [],
            allowHttp: true,
        };

        const { refreshSemanticIndexAfterTurn } = await registerInvokeRuntimeTools({
            cwd: workspaceRoot,
            model: 'qwen/qwen3-coder-next',
            toolRegistry,
            networkPolicy,
            healthMap,
            sessionManager,
            sessionId: projection.manifest.sessionId,
        });

        writeFileSync(join(workspaceRoot, 'sentinel.ts'), 'export const sentinelAuthToken = "m6-token";\n');

        const status = await refreshSemanticIndexAfterTurn([
            {
                kind: 'tool_result',
                id: 'item_tool_write' as ItemId,
                seq: 1,
                toolCallId: 'call_write_1',
                toolName: 'write_file',
                output: {
                    status: 'success',
                    data: 'Wrote sentinel.ts',
                    truncated: false,
                    bytesReturned: 0,
                    bytesOmitted: 0,
                    retryable: false,
                    timedOut: false,
                    mutationState: 'filesystem',
                },
                timestamp: new Date().toISOString(),
            },
        ]);

        expect(status).toMatch(/updated|scheduled/);

        const store = new IndexStore(join(indexDir, 'index.db'));
        expect(store.open()).toBe(true);
        try {
            expect(store.getFile('sentinel.ts')).not.toBeNull();
            expect(store.getStats().fileCount).toBe(2);
        } finally {
            store.close();
        }
    });
});
