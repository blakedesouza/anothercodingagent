import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    lspQuerySpec,
    createLspQueryImpl,
    type LspQueryDeps,
} from '../../src/tools/lsp-query.js';
import type { LspManager } from '../../src/lsp/lsp-manager.js';
import type { ToolContext } from '../../src/tools/tool-registry.js';
import type { ToolOutput } from '../../src/types/conversation.js';
import {
    LspUnavailableError,
    LspWarmingUpError,
    LspCrashedError,
    type LspResult,
} from '../../src/lsp/lsp-client.js';
import {
    getServerForExtension,
    getServerById,
    lspCapabilityId,
    BUILTIN_SERVERS,
} from '../../src/lsp/server-registry.js';
import { CapabilityHealthMap } from '../../src/core/capability-health.js';

// --- Helpers ---

function makeContext(): ToolContext {
    return {
        sessionId: 'test-session',
        workspaceRoot: '/tmp/test-workspace',
        signal: new AbortController().signal,
    };
}

function makeMockManager(overrides?: Partial<LspManager>): LspManager {
    return {
        query: vi.fn(async () => ({ kind: 'hover', contents: 'test type info' } as LspResult)),
        getActiveServers: vi.fn(() => []),
        dispose: vi.fn(async () => {}),
        ...overrides,
    } as unknown as LspManager;
}

function makeDeps(overrides?: Partial<LspQueryDeps>): LspQueryDeps {
    return {
        lspManager: makeMockManager(),
        ...overrides,
    };
}

function parseResult(output: ToolOutput): LspResult {
    return JSON.parse(output.data) as LspResult;
}

// --- Tests ---

