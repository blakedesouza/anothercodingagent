<!-- Source: fundamentals.md lines 1240-1454 -->
### Block 10: CLI Interface & Modes

> Current implementation note (2026-04): the exact live CLI surface is `aca --help`
> plus subcommand help. The current public build exposes `serve`, `describe`,
> `methods`, `debug-ui`, `witnesses`, `consult`, `rp-research`, `invoke`, `stats`,
> `init`, `configure`, `trust`, and `untrust`, with root flags `--model`,
> `--verbose`, `--no-confirm`, and `--resume`. Some option/mode details below
> reflect broader design intent from the original `fundamentals.md` and are not
> a byte-for-byte description of the current shipped flag surface.

The entry point and invocation modes. This block wires the user-facing CLI to the internal engine — it is the part users actually touch. It consumes Block 6's turn engine interface (`executeTurn`, `interrupt`, `getPhase`), Block 9's config loading pipeline, Block 8's approval classes and `--no-confirm` semantics, and the delegation contract's `describe`/`invoke` operations. All human-facing output (prompts, status, progress, errors) goes to `stderr`. `stdout` is reserved for assistant content (interactive/one-shot) or structured JSON (executor), per the observability decision.

**Core principle: modes are entry points, not runtime states.** The mode is determined once at startup and does not change during the session. Each mode defines how input arrives, how output is delivered, and when the process exits. The turn engine (Block 6) does not know which mode it is running in — the mode-specific wrapper calls `executeTurn` and interprets the yield.

**Foundational decisions:**

- **Argument parser: `commander` (v12+).** Commander is the right fit for ACA's command shape: subcommands with independent option schemas, typed options via `.opts<T>()`, built-in help and version generation, and a fluent API that scales to the ~7 subcommands without middleware complexity. `util.parseArgs` (Node 18.3+) lacks subcommand support entirely — adopting it would require rebuilding half of commander. `yargs` is more powerful but its middleware system and `.commandDir()` indirection add complexity without benefit for this use case. Commander's TypeScript definitions provide compile-time safety, and its 130M weekly downloads provide stability confidence.

  **Command tree:**

  | Command | Purpose | Notes |
  |---|---|---|
  | `aca [task]` | Main entry — interactive (no args) or one-shot (with task) | Default command |
  | `aca describe` | Output capability descriptor (delegation contract) | Always `--json` |
  | `aca invoke` | Execute structured task from stdin (delegation contract) | Always `--json` |
  | `aca init` | Initialize `~/.aca/` directory structure and secrets | Setup command |
  | `aca configure` | Interactive configuration wizard | Setup command |
  | `aca trust [path]` | Mark a workspace as trusted (Block 9) | Modifies `~/.aca/config.json` |
  | `aca untrust [path]` | Remove workspace trust (Block 9) | Modifies `~/.aca/config.json` |
  | `aca stats` | Usage analytics and cost summary (Block 19) | Queries SQLite observability store |

  The main command handles the `[task]` positional argument. Subcommands (`describe`, `invoke`, `init`, `configure`, `trust`, `untrust`) are independent entry points with their own option schemas. Global options (`--model`, `--verbose`, `--config`, etc.) are defined on the root program and inherited by all commands.

- **Mode detection: hybrid — subcommands for executor, implicit for human modes, with explicit override.** The mode is resolved once at startup using a deterministic priority chain. Executor mode is always explicit (via subcommand or `--json` flag with piped stdin). Human modes are inferred from context.

  **Resolution rules (evaluated in order, first match wins):**

  | Condition | Resolved mode |
  |---|---|
  | `aca describe` or `aca invoke` subcommand | Executor |
  | `!process.stdin.isTTY && --json` flag present | Executor |
  | Positional `[task]` argument present | One-shot |
  | `!process.stdin.isTTY && !--json` (piped text, no JSON flag) | One-shot (piped text becomes the task) |
  | None of the above | Interactive |

  **Edge case resolutions:**
  - `echo "fix the bug" | aca` — one-shot. The piped text is read as the task input. Executor requires `--json`
  - `echo '{"task":"..."}' | aca invoke --json` — executor. The subcommand is unambiguous
  - `aca --resume "continue fixing"` — resume session + one-shot (positional arg present)
  - `aca --resume` (with TTY) — resume session + interactive
  - `aca --resume` (without TTY) — error: no task input and no TTY for interaction
  - Positional task argument combined with piped stdin — rejected as ambiguous with a clear error message

  There is no `--mode` flag in v1. The resolution rules are deterministic and cover all practical invocations. An explicit mode flag adds option surface without resolving real ambiguity — the subcommand/TTY/positional heuristic is sufficient.

