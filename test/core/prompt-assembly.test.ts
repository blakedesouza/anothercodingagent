import { describe, it, expect } from 'vitest';
import {
    assemblePrompt,
    preparePrompt,
    buildContextBlock,
    buildToolDefinitions,
    buildConversationMessages,
    buildInvokeSystemMessages,
    buildAnalyticalSystemMessages,
    buildSynthesisSystemMessages,
    buildSystemMessagesForTier,
} from '../../src/core/prompt-assembly.js';
import type { PromptAssemblyOptions, CapabilityHealth, WorkingSetEntry, DurableTaskSummary } from '../../src/core/prompt-assembly.js';
import type { ConversationItem, MessageItem, ToolResultItem } from '../../src/types/conversation.js';
import type { RegisteredTool } from '../../src/tools/tool-registry.js';
import type { ItemId, ToolCallId } from '../../src/types/ids.js';

// --- Test helpers ---

function makeUserMessage(text: string, seq: number): MessageItem {
    return {
        kind: 'message',
        id: `item_${seq}` as ItemId,
        seq,
        role: 'user',
        parts: [{ type: 'text', text }],
        timestamp: new Date().toISOString(),
    };
}

function makeAssistantMessage(text: string, seq: number): MessageItem {
    return {
        kind: 'message',
        id: `item_${seq}` as ItemId,
        seq,
        role: 'assistant',
        parts: [{ type: 'text', text }],
        timestamp: new Date().toISOString(),
    };
}

function makeAssistantToolCall(
    toolName: string,
    args: Record<string, unknown>,
    seq: number,
    toolCallId?: string,
): MessageItem {
    return {
        kind: 'message',
        id: `item_${seq}` as ItemId,
        seq,
        role: 'assistant',
        parts: [{
            type: 'tool_call',
            toolCallId: (toolCallId ?? `tc_${seq}`) as ToolCallId,
            toolName,
            arguments: args,
        }],
        timestamp: new Date().toISOString(),
    };
}

function makeToolResult(toolName: string, data: string, seq: number, toolCallId?: string): ToolResultItem {
    return {
        kind: 'tool_result',
        id: `item_${seq}` as ItemId,
        seq,
        toolCallId: (toolCallId ?? `tc_${seq}`) as ToolCallId,
        toolName,
        output: {
            status: 'success',
            data,
            truncated: false,
            bytesReturned: data.length,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        },
        timestamp: new Date().toISOString(),
    };
}

function makeTool(name: string, description: string): RegisteredTool {
    return {
        spec: {
            name,
            description,
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
            },
            approvalClass: 'read-only',
            idempotent: true,
            timeoutCategory: 'file',
        },
        impl: async () => ({
            status: 'success' as const,
            data: '',
            truncated: false,
            bytesReturned: 0,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none' as const,
        }),
    };
}

function baseOptions(overrides: Partial<PromptAssemblyOptions> = {}): PromptAssemblyOptions {
    return {
        model: 'test-model',
        tools: [],
        items: [],
        cwd: '/home/user/project',
        shell: 'bash',
        ...overrides,
    };
}

// --- Tests ---

