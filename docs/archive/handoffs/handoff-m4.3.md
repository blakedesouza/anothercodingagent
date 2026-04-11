# M4.3 Handoff — Syntax Highlighting

**Date:** 2026-04-02
**Status:** M4.2 complete. Ready for M4.3.

## What's Done (M4.2)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| Renderer class (centralized ANSI output) | Complete | 45 |
| 5 tool category colors + error red | Complete | 6 |
| Compact single-line format | Complete | 4 |
| Error formatting with detail | Complete | 3 |
| Startup status block | Complete | 2 |
| Non-TTY fallback with timestamps | Complete | 4 |
| ANSI sanitization of user content | Complete | 4 |
| Unicode/ASCII fallbacks | Complete | 6 |
| **Total project tests** | | **966** |

## What to Do Next (M4.3)

**M4.3 — Syntax Highlighting (Block 18):**
- Shiki with WASM engine, lazy-loaded on first code block
- Language detection: explicit fence > file extension from context > shebang > none
- Theme: `github-dark`
- Non-TTY: no highlighting unless `FORCE_COLOR` (raw text otherwise)
- Bundled grammars: TypeScript, JavaScript, Python, Rust, Go, JSON, Bash, etc.

## Dependencies

- `shiki` npm package (~8MB with WASM + grammars) — not yet in `package.json`
- `Renderer` from M4.2 — syntax highlighting integrates with the rendering pipeline
- `TerminalCapabilities` from M4.1 — check colorDepth and isTTY for fallback behavior

## File Locations

- Step file: `docs/steps/04-milestone4-rendering.md`
- Spec: Block 18 in `docs/spec/18-terminal-rendering.md`
- Renderer: `src/rendering/renderer.ts`
- New source: `src/rendering/syntax-highlighter.ts` (suggested)
- New tests: `test/rendering/syntax-highlighter.test.ts`
