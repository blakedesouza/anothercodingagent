import { createEvent, type EventSink } from '../core/event-sink.js';
import type {
    ContextAssembledEvent,
    LlmRequestEvent,
    LlmResponseEvent,
    RuntimeErrorEvent,
    ToolCompletedEvent,
    ToolStartedEvent,
    TurnEndedEvent,
    TurnEngine,
    TurnStartedEvent,
} from '../core/turn-engine.js';
import type { SessionId } from '../types/ids.js';

export interface RuntimeEventBindingOptions {
    engine: TurnEngine;
    sessionId: SessionId;
    agentId: string;
    sinks: EventSink[];
}

export interface RuntimeEventBinding {
    dispose(): void;
}

export function bindRuntimeObservability(options: RuntimeEventBindingOptions): RuntimeEventBinding {
    const { engine, sessionId, agentId } = options;
    const sinks = options.sinks.filter(Boolean);
    let activeTurnNumber = 0;

    const emitToSinks = (event: ReturnType<typeof createEvent>): void => {
        for (const sink of sinks) {
            sink.emit(event);
        }
    };

    const onTurnStarted = (event: TurnStartedEvent): void => {
        activeTurnNumber = event.turnNumber;
        emitToSinks(createEvent('turn.started', sessionId, event.turnNumber, agentId, {
            turn_id: event.turnId,
            input_preview: event.inputPreview,
        }));
    };

    const onContextAssembled = (event: ContextAssembledEvent): void => {
        emitToSinks(createEvent('context.assembled', sessionId, event.turnNumber, agentId, {
            estimated_tokens: event.estimatedTokens,
            token_budget: event.tokenBudget,
            compression_tier: event.compressionTier,
            item_count: event.itemCount,
        }));
    };

    const onLlmRequest = (event: LlmRequestEvent): void => {
        emitToSinks(createEvent('llm.request', sessionId, event.turnNumber, agentId, {
            model: event.model,
            provider: event.provider,
            estimated_input_tokens: event.estimatedInputTokens,
            tool_count: event.toolCount,
        }));
    };

    const onLlmResponse = (event: LlmResponseEvent): void => {
        emitToSinks(createEvent('llm.response', sessionId, event.turnNumber, agentId, {
            model: event.model,
            provider: event.provider,
            tokens_in: event.tokensIn,
            tokens_out: event.tokensOut,
            latency_ms: event.latencyMs,
            finish_reason: event.finishReason,
            cost_usd: event.costUsd,
        }));
    };

    const onToolStarted = (event: ToolStartedEvent): void => {
        emitToSinks(createEvent('tool.invoked', sessionId, activeTurnNumber, agentId, {
            tool_name: event.toolName,
            args_summary: summarizeArgs(event.arguments),
            correlation_id: event.toolCallId,
        }));
    };

    const onToolCompleted = (event: ToolCompletedEvent): void => {
        emitToSinks(createEvent('tool.completed', sessionId, activeTurnNumber, agentId, {
            tool_name: event.toolName,
            status: event.output.status,
            duration_ms: event.durationMs,
            bytes_returned: event.output.bytesReturned,
            correlation_id: event.toolCallId,
        }));
        if (event.output.status === 'error' && event.output.error) {
            emitToSinks(createEvent('error', sessionId, activeTurnNumber, agentId, {
                code: event.output.error.code,
                message: event.output.error.message,
                context: { tool_name: event.toolName },
            }));
        }
    };

    const onModelFallback = (event: {
        from_model: string;
        to_model: string;
        reason: string;
        provider: string;
    }): void => {
        emitToSinks(createEvent('model.fallback', sessionId, activeTurnNumber, agentId, event));
    };

    const onRuntimeError = (event: RuntimeErrorEvent): void => {
        emitToSinks(createEvent('error', sessionId, event.turnNumber, agentId, {
            code: event.code,
            message: event.message,
            ...(event.context ? { context: event.context } : {}),
        }));
    };

    const onTurnEnded = (event: TurnEndedEvent): void => {
        emitToSinks(createEvent('turn.ended', sessionId, event.turnNumber, agentId, {
            turn_id: event.turnId,
            outcome: event.outcome,
            step_count: event.stepCount,
            tokens_in: event.tokensIn,
            tokens_out: event.tokensOut,
            duration_ms: event.durationMs,
        }));
    };

    engine.on('turn.started', onTurnStarted);
    engine.on('context.assembled', onContextAssembled);
    engine.on('llm.request', onLlmRequest);
    engine.on('llm.response', onLlmResponse);
    engine.on('tool.started', onToolStarted);
    engine.on('tool.completed', onToolCompleted);
    engine.on('model.fallback', onModelFallback);
    engine.on('runtime.error', onRuntimeError);
    engine.on('turn.ended', onTurnEnded);

    return {
        dispose(): void {
            engine.off('turn.started', onTurnStarted);
            engine.off('context.assembled', onContextAssembled);
            engine.off('llm.request', onLlmRequest);
            engine.off('llm.response', onLlmResponse);
            engine.off('tool.started', onToolStarted);
            engine.off('tool.completed', onToolCompleted);
            engine.off('model.fallback', onModelFallback);
            engine.off('runtime.error', onRuntimeError);
            engine.off('turn.ended', onTurnEnded);
        },
    };
}

function summarizeArgs(args: Record<string, unknown>): string {
    const raw = JSON.stringify(args);
    if (raw.length <= 120) return raw;
    return `${raw.slice(0, 119)}…`;
}