- **Flag design: minimal core flags, not a second config language.** The CLI exposes only high-value session-shaping overrides. Persistent configuration belongs in config files and environment variables (Block 9). Flags are for one-off overrides at invocation time.

  **Core flags (root program, inherited by all commands):**

  | Flag | Type | Config mapping | Purpose |
  |---|---|---|---|
  | `-m, --model <model>` | string | `model.default` | Model override for this session |
  | `--no-confirm` | boolean | `permissions.nonInteractive` | Auto-approve `confirm` decisions (not `deny`, per Block 8) |
  | `-v, --verbose` | boolean | (runtime only) | Verbose event rendering on stderr |
  | `-q, --quiet` | boolean | (runtime only) | Suppress non-essential stderr output. Never suppresses approval prompts or fatal diagnostics |
  | `--json` | boolean | (runtime only) | Structured JSON output mode. Implies executor when combined with piped stdin |
  | `-c, --config <path>` | string | (loader override) | Override config file path |
  | `-r, --resume [session]` | optional string | (session management) | Resume last session for workspace (no arg) or specific session ID (with arg) |
  | `--workspace <path>` | string | (workspace override) | Override workspace root detection |
  | `--max-steps <n>` | number | `limits.maxStepsPerTurn` | Override step limit for this session |

  **Boolean flag conventions:** Presence-based for positive toggles (`--verbose` = true, absent = false). Commander's built-in `--no-` prefix handling for negation (`--no-confirm`). No `--flag=false` syntax in v1 — use absence of flag. `--quiet` and `--verbose` are mutually exclusive; if both are present, `--quiet` wins (less output is safer). `--verbose` and `--json` are mutually exclusive; `--json` wins (structured output must not be polluted by verbose human text).

  **What is NOT a flag:** Provider selection (`--provider`), network mode, temperature, sandbox roots, pre-authorization rules, scrubbing patterns, and all other config fields. These are set via config files or `ACA_` environment variables per Block 9's precedence rules. The CLI is not a replacement for configuration — it is a lightweight override layer.