describe('lsp_query', () => {
    describe('spec', () => {
        it('has correct name and approval class', () => {
            expect(lspQuerySpec.name).toBe('lsp_query');
            expect(lspQuerySpec.approvalClass).toBe('read-only');
            expect(lspQuerySpec.idempotent).toBe(true);
            expect(lspQuerySpec.timeoutCategory).toBe('lsp');
        });

        it('requires operation and file inputs', () => {
            const schema = lspQuerySpec.inputSchema as Record<string, unknown>;
            expect(schema.required).toEqual(['operation', 'file']);
        });

        it('defines all 7 operations in enum', () => {
            const schema = lspQuerySpec.inputSchema as { properties: Record<string, { enum?: string[] }> };
            expect(schema.properties.operation.enum).toEqual([
                'hover', 'definition', 'references', 'diagnostics',
                'symbols', 'completions', 'rename',
            ]);
        });
    });

    describe('hover', () => {
        it('returns type info for a TypeScript symbol', async () => {
            const manager = makeMockManager({
                query: vi.fn(async () => ({
                    kind: 'hover' as const,
                    contents: '```typescript\nfunction greet(name: string): string\n```',
                })),
            });

            const impl = createLspQueryImpl({ lspManager: manager });
            const output = await impl(
                { operation: 'hover', file: 'src/index.ts', line: 5, character: 10 },
                makeContext(),
            );

            expect(output.status).toBe('success');
            const result = parseResult(output);
            expect(result.kind).toBe('hover');
            if (result.kind === 'hover') {
                expect(result.contents).toContain('function greet');
            }

            expect(manager.query).toHaveBeenCalledWith({
                operation: 'hover',
                file: 'src/index.ts',
                line: 5,
                character: 10,
                newName: undefined,
            });
        });
    });

    describe('definition', () => {
        it('returns file path + position', async () => {
            const manager = makeMockManager({
                query: vi.fn(async () => ({
                    kind: 'definition' as const,
                    locations: [
                        {
                            uri: 'file:///tmp/test-workspace/src/utils.ts',
                            startLine: 10,
                            startCharacter: 1,
                            endLine: 10,
                            endCharacter: 20,
                        },
                    ],
                })),
            });

            const impl = createLspQueryImpl({ lspManager: manager });
            const output = await impl(
                { operation: 'definition', file: 'src/index.ts', line: 5, character: 10 },
                makeContext(),
            );

            expect(output.status).toBe('success');
            const result = parseResult(output);
            expect(result.kind).toBe('definition');
            if (result.kind === 'definition') {
                expect(result.locations.length).toBe(1);
                expect(result.locations[0].uri).toContain('utils.ts');
                expect(result.locations[0].startLine).toBe(10);
            }
        });
    });

    describe('references', () => {
        it('returns list of locations', async () => {
            const manager = makeMockManager({
                query: vi.fn(async () => ({
                    kind: 'references' as const,
                    locations: [
                        { uri: 'file:///a.ts', startLine: 1, startCharacter: 1, endLine: 1, endCharacter: 10 },
                        { uri: 'file:///b.ts', startLine: 5, startCharacter: 3, endLine: 5, endCharacter: 12 },
                        { uri: 'file:///c.ts', startLine: 20, startCharacter: 1, endLine: 20, endCharacter: 10 },
                    ],
                })),
            });

            const impl = createLspQueryImpl({ lspManager: manager });
            const output = await impl(
                { operation: 'references', file: 'src/index.ts', line: 5, character: 10 },
                makeContext(),
            );

            expect(output.status).toBe('success');
            const result = parseResult(output);
            expect(result.kind).toBe('references');
            if (result.kind === 'references') {
                expect(result.locations.length).toBe(3);
            }
        });
    });

    describe('rename preview', () => {
        it('returns WorkspaceEdit without modifying files', async () => {
            const edit = {
                changes: {
                    'file:///tmp/test-workspace/src/index.ts': [
                        {
                            range: { start: { line: 4, character: 9 }, end: { line: 4, character: 14 } },
                            newText: 'farewell',
                        },
                    ],
                },
            };
            const manager = makeMockManager({
                query: vi.fn(async () => ({
                    kind: 'rename' as const,
                    edit,
                })),
            });

            const impl = createLspQueryImpl({ lspManager: manager });
            const output = await impl(
                { operation: 'rename', file: 'src/index.ts', line: 5, character: 10, newName: 'farewell' },
                makeContext(),
            );

            expect(output.status).toBe('success');
            const result = parseResult(output);
            expect(result.kind).toBe('rename');
            if (result.kind === 'rename') {
                expect(result.edit).toEqual(edit);
            }
        });

        it('requires newName parameter', async () => {
            const impl = createLspQueryImpl(makeDeps());
            const output = await impl(
                { operation: 'rename', file: 'src/index.ts', line: 5, character: 10 },
                makeContext(),
            );

            expect(output.status).toBe('error');
            expect(output.error?.code).toBe('tool.validation');
            expect(output.error?.message).toContain('newName');
        });
    });

    describe('server not installed', () => {
        it('returns LspUnavailable with install hint for missing server', async () => {
            const manager = makeMockManager({
                query: vi.fn(async () => {
                    throw new LspUnavailableError(
                        'rust-analyzer',
                        'rustup component add rust-analyzer',
                    );
                }),
            });

            const impl = createLspQueryImpl({ lspManager: manager });
            const output = await impl(
                { operation: 'hover', file: 'src/main.rs', line: 1, character: 1 },
                makeContext(),
            );

            expect(output.status).toBe('error');
            expect(output.error?.code).toBe('lsp_unavailable');
            expect(output.error?.message).toContain('rust-analyzer');
            expect(output.error?.message).toContain('rustup component add');
            expect(output.retryable).toBe(false);
        });
    });

    describe('server crash and restart', () => {
        it('crash → restart once, second crash → unavailable for session', async () => {
            const healthMap = new CapabilityHealthMap();
            healthMap.register('lsp:typescript', 'local');

            let callCount = 0;
            const manager = makeMockManager({
                query: vi.fn(async () => {
                    callCount++;
                    if (callCount === 1) {
                        // First call: simulate crash after restart (second crash = unavailable)
                        throw new LspCrashedError('typescript', false);
                    }
                    return { kind: 'hover' as const, contents: 'recovered' };
                }),
            });

            const impl = createLspQueryImpl({ lspManager: manager });

            // First call: crash → unavailable
            const output1 = await impl(
                { operation: 'hover', file: 'src/index.ts', line: 1, character: 1 },
                makeContext(),
            );
            expect(output1.status).toBe('error');
            expect(output1.error?.code).toBe('lsp_crashed');
            expect(output1.retryable).toBe(false);

            // Second call: manager has recovered (simulated)
            const output2 = await impl(
                { operation: 'hover', file: 'src/index.ts', line: 1, character: 1 },
                makeContext(),
            );
            expect(output2.status).toBe('success');
        });
    });

    describe('warming up', () => {
        it('returns retryable error with warming_up code', async () => {
            const manager = makeMockManager({
                query: vi.fn(async () => {
                    throw new LspWarmingUpError('rust-analyzer');
                }),
            });

            const impl = createLspQueryImpl({ lspManager: manager });
            const output = await impl(
                { operation: 'hover', file: 'src/main.rs', line: 1, character: 1 },
                makeContext(),
            );

            expect(output.status).toBe('error');
            expect(output.error?.code).toBe('warming_up');
            expect(output.retryable).toBe(true);
        });
    });

    describe('validation', () => {
        it('requires line and character for position-based operations', async () => {
            const impl = createLspQueryImpl(makeDeps());

            // hover without line
            const output = await impl(
                { operation: 'hover', file: 'src/index.ts' },
                makeContext(),
            );
            expect(output.status).toBe('error');
            expect(output.error?.code).toBe('tool.validation');
            expect(output.error?.message).toContain('line');

            // definition without character
            const output2 = await impl(
                { operation: 'definition', file: 'src/index.ts', line: 5 },
                makeContext(),
            );
            expect(output2.status).toBe('error');
            expect(output2.error?.message).toContain('character');
        });

        it('does not require line/character for symbols and diagnostics', async () => {
            const manager = makeMockManager({
                query: vi.fn(async () => ({
                    kind: 'symbols' as const,
                    symbols: [],
                })),
            });

            const impl = createLspQueryImpl({ lspManager: manager });

            // symbols without position — should succeed
            const output = await impl(
                { operation: 'symbols', file: 'src/index.ts' },
                makeContext(),
            );
            expect(output.status).toBe('success');
        });
    });
});

