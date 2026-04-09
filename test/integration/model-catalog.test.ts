/**
 * M11.8 — Model Catalog CLI Wiring Integration Tests
 *
 * Verifies end-to-end catalog wiring:
 *   T1: NanoGptCatalog → NanoGptDriver → correct capabilities
 *   T2: StaticCatalog fallback when API unreachable
 *   T3: Driver uses catalog maxOutputTokens in request body
 *   T4: Invoke prompt assembly includes workspace context (M11.6 verify)
 *   T5: Peer agent profiles grant full tool access (M11.7 verify)
 *   T6: Catalog logs model limits at verbose level
 */

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import { NanoGptDriver } from '../../src/providers/nanogpt-driver.js';
import { NanoGptCatalog, StaticCatalog } from '../../src/providers/model-catalog.js';
import { AgentRegistry } from '../../src/delegation/agent-registry.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolSpec, ToolImplementation } from '../../src/tools/tool-registry.js';
import { buildInvokeSystemMessages } from '../../src/core/prompt-assembly.js';
import { createServer, type Server } from 'node:http';

// --- Mock NanoGPT models API server ---

const MOCK_MODELS = [
    {
        id: 'qwen/qwen3-coder',
        context_length: 262000,
        max_output_tokens: 65536,
        capabilities: { vision: false, tool_calling: true, reasoning: false, structured_output: true },
        pricing: { input: 0, output: 0 },
    },
    {
        id: 'minimax/minimax-m2.7',
        context_length: 204800,
        max_output_tokens: 131072,
        capabilities: { vision: false, tool_calling: true, reasoning: false, structured_output: false },
        pricing: { input: 0.5, output: 1.0 },
    },
];

let mockModelsServer: Server;
let mockModelsPort: number;

async function startMockModelsServer(): Promise<void> {
    return new Promise((resolve) => {
        mockModelsServer = createServer((req, res) => {
            if (req.url?.includes('/models')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ data: MOCK_MODELS }));
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        mockModelsServer.listen(0, '127.0.0.1', () => {
            const addr = mockModelsServer.address();
            if (addr && typeof addr === 'object') {
                mockModelsPort = addr.port;
            }
            resolve();
        });
    });
}

