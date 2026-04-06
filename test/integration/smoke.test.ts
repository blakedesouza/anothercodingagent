/**
 * M1.10 — Integration Smoke Test
 *
 * Wires together the full M1 stack:
 *   SessionManager → TurnEngine → NanoGptDriver (mock) → ToolRegistry → read_file
 *
 * Verifies:
 *   T1: Full round-trip (user input → tool call → tool result → final response)
 *   T2: conversation.jsonl is complete and parseable
 *   T3: events.jsonl is complete and causally ordered
 *   T4: session can be loaded after completion (SessionManager.load)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockNanoGPTServer } from '../helpers/mock-nanogpt-server.js';
import { SessionManager } from '../../src/core/session-manager.js';
import type { SessionProjection } from '../../src/core/session-manager.js';
import { TurnEngine, Phase } from '../../src/core/turn-engine.js';
import type { TurnResult } from '../../src/core/turn-engine.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { readFileSpec, readFileImpl } from '../../src/tools/read-file.js';
import { NanoGptDriver } from '../../src/providers/nanogpt-driver.js';
import { JsonlEventSink, createEvent } from '../../src/core/event-sink.js';
import { readConversationLog } from '../../src/core/conversation-reader.js';
import type { MessageItem, ToolCallPart, ToolResultItem } from '../../src/types/conversation.js';
import type { TurnRecord } from '../../src/types/session.js';
import type { SessionId } from '../../src/types/ids.js';

const FIXTURE_PATH = join(process.cwd(), 'test', 'fixtures', 'sample.txt');

describe('M1 Integration Smoke Test', () => {
    let mockServer: MockNanoGPTServer;
    let sm: SessionManager;
    let sessionId: SessionId;
    let conversationPath: string;
    let eventsPath: string;
    let turnResult: TurnResult;
    let sessionsDir: string;

    beforeAll(async () => {
        // Start mock NanoGPT server
        mockServer = new MockNanoGPTServer();
        await mockServer.start();

        // Response 1: tool call to read_file
        mockServer.addToolCallResponse([{
            id: 'tc-001',
            name: 'read_file',
            arguments: { path: FIXTURE_PATH },
        }]);
        // Response 2: text summary after reading the file
        mockServer.addTextResponse('The file contains a greeting and 4 lines about integration testing.');

        // Create session in a temp directory
        sessionsDir = mkdtempSync(join(tmpdir(), 'aca-smoke-'));
        sm = new SessionManager(sessionsDir);
        const projection: SessionProjection = sm.create(process.cwd());
        sessionId = projection.manifest.sessionId;
        conversationPath = join(projection.sessionDir, 'conversation.jsonl');
        eventsPath = join(projection.sessionDir, 'events.jsonl');

        // Set up event sink (events.jsonl will be created on first emit)
        const eventSink = new JsonlEventSink(eventsPath);

        // Emit session.started before the turn
        eventSink.emit(createEvent('session.started', sessionId, 0, 'aca', {
            workspace_id: projection.manifest.workspaceId,
            model: 'gpt-4',
            provider: 'nanogpt',
        }));

        // Wire tool registry
        const registry = new ToolRegistry();
        registry.register(readFileSpec, readFileImpl);

        // Wire provider pointing at mock server
        const driver = new NanoGptDriver({
            apiKey: 'test-key',
            baseUrl: mockServer.baseUrl,
        });

        const engine = new TurnEngine(driver, registry, projection.writer, projection.sequenceGenerator);

        // Map TurnEngine phase transitions → structured events.
        // TurnEngine emits 'phase' synchronously; handlers run within executeTurn.
        let toolExecutionActive = false;
        engine.on('phase', (phase: Phase) => {
            const turnNumber = 1;
            switch (phase) {
                case Phase.OpenTurn:
                    eventSink.emit(createEvent('turn.started', sessionId, turnNumber, 'aca', {
                        turn_id: 'pending',
                        input_preview: 'read the file at test/fixtures/sample.txt',
                    }));
                    break;
                case Phase.CallLLM:
                    eventSink.emit(createEvent('llm.request', sessionId, turnNumber, 'aca', {
                        model: 'gpt-4',
                        provider: 'nanogpt',
                        estimated_input_tokens: 100,
                        tool_count: registry.list().length,
                    }));
                    break;
                case Phase.NormalizeResponse:
                    // LLM streaming is complete at this point
                    eventSink.emit(createEvent('llm.response', sessionId, turnNumber, 'aca', {
                        model: 'gpt-4',
                        provider: 'nanogpt',
                        tokens_in: 10,
                        tokens_out: 5,
                        latency_ms: 0,
                        finish_reason: 'stop',
                        cost_usd: null,
                    }));
                    break;
                case Phase.ExecuteToolCalls:
                    toolExecutionActive = true;
                    eventSink.emit(createEvent('tool.invoked', sessionId, turnNumber, 'aca', {
                        tool_name: 'read_file',
                        args_summary: FIXTURE_PATH.slice(-40),
                        correlation_id: 'corr-001',
                    }));
                    break;
                case Phase.AppendToolResults:
                    // Tool execution is complete at this point
                    if (toolExecutionActive) {
                        toolExecutionActive = false;
                        eventSink.emit(createEvent('tool.completed', sessionId, turnNumber, 'aca', {
                            tool_name: 'read_file',
                            status: 'success',
                            duration_ms: 0,
                            bytes_returned: 0,
                            correlation_id: 'corr-001',
                        }));
                    }
                    break;
            }
        });

        const config = {
            sessionId,
            model: 'gpt-4',
            provider: 'nanogpt',
            interactive: false,
            autoConfirm: true,
            isSubAgent: false,
            workspaceRoot: process.cwd(),
        };

        // Execute the turn — full round-trip through M1 stack
        turnResult = await engine.executeTurn(
            config,
            'read the file at test/fixtures/sample.txt',
            [],
        );

        // Emit turn.ended after execution completes
        eventSink.emit(createEvent('turn.ended', sessionId, 1, 'aca', {
            turn_id: turnResult.turn.id,
            outcome: turnResult.turn.outcome!,
            step_count: turnResult.steps.length,
            tokens_in: turnResult.steps.reduce((sum, s) => sum + s.tokenUsage.inputTokens, 0),
            tokens_out: turnResult.steps.reduce((sum, s) => sum + s.tokenUsage.outputTokens, 0),
            duration_ms: 0,
        }));

        // Persist updated manifest (turnCount tracks completed turns)
        projection.manifest.turnCount = 1;
        projection.manifest.lastActivityTimestamp = new Date().toISOString();
        sm.saveManifest(projection);
    }, 15_000);

    afterAll(async () => {
        await mockServer.stop();
        rmSync(sessionsDir, { recursive: true, force: true });
    });

    it('T1: full round-trip — user input → tool call → tool result → final response', () => {
        expect(turnResult.turn.outcome).toBe('assistant_final');
        expect(turnResult.turn.status).toBe('completed');
        expect(turnResult.steps.length).toBe(2); // step 1: tool call, step 2: text response

        // Items breakdown: user msg + asst(tool_call) + tool_result + asst(text)
        const messages = turnResult.items.filter(i => i.kind === 'message') as MessageItem[];
        const toolResults = turnResult.items.filter(i => i.kind === 'tool_result') as ToolResultItem[];

        expect(messages).toHaveLength(3);   // user + asst(tool_call) + asst(text)
        expect(toolResults).toHaveLength(1);

        const userMsgs = messages.filter(m => m.role === 'user');
        const assistantMsgs = messages.filter(m => m.role === 'assistant');
        expect(userMsgs).toHaveLength(1);
        expect(assistantMsgs).toHaveLength(2);

        // First assistant message carries the tool call
        // Cast needed: MessageItem.parts is TextPart[] | AssistantPart[]
        const toolCallPart = assistantMsgs[0].parts.find(
            p => p.type === 'tool_call',
        ) as ToolCallPart | undefined;
        expect(toolCallPart).toBeDefined();
        expect(toolCallPart!.toolName).toBe('read_file');
        expect((toolCallPart!.arguments as { path: string }).path).toBe(FIXTURE_PATH);

        // Tool executed successfully
        expect(toolResults[0].output.status).toBe('success');
        expect(toolResults[0].toolName).toBe('read_file');

        // Second assistant message carries the text summary
        const textPart = assistantMsgs[1].parts.find(p => p.type === 'text');
        expect(textPart).toBeDefined();

        // Mock server received exactly 2 requests: one for the tool call, one for the final response
        expect(mockServer.receivedRequests).toHaveLength(2);
    });

    it('T2: conversation log is complete and parseable', () => {
        expect(existsSync(conversationPath)).toBe(true);

        const { records, warnings } = readConversationLog(conversationPath);
        expect(warnings).toHaveLength(0);

        const types = records.map(r => r.recordType);
        expect(types).toContain('message');
        expect(types).toContain('tool_result');
        expect(types).toContain('turn');
        expect(types).toContain('step');

        // User message and at least one assistant message must be present
        const messages = records
            .filter((r): r is { recordType: 'message'; record: MessageItem } => r.recordType === 'message')
            .map(r => r.record);

        expect(messages.some(m => m.role === 'user')).toBe(true);
        expect(messages.filter(m => m.role === 'assistant').length).toBeGreaterThanOrEqual(1);

        // Completed turn record must be present
        const completedTurns = records
            .filter((r): r is { recordType: 'turn'; record: TurnRecord } => r.recordType === 'turn')
            .map(r => r.record)
            .filter(t => t.status === 'completed');
        expect(completedTurns).toHaveLength(1);
        expect(completedTurns[0].outcome).toBe('assistant_final');
    });

    it('T3: event log is complete and causally ordered', () => {
        expect(existsSync(eventsPath)).toBe(true);

        const rawLines = readFileSync(eventsPath, 'utf-8')
            .trim()
            .split('\n')
            .filter(l => l.trim().length > 0);
        expect(rawLines.length).toBeGreaterThan(0);

        // All lines must be valid JSON
        const events = rawLines.map(l => JSON.parse(l) as { event_type: string; session_id: string });

        // All events must carry the correct session ID
        for (const ev of events) {
            expect(ev.session_id).toBe(sessionId);
        }

        const eventTypes = events.map(e => e.event_type);

        // All required event types must be present
        expect(eventTypes).toContain('session.started');
        expect(eventTypes).toContain('turn.started');
        expect(eventTypes).toContain('llm.request');
        expect(eventTypes).toContain('llm.response');
        expect(eventTypes).toContain('tool.invoked');
        expect(eventTypes).toContain('tool.completed');
        expect(eventTypes).toContain('turn.ended');

        // Causal bookends: session.started is first, turn.ended is last
        expect(eventTypes[0]).toBe('session.started');
        expect(eventTypes[eventTypes.length - 1]).toBe('turn.ended');

        // Within a step: llm.request → llm.response → tool.invoked → tool.completed
        const firstLlmRequest = eventTypes.indexOf('llm.request');
        const firstLlmResponse = eventTypes.indexOf('llm.response');
        const toolInvoked = eventTypes.indexOf('tool.invoked');
        const toolCompleted = eventTypes.indexOf('tool.completed');

        expect(firstLlmRequest).toBeGreaterThan(eventTypes.indexOf('turn.started'));
        expect(firstLlmResponse).toBeGreaterThan(firstLlmRequest);
        expect(toolInvoked).toBeGreaterThan(firstLlmResponse);
        expect(toolCompleted).toBeGreaterThan(toolInvoked);
    });

    it('T4: session can be loaded after completion (SessionManager.load)', () => {
        const loaded = sm.load(sessionId);

        expect(loaded.manifest.sessionId).toBe(sessionId);
        expect(loaded.manifest.turnCount).toBe(1);
        expect(loaded.manifest.status).toBe('active');

        // Conversation items were replayed from JSONL
        expect(loaded.items.length).toBeGreaterThan(0);

        // Turn records were replayed
        expect(loaded.turns.length).toBeGreaterThan(0);
        const completedTurn = loaded.turns.find(t => t.status === 'completed');
        expect(completedTurn).toBeDefined();
        expect(completedTurn!.outcome).toBe('assistant_final');

        // JSONL is append-only: an initial 'active' record and a final 'completed' record
        // both exist for the same turn. Verify:
        //   1. Every active turn ID has a matching completed turn ID
        //   2. The completed record comes after the active record (no log corruption)
        type TurnState = { hasActive: boolean; hasCompleted: boolean; activeIdx: number; completedIdx: number };
        const turnStates = new Map<string, TurnState>();
        loaded.turns.forEach((t, idx) => {
            const s = turnStates.get(t.id) ?? { hasActive: false, hasCompleted: false, activeIdx: -1, completedIdx: -1 };
            if (t.status === 'active') { s.hasActive = true; s.activeIdx = idx; }
            else if (t.status === 'completed') { s.hasCompleted = true; s.completedIdx = idx; }
            turnStates.set(t.id, s);
        });
        for (const [, state] of turnStates) {
            if (state.hasActive) {
                expect(state.hasCompleted).toBe(true);
                expect(state.completedIdx).toBeGreaterThan(state.activeIdx);
            }
        }
    });
});
