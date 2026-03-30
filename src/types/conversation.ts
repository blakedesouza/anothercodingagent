import type { ItemId, ToolCallId } from './ids.js';

// --- Parts model ---

export interface TextPart {
    type: 'text';
    text: string;
}

export interface ToolCallPart {
    type: 'tool_call';
    toolCallId: ToolCallId;
    toolName: string;
    arguments: Record<string, unknown>;
}

export type AssistantPart = TextPart | ToolCallPart;

// --- Tool output envelope (Block 15) ---

export type MutationState = 'none' | 'filesystem' | 'process' | 'network';

export interface BlobRef {
    sha256: string;
    path: string;
    bytes: number;
    mimeType: string;
}

export interface ToolOutput {
    status: 'success' | 'error';
    data: string;
    error?: string;
    truncated: boolean;
    bytesReturned: number;
    retryable: boolean;
    timedOut: boolean;
    mutationState: MutationState;
}

// --- Conversation items ---

export interface MessageItem {
    kind: 'message';
    id: ItemId;
    seq: number;
    role: 'system' | 'user' | 'assistant';
    parts: TextPart[] | AssistantPart[];
    timestamp: string;
}

export interface ToolResultItem {
    kind: 'tool_result';
    id: ItemId;
    seq: number;
    toolCallId: ToolCallId;
    toolName: string;
    output: ToolOutput;
    blobRef?: BlobRef;
    timestamp: string;
}

export interface SummaryItem {
    kind: 'summary';
    id: ItemId;
    seq: number;
    text: string;
    pinnedFacts?: string[];
    coversSeq: { start: number; end: number };
    timestamp: string;
}

export type ConversationItem = MessageItem | ToolResultItem | SummaryItem;
