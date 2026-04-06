import { generateId } from '../types/ids.js';
import type { SessionId, TurnId, StepId, ItemId, ToolCallId } from '../types/ids.js';
import type { SecretScrubber } from '../permissions/secret-scrubber.js';
import type { TurnOutcome, TurnRecord, StepRecord, TokenUsage } from '../types/session.js';
import type {
    ConversationItem,
    MessageItem,
    ToolResultItem,
    TextPart,
    ToolCallPart,
    AssistantPart,
    ToolOutput,
} from '../types/conversation.js';
import type {
    ProviderDriver,
    ModelRequest,
    RequestMessage,
    StreamEvent,
    ToolDefinition,
} from '../types/provider.js';
import type { ToolContext } from '../tools/tool-registry.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolRunner } from '../tools/tool-runner.js';
import type { ConversationWriter } from './conversation-writer.js';
import type { SequenceGenerator } from '../types/sequence.js';
import type { ProviderRegistry } from '../providers/provider-registry.js';
import type { CostTracker } from '../observability/cost-tracker.js';
import { calculateCost } from '../observability/cost-tracker.js';
import { getModelCapabilities, resolveModel } from '../providers/model-registry.js';
import type { NetworkPolicy } from '../permissions/network-policy.js';
import type { ResolvedConfig } from '../config/schema.js';
import type { SessionGrantStore } from '../permissions/session-grants.js';
import {
    resolveApproval,
    formatApprovalPrompt,
    parseApprovalResponse,
    type ApprovalRequest,
} from '../permissions/approval.js';
import { analyzeCommand } from '../tools/command-risk-analyzer.js';
import type { CommandRiskAssessment } from '../tools/command-risk-analyzer.js';
import type { CapabilityHealthMap } from './capability-health.js';
import type { CheckpointManager, CheckpointMetadata } from '../checkpointing/checkpoint-manager.js';
import type { MetricsAccumulator } from '../observability/telemetry.js';
import { EventEmitter } from 'node:events';

// --- Error codes that trigger model fallback (provider-level failures only) ---
// TODO(M5.x): Add retry-before-fallback logic. Per spec, fallback occurs "after retry
// exhaustion". Currently we fall back on the first occurrence of a trigger code with
// no retries. Retry-within-provider logic is deferred to a future substep.
const FALLBACK_TRIGGER_CODES = new Set([
    'llm.rate_limit',
    'llm.server_error',
    'llm.timeout',
]);

// --- Confusion limit constants ---
export const CONFUSION_CONSECUTIVE_THRESHOLD = 3;
export const CONFUSION_SESSION_THRESHOLD = 10;
export const CONFUSION_SYSTEM_MESSAGE = 'Tool call accuracy has been low this session. Use simpler, single-tool approaches. Verify tool names and parameter schemas before calling.';
// Tool errors that count toward the "consecutive confusion" counter. After
// CONFUSION_CONSECUTIVE_THRESHOLD (3) consecutive errors in this set, the turn
// yields with llm.confused — the faster, more informative backstop for
// non-interactive runs where maxSteps/maxConsecutive are Infinity.
//
// Widened in M10.1c (from {not_found, validation}) to catch runaway loops on
// real tool failures: models sometimes call the same failing exec_command
// repeatedly. The counter resets on any non-confusion result, so models still
// get 3 recovery chances before the circuit breaker fires.
const CONFUSION_ERROR_CODES = new Set([
    'tool.not_found',
    'tool.validation',
    'tool.execution',
    'tool.timeout',
    'tool.crash',
]);

// --- Tool-error handling policy ---
// Per M10.1c: all tool-level errors are fed back to the model as tool_result
// items so it can learn and course-correct, rather than terminating the turn.
// Every major framework (Anthropic, OpenAI, LangChain) treats tool errors as
// conversation input, not terminal signals. The only fatal tool-layer signal
// is mutationState='indeterminate' — the workspace may be in an unknown state
// and further autonomous action is unsafe.
//
// Runaway protection is handled separately by:
//   - CONFUSION_CONSECUTIVE_THRESHOLD (3) for repeated not_found/validation
//   - CONFUSION_SESSION_THRESHOLD (10) for session-wide confusion
//   - maxStepsPerTurn / maxConsecutiveAutonomousToolSteps caps (interactive)
//   - Deadlines (non-interactive / invoke / delegation)

// --- Phase enum ---

export enum Phase {
    OpenTurn = 'OpenTurn',
    AppendUserMessage = 'AppendUserMessage',
    AssembleContext = 'AssembleContext',
    CreateStep = 'CreateStep',
    CallLLM = 'CallLLM',
    NormalizeResponse = 'NormalizeResponse',
    AppendAssistantMessage = 'AppendAssistantMessage',
    CheckYieldConditions = 'CheckYieldConditions',
    ValidateToolCalls = 'ValidateToolCalls',
    ExecuteToolCalls = 'ExecuteToolCalls',
    AppendToolResults = 'AppendToolResults',
    LoopOrYield = 'LoopOrYield',
}


// --- Interrupt levels ---

export type InterruptLevel = 'cancel' | 'abort';

// --- Configuration ---

