# M7.6 Handoff — Checkpointing / Undo (Block 16)

**Date:** 2026-04-04
**Status:** M7.5 complete. Ready for M7.6.

## What's Done (M7.5)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `web_search` tool (Tavily provider, SearchProvider interface) | Complete | 19 |
| `fetch_url` tool (Tier 1 HTTP+jsdom+Readability, Tier 2 Playwright) | Complete | 29 |
| `lookup_docs` tool (search+fetch composite, snippet fallback) | Complete | 14 |
| SSRF redirect protection (P0 fix) | Complete | 2 |
| JSDOM window cleanup (P1 fix) | Complete | — |
| Content-Length NaN guard (P1 fix) | Complete | 1 |
| Tavily key to Authorization header (P1 fix) | Complete | 1 |
| **Total** | **M7.5 complete** | **62 new, 2028 total** |

## What to Do Next (M7.6)

From `docs/steps/07c-milestone7-capabilities.md`:

- Shadow refs in git: `refs/aca/checkpoints/<session-id>/`
- Per-turn, lazy: checkpoint created before first workspace-write in a turn
- Before/after pair: `beforeTurn` and `afterTurn` commits
- `/undo [N]`: revert last N mutating turns
- `/restore <id>`: preview changes first, require confirmation before applying
- `/checkpoints`: list recent checkpoints with metadata
- Divergence detection: compare live workspace against last `afterTurn`
- Manual edit conflict: block undo/restore, require `--force`
- `externalEffects: true` warning on undo of turns with exec_command
- Auto-init git repo if none exists

## Dependencies

- M1.7: TurnEngine for turn lifecycle hooks (`src/core/turn-engine.ts`)
- M2.1: File system tools for workspace write detection (`src/tools/`)
- M2.2: Shell execution for exec_command external effects tracking
- Git CLI: `git` available on PATH for shadow ref operations

## File Locations

- Turn engine (hook integration): `src/core/turn-engine.ts`
- Session manager (manifest): `src/core/session-manager.ts`
- Suggested new: `src/checkpointing/checkpoint-manager.ts`, `src/checkpointing/checkpoint-commands.ts`
- Slash commands: integrate with existing REPL in `src/index.ts`
