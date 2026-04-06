# M1.8 Handoff — Basic REPL

**Date:** 2026-03-30
**Status:** M1.7 complete. Ready for M1.8 implementation.

## What's Done (M1.7)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `TurnEngine` class (executeTurn, interrupt, getPhase) | Complete | 12 |
| 12-phase state machine with event emission | Complete | 1 |
| LLM streaming via provider.stream() | Complete | — |
| Tool call validation + sequential execution | Complete | 3 |
| CheckYieldConditions (text-only, step limit, consecutive tools) | Complete | 3 |
| LoopOrYield (yieldOutcome, non-retryable error, indeterminate) | Complete | 2 |
| Max 10 tool calls per message with deferred handling | Complete | 1 |
| Turn record with outcome, steps, item range | Complete | 1 |
| Conversation JSONL persistence | Complete | 1 |

**Total tests: 165 passing** (153 prior + 12 new).

**Consultation:** 4/4 witnesses reviewed. 2 consensus fixes applied (stream error → `aborted`, deferredNames pre-compute).

## What to Do Next (M1.8)

Execute M1.8 from `docs/steps/01-milestone1-agent-loop.md`. This is the minimal interactive CLI.

### Key Requirements

- Entry point: `aca` command via `commander` (v12+)
- Mode detection: TTY → interactive; no TTY + positional arg → print "one-shot mode not yet supported"
- Minimal startup: parse CLI args (`--model`, `--verbose`), load API key from `NANOGPT_API_KEY`, create session, display startup status
- REPL: `readline` on stderr for prompt, stdout for assistant output
- Submit user input → `TurnEngine.executeTurn()` → display streamed output → prompt again
- Slash commands: `/exit`, `/quit`, `/help`, `/status`
- Ctrl+D (EOF) → clean exit
- Basic SIGINT: first → cancel active operation, second within 2s → abort turn

### Tests Required (12)

See step file M1.8 section for full test specifications.

## Dependencies

- `TurnEngine` from `src/core/turn-engine.ts` (M1.7)
- `SessionManager` from `src/core/session-manager.ts` (M1.3)
- `ToolRegistry` + `ToolRunner` from `src/tools/` (M1.5)
- `NanoGptDriver` from `src/providers/` (M1.4)
- `read_file` tool from `src/tools/read-file.ts` (M1.6)
- `ask_user` + `confirm_action` from `src/tools/` (M1.6b)
- `commander` package (already in dependencies)

## File Locations

| New File | Purpose |
|----------|---------|
| `src/cli/repl.ts` | REPL loop with readline |
| `src/cli/commands.ts` | Slash command handlers |
| `src/index.ts` | Entry point (may need updates) |
| `test/cli/repl.test.ts` | REPL tests (mock provider, mock readline) |

## Design Notes

The REPL needs to:
1. Wire up `TurnEngine` with `NanoGptDriver`, `ToolRegistry`, `SessionManager`, `ConversationWriter`
2. Use `config.onTextDelta` callback to stream text to stdout in real-time
3. Handle `TurnOutcome` after each turn — `assistant_final` → re-prompt, `awaiting_user` → special handling, etc.
4. Map SIGINT to `TurnEngine.interrupt()` — first signal = 'cancel', second within 2s = 'abort'

## Known Limitations from M1.7

- `turnNumber` hardcoded to 1 — M1.8 REPL should track turn count and pass it to the engine (or the engine config should accept it)
- No token estimation yet — `maxTokens` and `temperature` are hardcoded in TurnEngine