- **Three invocation modes with distinct semantics:**

  **Interactive mode** (`aca` with no arguments, TTY present):

  The agent launches a REPL session. The user and agent take turns. The session persists until the user exits (`/exit`, `/quit`, Ctrl+D) or the process is terminated.

  *Input handling:* Node.js `readline`/`readlinePromises` (built-in) for the main input loop, with output bound to `process.stderr` to preserve the stdout/assistant-content contract. The readline interface handles line editing, history (arrow keys), and SIGINT during input (clears current line, redisplays prompt). For multi-line input: a trailing `\` continues to the next line; a `/edit` slash command opens `$EDITOR` (or `$VISUAL`, falling back to `nano`) with a temp file for composing longer messages. Bare Enter on a non-empty line submits.

  *Confirmation prompts:* When the turn engine yields with `approval_required`, the CLI presents Block 8's `[y] approve [n] deny [a] always [e] edit` prompt on stderr using a simple single-keypress handler (raw mode for the single prompt, then back to readline). This does not require a heavy prompt library — it is a single-key selection with four options. The `[e] edit` option opens the command in `$EDITOR` and re-runs risk analysis on the edited result.

  *Slash commands:* Input lines starting with `/` are intercepted before being passed to the turn engine. Built-in slash commands: `/undo [N]`, `/restore <id>`, `/checkpoints` (Block: Checkpointing), `/exit` or `/quit`, `/edit` (open editor for multi-line input), `/clear` (clear terminal), `/status` (show session info, token usage, active capabilities), `/reindex` (rebuild project semantic index, Block 20), `/budget [extend <amount>]` (show remaining budget or extend it, Block 19), `/help` (list commands). Unknown slash commands produce a helpful error. Slash commands are not sent to the LLM.

  *Streaming coexistence:* During agent execution, text tokens stream to stdout (Block 6 streaming decision). The readline prompt is not active during agent execution — the terminal shows streaming output. When the agent yields, the readline prompt reappears. Tool progress indicators go to stderr. SIGINT during streaming is caught by the signal handler (see below), not by readline.

  *Why not ink:* ink (React for CLI) is a full TUI framework that fights the streaming model — it wants to own the terminal and re-render on state changes, which conflicts with raw token streaming to stdout. It is too heavy for v1. The readline + raw-mode-for-prompts approach is sufficient and composable. Revisit if TUI complexity grows significantly.

  *Why not @inquirer/prompts for the main loop:* Inquirer is designed for structured wizard-style prompts, not a free-form REPL. It is appropriate for the `aca configure` setup wizard but not for the main input loop. The approval prompt (4 keys) is simple enough to implement with raw mode directly.

  **One-shot mode** (`aca "fix the bug in auth.ts"` or piped input):

  The agent receives a single task, executes it autonomously, and exits. One-shot runs exactly one turn — one user message submitted to the turn engine, which runs its step loop (up to 30 steps per Block 6's one-shot/sub-agent default) until a yield condition is met. A text-only yield (assistant response with no pending tool calls) is the normal completion signal.

  *Why one turn, not multi-turn looping:* A single turn with 30 steps provides substantial autonomous capacity — the agent can read files, edit files, run tests, iterate on failures, all within one turn. A text-only yield means "I have completed my autonomous work and have a response." Multi-turn looping creates ambiguity: if the agent yields with text and no tool calls, did it finish the task or provide a progress update? The engine has no reliable "task complete" signal distinct from "turn complete." The safer v1 design treats one turn as the unit of one-shot work. Users who need multi-turn interaction should use interactive mode.

  *Confirmation handling in one-shot:* If a tool requires confirmation (`approval_required` yield) and a TTY is available, the CLI presents the approval prompt inline — the user can approve or deny as part of the one-shot execution. If no TTY is available and `--no-confirm` is absent, the tool fails with `user_cancelled` per Block 8's non-interactive semantics. The error message suggests running interactively or with `--no-confirm`.

  *Output:* Assistant text is written to stdout. Errors and diagnostics go to stderr. The final assistant message is the process output — suitable for piping to other tools (`aca "summarize this file" > summary.txt`).

  *Resume + one-shot:* `aca --resume "now fix the tests"` resumes the most recent session for this workspace and submits the new task as a user message, running one turn. This is useful for iterative workflows without entering interactive mode.

  **Executor mode** (`aca describe` / `aca invoke`):

  The agent operates as a callee in the delegation contract. Executor mode is entered via subcommand, not via flag inference. The two executor subcommands map directly to the universal capability contract operations defined in the Pluggable Delegation block.

  *`aca describe --json`:* A fast path that outputs the capability descriptor as a single JSON object on stdout and exits. This command skips workspace detection, config loading, session creation, and all other startup phases — the descriptor is a static declaration that depends only on the agent's version and built-in capabilities. The output includes `contract_version`, `schema_version`, capability name, description, input/output schemas, and constraints.

  *`aca invoke --json`:* Reads a complete JSON request from stdin, executes the task, and writes a structured JSON result to stdout. The stdin envelope matches the universal capability contract's invoke request shape exactly — `contract_version`, `schema_version`, `task`, `input`, `context`, `constraints`, `authority`, `deadline`. Version compatibility is checked before execution; mismatches return a structured `unsupported_version` error on stdout with a non-zero exit code (per the delegation contract's error shape).

  *I/O contract:* All output is structured JSON on stdout. Errors are JSON on stdout with a non-zero exit code — never raw text on stderr. Human-readable stderr output is fully suppressed in executor mode (no progress indicators, no status lines, no streaming text). The caller parses stdout; stderr is reserved for catastrophic failures only (e.g., out-of-memory, segfault). This keeps the protocol clean for machine consumption.

  *Streaming in executor mode:* No streaming in v1. The entire result is buffered and written as a single JSON object on stdout after execution completes. JSONL streaming (one event per line during execution) is a potential v2 enhancement for long-running tasks, but adds protocol complexity that is not justified in v1. The caller sets a deadline in the request; the agent respects it.

  *Session lifecycle:* Executor mode creates an ephemeral session that is not resumable. The session is created, used for the single invocation, and its data is retained in `~/.aca/sessions/` for debugging and auditing but not surfaced for resume. Sub-agent sessions always have `parentSessionId` set, enabling lineage tracing.

  *Cannot resume into executor mode:* Executor mode is stateless by contract — each invocation is independent. Resuming implies conversation history, which contradicts the delegation contract's bounded invocation model.

- **Exit codes: six codes covering all failure categories.** Exit codes are the primary signal for scripting and CI integration. The structured result (stdout JSON in executor mode, event log in all modes) carries fine-grained error details — exit codes provide coarse categorization for `$?` checks and `set -e` compatibility.

  | Code | Name | When | Notes |
  |---|---|---|---|
  | 0 | Success | Task completed normally | Text-only yield in one-shot, clean exit in interactive, successful result in executor |
  | 1 | Runtime error | Unrecoverable error during execution | Tool failure, LLM error, step limit reached, unexpected exception |
  | 2 | User cancelled | User interrupted or denied required approval | SIGINT abort, approval denied in non-interactive mode, Ctrl+D during required input |
  | 3 | Usage error | Invalid CLI arguments or ambiguous invocation | Bad flags, conflicting options, ambiguous piped+positional input |
  | 4 | Startup failure | Config, auth, workspace, or session error | Invalid config, missing API key, secrets file permission wrong, session not found for resume |
  | 5 | Protocol error | Executor mode contract violation | Invalid JSON on stdin, version mismatch, malformed request envelope |

  Exit codes above 5 are not assigned in v1. 128+N codes are reserved for signal-terminated processes by convention (e.g., 130 for SIGINT). The six-code scheme covers all categories without the "everything is exit 1" anti-pattern, while remaining small enough to remember and script against:

  ```bash
  aca "fix bug" || case $? in
    2) echo "Cancelled — run interactively or with --no-confirm";;
    4) echo "Check API key: ACA_MODEL_DEFAULT or ~/.aca/secrets.json";;
  esac
  ```

- **Signal handling: Block 6 two-tier SIGINT wired through, plus graceful handling for SIGTERM, SIGHUP, and SIGPIPE.** The CLI layer is responsible for registering OS signal handlers and translating them into the engine's `interrupt` interface and session persistence operations.

  **SIGINT (two-tier, per Block 6):**

  The signal handler maintains a `lastSigintTimestamp`. On each SIGINT:
  1. If within 500ms of the previous SIGINT — hard exit. Save manifest synchronously (`saveManifestSync`), exit with code 2. This matches the common CLI convention of double Ctrl+C to force quit
  2. If within 2s of the previous SIGINT and the turn engine is active — call `interrupt('abort_turn')`. The turn aborts, session state is saved, and the process returns to the input prompt (interactive) or exits with code 2 (one-shot/executor)
  3. Otherwise (first SIGINT or more than 2s since last) — call `interrupt('cancel_operation')`. The active operation (LLM streaming, tool execution) is cancelled per Block 6's phase-aware cancellation. The turn yields with `cancelled` outcome
  4. During input (readline active, no turn running) — SIGINT clears the current input line and redisplays the prompt. Two SIGINTs during input within 500ms exits the process (consistent with shell behavior)

  **SIGTERM (graceful shutdown):** Save session state (manifest + pending writes), abort the active turn if one is running, clean up spawned processes via the process registry, exit with code 0. SIGTERM is the standard signal for graceful process termination (sent by `kill`, systemd, Docker stop).

  **SIGHUP (terminal hangup):** Same behavior as SIGTERM — save state and exit. SIGHUP is sent when the terminal is closed (SSH disconnect, terminal emulator closed). Session data is preserved for later resume.

  **SIGPIPE / EPIPE:** Handled via `process.stdout.on('error')` rather than `process.on('SIGPIPE')` (Node.js does not reliably deliver SIGPIPE as a process event). When stdout's consumer is gone (pipe closed), exit immediately with code 0 and no stack trace. In executor mode, this is a protocol-level write failure — the caller disconnected. The session is saved but the result is lost.

  **SIGQUIT:** Not handled in v1. The default behavior (core dump if enabled) is acceptable for development. A diagnostic dump feature (dumping current phase, active tool, session state to stderr) is a potential v2 enhancement.

  **Unhandled rejection / uncaught exception:** Register global handlers that log the error to the event stream, save the session manifest, and exit with code 1. The error is written to stderr as a human-readable message (not a raw stack trace in non-verbose mode; full stack in verbose mode). This prevents silent data loss on unexpected crashes.

- **Startup sequence: deterministic 8-phase pipeline from invocation to mode entry.** The startup sequence runs once and produces the `RuntimeContext` consumed by the mode-specific loop. Phases are ordered by dependency — each phase's output is required by subsequent phases.

  **Phase 1 — Parse CLI arguments.** Commander parses `argv`, resolves the active command (root or subcommand), and extracts typed options and positional arguments. Invalid arguments fail immediately with exit code 3 and a help message. This phase is synchronous and has no side effects.

  **Phase 2 — Fast-path for `describe`.** If the active command is `aca describe`, skip all remaining phases. Output the static capability descriptor to stdout and exit with code 0. The descriptor depends only on the agent's version — no config, workspace, or session is needed. This makes `describe` near-instantaneous for capability discovery.

  **Phase 3 — Load configuration.** Run Block 9's deterministic config pipeline: load defaults, load user config (`~/.aca/config.json`), detect workspace root (via Project Awareness — walk up from `--workspace` override or `cwd` to find `.git`), load project config (`.aca/config.json` in workspace root, filtered through trust boundary), parse `ACA_` environment variables, apply CLI flag overrides, merge with precedence rules, validate, freeze as `ResolvedConfig`. Config errors fail with exit code 4. Project detection warnings (no `.git` found, no workspace root) are emitted to stderr but do not fail — the agent operates with `cwd` as a fallback workspace root.

  **Phase 4 — Load secrets and initialize redaction.** Load API keys from environment variables and `~/.aca/secrets.json` (Block 9). Verify `secrets.json` file permissions (must be `0600`). Build the exact-value redaction set for Block 8's secrets scrubbing. Missing API keys for the configured provider fail with exit code 4 and a message indicating which key is needed and where to set it.

  **Phase 5 — Resolve session.** If `--resume` is present: find the target session (latest for this workspace if no ID specified, or the specific `ses_<ULID>` if provided). Load `manifest.json` and rebuild the in-memory projection from `conversation.jsonl`. Detect config drift between the stored config snapshot and the current resolved config — warn on stderr if security-relevant settings have changed, but proceed. If the session is not found, fail with exit code 4. If `--resume` is absent: create a new session with a fresh `ses_<ULID>`, write the initial manifest with the config snapshot. For executor mode (`aca invoke`): create an ephemeral session marked as non-resumable.

  **Resume invariants:** A resumed session retains its stored workspace root and original config snapshot for reference. Invocation-scoped flags (`--verbose`, `--quiet`, `--no-confirm`, `--max-steps`) apply to the resumed session. Session-shaping flags that conflict with the frozen config (`--model` when different from the session's model) emit a warning but are allowed — the CLI flag takes precedence per Block 9's rules, and the config snapshot records the divergence. The `ResolvedConfig` for the resumed session is re-computed from current sources (not loaded from the snapshot), maintaining the principle that CLI flags always win.

  **Phase 6 — Initialize runtime services.** Create the process registry for spawned process tracking (Block: Tool Runtime Contract). Initialize the event sink (append-only JSONL writer targeting the session's `events.jsonl`). Emit `session.started` for both fresh and resumed sessions; resumed state is distinguished by the restored session manifest and startup path, not by a separate event type. Create the turn controller with all dependencies injected: session, resolved config, process registry, secret redactor, event sink.

  **Phase 7 — Display startup status.** In interactive mode: write a compact status block to stderr — version, session ID (truncated for readability), workspace root, model, and resume indicator if applicable. In one-shot mode: no startup display unless `--verbose`. In executor mode: no output of any kind — stdout is reserved for the structured result.

  **Phase 8 — Enter mode-specific loop.** Hand off to the interactive REPL, one-shot executor, or delegation handler. From this point, control flow is mode-specific.

  **What is NOT in the startup sequence:** LSP server initialization (lazy, on first `lsp_query` per Block 6). Browser/Playwright initialization (lazy, on first browser tool call). Search provider initialization (lazy, on first `web_search`). All capability initialization follows the "start on first use" principle — startup is fast by default.

- **Session resume: `--resume` for last session, `--resume <id>` for specific session.** Session resume reconstructs the in-memory state from the conversation log and allows the user to continue where they left off. Resume is a property of the startup sequence (Phase 5), not a separate mode.

  **Invocation forms:**

  | Command | Behavior |
  |---|---|
  | `aca --resume` | Resume most recent session for the current workspace. Enter interactive mode (TTY) or error (no TTY, no task) |
  | `aca --resume ses_01JQ7K...` | Resume the specific session. Enter interactive mode |
  | `aca --resume "fix the tests too"` | Resume most recent session, submit new task as one-shot |
  | `aca --resume ses_01JQ7K... "fix the tests too"` | Resume specific session, submit new task as one-shot |

  **Session selection:** `--resume` without an argument finds the most recent session for the current workspace's `workspaceId` (derived from workspace root path per Block 5). If no previous session exists, fail with exit code 4 and a clear message. `--resume <id>` opens the specific session regardless of workspace — this enables resuming a session from a different terminal or directory. The session's stored workspace root is used for path resolution.

  **What resume rebuilds:** The in-memory conversation projection (items, turns, steps, coverage map for summaries), session manifest (status, turn count, last activity), and process registry (no processes survive across invocations — the registry starts empty, old process entries are recorded as `terminated`). Checkpoint state is intact in git refs and does not need rebuilding.

  **Resume + executor mode:** Not supported. Executor mode creates ephemeral sessions per the delegation contract's stateless invocation model. Attempting `aca invoke --resume` is rejected as a usage error (exit code 3).

  **Session listing:** `aca --resume` needs to find sessions by workspace. Sessions in `~/.aca/sessions/` have `workspaceId` in their manifests. The session manager scans manifest files to find the latest session for a given workspace. In v1, this is a directory scan — if performance becomes an issue with many sessions, add an index file in v2. A future `aca sessions` subcommand (deferred) would provide listing, search, and cleanup.

**Integration with other blocks:**

- **Block 6 (Agent Loop):** The mode-specific loop calls `executeTurn(session, input)` for each turn and interprets the `TurnRecord.outcome` to decide whether to prompt for more input (interactive), exit (one-shot), or return a result (executor). The `interrupt(level)` method is called from the SIGINT handler. The `getPhase()` method feeds the verbose status display on stderr
- **Block 8 (Permissions):** `--no-confirm` flag maps directly to `permissions.nonInteractive` in the resolved config. The interactive mode's approval prompt implements Block 8's `[y] approve [n] deny [a] always [e] edit` UX. One-shot mode without TTY and without `--no-confirm` fails on `approval_required` yields with `user_cancelled`
- **Block 9 (Configuration):** CLI flags feed into Block 9's config pipeline at the highest precedence level. The `--config` flag overrides the config file path. The `--model`, `--no-confirm`, `--max-steps`, and `--workspace` flags map to specific config fields. The `ResolvedConfig` frozen at session start is the product of Block 9's pipeline, consumed by the turn engine and all runtime components
- **Pluggable Delegation:** `aca describe` and `aca invoke` implement the callee side of the universal capability contract. The JSON envelope shapes, version fields, and error types are defined in the Pluggable Delegation block. Block 10 provides the CLI transport binding
- **Observability:** The startup sequence emits `session.started` events for both fresh and resumed sessions. The mode-specific loops emit events through the shared event sink. Verbose mode (`--verbose`) enables the human-readable event renderer on stderr. Quiet mode (`--quiet`) suppresses non-essential stderr output
- **Checkpointing:** Slash commands `/undo`, `/restore`, `/checkpoints` are handled by the interactive mode's slash command dispatcher, which delegates to the checkpointing system

**Deferred:**
- `aca sessions` subcommand for listing, searching, and cleaning up sessions
- Tab completion for slash commands and file paths
- Rich terminal rendering (syntax highlighting, colored diffs, progress bars)
- ink-based TUI for complex interactive workflows
- JSONL streaming in executor mode for long-running tasks
- `--mode` explicit flag (if implicit detection proves insufficient)
- Multi-line input with bracket/quote balancing (v1 uses `\` continuation and `/edit`)
- Session auto-cleanup and retention policies
- `aca config` subcommand for interactive config editing
- `aca replay <session>` subcommand for session playback
- Custom key bindings and prompt themes