export interface TurnEngineConfig {
    sessionId: SessionId;
    model: string;
    provider: string;
    interactive: boolean;
    autoConfirm: boolean;
    isSubAgent: boolean;
    workspaceRoot: string;
    promptUser?: (question: string, choices?: string[]) => Promise<string>;
    onTextDelta?: (text: string) => void;
    /** Ordered list of fallback model names to try on provider-level errors. */
    fallbackChain?: string[];
    /** Additional trusted filesystem roots from user config. */
    extraTrustedRoots?: string[];
    /** Full resolved config — required for approval flow. */
    resolvedConfig?: ResolvedConfig;
    /** Session grant store — required for approval flow. */
    sessionGrants?: SessionGrantStore;
    /** Restrict which tools the agent can use. null = all tools allowed. */
    allowedTools?: string[] | null;
    /** Optional hard cap on LLM steps for delegated/executor turns. */
    maxSteps?: number;
    /** Optional hard cap on cumulative input + output tokens for the turn. */
    maxTotalTokens?: number;
    /** Custom system messages for invoke/delegation mode (replaces default "You are a helpful coding assistant."). */
    systemMessages?: RequestMessage[];
}

// --- Turn result ---

export interface TurnResult {
    turn: TurnRecord;
    items: ConversationItem[];
    steps: StepRecord[];
    /** Last LLM stream error — set when outcome is 'aborted'. */
    lastError?: { code: string; message: string };
}

// --- Max tool calls per message ---

const MAX_TOOL_CALLS_PER_MESSAGE = 10;

function positiveIntegerLimit(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    return Math.floor(value);
}

function resolveStepLimit(config: TurnEngineConfig): number {
    return positiveIntegerLimit(config.maxSteps) ?? (config.interactive ? 25 : Infinity);
}

// --- Tools that trigger risk assessment for approval flow ---

const EXEC_TOOLS = new Set(['exec_command', 'open_session', 'session_io']);

// --- TurnEngine ---

export class TurnEngine extends EventEmitter {
    private phase: Phase = Phase.OpenTurn;
    private interrupted: InterruptLevel | null = null;
    private readonly toolRunner: ToolRunner;
    private sessionConfusionCount = 0;
    private confusionSystemMessageInjected = false;
    /** Tools masked from LLM definitions due to unavailable capability health. Refreshed each step. */
    private maskedTools = new Set<string>();

    constructor(
        private readonly providerDriver: ProviderDriver,
        private readonly toolRegistry: ToolRegistry,
        private readonly writer: ConversationWriter,
        private readonly sequenceGenerator: SequenceGenerator,
        private readonly scrubber?: SecretScrubber,
        private readonly providerRegistry?: ProviderRegistry,
        private readonly costTracker?: CostTracker,
        networkPolicy?: NetworkPolicy,
        private readonly healthMap?: CapabilityHealthMap,
        private readonly checkpointManager?: CheckpointManager,
        private readonly metricsAccumulator?: MetricsAccumulator,
    ) {
        super();
        this.toolRunner = new ToolRunner(toolRegistry, networkPolicy);
    }

    getPhase(): Phase {
        return this.phase;
    }

    getSessionConfusionCount(): number {
        return this.sessionConfusionCount;
    }

    interrupt(level: InterruptLevel): void {
        this.interrupted = level;
    }

