# M1.3 Handoff — Session Manager

**Date:** 2026-03-30
**Status:** M1.2 complete. Ready for M1.3 implementation.

## What's Done (M1.2)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `ConversationWriter`: append typed records as JSON lines | Complete | 10 tests |
| `ConversationReader`: parse JSONL back to typed records | Complete | Covered above |
| `recordType` discriminator (kind→recordType on write, reverse on read) | Complete | Covered above |
| Crash-safe writes via `O_APPEND` + `writeSync` | Complete | Covered above |
| Malformed/partial line handling with warnings | Complete | Covered above |

**Total tests: 61 passing** (51 Phase 0/M1.1 + 10 M1.2)

**Consultation:** 4 witnesses reviewed M1.2 (all responded). 2 fixes applied:
1. Reader defensively strips `kind` from parsed payload to prevent spread-overwrite from corrupted data
2. Reader validates parsed JSON is an object (not array/primitive)

## What to Do Next (M1.3)

Execute M1.3 from `docs/steps/01-milestone1-agent-loop.md`.

### M1.3 — Session Manager (Block 5, Block 10 Phase 5)

- [ ] `SessionManager.create(workspaceRoot)`: generate session ID, create directory at `~/.aca/sessions/<ses_ULID>/`, write initial `manifest.json`
- [ ] `SessionManager.load(sessionId)`: read `manifest.json`, rebuild in-memory projection from `conversation.jsonl`
- [ ] `manifest.json` schema: sessionId, workspaceId, status, turnCount, lastActivityTimestamp, configSnapshot, durableTaskState, calibration
- [ ] `workspaceId` derivation: `wrk_<sha256(normalizedAbsolutePath)>`
- [ ] In-memory projection: ordered item list, current turn state, running sequence counter
- [ ] `manifest.json` overwritten at each turn boundary (not per-step)

### Tests Required

- Create session → directory exists, manifest.json is valid JSON, conversation.jsonl exists (empty)
- Load session → in-memory state matches what was written
- Write items → save manifest → reload → items and manifest match
- workspaceId is deterministic (same path → same id, different path → different id)
- workspaceId normalizes paths (trailing slash, `.` components don't change the id)
- Loading nonexistent session throws typed error

## Dependencies

- M1.1 types: `Session`, `TurnRecord`, `StepRecord`, `ConversationItem` (all in `src/types/`)
- M1.2: `ConversationWriter` and `ConversationReader` (in `src/core/`)
- `SequenceGenerator` for rebuilding sequence counter on load
- `generateId` for session/workspace IDs
- Node.js `crypto` for SHA-256 hashing (workspaceId)

## File Locations

| New File | Purpose |
|----------|---------|
| `src/core/session-manager.ts` | Session lifecycle: create, load, persist |
| `test/core/session-manager.test.ts` | All M1.3 tests |

## Architecture Notes

- Sessions stored at `~/.aca/sessions/<ses_ULID>/` (global, not per-project)
- Each session dir contains `manifest.json` + `conversation.jsonl`
- `manifest.json` is overwritten at turn boundaries, not per-step
- `workspaceId` = `wrk_<sha256(normalizedAbsolutePath)>` — deterministic, path-normalized
- On load: read manifest, then replay conversation.jsonl to rebuild in-memory projection
