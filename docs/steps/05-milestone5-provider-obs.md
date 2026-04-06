# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Milestone 5: Multi-Provider + Observability

Goal: Full provider abstraction, cost tracking, budget controls, analytics.

### M5.1 — Full Provider Abstraction (Block 17)

- [x] Anthropic driver: capabilities, stream (SSE content blocks), validate
- [x] OpenAI driver: capabilities, stream (SSE token deltas), validate
- [x] Optional `embed(texts, model)` method on `ProviderDriver` for API-based embeddings (Block 20 fallback path) — **DEFERRED**: all 3 audit witnesses agreed embed() tests deferred until M6 integration. Placeholder: method signature exists, throws `not_implemented` if called
- [x] `supportsEmbedding` and `embeddingModels` fields in `ModelCapabilities`
- [x] Model registry (`models.json`): model IDs, aliases, capabilities, cost data. Replaces M1.4's hardcoded registry
- [x] Model resolution: exact match → alias → default
- [x] `providers` array config (backward-compat with singular `provider`)
- [x] Provider priority for multi-provider model availability

**Tests:**
- Mock Anthropic API → correct StreamEvent normalization (content blocks → text_delta/tool_call_delta)
- Mock OpenAI API → correct StreamEvent normalization
- Both providers: final `done` event preserves `finishReason` and `usage` (token counts) — required by M5.4 cost tracking
- Model resolution: `claude-sonnet` → alias resolves to full ID → selected driver (test configures single provider to avoid priority ambiguity)
- Unknown model → error
- Priority: model available from 2 providers → higher priority selected

### M5.2 — Provider Features (Block 17)

- [x] Extensions system: `ExtensionRequest` in ModelRequest, `required` flag
- [x] Tool calling emulation for non-native providers (inject schemas in system prompt, parse JSON from response)
- [x] Fallback chains: configured in user config, tried on provider-level errors only
- [x] `model.fallback` event on fallback
- [x] `toolReliability` field in capabilities

**Tests:**
- Extension with `required: true` on unsupported provider → error
- Extension with `required: false` on unsupported provider → warning logged, request proceeds
- Tool emulation: mock provider without native tools → tool definitions injected in system prompt
- Tool emulation: model returns JSON tool call in text → parsed correctly into ToolCallPart
- Fallback chain: primary returns 429 after retries → next model tried
- Fallback NOT triggered on content filter (llm.content_filtered)
- Fallback NOT triggered on auth error

### M5.3 — SQLite Observability Store (Block 19)

- [x] `~/.aca/observability.db` with tables: sessions, events, tool_calls, errors
- [x] `better-sqlite3` for synchronous reads, debounced background writes (1s interval)
- [x] JSONL → SQLite batch insert (background writer)
- [x] Backfill on session resume: events in JSONL not yet in SQLite
- [x] SQLite failure → warn, continue (JSONL is authoritative)

**Tests:**
- Session start → session row created in SQLite
- Batch write semantics: emit 5 events rapidly → all 5 inserted in a single batch after 1s debounce (not 5 individual writes). Verify with fake timers: no writes at 999ms, all 5 present at 1001ms
- Events emitted during debounce window → queued and included in next batch
- Query across sessions: 3 sessions → all queryable
- SQLite write failure (simulate) → warning emitted, agent continues, events still in JSONL
- Backfill: create events, skip SQLite write, resume → backfill detects and inserts missing events

### M5.4 — Cost Tracking + Budget (Block 19)

- [x] Cost calculation: `(input_tokens * costPerMillion.input + output_tokens * costPerMillion.output) / 1_000_000` — separate input/output rates per Block 19
- [x] Per-event `cost_usd` field on `llm.response` events
- [x] In-memory `sessionCostAccumulator`: updated synchronously after each LLM response
- [x] Budget config: `budget.session`, `budget.daily`, `budget.warning` (fraction)
- [x] Warning at threshold → stderr message
- [x] Hard stop at 100% → `budget_exceeded` turn outcome
- [x] Daily budget: at session start, query SQLite for today's completed-session costs → store as `dailyBaselineCost`. Per-response check: `dailyBaselineCost + sessionCostAccumulator > budget.daily`. Uses per-event timestamps (not session start) to handle midnight-spanning sessions
- [x] `/budget extend <amount>` slash command for interactive override

**Tests:**
- LLM response with 1000 input + 500 output tokens, model cost = $3/$15 per million → correct USD
- Session accumulator: 3 LLM calls → total matches sum
- Budget warning at 80% of $5 budget → warning emitted at $4.00
- Budget exceeded at $5.00 → turn yields with `budget_exceeded`
- `/budget extend 5` → budget raised to $10, execution continues
- Daily budget: previous sessions today cost $20, daily limit $25 → $5 remaining
- Unknown model cost (null) → no budget enforcement for that call, warning
- Daily budget mid-session: baseline=$20, limit=$25, session spends $6 → blocked at $26 (not just checked at startup)

### M5.5 — `aca stats` Command (Block 19)

