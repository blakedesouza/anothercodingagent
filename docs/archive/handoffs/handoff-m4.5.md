# M4.5 Handoff — Progress Indicators

**Date:** 2026-04-03
**Status:** M4.4 complete. Ready for M4.5.

## What's Done (M4.4)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| DiffRenderer class | Complete | 18 |
| createTwoFilesPatch, 3-line context | Complete | — |
| Green/red/cyan/dim coloring | Complete | 5 |
| 100-line size guard (first 50 + last 10) | Complete | 3 |
| New file creation summary line | Complete | 4 |
| ANSI injection protection on filePath | Complete | 1 |
| Non-TTY / FORCE_COLOR support | Complete | 3 |
| **Total project tests** | | **1008** |

## What to Do Next (M4.5)

**M4.5 — Progress Indicators (Block 18):**

- Status line: `Thinking...` with elapsed time, `\r` in-place update
- Spinner: braille frames at 80ms interval for tool execution > 1s
- Progress bar for multi-file operations with known count
- Completion: spinner replaced with `✓` or `✗` line
- Non-TTY: static log lines with timestamps

**Tests:**
- Spinner starts after 1s delay, not immediately
- Braille spinner frames: cycle through `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 80ms interval (verify frame sequence and timing with fake timers)
- Spinner replaced with completion line when done
- Non-TTY → no `\r` updates, static lines instead
- Progress bar: 3/10 → visual bar at 30%
- Unicode=false → ASCII spinner fallback (`|/-\`)

## Dependencies

- `OutputChannel` from M4.0 — write to stderr via `output.stderr()`
- `TerminalCapabilities` from M4.1 — check `isTTY`, `unicode`, `columns`
- `Renderer` from M4.2 — progress indicators will likely be a new method or class that the Renderer delegates to
- Fake timers (vitest `vi.useFakeTimers()`) for spinner timing tests

## File Locations

- Step file: `docs/steps/04-milestone4-rendering.md`
- Spec: Block 18 in `docs/spec/18-terminal-rendering.md`
- Existing rendering: `src/rendering/renderer.ts`, `src/rendering/output-channel.ts`
- New source: `src/rendering/progress.ts` (suggested)
- New tests: `test/rendering/progress.test.ts`

## Key Design Notes

- Spinner frames: `['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']` (10 braille frames)
- ASCII fallback when `unicode=false`: `['|','/','-','\\']`
- All progress uses `\r` (carriage return) for in-place updates — no alternate screen buffer
- Spinner starts only after 1 second delay (not immediately on tool start)
- On completion: replace spinner line with `✓ tool_name (time)` or `✗ tool_name failed (time)` — same format as Renderer.toolComplete()
- Non-TTY: no `\r`, static timestamp lines instead
- Progress bar example: `[███░░░░░░░] 3/10 files indexed`
