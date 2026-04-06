<!-- Source: fundamentals.md lines 1725-1746 -->
### Observability / Logging

Every agent action — LLM calls, tool executions, delegation, errors — emits a structured event into an append-only log. This is the single source of truth for debugging, cost accounting, and post-hoc session reconstruction. The event stream is designed once and written to from day one; rendering (terminal, dashboards, replay) is layered on top.

**Foundational decisions:**
- **Append-only structured event stream** — every event is a typed JSON object with a universal envelope (`event_id`, `timestamp`, `session_id`, `turn_number`, `agent_id`, `event_type`, `schema_version`). Synchronous writes for crash durability. JSONL file per session
- **Parent-child event chaining** — every event carries optional `parent_event_id` forming a causal tree. Delegation spawns a new `session_id` but preserves the parent chain across agent boundaries. Cheap to add now, painful to retrofit
- **12 core event types** — `session.started/ended`, `turn.started/ended`, `llm.request/response`, `tool.invoked/completed`, `delegation.started/completed`, `context.assembled`, `error`. Each with typed payload. No stream-delta events — log final outcomes and timings
- **Provider-agnostic token accounting** — capture whatever token counts the provider reports (`input_tokens`, `output_tokens`, plus any cache fields if available), along with `model`, `provider`, and `latency_ms`. Different APIs (NanoGPT, Anthropic, OpenAI) report tokens differently — store raw provider response fields, normalize later. Accumulate per-turn and per-session totals, attributed to `agent_id` for sub-agent cost rollup
- **Content by reference, not inline** — events carry content hashes or message IDs pointing to the conversation log. Keeps the event stream small and queryable
- **Dual output: machine log + human terminal** — JSONL event stream is the authoritative record. Separate renderer produces human-readable output on `stderr` in verbose/debug mode. `stdout` reserved for assistant content
- **Tool invocation/result pairing** — `tool.invoked` carries `invocation_id`, `tool.completed` references it. Required for replay and cost attribution
- **Log completeness enables replay** — the event stream plus conversation log must contain enough data to reconstruct the exact sequence. The replay *engine* is deferred; log *completeness* is not

**Deferred:**
- Replay engine
- Cost estimation with live pricing (raw token counts are enough initially)
- Budget warnings and hard limits
- Log rotation, compaction, retention policies
- Metrics aggregation, remote telemetry
- Secrets redaction beyond basic scrubbing