- [x] New commander subcommand: `aca stats`
- [x] Default: last 7 days summary (sessions, cost, tokens, most-used tools, error rate)
- [x] `--session <id>`: per-turn breakdown
- [x] `--today`: today's usage + remaining daily budget
- [x] `--json`: structured JSON output

**Tests:**
- `aca stats` default output contains: session count, total cost (USD), total tokens (input+output), top 5 most-used tools by call count, error rate (errors/total calls as percentage)
- `aca stats --session ses_123` → per-turn breakdown: turn number, tool calls in turn, tokens used, cost, turn outcome
- `aca stats --today` → today's session count, total cost, remaining daily budget (if configured), tokens
- `aca stats --json` → valid JSON output with same fields as text mode, parseable by `JSON.parse`
- No sessions → graceful empty output (not an error)

### M5.6 — Log Retention (Block 19)

- [x] 30-day default retention, 5 GB size cap
- [x] Sessions > 7 days: compress JSONL (gzip), remove blobs
- [x] Sessions > 30 days: prune from disk
- [x] SQLite records retained (with `pruned` flag) for long-term trends
- [x] Runs at session start, max 10 sessions per startup

**Tests:**
- Session 31 days old → pruned from disk, SQLite row has `pruned=true`
- Session 8 days old → JSONL gzipped, blobs removed
- Total > 5 GB → oldest sessions pruned until under limit
- Max 10 per startup → remaining sessions deferred to next startup

### M5.7 — Remote Telemetry (Block 19, opt-in)

- [x] `telemetry` config: `enabled` (default false), `endpoint` (OTLP/HTTP URL), `interval` (seconds, default 300)
- [x] Telemetry config is user-only (project config cannot enable)
- [x] `@opentelemetry/api` + `@opentelemetry/exporter-metrics-otlp-http` for export
- [x] Exports aggregate metrics only: session count, total tokens, total cost, error counts by code, latency percentiles, tool usage counts
- [x] Never exports: conversation content, tool arguments/results, file paths/content, user/assistant messages, error details
- [x] Secrets scrubbing (Block 8) runs before telemetry export
- [x] Background export at configured interval, non-blocking
- [x] Unreachable endpoint → silently drop metrics, never affect agent operation

**Tests:**
- `telemetry.enabled: false` (default) → no export attempted
- `telemetry.enabled: true` with mock endpoint → aggregate metrics sent at interval
- Verify no conversation content in exported payload
- Unreachable endpoint → no error, agent continues normally
- Project config sets `telemetry.enabled: true` → rejected (user-only)

### M5.8 — CLI Wiring + Integration Test (All Blocks)

Wire all M1–M5 modules into `src/index.ts` and verify the agent works end-to-end against real NanoGPT API. This is a retroactive catch-up for M1–M4 wiring (never done) plus M5 features.

- [x] Register all tools in `index.ts`: read_file, write_file, edit_file, delete_path, move_path, make_directory, stat_path, find_paths, search_text, exec_command, open_session, session_io, close_session, ask_user, confirm_action, estimate_tokens
- [x] Load config via `ConfigLoader` (5-source precedence chain)
- [x] Create `Renderer` and wire to TurnEngine's `onTextDelta` for colored/highlighted output
- [x] Wire `WorkspaceSandbox` (zone enforcement) into tool context
- [x] Wire `ApprovalFlow` (confirm/deny/always) into tool execution
- [x] Wire `SecretScrubber` into TurnEngine constructor
- [x] Wire `NetworkPolicy` into tool context
- [x] Wire `EventSink` + `BackgroundWriter` + `SqliteStore` for observability
- [x] Wire `CostTracker` with budget config into TurnEngine
- [x] Wire `ProviderRegistry` with fallback chains
- [x] Load `NANOGPT_API_KEY` from `~/.api_keys` as fallback when env var is not set
- [x] Real API smoke test: start agent, send a prompt, verify LLM response streams back
- [x] Real tool test: ask agent to read a file, verify `read_file` tool executes and result is used
- [x] Real write test: ask agent to write a file, verify approval prompt appears, file is created
- [x] Real exec test: ask agent to run a command, verify risk analysis and approval flow

**Tests:**
- Integration test with real NanoGPT API (requires `NANOGPT_API_KEY`): send prompt → receive streamed response
- Tool round-trip: prompt triggers `read_file` → tool output returned to LLM → LLM references file content
- Approval flow: `write_file` triggers confirmation prompt in interactive mode
- Renderer output: verify colored/highlighted text appears on stderr (manual visual check)
- Session persistence: after a turn, `manifest.json` and `conversation.jsonl` contain expected data

---

## Post-Milestone Review
<!-- risk: high — multi-provider credentials, external API network requests, budget enforcement -->
<!-- final-substep: M5.8 — gate runs after this substep completes -->
- [x] Architecture review (4 witnesses): spec drift, coupling, interface consistency
- [x] Security review (4 witnesses): credential handling across providers, telemetry data exposure
- [x] Bug hunt (4 witnesses): cross-module integration, adversarial state transitions
- [x] Arch findings fed into security prompt; security findings fed into bug hunt prompt
- [x] Critical findings fixed and verified before next milestone
- [x] Bug hunt findings converted to regression tests
- [x] Review summary appended to changelog
