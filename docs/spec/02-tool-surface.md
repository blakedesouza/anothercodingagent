<!-- Source: fundamentals.md lines 197-363 -->
## Foundational Block: Tool Surface

### Design Philosophy

Keep built-in tools small and deep. The model chooses from the tool list every turn — too many tools degrades selection quality. Workflow-specific commands (git, test, lint, build, deploy) go through shell execution, not dedicated wrappers. External integrations surface as dynamic capabilities via the delegation contract.

### Tool Output Limits

All tool results are subject to hard size caps enforced by the Tool Runtime Contract. These limits are documented in tool schemas so the model can plan around them — truncation flags confirm enforcement, but the model should not rely on discovering limits through trial and error.

**Global cap:** 64 KiB per tool result. Oversized output is truncated with `truncated: true` and `bytesOmitted` metadata in the output envelope.

**Per-tool limits:**

| Tool | Cap | Behavior when exceeded |
|---|---|---|
| **read_file** | 64 KiB or 2,000 lines (whichever is hit first) | Returns first chunk from requested start position. Output includes `truncated`, `bytesOmitted`, `linesOmitted`, `totalBytes`, `totalLines`, and `nextStartLine` for continuation |
| **exec_command** | 64 KiB combined stdout + stderr | Head and tail retained (errors cluster at end). Middle omitted with truncation metadata |
| **search_text** | 200 matches max (default limit: 50) | Stops after limit. Output includes total match count if cheaply known |
| **find_paths** | 200 matches max (default limit: 50) | Stops after limit. Output includes total match count if cheaply known |
| All other tools | 64 KiB | Standard truncation |

**Large file navigation:** The model uses `read_file` with explicit line ranges (`line_start`, `line_end`) to navigate files that exceed the cap. Truncated results include enough metadata for the model to compute the next range without additional tool calls. No separate chunking mechanism — `read_file` with ranges is sufficient.

**Binary file handling:** `read_file` detects binary files (via null-byte check on the first 1 KiB plus file extension heuristics) and returns metadata instead of content: `isBinary: true`, file size, detected MIME type, and type-specific metadata when cheaply available (e.g., image dimensions). Binary detection is not an error — it is a normal file classification. No hex dumps; they consume context without aiding model reasoning. If uncertain, err toward treating the file as text.

### Core Tools (built-in, always available)

#### File System

| Tool | What it does | Input | Output |
|---|---|---|---|
| **read_file** | Read part or all of a text file. Truncated at 64 KiB / 2,000 lines — use line_start/line_end to read specific ranges. Binary files return metadata only | path, line_start (optional, 1-indexed), line_end (optional, inclusive) | content, encoding, truncated flag, bytesOmitted, linesOmitted, totalBytes, totalLines, nextStartLine, isBinary, file stats |
| **write_file** | Create or fully replace a file | path, content, mode (create/overwrite) | bytes written, hash |
| **edit_file** | Surgical edits to existing files (search/replace or patch) | path, edit operations | applied edits, rejects/conflicts |
| **delete_path** | Delete a file or directory | path, recursive flag | deleted items |
| **move_path** | Rename or move a file/directory | source, destination | result, conflict flag |
| **make_directory** | Create directories (with parents) | path | created or already existed |
| **stat_path** | Get metadata without reading contents | path | exists, kind, size, mtime, permissions |
| **find_paths** | Find files by name/glob pattern. Hard max 200 matches; default limit 50 | root, pattern, type filter, limit | matching paths with metadata, truncated flag |
| **search_text** | Regex/exact search across files. Hard max 200 matches; default limit 50 | root, pattern, file globs, context lines, limit | matches with file, line, snippet, truncated flag |

#### Shell Execution

| Tool | What it does | Input | Output |
|---|---|---|---|
| **exec_command** | Run a command, wait for completion, capture output. Output capped at 64 KiB (head + tail preserved). For large output, pipe through grep/sed or redirect to file | command, cwd, env, timeout | exit code, stdout, stderr, truncated flag, bytesOmitted, duration |
| **open_session** | Start a long-running/interactive process | command, cwd, env | session id, initial output |
| **session_io** | Send input to / read output from a running session | session id, optional stdin/signal, wait | incremental output, status |
| **close_session** | End a running session | session id, optional signal | final status |

#### Web / Research

| Tool | What it does | Input | Output |
|---|---|---|---|
| **fetch_url** | Fetch a URL and extract readable content | url, timeout | content (markdown/text), status, metadata |
| **web_search** | Search the public web | query, domain filter, recency, limit | ranked results (title, url, snippet) |
| **lookup_docs** | Query official library/framework documentation | library, version, query | doc passages, canonical URLs |

#### Code Intelligence

| Tool | What it does | Input | Output |
|---|---|---|---|
| **lsp_query** | Query language server (hover, definition, references, diagnostics, symbols, completions, rename) | operation, file, position/scope | operation-specific results |

One tool, multiple operations. The LLM specifies which LSP operation it wants. This avoids 15+ separate tools while keeping full LSP power available.

