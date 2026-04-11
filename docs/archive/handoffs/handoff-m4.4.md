# M4.4 Handoff — Diff Display

**Date:** 2026-04-03
**Status:** M4.3 complete. Ready for M4.4.

## What's Done (M4.3)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| SyntaxHighlighter class (shiki WASM, lazy-loaded) | Complete | 5 |
| detectLanguage (fence > ext > shebang > null) | Complete | 13 |
| 19 bundled grammars, github-dark theme | Complete | 3 |
| Non-TTY graceful degradation | Complete | 2 |
| Lazy init caching + concurrent-call safety | Complete | 3 |
| TypeScript snapshot test | Complete | 1 |
| Shebang detection | Complete | 1 |
| **Total project tests** | | **990** |

## What to Do Next (M4.4)

**M4.4 — Diff Display (Block 18):**
- Unified diff after every `edit_file`/`write_file` mutation
- `diff` npm package for computing diffs
- Colors: green (+), red (-), cyan (@@), gray (context)
- 3 lines of context
- Size guard: > 100 lines → show first 50 + last 10 + "N lines omitted"
- New file creation: summary line `+ Created path (N lines)` instead of diff

**Tests:**
- Single line change → correct unified diff with colors (snapshot test)
- Multiple hunks → all displayed
- Diff > 100 lines → truncated with omission indicator
- New file (create mode) → summary line, not diff
- Non-TTY → diff without ANSI codes (`FORCE_COLOR` restores diff coloring)

## Dependencies

- `diff` npm package — not yet in `package.json`, install before implementing
- `Renderer` from M4.2 — diff display integrates with the rendering pipeline (renders to stderr)
- `TerminalCapabilities` / `StreamCapabilities` from M4.1 — for color/non-TTY adaptation
- `SyntaxHighlighter` from M4.3 — not directly needed for diffs, but same pattern for color adaptation

## File Locations

- Step file: `docs/steps/04-milestone4-rendering.md`
- Spec: Block 18 in `docs/spec/18-terminal-rendering.md`
- Renderer: `src/rendering/renderer.ts`
- SyntaxHighlighter (for pattern reference): `src/rendering/syntax-highlighter.ts`
- New source: `src/rendering/diff-renderer.ts` (suggested)
- New tests: `test/rendering/diff-renderer.test.ts`
