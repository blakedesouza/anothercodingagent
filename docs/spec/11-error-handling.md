<!-- Source: fundamentals.md lines 1455-1676 -->
### Block 11: Error Handling & Recovery

Consistent policy for when things break. This block defines the typed error taxonomy used across all components, retry and fail-fast policies per error category, user-facing error presentation for each invocation mode, degraded capability handling, LLM API error recovery, and error composition across delegation chains. It integrates with the Tool Runtime Contract's output envelope, Block 6's yield conditions, the capability health tracking system, and Block 10's exit codes.

**Core principle: errors are structured data, never ambiguous.** Every error in the system carries a typed code, a human-readable message, a retryable flag, and an optional details object. The agent never surfaces raw stack traces, unstructured error strings, or provider-specific error formats to the model or the user. Errors are normalized into the canonical taxonomy at the boundary where they occur — tool implementations, provider adapters, and delegation handlers each normalize before returning.

**Foundational decisions:**

- **Error taxonomy uses two-level dot-notation codes with a shared `AcaError` shape.** All errors in the system — tool failures, LLM API errors, delegation errors, system errors — use the same shape:

  ```typescript
  interface AcaError {
    code: string;          // Two-level dot-notation (e.g., "tool.timeout")
    message: string;       // Human-readable, one line
    retryable: boolean;    // Whether automatic retry is appropriate
    details?: Record<string, unknown>;  // Error-specific structured data
    cause?: AcaError;      // Nested cause for error chains (delegation)
  }
  ```

  This shape is used in three places: (1) the `error` field of the Tool Runtime Contract's `ToolOutput` envelope for tool-level errors, (2) event payloads for LLM and system errors, and (3) turn outcome metadata. The `cause` field enables error chain traversal for delegation errors without flattening the original error.

  **Error codes (22 codes across 4 categories):**

  | Code | Semantics | Retryable | Details fields |
  |---|---|---|---|
  | **Tool errors** | | | |
  | `tool.validation` | Tool call input failed JSON Schema validation or tool name not found in registry | No | `toolName`, `parameter`, `constraint`, `validationErrors` |
  | `tool.timeout` | Tool exceeded its per-category timeout (file:5s, LSP:10s, web:15s, shell:60s) | Conditional | `toolName`, `timeoutMs`, `category`. Retryable only for idempotent tools; mutation tools get `mutationState: "indeterminate"` |
  | `tool.crash` | Tool implementation threw an unhandled exception or spawned process died | No | `toolName`, `exitCode`, `signal` |
  | `tool.cancelled` | Tool execution interrupted by user (SIGINT) | No | `toolName`, `phase` |
  | `tool.not_found` | Requested resource does not exist (file, path, session) | No | `toolName`, `resourcePath` |
  | `tool.permission_denied` | Sandbox zone check failed or OS permission error | No | `toolName`, `path`, `resolvedPath`, `reason` |
  | `tool.network_error` | Network failure during tool execution, after auto-retry exhaustion | No | `toolName`, `url`, `attempts`, `lastHttpStatus` |
  | `tool.contract_violation` | Tool returned malformed output that does not match the ToolOutput envelope. This is an implementation bug, not a user or model error | No | `toolName`, `violation` |
  | **LLM errors** | | | |
  | `llm.rate_limited` | HTTP 429 from provider, after retry exhaustion | No | `provider`, `attempts`, `totalWaitMs`, `retryAfter` |
  | `llm.context_too_long` | Provider rejected request for exceeding context window, after compression retry | No | `provider`, `estimatedTokens`, `contextLimit`, `compressionTier` |
  | `llm.content_filtered` | Provider safety filter or content policy triggered | No | `provider`, `filterReason` (if provided by API) |
  | `llm.server_error` | HTTP 5xx from provider, after retry exhaustion | No | `provider`, `httpStatus`, `attempts` |
  | `llm.auth_error` | HTTP 401/403 from provider | No | `provider`, `httpStatus` |
  | `llm.timeout` | No response from provider within configured timeout, after retry | No | `provider`, `timeoutMs`, `attempts` |
  | `llm.malformed_response` | Provider returned invalid JSON or response that cannot be parsed, after retry | No | `provider`, `attempts`, `responsePreview` (first 200 chars) |
  | `llm.confused` | Model produced repeated malformed tool calls, hitting the confusion limit | No | `confusionCount`, `lastToolName`, `lastValidationError` |
  | **Delegation errors** | | | |
  | `delegation.child_error` | Sub-agent completed but returned an error outcome | Conditional | `childAgentId`, `childLabel`, `childTurnCount`. `cause` carries the child's original error |
  | `delegation.child_crash` | Sub-agent process exited unexpectedly (non-zero exit, signal) | No | `childAgentId`, `exitCode`, `signal` |
  | `delegation.child_timeout` | Sub-agent exceeded the delegation timeout (120s) | Conditional | `childAgentId`, `elapsedMs`, `childPhase` |
  | **System errors** | | | |
  | `system.resource_exhausted` | Out of memory, disk full, file descriptor limit, or similar OS resource limit | No | `resource` (memory, disk, fd), `usage`, `limit` |
  | `system.internal` | Invariant violation or unexpected state — indicates a bug in the agent | No | `component`, `invariant`, `state` |
  | `system.config_error` | Configuration error detected at runtime (distinct from startup config errors, which use exit code 4) | No | `field`, `reason` |

  **Design rationale:** Two-level codes (`category.type`) provide enough structure for policy grouping (all `llm.*` errors share retry infrastructure, all `tool.*` errors flow through the ToolOutput envelope) without the parsing complexity of deeper nesting. The `details` object carries type-specific context — the model and user can reason about the error without the taxonomy needing a code for every possible detail. 22 codes covers all known failure modes; new codes can be added within categories without breaking existing error handling logic.

  Error codes that appear in ToolOutput's `error.code` field: all `tool.*` codes. Error codes that appear in event payloads and turn metadata: all codes. Error codes the model sees in conversation context: `tool.*` (via ToolResultItem), `llm.*` (via synthetic system message or turn outcome), `delegation.*` (via delegation tool result).

