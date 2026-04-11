# M1.6b Handoff — User Interaction Tools

**Date:** 2026-03-30
**Status:** M1.6 complete. Ready for M1.6b implementation.

## What's Done (M1.6)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `readFileSpec` (input schema, approval class, idempotent, timeout) | Complete | 1 test |
| `readFileImpl` (read, line ranges, truncation, binary detection) | Complete | 5 tests |
| Line range support (`line_start`/`line_end`, `nextStartLine`) | Complete | 3 tests |
| Whichever-first truncation (2,000 lines or 64 KiB envelope) | Complete | 2 tests |
| Binary detection (null-byte + extension heuristic) | Complete | 3 tests |
| Error handling (not_found, is_directory, permission_denied, invalid_input, file_too_large) | Complete | 3 tests |
| UTF-8 encoding + integration pipeline | Complete | 2 tests |

**Total tests: 131 passing** (112 prior + 19 new).

**Consultation:** 4 witnesses reviewed M1.6 (all responded, immediate consensus). 5 fixes applied:
1. Removed `.svg` from BINARY_EXTENSIONS (SVGs are text/XML)
2. Added 10 MiB file size cap before readFile() (OOM prevention)
3. Added `line_end < line_start` → `tool.invalid_input` error
4. Added `isFile()` check after stat + `tool.is_directory` error
5. Distinguished EACCES/EPERM in both stat and readFile catch blocks

## What to Do Next (M1.6b)

Execute M1.6b from `docs/steps/01-milestone1-agent-loop.md`.

### M1.6b — User Interaction Tools (Block 2)

- [ ] `ask_user`: question (string), optional choices/format → user response. Approval class: `user-facing`
- [ ] `confirm_action`: action description, affected paths, risk summary → approved (boolean). Approval class: `user-facing`
- [ ] Both require TTY in interactive mode. In one-shot without TTY: `ask_user` fails with `user_cancelled`, `confirm_action` fails unless `--no-confirm`
- [ ] In sub-agent context: excluded from tool profile. Profile check denies them
- [ ] `ask_user` yields turn with `awaiting_user` outcome
- [ ] `confirm_action` yields with `approval_required` outcome

### Tests Required

- `ask_user` in interactive mode → prompt displayed on stderr, user response returned
- `ask_user` in one-shot without TTY → `user_cancelled` error
- `confirm_action` with TTY → approval prompt, returns boolean
- `confirm_action` with `--no-confirm` → auto-approved (returns true)
- Sub-agent calls `ask_user` → denied with "not permitted by agent profile"
- Turn yields correctly: `ask_user` → `awaiting_user`, `confirm_action` → `approval_required`

## Dependencies

- `ToolRegistry` + `ToolRunner` from `src/tools/` (M1.5)
- `ToolOutput` type from `src/types/conversation.ts`
- `ToolSpec` / `ToolImplementation` types from `src/tools/tool-registry.ts`
- `read_file` tool as pattern reference from `src/tools/read-file.ts` (M1.6)

## File Locations

| New File | Purpose |
|----------|---------|
| `src/tools/ask-user.ts` | `ask_user` tool implementation + spec |
| `src/tools/confirm-action.ts` | `confirm_action` tool implementation + spec |
| `test/tools/ask-user.test.ts` | `ask_user` tests |
| `test/tools/confirm-action.test.ts` | `confirm_action` tests |

## Design Notes

These tools are unique because they interact with the user (TTY) and control turn outcomes. They need a mechanism to signal the turn engine that the turn should yield — likely via a special field in the `ToolOutput` or a thrown signal. The turn engine (M1.7) will consume this signal. For M1.6b, focus on the tool implementation and mocking the yield mechanism.
