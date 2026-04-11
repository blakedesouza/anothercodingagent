# M5.3 Handoff — SQLite Observability Store

**Date:** 2026-04-03
**Status:** M5.2 complete. Ready for M5.3.

## What's Done (M5.2)

| Deliverable | Status | Tests |
|---|---|---|
| Extension checking (required/optional) in AnthropicDriver, OpenAiDriver, NanoGptDriver | Complete | 8 |
| `tool-emulation.ts`: buildToolSchemaPrompt, injectToolsIntoRequest, parseEmulatedToolCalls (O(n)), wrapStreamWithToolEmulation | Complete | 19 |
| NanoGptDriver: rawStream() refactor + tool emulation integration | Complete | — |
| `moonshot-v1-8k` added to models.json (supportsTools: 'emulated') | Complete | — |
| TurnEngine fallback chain: fallbackChain config, ProviderRegistry param, model.fallback event | Complete | 8 |
| `model.fallback` event type in events.ts | Complete | — |
| **Total project tests** | | **1184** |

## What to Do Next (M5.3)

**M5.3 — SQLite Observability Store (Block 19):**

- [ ] `~/.aca/observability.db` with tables: sessions, events, tool_calls, errors
- [ ] `better-sqlite3` for synchronous reads, debounced background writes (1s interval)
- [ ] JSONL → SQLite batch insert (background writer)
- [ ] Backfill on session resume: events in JSONL not yet in SQLite
- [ ] SQLite failure → warn, continue (JSONL is authoritative)

**Tests:**
- Session start → session row created in SQLite
- Batch write semantics: emit 5 events rapidly → all 5 inserted in a single batch after 1s debounce (not 5 individual writes). Verify with fake timers: no writes at 999ms, all 5 present at 1001ms
- Events emitted during debounce window → queued and included in next batch
- Query across sessions: 3 sessions → all queryable
- SQLite write failure (simulate) → warning emitted, agent continues, events still in JSONL
- Backfill: create events, skip SQLite write, resume → backfill detects and inserts missing events

## Dependencies

- `better-sqlite3` must be added to dependencies (`npm install better-sqlite3 @types/better-sqlite3`)
- Event system (M1.9): `EventEnvelope`, `AcaEvent`, `EventType` — already defined in `src/types/events.ts`
- JSONL event log path: `<workspaceDir>/events.jsonl` (written by JsonlEventSink, M1.9)
- Session resume (M3.7): `resume()` in `src/core/session-manager.ts` — the backfill should hook here
- JSONL is authoritative; SQLite is a secondary index for querying

## File Locations

- Step file: `docs/steps/05-milestone5-provider-obs.md`
- Spec: Block 19 in `docs/spec/19-advanced-observability.md`
- New source: `src/observability/sqlite-store.ts` (suggested)
- New source: `src/observability/background-writer.ts` (debounced batch writer)
- Event types: `src/types/events.ts`
- Session manager (for backfill hook): `src/core/session-manager.ts`

## Key Design Notes

- `better-sqlite3` is **synchronous** — use it only for reads and for the background writer's batch insert. Don't call it in the hot path of every event emission.
- The debounce pattern: collect events in an in-memory queue; a `setTimeout` fires after 1s of inactivity and flushes the batch. Reset the timer on each new event.
- JSONL → SQLite backfill: on `resume()`, compare event_ids in JSONL vs SQLite for that session; insert any missing rows in one batch.
- SQLite failure isolation: wrap all SQLite operations in try/catch; emit a warning event and continue. Never let SQLite errors bubble up to the agent loop.
- Table schema suggestion:
  ```sql
  CREATE TABLE sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT, started_at TEXT, ended_at TEXT, status TEXT);
  CREATE TABLE events (event_id TEXT PRIMARY KEY, session_id TEXT, event_type TEXT, timestamp TEXT, payload TEXT);
  CREATE TABLE tool_calls (event_id TEXT PRIMARY KEY, session_id TEXT, tool_name TEXT, status TEXT, duration_ms INTEGER);
  CREATE TABLE errors (event_id TEXT PRIMARY KEY, session_id TEXT, code TEXT, message TEXT);
  ```