describe('assemblePrompt', () => {
    describe('assemble with no conversation', () => {
        it('returns system + context block + no conversation messages', () => {
            const result = assemblePrompt(baseOptions());

            // Should have exactly 2 messages: system identity + context block
            expect(result.messages).toHaveLength(2);
            expect(result.messages[0].role).toBe('system');
            expect(result.messages[1].role).toBe('system');

            // Layer 1: system identity
            const sysContent = result.messages[0].content as string;
            expect(sysContent).toContain('ACA');
            expect(sysContent).toContain('Instruction precedence');
            expect(sysContent).toContain('Workflow name disambiguation');
            expect(sysContent).toContain('"ACA consult" means use the `aca consult` workflow');
            expect(sysContent).toContain('Bare "ACA" is ambiguous');

            // Layer 3: context block has environment info
            const ctxContent = result.messages[1].content as string;
            expect(ctxContent).toContain('CWD: /home/user/project');
            expect(ctxContent).toContain('Shell: bash');
        });

        it('includes additional system messages ahead of the context block', () => {
            const result = assemblePrompt(baseOptions({
                additionalSystemMessages: [{ role: 'system', content: 'Use simpler tool plans.' }],
            }));

            expect(result.messages).toHaveLength(3);
            expect(result.messages[0].role).toBe('system');
            expect(result.messages[1]).toEqual({ role: 'system', content: 'Use simpler tool plans.' });
            expect(result.messages[2].role).toBe('system');
        });

        it('includes tools when provided', () => {
            const tools = [makeTool('read_file', 'Read a file'), makeTool('write_file', 'Write a file')];
            const result = assemblePrompt(baseOptions({ tools }));

            expect(result.tools).toBeDefined();
            expect(result.tools).toHaveLength(2);
            expect(result.tools![0].name).toBe('read_file');
            expect(result.tools![1].name).toBe('write_file');
        });

        it('omits tools array when no tools registered', () => {
            const result = assemblePrompt(baseOptions({ tools: [] }));
            expect(result.tools).toBeUndefined();
        });
    });

    describe('assemble with 5 turns', () => {
        it('includes all turns in conversation messages', () => {
            const items: ConversationItem[] = [];
            for (let i = 0; i < 5; i++) {
                items.push(makeUserMessage(`Question ${i + 1}`, i * 2 + 1));
                items.push(makeAssistantMessage(`Answer ${i + 1}`, i * 2 + 2));
            }

            const result = assemblePrompt(baseOptions({ items }));

            // 2 system messages + 10 conversation messages (5 user + 5 assistant)
            expect(result.messages).toHaveLength(12);

            // Verify user/assistant alternation
            const convMsgs = result.messages.slice(2);
            for (let i = 0; i < convMsgs.length; i++) {
                expect(convMsgs[i].role).toBe(i % 2 === 0 ? 'user' : 'assistant');
            }
        });

        it('uses visible history so covered items are replaced by summaries', () => {
            const items: ConversationItem[] = [
                makeUserMessage('old question', 1),
                makeAssistantMessage('old answer', 2),
                {
                    kind: 'summary',
                    id: 'item_3' as ItemId,
                    seq: 3,
                    text: 'Summary of the old exchange',
                    coversSeq: { start: 1, end: 2 },
                    timestamp: new Date().toISOString(),
                },
                makeUserMessage('current question', 4),
            ];

            const result = assemblePrompt(baseOptions({ items }));
            const contents = result.messages.map((message) => String(message.content));

            expect(contents.some((content) => content.includes('old question'))).toBe(false);
            expect(contents.some((content) => content.includes('old answer'))).toBe(false);
            expect(contents.some((content) => content.includes('[Summary of earlier conversation]'))).toBe(true);
            expect(contents.some((content) => content.includes('current question'))).toBe(true);
        });
    });

    describe('instruction precedence', () => {
        it('system identity states precedence ordering', () => {
            const result = assemblePrompt(baseOptions());
            const sysContent = result.messages[0].content as string;

            // The system prompt must explicitly state precedence
            expect(sysContent).toContain('Instruction precedence');
            expect(sysContent).toContain('Core system rules');
            expect(sysContent).toContain('Repository/user instruction files');
            expect(sysContent).toContain('Current user request');
            expect(sysContent).toContain('Durable task state');
            expect(sysContent).toContain('Prior conversation context');

            // Verify ordering: core rules (1) before user instructions (2) before user request (3)
            const coreIdx = sysContent.indexOf('1. Core system rules');
            const repoIdx = sysContent.indexOf('2. Repository/user instruction files');
            const reqIdx = sysContent.indexOf('3. Current user request');
            const durableIdx = sysContent.indexOf('4. Durable task state');
            const priorIdx = sysContent.indexOf('5. Prior conversation');
            expect(coreIdx).toBeLessThan(repoIdx);
            expect(repoIdx).toBeLessThan(reqIdx);
            expect(reqIdx).toBeLessThan(durableIdx);
            expect(durableIdx).toBeLessThan(priorIdx);
        });

        it('places user instructions in context block (layer 3), below system identity (layer 1)', () => {
            const result = assemblePrompt(baseOptions({
                userInstructions: 'Always use TypeScript strict mode.',
            }));

            // System identity is message[0], context block is message[1]
            const ctxContent = result.messages[1].content as string;
            expect(ctxContent).toContain('--- Instructions ---');
            expect(ctxContent).toContain('Always use TypeScript strict mode.');
        });
    });

    describe('capability health injection', () => {
        it('includes degraded capability in context block', () => {
            const capabilities: CapabilityHealth[] = [
                { name: 'LSP', status: 'degraded', detail: 'TypeScript server not responding' },
                { name: 'Git', status: 'available' },
            ];

            const result = assemblePrompt(baseOptions({ capabilities }));
            const ctxContent = result.messages[1].content as string;

            expect(ctxContent).toContain('--- Capability Health ---');
            expect(ctxContent).toContain('LSP: degraded — TypeScript server not responding');
            // Available capabilities should NOT appear in health section
            expect(ctxContent).not.toContain('Git: available');
        });

        it('includes unavailable capability in context block', () => {
            const capabilities: CapabilityHealth[] = [
                { name: 'Browser', status: 'unavailable', detail: 'Playwright not installed' },
            ];

            const result = assemblePrompt(baseOptions({ capabilities }));
            const ctxContent = result.messages[1].content as string;

            expect(ctxContent).toContain('Browser: unavailable — Playwright not installed');
        });

        it('omits capability health section when all available', () => {
            const capabilities: CapabilityHealth[] = [
                { name: 'LSP', status: 'available' },
                { name: 'Git', status: 'available' },
            ];

            const result = assemblePrompt(baseOptions({ capabilities }));
            const ctxContent = result.messages[1].content as string;

            expect(ctxContent).not.toContain('Capability Health');
        });
    });

    describe('tool definitions', () => {
        it('all registered tools present in assembled request', () => {
            const tools = [
                makeTool('read_file', 'Read a file from disk'),
                makeTool('write_file', 'Write content to a file'),
                makeTool('exec_command', 'Execute a shell command'),
                makeTool('search_text', 'Search for text in files'),
            ];

            const result = assemblePrompt(baseOptions({ tools }));

            expect(result.tools).toHaveLength(4);
            const names = result.tools!.map(t => t.name);
            expect(names).toEqual(['read_file', 'write_file', 'exec_command', 'search_text']);

            // Each tool should have description and parameters
            for (const def of result.tools!) {
                expect(def.description).toBeTruthy();
                expect(def.parameters).toBeDefined();
                expect(def.parameters.type).toBe('object');
            }
        });
    });

    describe('per-turn context', () => {
        it('project snapshot present in context block', () => {
            const result = assemblePrompt(baseOptions({
                projectSnapshot: {
                    root: '/home/user/project',
                    stack: ['Node', 'TypeScript', 'pnpm'],
                    git: { branch: 'main', status: 'dirty', staged: true },
                    ignorePaths: ['.git/', 'node_modules/'],
                    indexStatus: 'none',
                },
            }));

            const ctxContent = result.messages[1].content as string;
            expect(ctxContent).toContain('--- Project ---');
            expect(ctxContent).toContain('Project root: /home/user/project');
            expect(ctxContent).toContain('Stack: Node, TypeScript, pnpm');
            expect(ctxContent).toContain('branch=main');
            expect(ctxContent).toContain('dirty');
        });

        it('working set present in context block', () => {
            const workingSet: WorkingSetEntry[] = [
                { path: 'src/core/engine.ts', role: 'recently edited' },
                { path: 'test/core/engine.test.ts', role: 'test file' },
            ];

            const result = assemblePrompt(baseOptions({ workingSet }));
            const ctxContent = result.messages[1].content as string;

            expect(ctxContent).toContain('--- Working Set ---');
            expect(ctxContent).toContain('src/core/engine.ts (recently edited)');
            expect(ctxContent).toContain('test/core/engine.test.ts (test file)');
        });

        it('durable task state present in context block', () => {
            const durableTaskState: DurableTaskSummary = {
                goal: 'Implement prompt assembly',
                confirmedFacts: ['4-layer structure', 'instruction precedence'],
                openLoops: ['integration with TurnEngine'],
                blockers: [],
            };

            const result = assemblePrompt(baseOptions({ durableTaskState }));
            const ctxContent = result.messages[1].content as string;

            expect(ctxContent).toContain('--- Task State ---');
            expect(ctxContent).toContain('Goal: Implement prompt assembly');
            expect(ctxContent).toContain('Facts: 4-layer structure; instruction precedence');
            expect(ctxContent).toContain('Open loops: integration with TurnEngine');
            // Empty blockers should not appear
            expect(ctxContent).not.toContain('Blockers:');
        });

        it('all three present together', () => {
            const result = assemblePrompt(baseOptions({
                projectSnapshot: {
                    root: '/proj',
                    stack: ['Rust'],
                    git: { branch: 'dev', status: 'clean', staged: false },
                    ignorePaths: ['.git/'],
                    indexStatus: 'none',
                },
                workingSet: [{ path: 'src/main.rs', role: 'entry point' }],
                durableTaskState: { goal: 'Build parser' },
            }));

            const ctxContent = result.messages[1].content as string;
            expect(ctxContent).toContain('--- Project ---');
            expect(ctxContent).toContain('--- Working Set ---');
            expect(ctxContent).toContain('--- Task State ---');
        });
    });

    describe('active errors (pinned section)', () => {
        it('includes active errors in context block', () => {
            const result = assemblePrompt(baseOptions({
                activeErrors: [
                    'TypeError: Cannot read properties of undefined (reading "name")',
                    'Build failed: src/core/engine.ts(42): missing semicolon',
                ],
            }));

            const ctxContent = result.messages[1].content as string;
            expect(ctxContent).toContain('--- Active Errors ---');
            expect(ctxContent).toContain('- TypeError: Cannot read properties of undefined');
            expect(ctxContent).toContain('- Build failed: src/core/engine.ts(42)');
        });

        it('omits active errors section when no errors', () => {
            const result = assemblePrompt(baseOptions({ activeErrors: [] }));
            const ctxContent = result.messages[1].content as string;
            expect(ctxContent).not.toContain('Active Errors');
        });

        it('places errors before project snapshot (high priority)', () => {
            const result = assemblePrompt(baseOptions({
                activeErrors: ['some error'],
                projectSnapshot: {
                    root: '/proj',
                    stack: ['Node'],
                    git: null,
                    ignorePaths: [],
                    indexStatus: 'none',
                },
            }));

            const ctxContent = result.messages[1].content as string;
            const errIdx = ctxContent.indexOf('--- Active Errors ---');
            const projIdx = ctxContent.indexOf('--- Project ---');
            expect(errIdx).toBeLessThan(projIdx);
        });
    });

    describe('model request structure', () => {
        it('sets model, maxTokens, temperature from options', () => {
            const result = assemblePrompt(baseOptions({
                model: 'nanogpt-4o-mini',
                maxTokens: 8192,
                temperature: 0.3,
            }));

            expect(result.model).toBe('nanogpt-4o-mini');
            expect(result.maxTokens).toBe(8192);
            expect(result.temperature).toBe(0.3);
        });

        it('uses defaults for maxTokens and temperature', () => {
            const result = assemblePrompt(baseOptions());
            expect(result.maxTokens).toBe(4096);
            expect(result.temperature).toBe(0.7);
        });
    });

    describe('live compression integration', () => {
        it('tight context limit activates emergency compression and digesting', () => {
            const items: ConversationItem[] = [
                makeUserMessage('old question 1', 1),
                makeAssistantMessage('old answer 1', 2),
                makeUserMessage('old question 2', 3),
                makeAssistantMessage('old answer 2', 4),
                makeUserMessage('please inspect big.ts', 5),
                makeAssistantToolCall('read_file', { path: '/repo/big.ts', line_start: 1, line_end: 400 }, 6, 'tc_big'),
                makeToolResult(
                    'read_file',
                    JSON.stringify({ totalLines: 400, content: 'x'.repeat(4000) }),
                    7,
                    'tc_big',
                ),
            ];

            const prepared = preparePrompt(baseOptions({
                tools: [makeTool('read_file', 'Read a file from disk. Includes verbose details and examples.')],
                items,
                userInstructions: 'Always preserve formatting.',
                durableTaskState: { goal: 'Fix prompt wiring', openLoops: ['run tests'] },
                projectSnapshot: {
                    root: '/repo',
                    stack: ['TypeScript', 'Vitest'],
                    git: { branch: 'main', status: 'dirty', staged: false },
                    ignorePaths: [],
                    indexStatus: 'ready',
                },
                workingSet: [{ path: 'src/main.ts', role: 'editing' }],
                contextLimit: 1400,
                reservedOutputTokens: 200,
            }));

            expect(prepared.contextStats.compressionTier).toBe('emergency');
            expect(String(prepared.request.messages[1].content)).not.toContain('--- Instructions ---');
            expect(String(prepared.request.messages[1].content)).not.toContain('--- Task State ---');
            expect(prepared.request.tools?.[0]?.description).toBe('');
            expect(
                prepared.request.messages.some(
                    (message) => message.role === 'user' && String(message.content).includes('old question 1'),
                ),
            ).toBe(false);

            const toolMessage = prepared.request.messages.find((message) => message.role === 'tool');
            expect(toolMessage).toBeDefined();
            const parsed = JSON.parse(toolMessage!.content as string);
            expect(parsed.data).toContain('[content omitted');
        });
    });
});

