# M1.10 Handoff — Integration Smoke Test

**Date:** 2026-03-30
**Status:** M1.9 complete. Ready for M1.10 implementation.

## What's Done (M1.9)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `src/types/events.ts` — Event envelope, 12 typed payloads, EventPayloadMap, AcaEvent<T> | Complete | — |
| `src/core/event-sink.ts` — EventSink interface, NullEventSink, JsonlEventSink, createEvent helper | Complete | 9 |
| Runtime event_type validation against VALID_EVENT_TYPES set | Complete | 1 (malformed test) |

**Total tests: 194 passing** (185 prior + 9 new).

**Consultation:** 4/4 witnesses reviewed. 1 consensus fix applied (event_type runtime validation).

## What to Do Next (M1.10)

Execute M1.10 from `docs/steps/01-milestone1-agent-loop.md`. This is the end-to-end integration smoke test for the complete M1 stack.

### Key Requirements

- Integration test: start agent with mock NanoGPT server → send "read the file at test/fixtures/sample.txt" → agent calls read_file → returns content → agent responds with summary
- Verify: conversation.jsonl has user message, assistant message (with tool call), tool result, final assistant message
- Verify: events.jsonl has session.started, turn.started, llm.request, llm.response, tool.invoked, tool.completed, turn.ended
- Verify: manifest.json has correct turn count, status, last activity

### Tests Required (4)

1. Full round-trip with mock provider: user input → tool call → tool result → final response
2. Conversation log is complete and parseable
3. Event log is complete and causally ordered
4. Session can be loaded after completion (SessionManager.load)

## Dependencies

- **TurnEngine** from `src/core/turn-engine.ts` (M1.7) — core execution loop
- **ConversationWriter** from `src/core/conversation-writer.ts` (M1.2) — JSONL conversation log
- **EventSink** from `src/core/event-sink.ts` (M1.9) — structured event logging
- **SessionManager** from `src/core/session-manager.ts` (M1.3) — session lifecycle
- **ToolRegistry + read_file** from `src/tools/` (M1.5, M1.6) — tool execution
- **NanoGptDriver** from `src/providers/nanogpt-driver.ts` (M1.4) — LLM communication
- **Mock NanoGPT server** from `test/helpers/mock-nanogpt-server.ts` — test infrastructure

## File Locations

| New File | Purpose |
|----------|---------|
| `test/integration/smoke.test.ts` | End-to-end integration test |
| `test/fixtures/sample.txt` | Test fixture for read_file (may already exist) |

## Design Notes

This is a **test-only** substep — no new source code. The integration test wires together all M1 components:

1. Create a mock NanoGPT server that returns a tool call for `read_file` on first request, then a text summary on second request
2. Create a SessionManager with a temp directory
3. Create a TurnEngine with real ConversationWriter, real ToolRegistry (with read_file registered), and real JsonlEventSink
4. Execute a turn with user input → verify the full pipeline works end-to-end
5. Verify all three persistence artifacts: conversation.jsonl, events.jsonl, manifest.json

Note: The EventSink is not yet wired into TurnEngine — M1.9 created the sink but TurnEngine integration was listed as a checkbox item. The smoke test may need to wire it up or verify events via a separate emit path. Check TurnEngine's constructor and `executeTurn` to determine how to inject the event sink.

## Known State from M1.9

- 194 tests passing across 15 test files
- EventSink has `emit()` method; `createEvent()` helper builds typed events
- TurnEngine extends EventEmitter and emits `'phase'` events — the integration test can listen to these or use JsonlEventSink directly
