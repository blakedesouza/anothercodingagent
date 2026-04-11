# M3.6 Handoff — FileActivityIndex

**Date:** 2026-03-30
**Status:** M3.5 complete. Ready for M3.6.

## What's Done (M3.5)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `DurableTaskState` type + `createInitialDurableTaskState` | Complete | 1 |
| `extractTurnFacts` (modified files, errors, denials, mentions) | Complete | 8 |
| `applyDeterministicUpdates` (files, errors, denials → state) | Complete | 9 |
| `applyLlmPatch` (JSON patch, blocker auto-removal on done) | Complete | 8 |
| `updateDurableTaskState` (two-phase, stale management) | Complete | 5 |
| `renderDurableTaskState` (Task State: header, 80-150 tokens) | Complete | 7 |
| `MAX_FILES_OF_INTEREST = 50` cap | Complete | 1 |
| `session-manager.ts` typed `DurableTaskState \| null` | Complete | (existing) |
| `summarizer.ts` durable state in prompt context | Complete | (existing) |

**Total tests: 829 passing** (785 prior + 44 new).

**Consultation:** 4/4 witnesses, 1 round. 7 fixes applied: approval denial detection, blocker cleanup, stale flag semantics, filesOfInterest cap, LLM prompt context, absolute path regex, render header.

## What to Do Next (M3.6)

Implement `FileActivityIndex` — an in-memory map from file path to activity score, persisted in `manifest.json`. Updated deterministically from tool call history. Used to build the per-turn "active files" working set context.

### What to Build

- In-memory map: `file path → { score: number, turnsSinceLastTouch: number }`
- Scoring weights (on successful tool call):
  - `edit_file` / `write_file` = +30
  - `delete_path` / `move_path` = +35
  - `read_file` = +10
  - `search_text` match in file = +5
  - user message mention = +25
- Decay: subtract 5 per inactive turn (`turnsSinceLastTouch` increments each turn the file is not referenced)
- `turnsSinceLastTouch` resets to 0 on any reference (tool call or user mention)
- Drop from working set after 8 consecutive inactive turns (not from creation) — UNLESS the file is referenced by an active open loop in `DurableTaskState`
- Persist as `fileActivityIndex` in `manifest.json`, rebuild from conversation log on resume
- Per-turn context: top 5 files by score, rendered as `path (role)`

### Key Test Cases

- `edit_file` on `a.ts` → score = 30
- `read_file` on `a.ts` then `edit_file` → score = 40
- 8 consecutive inactive turns → score drops by 40 (5×8), file removed from working set
- Decay reset: edit at turn 1, idle turns 2-5 (score drops by 20), read at turn 6 → `turnsSinceLastTouch` resets to 0, score +10, decay restarts from turn 6
- Open-loop exemption: file in active durable open loop → not removed after 8 idle turns
- Top 5: 7 files touched → only top 5 appear in context
- Rebuild from log: replay tool calls → same scores as live tracking

## Dependencies

- M3.5 `DurableTaskState` (open-loop exemption check)
- M1.3 `SessionManager` / `manifest.json` (persistence — add `fileActivityIndex` field to `SessionManifest`)
- Existing tool names from M2.1/M2.2 (write_file, edit_file, read_file, delete_path, move_path, search_text)

## File Locations

| File | Purpose |
|------|---------|
| `src/core/file-activity-index.ts` | New — FileActivityIndex class/type, scoring, decay, eviction |
| `test/core/file-activity-index.test.ts` | New — all test cases above |
| `src/core/session-manager.ts` | Add `fileActivityIndex` field to `SessionManifest` |
