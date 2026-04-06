<!-- Source: fundamentals.md lines 1951-2093 -->
### Block 18: Terminal Rendering

Functional, high-quality terminal output that makes the agent's activity visible and its responses readable. This block defines the rendering stack, syntax highlighting, diff display, progress indicators, markdown rendering, and terminal adaptation. It extends Block 10's stderr output contract and Block 6's streaming output with a concrete rendering implementation.

**Core principle: progressive enhancement for human clarity.** Output adapts to terminal capabilities (TTY vs. pipe, color depth, width) without breaking machine parsing. Every rendering decision prioritizes information density and scanability over visual flourish. Non-TTY output degrades gracefully to plain text.

**Foundational decisions:**

- **Rendering stack: chalk + custom layout functions, no full-screen TUI frameworks.** The rendering system uses `chalk` (v5, pure JS, tree-shakable) for color and style codes, `string-width` for Unicode-aware width calculation, and `wrap-ansi` for ANSI-safe text wrapping. No ink, blessed, or other full-screen libraries.

  **Rationale:** Block 10 already rejected ink ("fights the streaming model — wants to own the terminal"). Blessed requires native deps and breaks in some terminals. Chalk is zero-overhead for basic styling. Custom layout functions for structured output (tool status, diffs, progress) stay imperative and fast. The agent is conversational, not a full-screen editor — the rendering system needs to interleave with streaming text output to stdout, not control the terminal.

  **Rendering boundaries:** Most rendering goes to `stderr` via a `Renderer` module (tool status, progress, errors, diffs). Assistant text goes to `stdout` but receives inline rendering when the output is a TTY: fenced code blocks are syntax-highlighted and markdown elements are rendered as they complete during streaming. When `stdout` is not a TTY (piped or redirected), assistant text is written raw with no ANSI codes — machine-parseable output is preserved. The `Renderer` module owns all ANSI escape code output — no other module writes escape codes directly. This centralizes terminal capability checks and ensures clean output when piping.

- **Syntax highlighting uses shiki with WASM engine, lazy-loaded on first code block.** Shiki produces accurate highlighting via TextMate grammars (same engine as VS Code). The WASM-based Oniguruma engine runs in pure JS without native deps.

  **Initialization:** The highlighter is created lazily on the first fenced code block in assistant output. Creation loads the WASM engine and the requested language grammar. Subsequent highlights reuse the cached instance. Initial load cost: ~150-200ms (acceptable since it happens once, during output display).

  **Language detection priority:**
  1. Explicit fence language: `` ```typescript `` — authoritative
  2. File extension from tool context: if the code block follows a `read_file` or `edit_file` result, use the file's extension
  3. Shebang line: `#!/usr/bin/env python` → Python
  4. No guessing — if language is unknown, render without highlighting (plain monospace)

  **Bundled grammars (loaded on demand):** TypeScript, JavaScript, Python, Rust, Go, Java, C/C++, JSON, YAML, Markdown, Bash/Shell, HTML, CSS, SQL, Dockerfile, TOML. Additional grammars can be loaded from shiki's registry if installed; missing grammars fall back to no highlighting without error.

  **Theme:** `github-dark` (high contrast, terminal-friendly). Single theme in v1. Theme selection deferred.

  **Rationale for shiki over alternatives:** `highlight.js` uses regex-based parsing (less accurate for complex grammars). Prism is browser-focused. Shiki's TextMate grammars match VS Code quality, and the WASM engine avoids native deps. The lazy loading pattern means zero cost for sessions that don't involve code display.

- **Diff rendering shows unified diffs with syntax-aware coloring after every file edit.** When `edit_file` or `write_file` modifies a file, the rendering system displays a compact unified diff on stderr.

  **Format:** Unified diff, 3 lines of context. Colors: green (`+`) for additions, red (`-`) for deletions, cyan for hunk headers (`@@`), gray for context lines. Line numbers shown in the left gutter.

  **Implementation:** Uses the `diff` npm package (`createTwoFilesPatch`) to compute the diff, then applies chalk coloring per line prefix. The old content is captured by the tool runtime before mutation; the new content is read after. The diff is rendered automatically — no opt-in flag needed.

  **Size guard:** If the diff exceeds 100 lines, show only the first 50 and last 10 with a "... N lines omitted ..." indicator. Full diffs available via `--verbose`. For complete file rewrites (`write_file` with `mode: create`), show a summary instead: `+ Created src/new-file.ts (142 lines)`.

  **Rationale:** Unified diff is universally understood. Automatic display keeps the user informed of every change without requiring them to inspect files. The size guard prevents flooding the terminal on large refactors.

- **Progress indicators use a three-tier system matched to operation duration.**

  | Tier | When | Visual | Implementation |
  |---|---|---|---|
  | **Status line** | LLM streaming (any duration) | `Thinking...` with elapsed time, updated in-place | `\r` carriage return, single stderr line |
  | **Spinner** | Tool execution > 1s | `⠋ Running npm install (2.3s)` | Braille spinner frames, 80ms interval, `\r` updates |
  | **Progress bar** | Multi-file operations with known count | `[███░░░░░░░] 3/10 files indexed` | Fixed-width bar, updated per item |

  Spinner frames: `['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']`. All progress indicators use carriage return (`\r`) for in-place updates — no alternate screen buffer, no cursor manipulation beyond the current line. When the operation completes, the spinner is replaced with a completion line: `✓ npm install (14.2s)` or `✗ npm install failed (exit 1, 3.1s)`.

  **Non-TTY:** No spinners, no `\r` updates. Static log lines with timestamps: `[12:34:56] Running npm install...` then `[12:35:10] npm install completed (14.2s)`.