    async executeTurn(
        config: TurnEngineConfig,
        userInput: string,
        existingItems: ConversationItem[],
    ): Promise<TurnResult> {
        this.interrupted = null;

        // Track active provider/model — may change if fallback chain is consumed.
        let activeDriver: ProviderDriver = this.providerDriver;
        let activeModel: string = config.model;
        let activeProvider: string = config.provider;
        let fallbackIndex = 0;

        const stepLimit = resolveStepLimit(config);
        const consecutiveToolLimit = config.interactive ? 10 : Infinity;
        const tokenLimit = positiveIntegerLimit(config.maxTotalTokens);

        const turnId = generateId('turn') as TurnId;
        const turnNumber = 1; // Caller should provide, but for now we derive from existing state
        const items: ConversationItem[] = [];
        const steps: StepRecord[] = [];
        let consecutiveToolSteps = 0;
        let consecutiveConfusionCount = 0;
        let beforeCheckpointCreated = false;
        let turnHasExternalEffects = false;
        let lastError: { code: string; message: string } | undefined;
        const turnFilesChanged = new Set<string>();

        // --- Phase 1: OpenTurn ---
        this.transitionTo(Phase.OpenTurn);
        const turn: TurnRecord = {
            id: turnId,
            sessionId: config.sessionId,
            turnNumber,
            status: 'active',
            itemSeqStart: this.sequenceGenerator.peek(),
            itemSeqEnd: 0,
            steps: [],
            startedAt: new Date().toISOString(),
        };
        this.writer.writeTurn(turn);

        // --- Phase 2: AppendUserMessage ---
        this.transitionTo(Phase.AppendUserMessage);
        const userMessage: MessageItem = {
            kind: 'message',
            id: generateId('item') as ItemId,
            seq: this.sequenceGenerator.next(),
            role: 'user',
            parts: [{ type: 'text', text: userInput }],
            timestamp: new Date().toISOString(),
        };
        items.push(userMessage);
        this.writer.writeItem(userMessage);

        // --- Step loop ---
        let stepNumber = 0;
        let outcome: TurnOutcome | undefined;
        let totalTurnTokens = 0;

        while (!outcome) {
            stepNumber++;

            if (this.interrupted) {
                outcome = this.interrupted === 'abort' ? 'aborted' : 'cancelled';
                break;
            }

            // --- Phase 3: AssembleContext ---
            this.transitionTo(Phase.AssembleContext);
            const allItems = [...existingItems, ...items];
            const messages = this.assembleMessages(allItems, config.systemMessages);
            const toolDefs = this.assembleToolDefinitions(config.allowedTools);

            // --- Phase 4: CreateStep ---
            this.transitionTo(Phase.CreateStep);
            const stepId = generateId('step') as StepId;
            const inputSeqs = allItems.map(i => i.seq);

            // --- Phase 5: CallLLM ---
            this.transitionTo(Phase.CallLLM);
            const request: ModelRequest = {
                model: activeModel,
                messages,
                tools: toolDefs.length > 0 ? toolDefs : undefined,
                maxTokens: 4096,
                temperature: 0.7,
            };

            const streamEvents: StreamEvent[] = [];
            let streamError: StreamEvent | null = null;
            const llmStartMs = Date.now();

            for await (const event of activeDriver.stream(request)) {
                streamEvents.push(event);
                if (event.type === 'text_delta' && config.onTextDelta) {
                    // Point 4: scrub secrets from streaming text before sending to terminal.
                    // Known limitation: a secret split across chunk boundaries is not caught
                    // because the scrubber operates on each chunk individually. A streaming-safe
                    // sliding-window buffer is planned for M7.8.
                    const displayText = this.scrubber ? this.scrubber.scrub(event.text) : event.text;
                    config.onTextDelta(displayText);
                }
                if (event.type === 'error') {
                    streamError = event;
                }
                if (this.interrupted) break;
            }

            if (this.interrupted) {
                outcome = this.interrupted === 'abort' ? 'aborted' : 'cancelled';
                break;
            }

            if (streamError && streamError.type === 'error') {
                // Record LLM error for telemetry
                this.metricsAccumulator?.recordError(streamError.error.code);

                // Attempt model fallback for provider-level errors
                if (
                    FALLBACK_TRIGGER_CODES.has(streamError.error.code) &&
                    this.providerRegistry
                ) {
                    const chain = config.fallbackChain ?? [];
                    if (fallbackIndex < chain.length) {
                        const nextModelName = chain[fallbackIndex++];
                        const resolved = this.providerRegistry.resolve(nextModelName);
                        if (resolved) {
                            const prevModel = activeModel;
                            activeDriver = resolved.driver;
                            activeModel = resolved.resolvedModelId;
                            activeProvider = resolved.config.name;
                            this.emit('model.fallback', {
                                from_model: prevModel,
                                to_model: activeModel,
                                reason: streamError.error.code,
                                provider: activeProvider,
                            });
                            continue; // retry this step with the fallback driver
                        }
                    }
                }
                lastError = { code: streamError.error.code, message: streamError.error.message };
                outcome = 'aborted';
                break;
            }

            // --- Phase 6: NormalizeResponse ---
            this.transitionTo(Phase.NormalizeResponse);
            const { textParts, toolCallParts, finishReason, tokenUsage, jsonParseFailures } =
                this.normalizeStreamEvents(streamEvents);

            // --- Phase 7: AppendAssistantMessage ---
            this.transitionTo(Phase.AppendAssistantMessage);
            const assistantParts: AssistantPart[] = [
                ...textParts,
                ...toolCallParts,
            ];

            if (assistantParts.length > 0) {
                const assistantMessage: MessageItem = {
                    kind: 'message',
                    id: generateId('item') as ItemId,
                    seq: this.sequenceGenerator.next(),
                    role: 'assistant',
                    parts: assistantParts,
                    timestamp: new Date().toISOString(),
                };
                items.push(assistantMessage);
                this.writer.writeItem(assistantMessage);
            }

            // --- Phase 8: CheckYieldConditions ---
            this.transitionTo(Phase.CheckYieldConditions);

            // Record metrics for telemetry (latency = time from stream start to normalize complete)
            const llmLatencyMs = Date.now() - llmStartMs;

            // Budget enforcement: calculate cost, record, and check limits
            const resolvedId = resolveModel(activeModel);
            const caps = resolvedId ? getModelCapabilities(resolvedId) : undefined;
            const costUsd = calculateCost(tokenUsage.inputTokens, tokenUsage.outputTokens, caps?.costPerMillion);
            totalTurnTokens += tokenUsage.inputTokens + tokenUsage.outputTokens;

            if (this.metricsAccumulator) {
                this.metricsAccumulator.recordLlmResponse(
                    tokenUsage.inputTokens, tokenUsage.outputTokens, costUsd, llmLatencyMs,
                );
            }

            if (this.costTracker) {
                const budgetResult = this.costTracker.recordCost(costUsd);
                if (budgetResult.status === 'exceeded') {
                    outcome = 'budget_exceeded';
                    const step = this.recordStep(
                        stepId, turnId, stepNumber, config, inputSeqs, items, finishReason, tokenUsage, activeModel, activeProvider,
                    );
                    steps.push(step);
                    this.writer.writeStep(step);
                    break;
                }
            }

            if (tokenLimit !== undefined && totalTurnTokens > tokenLimit) {
                outcome = 'budget_exceeded';
                const step = this.recordStep(
                    stepId, turnId, stepNumber, config, inputSeqs, items, finishReason, tokenUsage, activeModel, activeProvider,
                );
                steps.push(step);
                this.writer.writeStep(step);
                break;
            }

            // Text-only → yield with assistant_final
            if (toolCallParts.length === 0) {
                outcome = 'assistant_final';
                // Record the step before yielding
                const step = this.recordStep(
                    stepId, turnId, stepNumber, config, inputSeqs, items, finishReason, tokenUsage, activeModel, activeProvider,
                );
                steps.push(step);
                this.writer.writeStep(step);
                break;
            }

            // Step limit → yield with max_steps
            if (stepNumber >= stepLimit) {
                outcome = 'max_steps';
                const step = this.recordStep(
                    stepId, turnId, stepNumber, config, inputSeqs, items, finishReason, tokenUsage, activeModel, activeProvider,
                );
                steps.push(step);
                this.writer.writeStep(step);
                break;
            }

            // Consecutive tool limit
            consecutiveToolSteps++;
            if (consecutiveToolSteps >= consecutiveToolLimit) {
                outcome = 'max_consecutive_tools';
                const step = this.recordStep(
                    stepId, turnId, stepNumber, config, inputSeqs, items, finishReason, tokenUsage, activeModel, activeProvider,
                );
                steps.push(step);
                this.writer.writeStep(step);
                break;
            }

            // Tool calls present → continue to ValidateToolCalls

            // --- Phase 9: ValidateToolCalls ---
            this.transitionTo(Phase.ValidateToolCalls);

            // Enforce max tool calls per message
            const activeCalls = toolCallParts.slice(0, MAX_TOOL_CALLS_PER_MESSAGE);
            const deferredCalls = toolCallParts.slice(MAX_TOOL_CALLS_PER_MESSAGE);

            // Validate each tool call against registry
            const validatedCalls: Array<{ part: ToolCallPart; valid: boolean; errorCode?: string; error?: string }> = [];
            for (const part of activeCalls) {
                if (jsonParseFailures.has(part.toolCallId)) {
                    validatedCalls.push({
                        part,
                        valid: false,
                        errorCode: 'tool.validation',
                        error: `Malformed JSON in tool call arguments for "${part.toolName}"`,
                    });
                } else if (this.maskedTools.has(part.toolName)) {
                    // Tool exists but is masked because its capability is unavailable.
                    // The alternatives list must also respect the allowedTools
                    // constraint — suggesting a tool the agent isn't allowed to use
                    // would produce another tool.permission error on the next step.
                    const availableNames = this.toolRegistry.list()
                        .filter(t => !this.maskedTools.has(t.spec.name))
                        .filter(t => {
                            if (config.allowedTools === undefined || config.allowedTools === null) return true;
                            return config.allowedTools.includes(t.spec.name);
                        })
                        .map(t => t.spec.name);
                    const MAX_ALTERNATIVES = 5;
                    const altStr = availableNames.length === 0
                        ? 'No alternative tools are currently available.'
                        : availableNames.length > MAX_ALTERNATIVES
                            ? `Available alternatives: ${availableNames.slice(0, MAX_ALTERNATIVES).join(', ')}, and ${availableNames.length - MAX_ALTERNATIVES} others`
                            : `Available alternatives: ${availableNames.join(', ')}`;
                    validatedCalls.push({
                        part,
                        valid: false,
                        errorCode: 'tool.validation',
                        error: `Tool "${part.toolName}" is currently unavailable. ${altStr}`,
                    });
                } else {
                    const registered = this.toolRegistry.lookup(part.toolName);
                    if (!registered) {
                        validatedCalls.push({
                            part,
                            valid: false,
                            errorCode: 'tool.not_found',
                            error: `Unknown tool: ${part.toolName}`,
                        });
                    } else {
                        validatedCalls.push({ part, valid: true });
                    }
                }
            }

            // --- Phase 10: ExecuteToolCalls ---
            this.transitionTo(Phase.ExecuteToolCalls);

            const toolResults: ToolResultItem[] = [];
            const toolContext: Omit<ToolContext, 'signal'> = {
                sessionId: config.sessionId,
                workspaceRoot: config.workspaceRoot,
                interactive: config.interactive,
                autoConfirm: config.autoConfirm,
                isSubAgent: config.isSubAgent,
                promptUser: config.promptUser,
                extraTrustedRoots: config.extraTrustedRoots,
            };

            // Execute valid calls sequentially
            for (const { part, valid, errorCode, error } of validatedCalls) {
                if (this.interrupted) break;

                let output: ToolOutput;
                if (!valid) {
                    output = {
                        status: 'error',
                        data: '',
                        error: {
                            code: errorCode ?? 'tool.not_found',
                            message: error!,
                            retryable: false,
                        },
                        truncated: false,
                        bytesReturned: 0,
                        bytesOmitted: 0,
                        retryable: false,
                        timedOut: false,
                        mutationState: 'none',
                    };
                } else {
                    // Approval flow: resolve permission before executing
                    const approvalDenied = await this.resolveToolApproval(part, config);
                    if (approvalDenied) {
                        output = approvalDenied;
                    } else {
                        // Checkpoint hook: before first workspace-mutating tool in the turn
                        const registered = this.toolRegistry.lookup(part.toolName);
                        if (
                            this.checkpointManager &&
                            !beforeCheckpointCreated &&
                            registered &&
                            (registered.spec.approvalClass === 'workspace-write' ||
                             registered.spec.approvalClass === 'external-effect')
                        ) {
                            try {
                                await this.checkpointManager.createBeforeTurnCheckpoint(turnId, turnNumber);
                                beforeCheckpointCreated = true;
                            } catch {
                                // Checkpoint failure is non-fatal — continue without checkpoint
                            }
                        }

                        // Track external effects for undo warnings
                        if (registered && registered.spec.approvalClass === 'external-effect') {
                            turnHasExternalEffects = true;
                        }

                        output = await this.toolRunner.execute(
                            part.toolName,
                            part.arguments,
                            toolContext,
                        );

                        // Record tool call for telemetry
                        this.metricsAccumulator?.recordToolCall(part.toolName);

                        // Track mutated files for checkpoint metadata
                        if (output.mutationState === 'filesystem') {
                            const filePath = typeof part.arguments.path === 'string'
                                ? part.arguments.path
                                : typeof part.arguments.file === 'string'
                                    ? part.arguments.file
                                    : part.toolName;
                            turnFilesChanged.add(filePath);
                        }
                    }
                    // Point 1: scrub secrets from tool output before storing.
                    // Covers both output.data and output.error.message (errors can contain
                    // secrets, e.g., "Invalid API key sk-xxx: unauthorized").
                    if (this.scrubber) {
                        output = {
                            ...output,
                            data: this.scrubber.scrub(output.data),
                            ...(output.error ? {
                                error: {
                                    ...output.error,
                                    message: this.scrubber.scrub(output.error.message),
                                },
                            } : {}),
                        };
                    }
                }

                const resultItem: ToolResultItem = {
                    kind: 'tool_result',
                    id: generateId('item') as ItemId,
                    seq: this.sequenceGenerator.next(),
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    output,
                    timestamp: new Date().toISOString(),
                };
                toolResults.push(resultItem);
            }

            // Create synthetic error results for deferred calls
            const deferredNames = deferredCalls.map(d => d.toolName).join(', ');
            for (const part of deferredCalls) {
                const resultItem: ToolResultItem = {
                    kind: 'tool_result',
                    id: generateId('item') as ItemId,
                    seq: this.sequenceGenerator.next(),
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    output: {
                        status: 'error',
                        data: '',
                        error: {
                            code: 'tool.deferred',
                            message: `Tool call deferred: max ${MAX_TOOL_CALLS_PER_MESSAGE} calls per message. Deferred tools: ${deferredNames}`,
                            retryable: false,
                        },
                        truncated: false,
                        bytesReturned: 0,
                        bytesOmitted: 0,
                        retryable: false,
                        timedOut: false,
                        mutationState: 'none',
                    },
                    timestamp: new Date().toISOString(),
                };
                toolResults.push(resultItem);
            }

            // --- Confusion tracking ---
            // Count ALL results for session total (no early break).
            // Non-confusion results (success OR non-confusion errors like execution
            // failures) reset the consecutive counter — the model demonstrated it
            // can make valid tool calls, breaking the "invalid" chain.
            let confusionYield = false;
            let confusionThresholdIndex = -1;
            for (let i = 0; i < toolResults.length; i++) {
                const result = toolResults[i];
                const isConfusion = result.output.status === 'error'
                    && result.output.error != null
                    && CONFUSION_ERROR_CODES.has(result.output.error.code);

                // Record tool errors for telemetry
                if (result.output.status === 'error' && result.output.error) {
                    this.metricsAccumulator?.recordError(result.output.error.code);
                }

                if (isConfusion) {
                    consecutiveConfusionCount++;
                    this.sessionConfusionCount++;
                    if (consecutiveConfusionCount >= CONFUSION_CONSECUTIVE_THRESHOLD && confusionThresholdIndex === -1) {
                        confusionThresholdIndex = i;
                    }
                } else {
                    consecutiveConfusionCount = 0;
                }
            }

            if (confusionThresholdIndex >= 0) {
                toolResults[confusionThresholdIndex].output = {
                    ...toolResults[confusionThresholdIndex].output,
                    error: {
                        code: 'llm.confused',
                        message: `Model made ${CONFUSION_CONSECUTIVE_THRESHOLD} consecutive invalid tool calls`,
                        retryable: false,
                    },
                };
                confusionYield = true;
            }

            if (this.sessionConfusionCount >= CONFUSION_SESSION_THRESHOLD && !this.confusionSystemMessageInjected) {
                this.confusionSystemMessageInjected = true;
            }

            // --- Phase 11: AppendToolResults ---
            this.transitionTo(Phase.AppendToolResults);
            for (const result of toolResults) {
                items.push(result);
                this.writer.writeItem(result);
            }

            // Record step
            const step = this.recordStep(
                stepId, turnId, stepNumber, config, inputSeqs, items, finishReason, tokenUsage,
            );
            steps.push(step);
            this.writer.writeStep(step);

            // --- Phase 12: LoopOrYield ---
            this.transitionTo(Phase.LoopOrYield);

            // Confusion threshold reached → yield immediately
            if (confusionYield) {
                outcome = 'tool_error';
                break;
            }

            // Check for yieldOutcome from tool results
            for (const result of toolResults) {
                if (result.output.yieldOutcome) {
                    outcome = result.output.yieldOutcome;
                    break;
                }
            }
            if (outcome) break;

            // Per M10.1c: tool-level errors (status='error') are fed back to
            // the model on the next step so it can course-correct — we do NOT
            // terminate the turn on a non-retryable tool error. The only fatal
            // tool-layer signal is indeterminate mutation state, which means
            // the workspace may be in an unknown state and further autonomous
            // action is unsafe. Runaway protection lives in the confusion
            // counter and step/deadline caps (see CONFUSION_ERROR_CODES).
            for (const result of toolResults) {
                if (result.output.mutationState === 'indeterminate') {
                    // In autoConfirm mode, successful tools with indeterminate mutation
                    // state (e.g. exec_command) should not terminate the turn — the caller
                    // has explicitly trusted the agent to execute tools without confirmation.
                    if (config.autoConfirm && result.output.status === 'success') continue;
                    outcome = 'tool_error';
                    break;
                }
            }
            if (outcome) break;

            // Tool results appended → loop back to AssembleContext
            // (consecutiveToolSteps already incremented above)
        }

        // Create afterTurn checkpoint if a beforeTurn was created
        if (this.checkpointManager && beforeCheckpointCreated) {
            try {
                const metadata: CheckpointMetadata = {
                    turnId,
                    turnNumber,
                    filesChanged: [...turnFilesChanged],
                    hasExternalEffects: turnHasExternalEffects,
                    timestamp: new Date().toISOString(),
                };
                await this.checkpointManager.createAfterTurnCheckpoint(metadata);
            } catch {
                // Checkpoint failure is non-fatal
            }
        }

        // Finalize turn
        const completedTurn: TurnRecord = {
            ...turn,
            status: 'completed',
            outcome: outcome!,
            itemSeqEnd: this.sequenceGenerator.value(),
            steps,
            completedAt: new Date().toISOString(),
        };

        // Write completed turn record
        this.writer.writeTurn(completedTurn);

        return {
            turn: completedTurn,
            items,
            steps,
            lastError,
        };
    }

