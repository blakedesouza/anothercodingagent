<!-- Source: fundamentals.md lines 1677-1695 -->
### Project Awareness

The agent automatically detects the project it's operating in — where the root is, what language/toolchain is used, what files to ignore, and what git state exists. This runs at session start and produces a small structured snapshot used internally by tools and injected as compact context for the LLM. The total injected context must stay under ~200 tokens. Everything beyond the snapshot is available on-demand via `exec_command` and file reads.

**Foundational decisions:**
- **Project root detection** — Walk up from `cwd`, stop at the first `.git/` directory (strongest marker). If no `.git/` found, fall back to the nearest language-specific root file (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `pom.xml`, `build.gradle`). Stop at filesystem root. Single root for now — the agent operates relative to this root for all path resolution and tool defaults
- **Ignore rules are tool defaults, not LLM instructions** — `find_paths` and `search_text` respect `.gitignore` patterns by default, plus hardcoded ignores (`.git/`, `node_modules/`, `dist/`, `build/`, `coverage/`). Both tools expose an `include_ignored: boolean` parameter (default `false`) for explicit override. `.git/` is never searchable regardless of override. This is enforced in tool implementation, not prompt text
- **Language/toolchain detection is shallow** — Detect primary ecosystem from root marker files and lockfiles (e.g., `pnpm-lock.yaml` means pnpm, `Cargo.lock` means Rust/cargo). Note existence of config files (`tsconfig.json`, `vitest.config.*`, `.eslintrc*`) without parsing their contents. This detection influences LLM context only — tools remain language-agnostic. Injected as one line: `Stack: Node + TypeScript, pnpm, vitest, eslint`
- **Git state: minimal snapshot at session start** — Detect: inside git repo (yes/no), current branch, dirty/clean status, whether staged changes exist. Inject as one line: `Git: branch=feature/x, dirty, staged=false`. Not re-injected every turn — refresh when git-sensitive task is detected or when tool results indicate state changed. Recent commits, diffs, full status, and ahead/behind are on-demand via `exec_command`, never auto-injected
- **Index status tracking** — The `ProjectSnapshot` includes an `indexStatus` field with values: `none` (no index exists), `building` (initial indexing in progress), `ready` (index available for search), `updating` (incremental update in progress), `stale` (files changed since last index). This field is consumed by `search_semantic` to return appropriate errors and by the LLM context to indicate whether semantic search is available
- **Context injection policy** — Project snapshot is injected at session start as part of system context assembly. Updated only when state changes or task warrants it. The snapshot is structured data internally (`ProjectSnapshot`) and rendered as a compact text block (~5-8 lines) for the LLM

**Deferred:**
- Monorepo awareness (workspace root vs focus root, package graph detection)
- Deep config parsing (tsconfig options, ESLint rules, dependency versions)
- Framework detection beyond simple heuristics
- Rich git state (recent commit summaries, diff statistics, ahead/behind remote)
- Per-ecosystem command inference (auto-suggesting `pnpm test` vs `cargo test`)
- Custom agent ignore patterns beyond `.gitignore`
