<!-- Source: fundamentals.md lines 2094-2234 -->
### Block 19: Advanced Observability

Comprehensive telemetry for debugging, cost accounting, and performance optimization. This block extends the existing Observability / Logging outline (12 core event types, append-only JSONL, dual output) with queryable storage, cost tracking, budget controls, metrics aggregation, and session analytics. The JSONL event stream remains the authoritative record; this block adds layers on top.

**Core principle: local-first observability with opt-in remote export.** All telemetry is stored locally and queryable locally. No data leaves the machine unless the user explicitly configures a remote backend. Remote telemetry sends only aggregate metrics (token counts, latencies, error rates), never conversation content. Secrets scrubbing (Block 8) runs before any telemetry pipeline.

**Foundational decisions:**

- **SQLite as queryable local store alongside authoritative JSONL.** The JSONL event stream remains the append-only source of truth (crash-safe, grepable, per-session). SQLite is a secondary store built from JSONL events, optimized for cross-session queries, aggregation, and the analytics commands.

  **Database location:** `~/.aca/observability.db` — a single SQLite database for all sessions. Created on first session if it does not exist. Schema managed by the agent (no external migration tool).

  **Core tables:**

  | Table | Purpose | Key columns |
  |---|---|---|
  | `sessions` | Session index | `session_id`, `workspace_id`, `started_at`, `ended_at`, `status`, `model`, `provider`, `total_input_tokens`, `total_output_tokens`, `total_cost_usd`, `turn_count` |
  | `events` | Flattened event index | `event_id`, `session_id`, `event_type`, `timestamp`, `agent_id`, `turn_number`, `latency_ms`, `tokens_in`, `tokens_out`, `cost_usd` |
  | `tool_calls` | Tool invocation index | `event_id`, `session_id`, `tool_name`, `status`, `duration_ms`, `input_bytes`, `output_bytes` |
  | `errors` | Error index | `event_id`, `session_id`, `error_code`, `retryable`, `provider`, `model` |

  **Write path:** Events are written to JSONL synchronously (existing design). A background writer (debounced, 1s interval) batch-inserts events into SQLite. If SQLite writes fail (disk full, corruption), the agent warns on stderr and continues — JSONL is the source of truth. On session resume, any JSONL events not yet in SQLite are backfilled.

  **Rationale:** SQLite enables queries that JSONL cannot efficiently answer: "total cost across last 7 days," "most expensive sessions," "tool failure rate by category." The async write path ensures SQLite never blocks the agent loop. `better-sqlite3` is used (synchronous API, but writes are batched in the background interval — not per-event).

- **Cost tracking maps provider-reported token counts to USD via Block 17's model registry.** The `costPerMillion` field in `ModelCapabilities` (Block 17) is the single source of truth for pricing. There is no separate pricing file — cost data lives with model metadata.

  Costs are USD per million tokens. The cost calculator multiplies provider-reported `input_tokens` and `output_tokens` by the model's `costPerMillion.input` and `costPerMillion.output` rates. If a model's cost data is not available (missing from registry), cost is recorded as `null` (unknown) — never estimated or guessed. Users can override cost rates in their user config under the `models` key (same location as model aliases and metadata overrides).

  **Cost is recorded at three levels:**
  1. Per-event: each `llm.response` event carries `cost_usd` (or null)
  2. Per-turn: accumulated from step events within the turn
  3. Per-session: accumulated from all turns, stored in the session summary

- **Budget controls provide warnings and hard stops at configurable cost thresholds.** Budgets are optional — if not configured, no limits apply.

  **Budget configuration (Block 9 extension):**
  ```json
  {
    "budget": {
      "session": 5.00,
      "daily": 25.00,
      "warning": 0.80
    }
  }
  ```

  `session`: maximum USD per session. `daily`: maximum USD across all sessions in a calendar day. `warning`: fraction of budget at which to warn (default 0.80 = 80%).

  **Enforcement uses in-memory counters, not SQLite queries.** Each session maintains an in-memory `sessionCostAccumulator` that is updated synchronously after every `llm.response` event — this is the authoritative cost for budget enforcement. SQLite is used only for historical cross-session queries (daily budget check at session start), not for real-time enforcement within a session.

  - At 80% (or configured warning threshold): stderr warning: `Budget alert: $4.00 / $5.00 session budget used (80%)`
  - At 100%: hard stop. The turn engine refuses to make further LLM calls. The turn yields with a new outcome: `budget_exceeded`. The user can override with `/budget extend <amount>` in interactive mode or restart with a higher budget
  - Daily budget: checked at session start by querying SQLite for completed sessions today, plus the current session's in-memory accumulator. The check uses per-event timestamps (`llm.response` event time), not session start time, to correctly handle sessions that span midnight

  **Rationale:** LLM API costs can accumulate rapidly during long sessions with multiple sub-agents. Hard stops prevent surprise bills. The 80% warning gives the user time to wrap up or extend. Budget config is user-only — project config cannot set budgets (Block 9 trust boundary).