- **Retry and fail-fast policies are defined per error code, with retry logic owned by the component that detects the error.** Tool-level retries are handled by the Tool Runtime Contract (already defined: 3 attempts, exponential backoff, 250ms start, idempotent tools only). LLM-level retries are handled by the provider adapter. Delegation retries are decided by the parent agent (model-driven). Block 11 defines the policies; existing components implement them.

  **LLM API error recovery policies:**

  | Error | Detection | Retry Policy | Backoff | User Feedback |
  |---|---|---|---|---|
  | **Rate limited (429)** | HTTP status. `Retry-After` header parsed when present | 5 attempts (including initial) | Base: `max(Retry-After, 1s)`. Multiplier: 2× per attempt. Jitter: ±20%. Cap: 60s | Interactive: "Rate limited by [provider], retrying in Ns..." on stderr, updated in place. One-shot: silent during retries, message on final failure. Executor: internal, no output until final result |
  | **Context too long** | Provider-specific error message patterns, normalized by adapter | 1 retry. Escalate one compression tier per Block 7, add 10% estimation guard | No backoff (compression is the fix, not waiting) | Interactive: "Context too long, compressing..." on stderr. If second attempt also fails: "Unable to fit in context window. Consider starting a new session." |
  | **Content filter** | Provider-specific refusal/filter indicators, normalized by adapter | No retry. Never retry — the same content will hit the same filter | N/A | Interactive: "Response blocked by [provider] content filter." The error is surfaced to the model as a synthetic system message so it can rephrase or take a different approach. The model is not told to "try again" — it decides its own recovery |
  | **Server errors (5xx)** | HTTP status 500, 502, 503, 504 | 3 attempts | Exponential: 1s base, 2× multiplier, ±20% jitter. Cap: 16s | Silent during retries. Final failure: "Provider [name] is experiencing errors, please try again later" |
  | **Auth errors (401/403)** | HTTP status | No retry. Fail immediately — auth errors never self-resolve within a session | N/A | "Authentication failed with [provider]. Verify your API key." Provider health set to session-terminal `unavailable`. In interactive mode, the agent continues without LLM capability (can only respond to `/` commands). In one-shot/executor, exit code 4 if at startup, yield error if mid-session |
  | **Malformed response** | JSON parse failure on provider response body | 2 attempts (including initial), immediate retry with no backoff | None | Never shown to user (internal). Logged for debugging. If both attempts fail, yield `llm.malformed_response` |
  | **Provider timeout** | Configured timeout exceeded (default 30s from Block 9) | 2 attempts. Second attempt uses 150% of the configured timeout | No exponential — single extended retry | Interactive: "Request timed out, retrying with extended timeout..." Timeout on retry: yield `llm.timeout` |

  **Retry state is per-call, not global.** Each LLM API call maintains its own retry counter and backoff state. A rate limit on call N does not affect the retry budget for call N+1. This prevents head-of-line blocking where one bad call exhausts retry budget for the session.

  **Health state updates after retry exhaustion:** Rate limit exhaustion → provider health `degraded` with cooldown. Server error exhaustion → provider health `degraded`. Auth error → provider health `unavailable` (session-terminal). Timeout exhaustion → provider health `degraded`. These integrate with the existing capability health tracking system — the provider adapter reports health transitions after final retry failure.

  **Tool-level retry policy (confirming existing design, not overriding):** The Tool Runtime Contract's auto-retry (3 attempts, exponential backoff from 250ms, idempotent tools only) handles transient network errors within tool execution. Block 11 does not add a separate retry layer for tools. If auto-retry is exhausted, the tool returns `tool.network_error` with `retryable: false` — the model sees the final failure and decides whether to try an alternative approach.