describe('buildContextBlock', () => {
    it('includes OS info', () => {
        const block = buildContextBlock({ cwd: '/tmp' });
        expect(block).toContain('OS:');
        expect(block).toContain('Shell: unknown');
        expect(block).toContain('CWD: /tmp');
    });

    it('omits project section when no snapshot', () => {
        const block = buildContextBlock({ cwd: '/tmp' });
        expect(block).not.toContain('--- Project ---');
    });
});

describe('buildToolDefinitions', () => {
    it('converts registered tools to provider format', () => {
        const tools = [makeTool('test_tool', 'A test tool')];
        const defs = buildToolDefinitions(tools);

        expect(defs).toHaveLength(1);
        expect(defs[0].name).toBe('test_tool');
        expect(defs[0].description).toBe('A test tool');
        expect(defs[0].parameters).toEqual({
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
        });
    });
});

describe('buildConversationMessages', () => {
    it('converts user/assistant message items', () => {
        const items: ConversationItem[] = [
            makeUserMessage('hello', 1),
            makeAssistantMessage('hi there', 2),
        ];

        const msgs = buildConversationMessages(items);
        expect(msgs).toHaveLength(2);
        expect(msgs[0]).toEqual({ role: 'user', content: 'hello' });
        expect(msgs[1]).toEqual({ role: 'assistant', content: 'hi there' });
    });

    it('converts tool result items', () => {
        const items: ConversationItem[] = [
            makeToolResult('read_file', 'file contents here', 3, 'tc_1'),
        ];

        const msgs = buildConversationMessages(items);
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe('tool');
        expect(msgs[0].toolCallId).toBe('tc_1');

        const parsed = JSON.parse(msgs[0].content as string);
        expect(parsed.status).toBe('success');
        expect(parsed.data).toBe('file contents here');
    });

    it('converts assistant messages with tool calls', () => {
        const item: MessageItem = {
            kind: 'message',
            id: 'item_5' as ItemId,
            seq: 5,
            role: 'assistant',
            parts: [
                { type: 'text', text: 'Let me read that file.' },
                {
                    type: 'tool_call',
                    toolCallId: 'tc_1' as ToolCallId,
                    toolName: 'read_file',
                    arguments: { path: '/tmp/test.ts' },
                },
            ],
            timestamp: new Date().toISOString(),
        };

        const msgs = buildConversationMessages([item]);
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe('assistant');
        expect(Array.isArray(msgs[0].content)).toBe(true);

        const parts = msgs[0].content as Array<{ type: string; text?: string; toolName?: string }>;
        expect(parts).toHaveLength(2);
        expect(parts[0].type).toBe('text');
        expect(parts[0].text).toBe('Let me read that file.');
        expect(parts[1].type).toBe('tool_call');
        expect(parts[1].toolName).toBe('read_file');
    });

    it('converts summary items', () => {
        const items: ConversationItem[] = [
            {
                kind: 'summary',
                id: 'item_10' as ItemId,
                seq: 10,
                text: 'User asked about file handling. Agent read and modified 3 files.',
                coversSeq: { start: 1, end: 8 },
                timestamp: new Date().toISOString(),
            },
        ];

        const msgs = buildConversationMessages(items);
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe('system');
        expect(msgs[0].content).toContain('[Summary of earlier conversation]');
        expect(msgs[0].content).toContain('file handling');
    });

    it('applies scrub function to user messages and tool results', () => {
        const scrub = (text: string) => text.replace(/secret-key-123/g, '[REDACTED]');
        const items: ConversationItem[] = [
            makeUserMessage('my key is secret-key-123', 1),
            makeToolResult('exec', 'output: secret-key-123', 2),
        ];

        const msgs = buildConversationMessages(items, scrub);
        expect(msgs[0].content).toBe('my key is [REDACTED]');
        const parsed = JSON.parse(msgs[1].content as string);
        expect(parsed.data).toBe('output: [REDACTED]');
    });

    it('skips system-role message items', () => {
        const items: ConversationItem[] = [
            {
                kind: 'message',
                id: 'item_1' as ItemId,
                seq: 1,
                role: 'system',
                parts: [{ type: 'text', text: 'old system prompt' }],
                timestamp: new Date().toISOString(),
            },
            makeUserMessage('hello', 2),
        ];

        const msgs = buildConversationMessages(items);
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe('user');
    });
});

