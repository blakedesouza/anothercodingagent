import { generateId } from '../../src/types/ids.js';
import type { Session, TurnRecord, StepRecord, TurnOutcome } from '../../src/types/session.js';
import type { ConversationItem, MessageItem, ToolResultItem, TextPart, ToolCallPart } from '../../src/types/conversation.js';
import type { SessionId, TurnId, StepId, ItemId, ToolCallId, WorkspaceId } from '../../src/types/ids.js';

/**
 * Factory for creating valid Block 5 Session objects in tests.
 * Produces sessions with predefined conversation state.
 */

export interface SessionFactoryOptions {
    model?: string;
    provider?: string;
    status?: Session['status'];
    turnCount?: number;
    label?: string;
}

export interface TurnFactoryOptions {
    outcome?: TurnOutcome;
    stepCount?: number;
    userMessage?: string;
    assistantMessage?: string;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

let seqCounter = 0;

function nextSeq(): number {
    return ++seqCounter;
}

function now(): string {
    return new Date().toISOString();
}

export function resetSeqCounter(): void {
    seqCounter = 0;
}

export function createItem(
    role: 'system' | 'user' | 'assistant',
    text: string,
): MessageItem {
    return {
        kind: 'message',
        id: generateId('item') as ItemId,
        seq: nextSeq(),
        role,
        parts: [{ type: 'text', text }] satisfies TextPart[],
        timestamp: now(),
    };
}

export function createToolCallItem(
    toolName: string,
    args: Record<string, unknown>,
    text?: string,
): { message: MessageItem; toolCallId: ToolCallId } {
    const toolCallId = generateId('toolCall') as ToolCallId;
    const parts: (TextPart | ToolCallPart)[] = [];
    if (text) {
        parts.push({ type: 'text', text });
    }
    parts.push({
        type: 'tool_call',
        toolCallId,
        toolName,
        arguments: args,
    });
    return {
        message: {
            kind: 'message',
            id: generateId('item') as ItemId,
            seq: nextSeq(),
            role: 'assistant',
            parts,
            timestamp: now(),
        },
        toolCallId,
    };
}

export function createToolResultItem(
    toolCallId: ToolCallId,
    toolName: string,
    data: string,
    status: 'success' | 'error' = 'success',
): ToolResultItem {
    return {
        kind: 'tool_result',
        id: generateId('item') as ItemId,
        seq: nextSeq(),
        toolCallId,
        toolName,
        output: {
            status,
            data,
            truncated: false,
            bytesReturned: Buffer.byteLength(data, 'utf-8'),
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        },
        timestamp: now(),
    };
}

let stepCounter = 0;

export function resetStepCounter(): void {
    stepCounter = 0;
}

export function createStep(
    turnId: TurnId,
    inputSeqs: number[],
    outputSeqs: number[],
    options?: { model?: string; provider?: string; finishReason?: string; stepNumber?: number },
): StepRecord {
    return {
        id: generateId('step') as StepId,
        turnId,
        stepNumber: options?.stepNumber ?? ++stepCounter,
        model: options?.model ?? 'mock-model',
        provider: options?.provider ?? 'nanogpt',
        inputItemSeqs: inputSeqs,
        outputItemSeqs: outputSeqs,
        finishReason: options?.finishReason ?? 'stop',
        contextStats: {
            tokenCount: 100,
            tokenLimit: 128000,
            compressionTier: 'full',
            systemPromptFingerprint: 'mock-fingerprint',
        },
        tokenUsage: {
            inputTokens: 50,
            outputTokens: 20,
        },
        timestamp: now(),
    };
}

export function createTurn(
    sessionId: SessionId,
    turnNumber: number,
    options: TurnFactoryOptions = {},
): { turn: TurnRecord; items: ConversationItem[] } {
    const turnId = generateId('turn') as TurnId;
    const items: ConversationItem[] = [];

    const userMsg = createItem('user', options.userMessage ?? `User message ${turnNumber}`);
    items.push(userMsg);

    const inputSeqs = [userMsg.seq];
    const outputSeqs: number[] = [];

    if (options.toolCalls && options.toolCalls.length > 0) {
        for (const tc of options.toolCalls) {
            const { message, toolCallId } = createToolCallItem(tc.name, tc.arguments);
            items.push(message);
            outputSeqs.push(message.seq);

            const result = createToolResultItem(toolCallId, tc.name, `Result of ${tc.name}`);
            items.push(result);
            inputSeqs.push(result.seq);
        }
    }

    const assistantMsg = createItem('assistant', options.assistantMessage ?? `Response ${turnNumber}`);
    items.push(assistantMsg);
    outputSeqs.push(assistantMsg.seq);

    const step = createStep(turnId, inputSeqs, outputSeqs);

    const turn: TurnRecord = {
        id: turnId,
        sessionId,
        turnNumber,
        status: 'completed',
        outcome: options.outcome ?? 'assistant_final',
        itemSeqStart: items[0].seq,
        itemSeqEnd: items[items.length - 1].seq,
        steps: [step],
        startedAt: now(),
        completedAt: now(),
    };

    return { turn, items };
}

export function createSession(options: SessionFactoryOptions = {}): {
    session: Session;
    items: ConversationItem[];
} {
    resetSeqCounter();
    resetStepCounter();

    const sessionId = generateId('session') as SessionId;
    const turnCount = options.turnCount ?? 0;
    const allItems: ConversationItem[] = [];
    const turns: TurnRecord[] = [];

    for (let i = 1; i <= turnCount; i++) {
        const { turn, items } = createTurn(sessionId, i);
        turns.push(turn);
        allItems.push(...items);
    }

    const session: Session = {
        id: sessionId,
        workspaceId: generateId('workspace') as WorkspaceId,
        status: options.status ?? 'active',
        model: options.model ?? 'mock-model',
        provider: options.provider ?? 'nanogpt',
        configSnapshot: { model: options.model ?? 'mock-model', provider: options.provider ?? 'nanogpt' },
        turns,
        currentTurnNumber: turnCount,
        nextItemSeq: seqCounter + 1,
        createdAt: now(),
        lastActivityAt: now(),
        label: options.label,
    };

    return { session, items: allItems };
}