async function stopMockModelsServer(): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!mockModelsServer) { resolve(); return; }
        mockModelsServer.close((err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

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

describe('M11.8 Model Catalog Wiring', () => {
    beforeAll(async () => {
        await startMockModelsServer();
    });

    afterAll(async () => {
        await stopMockModelsServer();
    });

    it('T1: NanoGptCatalog feeds live limits into NanoGptDriver.capabilities()', async () => {
        const catalog = new NanoGptCatalog({
            apiKey: 'test-key',
            baseUrl: `http://127.0.0.1:${mockModelsPort}`,
        });
        await catalog.fetch();

        const driver = new NanoGptDriver({
            apiKey: 'test-key',
            catalog,
        });

        const caps = driver.capabilities('qwen/qwen3-coder');
        expect(caps.maxContext).toBe(262000);
        expect(caps.maxOutput).toBe(65536);
        expect(caps.supportsTools).not.toBe('none');

        const minimax = driver.capabilities('minimax/minimax-m2.7');
        expect(minimax.maxContext).toBe(204800);
        expect(minimax.maxOutput).toBe(131072);
    });

    it('T2: StaticCatalog fallback when API unreachable', async () => {
        const catalog = new NanoGptCatalog({
            apiKey: 'test-key',
            baseUrl: 'http://127.0.0.1:1', // unreachable port
            timeout: 500,
            fallback: new StaticCatalog(),
        });
        await catalog.fetch();

        // Should have fallen back to static catalog
        expect(catalog.isLoaded).toBe(true);

        const driver = new NanoGptDriver({
            apiKey: 'test-key',
            catalog,
        });

        // Static catalog has known models — should return their static limits
        const caps = driver.capabilities('gpt-4o');
        expect(caps.maxContext).toBeGreaterThan(0);
        expect(caps.maxOutput).toBeGreaterThan(0);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('T3: driver uses catalog maxOutputTokens in request body', async () => {
        const catalog = new NanoGptCatalog({
            apiKey: 'test-key',
            baseUrl: `http://127.0.0.1:${mockModelsPort}`,
        });
        await catalog.fetch();

        let capturedBody: Record<string, unknown> | null = null;

        const driver = new NanoGptDriver({
            apiKey: 'test-key',
            baseUrl: `http://127.0.0.1:${mockModelsPort}`,
            catalog,
        });

        // Intercept fetch via vi.spyOn — restored by afterEach
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : input.toString();
                if (url.includes('/chat/completions')) {
                    capturedBody = JSON.parse(init?.body as string);
                    const body = new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                            controller.close();
                        },
                    });
                    return new Response(body, {
                        status: 200,
                        headers: { 'Content-Type': 'text/event-stream' },
                    });
                }
                return fetch(input, init);
            },
        );

        const gen = driver.stream({
            model: 'qwen/qwen3-coder',
            messages: [{ role: 'user', content: 'hello' }],
            maxTokens: 4096, // caller requests 4096
            temperature: 0.7,
        });
        for await (const _event of gen) { /* drain */ }

        expect(capturedBody).not.toBeNull();
        // The catalog says qwen3-coder has 65536 max output — driver should use that
        expect(capturedBody!.max_tokens).toBe(65536);
        expect(fetchSpy).toHaveBeenCalled();
    });

    it('T4: invoke prompt assembly includes workspace context', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/home/user/myproject',
            toolNames: ['read_file', 'write_file', 'exec_command'],
            projectSnapshot: {
                root: '/home/user/myproject',
                stack: ['Node', 'TypeScript'],
                git: { branch: 'main', status: 'clean', staged: false },
                ignorePaths: [],
                indexStatus: 'none',
            },
        });

        expect(msgs.length).toBeGreaterThan(0);
        const content = msgs[0].content as string;
        expect(content).toContain('/home/user/myproject');
        expect(content).toContain('Node');
        expect(content).toContain('TypeScript');
        expect(content).toContain('read_file');
        expect(content).toContain('write_file');
        expect(content).toContain('exec_command');
        expect(content).toContain('main'); // git branch
    });

    it('T5: peer agent profiles grant full tool access (M11.7)', () => {
        const registry = new ToolRegistry();

        // Register a representative set of tools
        const toolNames = [
            'read_file', 'write_file', 'edit_file', 'delete_path', 'move_path',
            'make_directory', 'stat_path', 'find_paths', 'search_text',
            'exec_command', 'open_session', 'session_io', 'close_session',
            'search_semantic', 'fetch_url', 'web_search', 'lookup_docs',
            'lsp_query', 'estimate_tokens',
            'browser_navigate', 'browser_click', 'browser_type', 'browser_press',
            'browser_snapshot', 'browser_screenshot', 'browser_evaluate',
            'browser_extract', 'browser_wait', 'browser_close',
            'spawn_agent', 'message_agent', 'await_agent',
            'ask_user', 'confirm_action',
        ];

        for (const name of toolNames) {
            const approvalClass = ['write_file', 'edit_file', 'delete_path', 'move_path', 'make_directory']
                .includes(name) ? 'workspace-write' as const
                : ['ask_user', 'confirm_action'].includes(name) ? 'user-facing' as const
                : ['exec_command', 'open_session', 'session_io', 'close_session',
                   'fetch_url', 'web_search', 'lookup_docs', 'spawn_agent',
                   'browser_navigate', 'browser_click', 'browser_type', 'browser_press',
                   'browser_snapshot', 'browser_screenshot', 'browser_evaluate',
                   'browser_extract', 'browser_wait', 'browser_close']
                    .includes(name) ? 'external-effect' as const
                : 'read-only' as const;
            registry.register(makeToolSpec(name, approvalClass), noopImpl);
        }

        const result = AgentRegistry.resolve(registry);
        const agentRegistry = result.registry;

        // Coder profile should have all tools minus user-facing
        const coder = agentRegistry.getProfile('coder');
        expect(coder).toBeDefined();
        expect(coder!.defaultTools).toContain('read_file');
        expect(coder!.defaultTools).toContain('write_file');
        expect(coder!.defaultTools).toContain('exec_command');
        expect(coder!.defaultTools).toContain('search_semantic');
        expect(coder!.defaultTools).toContain('browser_navigate');
        expect(coder!.defaultTools).toContain('spawn_agent');
        expect(coder!.defaultTools).toContain('message_agent');
        expect(coder!.defaultTools).toContain('await_agent');
        expect(coder!.defaultTools).not.toContain('ask_user');

        // Witness profile should have non-mutating tools
        const witness = agentRegistry.getProfile('witness');
        expect(witness).toBeDefined();
        expect(witness!.defaultTools).toContain('read_file');
        expect(witness!.defaultTools).toContain('search_semantic');
        expect(witness!.defaultTools).toContain('fetch_url');
        expect(witness!.defaultTools).toContain('web_search');
        expect(witness!.defaultTools).toContain('lsp_query');
        expect(witness!.defaultTools).not.toContain('spawn_agent');
    });

    it('T6: catalog getModel returns null for unknown models (driver falls back to static)', async () => {
        const catalog = new NanoGptCatalog({
            apiKey: 'test-key',
            baseUrl: `http://127.0.0.1:${mockModelsPort}`,
        });
        await catalog.fetch();

        // Model not in the mock API
        expect(catalog.getModel('nonexistent/model')).toBeNull();

        // Driver should still return defaults from static registry
        const driver = new NanoGptDriver({
            apiKey: 'test-key',
            catalog,
        });
        const caps = driver.capabilities('nonexistent/model');
        // Should get default capabilities (not throw)
        expect(caps.maxContext).toBeGreaterThan(0);
    });
});