describe('buildInvokeSystemMessages', () => {
    it('returns a single system message with identity', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/home/user/project',
            toolNames: ['read_file'],
        });

        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe('system');
        const content = msgs[0].content as string;
        expect(content).toContain('ACA');
        expect(content).toContain('coding agent');
        expect(content).toContain('<workflow_disambiguation>');
        expect(content).toContain('"ACA consult" means use the `aca consult` workflow');
        expect(content).toContain('Bare "ACA" is ambiguous');
    });

    it('includes working directory', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/workspace/my-app',
            toolNames: [],
        });

        const content = msgs[0].content as string;
        expect(content).toContain('Working directory: /workspace/my-app');
    });

    it('includes tool list with count', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/tmp',
            toolNames: ['read_file', 'write_file', 'exec_command'],
        });

        const content = msgs[0].content as string;
        expect(content).toContain('Available tools (3)');
        expect(content).toContain('read_file');
        expect(content).toContain('write_file');
        expect(content).toContain('exec_command');
    });

    it('omits tool section when no tools', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/tmp',
            toolNames: [],
        });

        const content = msgs[0].content as string;
        expect(content).not.toContain('Available tools');
    });

    it('includes project stack from snapshot', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/home/user/project',
            toolNames: ['read_file'],
            projectSnapshot: {
                root: '/home/user/project',
                stack: ['Node', 'TypeScript', 'pnpm', 'vitest'],
                git: { branch: 'main', status: 'clean', staged: false },
                ignorePaths: ['.git/', 'node_modules/'],
                indexStatus: 'none',
            },
        });

        const content = msgs[0].content as string;
        expect(content).toContain('Stack: Node, TypeScript, pnpm, vitest');
        expect(content).toContain('Git: branch=main, clean');
    });

    it('includes git staged info when staged changes exist', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/proj',
            toolNames: [],
            projectSnapshot: {
                root: '/proj',
                stack: [],
                git: { branch: 'feature', status: 'dirty', staged: true },
                ignorePaths: [],
                indexStatus: 'none',
            },
        });

        const content = msgs[0].content as string;
        expect(content).toContain('staged changes');
    });

    it('shows project root only when different from cwd', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/proj/packages/core',
            toolNames: [],
            projectSnapshot: {
                root: '/proj',
                stack: [],
                git: null,
                ignorePaths: [],
                indexStatus: 'none',
            },
        });

        const content = msgs[0].content as string;
        expect(content).toContain('Project root: /proj');
    });

    it('omits project root when same as cwd', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/proj',
            toolNames: [],
            projectSnapshot: {
                root: '/proj',
                stack: [],
                git: null,
                ignorePaths: [],
                indexStatus: 'none',
            },
        });

        const content = msgs[0].content as string;
        expect(content).not.toContain('Project root:');
    });

    it('includes autonomous-mode framing', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/tmp',
            toolNames: ['read_file'],
        });

        const content = msgs[0].content as string;
        // The prompt must declare non-interactive mode so models know a text-only
        // response ends the turn. This closes the "empty end_turn" stall pattern.
        expect(content).toContain('<mode>');
        expect(content).toContain('NON-INTERACTIVE');
        expect(content).toContain('ends the conversation');
    });

    it('includes persistence block (OpenAI GPT-5 pattern)', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/tmp',
            toolNames: ['read_file'],
        });

        const content = msgs[0].content as string;
        expect(content).toContain('<persistence>');
        expect(content).toContain('keep going until');
        expect(content).toContain('biased for action');
    });

    it('includes tool_preambles block with anti-stall example', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/tmp',
            toolNames: ['read_file'],
        });

        const content = msgs[0].content as string;
        expect(content).toContain('<tool_preambles>');
        // The exact stall text from the M10.2 Kimi session — used as a negative
        // example so the model recognizes the anti-pattern verbatim.
        expect(content).toContain('Let me make the modifications');
        expect(content).toContain('your FIRST assistant message must include at least one tool call');
        expect(content).toContain('must be immediately followed by tool calls in the SAME assistant message');
        expect(content).toContain('If a tool result changes your next step');
        expect(content).toContain("I'll research this across multiple sources");
        expect(content).toContain("I'll start by reading the local reference files and querying the wiki API in parallel.");
        expect(content).toContain('The category came back empty; I need to try subcategories and direct page fetches.');
        expect(content).not.toContain('exec_command');
        expect(content).not.toContain('edit_file');
    });

    it('only declares unavailable tools when they are visible', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/tmp',
            toolNames: ['read_file', 'ask_user', 'confirm_action'],
        });

        const content = msgs[0].content as string;
        expect(content).toContain('<unavailable_tools>');
        expect(content).toContain('ask_user');
        expect(content).toContain('confirm_action');
    });

    it('does not name tools excluded from the visible tool set', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/tmp',
            toolNames: ['read_file', 'fetch_url', 'web_search'],
        });

        const content = msgs[0].content as string;
        expect(content).toContain('Available tools (3): read_file, fetch_url, web_search');
        expect(content).not.toContain('exec_command');
        expect(content).not.toContain('edit_file');
        expect(content).not.toContain('ask_user');
        expect(content).not.toContain('confirm_action');
    });

    it('includes active profile instructions when provided', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/tmp',
            toolNames: ['read_file', 'write_file'],
            profileName: 'rp-researcher',
            profilePrompt: 'Write Markdown only. Do not spend the whole tool budget on research.',
        });

        const content = msgs[0].content as string;
        expect(content).toContain('Active profile: rp-researcher');
        expect(content).toContain('<active_profile>');
        expect(content).toContain('Write Markdown only');
        expect(content).toContain('Do not spend the whole tool budget on research');
    });

    it('includes safety block forbidding unauthorized destructive ops', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/tmp',
            toolNames: ['read_file', 'edit_file'],
        });

        const content = msgs[0].content as string;
        expect(content).toContain('<safety>');
        expect(content).toContain('Do NOT delete');
        expect(content).toContain('empty edits');
    });

    it('includes few-shot example with CORRECT and INCORRECT branches', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/tmp',
            toolNames: ['read_file'],
        });

        const content = msgs[0].content as string;
        expect(content).toContain('<example>');
        expect(content).toContain('CORRECT behavior');
        expect(content).toContain('INCORRECT behavior');
        expect(content).toContain('TURN ENDS, TASK FAILS');
    });

    // C9 regression: softened qualifiers must be present
    it('<mode> provides a final-summary escape hatch, not unconditional termination', () => {
        const msgs = buildInvokeSystemMessages({ cwd: '/tmp', toolNames: ['read_file'] });
        const content = msgs[0].content as string;
        // The ONLY valid text-only response is the final summary — not "any text ends it"
        expect(content).toContain('The ONLY valid text-only response is your final summary');
    });

    it('<persistence> applies while work remains (softened qualifier)', () => {
        const msgs = buildInvokeSystemMessages({ cwd: '/tmp', toolNames: ['read_file'] });
        const content = msgs[0].content as string;
        expect(content).toContain('This applies while work remains');
    });

    it('<tool_preambles> gates tool use on task requirement, not unconditionally', () => {
        const msgs = buildInvokeSystemMessages({ cwd: '/tmp', toolNames: ['read_file'] });
        const content = msgs[0].content as string;
        // Must say "when the task requires tools", not "whenever tools are available"
        expect(content).toContain('When the task requires tools');
    });

    it('sanitizes control characters in paths', () => {
        const msgs = buildInvokeSystemMessages({
            cwd: '/home/user/evil\ninjected line\ndir',
            toolNames: ['read_file'],
            projectSnapshot: {
                root: '/home/user/evil\rinjection\nroot',
                stack: [],
                git: null,
                ignorePaths: [],
                indexStatus: 'none',
            },
        });

        const content = msgs[0].content as string;
        // Control characters replaced with spaces — no injected newlines from paths
        // The cwd line should be on a single line (newlines stripped)
        const cwdLine = content.split('\n').find(l => l.startsWith('Working directory:'))!;
        expect(cwdLine).not.toContain('\n');
        expect(cwdLine).toContain('evil');
        expect(cwdLine).toContain('injected line'); // text preserved, just on same line
        // Project root should also be sanitized (no raw \r or \n)
        const rootLine = content.split('\n').find(l => l.startsWith('Project root:'))!;
        expect(rootLine).toContain('injection');
        expect(rootLine).toContain('root');
        expect(rootLine).not.toMatch(/[\r\n]/);
    });

    it('stays under ~6K tokens for a full peer-level tool set (runaway guard)', () => {
        // The invoke prompt is autonomous-agent-grade (per docs/research/
        // system-prompt-giants/) and targets 3-5K tokens. This test is a
        // runaway-growth guard, not a hard optimization target — the invoke
        // path has no compression coupling (verified at turn-engine.ts:778)
        // so the real constraint is "leave room for tool outputs".
        const msgs = buildInvokeSystemMessages({
            cwd: '/home/user/project',
            toolNames: [
                'read_file', 'write_file', 'edit_file', 'delete_path', 'move_path',
                'make_directory', 'stat_path', 'find_paths', 'search_text',
                'exec_command', 'open_session', 'session_io', 'close_session',
                'ask_user', 'confirm_action', 'estimate_tokens', 'search_semantic',
                'lsp_query', 'browser_navigate', 'browser_click', 'browser_type',
                'web_search', 'fetch_url', 'lookup_docs',
            ],
            projectSnapshot: {
                root: '/home/user/project',
                stack: ['Node', 'TypeScript', 'pnpm', 'vitest', 'eslint'],
                git: { branch: 'feature/invoke-prompt', status: 'dirty', staged: true },
                ignorePaths: ['.git/', 'node_modules/', 'dist/', 'build/', 'coverage/'],
                indexStatus: 'ready',
            },
        });

        const content = msgs[0].content as string;
        // ~4 chars per token, 6K tokens = ~24K chars
        expect(content.length).toBeLessThan(24_000);
    });

    it('contains all required top-level sections in order', () => {

        // Section ordering is load-bearing: the operational drive (persistence,
        // tool_preambles) sits before environment so it frames the task. The
        // closing anchor is last so it is the model's final read.
        const msgs = buildInvokeSystemMessages({
            cwd: '/tmp',
            toolNames: ['read_file', 'ask_user'],
            projectSnapshot: {
                root: '/tmp',
                stack: ['Node'],
                git: null,
                ignorePaths: [],
                indexStatus: 'none',
            },
        });

        const content = msgs[0].content as string;
        const expectedOrder = [
            '<mode>',
            '<persistence>',
            '<tool_preambles>',
            '<use_parallel_tool_calls>',
            '<default_to_action>',
            '<unavailable_tools>',
            '<safety>',
            '<tool_results>',
            '<environment>',
            '<tool_reference>',
            '<example>',
        ];
        let lastIndex = -1;
        for (const marker of expectedOrder) {
            const idx = content.indexOf(marker);
            expect(idx, `missing section ${marker}`).toBeGreaterThan(-1);
            expect(idx, `section ${marker} out of order`).toBeGreaterThan(lastIndex);
            lastIndex = idx;
        }
        // Closing anchor must be present and after the last tagged section
        const anchorIdx = content.indexOf('Remember: a response without tool calls');
        expect(anchorIdx).toBeGreaterThan(lastIndex);
    });
});