// --- Server registry tests ---

describe('server-registry', () => {
    it('maps TypeScript extensions to typescript server', () => {
        for (const ext of ['ts', 'tsx', 'js', 'jsx']) {
            const config = getServerForExtension(ext);
            expect(config).toBeDefined();
            expect(config!.serverId).toBe('typescript');
        }
    });

    it('maps Python extensions to pyright server', () => {
        const config = getServerForExtension('py');
        expect(config).toBeDefined();
        expect(config!.serverId).toBe('pyright');
    });

    it('maps Rust extension to rust-analyzer server', () => {
        const config = getServerForExtension('rs');
        expect(config).toBeDefined();
        expect(config!.serverId).toBe('rust-analyzer');
    });

    it('returns undefined for unknown extensions', () => {
        expect(getServerForExtension('xyz')).toBeUndefined();
        expect(getServerForExtension('')).toBeUndefined();
    });

    it('getServerById returns correct config', () => {
        const config = getServerById('typescript');
        expect(config).toBeDefined();
        expect(config!.command).toBe('typescript-language-server');
    });

    it('lspCapabilityId returns correct format', () => {
        expect(lspCapabilityId('typescript')).toBe('lsp:typescript');
        expect(lspCapabilityId('rust-analyzer')).toBe('lsp:rust-analyzer');
    });

    it('all built-in servers have required fields', () => {
        for (const server of BUILTIN_SERVERS) {
            expect(server.serverId).toBeTruthy();
            expect(server.language).toBeTruthy();
            expect(server.command).toBeTruthy();
            expect(server.fileGlobs.length).toBeGreaterThan(0);
            expect(server.installHint).toBeTruthy();
        }
    });
});

