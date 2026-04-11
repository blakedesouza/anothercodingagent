# M5.5 Handoff — `aca stats` Command

**Date:** 2026-04-03
**Status:** M5.4 complete. Ready for M5.5.

## What's Done (M5.4)

| Deliverable | Status | Tests |
|---|---|---|
| calculateCost pure function | Complete | 3 |
| CostTracker (session/daily accumulators, independent warning flags) | Complete | 12 |
| Budget enforcement in TurnEngine Phase 8 | Complete | 0 (integration) |
| /budget extend slash command | Complete | 0 (covered by REPL tests) |
| getDailyCostExcludingSession SQLite query | Complete | 0 (integration) |
| cost_usd on LlmResponsePayload | Complete | 0 (type only) |
| budget config in ResolvedConfig | Complete | 0 (schema) |
| **Total project tests** | | **1219** |

## What to Do Next (M5.5)

**M5.5 — `aca stats` Command (Block 19):**

- [ ] New commander subcommand: `aca stats`
- [ ] Default: last 7 days summary (sessions, cost, tokens, most-used tools, error rate)
- [ ] `--session <id>`: per-turn breakdown
- [ ] `--today`: today's usage + remaining daily budget
- [ ] `--json`: structured JSON output

## Dependencies

- **SqliteStore** (`src/observability/sqlite-store.ts`): queries for sessions, events, tool_calls, errors
- **CostTracker** (`src/observability/cost-tracker.ts`): `calculateCost` for computing cost from stored events
- **Config** (`src/config/schema.ts`): budget config for `--today` remaining budget display
- **Commands** (`src/cli/commands.ts`): existing slash command infrastructure

## File Locations

- Step file: `docs/steps/05-milestone5-provider-obs.md`
- Spec: Block 19 in `docs/spec/19-observability-advanced.md`
- New source: `src/cli/stats.ts` (suggested — stats command implementation)
- Modify: `src/cli/commands.ts` or `src/index.ts` (add `aca stats` subcommand)
- Read: `src/observability/sqlite-store.ts` (query methods needed)
