<!-- Source: 07-milestone7-delegation.md (reordered and split) -->
# ACA Implementation Steps — Milestone 7, Part C: Capabilities & Modes

LSP, browser, web, checkpointing, CLI modes, telemetry. These steps depend on M7A (error handling, health, network policy) being complete.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure

---

## Milestone 7C: Capabilities & Modes

### M7.3 — LSP Integration (Block 2: Code Intelligence)

- [x] `lsp_query` tool: operation (hover, definition, references, diagnostics, symbols, completions, rename), file, position/scope
- [x] Thin adapter over `vscode-jsonrpc/node` + `vscode-languageserver-protocol`
- [x] Lazy lifecycle: start on first query, session-scoped, crash restart once
- [x] File-extension routing: `.ts`→TypeScript, `.py`→pyright, `.rs`→rust-analyzer, etc.
- [x] Bundle `typescript-language-server`, others expected on PATH
- [x] `warming_up` retryable error if init exceeds 10s timeout
- [x] Rename returns preview only (WorkspaceEdit), does not apply
- [x] Fallback is explicit: unavailable → structured error, model decides
- [x] Health integration: crash → M7.13 health state update → M7.7c tool masking if unavailable

**Tests:**
- Hover on TypeScript symbol → returns type info
- Go to definition → returns file path + position
- Find references → returns list of locations
- Rename preview → returns WorkspaceEdit without modifying files
- Server not installed (e.g., rust-analyzer missing) → `LspUnavailable` with install hint
- Server crash → restart once. Second crash → mark unavailable for session (M7.13 integration)
- Warming up (slow init) → retryable error with `warming_up` code
- Multi-language: TypeScript + Rust files → two servers running, correct routing

### M7.4 — Browser Automation (Playwright, Block 3)

- [x] Browser tools: navigate, click, type, press, snapshot, screenshot, evaluate, extract, wait, close
- [x] Lazy initialization: first browser tool → launch Chromium headless
- [x] Session-scoped BrowserContext: persists cookies/state across calls
- [x] Single active page (v1)
- [x] Crash recovery: restart once with 2s backoff → unavailable on second crash
- [x] Process registry integration: PID, idle TTL (1h), hard max (4h)
- [x] Checkpointing: workspace file writes (e.g., screenshot PNGs) are checkpointed normally; browser state (cookies, DOM, sessionStorage) is excluded. Turns carry `externalEffects: true` so `/undo` warns about non-reversible browser state and closes the active session
- [x] Network policy integration: domain checked before navigation (M7.10) — route interceptor enforces policy on ALL navigations (click, form submit, etc.)
- [x] **Security hardening (mandatory):**
  - [x] BrowserContext: `acceptDownloads: false`, `permissions: []` (deny geolocation, camera, mic, notifications)
  - [x] Launch args: `--disable-extensions`, `--disable-plugins`, `--disable-background-networking`, `--disable-sync`
  - [x] Sandbox-first launch: attempt `--sandbox` first, fall back to `--no-sandbox` with logged warning only if sandbox fails
  - [x] No `--disable-popup-blocking` (popups stay blocked)

**Tests:**
- Navigate to test page → page loaded (verify via snapshot)
- Click button → DOM state changed
- Type in input → value set
- press key (e.g., Enter, Escape) → keyboard event dispatched, expected DOM change occurs
- snapshot → returns accessibility tree / DOM structure (not a screenshot, structured text)
- evaluate JS expression → returns expression result (e.g., `document.title` → page title string)
- extract selector → returns text content of matching elements
- wait for selector → blocks until element appears (with timeout), returns on match or times out with error
- Screenshot → PNG file created
- State persistence: navigate to login → type credentials → click submit → navigate to dashboard → cookies preserved
- Close → context destroyed. Next call → fresh context
- Crash recovery: kill browser PID → restart succeeds. Kill again → unavailable
- Idle timeout: mock 1h → browser cleaned up
- Network policy: navigate to denied domain → blocked
- Screenshot creates file → /undo reverts the PNG file but warns about browser state loss
- Security: BrowserContext created with `acceptDownloads: false` → download attempt has no effect
- Security: BrowserContext permissions array is empty → geolocation request denied
- Security: sandbox-first launch → if sandbox fails, fallback logged as warning and `--no-sandbox` used

### M7.5 — Web Capabilities (Block 3)

> Depends on M7.10 (network egress integration) for policy enforcement.

