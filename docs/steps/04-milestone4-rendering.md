# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Milestone 4: Terminal + Rendering

Goal: Polished terminal output with colors, syntax highlighting, diffs, and progress.

### M4.0 — Output Channel Contract (Block 18, Block 10)

Define the stderr/stdout split before any rendering code. All rendering steps depend on knowing which channel to target.

- [x] Document and enforce output channel rules:
  - **stdout**: assistant content (text responses, code) in interactive/one-shot; structured JSON in executor
  - **stderr**: all human-facing chrome — prompts, status, progress, tool indicators, errors, diagnostics
  - **Executor mode**: stderr fully suppressed (reserved for catastrophic failures only)
  - **Non-TTY**: no ANSI codes on either channel unless `FORCE_COLOR` overrides color output (see M4.1). `FORCE_COLOR` restores color codes only; cursor control (`\r`, spinners) remains suppressed regardless
- [x] `OutputChannel` abstraction: `stdout(text)`, `stderr(text)`, `isExecutor()`, `isTTY()`
- [x] All subsequent M4 steps use `OutputChannel`, never raw `process.stdout/stderr`

**Tests:**
- Interactive mode: assistant text → stdout, tool status → stderr
- One-shot mode: same split, but no interactive prompts on stderr
- Executor mode: no stderr output at all during normal operation
- Non-TTY: verify zero ANSI escape codes in both channels
- Piped stdout: `aca "task" | cat` → clean text, no ANSI, no progress indicators

### M4.1 — Terminal Capabilities (Block 18)

- [x] `TerminalCapabilities`: per-stream detection — `stdout` and `stderr` each get own `isTTY`, `colorDepth`, `columns`. Shared: `rows`, `unicode`
- [x] Detection: `process.stdout.isTTY` / `process.stderr.isTTY` independently, `chalk.level` per stream, `LANG`/`LC_ALL` for unicode
- [x] `NO_COLOR` env var → colorDepth=0
- [x] `FORCE_COLOR` → colors even without TTY
- [x] Frozen at startup

**Tests:**
- Mock TTY → isTTY=true, colorDepth > 0
- Mock non-TTY → isTTY=false
- `NO_COLOR=1` → colorDepth=0
- `FORCE_COLOR=1` + non-TTY → colors enabled
- Unicode detection: `LANG=en_US.UTF-8` → unicode=true. `LANG=C` → unicode=false
- Piped stdout + TTY stderr → stdout: no ANSI, stderr: full color/spinners

### M4.2 — Renderer Module (Block 18)

- [x] Centralized `Renderer` class: all ANSI output goes through it
- [x] Tool call status: category-based coloring (file=blue, shell=yellow, web=magenta, LSP=cyan, delegation=green, error=red)
- [x] Compact single-line format: `▶ tool_name args` → `✓ tool_name → result (time)` or `✗ tool_name failed (time)`
- [x] Error formatting: `! [error.code] message` with optional detail
- [x] Startup status block on stderr
- [x] Non-TTY fallback: plain text with timestamps, no ANSI codes (`FORCE_COLOR` restores colors but not cursor control)

**Tests:**
- Tool completion → formatted line with correct color. 6 parameterized category color tests:
  - file tools (read_file, write_file, edit_file) → blue (ANSI `\x1b[34m`)
  - shell tools (exec_command) → yellow (ANSI `\x1b[33m`)
  - web tools (web_fetch, web_search) → magenta (ANSI `\x1b[35m`)
  - LSP tools (lsp_query) → cyan (ANSI `\x1b[36m`)
  - delegation tools (spawn_agent, message_agent) → green (ANSI `\x1b[32m`)
  - error display → red (ANSI `\x1b[31m`)
- Error → formatted with `!` prefix and error code
- Non-TTY → no ANSI escape codes in output
- Verbose mode → additional detail lines below tool status
- Unicode=false → ASCII fallbacks for status icons

