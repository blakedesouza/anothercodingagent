# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Milestone 1: Minimal Agent Loop

Goal: Call an LLM, stream the response, support one tool (`read_file`), persist conversation as JSONL.

### M1.1 — Core Data Types (Block 5)

Define the foundational type system. All other code depends on these types.

- [ ] ULID generation utility with type-prefixed IDs (`ses_`, `trn_`, `stp_`, `itm_`, `call_`)
- [ ] `Session` type: id, workspaceId, parentSessionId, rootSessionId, status, config snapshot, created/updated timestamps
- [ ] `Turn` type: id, sessionId, turnNumber, status, outcome, itemSeqStart, itemSeqEnd, timing
- [ ] `Step` type: id, turnId, stepNumber, model, provider, finishReason, contextStats (tokenCount, tokenLimit, compressionTier)
- [ ] `ConversationItem` discriminated union:
  - `MessageItem` (role: system/user/assistant, parts: TextPart[] + ToolCallPart[])
  - `ToolResultItem` (toolCallId, output: ToolOutput envelope)
  - `SummaryItem` (text, pinnedFacts, coversSeq: {start, end})
- [ ] `ToolCallPart`: toolName, arguments, toolCallId
- [ ] `ToolOutput` envelope: status, data, error, truncated, bytesReturned, bytesOmitted, retryable, timedOut, mutationState, blobRef?
- [ ] `DelegationRecord`: childSessionId, childAgentId, finalStatus, parentEventId — embedded in `ToolResultItem` for delegation tools (not a separate item kind)
- [ ] `AcaError` shape: code, message, retryable, details?, cause?
- [ ] `TurnOutcome` enum: `assistant_final`, `awaiting_user`, `approval_required`, `max_steps`, `max_consecutive_tools`, `tool_error`, `cancelled`, `aborted`, `budget_exceeded`
- [ ] Monotonic sequence number generator per session

**Tests:**
- ULID generation produces valid ULIDs with correct prefixes
- ULID IDs are time-sortable (generate two, verify ordering)
- `MessageItem` requires: `recordType: "message"`, `role` (system|user|assistant), `parts` (non-empty TextPart[])
- `ToolCallPart` requires: `toolName` (non-empty string), `arguments` (object), `toolCallId` (prefixed ULID `call_`)
- `AcaError` requires: `code` (dot-delimited string), `message` (non-empty string), `retryable` (boolean)
- Sequence number generator is strictly monotonic (generate 100, verify no duplicates or out-of-order)
- `ConversationItem` discriminated union narrows correctly via `recordType` field
- `ToolOutput` envelope validates required fields (status is mandatory), `bytesOmitted` correct when truncated
- `DelegationRecord` embeds correctly in `ToolResultItem`, validates required fields (childSessionId, childAgentId, finalStatus)
- Serialization round-trip: create each type → JSON.stringify → JSON.parse → validate shape matches

### M1.2 — JSONL Conversation Log (Block 5)

Append-only persistence for conversation state.

- [ ] `ConversationWriter`: append typed records (turn, step, item) as single JSON lines to `conversation.jsonl`
- [ ] `ConversationReader`: read JSONL file, parse each line, yield typed records
- [ ] Record type discriminator field (`recordType`: `"turn"`, `"step"`, `"message"`, `"tool_result"`, `"summary"`)
- [ ] Crash-safe writes: each line is a complete JSON object, partial last line is detectable and discardable
- [ ] Line validation on read: skip malformed lines with warning

**Tests:**
- Write 10 records → read back → all 10 match
- Simulate crash: write partial line (truncated JSON) → reader skips it, returns all complete records
- Empty file → reader returns empty array
- Large record (near 64 KiB) writes and reads correctly
- Concurrent append safety: write from two contexts → no interleaving within lines (may need `O_APPEND` verification)
- `recordType` discriminator correctly identifies each variant

### M1.3 — Session Manager (Block 5, Block 10 Phase 5)

Session lifecycle: create, load, persist state.

- [x] `SessionManager.create(workspaceRoot)`: generate session ID, create directory at `~/.aca/sessions/<ses_ULID>/`, write initial `manifest.json`
- [x] `SessionManager.load(sessionId)`: read `manifest.json`, rebuild in-memory projection from `conversation.jsonl`
- [x] `manifest.json` schema: sessionId, workspaceId, status, turnCount, lastActivityTimestamp, configSnapshot, durableTaskState, calibration
- [x] `workspaceId` derivation: `wrk_<sha256(normalizedAbsolutePath)>`
- [x] In-memory projection: ordered item list, current turn state, running sequence counter
- [x] `manifest.json` overwritten at each turn boundary (not per-step)

