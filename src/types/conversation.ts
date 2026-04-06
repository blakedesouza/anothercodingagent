import type { ItemId, ToolCallId, SessionId, EventId } from './ids.js';
import type { AcaError } from './errors.js';

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

export type MutationState = 'none' | 'filesystem' | 'process' | 'network' | 'indeterminate';

export interface BlobRef {
    sha256: string;
    path: string;
    bytes: number;
    mimeType: string;
}

export interface ToolOutput {
    status: 'success' | 'error';
    data: string;
    error?: AcaError;
    truncated: boolean;
    bytesReturned: number;
    bytesOmitted: number;
    retryable: boolean;
    timedOut: boolean;
    mutationState: MutationState;
    blobRef?: BlobRef;
    /** Set by user-interaction tools to signal the turn engine to yield. */
    yieldOutcome?: 'awaiting_user' | 'approval_required';
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
    delegation?: DelegationRecord;
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

// --- Delegation record (6th core type, embedded in ToolResultItem for delegation tools) ---

export interface DelegationRecord {
    childSessionId: SessionId;
    childAgentId: string;
    finalStatus: 'completed' | 'failed' | 'cancelled';
    parentEventId: EventId;
}
