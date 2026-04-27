import { generateId } from '../types/ids.js';
import { sanitizeModelJson } from '../providers/tool-emulation.js';
import type { SessionId, TurnId, StepId, ItemId, ToolCallId } from '../types/ids.js';
import type { SecretScrubber } from '../permissions/secret-scrubber.js';
import type { TurnOutcome, TurnRecord, StepRecord, StepSafetyStats, TokenUsage } from '../types/session.js';
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
    ModelResponseFormat,
} from '../types/provider.js';
import type { ToolContext } from '../tools/tool-registry.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { RegisteredTool } from '../tools/tool-registry.js';
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
import { normalizeToolArguments } from '../tools/tool-argument-normalizer.js';
import type { CommandRiskAssessment } from '../tools/command-risk-analyzer.js';
import { evaluateShellNetworkAccess } from '../permissions/network-policy.js';
import type { CapabilityHealthMap } from './capability-health.js';
import type { CheckpointManager, CheckpointMetadata } from '../checkpointing/checkpoint-manager.js';
import type { MetricsAccumulator } from '../observability/telemetry.js';
import { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { estimateRequestTokens } from './token-estimator.js';
import { preparePrompt } from './prompt-assembly.js';
import { computeBackoff, getRetryPolicy } from './retry-policy.js';
import type { RetryPolicy } from './retry-policy.js';
import type {
    CapabilityHealth,
    DurableTaskSummary,
    PromptAssemblyStats,
    WorkingSetEntry,
} from './prompt-assembly.js';
import type { ProjectSnapshot } from './project-awareness.js';
import { resolveToolPath } from '../tools/workspace-sandbox.js';

// --- Error codes that trigger model fallback (provider-level failures only) ---
// TODO(M5.x): Add retry-before-fallback logic. Per spec, fallback occurs "after retry
// exhaustion". Currently we fall back on the first occurrence of a trigger code with
// no retries. Retry-within-provider logic is deferred to a future substep.
const FALLBACK_TRIGGER_CODES = new Set([
    'llm.rate_limit',
    'llm.rate_limited',
    'llm.server_error',
    'llm.timeout',
    'llm.malformed_response',
]);

function shouldRetryLlmStep(
    _code: string,
    attempts: number,
    policy: RetryPolicy | undefined,
): policy is RetryPolicy {
    return policy !== undefined && policy.maxAttempts > 1 && attempts < policy.maxAttempts;
}

function sleep(ms: number): Promise<void> {
    return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

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
    /** Additional invoke/delegation authority rules. Deny rules are enforced even without interactive approval flow. */
    authority?: Array<{
        tool: string;
        args_match?: Record<string, unknown>;
        decision: 'approve' | 'deny';
    }>;
    /** Optional hard cap on LLM steps for delegated/executor turns. */
    maxSteps?: number;
    /** Optional hard cap on total accepted tool calls for the turn. */
    maxToolCalls?: number;
    /** Optional hard caps on accepted tool calls by tool name. */
    maxToolCallsByName?: Record<string, number>;
    /** Optional hard cap on cumulative tool-result data bytes for the turn. */
    maxToolResultBytes?: number;
    /** Optional hard cap on estimated input tokens before each LLM request. */
    maxInputTokens?: number;
    /** Optional hard cap on overlapping read_file calls for the same file/range. */
    maxRepeatedReadCalls?: number;
    /** Optional hard cap on cumulative input + output tokens for the turn. */
    maxTotalTokens?: number;
    /** Optional model sampling temperature override. */
    temperature?: number;
    /** Optional model nucleus sampling override. */
    topP?: number;
    /** Optional provider-specific thinking mode override. */
    thinking?: { type: 'enabled' | 'disabled' };
    /** Optional provider structured-output response format. */
    responseFormat?: ModelResponseFormat;
    /** Custom system messages for invoke/delegation mode (replaces default "You are a helpful coding assistant."). */
    systemMessages?: RequestMessage[];
    /** Optional shell name for prompt context assembly. */
    shell?: string;
    /** Optional project snapshot for prompt context assembly. */
    projectSnapshot?: ProjectSnapshot;
    /** Optional working set for prompt context assembly. */
    workingSet?: WorkingSetEntry[];
    /** Optional durable task summary for prompt context assembly. */
    durableTaskState?: DurableTaskSummary;
    /** Optional capability health entries for prompt context assembly. */
    capabilities?: CapabilityHealth[];
    /** Optional repo/user instruction text for prompt context assembly. */
    userInstructions?: string;
    /** Optional active errors to pin into prompt context. */
    activeErrors?: string[];
}

// --- Turn result ---

export interface TurnResult {
    turn: TurnRecord;
    items: ConversationItem[];
    steps: StepRecord[];
    /** Last LLM stream error — set when outcome is 'aborted'. */
    lastError?: { code: string; message: string };
}

export interface MutationRenderPreview {
    filePath: string;
    oldContent: string;
    newContent: string;
    isNewFile: boolean;
}

export interface TurnStartedEvent {
    turnId: TurnId;
    turnNumber: number;
    inputPreview: string;
}

export interface TurnEndedEvent {
    turnId: TurnId;
    turnNumber: number;
    outcome: TurnOutcome;
    stepCount: number;
    tokensIn: number;
    tokensOut: number;
    durationMs: number;
}

export interface ContextAssembledEvent {
    turnNumber: number;
    estimatedTokens: number;
    tokenBudget: number;
    compressionTier: 'full' | 'medium' | 'aggressive' | 'emergency';
    itemCount: number;
}

export interface LlmRequestEvent {
    turnNumber: number;
    model: string;
    provider: string;
    estimatedInputTokens: number;
    toolCount: number;
}

export interface LlmResponseEvent {
    turnNumber: number;
    model: string;
    provider: string;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    finishReason: string;
    costUsd: number | null;
}

export interface RuntimeErrorEvent {
    turnNumber: number;
    code: string;
    message: string;
    context?: Record<string, unknown>;
}

export interface ToolStartedEvent {
    toolCallId: ToolCallId;
    toolName: string;
    arguments: Record<string, unknown>;
}

export interface ToolCompletedEvent {
    toolCallId: ToolCallId;
    toolName: string;
    arguments: Record<string, unknown>;
    output: ToolOutput;
    durationMs: number;
    renderPreview?: MutationRenderPreview;
}

// --- Max tool calls per message ---

const MAX_TOOL_CALLS_PER_MESSAGE = 10;
const MAX_RENDER_PREVIEW_BYTES = 256 * 1024;

function positiveIntegerLimit(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    return Math.floor(value);
}

function positiveIntegerLimitMap(value: Record<string, number> | undefined): Map<string, number> {
    const limits = new Map<string, number>();
    if (!value) return limits;
    for (const [toolName, rawLimit] of Object.entries(value)) {
        const limit = positiveIntegerLimit(rawLimit);
        if (limit !== undefined) limits.set(toolName, limit);
    }
    return limits;
}

function mapToRecord(map: Map<string, number>): Record<string, number> {
    return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function deriveTurnNumber(existingItems: readonly ConversationItem[]): number {
    return existingItems.filter(
        (item) => item.kind === 'message' && item.role === 'user',
    ).length + 1;
}

interface ReadRange {
    path: string;
    start: number;
    end: number;
}

function readRangeFor(part: ToolCallPart): ReadRange | null {
    if (part.toolName !== 'read_file') return null;
    const path = part.arguments.path;
    if (typeof path !== 'string') return null;
    const rawStart = part.arguments.line_start;
    const rawEnd = part.arguments.line_end;
    const start = typeof rawStart === 'number' && Number.isFinite(rawStart)
        ? Math.max(1, Math.floor(rawStart))
        : 1;
    const end = typeof rawEnd === 'number' && Number.isFinite(rawEnd)
        ? Math.max(start, Math.floor(rawEnd))
        : Number.MAX_SAFE_INTEGER;
    return { path, start, end };
}

function rangesOverlap(a: ReadRange, b: ReadRange): boolean {
    return a.path === b.path && a.start <= b.end && b.start <= a.end;
}

function dataBytes(data: string): number {
    return Buffer.byteLength(data, 'utf8');
}

interface PendingMutationPreview {
    filePath: string;
    absolutePath: string;
    oldContent: string;
    isNewFile: boolean;
}

async function captureMutationPreviewBaseline(
    part: ToolCallPart,
    config: TurnEngineConfig,
): Promise<PendingMutationPreview | null> {
    if ((part.toolName !== 'write_file' && part.toolName !== 'edit_file') || typeof part.arguments.path !== 'string') {
        return null;
    }

    const filePath = part.arguments.path;
    const absolutePath = resolveToolPath(filePath, { workspaceRoot: config.workspaceRoot });

    try {
        const fileStat = await stat(absolutePath);
        if (!fileStat.isFile() || fileStat.size > MAX_RENDER_PREVIEW_BYTES) {
            return null;
        }
        const oldContent = await readFile(absolutePath, 'utf8');
        return {
            filePath,
            absolutePath,
            oldContent,
            isNewFile: false,
        };
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'ENOENT') {
            return {
                filePath,
                absolutePath,
                oldContent: '',
                isNewFile: true,
            };
        }
        return null;
    }
}

async function finalizeMutationPreview(
    pending: PendingMutationPreview | null,
    output: ToolOutput,
): Promise<MutationRenderPreview | undefined> {
    if (!pending || output.status !== 'success') return undefined;

    try {
        const fileStat = await stat(pending.absolutePath);
        if (!fileStat.isFile() || fileStat.size > MAX_RENDER_PREVIEW_BYTES) {
            return undefined;
        }
        const newContent = await readFile(pending.absolutePath, 'utf8');
        return {
            filePath: pending.filePath,
            oldContent: pending.oldContent,
            newContent,
            isNewFile: pending.isNewFile,
        };
    } catch {
        return undefined;
    }
}

function truncateUtf8(text: string, maxBytes: number): string {
    if (maxBytes <= 0) return '';
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    let result = '';
    let usedBytes = 0;
    for (const char of text) {
        const charBytes = Buffer.byteLength(char, 'utf8');
        if (usedBytes + charBytes > maxBytes) break;
        result += char;
        usedBytes += charBytes;
    }
    return result;
}

function errorOutput(code: string, message: string): ToolOutput {
    return {
        status: 'error',
        data: '',
        error: { code, message, retryable: false },
        truncated: false,
        bytesReturned: 0,
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    };
}

/** JSON.stringify with sorted keys so {a:1,b:2} and {b:2,a:1} are identical. */
function stableStringify(v: unknown): string {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return JSON.stringify(v);
    }
    const obj = v as Record<string, unknown>;
    const pairs = Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${pairs.join(',')}}`;
}

function authorityArgsMatch(
    actual: Record<string, unknown>,
    expected?: Record<string, unknown>,
): boolean {
    if (expected === undefined) return true;
    // Use stable (key-sorted) stringify so nested objects with different key
    // insertion order still compare equal — prevents security-boundary false negatives.
    return Object.entries(expected).every(([key, value]) =>
        stableStringify(actual[key]) === stableStringify(value)
    );
}

function matchingAuthorityDecision(
    part: ToolCallPart,
    config: TurnEngineConfig,
    decision: 'approve' | 'deny',
): boolean {
    return (config.authority ?? []).some(rule =>
        rule.decision === decision &&
        rule.tool === part.toolName &&
        authorityArgsMatch(part.arguments, rule.args_match)
    );
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
        const toolCallLimit = positiveIntegerLimit(config.maxToolCalls);
        const toolCallLimitsByName = positiveIntegerLimitMap(config.maxToolCallsByName);
        const toolResultByteLimit = positiveIntegerLimit(config.maxToolResultBytes);
        const inputTokenLimit = positiveIntegerLimit(config.maxInputTokens);
        const repeatedReadLimit = positiveIntegerLimit(config.maxRepeatedReadCalls);

        const turnId = generateId('turn') as TurnId;
        const turnNumber = deriveTurnNumber(existingItems);
        const turnStartMs = Date.now();
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
        this.emit('turn.started', {
            turnId,
            turnNumber,
            inputPreview: userInput.slice(0, 200),
        } satisfies TurnStartedEvent);

        // --- Phase 2: AppendUserMessage ---
        this.transitionTo(Phase.AppendUserMessage);
        // Point 3: scrub secrets from user input before persisting to conversation.jsonl.
        const persistedUserInput = this.scrubber ? this.scrubber.scrub(userInput) : userInput;
        const userMessage: MessageItem = {
            kind: 'message',
            id: generateId('item') as ItemId,
            seq: this.sequenceGenerator.next(),
            role: 'user',
            parts: [{ type: 'text', text: persistedUserInput }],
            timestamp: new Date().toISOString(),
        };
        items.push(userMessage);
        this.writer.writeItem(userMessage);

        // --- Step loop ---
        let stepNumber = 0;
        let outcome: TurnOutcome | undefined;
        let totalTurnTokens = 0;
        let totalAcceptedToolCalls = 0;
        let totalToolResultBytes = 0;
        const totalAcceptedToolCallsByName = new Map<string, number>();
        const acceptedReadRanges: ReadRange[] = [];

        while (!outcome) {
            stepNumber++;

            if (this.interrupted) {
                outcome = this.interrupted === 'abort' ? 'aborted' : 'cancelled';
                break;
            }

            // --- Phase 3: AssembleContext ---
            this.transitionTo(Phase.AssembleContext);
            const allItems = [...existingItems, ...items];
            const useCustomSystemMessages = !!(config.systemMessages && config.systemMessages.length > 0);
            const remainingToolCalls = toolCallLimit === undefined
                ? undefined
                : Math.max(0, toolCallLimit - totalAcceptedToolCalls);
            const toolResultByteBudgetExhausted = toolResultByteLimit !== undefined
                && totalToolResultBytes >= toolResultByteLimit;
            const availableTools = remainingToolCalls === 0 || toolResultByteBudgetExhausted
                ? []
                : this.getAvailableTools(config.allowedTools);

            // --- Phase 4: CreateStep ---
            this.transitionTo(Phase.CreateStep);
            const stepId = generateId('step') as StepId;
            const inputSeqs = allItems.map(i => i.seq);

            // --- Phase 5: CallLLM ---
            this.transitionTo(Phase.CallLLM);
            const resolvedForRequest = resolveModel(activeModel);
            const requestCaps = resolvedForRequest
                ? getModelCapabilities(resolvedForRequest)
                : activeDriver.capabilities(activeModel);
            const maxRequestOutputTokens = Math.min(4096, requestCaps?.maxOutput ?? 4096);
            let promptAssemblyStats: PromptAssemblyStats = {
                compressionTier: 'full',
                estimatedTokens: 0,
                droppedItemCount: 0,
                digestedItemCount: 0,
                instructionSummaryIncluded: true,
                durableTaskStateIncluded: true,
            };
            let request: ModelRequest = useCustomSystemMessages
                ? {
                    model: activeModel,
                    messages: this.assembleMessages(allItems, config.systemMessages),
                    tools: availableTools.length > 0
                        ? availableTools.map((tool) => ({
                            name: tool.spec.name,
                            description: tool.spec.description,
                            parameters: tool.spec.inputSchema,
                        }))
                        : undefined,
                    maxTokens: maxRequestOutputTokens,
                    temperature: config.temperature ?? 0.7,
                    topP: config.topP,
                    thinking: config.thinking,
                    responseFormat: config.responseFormat,
                }
                : (() => {
                    const preparedPrompt = preparePrompt({
                        model: activeModel,
                        maxTokens: maxRequestOutputTokens,
                        temperature: config.temperature ?? 0.7,
                        tools: availableTools,
                        items: allItems,
                        cwd: config.workspaceRoot,
                        shell: config.shell,
                        projectSnapshot: config.projectSnapshot,
                        workingSet: config.workingSet,
                        capabilities: config.capabilities,
                        durableTaskState: config.durableTaskState,
                        userInstructions: config.userInstructions,
                        activeErrors: config.activeErrors,
                        additionalSystemMessages: this.confusionSystemMessageInjected
                            ? [{ role: 'system', content: CONFUSION_SYSTEM_MESSAGE }]
                            : undefined,
                        scrub: this.scrubber ? ((text: string) => this.scrubber!.scrub(text)) : undefined,
                        contextLimit: requestCaps?.maxContext,
                        reservedOutputTokens: maxRequestOutputTokens,
                        bytesPerToken: requestCaps?.bytesPerToken,
                    });
                    promptAssemblyStats = preparedPrompt.contextStats;
                    return {
                        ...preparedPrompt.request,
                        topP: config.topP,
                        thinking: config.thinking,
                        responseFormat: config.responseFormat,
                    };
                })();
            let estimatedInputTokens = estimateRequestTokens(request, requestCaps?.bytesPerToken);
            if (promptAssemblyStats.estimatedTokens === 0) {
                promptAssemblyStats = {
                    ...promptAssemblyStats,
                    estimatedTokens: estimatedInputTokens,
                };
            }
            let guardrail: string | undefined = toolResultByteBudgetExhausted
                ? 'tool_result_byte_budget_exhausted_tools_hidden'
                : undefined;

            if (inputTokenLimit !== undefined && estimatedInputTokens > inputTokenLimit && request.tools) {
                request = { ...request, tools: undefined };
                estimatedInputTokens = estimateRequestTokens(request, requestCaps?.bytesPerToken);
                promptAssemblyStats = {
                    ...promptAssemblyStats,
                    estimatedTokens: estimatedInputTokens,
                };
                guardrail = 'max_input_tokens_tools_hidden';
            }

            this.emit('context.assembled', {
                turnNumber,
                estimatedTokens: estimatedInputTokens,
                tokenBudget: promptAssemblyStats.safeInputBudget ?? requestCaps?.maxContext ?? estimatedInputTokens,
                compressionTier: promptAssemblyStats.compressionTier,
                itemCount: allItems.length,
            } satisfies ContextAssembledEvent);

            const stepSafetyStats: StepSafetyStats = {
                estimatedInputTokens,
                toolDefinitionCount: request.tools?.length ?? 0,
                acceptedToolCalls: 0,
                rejectedToolCalls: 0,
                acceptedToolCallsByName: mapToRecord(totalAcceptedToolCallsByName),
                toolResultBytes: 0,
                cumulativeToolResultBytes: totalToolResultBytes,
                ...(guardrail ? { guardrail } : {}),
            };

            if (inputTokenLimit !== undefined && estimatedInputTokens > inputTokenLimit) {
                outcome = 'budget_exceeded';
                stepSafetyStats.guardrail = 'max_input_tokens';
                const step = this.recordStep(
                    stepId, turnId, stepNumber, config, inputSeqs, items,
                    'input_guard', { inputTokens: 0, outputTokens: 0 },
                    activeModel, activeProvider, stepSafetyStats, promptAssemblyStats, requestCaps?.maxContext,
                );
                steps.push(step);
                this.writer.writeStep(step);
                break;
            }
            this.emit('llm.request', {
                turnNumber,
                model: activeModel,
                provider: activeProvider,
                estimatedInputTokens,
                toolCount: request.tools?.length ?? 0,
            } satisfies LlmRequestEvent);

            let streamEvents: StreamEvent[] = [];
            let streamError: StreamEvent | null = null;
            const llmStartMs = Date.now();
            let llmAttempts = 0;

            for (;;) {
                llmAttempts += 1;
                const attemptEvents: StreamEvent[] = [];
                const attemptTextDeltas: string[] = [];
                let attemptError: StreamEvent | null = null;

                for await (const event of activeDriver.stream(request)) {
                    // Point 4: scrub secrets from text_delta before persisting to streamEvents
                    // (which feeds conversation.jsonl). The display callback reuses the already-
                    // scrubbed text. Known limitation: a secret split across chunk boundaries is
                    // not caught because the scrubber operates per-chunk. A streaming-safe
                    // sliding-window buffer is planned for M7.8.
                    const storedEvent = (event.type === 'text_delta' && this.scrubber)
                        ? { ...event, text: this.scrubber.scrub(event.text) }
                        : event;
                    attemptEvents.push(storedEvent);
                    if (storedEvent.type === 'text_delta') {
                        attemptTextDeltas.push(storedEvent.text);
                        if (config.interactive && config.onTextDelta) {
                            config.onTextDelta(storedEvent.text);
                        }
                    }
                    if (event.type === 'error') {
                        attemptError = event;
                    }
                    if (this.interrupted) break;
                }

                if (this.interrupted) {
                    streamEvents = attemptEvents;
                    streamError = attemptError;
                    break;
                }

                if (attemptError?.type === 'error' && !config.interactive) {
                    const policy = getRetryPolicy(attemptError.error.code);
                    if (shouldRetryLlmStep(attemptError.error.code, llmAttempts, policy)) {
                        const delay = computeBackoff(llmAttempts, policy);
                        await sleep(delay);
                        continue;
                    }
                }

                const normalizedAttempt = this.normalizeStreamEvents(attemptEvents);
                const emptyAssistantAttempt =
                    attemptError === null
                    && normalizedAttempt.textParts.length === 0
                    && normalizedAttempt.toolCallParts.length === 0;

                if (emptyAssistantAttempt && !config.interactive) {
                    const policy = getRetryPolicy('llm.malformed');
                    if (shouldRetryLlmStep('llm.malformed', llmAttempts, policy)) {
                        const delay = computeBackoff(llmAttempts, policy);
                        await sleep(delay);
                        continue;
                    }
                }

                streamEvents = attemptEvents;
                streamError = attemptError;
                if (!config.interactive && config.onTextDelta) {
                    for (const text of attemptTextDeltas) {
                        config.onTextDelta(text);
                    }
                }
                break;
            }

            if (this.interrupted) {
                outcome = this.interrupted === 'abort' ? 'aborted' : 'cancelled';
                break;
            }

            if (streamError && streamError.type === 'error') {
                // Record LLM error for telemetry
                this.metricsAccumulator?.recordError(streamError.error.code);
                this.emit('runtime.error', {
                    turnNumber,
                    code: streamError.error.code,
                    message: streamError.error.message,
                    context: {
                        model: activeModel,
                        provider: activeProvider,
                        step: stepNumber,
                        attempts: llmAttempts,
                    },
                } satisfies RuntimeErrorEvent);

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
            this.emit('llm.response', {
                turnNumber,
                model: activeModel,
                provider: activeProvider,
                tokensIn: tokenUsage.inputTokens,
                tokensOut: tokenUsage.outputTokens,
                latencyMs: llmLatencyMs,
                finishReason,
                costUsd,
            } satisfies LlmResponseEvent);

            if (assistantParts.length === 0) {
                const message = 'Model returned an empty response';
                this.metricsAccumulator?.recordError('llm.malformed');
                this.emit('runtime.error', {
                    turnNumber,
                    code: 'llm.malformed',
                    message,
                    context: {
                        model: activeModel,
                        provider: activeProvider,
                        step: stepNumber,
                        attempts: llmAttempts,
                    },
                } satisfies RuntimeErrorEvent);
                lastError = { code: 'llm.malformed', message };
                outcome = 'aborted';
                const step = this.recordStep(
                    stepId, turnId, stepNumber, config, inputSeqs, items, finishReason, tokenUsage, activeModel, activeProvider, stepSafetyStats, promptAssemblyStats, requestCaps?.maxContext,
                );
                steps.push(step);
                this.writer.writeStep(step);
                break;
            }

            if (this.costTracker) {
                const budgetResult = this.costTracker.recordCost(costUsd);
                if (budgetResult.status === 'exceeded') {
                    outcome = 'budget_exceeded';
                    const step = this.recordStep(
                        stepId, turnId, stepNumber, config, inputSeqs, items, finishReason, tokenUsage, activeModel, activeProvider, stepSafetyStats, promptAssemblyStats, requestCaps?.maxContext,
                    );
                    steps.push(step);
                    this.writer.writeStep(step);
                    break;
                }
            }

            // Text-only → yield with assistant_final (check BEFORE budget so completion takes priority)
            if (toolCallParts.length === 0) {
                outcome = 'assistant_final';
                // Track if budget was exceeded even though task completed
                if (tokenLimit !== undefined && totalTurnTokens > tokenLimit) {
                    stepSafetyStats.guardrail = 'budget_exceeded_after_completion';
                }
                // Record the step before yielding
                const step = this.recordStep(
                    stepId, turnId, stepNumber, config, inputSeqs, items, finishReason, tokenUsage, activeModel, activeProvider, stepSafetyStats, promptAssemblyStats, requestCaps?.maxContext,
                );
                steps.push(step);
                this.writer.writeStep(step);
                break;
            }

            // Budget exceeded with pending tool calls → truly incomplete
            if (tokenLimit !== undefined && totalTurnTokens > tokenLimit) {
                outcome = 'budget_exceeded';
                const step = this.recordStep(
                    stepId, turnId, stepNumber, config, inputSeqs, items, finishReason, tokenUsage, activeModel, activeProvider, stepSafetyStats, promptAssemblyStats, requestCaps?.maxContext,
                );
                steps.push(step);
                this.writer.writeStep(step);
                break;
            }

            // Step limit → yield with max_steps
            if (stepNumber >= stepLimit) {
                outcome = 'max_steps';
                const step = this.recordStep(
                    stepId, turnId, stepNumber, config, inputSeqs, items, finishReason, tokenUsage, activeModel, activeProvider, stepSafetyStats, promptAssemblyStats, requestCaps?.maxContext,
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
                    stepId, turnId, stepNumber, config, inputSeqs, items, finishReason, tokenUsage, activeModel, activeProvider, stepSafetyStats, promptAssemblyStats, requestCaps?.maxContext,
                );
                steps.push(step);
                this.writer.writeStep(step);
                break;
            }

            // Tool calls present → continue to ValidateToolCalls

            // --- Phase 9: ValidateToolCalls ---
            this.transitionTo(Phase.ValidateToolCalls);

            // Enforce per-message, per-turn, per-tool, and repeated-read caps
            // before executing anything. Prompt text is advisory; these limits are
            // the actual leash for weaker or overly persistent tool callers.
            type RejectedToolCall = {
                part: ToolCallPart;
                code: 'tool.deferred' | 'tool.max_tool_calls';
                message: string;
                hardLimit: boolean;
            };
            const activeCalls: ToolCallPart[] = [];
            const rejectedCalls: RejectedToolCall[] = [];
            const acceptedThisStepByName = new Map<string, number>();
            const plannedReadRanges = [...acceptedReadRanges];

            for (const part of toolCallParts) {
                if (activeCalls.length >= MAX_TOOL_CALLS_PER_MESSAGE) {
                    rejectedCalls.push({
                        part,
                        code: 'tool.deferred',
                        message: `Tool call deferred: max ${MAX_TOOL_CALLS_PER_MESSAGE} calls per message.`,
                        hardLimit: false,
                    });
                    continue;
                }

                if (remainingToolCalls !== undefined && activeCalls.length >= remainingToolCalls) {
                    rejectedCalls.push({
                        part,
                        code: 'tool.max_tool_calls',
                        message: `Tool call rejected: max_tool_calls limit ${toolCallLimit} reached`,
                        hardLimit: true,
                    });
                    continue;
                }

                const toolLimit = toolCallLimitsByName.get(part.toolName);
                const acceptedForTool =
                    (totalAcceptedToolCallsByName.get(part.toolName) ?? 0) +
                    (acceptedThisStepByName.get(part.toolName) ?? 0);
                if (toolLimit !== undefined && acceptedForTool >= toolLimit) {
                    rejectedCalls.push({
                        part,
                        code: 'tool.max_tool_calls',
                        message: `Tool call rejected: max_tool_calls_by_name.${part.toolName} limit ${toolLimit} reached`,
                        hardLimit: true,
                    });
                    continue;
                }

                const readRange = readRangeFor(part);
                if (readRange && repeatedReadLimit !== undefined) {
                    const overlappingReads = plannedReadRanges.filter(range => rangesOverlap(range, readRange)).length;
                    if (overlappingReads >= repeatedReadLimit) {
                        rejectedCalls.push({
                            part,
                            code: 'tool.max_tool_calls',
                            message: `Tool call rejected: max_repeated_read_calls limit ${repeatedReadLimit} reached for ${readRange.path}`,
                            hardLimit: true,
                        });
                        continue;
                    }
                    plannedReadRanges.push(readRange);
                }

                activeCalls.push(part);
                acceptedThisStepByName.set(part.toolName, (acceptedThisStepByName.get(part.toolName) ?? 0) + 1);
            }
            const exceededTurnToolLimit = rejectedCalls.some(call => call.hardLimit);

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
            let toolResultBytesThisStep = 0;
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
                let renderPreview: MutationRenderPreview | undefined;
                if (toolResultByteLimit !== undefined && totalToolResultBytes >= toolResultByteLimit) {
                    output = errorOutput(
                        'tool.max_tool_result_bytes',
                        `Tool call rejected: max_tool_result_bytes limit ${toolResultByteLimit} reached`,
                    );
                    stepSafetyStats.guardrail = 'max_tool_result_bytes';
                } else if (!valid) {
                    output = errorOutput(errorCode ?? 'tool.not_found', error!);
                } else {
                    // Approval flow: resolve permission before executing
                    const approval = await this.resolveToolApproval(part, config);
                    if (approval.denied) {
                        output = approval.denied;
                    } else {
                        const pendingRenderPreview = await captureMutationPreviewBaseline(part, config);
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

                        this.emit('tool.started', {
                            toolCallId: part.toolCallId,
                            toolName: part.toolName,
                            arguments: part.arguments,
                        } satisfies ToolStartedEvent);
                        const toolStartMs = Date.now();
                        output = await this.toolRunner.execute(
                            part.toolName,
                            part.arguments,
                            {
                                ...toolContext,
                                networkApproved: approval.networkApproved,
                            },
                        );
                        const durationMs = Date.now() - toolStartMs;
                        renderPreview = await finalizeMutationPreview(pendingRenderPreview, output);
                        this.emit('tool.completed', {
                            toolCallId: part.toolCallId,
                            toolName: part.toolName,
                            arguments: part.arguments,
                            output,
                            durationMs,
                            ...(renderPreview ? { renderPreview } : {}),
                        } satisfies ToolCompletedEvent);

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

                const outputBytes = dataBytes(output.data);
                const remainingToolResultBytes = toolResultByteLimit === undefined
                    ? undefined
                    : Math.max(0, toolResultByteLimit - totalToolResultBytes);
                if (remainingToolResultBytes !== undefined && outputBytes > remainingToolResultBytes) {
                    const truncatedData = truncateUtf8(output.data, remainingToolResultBytes);
                    const returnedBytes = dataBytes(truncatedData);
                    output = {
                        ...output,
                        data: truncatedData,
                        truncated: true,
                        bytesReturned: returnedBytes,
                        bytesOmitted: output.bytesOmitted + Math.max(0, outputBytes - returnedBytes),
                    };
                    stepSafetyStats.guardrail = 'max_tool_result_bytes';
                }
                const storedOutputBytes = dataBytes(output.data);
                totalToolResultBytes += storedOutputBytes;
                toolResultBytesThisStep += storedOutputBytes;

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

            // Create synthetic error results for calls rejected by guardrails.
            for (const { part, code, message } of rejectedCalls) {
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
                            code,
                            message,
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
            totalAcceptedToolCalls += activeCalls.length;
            for (const part of activeCalls) {
                totalAcceptedToolCallsByName.set(
                    part.toolName,
                    (totalAcceptedToolCallsByName.get(part.toolName) ?? 0) + 1,
                );
                const readRange = readRangeFor(part);
                if (readRange) acceptedReadRanges.push(readRange);
            }
            stepSafetyStats.acceptedToolCalls = activeCalls.length;
            stepSafetyStats.rejectedToolCalls = rejectedCalls.length;
            stepSafetyStats.acceptedToolCallsByName = mapToRecord(totalAcceptedToolCallsByName);
            stepSafetyStats.toolResultBytes = toolResultBytesThisStep;
            stepSafetyStats.cumulativeToolResultBytes = totalToolResultBytes;

            // --- Confusion tracking ---
            // Count confusion per assistant attempt, not per parallel tool inside
            // the same attempt. A single batched message with several malformed
            // calls should feed back as one failed attempt so the model can repair
            // the batch on the next step. Successful results still reset the chain.
            let confusionYield = false;
            let confusionThresholdIndex = -1;
            const stepConfusionIndices: number[] = [];
            let stepHasResettingResult = false;
            for (let i = 0; i < toolResults.length; i++) {
                const result = toolResults[i];
                const errorCode = result.output.status === 'error'
                    ? result.output.error?.code
                    : undefined;
                const isConfusion = errorCode !== undefined && CONFUSION_ERROR_CODES.has(errorCode);
                const isNeutralDeferred = errorCode === 'tool.deferred';

                // Record tool errors for telemetry
                if (result.output.status === 'error' && result.output.error) {
                    this.metricsAccumulator?.recordError(result.output.error.code);
                }

                if (isConfusion) {
                    stepConfusionIndices.push(i);
                    continue;
                }

                // A deferred overflow call is not evidence that the model recovered;
                // it just needs another step. Leave the confusion chain unchanged.
                if (!isNeutralDeferred) {
                    stepHasResettingResult = true;
                }
            }

            if (stepHasResettingResult) {
                consecutiveConfusionCount = 0;
            } else if (stepConfusionIndices.length > 0) {
                consecutiveConfusionCount++;
                this.sessionConfusionCount++;
                if (consecutiveConfusionCount >= CONFUSION_CONSECUTIVE_THRESHOLD) {
                    confusionThresholdIndex = stepConfusionIndices[stepConfusionIndices.length - 1];
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
                    stepId, turnId, stepNumber, config, inputSeqs, items, finishReason, tokenUsage, activeModel, activeProvider, stepSafetyStats, promptAssemblyStats, requestCaps?.maxContext,
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

            // A model can use exactly the final permitted tool call and still
            // get one no-tools follow-up step to summarize. If it exceeds the
            // cap in the current step, stop immediately.
            if (exceededTurnToolLimit) {
                outcome = 'max_tool_calls';
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
        this.emit('turn.ended', {
            turnId,
            turnNumber,
            outcome: completedTurn.outcome!,
            stepCount: steps.length,
            tokensIn: steps.reduce((sum, step) => sum + step.tokenUsage.inputTokens, 0),
            tokensOut: steps.reduce((sum, step) => sum + step.tokenUsage.outputTokens, 0),
            durationMs: Date.now() - turnStartMs,
        } satisfies TurnEndedEvent);

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

    private getAvailableTools(allowedTools?: string[] | null): RegisteredTool[] {
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
            });
    }

    private assembleToolDefinitions(allowedTools?: string[] | null): ToolDefinition[] {
        return this.getAvailableTools(allowedTools).map(tool => ({
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

        const toolCallParts: ToolCallPart[] = [];
        const jsonParseFailures = new Set<string>();
        for (const accum of toolCallSlots) {
            let args: Record<string, unknown> = {};
            let parseFailure = false;
            try {
                args = normalizeToolArguments(
                    accum.name,
                    JSON.parse(sanitizeModelJson(accum.arguments || '{}')),
                );
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

        const textParts: TextPart[] = [];
        if (fullText.length > 0 && toolCallParts.length === 0) {
            textParts.push({ type: 'text', text: fullText });
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
        safetyStats?: StepSafetyStats,
        promptStats?: PromptAssemblyStats,
        tokenLimit?: number,
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
                tokenCount: promptStats?.estimatedTokens ?? (tokenUsage.inputTokens + tokenUsage.outputTokens),
                tokenLimit: tokenLimit ?? 128_000,
                compressionTier: promptStats?.compressionTier ?? 'full',
                systemPromptFingerprint: 'prompt-assembly-v1',
            },
            tokenUsage,
            ...(safetyStats ? { safetyStats } : {}),
            timestamp: new Date().toISOString(),
        };
    }

    /**
     * Resolve approval for a tool call before execution.
     * Returns a ToolOutput error if denied, or approval metadata if approved.
     */
    private async resolveToolApproval(
        part: ToolCallPart,
        config: TurnEngineConfig,
    ): Promise<{ denied: ToolOutput | null; networkApproved: boolean }> {
        // Enforce allowedTools constraint even without full approval flow
        if (config.allowedTools !== undefined && config.allowedTools !== null) {
            if (!config.allowedTools.includes(part.toolName)) {
                return {
                    denied: {
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
                    },
                    networkApproved: false,
                };
            }
        }

        if (matchingAuthorityDecision(part, config, 'deny')) {
            return {
                denied: {
                    status: 'error',
                    data: '',
                    error: {
                        code: 'tool.permission',
                        message: 'Denied: matched invoke authority deny rule',
                        retryable: false,
                    },
                    truncated: false,
                    bytesReturned: 0,
                    bytesOmitted: 0,
                    retryable: false,
                    timedOut: false,
                    mutationState: 'none',
                },
                networkApproved: false,
            };
        }

        // Full approval flow requires config + session grants
        if (!config.resolvedConfig || !config.sessionGrants) {
            return { denied: null, networkApproved: false };
        }

        const registered = this.toolRegistry.lookup(part.toolName);
        if (!registered) return { denied: null, networkApproved: false }; // Already handled by validation

        // Compute risk assessment for exec/session tools
        let riskAssessment: CommandRiskAssessment | undefined;
        const command = EXEC_TOOLS.has(part.toolName)
            ? (part.toolName === 'session_io'
                ? (typeof part.arguments.stdin === 'string' ? part.arguments.stdin : '')
                : (typeof part.arguments.command === 'string' ? part.arguments.command : ''))
            : '';
        if (EXEC_TOOLS.has(part.toolName)) {
            if (command) {
                // session_io targets a long-lived shell whose cwd may have changed
                // arbitrarily since spawn; treating stdin as if it still runs in
                // ACA's workspaceRoot can silently under-classify relative
                // destructive commands. Use conservative unknown-context analysis.
                const cwd = part.toolName === 'session_io'
                    ? '/'
                    : (typeof part.arguments.cwd === 'string' ? part.arguments.cwd : config.workspaceRoot);
                const workspaceRoot = part.toolName === 'session_io'
                    ? undefined
                    : config.workspaceRoot;
                riskAssessment = analyzeCommand(command, cwd, undefined, workspaceRoot);
            }
        }
        const networkPolicyResult = command
            ? evaluateShellNetworkAccess(command, config.resolvedConfig.network)
            : null;

        const request: ApprovalRequest = {
            toolName: part.toolName,
            toolArgs: part.arguments,
            approvalClass: registered.spec.approvalClass,
            riskAssessment,
            networkPolicyResult,
        };

        const result = resolveApproval(request, {
            config: config.resolvedConfig,
            sessionGrants: config.sessionGrants,
            noConfirm: config.autoConfirm,
            workspaceRoot: config.workspaceRoot,
            allowedTools: config.allowedTools,
        });

        if (result.decision === 'allow') {
            return {
                denied: null,
                networkApproved: networkPolicyResult?.decision === 'confirm',
            };
        }

        if (result.decision === 'deny') {
            return {
                denied: {
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
                },
                networkApproved: false,
            };
        }

        if (
            result.decision === 'confirm' &&
            matchingAuthorityDecision(part, config, 'approve')
        ) {
            return { denied: null, networkApproved: false };
        }

        // confirm or confirm_always — prompt user
        // Check promptUser only (not interactive) so one-shot mode with TTY can prompt
        if (!config.promptUser) {
            return {
                denied: {
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
                },
                networkApproved: false,
            };
        }

        const prompt = formatApprovalPrompt(request, riskAssessment);
        const response = await config.promptUser(prompt);
        const parsed = parseApprovalResponse(response);

        if (parsed.choice === 'approve') {
            return {
                denied: null,
                networkApproved: networkPolicyResult?.decision === 'confirm',
            };
        }
        if (parsed.choice === 'always') {
            // Extract command for exec tools session grant
            const commandPattern = command || undefined;
            config.sessionGrants.addGrant(part.toolName, commandPattern);
            return {
                denied: null,
                networkApproved: networkPolicyResult?.decision === 'confirm',
            };
        }

        // deny or edit (edit not yet supported — treat as deny)
        return {
            denied: {
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
            },
            networkApproved: false,
        };
    }
}
