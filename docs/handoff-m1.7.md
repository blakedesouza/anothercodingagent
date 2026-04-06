# M1.7 Handoff — Agent Loop / Turn Engine

**Date:** 2026-03-30
**Status:** M1.6b complete. Ready for M1.7 implementation.

## What's Done (M1.6b)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `ask_user` spec + impl (question, choices, format) | Complete | 9 |
| `confirm_action` spec + impl (action, affected_paths, risk_summary) | Complete | 13 |
| TTY/non-interactive mode guards | Complete | 2 |
| Sub-agent denial (isSubAgent check) | Complete | 2 |
| autoConfirm bypass (--no-confirm) | Complete | 2 |
| yieldOutcome signaling on ToolOutput | Complete | 2 |
| promptUser error handling (try/catch → user_cancelled) | Complete | 2 |
| ToolContext extensions (interactive, autoConfirm, isSubAgent, promptUser) | Complete | — |

**Total tests: 153 passing** (131 prior + 22 new).

**Consultation:** 4/4 witnesses reviewed. One consensus fix applied (promptUser try/catch → user_cancelled).

## What to Do Next (M1.7)

Execute M1.7 from `docs/steps/01-milestone1-agent-loop.md`. This is the core execution cycle — the heart of the agent.

### Key Requirements

- `TurnEngine` class with `executeTurn(session, input)`, `interrupt(level)`, `getPhase()`
- 12-phase state machine (OpenTurn through LoopOrYield)
- Phase transitions with event emission
- LLM streaming via provider.stream()
- Tool call validation, sequential execution, result appending
- Yield conditions: text-only → `assistant_final`, step limit → `max_steps`, consecutive tool limit → `max_consecutive_tools`, tool error → `tool_error`
- **yieldOutcome from tools**: LoopOrYield must check `ToolOutput.yieldOutcome` — if set, yield the turn with that outcome
- Step limits: 25 (interactive), 30 (one-shot/sub-agent)
- Max 10 tool calls per message (defer excess with synthetic error results)

### Tests Required (12)

See step file M1.7 section for full test specifications.

## Dependencies

- `ToolRegistry` + `ToolRunner` from `src/tools/` (M1.5)
- `ToolOutput.yieldOutcome` from `src/types/conversation.ts` (M1.6b)
- `ToolContext` extensions from `src/tools/tool-registry.ts` (M1.6b)
- `ProviderDriver` + `NanoGptDriver` from `src/providers/` (M1.4)
- `ConversationWriter` + `ConversationReader` from `src/core/` (M1.2)
- `SessionManager` from `src/core/` (M1.3)
- All core types from `src/types/` (M1.1)

## File Locations

| New File | Purpose |
|----------|---------|
| `src/core/turn-engine.ts` | TurnEngine class with phase state machine |
| `test/core/turn-engine.test.ts` | TurnEngine tests (mock provider, mock tools) |

## Design Notes

The TurnEngine needs to:
1. Populate `ToolContext` with `interactive`, `autoConfirm`, `isSubAgent`, and `promptUser` when executing tools
2. Check `ToolOutput.yieldOutcome` in the LoopOrYield phase and yield accordingly
3. Stream text to stdout during CallLLM phase
4. Handle the NanoGptDriver's SSE stream events and reconstruct full responses