    // --- Private helpers ---

    private transitionTo(phase: Phase): void {
        this.phase = phase;
        this.emit('phase', phase);
    }

    private assembleMessages(items: ConversationItem[], systemMessages?: RequestMessage[]): RequestMessage[] {
        const messages: RequestMessage[] = [];

        // System prompt: use caller-provided messages (invoke/delegation) or default
        if (systemMessages && systemMessages.length > 0) {
            messages.push(...systemMessages);
        } else {
            messages.push({
                role: 'system',
                content: 'You are a helpful coding assistant.',
            });
        }

        // Confusion system message (injected when session confusion threshold reached)
        if (this.confusionSystemMessageInjected) {
            messages.push({
                role: 'system',
                content: CONFUSION_SYSTEM_MESSAGE,
            });
        }

        for (const item of items) {
            if (item.kind === 'message') {
                if (item.role === 'system') continue; // We already added a system prompt
                if (item.role === 'user') {
                    const rawText = (item.parts as AssistantPart[])
                        .filter((p): p is TextPart => p.type === 'text')
                        .map(p => p.text)
                        .join('\n');
                    // Point 2: scrub secrets from user messages before sending to LLM
                    const text = this.scrubber ? this.scrubber.scrub(rawText) : rawText;
                    messages.push({ role: 'user', content: text });
                } else if (item.role === 'assistant') {
                    const parts = item.parts as AssistantPart[];
                    const textParts = parts.filter((p): p is TextPart => p.type === 'text');
                    const toolParts = parts.filter((p): p is ToolCallPart => p.type === 'tool_call');

                    if (toolParts.length > 0) {
                        // Assistant message with tool calls → use content parts format
                        const contentParts = [];
                        for (const tp of textParts) {
                            contentParts.push({ type: 'text' as const, text: tp.text });
                        }
                        for (const tc of toolParts) {
                            contentParts.push({
                                type: 'tool_call' as const,
                                toolCallId: tc.toolCallId,
                                toolName: tc.toolName,
                                arguments: tc.arguments,
                            });
                        }
                        messages.push({ role: 'assistant', content: contentParts });
                    } else {
                        const text = textParts.map(p => p.text).join('\n');
                        messages.push({ role: 'assistant', content: text });
                    }
                }
            } else if (item.kind === 'tool_result') {
                // Point 2: scrub secrets from tool results before adding to LLM context
                const toolData = this.scrubber ? this.scrubber.scrub(item.output.data) : item.output.data;
                messages.push({
                    role: 'tool',
                    content: JSON.stringify({
                        status: item.output.status,
                        data: toolData,
                        error: item.output.error,
                    }),
                    toolCallId: item.toolCallId,
                });
            } else if (item.kind === 'summary') {
                // Include summaries as system-role messages
                messages.push({
                    role: 'system',
                    content: `[Summary of earlier conversation]\n${item.text}`,
                });
            }
        }

        return messages;
    }