- **Markdown rendering is selective: render the elements that aid readability, pass through the rest.** Assistant output is streamed as raw text to stdout (Block 6 streaming contract). The rendering system post-processes completed text blocks for stderr display (verbose mode) and applies selective markdown rendering.

  **Rendered elements:**
  - **Bold** (`**text**`): `chalk.bold`
  - **Italic** (`*text*`): `chalk.italic`
  - **Inline code** (`` `code` ``): `chalk.inverse` with padding
  - **Fenced code blocks** (`` ``` ``): syntax highlighting via shiki (see above)
  - **Lists** (bulleted and numbered): preserved with 2-space indent
  - **Blockquotes** (`>`): gray left border (`│`) prefix

  **Not rendered (passed through as-is):**
  - **Headers** (`#`): shown as-is (bold would be redundant with the `#` marker)
  - **Tables**: shown as raw markdown (too wide for reliable terminal rendering)
  - **Horizontal rules**: shown as-is
  - **Links**: shown as `text (url)` format
  - **HTML tags**: stripped

  **Rationale:** Full markdown-to-terminal rendering (e.g., `marked-terminal`) is heavy and opinionated. Selective rendering covers the common cases in LLM coding output. Tables are the main casualty — LLMs sometimes output tables, but terminal table rendering requires width negotiation that adds complexity without sufficient v1 value.

- **Terminal capability detection adapts output to the environment.**

  ```typescript
  interface TerminalCapabilities {
    isTTY: boolean;
    colorDepth: 0 | 4 | 8 | 24;   // no color, 16 colors, 256 colors, true color
    columns: number;
    rows: number;
    unicode: boolean;
  }
  ```

  Detection runs once at startup. `colorDepth` is detected via `chalk.level` (which checks `COLORTERM`, `TERM`, and related env vars). `unicode` is inferred from `LANG`/`LC_ALL` containing `UTF-8`. Capabilities are frozen for the session.

  **Adaptation rules:**
  - `isTTY = false`: no colors (unless `FORCE_COLOR` env var), no spinners, no `\r` updates, append-only output, width defaults to 80
  - `colorDepth = 0`: plain text, no ANSI codes. Respects `NO_COLOR` env var convention
  - `colorDepth = 4`: 16-color palette only (basic ANSI colors)
  - `unicode = false`: ASCII fallbacks for spinner (`|/-\`), borders (`|`, `-`), and status icons (`[OK]`, `[FAIL]`)
  - Width < 60: suppress diff gutter line numbers, reduce progress bar width

  **Env var overrides:** `NO_COLOR` (any value) forces `colorDepth: 0`. `FORCE_COLOR` (any value) forces colors even when not TTY. `ACA_COLUMNS` overrides detected width. These follow widely-adopted CLI conventions.

- **Tool call rendering uses compact single-line status with category-based coloring.**

  ```
  ▶ read_file src/config.ts
  ✓ read_file src/config.ts → 234 lines (0.1s)

  ▶ exec_command npm test
  ⠋ exec_command npm test (4.2s)
  ✓ exec_command npm test → exit 0 (14.2s)

  ▶ edit_file src/agent.ts
  ✓ edit_file src/agent.ts → 3 edits applied
    --- a/src/agent.ts
    +++ b/src/agent.ts
    @@ -42,3 +42,5 @@
    +  const result = await provider.stream(request);
    +  return result;
  ```

  **Color by tool category:** File operations (read, write, edit): blue. Shell execution: yellow. Web/network: magenta. LSP: cyan. Delegation: green. Errors: red. This gives users an at-a-glance sense of what kind of work the agent is doing.

  **Verbose mode** (`--verbose`): shows additional detail below each tool call — working directory, timeout, input summary, output summary (first/last lines).

**Integration with other blocks:**

- **Block 6 (Agent Loop):** Text tokens stream to stdout unmodified (no rendering applied to stdout). Tool status events are emitted to the `Renderer` which displays on stderr. The `Renderer` is injected into the turn engine as an event listener
- **Block 10 (CLI Interface):** The `Renderer` replaces direct `process.stderr.write` calls. Block 10's approval prompts use the `Renderer` for consistent styling. Startup status display uses the `Renderer`
- **Block 11 (Error Handling):** Error display uses `Renderer.error()` for consistent formatting: `! [error.code] message` with optional detail expansion
- **Observability:** Render events (what was displayed, content hash) are logged for debugging display issues. ANSI codes are never written to event logs — only plain text content

**Dependencies:**

| Package | Size | Purpose |
|---|---|---|
| `chalk` v5 | ~40KB | ANSI colors and styles |
| `shiki` | ~8MB (with WASM + grammars) | Syntax highlighting |
| `diff` | ~50KB | Unified diff computation |
| `string-width` | ~20KB | Unicode-aware string width |
| `wrap-ansi` | ~10KB | ANSI-safe text wrapping |

**Deferred:**
- Side-by-side diff view
- Custom themes (dark/light/solarized)
- Terminal image display (sixel/kitty graphics protocol)
- Interactive table rendering with scroll
- Screen recording integration
- Clickable file paths (OSC 8 hyperlinks)
- Configurable color scheme
