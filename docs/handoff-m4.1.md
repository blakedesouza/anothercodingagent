# M4.1 Handoff — Terminal Capabilities

**Date:** 2026-03-31
**Status:** M3 complete (review gate closed). Ready for M4.1.

## What's Done (M3 + Review)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| M3.0a Project Awareness | Complete | 40 |
| M3.0b System Prompt Assembly | Complete | 28 |
| M3.1 Token Estimation + estimate_tokens | Complete | 47 |
| M3.2 Context Assembly Algorithm | Complete | 72 |
| M3.3 Compression Tier Actions | Complete | 19 |
| M3.4 Summarization | Complete | 21 |
| M3.5 Durable Task State | Complete | 49 |
| M3.6 FileActivityIndex | Complete | 28 |
| M3.7 Session Resume | Complete | 11 |
| M3 Post-Milestone Review | Complete | +3 regression |
| **Total** | | **873** |

## What to Do Next (M4.0 → M4.1)

**M4.0 — Output Channel Contract** must come first (M4.1 depends on it):
- Document and enforce stdout/stderr split
- `OutputChannel` abstraction: `stdout(text)`, `stderr(text)`, `isExecutor()`, `isTTY()`
- All M4 rendering uses `OutputChannel`, never raw `process.stdout/stderr`

**M4.1 — Terminal Capabilities:**
- `TerminalCapabilities`: per-stream detection (isTTY, colorDepth, columns per stream)
- `NO_COLOR` → colorDepth=0
- `FORCE_COLOR` → colors even without TTY
- Unicode detection via `LANG`/`LC_ALL`
- Frozen at startup

## Dependencies
- M3 context assembly provides the budget/packing that rendering will display
- M4.0 OutputChannel is prerequisite for M4.1+

## File Locations
- Step file: `docs/steps/04-milestone4-rendering.md`
- Spec: Block 18 (Terminal Rendering) in `fundamentals.md` / `docs/spec/`
- New source: `src/cli/output-channel.ts`, `src/cli/terminal-capabilities.ts` (suggested)
- Existing CLI: `src/cli/repl.ts`, `src/cli/commands.ts`