- **User-facing error presentation is mode-dependent, always structured, never a raw stack trace.** Errors are formatted differently for each invocation mode, but all modes use the same underlying `AcaError` data. The formatting layer is in the CLI (Block 10), not in the error-producing components.

  **Interactive mode (stderr):**

  Tool errors appear as compact single-line messages with optional detail expansion:
  ```
  ! read_file failed: file not found — /src/missing.ts [tool.not_found]
  ```

  LLM retries show progress inline (overwriting the same line):
  ```
  ! Rate limited by nanogpt, retrying in 2.1s... (2/5)
  ```

  Final LLM failures show the error with actionable guidance:
  ```
  ! LLM error: rate limited after 5 retries [llm.rate_limited]
    Wait a moment and try again, or check provider status.
  ```

  System errors include the code for bug reports but not stack traces (stack traces appear only with `--verbose`):
  ```
  ! Internal error [system.internal] — please report this with session ID ses_01JQ7K...
  ```

  **One-shot mode (stderr):**

  Same format as interactive but prefixed with `aca:` for machine parsing when piped:
  ```
  aca: error: tool.timeout — exec_command timed out after 60s
  ```

  Exit code mapping to error categories:
  - Exit 1 (runtime error): `tool.*` (except validation), `llm.*`, `system.*`, `delegation.*`
  - Exit 2 (user cancelled): `tool.cancelled`, SIGINT abort
  - Exit 3 (usage error): `tool.validation` when caused by CLI input, `system.config_error`
  - Exit 4 (startup failure): `llm.auth_error` at startup, `system.config_error` at startup
  - Exit 5 (protocol error): `llm.malformed_response` in executor mode, `delegation.child_crash` with IPC failure

  **Executor mode (stdout JSON):**

  All errors are structured JSON on stdout. The error envelope extends the delegation contract's result shape:
  ```json
  {
    "status": "error",
    "error": {
      "code": "llm.rate_limited",
      "message": "Rate limited by nanogpt after 5 retries",
      "retryable": false,
      "details": {
        "provider": "nanogpt",
        "attempts": 5,
        "totalWaitMs": 47200
      }
    },
    "turnOutcome": "tool_error",
    "sessionId": "ses_01JQ7K..."
  }
  ```

  The `turnOutcome` field maps to Block 5's 8 turn outcome types, giving the caller both the specific error (`error.code`) and the engine-level outcome (`turnOutcome`). Non-zero exit code accompanies the JSON output per Block 10's exit code scheme.

