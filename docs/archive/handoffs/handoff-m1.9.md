# M1.9 Handoff — Event System

**Date:** 2026-03-30
**Status:** M1.8 complete. Ready for M1.9 implementation.

## What's Done (M1.8)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `src/index.ts` entry point (commander, --model, --verbose, API key validation) | Complete | 2 (mode detection logic) |
| `src/cli/repl.ts` REPL loop (readline, turn execution, SIGINT) | Complete | 12 |
| `src/cli/commands.ts` slash commands (/exit, /quit, /help, /status) | Complete | 6 |
| Manifest persistence at turn boundaries | Complete | — |
| workspaceRoot fix (passes cwd, not hash) | Complete | — |

**Total tests: 185 passing** (165 prior + 20 new).

**Consultation:** 4/4 witnesses reviewed. 3 consensus fixes applied (workspaceRoot, manifest persistence, SIGINT null check).

## What to Do Next (M1.9)

Execute M1.9 from `docs/steps/01-milestone1-agent-loop.md`. This is the basic structured event logging system.

### Key Requirements

- Event envelope: `event_id` (ULID), `timestamp` (ISO), `session_id`, `turn_number`, `agent_id`, `event_type`, `schema_version`, `parent_event_id?`
- `EventSink` interface: `emit(event)` — writes to `events.jsonl`
- JSONL event writer: append-only, one JSON object per line, synchronous writes
- 12 core event types with typed payloads:
  - `session.started` / `session.ended`
  - `turn.started` / `turn.ended` (with outcome)
  - `llm.request` / `llm.response` (tokens, latency)
  - `tool.invoked` / `tool.completed` (correlation_id)
  - `delegation.started` / `delegation.completed`
  - `context.assembled`
  - `error`
- Event sink injected into TurnEngine; emit at each phase transition
- Content by reference: events carry item IDs, not full content

### Tests Required (10)

See step file M1.9 section for full test specifications.

## Dependencies

- `TurnEngine` from `src/core/turn-engine.ts` (M1.7) — already emits phase events via EventEmitter
- `generateId` from `src/types/ids.ts` for ULID event IDs
- `ConversationWriter` pattern from `src/core/conversation-writer.ts` for JSONL append

## File Locations

| New File | Purpose |
|----------|---------|
| `src/core/event-sink.ts` | EventSink interface + JSONL writer |
| `src/types/events.ts` | Event envelope and typed payload definitions |
| `test/core/event-sink.test.ts` | Event system tests |

## Design Notes

The TurnEngine already extends EventEmitter and emits `'phase'` events. M1.9 adds a structured event system on top:
1. Define the `EventSink` interface and event types
2. Implement a JSONL-based event writer
3. Inject the sink into TurnEngine and wire up emissions at each phase
4. The REPL (`src/index.ts`) creates the event sink and passes it through

## Known State from M1.8

- 185 tests passing across 14 test files
- `src/cli/repl.ts` creates a new TurnEngine per turn — the event sink will need to be passed to the TurnEngine constructor or executeTurn config
- Manifest persistence is working at turn boundaries