- [x] `web_search` tool: query, domain filter, recency, limit → ranked results. Provider-abstracted (start with SearXNG or Tavily)
- [x] `fetch_url` tool: Tier 1 (HTTP + jsdom + readability → markdown). Tier 2 (Playwright fallback for SPAs)
- [x] `lookup_docs` tool: library, version, query → doc passages
- [x] Network policy enforcement: all web tools check M2.7/M7.10 policy before any request
- [x] Output caps: download 2-5 MB, extracted 4-8K chars
- [x] **Security hardening (mandatory):**
  - [x] `fetch_url` Tier 1: verify `jsdom` is created WITHOUT `runScripts` option (default disabled, but must be explicit and tested)
  - [x] `fetch_url` Tier 1: enforce strict download size cap (5 MB) via `Content-Length` check + streaming byte counter, abort on exceeded
  - [x] `fetch_url` Tier 1: set request timeout (30s) and follow-redirect limit (5 max)
  - [x] `fetch_url` Tier 2: reuse M7.4 hardened BrowserContext (inherits `acceptDownloads: false`, `permissions: []`, hardened launch args)
  - [x] All web tools: extracted content capped at 8K chars, truncated at paragraph boundary before reaching LLM context

**Tests:**
- web_search with mock provider → normalized results (title, url, snippet)
- fetch_url on static HTML page → markdown content extracted
- fetch_url on SPA (JS-rendered) → Tier 1 fails → Tier 2 (Playwright) succeeds
- fetch_url with size cap exceeded → truncated
- Network mode=off → network tools return `network_disabled` error
- Network mode=approved-only, unlisted domain → requires confirmation
- Domain deny list → denied even in open mode
- Localhost exception (9 parameterized tests — 3 tools × 3 addresses): each of `fetch_url`, `web_search`, `lookup_docs` with each of `localhost`, `127.0.0.1`, `::1` → auto-allowed regardless of network mode
- Shell localhost NOT exempted: `exec_command "curl localhost"` → still subject to network policy detection (not auto-allowed, because shell can do anything once running)
- Security: `jsdom` created without `runScripts` → inline script tags in HTML are NOT executed
- Security: fetch_url with 10 MB response → aborted at 5 MB cap, error returned
- Security: fetch_url with redirect chain > 5 → aborted, error returned
- Security: fetch_url Tier 2 uses hardened context → `acceptDownloads` is false

### M7.6 — Checkpointing / Undo (Block 16)

- [x] Shadow refs in git: `refs/aca/checkpoints/<session-id>/`
- [x] Per-turn, lazy: checkpoint created before first workspace-write in a turn
- [x] Before/after pair: `beforeTurn` and `afterTurn` commits
- [x] `/undo [N]`: revert last N mutating turns
- [x] `/restore <id>`: preview changes first, require confirmation before applying. Show diff between current workspace and target checkpoint
- [x] `/checkpoints`: list recent checkpoints with metadata (turn number, files changed, timestamp)
- [x] Divergence detection: compare live workspace against last `afterTurn`. Applies to both `/undo` and `/restore`
- [x] Manual edit conflict: block undo/restore, require `--force`. Never silently discard manual edits
- [x] `externalEffects: true` warning on undo of turns with exec_command
- [x] Auto-init git repo if none exists

**Tests:**
- edit_file → checkpoint created with beforeTurn and afterTurn
- /undo → files restored to beforeTurn state
- /undo 3 → last 3 mutating turns reverted
- /restore preview: shows diff of what would change before applying
- /restore confirmation: user must confirm after seeing preview
- /restore to specific checkpoint → workspace matches that state
- Read-only turn → no checkpoint created
- Manual edit between turns → divergence detected → undo blocked
- Force override → undo succeeds despite divergence
- /restore with manual edits since target → divergence detected → restore blocked
- /restore --force with manual edits → restore succeeds despite divergence
- exec_command turn → undo restores files but warns about shell side effects
- /checkpoints → lists recent checkpoints with metadata
- Shadow refs invisible to `git branch` and `git log`

### M7.10b — CLI Setup Commands (Block 10)

- [x] `aca init`: create `~/.aca/` directory structure, `secrets.json` with restricted permissions (POSIX: `0600`; Windows: owner-only ACL via `icacls`), initial `config.json`
- [x] `aca configure`: interactive configuration wizard (use `@inquirer/prompts` for structured prompts)
- [x] `aca trust [path]`: mark workspace as trusted in `~/.aca/config.json` `trustedWorkspaces` map
- [x] `aca untrust [path]`: remove workspace trust

**Tests:**
- `aca init` → creates `~/.aca/`, `secrets.json` with restricted permissions (POSIX: `0600`; Windows: owner-only ACL), `config.json` with defaults
- `aca init` on Windows → `secrets.json` ACL set via `icacls` (no `0600` equivalent); startup permission check uses `fs.access` + platform-conditional logic
- `aca init` when `~/.aca/` exists → no error, preserves existing files
- `aca trust /path/to/project` → `trustedWorkspaces` map updated in user config
- `aca untrust /path/to/project` → entry removed
- `aca trust` without path → uses cwd

### M7.11 — Executor Mode (Block 10, Block 1: Delegation Contract)

Full implementation of the universal capability contract's callee side.

- [x] `aca describe --json`: output capability descriptor, skip all startup phases
  - Descriptor fields: `contract_version`, `schema_version`, `name`, `description`, `input_schema`, `output_schema`, `constraints`
