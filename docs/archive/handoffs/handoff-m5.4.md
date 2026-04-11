# M5.4 Handoff — Cost Tracking + Budget

**Date:** 2026-04-03
**Status:** M5.3 complete. Ready for M5.4.

## What's Done (M5.3)

| Deliverable | Status | Tests |
|---|---|---|
| SqliteStore (4 tables, WAL, cached stmts, timestamp index) | Complete | 10 |
| BackgroundWriter (1s debounce, EventSink interface) | Complete | 4 |
| backfillSession (JSONL→SQLite diff + batch insert) | Complete | 6 |
| **Total project tests** | | **1204** |

## What to Do Next (M5.4)

**M5.4 — Cost Tracking + Budget (Block 19):**

- [ ] Cost calculation: `(input_tokens * costPerMillion.input + output_tokens * costPerMillion.output) / 1_000_000`
- [ ] Per-event `cost_usd` field on `llm.response` events
- [ ] In-memory `sessionCostAccumulator`: updated synchronously after each LLM response
- [ ] Budget config: `budget.session`, `budget.daily`, `budget.warning` (fraction)
- [ ] Warning at threshold → stderr message
- [ ] Hard stop at 100% → `budget_exceeded` turn outcome
- [ ] Daily budget: query SQLite at session start for today's costs, then per-response check
- [ ] `/budget extend <amount>` slash command for interactive override

## Dependencies

- **Model registry** (`src/providers/model-registry.ts`, `src/providers/models.json`): `costPerMillion.input` and `costPerMillion.output` fields already exist in `ModelCapabilities`
- **Event types** (`src/types/events.ts`): `LlmResponsePayload` has `tokens_in`/`tokens_out` — needs `cost_usd` field added
- **SqliteStore** (`src/observability/sqlite-store.ts`): for daily budget baseline query (today's completed session costs)
- **TurnEngine** (`src/core/turn-engine.ts`): budget enforcement hooks into yield conditions
- **Config** (`src/config/schema.ts`): needs `budget` section added
- **Session types** (`src/types/session.ts`): `budget_exceeded` already listed as a TurnOutcome

## File Locations

- Step file: `docs/steps/05-milestone5-provider-obs.md`
- Spec: Block 19 in `docs/spec/19-observability-advanced.md`
- New source: `src/observability/cost-tracker.ts` (suggested — cost calculator + accumulator)
- Modify: `src/types/events.ts` (add cost_usd to LlmResponsePayload)
- Modify: `src/config/schema.ts` (add budget config section)
- Modify: `src/core/turn-engine.ts` (budget enforcement in yield check)
- Modify: `src/cli/repl.ts` (add `/budget extend` slash command)