    private assembleToolDefinitions(allowedTools?: string[] | null): ToolDefinition[] {
        const tools = this.toolRegistry.list();

        // Refresh masked tools based on capability health
        this.maskedTools.clear();
        if (this.healthMap) {
            const masked = this.healthMap.getMaskedToolNames(tools);
            for (const name of masked) this.maskedTools.add(name);
        }

        // Filter by capability-health masking, then by allowedTools constraint.
        // Don't present tools the agent can't use: reduces confusion and
        // improves tool-call accuracy (Anthropic observed 49%→74% uplift with
        // tool-count reduction). Qwen3-Coder has a known bug with >5 tools
        // where it falls back to XML format.
        return tools
            .filter(tool => !this.maskedTools.has(tool.spec.name))
            .filter(tool => {
                if (allowedTools === undefined || allowedTools === null) return true;
                return allowedTools.includes(tool.spec.name);
            })
            .map(tool => ({
                name: tool.spec.name,
                description: tool.spec.description,
                parameters: tool.spec.inputSchema,
            }));
    }

    private normalizeStreamEvents(events: StreamEvent[]): {
        textParts: TextPart[];
        toolCallParts: ToolCallPart[];
        finishReason: string;
        tokenUsage: TokenUsage;
        jsonParseFailures: Set<string>;
    } {
        let fullText = '';
        // Insertion-ordered list of accumulated tool calls. We DO NOT key on
        // `event.index` alone because some providers (notably the NanoGPT
        // gemma-4-31b-it short-id backend) emit parallel tool calls with all
        // index=0 but distinct ids — keying on index would merge them into a
        // single entry, concatenating multiple JSON arg blobs into garbage and
        // tripping the JSON.parse failure path. Instead we maintain a
        // `currentSlotByIndex` map that tracks which slot the next chunk for
        // a given index should accumulate into, and we allocate a new slot
        // whenever an incoming delta carries an `id` that conflicts with the
        // existing slot's id (collision = new tool call).
        const toolCallSlots: Array<{ name: string; arguments: string; id?: string }> = [];
        const currentSlotByIndex = new Map<number, number>();
        let finishReason = 'stop';
        let tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

        for (const event of events) {
            switch (event.type) {
                case 'text_delta':
                    fullText += event.text;
                    break;
                case 'tool_call_delta': {
                    const slotIdx = currentSlotByIndex.get(event.index);
                    let existing = slotIdx !== undefined ? toolCallSlots[slotIdx] : undefined;

                    // Collision: an existing slot at this index has an id that
                    // differs from the incoming delta's id. Allocate a fresh slot.
                    // Standard OpenAI streaming sends `id` only on the FIRST
                    // chunk of each tool call, so later chunks with no `id` will
                    // never trigger this branch (deltaId is undefined → falsy).
                    const isCollision =
                        existing !== undefined &&
                        existing.id !== undefined &&
                        event.id !== undefined &&
                        existing.id !== event.id;

                    if (existing === undefined || isCollision) {
                        existing = { name: '', arguments: '', id: event.id };
                        toolCallSlots.push(existing);
                        currentSlotByIndex.set(event.index, toolCallSlots.length - 1);
                    } else if (event.id !== undefined && existing.id === undefined) {
                        // Adopt the id if a later chunk happens to carry it.
                        existing.id = event.id;
                    }

                    if (event.name) existing.name = event.name;
                    if (event.arguments) existing.arguments += event.arguments;
                    break;
                }
                case 'done':
                    finishReason = event.finishReason;
                    tokenUsage = event.usage;
                    break;
                case 'error':
                    // Errors are handled by the caller
                    break;
            }
        }

        const textParts: TextPart[] = [];
        if (fullText.length > 0) {
            textParts.push({ type: 'text', text: fullText });
        }

        const toolCallParts: ToolCallPart[] = [];
        const jsonParseFailures = new Set<string>();
        for (const accum of toolCallSlots) {
            let args: Record<string, unknown> = {};
            let parseFailure = false;
            try {
                args = JSON.parse(accum.arguments || '{}');
            } catch {
                args = {};
                parseFailure = true;
            }
            const toolCallId = generateId('toolCall') as ToolCallId;
            toolCallParts.push({
                type: 'tool_call',
                toolCallId,
                toolName: accum.name,
                arguments: args,
            });
            if (parseFailure) {
                jsonParseFailures.add(toolCallId);
            }
        }

        return { textParts, toolCallParts, finishReason, tokenUsage, jsonParseFailures };
    }

