import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnEngine } from '../../src/core/turn-engine.js';
import type { TurnEngineConfig } from '../../src/core/turn-engine.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { readFileSpec, readFileImpl } from '../../src/tools/read-file.js';
import { buildInvokeSystemMessages } from '../../src/core/prompt-assembly.js';
import type { ConversationWriter } from '../../src/core/conversation-writer.js';
import { SequenceGenerator } from '../../src/types/sequence.js';
import type { ProviderDriver, ModelRequest, StreamEvent, ProviderConfig } from '../../src/types/provider.js';
import type { SessionId } from '../../src/types/ids.js';
import { SessionGrantStore } from '../../src/permissions/session-grants.js';

// --- Mock provider that captures the request ---

function createCapturingDriver(): {
    driver: ProviderDriver;
    capturedRequests: ModelRequest[];
} {
    const capturedRequests: ModelRequest[] = [];

    const driver: ProviderDriver = {
        validate(_config: ProviderConfig) {
            return { ok: true as const, value: undefined };
        },
        capabilities(_model: string) {
            return {
                maxContext: 128000,
                maxOutput: 4096,
                supportsTools: 'native' as const,
                supportsVision: false,
                supportsStreaming: true,
                supportsPrefill: false,
                supportsEmbedding: false,
                embeddingModels: [],
                toolReliability: 'native' as const,
                costPerMillion: { input: 0, output: 0 },
                specialFeatures: [],
                bytesPerToken: 4,
            };
        },
        async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
            capturedRequests.push(request);
            yield { type: 'text_delta', text: 'done' };
            yield {
                type: 'done',
                finishReason: 'stop',
                usage: { inputTokens: 10, outputTokens: 2 },
            };
        },
    };

    return { driver, capturedRequests };
}

function createMockWriter(): ConversationWriter {
    return {
        writeTurn: vi.fn(),
        writeItem: vi.fn(),
        writeStep: vi.fn(),
        close: vi.fn(),
    } as unknown as ConversationWriter;
}

describe('Invoke Prompt Assembly Integration', () => {
    let toolRegistry: ToolRegistry;

    beforeEach(() => {
        toolRegistry = new ToolRegistry();
        toolRegistry.register(readFileSpec, readFileImpl);
    });

    it('TurnEngine uses custom systemMessages when provided', async () => {
        const { driver, capturedRequests } = createCapturingDriver();

        const engine = new TurnEngine(
            driver,
            toolRegistry,
            createMockWriter(),
            new SequenceGenerator(),
        );

        const systemMessages = buildInvokeSystemMessages({
            cwd: '/test/project',
            toolNames: ['read_file'],
            projectSnapshot: {
                root: '/test/project',
                stack: ['Node', 'TypeScript'],
                git: { branch: 'main', status: 'clean', staged: false },
                ignorePaths: [],
                indexStatus: 'none',
            },
        });

        const config: TurnEngineConfig = {
            sessionId: 'ses_test123' as SessionId,
            model: 'test-model',
            provider: 'test',
            interactive: false,
            autoConfirm: true,
            isSubAgent: true,
            workspaceRoot: '/test/project',
            sessionGrants: new SessionGrantStore(),
            systemMessages,
        };

        await engine.executeTurn(config, 'Hello', []);

        // Verify the LLM received our custom system messages, not the default
        expect(capturedRequests).toHaveLength(1);
        const request = capturedRequests[0];
        const systemMsg = request.messages[0];
        expect(systemMsg.role).toBe('system');
        const content = systemMsg.content as string;
        expect(content).toContain('ACA');
        expect(content).toContain('Working directory: /test/project');
        expect(content).toContain('Stack: Node, TypeScript');
        expect(content).toContain('read_file');
        // The default MUST NOT appear anywhere in ANY message — it's replaced, not appended
        const allContent = JSON.stringify(request.messages);
        expect(allContent).not.toContain('You are a helpful coding assistant.');
    });

    it('TurnEngine falls back to default when systemMessages not set', async () => {
        const { driver, capturedRequests } = createCapturingDriver();

        const engine = new TurnEngine(
            driver,
            toolRegistry,
            createMockWriter(),
            new SequenceGenerator(),
        );

        const config: TurnEngineConfig = {
            sessionId: 'ses_test456' as SessionId,
            model: 'test-model',
            provider: 'test',
            interactive: false,
            autoConfirm: true,
            isSubAgent: false,
            workspaceRoot: '/test',
            sessionGrants: new SessionGrantStore(),
        };

        await engine.executeTurn(config, 'Hello', []);

        expect(capturedRequests).toHaveLength(1);
        const request = capturedRequests[0];
        const systemMsg = request.messages[0];
        const content = systemMsg.content as string;
        expect(content).toBe('You are a helpful coding assistant.');
    });

    it('invoke system prompt includes all tool names', () => {
        const toolNames = ['read_file', 'write_file', 'edit_file', 'exec_command', 'search_text'];

        const msgs = buildInvokeSystemMessages({
            cwd: '/workspace',
            toolNames,
        });

        const content = msgs[0].content as string;
        for (const name of toolNames) {
            expect(content).toContain(name);
        }
        expect(content).toContain(`Available tools (${toolNames.length})`);
    });
});