**LSP integration design decisions:**

- **Server distribution: hybrid with registry** — Bundle `typescript-language-server` (the agent's own ecosystem must work out-of-box). All other LSP servers (rust-analyzer, gopls, pyright, clangd, etc.) are expected pre-installed on PATH. Ship a static registry mapping language to `{ command, args, rootMarkers, fileGlobs, installHint }`. If a needed server is missing, return a typed `LspUnavailable` result with the install hint — never auto-install from `lsp_query`. Installation goes through `exec_command` with user confirmation
- **Lifecycle: lazy start, session-scoped, crash restart** — Start the LSP server process on the first `lsp_query` targeting that language, not at session start. Keep it alive for the session, keyed by `(workspaceRoot, serverId)`. If cold initialization (e.g., rust-analyzer indexing a large workspace) exceeds the 10s tool timeout, return `{ status: "error", retryable: true, error: { code: "warming_up" } }` and keep the process alive so the next query hits a warm server. On server crash: restart once with 1s backoff, then mark unavailable for the session. Clean up all server processes on session end via the process registry (same infrastructure as `open_session`)
- **Multi-language: file-extension routing** — Route each `lsp_query` to the correct server based on the target file's extension (`.ts`/`.tsx` to TypeScript, `.rs` to rust-analyzer, `.py` to pyright, etc.). Multiple servers may be alive simultaneously — a TypeScript project with Rust WASM modules will have both `typescript-language-server` and `rust-analyzer` running. Servers are only started on demand, not preemptively for every detected language. For workspace-wide operations with no target file (e.g., workspace symbols), require an explicit `language` parameter or reject as ambiguous
- **Abstraction: thin adapter over `vscode-jsonrpc` and `vscode-languageserver-protocol`** — Use the `vscode-jsonrpc/node` package for JSON-RPC transport over stdio, and `vscode-languageserver-protocol` for typed LSP request/response definitions. Do not use `vscode-languageclient` (VS Code extension-host assumptions the agent does not share). The adapter handles: spawning server processes over stdio, sending `initialize`/`initialized`, managing `textDocument/didOpen` and `textDocument/didClose`, mapping `lsp_query` operations to LSP methods, enforcing the 10s timeout, and shaping results into the standard tool output envelope
- **Rename returns preview only** — The `rename` operation returns the `WorkspaceEdit` proposed by the server but does not apply it. The agent applies edits through `edit_file` after the normal approval flow. This preserves `lsp_query` as read-only (matching its approval class) and keeps mutation authority with the write tools
- **Fallback is explicit, not silent** — When LSP is unavailable (server missing, crashed, timed out), the tool returns a structured error indicating LSP unavailability. The model then decides whether to fall back to `search_text` or `find_paths`. The tool does not silently substitute text-search results as if they were LSP results

**Deferred:**
- Bundling additional LSP servers beyond TypeScript
- LSP server auto-installation or version management
- Semantic token / inlay hint support
- Incremental document sync (full document sync is sufficient initially)
- Multi-root workspace support (single root per server instance for now)
- Code action / quick-fix operations
- LSP server configuration passthrough (e.g., tsconfig paths, pyright settings)

#### User Interaction

| Tool | What it does | Input | Output |
|---|---|---|---|
| **ask_user** | Ask the user a question or present choices | question, optional choices/format | user response |
| **confirm_action** | Request explicit approval for risky/destructive actions | action description, affected paths, risk summary | approved or rejected |

#### Delegation

| Tool | What it does | Input | Output |
|---|---|---|---|
| **spawn_agent** | Start a scoped sub-agent for a specific task | agent_type, task, context, allowed_tools (optional narrowing), label (optional) | agent id, status |
| **message_agent** | Send follow-up to a running sub-agent | agent id, message | ack/status |
| **await_agent** | Wait for sub-agent completion or progress | agent id, timeout (0 = poll) | result or progress snapshot |

**Agent identity, discovery, configuration, lifecycle, and limits:**

- **Identity: flat opaque ID with metadata hierarchy** — Each agent gets an opaque `agt_<ulid>` identifier as its primary key. ULIDs are time-sortable and globally unique within a session. Hierarchy is tracked as metadata, not encoded in the ID string: `parentAgentId`, `rootAgentId`, `depth` (root = 0), and `spawnIndex` (sequential counter per parent). Each agent also carries a human-readable `label` for display, defaulting to `<agent_type>-<spawnIndex>` (e.g., `researcher-1`, `coder-2`). The `agent_id` in the event log envelope is this opaque ID. The `session_id` remains separate — a child agent gets its own session, but the `agent_id` ties together logs, process registry entries, and tool calls across session boundaries

- **Discovery: static registry, no separate tool** — Available agent types are defined in an `AgentRegistry` resolved once at session start from built-in profiles plus any additional profiles registered in project config (`.aca/config.json`). The registry is frozen for the session. The LLM discovers available types through two mechanisms: the `spawn_agent` tool schema includes `agent_type` as an enum populated from the registry, and the per-turn context block includes a one-line manifest (e.g., `Spawnable agents: general, researcher, coder, reviewer`). No separate discovery tool — the existing "all enabled tools every turn" design already provides the right injection point

- **Configuration: predefined profiles, narrow-only overrides** — Agent types are predefined profiles, not ad-hoc compositions. Each profile specifies: a short system prompt overlay, default allowed tools, default model (optional), and whether nested delegation is permitted. Four built-in profiles ship with v1:

  | Profile | Default tools | Can delegate | Description |
  |---|---|---|---|
  | **general** | all read-only + workspace-write tools | yes | Flexible sub-agent for tasks that don't fit a specialist |
  | **researcher** | read_file, find_paths, search_text, fetch_url, web_search, exec_command | no | Deep research: searches, reads, synthesizes. No file writes |
  | **coder** | read_file, write_file, edit_file, find_paths, search_text, exec_command, lsp_query | yes | Implementation: writes code, runs tests, fixes bugs |
  | **reviewer** | read_file, find_paths, search_text, lsp_query, exec_command | no | Code review: analyzes code, finds issues, suggests fixes. Read-only |

  `spawn_agent` accepts optional `allowed_tools` and `authority` overrides, but overrides may only **narrow** what the profile grants, never widen it. Tool intersection is enforced at spawn time. Project-specific profiles can be added via `.aca/config.json` and behave identically to built-ins after session start

- **Lifecycle visibility: coarse, event-driven, sync-compatible** — The parent LLM does not see the child's conversation in real time. Visibility is through `await_agent` only:
  - `await_agent(id, timeout=0)` polls without blocking — returns a progress snapshot: `{ status, phase, activeTool, lastEventAt, elapsedMs, summary }`
  - `await_agent(id, timeout=N)` blocks up to N milliseconds, then returns either the final result or a progress snapshot
  - Phases: `booting`, `thinking`, `tool`, `waiting`
  - Final result includes the child's structured output, token usage, and tool call summary

  Humans see child activity on `stderr` in verbose mode through the existing event renderer. The child's events flow into the shared event log (same `session_id` lineage) for observability and replay, but the parent model only reasons over what `await_agent` returns. This preserves the sync-first execution model — the parent explicitly decides when to check on a child

- **Limits: hard caps, enforced at spawn** — Static defaults enforced in `spawn_agent` before any child process starts. On violation, `spawn_agent` returns a typed `limit_exceeded` error with current and allowed values:

  | Limit | Default | Rationale |
  |---|---|---|
  | Max concurrent agents per root session | 4 | Fits in context window, manageable resource usage |
  | Max delegation depth | 2 (root=0, child=1, grandchild=2) | root -> coder -> reviewer covers common patterns; deeper chains add complexity without clear v1 value |
  | Max total agents per session | 20 (includes completed) | Prevents runaway spawning while allowing complex multi-step workflows |

  **Approval routing:** Children cannot prompt the user directly. If a child agent encounters an action that exceeds its inherited authority, it returns `approval_required` to the parent rather than invoking `ask_user` or `confirm_action`. Only the root agent interacts with the user. This preserves the "user has final say" guarantee through the delegation chain without giving nested agents direct user access

  Sequential spawning (spawn, await, spawn another) is unlimited within the total-per-session cap. Limits are configurable via `.aca/config.json` but the defaults are deliberately conservative for v1

#### Context Management

| Tool | What it does | Input | Output |
|---|---|---|---|
| **estimate_tokens** | Estimate token count for text or files | text or file paths, model | token count, fits-in-context flag |

### Tool Count: 22 built-in tools

### What Is NOT a Built-in Tool

These are important capabilities but belong in **shell execution** (`exec_command`) or **dynamic capabilities** (delegation contract), not dedicated tools:

- **Git operations** — `exec_command("git status")`, `exec_command("git diff")`, etc. Git is already a superb CLI. Wrapping it adds maintenance cost and no value. If you want structured git output or approval policies later, add a dynamic capability.
- **Test/lint/build/format** — `exec_command("npm test")`, `exec_command("eslint .")`. These are project-specific workflows, not universal primitives.
- **Package management** — `exec_command("npm install")`. Same reasoning.
- **Database operations** — dynamic capability if needed, not built-in.
- **Deployment** — dynamic capability if needed, not built-in.
- **Browser automation** — dynamic capability (Playwright, Puppeteer) surfaced via delegation contract when installed.

### Approval Classes

Every tool has an approval class that determines whether user confirmation is needed:

| Class | Behavior | Examples |
|---|---|---|
| **read-only** | Auto-approved, no side effects | read_file, find_paths, search_text, stat_path, estimate_tokens, lsp_query |
| **workspace-write** | May require confirmation based on scope | write_file, edit_file, delete_path, move_path, make_directory |
| **external-effect** | Always requires confirmation unless pre-authorized | exec_command, fetch_url, web_search, spawn_agent |
| **user-facing** | Inherently interactive | ask_user, confirm_action |
