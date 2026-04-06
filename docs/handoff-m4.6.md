# M4.6 Handoff — Markdown Rendering

**Date:** 2026-04-03
**Status:** M4.5 complete. Ready for M4.6.

## What's Done (M4.5)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| StatusLine class (Thinking... elapsed, \r update, 250ms interval) | Complete | 4 |
| Spinner class (1s delay, braille/ASCII frames, 80ms interval) | Complete | 13 |
| ProgressBar class ([bar] N/total label, TTY in-place, non-TTY complete-only) | Complete | 8 |
| sanitizeLabel() helper (strips ANSI + \r\n) | Complete | — |
| Double-start cancel guard (Spinner + StatusLine) | Complete | — |
| Non-TTY static timestamp lines for all three | Complete | — |
| **Total project tests** | | **1033** |

## What to Do Next (M4.6)

**M4.6 — Markdown Rendering (Block 18):**
- Selective rendering: bold→chalk.bold, italic→chalk.italic, inline code→chalk.inverse, fenced blocks→shiki, lists→2-space indent, blockquotes→gray `│` prefix
- Pass-through: headers, tables, horizontal rules, links (as `text (url)`)
- HTML tags stripped

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

**Note:** M4.6 is the final substep of Milestone 4. After approval, the post-milestone review (medium risk: arch + bug hunt, 4 witnesses each) must run before Milestone 5 work begins.

## Dependencies

- `SyntaxHighlighter` from M4.3 (`src/rendering/syntax-highlighter.ts`) — fenced code block rendering delegates to it
- `OutputChannel` from M4.0 — markdown renderer writes to stdout (assistant content) or stderr
- `TerminalCapabilities` from M4.1 — TTY detection for whether to render at all
- `Renderer` from M4.2 — markdown rendering likely integrates here or as a peer module

## File Locations

- Step file: `docs/steps/04-milestone4-rendering.md`
- Spec: Block 18 in `docs/spec/18-terminal-rendering.md`
- SyntaxHighlighter (pattern reference): `src/rendering/syntax-highlighter.ts`
- Renderer (for integration pattern): `src/rendering/renderer.ts`
- New source: `src/rendering/markdown-renderer.ts` (suggested)
- New tests: `test/rendering/markdown-renderer.test.ts`

## Key Design Notes (from spec)

- **Rendered elements:** bold (`**`), italic (`*`), inline code (`` ` ``), fenced code (`` ``` ``), lists, blockquotes (`>`)
- **Pass-through as-is:** headers (`#`), tables, horizontal rules (`---`), links → `text (url)`
- **Stripped:** HTML tags
- Non-TTY: no rendering unless FORCE_COLOR (raw text otherwise)
- The markdown renderer post-processes completed text blocks — it is not a streaming renderer