describe('buildAnalyticalSystemMessages', () => {
    it('returns a single system message', () => {
        const msgs = buildAnalyticalSystemMessages({ cwd: '/tmp', toolNames: [] });
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe('system');
    });

    it('includes ACA identity', () => {
        const msgs = buildAnalyticalSystemMessages({ cwd: '/tmp', toolNames: [] });
        const content = msgs[0].content as string;
        expect(content).toContain('ACA');
    });

    it('includes <tool_policy> block', () => {
        const msgs = buildAnalyticalSystemMessages({ cwd: '/tmp', toolNames: ['read_file'] });
        const content = msgs[0].content as string;
        expect(content).toContain('<workflow_disambiguation>');
        expect(content).toContain('"ACA invoke" means use the `aca invoke` workflow');
        expect(content).toContain('<tool_policy>');
        expect(content).toContain('If the task is purely conceptual and does not ask you to verify against code');
    });

    it('requires grounded verification instead of answering from memory when the task asks for evidence', () => {
        const msgs = buildAnalyticalSystemMessages({ cwd: '/tmp', toolNames: ['read_file', 'fetch_url'] });
        const content = msgs[0].content as string;
        expect(content).toContain('do NOT answer from memory');
        expect(content).toContain('If the active profile asks for grounded verification');
        expect(content).not.toContain('If you can answer the question from your knowledge, do so immediately');
    });

    it('instructs blocked verification paths to fail plainly instead of leaking tool markup', () => {
        const msgs = buildAnalyticalSystemMessages({ cwd: '/tmp', toolNames: ['fetch_url'] });
        const content = msgs[0].content as string;
        expect(content).toContain('If required verification is blocked because tools are unavailable, unconfigured, denied, or exhausted');
        expect(content).toContain('Do not emit raw tool-call JSON');
    });

    it('includes <environment> with working directory', () => {
        const msgs = buildAnalyticalSystemMessages({ cwd: '/workspace/proj', toolNames: [] });
        const content = msgs[0].content as string;
        expect(content).toContain('<environment>');
        expect(content).toContain('Working directory: /workspace/proj');
    });

    it('includes <tool_reference> when tools provided', () => {
        const msgs = buildAnalyticalSystemMessages({
            cwd: '/tmp',
            toolNames: ['read_file', 'search_text'],
        });
        const content = msgs[0].content as string;
        expect(content).toContain('<tool_reference>');
        expect(content).toContain('Available tools (2): read_file, search_text');
    });

    it('omits <tool_reference> when no tools', () => {
        const msgs = buildAnalyticalSystemMessages({ cwd: '/tmp', toolNames: [] });
        expect(msgs[0].content as string).not.toContain('<tool_reference>');
    });

    it('does NOT contain <mode> or <persistence> (C9 regression)', () => {
        const msgs = buildAnalyticalSystemMessages({ cwd: '/tmp', toolNames: ['read_file'] });
        const content = msgs[0].content as string;
        expect(content).not.toContain('<mode>');
        expect(content).not.toContain('<persistence>');
    });

    it('injects profile when profilePrompt provided', () => {
        const msgs = buildAnalyticalSystemMessages({
            cwd: '/tmp',
            toolNames: [],
            profileName: 'reviewer',
            profilePrompt: 'Focus on security findings only.',
        });
        const content = msgs[0].content as string;
        expect(content).toContain('Active profile: reviewer');
        expect(content).toContain('<profile>');
        expect(content).toContain('Focus on security findings only.');
    });

    it('does NOT contain <mode> or <persistence> even with profile (C9 regression)', () => {
        const msgs = buildAnalyticalSystemMessages({
            cwd: '/tmp',
            toolNames: ['read_file'],
            profilePrompt: 'Some profile instructions.',
        });
        const content = msgs[0].content as string;
        expect(content).not.toContain('<mode>');
        expect(content).not.toContain('<persistence>');
    });
});