    private recordStep(
        stepId: StepId,
        turnId: TurnId,
        stepNumber: number,
        config: TurnEngineConfig,
        inputSeqs: number[],
        items: ConversationItem[],
        finishReason: string,
        tokenUsage: TokenUsage,
        modelOverride?: string,
        providerOverride?: string,
    ): StepRecord {
        const outputSeqs = items
            .filter(i => !inputSeqs.includes(i.seq))
            .map(i => i.seq);

        return {
            id: stepId,
            turnId,
            stepNumber,
            model: modelOverride ?? config.model,
            provider: providerOverride ?? config.provider,
            inputItemSeqs: inputSeqs,
            outputItemSeqs: outputSeqs,
            finishReason,
            contextStats: {
                tokenCount: tokenUsage.inputTokens + tokenUsage.outputTokens,
                tokenLimit: 128_000, // Placeholder for v1
                compressionTier: 'none',
                systemPromptFingerprint: 'v1',
            },
            tokenUsage,
            timestamp: new Date().toISOString(),
        };
    }

    /**
     * Resolve approval for a tool call before execution.
     * Returns a ToolOutput error if denied, or null if approved.
     */
    private async resolveToolApproval(
        part: ToolCallPart,
        config: TurnEngineConfig,
    ): Promise<ToolOutput | null> {
        // Enforce allowedTools constraint even without full approval flow
        if (config.allowedTools !== undefined && config.allowedTools !== null) {
            if (!config.allowedTools.includes(part.toolName)) {
                return {
                    status: 'error',
                    data: '',
                    error: {
                        code: 'tool.permission',
                        message: `Denied: not permitted by allowed_tools constraint`,
                        retryable: false,
                    },
                    truncated: false,
                    bytesReturned: 0,
                    bytesOmitted: 0,
                    retryable: false,
                    timedOut: false,
                    mutationState: 'none',
                };
            }
        }

        // Full approval flow requires config + session grants
        if (!config.resolvedConfig || !config.sessionGrants) return null;

        const registered = this.toolRegistry.lookup(part.toolName);
        if (!registered) return null; // Already handled by validation

        // Compute risk assessment for exec/session tools
        let riskAssessment: CommandRiskAssessment | undefined;
        if (EXEC_TOOLS.has(part.toolName)) {
            const command = part.toolName === 'session_io'
                ? (typeof part.arguments.stdin === 'string' ? part.arguments.stdin : '')
                : (typeof part.arguments.command === 'string' ? part.arguments.command : '');
            const cwd = typeof part.arguments.cwd === 'string'
                ? part.arguments.cwd
                : config.workspaceRoot;
            if (command) {
                riskAssessment = analyzeCommand(command, cwd, undefined, config.workspaceRoot);
            }
        }

        const request: ApprovalRequest = {
            toolName: part.toolName,
            toolArgs: part.arguments,
            approvalClass: registered.spec.approvalClass,
            riskAssessment,
        };

        const result = resolveApproval(request, {
            config: config.resolvedConfig,
            sessionGrants: config.sessionGrants,
            noConfirm: config.autoConfirm,
            allowedTools: config.allowedTools,
        });

        if (result.decision === 'allow') return null;

        if (result.decision === 'deny') {
            return {
                status: 'error',
                data: '',
                error: {
                    code: 'tool.permission',
                    message: `Denied: ${result.reason}`,
                    retryable: false,
                },
                truncated: false,
                bytesReturned: 0,
                bytesOmitted: 0,
                retryable: false,
                timedOut: false,
                mutationState: 'none',
            };
        }

        // confirm or confirm_always — prompt user
        // Check promptUser only (not interactive) so one-shot mode with TTY can prompt
        if (!config.promptUser) {
            return {
                status: 'error',
                data: '',
                error: {
                    code: 'tool.permission',
                    message: `Requires confirmation but no interactive prompt available: ${result.reason}`,
                    retryable: false,
                },
                truncated: false,
                bytesReturned: 0,
                bytesOmitted: 0,
                retryable: false,
                timedOut: false,
                mutationState: 'none',
            };
        }

        const prompt = formatApprovalPrompt(request, riskAssessment);
        const response = await config.promptUser(prompt);
        const parsed = parseApprovalResponse(response);

        if (parsed.choice === 'approve') return null;
        if (parsed.choice === 'always') {
            // Extract command for exec tools session grant
            const command = EXEC_TOOLS.has(part.toolName)
                ? (part.toolName === 'session_io'
                    ? (typeof part.arguments.stdin === 'string' ? part.arguments.stdin : undefined)
                    : (typeof part.arguments.command === 'string' ? part.arguments.command : undefined))
                : undefined;
            config.sessionGrants.addGrant(part.toolName, command);
            return null;
        }

        // deny or edit (edit not yet supported — treat as deny)
        return {
            status: 'error',
            data: '',
            error: {
                code: 'tool.permission',
                message: 'User denied the operation',
                retryable: false,
            },
            truncated: false,
            bytesReturned: 0,
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        };
    }
}