- [x] `aca invoke --json`: read JSON from stdin, execute, write JSON to stdout
  - Request envelope: `contract_version`, `schema_version`, `task`, `input`, `context`, `constraints`, `authority`, `deadline`
  - Response envelope: `contract_version`, `schema_version`, `status`, `result`, `usage` (tokens, cost), `errors`
- [x] Version compatibility check: contract_version + schema_version major must match
- [x] Mismatch → `unsupported_version` error on stdout + non-zero exit
- [x] No streaming (v1): buffer full result
- [x] Ephemeral non-resumable sessions
- [x] No stderr output (reserved for catastrophic failures)
- [x] Exit codes: 0/1/5 (success/runtime/protocol)
- [x] Authority propagation: `authority` field from request maps to child pre-auth rules

**Tests:**
- `aca describe --json` → valid JSON with contract_version, schema_version, name, description, input_schema, output_schema, constraints
- `aca describe` is fast (< 100ms, no config/session loading)
- `aca invoke` with valid request → structured result on stdout with usage stats
- `aca invoke` with version mismatch → `unsupported_version` error, exit 5
- `aca invoke` with malformed JSON stdin → error, exit 5
- No stderr output during normal execution
- Session is ephemeral: not listed for resume
- Authority propagation: request includes pre-auth patterns → child session honors them
- Response envelope includes token usage and cost

### M7.12 — One-Shot Mode (Block 10)

- [x] `aca "task text"` → single turn, up to 30 steps
- [x] Piped input: `echo "task" | aca` → one-shot
- [x] Text output to stdout, errors to stderr
- [x] Confirmation handling with TTY → inline prompt. Without TTY + no `--no-confirm` → fail
- [x] Resume + one-shot: `aca --resume "new task"` → resume session + one turn
- [x] Exit codes mapped to error categories

**Tests:**
- `aca "echo hello"` with mock provider → output on stdout, exit 0
- Piped input → treated as task, exit 0
- Approval needed, no TTY, no --no-confirm → exit 2
- --no-confirm → approvals auto-granted
- Step limit at 30 → yields with max_steps
- Exit code 1 on runtime error, 2 on cancel

### M7.14 — OpenTelemetry Export (Block 19)

- [x] Opt-in via `telemetry.enabled: true`
- [x] OTLP/HTTP JSON via native fetch (supersedes @opentelemetry packages — M5.7 decision, 4-witness validated)
- [x] Aggregate metrics only: session count, tokens, cost, error counts, latency percentiles
- [x] Never sends: content, file paths, messages, arguments
- [x] Configurable endpoint and interval (default 300s)
- [x] Failure → silent drop, no impact on agent

**Tests:**
- telemetry.enabled=false (default) → no OTel initialization
- telemetry.enabled=true → metrics exported to mock endpoint
- Verify: exported data contains only aggregate metrics, no content
- Endpoint unreachable → silent failure, agent unaffected
- Interval: mock clock → export fires at configured interval

---

### M7.15 — CLI Wiring + Integration Test

Wire all M7 features into the CLI entry point and verify they work end-to-end.

- [x] Wire error recovery (M7a): retry policies, health tracker, tool masking
- [x] Wire delegation (M7b): agent registry, spawn/await/message tools registered
- [x] Wire LSP integration (M7.3) into project awareness
- [x] Wire browser/Playwright tools (M7.4) with sandbox constraints
- [x] Wire web tools (M7.5): fetch, search
- [x] Wire checkpointing (M7.6) into TurnEngine
- [x] Wire CLI modes: executor mode (M7.11), one-shot mode (M7.12)
- [x] Wire setup commands (M7.10b)
- [x] Real delegation test: ask agent to spawn a sub-agent, verify communication
- [x] Real browser test: ask agent to navigate to a page, verify Playwright executes
- [x] Real checkpoint test: make changes, undo, verify rollback

**Tests:**
- All M7 tools registered and callable via agent prompt
- Delegation round-trip with mock sub-agent
- CLI mode detection: `aca exec` vs `aca` vs one-shot

---

## Post-Milestone Review (M7 — covers 07a, 07b, 07c)
<!-- risk: high — sub-agent delegation, transitive permission amplification, browser automation, LSP -->
<!-- final-substep: M7.15 — gate runs after this substep completes (covers all of 07a, 07b, 07c) -->
- [x] Architecture review (4 witnesses): spec drift, coupling, interface consistency across all M7 substeps
- [x] Security review (4 witnesses): delegation permission escalation, browser sandbox escape vectors, web fetch malware surface, LSP trust, `--no-sandbox` fallback implications
- [x] Bug hunt (4 witnesses): cross-module integration, adversarial delegation chains
- [x] Arch findings fed into security prompt; security findings fed into bug hunt prompt
- [x] Critical findings fixed and verified before release
- [x] Bug hunt findings converted to regression tests
- [x] Review summary appended to changelog