describe('buildSynthesisSystemMessages', () => {
    it('returns a single system message', () => {
        const msgs = buildSynthesisSystemMessages({ cwd: '/tmp', toolNames: [] });
        expect(msgs).toHaveLength(1);
        expect(msgs[0].role).toBe('system');
    });

    it('states tools are NOT available', () => {
        const msgs = buildSynthesisSystemMessages({ cwd: '/tmp', toolNames: [] });
        const content = msgs[0].content as string;
        expect(content).toContain('<workflow_disambiguation>');
        expect(content).toContain('"ACA consult" means use the `aca consult` workflow');
        expect(content).toContain('NOT available in this session');
    });

    it('instructs model not to emit tool-call markup', () => {
        const msgs = buildSynthesisSystemMessages({ cwd: '/tmp', toolNames: [] });
        const content = msgs[0].content as string;
        expect(content).toContain('Do not call tools');
        expect(content).toContain('<tool_call>');
        expect(content).toContain('<function_calls>');
    });

    it('does not include <tool_reference>', () => {
        const msgs = buildSynthesisSystemMessages({ cwd: '/tmp', toolNames: ['read_file'] });
        expect(msgs[0].content as string).not.toContain('<tool_reference>');
    });

    it('does NOT contain <mode> or <persistence>', () => {
        const msgs = buildSynthesisSystemMessages({ cwd: '/tmp', toolNames: [] });
        const content = msgs[0].content as string;
        expect(content).not.toContain('<mode>');
        expect(content).not.toContain('<persistence>');
    });

    it('injects profile when profilePrompt provided', () => {
        const msgs = buildSynthesisSystemMessages({
            cwd: '/tmp',
            toolNames: [],
            profileName: 'triage',
            profilePrompt: 'Aggregate findings into a ranked list.',
        });
        const content = msgs[0].content as string;
        expect(content).toContain('Active profile: triage');
        expect(content).toContain('<profile>');
        expect(content).toContain('Aggregate findings into a ranked list.');
    });
});

