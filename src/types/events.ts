/**
 * Structured event types for the ACA event system (Block 14).
 *
 * Every agent action emits a typed event into an append-only JSONL log.
 * Events carry content by reference (item IDs), not inline content.
 */

import type { SessionId, EventId } from './ids.js';
import type { TurnOutcome } from './session.js';

// --- Event envelope ---

export interface EventEnvelope {
    event_id: EventId;
    timestamp: string; // ISO-8601
    session_id: SessionId;
    turn_number: number;
    agent_id: string;
    event_type: EventType;
    schema_version: number;
    parent_event_id?: EventId;
}

// --- 13 core event types ---

export type EventType =
    | 'session.started'
    | 'session.ended'
    | 'turn.started'
    | 'turn.ended'
    | 'llm.request'
    | 'llm.response'
    | 'tool.invoked'
    | 'tool.completed'
    | 'delegation.started'
    | 'delegation.completed'
    | 'context.assembled'
    | 'model.fallback'
    | 'network.checked'
    | 'error';

// --- Typed payloads ---

export interface SessionStartedPayload {
    workspace_id: string;
    model: string;
    provider: string;
}

export interface SessionEndedPayload {
    total_turns: number;
    total_tokens_in: number;
    total_tokens_out: number;
    duration_ms: number;
}

export interface TurnStartedPayload {
    turn_id: string;
    input_preview: string; // First 200 chars of user input
}

export interface TurnEndedPayload {
    turn_id: string;
    outcome: TurnOutcome;
    step_count: number;
    tokens_in: number;
    tokens_out: number;
    duration_ms: number;
}

export interface LlmRequestPayload {
    model: string;
    provider: string;
    estimated_input_tokens: number;
    tool_count: number;
}

export interface LlmResponsePayload {
    model: string;
    provider: string;
    tokens_in: number;
    tokens_out: number;
    latency_ms: number;
    finish_reason: string;
    cost_usd: number | null;
}

export interface ToolInvokedPayload {
    tool_name: string;
    args_summary: string; // Truncated stringified args
    correlation_id: string;
}

export interface ToolCompletedPayload {
    tool_name: string;
    status: 'success' | 'error';
    duration_ms: number;
    bytes_returned: number;
    correlation_id: string;
}

export interface DelegationStartedPayload {
    child_agent_id: string;
    task_summary: string;
}

export interface DelegationCompletedPayload {
    child_agent_id: string;
    final_status: 'completed' | 'failed' | 'cancelled';
    tokens_in: number;
    tokens_out: number;
}

export interface ContextAssembledPayload {
    estimated_tokens: number;
    token_budget: number;
    compression_tier: 'full' | 'medium' | 'aggressive' | 'emergency';
    item_count: number;
}

export interface ModelFallbackPayload {
    from_model: string;
    to_model: string;
    reason: string; // The error code that triggered the fallback
    provider: string; // The new provider name
}

export interface NetworkCheckedPayload {
    domain: string;
    mode: 'off' | 'approved-only' | 'open';
    decision: 'allow' | 'confirm' | 'deny';
    reason: string;
    source: 'url' | 'shell' | 'browser';
}

export interface ErrorPayload {
    code: string;
    message: string;
    context?: Record<string, unknown>;
}

// --- Payload map (event_type → payload type) ---

export interface EventPayloadMap {
    'session.started': SessionStartedPayload;
    'session.ended': SessionEndedPayload;
    'turn.started': TurnStartedPayload;
    'turn.ended': TurnEndedPayload;
    'llm.request': LlmRequestPayload;
    'llm.response': LlmResponsePayload;
    'tool.invoked': ToolInvokedPayload;
    'tool.completed': ToolCompletedPayload;
    'delegation.started': DelegationStartedPayload;
    'delegation.completed': DelegationCompletedPayload;
    'context.assembled': ContextAssembledPayload;
    'model.fallback': ModelFallbackPayload;
    'network.checked': NetworkCheckedPayload;
    'error': ErrorPayload;
}

// --- Full typed event (envelope + payload) ---

export type AcaEvent<T extends EventType = EventType> = EventEnvelope & {
    payload: T extends keyof EventPayloadMap ? EventPayloadMap[T] : never;
};

// --- Current schema version ---

export const CURRENT_SCHEMA_VERSION = 1;