- **Confusion limit prevents infinite loops from persistently malformed LLM tool calls.** The LLM sometimes produces tool calls that fail validation — wrong JSON structure, nonexistent tool names, missing required parameters. Block 6 already specifies that validation failures become synthetic `ToolResultItem`s so the model can correct itself. Block 11 defines the limit on how many times this can happen.

  **Per-turn confusion limit: 3 consecutive invalid tool calls.** A "confusion event" is any tool call that fails validation at Block 6 phase 9 (`ValidateToolCalls`). The counter tracks consecutive failures within a turn — a successful tool call resets the counter to zero.

  Behavior at each threshold:
  1. **Failures 1-2:** Synthetic `ToolResultItem` with `error.code: "tool.validation"` and a clear message describing what went wrong. The model gets another step to correct itself. This is the normal path — models occasionally produce minor schema errors
  2. **Failure 3:** Synthetic `ToolResultItem` appended, then the turn yields with outcome `tool_error` and code `llm.confused`. The yield message informs the user (interactive) or returns the error (executor). The model's last valid text output (if any) is preserved

  **Per-session confusion limit: 10 total confusion events (cumulative, not consecutive).** After 10 confusion events across the session, the engine injects a persistent system message: "Tool call accuracy has been low this session. Use simpler, single-tool approaches. Verify tool names and parameter schemas before calling." This message is added to the pinned sections in context assembly and costs ~30 tokens. It is informational — the engine does not disable tools or restrict the model.

  **Rationale for limits:** 3 consecutive is tight enough to prevent runaway loops (3 failed validations × 1 step each = 3 wasted LLM calls) while allowing recovery from occasional typos. The per-session limit of 10 catches models that make errors intermittently but persistently — a symptom of the model struggling with the tool surface. The system message nudge is lightweight and lets the model self-correct without engine-level restrictions that might prevent legitimate tool use.

  **What counts as a confusion event:** JSON parse failure on tool call arguments, tool name not found in the tool registry, required parameter missing, parameter type mismatch, parameter value outside allowed enum. What does NOT count: tool execution failures (the call was valid, the tool failed), approval denials (valid call, policy blocked it), tool timeout (valid call, timed out).

- **Degraded capability handling is model-driven with automatic tool masking for unavailable capabilities.** The agent does not silently substitute one capability for another. When a capability becomes unavailable, the model is informed and chooses its own fallback strategy. This is consistent with the existing capability health tracking design (health injected into per-turn context) and avoids surprising behavior changes from automatic substitution.

  **Three behaviors by health state:**

  | Health State | Engine Behavior | Model Sees |
  |---|---|---|
  | `available` | Normal operation. Tool in definitions, no health context line | Nothing special |
  | `degraded` | Tool remains in definitions. Health context injected | `Capability status: lsp(ts)=degraded (warming_up)` — model may choose alternatives |
  | `unavailable` | **Tool removed from tool definitions** sent to the LLM. If the model somehow references the tool (via memory of prior turns), the validation phase returns `tool.validation` with a message explaining unavailability and listing alternatives | Tool absent from available tools. If referenced: `"lsp_query is unavailable this session (server crashed). Use search_text or find_paths instead."` |

  **Why tool masking, not just health context:** Removing unavailable tools from the definitions is stronger than relying on the model to read a health context line and decide not to use the tool. Models sometimes ignore context lines and attempt to use tools they remember from earlier in the conversation. Masking prevents the attempt entirely, saving a step and avoiding confusion event accumulation. The health context line remains for `degraded` capabilities where the model should know about reduced quality but the tool is still functional.

  **No automatic fallback exceptions.** Neither LSP-to-text-search nor search-to-fetch nor any other substitution happens automatically. The model reads the health context, sees which tools are available, and makes its own decision. This keeps behavior predictable and auditable. The model is well-equipped to choose — the health context gives it the information, and the tool definitions tell it what is available.

  **Integration with capability health tracking:** The health map is consulted during `AssembleContext` (Block 6 phase 3). Tool definitions are filtered based on health state before being included in the API request. The `context.assembled` event records which tools were masked and why.

