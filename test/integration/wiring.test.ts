/**
 * M5.8 — CLI Wiring Integration Tests
 *
 * Verifies that all M1–M5 modules are properly wired:
 *   T1: Approval flow triggers on workspace-write tools
 *   T2: Sandbox denies paths outside workspace
 *   T3: Network policy enforced via ToolRunner
 *   T4: ProviderRegistry resolves models
 *   T5: Session persistence (manifest + conversation.jsonl)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockNanoGPTServer } from '../helpers/mock-nanogpt-server.js';
import { SessionManager } from '../../src/core/session-manager.js';
import type { SessionProjection } from '../../src/core/session-manager.js';
import { TurnEngine } from '../../src/core/turn-engine.js';
import type { TurnEngineConfig } from '../../src/core/turn-engine.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { readFileSpec, readFileImpl } from '../../src/tools/read-file.js';
import { writeFileSpec, writeFileImpl } from '../../src/tools/write-file.js';
import { execCommandSpec, execCommandImpl } from '../../src/tools/exec-command.js';
import { NanoGptDriver } from '../../src/providers/nanogpt-driver.js';
import { ProviderRegistry } from '../../src/providers/provider-registry.js';
import { SessionGrantStore } from '../../src/permissions/session-grants.js';
import { CONFIG_DEFAULTS, type ResolvedConfig } from '../../src/config/schema.js';
import type { NetworkPolicy } from '../../src/permissions/network-policy.js';
import type { ToolResultItem } from '../../src/types/conversation.js';

const FIXTURE_PATH = join(process.cwd(), 'test', 'fixtures', 'sample.txt');

describe('M5.8 CLI Wiring Integration', () => {
    let mockServer: MockNanoGPTServer;
    let sessionsDir: string;
    let sm: SessionManager;

    beforeAll(async () => {
        mockServer = new MockNanoGPTServer();
        await mockServer.start();
        sessionsDir = mkdtempSync(join(tmpdir(), 'aca-wiring-'));
        sm = new SessionManager(sessionsDir);
    });

    afterAll(async () => {
        await mockServer.stop();
        rmSync(sessionsDir, { recursive: true, force: true });
    });

    function makeConfig(): ResolvedConfig {
        return {
            ...CONFIG_DEFAULTS,
            permissions: {
                ...CONFIG_DEFAULTS.permissions,
                classOverrides: {},
                toolOverrides: {},
                blockedTools: [],
            },
        };
    }

    function makeEngine(
        projection: SessionProjection,
        registry: ToolRegistry,
        opts?: { networkPolicy?: NetworkPolicy },
    ): TurnEngine {
        const driver = new NanoGptDriver({
            apiKey: 'test-key',
            baseUrl: mockServer.baseUrl,
        });
        return new TurnEngine(
            driver,
            registry,
            projection.writer,
            projection.sequenceGenerator,
            undefined, // scrubber
            undefined, // providerRegistry
            undefined, // costTracker
            opts?.networkPolicy,
        );
    }

    function makeEngineConfig(
        projection: SessionProjection,
        overrides?: Partial<TurnEngineConfig>,
    ): TurnEngineConfig {
        return {
            sessionId: projection.manifest.sessionId,
            model: 'gpt-4',
            provider: 'nanogpt',
            interactive: true,
            autoConfirm: false,
            isSubAgent: false,
            workspaceRoot: process.cwd(),
            resolvedConfig: makeConfig(),
            sessionGrants: new SessionGrantStore(),
            ...overrides,
        };
    }

    it('T1: approval flow denies blocked tools', async () => {
        const projection = sm.create(process.cwd());
        const registry = new ToolRegistry();
        registry.register(writeFileSpec, writeFileImpl);
        const engine = makeEngine(projection, registry);

        // Queue a tool call response to write_file
        mockServer.reset();
        mockServer.addToolCallResponse([{
            id: 'tc-write',
            name: 'write_file',
            arguments: { path: '/tmp/test-write.txt', content: 'hello' },
        }]);
        mockServer.addTextResponse('Done writing.');

        const configWithBlocked = makeConfig();
        configWithBlocked.permissions.blockedTools = ['write_file'];

        const config = makeEngineConfig(projection, {
            resolvedConfig: configWithBlocked,
        });

        const result = await engine.executeTurn(config, 'write a file', []);

        // Tool should be denied by approval flow (step 1: blocked tool)
        const toolResults = result.items.filter(i => i.kind === 'tool_result') as ToolResultItem[];
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.status).toBe('error');
        expect(toolResults[0].output.error?.code).toBe('tool.permission');
    });

    it('T2: approval flow prompts for workspace-write and user can deny', async () => {
        const projection = sm.create(process.cwd());
        const registry = new ToolRegistry();
        registry.register(writeFileSpec, writeFileImpl);
        const engine = makeEngine(projection, registry);

        mockServer.reset();
        mockServer.addToolCallResponse([{
            id: 'tc-write2',
            name: 'write_file',
            arguments: { path: join(process.cwd(), 'test-output.txt'), content: 'hello' },
        }]);
        mockServer.addTextResponse('File denied.');

        const config = makeEngineConfig(projection, {
            promptUser: async () => 'n', // User denies
        });

        const result = await engine.executeTurn(config, 'write a file', []);

        const toolResults = result.items.filter(i => i.kind === 'tool_result') as ToolResultItem[];
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.status).toBe('error');
        expect(toolResults[0].output.error?.message).toContain('denied');
    });

    it('T3: approval flow auto-approves with autoConfirm=true', async () => {
        const projection = sm.create(process.cwd());
        const registry = new ToolRegistry();
        registry.register(readFileSpec, readFileImpl);
        const engine = makeEngine(projection, registry);

        mockServer.reset();
        mockServer.addToolCallResponse([{
            id: 'tc-read',
            name: 'read_file',
            arguments: { path: FIXTURE_PATH },
        }]);
        mockServer.addTextResponse('File contents read successfully.');

        const config = makeEngineConfig(projection, {
            autoConfirm: true,
        });

        const result = await engine.executeTurn(config, 'read a file', []);

        // read_file is read-only class → auto-approved
        const toolResults = result.items.filter(i => i.kind === 'tool_result') as ToolResultItem[];
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.status).toBe('success');
    });

    it('T4: sandbox denies path outside workspace via tool execution', async () => {
        const projection = sm.create(process.cwd());
        const registry = new ToolRegistry();
        registry.register(readFileSpec, readFileImpl);
        const engine = makeEngine(projection, registry);

        mockServer.reset();
        mockServer.addToolCallResponse([{
            id: 'tc-read-oob',
            name: 'read_file',
            arguments: { path: '/etc/passwd' },
        }]);
        mockServer.addTextResponse('Could not read the file.');

        const config = makeEngineConfig(projection);

        const result = await engine.executeTurn(config, 'read /etc/passwd', []);

        // checkZone inside read_file blocks out-of-zone paths
        const toolResults = result.items.filter(i => i.kind === 'tool_result') as ToolResultItem[];
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.status).toBe('error');
        expect(toolResults[0].output.error?.code).toBe('tool.sandbox');
    });

    it('T5: network policy denies shell network commands when mode=off', async () => {
        const projection = sm.create(process.cwd());
        const registry = new ToolRegistry();
        registry.register(execCommandSpec, execCommandImpl);

        const networkPolicy: NetworkPolicy = {
            mode: 'off',
            allowDomains: [],
            denyDomains: [],
            allowHttp: false,
        };
        const engine = makeEngine(projection, registry, { networkPolicy });

        mockServer.reset();
        mockServer.addToolCallResponse([{
            id: 'tc-curl',
            name: 'exec_command',
            arguments: { command: 'curl https://example.com' },
        }]);
        mockServer.addTextResponse('Network denied.');

        // autoConfirm=true so the approval flow auto-approves the external-effect class,
        // allowing the ToolRunner's network policy check to run.
        const config = makeEngineConfig(projection, { autoConfirm: true });

        const result = await engine.executeTurn(config, 'curl example.com', []);

        const toolResults = result.items.filter(i => i.kind === 'tool_result') as ToolResultItem[];
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0].output.status).toBe('error');
        expect(toolResults[0].output.error?.code).toBe('tool.permission');
    });

    it('T6: ProviderRegistry resolves models by priority', () => {
        const registry = new ProviderRegistry();
        const driver1 = new NanoGptDriver({ apiKey: 'k1', baseUrl: mockServer.baseUrl });
        const driver2 = new NanoGptDriver({ apiKey: 'k2', baseUrl: mockServer.baseUrl });

        registry.register(driver1, {
            name: 'primary',
            driver: 'nanogpt',
            baseUrl: mockServer.baseUrl,
            timeout: 30000,
            priority: 1,
        });
        registry.register(driver2, {
            name: 'secondary',
            driver: 'nanogpt',
            baseUrl: mockServer.baseUrl,
            timeout: 30000,
            priority: 2,
        });

        // Both drivers support the same models — higher priority wins
        const resolved = registry.resolve('qwen/qwen3-coder');
        expect(resolved).toBeDefined();
        expect(resolved!.config.name).toBe('primary');
    });

    it('T7: session persistence after a turn', async () => {
        const projection = sm.create(process.cwd());
        const registry = new ToolRegistry();
        registry.register(readFileSpec, readFileImpl);
        const engine = makeEngine(projection, registry);

        mockServer.reset();
        mockServer.addTextResponse('Hello from the assistant!');

        const config = makeEngineConfig(projection, { autoConfirm: true });

        const result = await engine.executeTurn(config, 'say hello', []);

        expect(result.turn.outcome).toBe('assistant_final');

        // Persist manifest
        projection.manifest.turnCount = 1;
        projection.manifest.lastActivityTimestamp = new Date().toISOString();
        sm.saveManifest(projection);

        // Verify conversation.jsonl exists and is parseable
        const convPath = join(projection.sessionDir, 'conversation.jsonl');
        expect(existsSync(convPath)).toBe(true);
        const lines = readFileSync(convPath, 'utf-8').trim().split('\n');
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            expect(() => JSON.parse(line)).not.toThrow();
        }

        // Verify manifest was persisted
        const loaded = sm.load(projection.manifest.sessionId);
        expect(loaded.manifest.turnCount).toBe(1);
    });

    it('T8: session grants persist across tool calls within a turn', async () => {
        const projection = sm.create(process.cwd());
        const registry = new ToolRegistry();
        registry.register(writeFileSpec, writeFileImpl);
        const engine = makeEngine(projection, registry);

        const sessionGrants = new SessionGrantStore();
        // Pre-grant write_file
        sessionGrants.addGrant('write_file');

        mockServer.reset();
        mockServer.addToolCallResponse([{
            id: 'tc-write-granted',
            name: 'write_file',
            arguments: { path: join(process.cwd(), 'test-grant-output.txt'), content: 'granted' },
        }]);
        mockServer.addTextResponse('Written with grant.');

        const config = makeEngineConfig(projection, {
            sessionGrants,
            // No promptUser — should auto-approve via session grant
        });

        const result = await engine.executeTurn(config, 'write a file', []);

        const toolResults = result.items.filter(i => i.kind === 'tool_result') as ToolResultItem[];
        expect(toolResults).toHaveLength(1);
        // Session grant allows write_file without prompting
        expect(toolResults[0].output.status).toBe('success');

        // Cleanup created file
        const outPath = join(process.cwd(), 'test-grant-output.txt');
        if (existsSync(outPath)) rmSync(outPath);
    });
});