### M4.3 — Syntax Highlighting (Block 18)

- [x] Shiki with WASM engine, lazy-loaded on first code block
- [x] Language detection: explicit fence > file extension from context > shebang > none
- [x] Theme: `github-dark`
- [x] Non-TTY: no highlighting unless `FORCE_COLOR` (raw text otherwise)
- [x] Bundled grammars: TypeScript, JavaScript, Python, Rust, Go, JSON, Bash, etc.

**Tests:**
- TypeScript code block → highlighted output (snapshot test)
- Language-specific highlighting (parameterized): Python (`def foo():`) → ANSI output contains keyword color, Rust (`fn main()`) → ANSI output contains keyword color, Go (`func main()`) → ANSI output contains keyword color
- Unknown language → plain text, no error
- Unknown file extension (e.g., `.xyz`) → falls back to plain text rendering, no ANSI highlighting codes, no error thrown
- Non-TTY → no ANSI codes in code blocks
- Lazy loading: first code block triggers init (~150ms acceptable), subsequent blocks use cache
- Shebang detection: `#!/usr/bin/env python` → Python highlighting

### M4.4 — Diff Display (Block 18)

- [x] Unified diff after every `edit_file`/`write_file` mutation
- [x] `diff` npm package for computing diffs
- [x] Colors: green (+), red (-), cyan (@@), gray (context)
- [x] 3 lines of context
- [x] Size guard: > 100 lines → show first 50 + last 10 + "N lines omitted"
- [x] New file creation: summary line `+ Created path (N lines)` instead of diff

**Tests:**
- Single line change → correct unified diff with colors (snapshot test)
- Multiple hunks → all displayed
- Diff > 100 lines → truncated with omission indicator
- New file (create mode) → summary line, not diff
- Non-TTY → diff without ANSI codes (`FORCE_COLOR` restores diff coloring)

### M4.5 — Progress Indicators (Block 18)

- [x] Status line: `Thinking...` with elapsed time, `\r` in-place update
- [x] Spinner: braille frames at 80ms interval for tool execution > 1s
- [x] Progress bar for multi-file operations with known count
- [x] Completion: spinner replaced with `✓` or `✗` line
- [x] Non-TTY: static log lines with timestamps

**Tests:**
- Spinner starts after 1s delay, not immediately
- Braille spinner frames: cycle through `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 80ms interval (verify frame sequence and timing with fake timers)
- Spinner replaced with completion line when done
- Non-TTY → no `\r` updates, static lines instead
- Progress bar: 3/10 → visual bar at 30%
- Unicode=false → ASCII spinner fallback (`|/-\`)

### M4.6 — Markdown Rendering (Block 18)

- [x] Selective rendering: bold→chalk.bold, italic→chalk.italic, inline code→chalk.inverse, fenced blocks→shiki, lists→2-space indent, blockquotes→gray `│` prefix
- [x] Pass-through: headers, tables, horizontal rules, links (as `text (url)`)
- [x] HTML tags stripped

**Tests:**
- `**bold**` → chalk.bold applied (snapshot)
- `` `inline` `` → chalk.inverse applied
- Fenced code block → syntax highlighted
- `> blockquote` → gray border prefix
- `# Header` → rendered (passed through with text intact)
- `---` horizontal rule → rendered as visual separator
- `[text](url)` link → rendered as `text (url)` in output
- Table → passed through as-is (columns/alignment preserved)
- `<div>text</div>` → `text` (tags stripped)

---

## Post-Milestone Review
<!-- risk: medium — ANSI escape injection risk in terminal rendering (elevated from low by consultation) -->
<!-- final-substep: M4.6 — gate runs after this substep completes -->
- [x] Architecture review (4 witnesses): spec drift, coupling, interface consistency
- [x] Bug hunt (4 witnesses): cross-module integration, ANSI escape sanitization
- [x] Bug hunt findings converted to regression tests
- [x] Review summary appended to changelog
