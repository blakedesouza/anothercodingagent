# M3.7 Handoff — Session Resume

**Date:** 2026-03-31
**Status:** M3.6 complete. Ready for M3.7.

## What's Done (M3.6)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `FileActivityIndex` class (scoring, decay, eviction) | Complete | 15 |
| `rebuildFromLog` (conservative open-loop protection) | Complete | 2 |
| `renderWorkingSet` (top 5 files with roles) | Complete | 4 |
| `getActiveOpenLoopFiles` helper | Complete | 2 |
| `SessionManifest.fileActivityIndex` field | Complete | (existing) |
| Serialization round-trip | Complete | 2 |
| User mention deduplication | Complete | 1 |
| Score floor at 0 | Complete | (verified in open-loop tests) |
| Failed tool calls excluded | Complete | 1 |
| Role tracking | Complete | 1 |

**Total tests: 859 passing** (829 prior + 28 new + 2 manifest).

**Consultation:** 4/4 witnesses, 1 round. 3 fixes applied: rebuildFromLog open-loop protection, mention deduplication, score floor.

## What to Do Next (M3.7)

Implement session resume — `--resume` flag to restore a previous session's full in-memory state from disk.

### What to Build

- `--resume` CLI flag: find latest session for workspace, or specific `ses_<ULID>`
- Rebuild in-memory projection from conversation.jsonl
- Rebuild coverage map, FileActivityIndex, sequence counter
- Reload durable task state from manifest.json
- Config re-resolved from current sources (CLI flags win)
- Config drift detection: warn if security-relevant settings changed

### Key Test Cases

- Create session → exit → resume → in-memory state matches original
- Resume with different `--model` flag → resolved config uses new model, warning emitted
- Resume nonexistent session → exit code 4
- Resume latest for workspace: create 3 sessions → resume picks most recent
- Projection rebuild: 10 turns with summaries → visibleHistory matches pre-exit state

**Note:** This is the final substep of Milestone 3. Post-milestone review (medium risk: arch + bug hunt) will fire after M3.7 approval.

## Dependencies

- M3.6 `FileActivityIndex` + `rebuildFromLog` (rebuild on resume)
- M3.4 Summarization (`visibleHistory`, coverage map rebuild)
- M3.5 `DurableTaskState` (reload from manifest)
- M2.5 Configuration System (re-resolve, drift detection)
- M1.3 `SessionManager` (load method, manifest reading)
- M1.8 Basic REPL (`commander` entry point, CLI flag parsing)

## File Locations

| File | Purpose |
|------|---------|
| `src/core/session-manager.ts` | Extend `load()` or add `resume()` method |
| `src/cli/commander.ts` | Add `--resume` flag parsing |
| `src/core/file-activity-index.ts` | `rebuildFromLog` already implemented |
| `src/core/summarizer.ts` | Coverage map rebuild already implemented |
| `test/core/session-manager.test.ts` | Resume test cases |
