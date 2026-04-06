<!-- Source: fundamentals.md lines 594-690 -->
### Block 6: Agent Loop / Turn Engine

The core execution cycle that ties everything together. This block consumes Block 5's data structures (Session, Turn, Step, ConversationItem) and orchestrates the flow from user input through LLM calls, tool execution, and back to user output. The event stream (Block: Observability) is emitted as a side effect at each phase transition.

**Core principle: the loop is a step machine inside a turn boundary.** A turn starts when the user (or parent agent) provides input and ends when the agent yields back. Within a turn, the loop executes steps — each step is one LLM API call plus the resulting tool executions. The loop continues stepping until a yield condition is met.

**Foundational decisions:**

- **Twelve phases per step, with explicit phase transitions.** Each step passes through these phases in order. Phase transitions emit events to the observability stream and update the in-memory projection. The phases:

  1. **`OpenTurn`** — create `TurnRecord`, set status to `running`, emit `turn.started` event. Only runs on the first step of a turn
  2. **`AppendUserMessage`** — create a `MessageItem` (role: user) from the input and append to the conversation log. Only runs on the first step
  3. **`AssembleContext`** — build the LLM API request from the 4-layer system prompt assembly: system parameter, tool definitions, per-turn context block, and conversation history. Select which `ConversationItem`s to include based on context budget. Emit `context.assembled` event with token stats and compression tier. If context pressure exceeds thresholds (60/80/90%), apply the compression strategy defined in System Prompt Assembly
  4. **`CreateStep`** — create a `StepRecord` with the assembled context stats (token count, token limit, compression tier, system prompt fingerprint). Record which item IDs were sent as input
  5. **`CallLLM`** — send the assembled request to the LLM provider. Stream tokens to the terminal for real-time display (see streaming decision below). Emit `llm.request` event before the call. This phase is interruptible by SIGINT
  6. **`NormalizeResponse`** — when the provider stream completes, normalize the response into the canonical parts model: `TextPart[]` and `ToolCallPart[]`. Different providers return different formats (Anthropic content blocks, OpenAI tool_calls) — the provider adapter normalizes here. Emit `llm.response` event with token usage and finish reason
  7. **`AppendAssistantMessage`** — create a `MessageItem` (role: assistant) with the normalized parts and append to the conversation log. Update the step record with the output message ID
  8. **`CheckYieldConditions`** — if the response contains only text and no tool calls, proceed to `YieldToUser`. If the response contains tool calls, check yield conditions (step limits, consecutive tool limits, approval requirements) before proceeding to tool execution. If a yield condition is met, proceed to `YieldToUser` with the appropriate outcome
  9. **`ValidateToolCalls`** — validate each `ToolCallPart` against the tool's JSON Schema. Validation failures become synthetic `ToolResultItem`s with `ValidationError` status — they are not retried by the engine (the model must issue a corrected call on the next step)
  10. **`ExecuteToolCalls`** — execute validated tool calls through the Tool Runtime Contract. Execute sequentially in emitted order within a single step. Emit `tool.invoked` and `tool.completed` events per call. If a tool requires user confirmation (approval class), the loop yields with `approval_required` outcome — the tool is not executed until the user approves
  11. **`AppendToolResults`** — create a `ToolResultItem` per completed tool call and append to the conversation log. Link each result to its `ToolCallPart` by `toolCallId`. For large results, store the full payload as a blob and keep a truncated version in the item
  12. **`LoopOrYield`** — if more tool results need processing (the model needs to see them), loop back to `AssembleContext` for the next step. If a yield condition was deferred, yield now. Otherwise, continue the step loop

  For the first step of a turn, phases 1-2 run before phases 3-12. For subsequent steps (tool result follow-ups), the loop enters at phase 3 directly.

