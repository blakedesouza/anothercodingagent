# M5.6 Handoff — Log Retention

**Date:** 2026-04-03
**Status:** M5.5 complete. Ready for M5.6.

## What's Done (M5.5)

| Deliverable | Status | Tests |
|---|---|---|
| `aca stats` commander subcommand | Complete | 0 (CLI) |
| Default 7-day summary (sessions, cost, tokens, top tools, error rate) | Complete | 2 |
| `--session <id>` per-turn breakdown | Complete | 2 |
| `--today` with remaining daily budget | Complete | 2 |
| `--json` structured output | Complete | 3 |
| SqliteStore aggregate queries (6 methods) | Complete | 0 (covered by stats tests) |
| Incomplete turn flush | Complete | 0 (edge case) |
| **Total project tests** | | **1228** |

## What to Do Next (M5.6)

**M5.6 — Log Retention (Block 19):**

- [ ] 30-day default retention, 5 GB size cap
- [ ] Sessions > 7 days: compress JSONL (gzip), remove blobs
- [ ] Sessions > 30 days: prune from disk
- [ ] SQLite records retained (with `pruned` flag) for long-term trends
- [ ] Runs at session start, max 10 sessions per startup

## Dependencies

- **SessionManager** (`src/core/session-manager.ts`): session directory structure in `~/.aca/sessions/`
- **SqliteStore** (`src/observability/sqlite-store.ts`): needs `pruned` flag column on sessions table
- **Config** (`src/config/schema.ts`): retention config (retention.days, retention.maxSizeGb) — user-only

## File Locations

- Step file: `docs/steps/05-milestone5-provider-obs.md`
- Spec: Block 19 in `docs/spec/19-observability-advanced.md`
- New source: `src/observability/log-retention.ts` (suggested)
- Modify: `src/observability/sqlite-store.ts` (add `pruned` flag, schema migration)
- Modify: `src/config/schema.ts` (add retention config)
- Read: `src/core/session-manager.ts` (session directory layout)