- **Delegation error composition uses the `AcaError` shape with nested `cause` for error chain traversal.** When a sub-agent encounters an error, the parent receives a structured result through the normal `await_agent` response. The parent model can reason about the error's root cause and decide whether to retry, try a different decomposition, or yield the error upward.

  **Delegation result shape (extending the existing delegation design):**

  ```typescript
  type DelegationResult =
    | { status: "success"; output: ToolOutput; turnCount: number; tokenUsage: TokenUsage }
    | { status: "approval_required"; request: ApprovalRequest }
    | { status: "error"; error: AcaError; turnCount: number }
    | { status: "crash"; error: AcaError }
    | { status: "timeout"; elapsedMs: number; partialOutput?: string };
  ```

  **Mapping child failures to parent-visible errors:**

  | Child Situation | Parent Receives | `error.code` | `error.cause` |
  |---|---|---|---|
  | Child's tool hit non-retryable error | `status: "error"` | `delegation.child_error` | The child's original `AcaError` (e.g., `tool.permission_denied`) |
  | Child's LLM call failed after retries | `status: "error"` | `delegation.child_error` | `llm.rate_limited` or `llm.server_error` etc. |
  | Child hit confusion limit | `status: "error"` | `delegation.child_error` | `llm.confused` |
  | Child process exited unexpectedly | `status: "crash"` | `delegation.child_crash` | Signal/exit code in details |
  | Child exceeded 120s delegation timeout | `status: "timeout"` | `delegation.child_timeout` | Elapsed time, last known phase |
  | Child needs user approval | `status: "approval_required"` | N/A (not an error) | Per Block 8's approval bubbling |

  **Parent retry policy for delegation errors:**
  - `delegation.child_error` with `cause.retryable: true` — parent may retry by spawning a new sub-agent with the same task. Limited to 1 retry (2 total attempts)
  - `delegation.child_error` with `cause.retryable: false` — parent does not retry. It may try a different decomposition (different agent profile, narrower task) or yield the error to the user
  - `delegation.child_crash` — parent may retry once (new process). If the retry also crashes, yield error
  - `delegation.child_timeout` — parent may retry once with a more constrained task or increased timeout (if within its authority). If retry also times out, yield error

  **Error chain depth:** In a delegation chain (root → child → grandchild), errors nest: the grandchild's `AcaError` becomes the `cause` of the child's `delegation.child_error`, which becomes the `cause` of the root's `delegation.child_error`. Maximum nesting depth is 3 (matching max delegation depth of 2). Each level preserves the original error code so the root agent can pattern-match on the leaf cause (e.g., "the grandchild failed because of `llm.auth_error`").

**Integration with other blocks:**

- **Tool Runtime Contract:** The `error.code` field in `ToolOutput` uses the `tool.*` codes from this taxonomy. The `retryable` field is set according to the per-code policy table. The auto-retry mechanism (3 attempts for transient network errors) runs before the error reaches conversation state — Block 11's retry policies for tools are already implemented by the Tool Runtime Contract
- **Block 6 (Agent Loop):** The confusion limit is checked at `ValidateToolCalls` (phase 9). When the limit is reached, phase 8 (`CheckYieldConditions`) yields with `tool_error` outcome. LLM API retry logic runs within `CallLLM` (phase 5) — the provider adapter handles retries internally, and if all retries fail, the phase produces an error that triggers a yield. Tool masking for unavailable capabilities runs during `AssembleContext` (phase 3)
- **Block 5 (Conversation State):** The 8 turn outcomes remain unchanged. `tool_error` covers confusion limit, non-retryable tool errors, and LLM errors that exhaust retries. `cancelled` covers user interruption. `aborted` covers session-level abort. The `AcaError` is recorded in the `TurnRecord`'s metadata for the `tool_error` and `aborted` outcomes
- **Capability Health Tracking:** LLM error recovery updates provider health state after retry exhaustion (described in the retry policy table). Tool masking for `unavailable` capabilities is a new behavior defined here and implemented in `AssembleContext`. Health context injection for `degraded` capabilities is unchanged from the existing design
- **Block 7 (Context Window):** The `llm.context_too_long` recovery (escalate compression tier + 10% guard, retry once) is confirmed and unchanged. If the retry also fails, the error is surfaced as `llm.context_too_long` with `retryable: false`
- **Block 8 (Permissions):** Sandbox denials produce `tool.permission_denied`. Approval-required is a yield condition, not an error — it uses the existing `approval_required` turn outcome, not an error code. The `--no-confirm` flag overrides `confirm` but not `deny` (unchanged)
- **Block 9 (Configuration):** Provider timeout (default 30s) feeds `llm.timeout` retry policy (retry once at 150% timeout). No new config fields in Block 11 — retry parameters (attempt counts, backoff multipliers) are hardcoded for v1, not configurable. Configurability deferred
- **Block 10 (CLI Interface):** Exit codes map to error categories per the table above. Executor mode error envelope defined. Interactive/one-shot error formatting defined

**Deferred:**
- Configurable retry parameters (attempt counts, backoff multipliers, jitter range)
- Error reporting / telemetry to remote service
- Adaptive retry based on observed provider behavior
- Custom error recovery strategies (user-defined retry policies)
- Error budget tracking (alerting when error rate exceeds threshold)
- Automatic session migration to different provider on persistent errors
- Structured error codes for specific tool failures beyond the generic `tool.*` categories (e.g., `tool.edit_conflict`, `tool.git_merge_conflict`)
- Error correlation across sessions (detecting provider-wide outages from local observations)