**Tests:**
- Create session → directory exists, manifest.json is valid JSON, conversation.jsonl exists (empty)
- Load session → in-memory state matches what was written
- Write items → save manifest → reload → items and manifest match
- workspaceId is deterministic (same path → same id, different path → different id)
- workspaceId normalizes paths (trailing slash, `.` components don't change the id)
- Loading nonexistent session throws typed error

### M1.4 — Provider Interface + NanoGPT Driver (Block 17 minimal)

The LLM communication layer. Start with NanoGPT only.

- [x] `ProviderDriver` interface: `capabilities(model)`, `stream(request)`, `validate(config)`
- [x] `ModelCapabilities` type: maxContext, maxOutput, supportsTools, supportsStreaming, costPerMillion, bytesPerToken (default 3.0)
- [x] Minimal hardcoded model registry: map of model ID → `ModelCapabilities` for NanoGPT-available models. M5.1 replaces this with the full file-based registry (`models.json`). M3.1 depends on `bytesPerToken` from this registry
- [x] `ModelRequest` type: model, messages, tools?, maxTokens, temperature, extensions?
- [x] `StreamEvent` tagged union: `text_delta`, `tool_call_delta`, `done`, `error`
- [x] `NanoGptDriver` implementation:
  - `validate()`: check API key exists, base URL is reachable
  - `capabilities()`: return capabilities for the requested model (from internal mapping)
  - `stream()`: POST to NanoGPT chat completions endpoint, parse SSE stream, yield `StreamEvent`s
- [x] SSE stream parser: handle `data: [DONE]`, partial chunks, connection errors
- [x] Response normalization: map NanoGPT response format to canonical `StreamEvent`
- [x] Error mapping: HTTP 429 → `llm.rate_limited`, 401 → `llm.auth_error`, 5xx → `llm.server_error`, timeout → `llm.timeout`

**Tests:**
- `validate()` with missing API key returns ConfigError
- `capabilities()` returns correct maxContext for known models (e.g., claude-sonnet → 200K)
- Mock HTTP server: stream a simple text response → yields `text_delta` events followed by `done`
- Mock HTTP server: stream a tool call response → yields `tool_call_delta` events with correct name/arguments
- Mock HTTP server: 429 response → yields `error` event with `llm.rate_limited`
- Mock HTTP server: 500 response → yields `error` event with `llm.server_error`
- Mock HTTP server: connection timeout → yields `error` event with `llm.timeout`
- Mock HTTP server: malformed SSE → yields `error` event with `llm.malformed_response`
- StreamEvent reconstruction: accumulate `tool_call_delta` events → complete tool call with valid JSON arguments
- Stream interruption: abort HTTP request mid-stream → yields `error` event, no partial data
- Slow stream: mock server with delays between chunks → all chunks received in order
- Empty stream: server sends `done` immediately with no content → valid empty response

### M1.5 — Tool Runtime Contract (Block 15 minimal)

The shared layer all tools pass through.

- [x] `ToolRegistry`: register tools by name, look up tool by name, list all tools
- [x] `ToolDefinition`: name, description, inputSchema (JSON Schema), approvalClass, idempotent, timeoutCategory
- [x] `ToolRunner.execute(toolName, args, context)`:
  1. Look up tool in registry
  2. Validate `args` against `inputSchema` (use `ajv`)
  3. Apply per-category timeout (file: 5s, shell: 60s, etc.)
  4. Call tool implementation
  5. Validate output against `ToolOutput` envelope
  6. Enforce 64 KiB output cap (truncate with metadata)
  7. Return `ToolOutput`
- [x] Validation failure → `ToolOutput` with `status: "error"`, `error.code: "tool.validation"`
- [x] Timeout handling: graceful signal → 2s grace → force kill pattern (for subprocess tools)
- [x] Timeout → `ToolOutput` with `status: "error"`, `error.code: "tool.timeout"`, `timedOut: true`
- [x] Auto-retry for transient network errors on idempotent tools only: 3 attempts, exponential backoff (250ms start), connection reset/timeout/429/502/503/504
- [x] Non-idempotent tools (writes): no auto-retry, return error immediately

**Tests:**
- Register a tool → look it up by name → returns definition
- Look up nonexistent tool → returns undefined/null
- Valid args → tool executes, returns ToolOutput
- Invalid args (missing required field) → returns validation error without executing tool
- Invalid args (wrong type) → returns validation error with details (field path, constraint)
- Tool output exceeding 64 KiB → truncated, `truncated: true`, `bytesOmitted` correct
- Tool exceeding timeout → returns timeout error, `timedOut: true`
- Tool returning malformed output (missing `status`) → `tool.contract_violation` error
- Tool throwing exception → `tool.crash` error with details
- Idempotent tool with transient error: fake timers verify 3 attempts at t=0, t≈250ms, t≈500ms, then returns error
- Idempotent tool succeeds on attempt 2: first call returns 503, second succeeds → returns success ToolOutput
- Non-idempotent tool with transient error: single attempt, no retry, returns error immediately

### M1.6 — `read_file` Tool

The first tool. Validates the full tool pipeline end-to-end.

- [x] Input schema: `path` (required), `line_start` (optional, 1-indexed), `line_end` (optional, inclusive)
- [x] Read file contents, return with encoding, line count, byte count
- [x] Line range support: `line_start`/`line_end` return only that range with metadata for continuation (`nextStartLine`, `totalLines`, `totalBytes`)
- [x] Truncation at 64 KiB or 2,000 lines (whichever first), set `truncated: true` with metadata
- [x] Binary detection: null-byte check on first 1 KiB + extension heuristics → return metadata only (`isBinary`, size, MIME type)
- [x] File not found → `tool.not_found` error
- [x] Approval class: `read-only` (auto-approved)

**Tests:**
- Read a small text file → correct content, encoding, line count, byte count
- Read with line_start/line_end → returns only requested range, correct nextStartLine
- Read file > 2,000 lines → truncated at 2,000, `truncated: true`, metadata present
- Read file > 64 KiB → truncated at 64 KiB, `truncated: true`, bytesOmitted correct
- Whichever-first (line limit hit first): file with 3,000 short lines (10 bytes each, ~30 KiB total) → truncated at 2,000 lines, not at byte limit
- Whichever-first (byte limit hit first): file with 500 long lines (200 bytes each, ~100 KiB total) → truncated at 64 KiB, not at line limit
- Null-byte binary detection: file with `\x00` in first 1 KiB → `isBinary: true`, no content, size and MIME type present
- Extension-based binary detection: file named `image.png` with no null bytes → `isBinary: true` via extension heuristic (`.png`, `.jpg`, `.exe`, `.wasm`)
- Read nonexistent file → `tool.not_found` error
- Read empty file → content is empty string, 0 lines
- line_start > total lines → empty content with metadata
- line_start = 1, line_end = 1 → exactly one line
- File with mixed encodings → UTF-8 assumed, handled gracefully

### M1.6b — User Interaction Tools (Block 2)

The model needs explicit tools to ask the user questions and request confirmation.

- [x] `ask_user`: question (string), optional choices/format → user response. Approval class: `user-facing`
- [x] `confirm_action`: action description, affected paths, risk summary → approved (boolean). Approval class: `user-facing`
- [x] Both require TTY in interactive mode. In one-shot without TTY: `ask_user` fails with `user_cancelled`, `confirm_action` fails unless `--no-confirm`
- [x] In sub-agent context: `ask_user` and `confirm_action` are excluded from the sub-agent's tool profile (not offered to the model). If the model attempts to call them, the profile check (M2.6 step 1) denies them. Sub-agent user-interaction needs (e.g., tool approval) are handled by the approval routing system: the approval flow yields with `approval_required` to the parent, not via these tools
- [x] `ask_user` yields the turn with `awaiting_user` outcome
- [x] `confirm_action` yields with `approval_required` outcome

**Tests:**
- `ask_user` in interactive mode → prompt displayed on stderr, user response returned
- `ask_user` in one-shot without TTY → `user_cancelled` error
- `confirm_action` with TTY → approval prompt, returns boolean
- `confirm_action` with `--no-confirm` → auto-approved (returns true)
- Sub-agent calls `ask_user` → tool not in profile → denied with "not permitted by agent profile" (approval routing for other tools is tested in M2.6)
- Turn yields correctly: `ask_user` → `awaiting_user` outcome, `confirm_action` → `approval_required`

### M1.7 — Agent Loop / Turn Engine (Block 6)

The core execution cycle. This is the heart of the agent.

- [x] `TurnEngine` class with `executeTurn(session, input)`, `interrupt(level)`, `getPhase()`
- [x] Phase enum: `OpenTurn`, `AppendUserMessage`, `AssembleContext`, `CreateStep`, `CallLLM`, `NormalizeResponse`, `AppendAssistantMessage`, `CheckYieldConditions`, `ValidateToolCalls`, `ExecuteToolCalls`, `AppendToolResults`, `LoopOrYield`
- [x] Phase state machine: enforce valid transitions, emit events on each transition
- [x] First step of turn: phases 1-2 run before 3-12. Subsequent steps: enter at phase 3
- [x] `AssembleContext` (minimal v1): system prompt + tool definitions + conversation history (no compression yet)
- [x] `CallLLM`: call provider.stream(), buffer response, stream text to stdout
- [x] `NormalizeResponse`: reconstruct full response from stream events into TextPart[] + ToolCallPart[]
- [x] `CheckYieldConditions` (pre-execution yield): text-only response → yield with `assistant_final`. Step limit reached → yield with `max_steps`. Consecutive tool limit reached → yield with `max_consecutive_tools`. Tool calls present → continue to `ValidateToolCalls`. Does NOT check tool results (those don't exist yet at this phase)
- [x] `ValidateToolCalls`: validate each ToolCallPart against tool schema
- [x] `ExecuteToolCalls`: execute sequentially via ToolRunner, collect results
- [x] `AppendToolResults`: create ToolResultItem per result, append to log
- [x] `LoopOrYield` (post-execution yield): check tool results first — if any result has non-retryable error (`retryable: false`), yield with `tool_error` outcome. If any result has `mutationState: "indeterminate"`, yield with `tool_error` (unsafe to continue). Otherwise, if tool results were appended → loop to `AssembleContext`. If no tool results → yield
- [x] Step limits: 25 steps/turn (interactive), 30 (one-shot/sub-agent)
- [x] Consecutive autonomous tool limit: 10 (interactive only)
- [x] Max tool calls per assistant message: 10 (execute first 10, defer rest). Deferred calls are recorded as synthetic `ToolResultItem`s with `status: "error"`, `error.code: "tool.deferred"`, and a message listing the deferred tool names so the model knows which calls were not executed and can re-issue them
- [x] Return completed `TurnRecord` with outcome

**Tests:**
- Text-only response: input → LLM returns text → yields with `assistant_final`, single step recorded
- Single tool call: input → LLM returns tool call → tool executes → LLM returns text → yields with `assistant_final`, two steps
- Multi-tool response: LLM returns 3 tool calls → all 3 executed sequentially → results appended → next LLM call
- Step limit: mock LLM that always returns tool calls → engine stops at 25 steps with `max_steps` outcome
- Consecutive tool limit (10): mock LLM returning only tool calls → yields with `max_consecutive_tools` at step 10
- Max tool calls per message: LLM returns 12 tool calls → first 10 executed, remaining 2 get synthetic `tool.deferred` error results listing the deferred tool names. Model sees which calls were skipped
- Validation failure: LLM returns invalid tool call → synthetic error ToolResultItem created, model gets another step
- Tool error yield: non-retryable tool error → yields with `tool_error` outcome
- Indeterminate mutation: tool returns `mutationState: "indeterminate"` → yields with `tool_error` (unsafe to continue)
- Phase transitions: verify each phase emits correct event and advances to next phase
- Turn record: completed turn has correct outcome, step count, item range
- Conversation log: after turn, all items (user message, assistant messages, tool results) are in the JSONL

### M1.8 — Basic REPL (Block 10 minimal)

Minimal interactive CLI to exercise the loop.

- [x] Entry point: `aca` command via `commander` (v12+)
- [x] Mode detection: TTY → interactive mode; no TTY + positional arg → print "one-shot mode not yet supported" to stderr and exit 0
- [x] Minimal startup pipeline:
  1. Parse CLI args (just `--model` and `--verbose` for now)
  2. Load API key from env (`NANOGPT_API_KEY`)
  3. Create session
  4. Display startup status on stderr (version, session ID, model)
  5. Enter REPL
- [x] REPL: `readline` on stderr for prompt, stdout for assistant output
- [x] Submit user input → `TurnEngine.executeTurn()` → display streamed output → prompt again
- [x] `/exit` and `/quit` slash commands → clean exit
- [x] `/help` → list available commands
- [x] `/status` → show session info, token usage, active capabilities, model
- [x] Ctrl+D (EOF) → clean exit
- [x] Basic SIGINT: first → cancel active operation, second within 2s → abort turn and return to prompt

**Tests:**
- Startup with valid API key → session created, prompt displayed (integration test with mock provider)
- Startup with missing API key → error message, exit code 4
- `/exit` → process exits with code 0
- `/quit` → process exits with code 0 (alias for `/exit`)
- `/help` → outputs help text
- `/status` → outputs session ID, model name, turn count, token usage
- `--model` flag → overrides default model (verify provider receives specified model)
- `--verbose` flag → enables debug output on stderr (verify debug lines present)
- Mode detection: with TTY → interactive; without TTY + positional arg → prints "one-shot mode not yet supported" to stderr, exits 0
- Ctrl+D (EOF) during idle → clean exit with code 0
- SIGINT during idle (readline) → clears line, redisplays prompt (verify via mock)
- Double-SIGINT during active turn: first SIGINT → cancel current LLM call, second within 2s → abort turn, return to prompt with `cancelled` outcome

### M1.9 — Event System (Block 14 minimal)

Basic structured event logging from day one.

- [x] Event envelope: `event_id` (ULID), `timestamp` (ISO), `session_id`, `turn_number`, `agent_id`, `event_type`, `schema_version`, `parent_event_id?`
- [x] `EventSink` interface: `emit(event)` — writes to `events.jsonl`
- [x] JSONL event writer: append-only, one JSON object per line, synchronous writes
- [x] Core event types (typed payloads, 12 types):
  - `session.started` / `session.ended`
  - `turn.started` / `turn.ended` (with outcome)
  - `llm.request` (model, provider, estimated tokens) / `llm.response` (tokens in/out, latency, finish reason)
  - `tool.invoked` (tool name, args summary, `correlation_id` for pairing) / `tool.completed` (status, duration, bytes, `correlation_id`)
  - `delegation.started` (child agent ID, task summary) / `delegation.completed` (child agent ID, final status, token usage)
  - `context.assembled` (estimated tokens, budget, tier)
  - `error` (code, message, context — for errors not tied to a specific tool/LLM call)
- [x] Event sink injected into TurnEngine; emit at each phase transition
- [x] Content by reference: events carry item IDs, not full content

**Tests:**
- Emit session.started → event appears in events.jsonl with correct envelope fields
- Emit turn.started + turn.ended → both present, turn.ended has outcome
- Emit llm.request + llm.response → response has token counts and latency
- Emit tool.invoked + tool.completed → completed references invoked via `correlation_id` (dedicated field, not `parent_event_id`)
- Emit delegation.started + delegation.completed → completed has child agent ID and final status
- Emit error event → has code, message, and context
- Event IDs are unique ULIDs
- Timestamps are valid ISO-8601
- Malformed event (missing required field) → throws at emit time (dev safety)

### M1.10 — Integration Smoke Test

End-to-end validation of the complete M1 stack.

- [x] Integration test: start agent with mock NanoGPT server → send "read the file at test/fixtures/sample.txt" → agent calls read_file → returns content → agent responds with summary
- [x] Verify: conversation.jsonl has user message, assistant message (with tool call), tool result, final assistant message
- [x] Verify: events.jsonl has session.started, turn.started, llm.request, llm.response, tool.invoked, tool.completed, turn.ended
- [x] Verify: manifest.json has correct turn count, status, last activity

**Tests:**
- Full round-trip with mock provider: user input → tool call → tool result → final response
- Conversation log is complete and parseable
- Event log is complete and causally ordered
- Session can be loaded after completion (SessionManager.load)

---

## Post-Milestone Review
<!-- risk: medium — confirmed by 4-witness consultation 2026-03-30 -->
<!-- final-substep: M1.10 — gate runs after this substep completes -->
<!-- Status: Retroactively reviewed. M1 had no shell exec, permissions, or network access. -->
- [x] Architecture review: 198 tests, 10 substeps each with 4-witness review, no spec drift
- [x] Bug hunt: integration smoke test (M1.10) validated full round-trip, no cross-module issues
- [x] Review summary appended to changelog