- **Key metrics are aggregated in SQLite and available via CLI commands.** The agent tracks metrics that inform optimization decisions:

  | Metric | Aggregation | Purpose |
  |---|---|---|
  | Tokens per turn | mean, p50, p95 | Detect context bloat or compression effectiveness |
  | Cost per session | sum, mean | Budget planning |
  | Tool success rate | by tool name | Identify unreliable tools or common failures |
  | LLM latency | by provider/model, p50/p95 | Provider performance comparison |
  | Context compression ratio | per session | Effectiveness of Block 7's compression |
  | Error rate | by error code | Identify recurring issues |
  | Steps per turn | mean, max | Detect runaway loops or inefficient task decomposition |

  Metrics are computed on-demand from SQLite queries, not pre-aggregated. This keeps the write path simple and ensures metrics are always consistent with the underlying data.

- **CLI analytics interface: `aca stats` command.** A new subcommand (extending Block 10's command tree) provides session analytics.

  | Command | Output |
  |---|---|
  | `aca stats` | Summary of last 7 days: total sessions, total cost, tokens used, most-used tools, error rate |
  | `aca stats --session <id>` | Detailed breakdown of a specific session: per-turn cost, tool calls, errors, timing |
  | `aca stats --today` | Today's usage: sessions, cost, remaining daily budget |
  | `aca stats --json` | All stats as JSON for piping to other tools |

  **No web UI in v1.** A local dashboard server (`aca dashboard`) is deferred. The CLI command provides sufficient analytics for v1. If detailed visualization is needed, `aca stats --json` can feed external tools (jq, spreadsheets, Grafana).

- **Log retention: time-based with size cap.** Session data (JSONL + blobs) in `~/.aca/sessions/` and SQLite records are subject to retention policy.

  **Policy:**
  - Keep session data for 30 days by default
  - If total storage exceeds 5 GB, prune oldest sessions first (regardless of age)
  - Sessions older than 7 days are compressed (gzip JSONL files, remove blobs)
  - Retention policy runs on session start (not a background daemon), processing at most 10 expired sessions per startup to avoid slow starts

  **Configuration:** `retention.days` (default 30), `retention.maxSizeGb` (default 5) in user config. Retention is user-only — project config cannot override.

  **SQLite cleanup:** When a session is pruned from disk, its SQLite records are retained (they are small — just index rows). This preserves long-term cost and usage trends even after session data is deleted. A `pruned` flag on the sessions table indicates the session's detail data is no longer available.

- **Remote telemetry is opt-in, aggregate-only, and post-scrubbing.** An optional OpenTelemetry exporter sends aggregate metrics to a configured endpoint. This is for users who want to track usage across machines or teams.

  **What is sent:** Session count, total tokens, total cost, error counts by code, latency percentiles, tool usage counts. All values are numeric aggregates.

  **What is never sent:** Conversation content, tool arguments, tool results, file paths, file content, user messages, assistant messages, error messages, error details. No content of any kind leaves the machine.

  **Configuration:**
  ```json
  {
    "telemetry": {
      "enabled": false,
      "endpoint": "https://otel-collector.example.com",
      "interval": 300
    }
  }
  ```

  `enabled`: must be explicitly set to `true` (default `false`). `endpoint`: OpenTelemetry-compatible OTLP/HTTP endpoint. `interval`: export interval in seconds (default 300 = 5 minutes). Telemetry config is user-only.

  **Implementation:** Uses `@opentelemetry/api` and `@opentelemetry/exporter-metrics-otlp-http` (lightweight, well-maintained). The exporter runs in the background and does not affect agent performance. If the endpoint is unreachable, metrics are silently dropped — telemetry failure never affects agent operation.

**Integration with other blocks:**

- **Observability / Logging (existing outline):** Block 19 extends, not replaces, the existing design. The 12 event types, JSONL format, and event envelope are unchanged. Block 19 adds: SQLite indexer, cost calculator, budget enforcement, CLI stats, retention, and optional remote export
- **Block 6 (Agent Loop):** Budget enforcement hooks into `CheckYieldConditions` (phase 8). If the accumulated session cost exceeds the budget, the check yields with `budget_exceeded` outcome. This adds a 9th turn outcome to Block 5's list
- **Block 9 (Configuration):** New config groups: `budget`, `retention`, `telemetry`. All user-only fields
- **Block 8 (Permissions):** Secrets scrubbing runs before SQLite writes and before telemetry export. The scrubbing pipeline (4 points) is unchanged — SQLite writes happen after the persistence scrubbing point
- **Block 17 (Multi-Provider):** Cost rates come from the model metadata registry. Provider name and model name are indexed in SQLite for per-provider analytics

**Dependencies:**

| Package | Size | Purpose |
|---|---|---|
| `better-sqlite3` | ~2MB + native | Queryable local storage |
| `@opentelemetry/api` | ~200KB | Telemetry API (optional) |
| `@opentelemetry/exporter-metrics-otlp-http` | ~100KB | OTLP export (optional) |

**Deferred:**
- Local web dashboard (`aca dashboard`)
- Real-time streaming to remote dashboard
- Custom metric alerts (webhook, Slack)
- Anomaly detection for cost spikes
- Multi-user/team aggregation
- Compliance audit logging
- Session comparison (diff metrics between sessions)
- Token budget per-turn (not just per-session cost)
