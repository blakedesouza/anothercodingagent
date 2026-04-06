# M7.12 Handoff — One-Shot Mode (Block 10)

**Date:** 2026-04-04
**Status:** M7.11 complete. Ready for M7.12.

## What's Done (M7.11)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| CapabilityDescriptor type + buildDescriptor | Complete | 7 |
| InvokeRequest/Response envelopes + parsing | Complete | 15 |
| Version compatibility (SemVer major-only) | Complete | 5 |
| `aca describe --json` fast path | Complete | 2 |
| `aca invoke --json` with TurnEngine | Complete | — (integration) |
| Ephemeral sessions (manifest.ephemeral) | Complete | 2 |
| Promise.race deadline enforcement | Complete | — |
| 10MB stdin size cap | Complete | — |
| 3 consultation fixes (deadline, stdin cap, array rejection) | Complete | 2 |
| **Total** | **M7.11 complete** | **35 new, 2103 total** |

## What to Do Next (M7.12)

From `docs/steps/07c-milestone7-capabilities.md`:

- `aca "task text"` → single turn, up to 30 steps
- Piped input: `echo "task" | aca` → one-shot
- Text output to stdout, errors to stderr
- Confirmation handling with TTY → inline prompt. Without TTY + no `--no-confirm` → fail
- Resume + one-shot: `aca --resume "new task"` → resume session + one turn
- Exit codes mapped to error categories

## Dependencies

- Block 10: CLI Interface (commander framework, already wired)
- M1.7: TurnEngine (executeTurn interface)
- M1.8: REPL (existing readline setup — one-shot bypasses the REPL loop)

## File Locations

- CLI entry point: `src/index.ts` (modify the default action for one-shot detection)
- Existing one-shot stubs: `src/index.ts:98-109` (currently prints "not yet supported")
- Turn engine: `src/core/turn-engine.ts` (executeTurn with `interactive: false`)
- Approval flow: `src/permissions/approval.ts` (for TTY confirmation handling)