describe('buildSystemMessagesForTier', () => {
    it("routes 'analytical' to buildAnalyticalSystemMessages", () => {
        const msgs = buildSystemMessagesForTier('analytical', { cwd: '/tmp', toolNames: ['read_file'] });
        const content = msgs[0].content as string;
        expect(content).toContain('<tool_policy>');
        expect(content).not.toContain('<mode>');
    });

    it("routes 'synthesis' to buildSynthesisSystemMessages", () => {
        const msgs = buildSystemMessagesForTier('synthesis', { cwd: '/tmp', toolNames: [] });
        const content = msgs[0].content as string;
        expect(content).toContain('NOT available in this session');
        expect(content).not.toContain('<mode>');
    });

    it("routes 'agentic' to buildInvokeSystemMessages", () => {
        const msgs = buildSystemMessagesForTier('agentic', { cwd: '/tmp', toolNames: ['read_file'] });
        const content = msgs[0].content as string;
        expect(content).toContain('<mode>');
        expect(content).toContain('<persistence>');
    });

    it('routes undefined to buildInvokeSystemMessages', () => {
        const msgs = buildSystemMessagesForTier(undefined, { cwd: '/tmp', toolNames: ['read_file'] });
        const content = msgs[0].content as string;
        expect(content).toContain('<mode>');
        expect(content).toContain('<persistence>');
    });
});