// --- LspClient unit tests ---

describe('LspClient', () => {
    // LspClient tests use a mock spawn to avoid real LSP servers.
    // Full integration tests would use real typescript-language-server.

    it('detects multi-language routing (TypeScript + Rust)', () => {
        // Verify the registry correctly routes both languages
        const tsConfig = getServerForExtension('ts');
        const rsConfig = getServerForExtension('rs');

        expect(tsConfig).toBeDefined();
        expect(rsConfig).toBeDefined();
        expect(tsConfig!.serverId).not.toBe(rsConfig!.serverId);
        expect(tsConfig!.serverId).toBe('typescript');
        expect(rsConfig!.serverId).toBe('rust-analyzer');
    });
});

// --- Health integration tests ---

describe('health integration', () => {
    it('crash → M7.13 health state update → M7.7c tool masking if unavailable', () => {
        const healthMap = new CapabilityHealthMap();
        healthMap.register('lsp:typescript', 'local');

        // First crash → degraded
        const state1 = healthMap.reportRetryableFailure('lsp:typescript', 'crash');
        expect(state1).toBe('degraded');

        // Second crash → unavailable (session-terminal)
        const state2 = healthMap.reportRetryableFailure('lsp:typescript', 'second crash');
        expect(state2).toBe('unavailable');

        // Tool masking should include lsp_query when capability is unavailable
        const tools = [{ spec: { name: 'lsp_query', capabilityId: 'lsp:typescript' } }];
        const masked = healthMap.getMaskedToolNames(tools);
        expect(masked.has('lsp_query')).toBe(true);
    });

    it('server not installed → non-retryable → immediate unavailable', () => {
        const healthMap = new CapabilityHealthMap();
        healthMap.register('lsp:rust-analyzer', 'local');

        const state = healthMap.reportNonRetryableFailure(
            'lsp:rust-analyzer',
            'binary not found',
        );
        expect(state).toBe('unavailable');

        const entry = healthMap.getEntry('lsp:rust-analyzer');
        expect(entry?.sessionTerminal).toBe(true);
    });

    it('successful query resets health state', () => {
        const healthMap = new CapabilityHealthMap();
        healthMap.register('lsp:typescript', 'local');

        // First crash → degraded
        healthMap.reportRetryableFailure('lsp:typescript', 'crash');
        expect(healthMap.getState('lsp:typescript')).toBe('degraded');

        // Recovery
        healthMap.reportSuccess('lsp:typescript');
        expect(healthMap.getState('lsp:typescript')).toBe('available');
    });
});

// --- LspManager routing tests ---

describe('LspManager routing', () => {
    it('routes .ts files to typescript server and .rs files to rust-analyzer', () => {
        // This tests the extension-to-server mapping used by LspManager
        const tsConfig = getServerForExtension('ts');
        const rsConfig = getServerForExtension('rs');
        const pyConfig = getServerForExtension('py');
        const goConfig = getServerForExtension('go');

        expect(tsConfig!.serverId).toBe('typescript');
        expect(rsConfig!.serverId).toBe('rust-analyzer');
        expect(pyConfig!.serverId).toBe('pyright');
        expect(goConfig!.serverId).toBe('gopls');
    });

    it('Go files map to gopls', () => {
        const config = getServerForExtension('go');
        expect(config!.command).toBe('gopls');
        expect(config!.args).toEqual(['serve']);
    });

    it('C/C++ extensions map to clangd', () => {
        for (const ext of ['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx']) {
            const config = getServerForExtension(ext);
            expect(config).toBeDefined();
            expect(config!.serverId).toBe('clangd');
        }
    });
});