- **Multi-tool-call responses: execute sequentially, loop once.** When the LLM requests multiple tool calls in a single response (multiple `ToolCallPart`s in one assistant message), all calls are executed sequentially in the order they appear in the response during a single `ExecuteToolCalls` phase. All results are appended before the next LLM call. Sequential execution is the v1 default because: it avoids race conditions between tools that might interact (read then edit), it simplifies error handling (a failed tool doesn't need to cancel siblings), and it matches the sync-first execution model. Parallel execution of read-only tools is a future optimization, not a v1 feature

- **Step and turn limits prevent runaway loops.** Limits are enforced at `CheckYieldConditions` (phase 8) and checked again at `LoopOrYield` (phase 12). All limits are configurable via agent profile and CLI flags:

  | Limit | Default (interactive) | Default (sub-agent/one-shot) | Rationale |
  |---|---|---|---|
  | **Max steps per turn** | 25 | 30 | One step = one LLM call. 25 allows complex multi-file edits. Sub-agents get slightly more since they run unsupervised within a scoped task |
  | **Max consecutive autonomous tool steps** | 10 | No separate limit | In interactive mode, after 10 steps with only tool calls and no text output to the user, the loop yields with `max_consecutive_tools` outcome and a progress summary. This prevents the agent from silently churning. Sub-agents are expected to work autonomously within their step budget |
  | **Soft progress notice** | At step 8 | N/A | In interactive mode, after 8 steps the agent injects a brief status line to stderr (not a conversation message) showing what it's working on. Keeps the user informed during long autonomous stretches |
  | **Max tool calls per assistant message** | 10 | 10 | If the LLM returns more than 10 tool calls in a single response, execute only the first 10 and inform the model that remaining calls were deferred. This caps per-step work |
  | **No hard per-session turn limit** | None | N/A | Sessions can have hundreds of turns. Cost control is handled by budget limits (deferred to Block 9), not turn caps. Soft warning at 200 turns |

- **SIGINT handling: two-tier, phase-aware.** The handler tracks the current phase and applies the appropriate cancellation:

  **First SIGINT — cancel active operation:**
  - During `CallLLM` (streaming): abort the HTTP request. Discard the partial response — do not persist incomplete assistant messages as canonical conversation items. Record the interruption in the event stream. The turn continues at phase 8 (`CheckYieldConditions`) with `cancelled` outcome
  - During `ExecuteToolCalls`: send cancellation signal to the active tool through the Tool Runtime Contract's graceful signal → 2s grace → force kill sequence. The tool result carries `status: "error"` with `code: "cancelled"`. Remaining tool calls in the batch are skipped. The turn yields with `cancelled` outcome
  - During `AssembleContext` or `NormalizeResponse`: cancel immediately (these are CPU-bound and fast). Yield with `cancelled` outcome
  - During user interaction (`ask_user`, `confirm_action`): cancel the prompt and yield

  **Second SIGINT within 2 seconds of the first (or while cancellation is in progress):** abort the entire turn immediately. Set turn status to `aborted`. Save session state (manifest + any items already appended). Return to the input prompt (interactive mode) or exit with code 2 (one-shot/executor mode)

  Double-SIGINT within 500ms is treated as a hard exit request — the process exits after saving the manifest. This matches common CLI conventions (Ctrl+C twice to force quit)

  SIGINT during `AppendUserMessage`, `AppendAssistantMessage`, or `AppendToolResults` is deferred until the write completes — these are fast I/O operations and interrupting mid-write would corrupt the log

- **Yield-to-user rules define when autonomous execution stops.** The agent yields (returns control to the user in interactive mode, or completes in one-shot/executor mode) when any of these conditions is true:

  1. **Text response with no tool calls** — the assistant produced a final answer. This is the normal yield
  2. **Approval required** — a tool call's approval class requires user confirmation. The loop pauses at `CheckYieldConditions`, presents the confirmation prompt, and resumes or aborts based on the user's response. In sub-agent mode, this becomes an `approval_required` return to the parent (sub-agents never prompt the user directly, per delegation design)
  3. **Non-retryable tool error** — a tool failed with `retryable: false`. The agent yields with the error in context so the user can decide how to proceed. Retryable errors are handled by the Tool Runtime Contract's auto-retry (3 attempts) before reaching the conversation state
  4. **Indeterminate mutation state** — a tool returned `mutationState: "indeterminate"`. The agent yields to inform the user that filesystem state may be inconsistent
  5. **Step limit reached** — `maxStepsPerTurn` exceeded. The agent yields with a summary of what was accomplished and what remains
  6. **Consecutive tool step limit** — `maxConsecutiveAutonomousToolSteps` exceeded in interactive mode. The agent yields with a progress update
  7. **User interruption** — SIGINT received
  8. **The agent does NOT yield on "uncertainty."** There is no engine-level confidence threshold or uncertainty detector. If the model is uncertain, it should use the `ask_user` tool explicitly — this is a model behavior, not an engine policy. The engine yields when `ask_user` is invoked (it is an inherently interactive tool), which achieves the same result without a fragile heuristic

- **Tool result to message conversion preserves the standard envelope.** When a tool completes, its `ToolOutput` envelope from the Tool Runtime Contract is stored as the `output` field of a `ToolResultItem`. The conversion to LLM-visible message format:

  1. The `ToolResultItem` becomes a message with `role: "tool"` in the provider's format
  2. The `toolCallId` links it to the corresponding `ToolCallPart` in the preceding assistant message
  3. The message content is a JSON serialization of the essential fields: `{ status, data, error, truncated }`. The `bytesReturned`, `retryable`, `timedOut`, and `mutationState` fields are included only when they carry non-default values (non-zero bytes, true flags). This keeps tool result messages concise while preserving all decision-relevant information
  4. For large tool outputs: if `data` exceeds 32 KiB when serialized, the model-visible version is truncated with a note indicating total size and how to retrieve more (e.g., "Output truncated. Use read_file with line ranges to see the full content"). The full payload is stored via `blobRef`
  5. Error results include the full error object (`code`, `message`, `retryable`, `details`) so the model can reason about whether to retry, fall back, or ask the user

  The provider adapter handles format differences: Anthropic expects `tool_result` content blocks with `tool_use_id`, OpenAI expects tool messages with `tool_call_id`. The canonical `ToolResultItem` is provider-agnostic; the adapter translates at `AssembleContext` time

- **Streaming: display tokens as they arrive, buffer for state.** The LLM API call uses streaming when available. Behavior during streaming:

  1. **Text tokens** are written to stdout as they arrive, giving the user real-time feedback. The full text is simultaneously buffered in memory
  2. **Tool-call tokens** (tool name, arguments being generated) are displayed as a compact progress indicator on stderr (e.g., `[calling: edit_file...]`), not streamed verbatim to stdout. Tool call arguments may be partial/invalid mid-stream
  3. **Tool calls are never executed mid-stream.** The engine waits for the provider to signal response completion (`stop_reason`/`finish_reason`) before parsing tool calls and entering `ValidateToolCalls`. This prevents executing on malformed partial JSON arguments
  4. **Partial responses on interruption** are discarded from conversation state (not appended as items). The event stream records that a streaming response was interrupted, including how many tokens were received before cancellation
  5. **Provider differences** are handled in the adapter layer. Some providers stream content blocks incrementally (Anthropic), others stream token deltas (OpenAI). The adapter normalizes into a unified token stream with block-type annotations

- **The turn engine exposes a minimal interface to the rest of the system.** Block 6 is consumed by the CLI interface (Block 10) and the delegation system. The interface:

  - `executeTurn(session, input)` — main entry point. Runs the step loop until yield. Returns the completed `TurnRecord` with outcome
  - `interrupt(level)` — signal cancellation. Two levels: `cancel_operation` and `abort_turn`
  - `getPhase()` — current phase for status display and event rendering

  The turn engine does not manage session lifecycle (creation, loading, saving) — that belongs to the session manager built on Block 5's data model. The turn engine receives a live session and appends to it.

**Deferred:**
- Parallel tool execution for read-only tools
- Adaptive step limits based on task complexity
- Turn resumption after interruption (resume from last completed step)
- Background/detached turn execution
- Per-step timeout (distinct from per-tool timeout)
- Streaming tool output into model context (currently tools buffer to completion)
- Step-level branching (re-running a step with different tool results)
