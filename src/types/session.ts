import type { SessionId, TurnId, StepId, WorkspaceId } from './ids.js';

// --- Turn outcomes (9 values per Block 5) ---

export type TurnOutcome =
    | 'assistant_final'
    | 'awaiting_user'
    | 'approval_required'
    | 'max_steps'
    | 'max_consecutive_tools'
    | 'tool_error'
    | 'cancelled'
    | 'aborted'
    | 'budget_exceeded';

// --- Step record ---

export interface ContextStats {
    tokenCount: number;
    tokenLimit: number;
    compressionTier: 'none' | 'trim' | 'summarize' | 'aggressive';
    systemPromptFingerprint: string;
}

export interface StepRecord {
    id: StepId;
    turnId: TurnId;
    model: string;
    provider: string;
    inputItemSeqs: number[];
    outputItemSeqs: number[];
    finishReason: string;
    contextStats: ContextStats;
    tokenUsage: TokenUsage;
    timestamp: string;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
}

// --- Turn record ---

export type TurnStatus = 'active' | 'completed' | 'cancelled';

export interface TurnRecord {
    id: TurnId;
    sessionId: SessionId;
    turnNumber: number;
    status: TurnStatus;
    outcome?: TurnOutcome;
    itemSeqStart: number;
    itemSeqEnd: number;
    steps: StepRecord[];
    startedAt: string;
    completedAt?: string;
}

// --- Session ---

export type SessionStatus = 'active' | 'paused' | 'completed' | 'aborted';

export interface Session {
    id: SessionId;
    workspaceId: WorkspaceId;
    parentSessionId?: SessionId;
    rootSessionId?: SessionId;
    status: SessionStatus;
    model: string;
    provider: string;
    turns: TurnRecord[];
    currentTurnNumber: number;
    nextItemSeq: number;
    createdAt: string;
    lastActivityAt: string;
    label?: string;
}
