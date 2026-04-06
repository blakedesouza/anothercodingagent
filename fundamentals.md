# Fundamentals

## What This Is

A CLI coding agent is an interactive, stateful command-line program that assists with software development tasks through a multi-turn conversation with an LLM, directly interacting with the local development environment to read, write, and execute code.

## Core Identity (irreducible)

- **Purpose** — assists with software development tasks. This is what makes it a *coding* agent, not a generic chat tool
- **Interactive** — the user and the model take turns in a live session
- **Stateful** — the conversation accumulates context across turns (not isolated one-shot prompts)
- **Command-line** — invoked from and lives in the terminal
- **LLM-backed** — the thinking is done by an LLM via API (at minimum, Anthropic Claude)
- **Tool-using** — the LLM selects and invokes tools (read files, edit files, run commands) as part of its reasoning. Tool calls and their results are first-class conversation state — the model reasons over them, not around them. This is what makes it an *agent*, not a chat client

## Foundational Block: Pluggable Delegation

The agent can invoke any external capability AND be invoked by any external system through the same contract shape. This is bidirectional symmetry — the interface for calling out is the same shape as being called in.

### The Universal Capability Contract

Every pluggable capability — local tool, remote API, external agent, this agent itself — maps to one shape:

- **Describe** — self-declaring: what it can do, what input it accepts, what output it returns (versioned, schema-first)
- **Invoke** — structured request in, structured result out. Request carries: task, input, context, constraints, authority, deadline. Result carries: status, output, artifacts, error typing
- **Bounded** — every invocation has a timeout, explicit authority limits, and typed failure modes

### Foundational Guarantees ("graceful")

1. **Failure isolation** — a delegated capability crashing does not corrupt the agent's state or session
2. **Structured failure** — errors are typed data with status codes and recoverability flags, not process ambiguity
3. **Authority preservation** — a delegate cannot silently gain more power than the caller granted. User authority propagates through the chain
4. **Delegation as first-class state** — every invocation and its result enters the conversation history the model reasons over, same as local tool calls. Delegation is not an out-of-band side channel
5. **Lineage** — every delegation leaves a trace: what was called, what it returned, what state changed. The chain is auditable
6. **Transport-agnostic** — the contract holds whether the capability is in-process, a local subprocess (stdin/stdout), or a remote HTTP call. Transport is a binding detail below the contract

### Caller and Callee Modes

**As caller:** the agent invokes external capabilities (APIs, other agents, local scripts) through the universal contract. The LLM selects which capability to invoke and with what input.

**As callee:** the agent exposes the same contract shape so external systems (Claude Code, orchestrators, other agents) can delegate tasks to it. The agent receives a structured task, executes using its tools, and returns a structured result.

The canonical first transport binding is CLI-compatible (structured input via stdin/args, structured output via stdout). Other bindings (HTTP, IPC) can map to the same contract later.

### Capability Versioning & Schema Evolution

The contract is "versioned, schema-first" — this section defines what that means concretely.

**Two independent version tracks:**

- **Contract version** — the version of the universal wire protocol: the `describe/invoke/bounded` shape, envelope fields, status codes, error taxonomy. All capabilities share this. Changes here affect every caller and callee simultaneously
- **Schema version** — the version of a specific capability's input/output schema. Each capability evolves independently. Changes here affect only callers of that capability

Both use SemVer strings (e.g., `1.0.0`), starting at `1.0.0`. In v1, only the major number participates in compatibility decisions — minor and patch are informational, tracking additive changes and documentation fixes respectively.

**Where versions appear:**

In `describe` output (self-declaration):

| Field | Example | Meaning |
|---|---|---|
| `contract_version` | `"1.0.0"` | Wire protocol version this capability speaks |
| `schema_version` | `"1.2.0"` | This capability's input/output schema version |

In `invoke` request — the caller includes `contract_version` and the capability's `schema_version` it was built against. In the result — the callee confirms the versions it used.

**Compatibility rules (v1):**

1. `contract_version` major must match between caller and callee
2. `schema_version` major must match for the invoked capability
3. One active schema version per capability per session — no simultaneous multi-version support
4. Version mismatch is a typed error (`unsupported_version`), never an unstructured crash

Version mismatch error shape:

| Field | Value |
|---|---|
| `status` | `"error"` |
| `error.code` | `"unsupported_version"` |
| `error.retryable` | `false` |
| `error.details` | `capability_id`, `requested_contract_version`, `supported_contract_version`, `requested_schema_version`, `supported_schema_version` |

**What counts as breaking (major bump):**

- Removing or renaming a field
- Changing a field's type or semantics
- Making an optional request field required
- Narrowing accepted values
- Changing universal enums (`status`, top-level `error.code`)
- Changing authority or deadline semantics incompatibly

**What is non-breaking (minor bump):**

- New optional request fields with defined defaults
- New optional response fields
- New error types (expanding the failure taxonomy)
- Relaxed validation (e.g., longer max length)

**Schema evolution strategy — additive-only within a major:**

- New request fields must be optional and have server-side defaults
- New response fields must not be required for existing callers to function
- Callees must tolerate unknown fields in requests (ignore, do not reject)
- Callers must tolerate unknown fields in responses (ignore, do not reject)

This means: within the same major version, newer callees accept older callers, and older callers work with newer callees. No closed-world validation across minor versions.

**Negotiation protocol (v1):**

For external/dynamic capabilities: the caller calls `describe`, compares major versions, and proceeds to `invoke` only if compatible. For built-in capabilities in the same registry: compatibility is guaranteed by the build — no runtime negotiation needed.

No range negotiation in v1. If versions are incompatible, the structured error tells the caller exactly what the callee supports. The remedy is "update to match," not "negotiate a middle ground."

**Executor mode (agent as callee):**

When the agent is invoked by an external system:

- `aca describe` returns the capability descriptor including both `contract_version` and `schema_version`
- `aca invoke` reads structured input from stdin and returns structured output on stdout
- Version incompatibility returns structured JSON on stdout with a non-zero exit code

The version fields live in the JSON envelope, not in transport headers or CLI flags. This keeps the versioning transport-agnostic — the same payloads work over CLI, HTTP, or IPC.

**Relationship to event log `schema_version`:**

The event log envelope's `schema_version` tracks the event serialization format — how events are structured for observability. This is a separate concern from capability contract/schema versions and evolves on its own track (likely slower, since it is internal infrastructure).

**Deferred:**
- Range-based version negotiation (needed when third-party capabilities appear)
- Multiple simultaneous versions of the same capability (needed for smooth major-version transitions)
- Deprecation tracking and sunset warnings in `describe` output
- Version-aware capability routing (selecting among multiple providers at different versions)

### Capability Health Tracking

The universal contract guarantees failure isolation and typed errors, but the agent also needs to know whether a capability is likely to work *before* attempting an invocation — both to avoid wasting time on dead capabilities and to let the LLM choose alternatives. This section defines how capability health is detected, tracked, and surfaced.

**Core principle: reactive, not proactive.** The agent is a CLI tool with session-scoped lifecycle, not a long-running server. There are no periodic health polls, no background heartbeats, no separate `health_check` operation in the contract. Health state is derived from invocation outcomes and, for local processes, process lifecycle events.

**Why no explicit health check operation:** For stateless HTTP capabilities (search APIs, LLM APIs), a health check request has identical failure modes to the real request — it burns quota and adds latency without providing information the actual invocation wouldn't. For local session-scoped processes (LSP, browser), the process lifecycle (spawn, exit, crash) is the health signal. A runtime-internal readiness probe on first use or after crash is sufficient — it does not need to be a contract-level operation visible to callers.

**Health states:**

| State | Meaning | Transitions in |
|---|---|---|
| `unknown` | Never invoked or cached state expired | Session start; cooldown expiry for HTTP capabilities |
| `available` | Last invocation succeeded or readiness probe passed | Successful invocation; successful restart |
| `degraded` | Operational with issues — warming up, rate-limited, high latency | Retryable failure; `warming_up` response; rate limit hit |
| `unavailable` | Not expected to work for the remainder of the session (local) or until cooldown expires (HTTP) | Non-retryable error; repeated crash after restart; auth/config failure; breaker escalation |

**State tracking:** A per-session in-memory `CapabilityHealthMap` in the shared runtime layer, keyed by capability identifier (e.g., `lsp:typescript:/workspace`, `search:tavily`, `llm:anthropic`). Each entry tracks: current state, reason (e.g., `rate_limited`, `process_crashed`, `auth_invalid`, `warming_up`), consecutive failure count, last success/failure timestamps, and cooldown expiry (if applicable). The map is created at session start and discarded at session end.

**Asymmetric policies by capability kind:**

The failure/recovery model differs between local session-scoped processes and stateless HTTP services because their failure characteristics are fundamentally different.

*Local session-scoped processes (LSP servers, browser, sub-agents):*
- On first use, the runtime performs an internal readiness probe (process alive, initialization complete). This is not a contract operation — it is transport-level verification
- On process crash: restart once with brief backoff (1s for LSP, 2s for sub-agents). If the restart succeeds, mark `available`. If it fails, mark `unavailable` for the session
- Session-terminal `unavailable` means the runtime will not attempt further restarts. The capability is dead for this session. Rationale: a local process that crashes twice is genuinely broken — retrying wastes time and confuses the model
- Non-retryable errors (missing binary, init failure, resource exhaustion) go directly to session-terminal `unavailable`

*Stateless HTTP services (search APIs, LLM APIs):*
- No preflight health check — the invocation is the health check. The existing auto-retry mechanism (3 attempts, exponential backoff, for transient errors on idempotent tools) handles transient failures before health state is updated
- After auto-retry exhaustion with retryable errors: mark `degraded` and set a cooldown. Base cooldown 5s, exponential to max 60s. On cooldown expiry, state reverts to `unknown` and the next invocation is attempted normally
- After 2 consecutive final failures (post-retry): open a circuit breaker — mark `unavailable` with cooldown. Success resets the consecutive failure count and cooldown
- Non-retryable config/auth errors (`401`, invalid API key) go directly to session-terminal `unavailable` with no cooldown — these won't self-resolve

**State transition summary:**

- `unknown` -> `available`: first successful invocation or readiness probe
- `unknown` -> `degraded`: retryable failure, `warming_up`, transient network error
- `unknown` -> `unavailable`: non-retryable error, boot failure
- `available` -> `degraded`: retryable failure, rate limit, process crash with restart pending
- `available` -> `unavailable`: non-retryable error, second crash after restart
- `degraded` -> `available`: next successful invocation
- `degraded` -> `unavailable`: breaker escalation (consecutive failures), second local process crash
- `unavailable` -> `unknown`: cooldown expiry (HTTP services only; local process unavailability is session-terminal)

**LLM visibility:** Non-healthy capability states are injected into the per-turn context block (the same block that carries OS, cwd, project snapshot). Only `degraded` and `unavailable` entries appear — `unknown` and `available` are not mentioned. This costs 1-3 lines of context and lets the model choose alternatives (e.g., `search_text` instead of `lsp_query` when LSP is unavailable). The runtime still owns retry logic, cooldown enforcement, and error shaping — the model sees status, not retry mechanics.

Example context injection: `Capability status: lsp(ts)=degraded (warming_up, retry ~8s) | search:tavily=unavailable (rate_limited, cooldown 45s) | playwright=unavailable this session (browser launch failed)`

**Observability integration:** Health state changes are recorded as additional fields on existing `tool.completed` and `delegation.completed` event payloads: `health_before`, `health_after`, and `health_changed: boolean`. No new event type in v1 — health transitions are a property of invocation outcomes, not independent events.

**Interaction with existing mechanisms:**
- The LSP integration's existing "restart once with 1s backoff, then mark unavailable" and "`warming_up` as retryable error" behaviors are subsumed by this design. The LSP adapter registers with the health map instead of maintaining private crash/restart state
- The Tool Runtime Contract's auto-retry for transient network errors (3 attempts, exponential backoff) fires *before* health state is updated — health state reflects the final outcome after retries are exhausted
- The delegation tool timeout categories remain as-is. Health tracking is orthogonal to timeout enforcement

**Deferred:**
- Health-aware capability routing (selecting among multiple providers based on health)
- User-facing health dashboard or `/status` command
- Cross-session health persistence (remembering that a capability was broken last session)
- Adaptive cooldown tuning based on observed recovery patterns

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

## Foundational Decisions (locked)

| Decision | Answer | Why now |
|---|---|---|
| Single-turn vs multi-turn | **Multi-turn** | Changes the core unit from "one prompt" to "a session with accumulated state" |
| Tools as core identity | **LLM-driven tool selection** | The model decides which tools to call and when — not hardcoded scripts. Without this, it's automation, not agency |
| Tool state in conversation | **First-class** | Tool calls and results live inside the message history the model reasons over. This is structural bedrock — if wrong, everything above rewrites |
| Sync vs async tool execution | **Sync-first** | Simpler foundation with clear turn boundaries and obvious failure modes. Async patterns can layer on later without rewriting the core |
| User authority | **User has final say** | The agent proposes, the user approves destructive or ambiguous actions. The user is in charge when there's conflict |
| Delegation contract | **Universal capability shape** | One contract for all pluggable capabilities (local tools, remote APIs, external agents). Bidirectional: same shape for calling out and being called in |
| Delegation state | **First-class conversation state** | Delegation invocations/results enter the model's reasoning context, same as local tool calls |
| Delegation failure | **Isolated and typed** | External failures are contained, structured, and non-corrupting to agent state |
| Tool surface philosophy | **Small and deep** | 22 built-in tools. Workflow commands (git, test, lint) use exec_command. External integrations surface as dynamic capabilities via delegation contract |
| Tool approval | **Classified by effect** | Read-only auto-approves. Workspace writes may need confirmation. External effects always need confirmation unless pre-authorized |

## Foundational Block: Web Capabilities

### Operating Modes

Web capabilities depend on how the agent is being used:

- **Executor mode** (called by Claude Code, Codex, or another orchestrator): The orchestrator already has web search and fetch. This agent only needs **browser automation** for tasks the orchestrator delegates (e.g., "test this UI", "scrape this page", "fill this form"). Web search and fetch are unnecessary overhead.
- **Standalone mode** (user runs the agent directly): All three capabilities are useful — search, fetch, and browser.

**Design decision:** Browser automation (Playwright) is always available. Web search and web fetch are **optional modules** — available when configured, not required for core operation.

### Web Search (optional — standalone mode)

Programmatic web search via external search API. Only needed when the agent runs standalone.

**Architecture:** Provider-abstracted. Define a `SearchProvider` interface, start with one provider, normalize output.

| Provider | Free Tier | Quality | Notes |
|---|---|---|---|
| **Tavily** | 1,000/month | Excellent (AI-optimized) | Best quick-start option |
| **Serper** | 2,500/month | Excellent (Google results) | Best cheap Google-like |
| **Brave Search** | 2,000/month | Very good | Independent index, privacy-focused |
| **SearXNG** | Unlimited (self-hosted) | Good (aggregated) | Docker setup, no API key needed |

Start with one paid-tier provider (Tavily or Serper). Add SearXNG as unlimited fallback later. Avoid scraping search engines directly (fragile, ToS violations). Bing Search API was retired August 2025.

**Output shape:** `{ title, url, snippet, source }` — normalized across all providers.

### Web Fetch (optional — standalone mode)

Fetch a URL and extract clean, readable content for LLM consumption. Only needed when the agent runs standalone.

**Architecture:** Two-tier with automatic escalation.

**Tier 1 — Lightweight (default, handles ~80% of pages):**
- HTTP fetch with timeout and size cap
- Parse HTML with `jsdom`
- Extract article content with `@mozilla/readability`
- Convert to Markdown with `turndown` or `node-html-markdown`
- Fast, low memory, no browser needed

**Tier 2 — Browser fallback (SPAs, JS-heavy pages):**
- If Tier 1 extraction returns empty or too short, retry with Playwright
- Required for: SPAs (React/Vue/Angular), content behind JS rendering, infinite scroll, aggressive bot detection

**Token management:**
- Cap download size (~2-5 MB)
- Cap extracted output (~4-8k characters)
- Truncate at paragraph boundaries
- Return `{ url, title, content (markdown), excerpt, word count, estimated tokens }`

### Browser Automation (Playwright) — always available

Full browser automation for interactive/JS-heavy pages.

**Feasibility confirmed:** Playwright runs headless on WSL2 without a display server. Install Chromium only (~130-280MB).

**WSL2 requirements:**
- `npx playwright install chromium` (or `--with-deps` for system libraries)
- Launch flags: `--disable-gpu`, `--disable-dev-shm-usage`, `--no-sandbox`
- Headless mode works out of the box; headed mode needs WSLg or X server

**Agent tool surface:**
- `navigate(url)` — go to page, wait for network idle
- `click(selector)` — click element
- `type(selector, text)` — fill input
- `press(key)` — keyboard input
- `snapshot()` — compact text/DOM/accessibility snapshot (not full HTML)
- `screenshot()` — capture page as image
- `evaluate(script)` — run JavaScript on page
- `extract()` — run Readability on current page content
- `wait(selector | timeout)` — wait for condition
- `close()` — end session

**Resource model:**
- One long-lived `Browser` process per session, lazy-started on the first browser tool call
- One implicit `BrowserContext` per session (not per tool call, not per turn)
- One active `Page` inside that context
- ~100-300MB RAM per live session — this is why Playwright is escalation, not default

**Browser state persistence:** The `BrowserContext` persists across sequential browser tool calls within the same session. Cookies, localStorage, sessionStorage, and page state survive across `navigate`, `click`, `type`, `press`, `wait`, `snapshot`, `screenshot`, `extract`, and `evaluate` calls. This is essential for multi-step workflows (e.g., navigate to login page, enter credentials, submit, navigate to dashboard — the login session survives).

The model can rely on browser state persisting between tool calls. It cannot rely on state surviving: `close()`, idle timeout expiry, session end, browser crash/restart, or `/undo`/`/restore` operations.

**Browser session lifecycle:**
- **Creation** — lazy, on first browser tool call. No explicit "open" tool needed. Follows the same pattern as LSP servers: start on first use, not at session start
- **Reuse** — all subsequent browser tool calls reuse the same context and page
- **Reset** — `close()` destroys the context and page. The next browser tool call creates a fresh context (clean cookies, clean storage, new page)
- **Cleanup** — context is destroyed on any of: explicit `close()`, session end, idle timeout (1h), hard max lifetime (4h), or browser crash after failed restart. These limits align with the process registry defaults for all spawned processes
- **Crash recovery** — follows capability health tracking: restart once with 2s backoff, then mark unavailable for the session. A browser that crashes twice is genuinely broken

**Page management (v1):** Single active page enforced. If a click opens a popup or new tab, it becomes the active page automatically. No multi-page management tools in v1 — `navigate()` operates on the single active page. Multi-tab support (`list_pages`, `switch_page`) deferred until a concrete need emerges.

**State save/restore:** Not supported in v1. Browser state is ephemeral — it lives only while the context is alive. No cross-close or cross-session cookie persistence. If the model needs to inspect cookies for debugging, it can use `evaluate("document.cookie")`. Serializable state persistence is a potential v2 enhancement.

**Checkpointing interaction:** Browser state is explicitly excluded from the git-based checkpointing system. Browser tool calls carry `externalEffects: true` in undo metadata. On `/undo` or `/restore`, the active browser session is closed to prevent stale state (e.g., cookies referencing server-side sessions that no longer match the restored code state). The agent warns that browser state was not restored and a fresh browser session will be created on next use.

**Process registry integration:** The browser process registers with the shared session process registry (same infrastructure as `open_session` and LSP servers). The registry entry tracks PID, start time, last activity, idle TTL (1h), and hard max (4h). Idle timer resets on every browser tool call.

**Playwright vs Puppeteer:** Playwright is the better fit — stronger locators, auto-waiting, browser-context model. Puppeteer is lighter but only Chromium.

**Snapshot types:**
- **DOM snapshot** — compact accessibility tree / text content. Used for LLM reasoning about page structure
- **Screenshot** — PNG image capture. Used for visual inspection, UI testing, debugging

### Known Risk: Cloudflare Bot Detection

Headless Chromium gets fingerprinted and blocked by Cloudflare's bot detection (and similar WAFs). This is a known industry-wide problem.

**Potential mitigations (to investigate during implementation):**
- `playwright-extra` with stealth plugin (patches common fingerprint leaks)
- Custom user agent and viewport settings
- Proxy rotation
- Running in headed mode via WSLg when stealth matters

**Status:** Flagged for implementation-time research. Not a foundational decision, but a real operational constraint that will affect reliability.

### Design Principle: Playwright Does NOT Subsume Fetch

Using a full browser for every URL wastes ~100-300MB RAM and is 10x slower than HTTP + Readability. The lightweight tier handles most pages. Playwright is reserved for:
- JavaScript-rendered SPAs
- Interactive automation (login flows, form submission, clicking/pagination)
- Screenshots and visual inspection
- Pages where lightweight extraction fails

### Dependencies

| Package | Size | Purpose |
|---|---|---|
| `jsdom` + `@mozilla/readability` | ~15MB | HTML parsing + article extraction |
| `turndown` or `node-html-markdown` | ~1MB | HTML → Markdown |
| `playwright` (library) | ~8MB | Browser automation API |
| Chromium binary | ~130-280MB | Headless browser (installed separately) |
| Search API client | minimal | HTTP calls to search provider |

## Remaining Foundational Blocks (must define before coding)

### Block 5: Conversation State Model

The canonical data model for everything the agent tracks. All other blocks depend on this shape. Block 6 (Agent Loop) consumes these data structures directly — the two blocks are designed together.

**Core principle: the conversation log is what the LLM reasons over. The event stream (Block: Observability) is what humans debug with.** The conversation state model captures semantic content — messages, tool calls, tool results, summaries. Timing, cost, retries, and health transitions live in the event stream. The two are linked by shared IDs but serve different audiences.

**Foundational decisions:**

- **Six core types form the data model.** The nesting is: `Session` contains `Turn`s, each `Turn` contains `Step`s (one per LLM API call), each `Step` produces `ConversationItem`s. Items are the atomic unit the LLM sees. The types:

  1. **`Session`** — top-level container. Holds identity, lineage (for sub-agents), configuration snapshot, and mutable status. One session per agent instance (root or sub-agent)
  2. **`Turn`** — one user message plus all agent work until yield. Contains metadata (status, outcome, timing) and references a contiguous range of items by sequence number. Turns do not deeply nest items on disk — they reference item ranges
  3. **`Step`** — one LLM API call within a turn. A turn with 5 tool-call rounds has 5 steps. Steps track which items were sent as input and which items the LLM produced as output. Steps also record the model, provider, finish reason, and context stats (token count, compression tier). Steps are the unit the Agent Loop (Block 6) iterates over
  4. **`ConversationItem`** — the atomic unit of conversation history. Three variants:
     - `MessageItem` (role: system/user/assistant) — text content and/or tool-call parts
     - `ToolResultItem` (role: tool) — linked to a tool-call part by `toolCallId`, carries the Tool Runtime Contract output envelope
     - `SummaryItem` — replaces a range of older items when context compression fires (Block 7). Carries the summarized text plus optional pinned facts that must survive compression
  5. **`ToolCallPart`** — lives inside an assistant `MessageItem`. Contains tool name, arguments, and the provider's tool-call ID. This is what the LLM requested. The corresponding `ToolResultItem` is a separate item linked by `toolCallId`
  6. **`DelegationRecord`** — delegation invocations and results flow through the normal tool-call/tool-result pattern (spawn_agent is a tool). The `DelegationRecord` adds sub-agent lineage: child session ID, child agent ID, final status, and the parent event ID for cross-session causality. It is embedded in the `ToolResultItem` for delegation tools, not a separate item kind

- **Identity scheme: ULID-based opaque IDs with type prefixes.** All IDs are `<prefix>_<ulid>` strings. ULIDs are time-sortable and globally unique within a session. Prefixes:

  | Type | Prefix | Example |
  |---|---|---|
  | Session | `ses_` | `ses_01JQ7K...` |
  | Turn | `trn_` | `trn_01JQ7K...` |
  | Step | `stp_` | `stp_01JQ7K...` |
  | Item | `itm_` | `itm_01JQ7K...` |
  | Tool Call | `call_` | `call_01JQ7K...` |

  Session identity is never derived from path. A separate `workspaceId = wrk_<sha256(normalizedRootPath)>` links sessions to projects without encoding paths in session IDs. User-provided labels are metadata only — `ses_<ulid>` is always the primary key. Sub-agent sessions get a new `ses_<ulid>` with `parentSessionId` and `rootSessionId` for lineage traversal

- **Conversation items carry a monotonic sequence number.** Every `ConversationItem` gets a `seq: number` that increments per session. Turns reference item ranges by `[itemSeqStart, itemSeqEnd]`. This enables efficient slicing for context assembly: "give me items 1-50 for the full history" or "give me items 45-50 for recent turns only." Summary items record the `coversSeq: { start, end }` range they replace. Sequence numbers are never reused — summary items get new sequence numbers

- **Append-only canonical log, mutable in-memory projection.** The conversation log file is append-only — items and turn/step records are written once and never modified. This matches the checkpointing decision ("undo rewinds files, not history") and gives crash durability (partial writes lose at most the last item). The turn engine (Block 6) maintains a mutable in-memory projection for fast access: current turn state, pending tool calls, active step, running item count. The projection is rebuilt from the log on session resume. Mutable session-level state (status, current turn number, last activity timestamp) lives in a separate `manifest.json` that is overwritten on each turn boundary

- **Assistant messages use a parts model.** An assistant `MessageItem` contains an array of parts: `TextPart` and `ToolCallPart`. This mirrors provider API response formats (Anthropic content blocks, OpenAI tool_calls) and avoids lossy flattening. A single assistant message can contain interleaved text and tool-call requests. The provider adapter normalizes into this shape regardless of upstream format

- **Tool results carry the standard envelope.** A `ToolResultItem` includes the full `ToolOutput` envelope from the Tool Runtime Contract: `{ status, data, error, truncated, bytesReturned, retryable, timedOut, mutationState }`. For large tool outputs (approaching the 64 KiB cap), the item stores a truncated model-visible version in `data` and a `blobRef` pointing to the full payload on disk. The `blobRef` shape: `{ sha256, path, bytes, mimeType }`. This keeps the conversation log small while preserving full data for debugging

- **Serialization: JSONL per session.** One JSON object per line in `conversation.jsonl`. Each line is a typed record: session manifest snapshot, turn record, step record, or conversation item. The record type is identified by a `recordType` discriminator field. JSONL is chosen over SQLite because: it matches the event stream format, supports append-only writes naturally, is crash-friendly (partial last line is detectable and discardable), is grepable for debugging, and avoids schema migration complexity. If querying becomes a need, build a SQLite indexer on top of JSONL rather than making SQLite the canonical format

- **Storage layout: directory per session under `~/.aca/sessions/`.**

  ```
  ~/.aca/sessions/<ses_ULID>/
    manifest.json          # Session identity, config, mutable status (overwritten per turn)
    conversation.jsonl     # Append-only conversation log (items, turns, steps)
    events.jsonl           # Append-only event stream (observability)
    blobs/                 # Large tool outputs by SHA-256 hash (created on demand)
      <sha256>.bin
  ```

  Sessions are always stored globally under `~/.aca/sessions/`. The `workspaceId` in the manifest links sessions to projects. Project-local `.aca/` directories are for project configuration, not session storage. This avoids polluting project directories and simplifies `.gitignore` management. Sub-agent sessions are stored as sibling directories (not nested) — lineage is tracked via `parentSessionId`, not filesystem hierarchy

- **Session resumability from conversation log.** The `manifest.json` plus `conversation.jsonl` contain enough data to reconstruct the full in-memory state and resume an interrupted session. The event stream is not required for resumption — it is supplementary for debugging and cost accounting. Exact timing replay (reproducing the precise sequence with latencies) requires the event stream. Conversation replay (what was said, what tools were called, what results came back) requires only the conversation log

- **Turn outcome captures why the agent yielded.** Each `TurnRecord` has an `outcome` field that records the reason the turn ended. This is consumed by the Agent Loop (Block 6) for display and by future analytics:

  | Outcome | Meaning |
  |---|---|
  | `assistant_final` | Assistant produced a text response with no pending tool calls |
  | `awaiting_user` | Assistant explicitly asked the user a question |
  | `approval_required` | A tool or action needed user confirmation |
  | `max_steps` | Step limit per turn was reached |
  | `max_consecutive_tools` | Consecutive autonomous tool steps limit reached |
  | `tool_error` | Non-retryable tool error forced a yield |
  | `cancelled` | User interrupted (SIGINT) |
  | `aborted` | Session-level abort |
  | `budget_exceeded` | Cost budget for session or daily limit was reached (Block 19) |

**Deferred:**
- Conversation branching / forking on undo
- Cross-session conversation continuity (resuming a session in a new terminal)
- Named/tagged session bookmarks
- Session search and querying beyond grep
- Rich attachment support (images, binary files as conversation items)
- Conversation export formats (markdown, HTML)

### Block 6: Agent Loop / Turn Engine

The core execution cycle that ties everything together. This block consumes Block 5's data structures (Session, Turn, Step, ConversationItem) and orchestrates the flow from user input through LLM calls, tool execution, and back to user output. The event stream (Block: Observability) is emitted as a side effect at each phase transition.

**Core principle: the loop is a step machine inside a turn boundary.** A turn starts when the user (or parent agent) provides input and ends when the agent yields back. Within a turn, the loop executes steps — each step is one LLM API call plus the resulting tool executions. The loop continues stepping until a yield condition is met.

**Foundational decisions:**

- **Twelve phases per step, with explicit phase transitions.** Each step passes through these phases in order. Phase transitions emit events to the observability stream and update the in-memory projection. The phases:

  1. **`OpenTurn`** — create `TurnRecord`, set status to `running`, emit `turn.started` event. Only runs on the first step of a turn
  2. **`AppendUserMessage`** — create a `MessageItem` (role: user) from the input and append to the conversation log. Only runs on the first step
  3. **`AssembleContext`** — build the LLM API request from the 4-layer system prompt assembly: system parameter, tool definitions, per-turn context block, and conversation history. Select which `ConversationItem`s to include based on context budget. Emit `context.assembled` event with token stats and compression tier. If context pressure exceeds thresholds (60/80/90%), apply the compression strategy defined in System Prompt Assembly
  4. **`CreateStep`** — create a `StepRecord` with the assembled context stats (token count, token limit, compression tier, system prompt fingerprint). Record which item IDs were sent as input
  5. **`CallLLM`** — send the assembled request to the LLM provider. Stream tokens to the terminal for real-time display (see streaming decision below). Emit `llm.request` event before the call. This phase is interruptible by SIGINT
  6. **`NormalizeResponse`** — when the provider stream completes, normalize the response into the canonical parts model: `TextPart[]` and `ToolCallPart[]`. Different providers return different formats (Anthropic content blocks, OpenAI tool_calls) — the provider adapter normalizes here. Emit `llm.response` event with token usage and finish reason
  7. **`AppendAssistantMessage`** — create a `MessageItem` (role: assistant) with the normalized parts and append to the conversation log. Update the step record with the output message ID
  8. **`CheckYieldConditions`** — if the response contains only text and no tool calls, proceed to `YieldToUser`. If the response contains tool calls, check yield conditions (step limits, consecutive tool limits, approval requirements) before proceeding to tool execution. If a yield condition is met, proceed to `YieldToUser` with the appropriate outcome
  9. **`ValidateToolCalls`** — validate each `ToolCallPart` against the tool's JSON Schema. Validation failures become synthetic `ToolResultItem`s with `ValidationError` status — they are not retried by the engine (the model must issue a corrected call on the next step)
  10. **`ExecuteToolCalls`** — execute validated tool calls through the Tool Runtime Contract. Execute sequentially in emitted order within a single step. Emit `tool.invoked` and `tool.completed` events per call. If a tool requires user confirmation (approval class), the loop yields with `approval_required` outcome — the tool is not executed until the user approves
  11. **`AppendToolResults`** — create a `ToolResultItem` per completed tool call and append to the conversation log. Link each result to its `ToolCallPart` by `toolCallId`. For large results, store the full payload as a blob and keep a truncated version in the item
  12. **`LoopOrYield`** — if more tool results need processing (the model needs to see them), loop back to `AssembleContext` for the next step. If a yield condition was deferred, yield now. Otherwise, continue the step loop

  For the first step of a turn, phases 1-2 run before phases 3-12. For subsequent steps (tool result follow-ups), the loop enters at phase 3 directly.

- **Multi-tool-call responses: execute sequentially, loop once.** When the LLM requests multiple tool calls in a single response (multiple `ToolCallPart`s in one assistant message), all calls are executed sequentially in the order they appear in the response during a single `ExecuteToolCalls` phase. All results are appended before the next LLM call. Sequential execution is the v1 default because: it avoids race conditions between tools that might interact (read then edit), it simplifies error handling (a failed tool doesn't need to cancel siblings), and it matches the sync-first execution model. Parallel execution of read-only tools is a future optimization, not a v1 feature

- **Step and turn limits prevent runaway loops.** Limits are enforced at `CheckYieldConditions` (phase 8) and checked again at `LoopOrYield` (phase 12). All limits are configurable via agent profile and CLI flags:

  | Limit | Default (interactive) | Default (sub-agent/one-shot) | Rationale |
  |---|---|---|---|
  | **Max steps per turn** | 25 | 30 | One step = one LLM call. 25 allows complex multi-file edits. Sub-agents get slightly more since they run unsupervised within a scoped task |
  | **Max consecutive autonomous tool steps** | 10 | No separate limit | In interactive mode, after 10 steps with only tool calls and no text output to the user, the loop yields with `max_consecutive_tools` outcome and a progress summary. This prevents the agent from silently churning. Sub-agents are expected to work autonomously within their step budget |
  | **Soft progress notice** | At step 8 | N/A | In interactive mode, after 8 steps the agent injects a brief status line to stderr (not a conversation message) showing what it's working on. Keeps the user informed during long autonomous stretches |
  | **Max tool calls per assistant message** | 10 | 10 | If the LLM returns more than 10 tool calls in a single response, execute only the first 10 and inform the model that remaining calls were deferred. This caps per-step work |
  | **No hard per-session turn limit** | None | N/A | Sessions can have hundreds of turns. Cost control is handled by budget limits (deferred to Block 9), not turn caps. Soft warning at 200 turns |

- **SIGINT handling: two-tier, phase-aware.** The handler tracks the current phase and applies the appropriate cancellation:

  **First SIGINT — cancel active operation:**
  - During `CallLLM` (streaming): abort the HTTP request. Discard the partial response — do not persist incomplete assistant messages as canonical conversation items. Record the interruption in the event stream. The turn continues at phase 8 (`CheckYieldConditions`) with `cancelled` outcome
  - During `ExecuteToolCalls`: send cancellation signal to the active tool through the Tool Runtime Contract's graceful signal → 2s grace → force kill sequence. The tool result carries `status: "error"` with `code: "cancelled"`. Remaining tool calls in the batch are skipped. The turn yields with `cancelled` outcome
  - During `AssembleContext` or `NormalizeResponse`: cancel immediately (these are CPU-bound and fast). Yield with `cancelled` outcome
  - During user interaction (`ask_user`, `confirm_action`): cancel the prompt and yield

  **Second SIGINT within 2 seconds of the first (or while cancellation is in progress):** abort the entire turn immediately. Set turn status to `aborted`. Save session state (manifest + any items already appended). Return to the input prompt (interactive mode) or exit with code 2 (one-shot/executor mode)

  Double-SIGINT within 500ms is treated as a hard exit request — the process exits after saving the manifest. This matches common CLI conventions (Ctrl+C twice to force quit)

  SIGINT during `AppendUserMessage`, `AppendAssistantMessage`, or `AppendToolResults` is deferred until the write completes — these are fast I/O operations and interrupting mid-write would corrupt the log

- **Yield-to-user rules define when autonomous execution stops.** The agent yields (returns control to the user in interactive mode, or completes in one-shot/executor mode) when any of these conditions is true:

  1. **Text response with no tool calls** — the assistant produced a final answer. This is the normal yield
  2. **Approval required** — a tool call's approval class requires user confirmation. The loop pauses at `CheckYieldConditions`, presents the confirmation prompt, and resumes or aborts based on the user's response. In sub-agent mode, this becomes an `approval_required` return to the parent (sub-agents never prompt the user directly, per delegation design)
  3. **Non-retryable tool error** — a tool failed with `retryable: false`. The agent yields with the error in context so the user can decide how to proceed. Retryable errors are handled by the Tool Runtime Contract's auto-retry (3 attempts) before reaching the conversation state
  4. **Indeterminate mutation state** — a tool returned `mutationState: "indeterminate"`. The agent yields to inform the user that filesystem state may be inconsistent
  5. **Step limit reached** — `maxStepsPerTurn` exceeded. The agent yields with a summary of what was accomplished and what remains
  6. **Consecutive tool step limit** — `maxConsecutiveAutonomousToolSteps` exceeded in interactive mode. The agent yields with a progress update
  7. **User interruption** — SIGINT received
  8. **The agent does NOT yield on "uncertainty."** There is no engine-level confidence threshold or uncertainty detector. If the model is uncertain, it should use the `ask_user` tool explicitly — this is a model behavior, not an engine policy. The engine yields when `ask_user` is invoked (it is an inherently interactive tool), which achieves the same result without a fragile heuristic

- **Tool result to message conversion preserves the standard envelope.** When a tool completes, its `ToolOutput` envelope from the Tool Runtime Contract is stored as the `output` field of a `ToolResultItem`. The conversion to LLM-visible message format:

  1. The `ToolResultItem` becomes a message with `role: "tool"` in the provider's format
  2. The `toolCallId` links it to the corresponding `ToolCallPart` in the preceding assistant message
  3. The message content is a JSON serialization of the essential fields: `{ status, data, error, truncated }`. The `bytesReturned`, `retryable`, `timedOut`, and `mutationState` fields are included only when they carry non-default values (non-zero bytes, true flags). This keeps tool result messages concise while preserving all decision-relevant information
  4. For large tool outputs: if `data` exceeds 32 KiB when serialized, the model-visible version is truncated with a note indicating total size and how to retrieve more (e.g., "Output truncated. Use read_file with line ranges to see the full content"). The full payload is stored via `blobRef`
  5. Error results include the full error object (`code`, `message`, `retryable`, `details`) so the model can reason about whether to retry, fall back, or ask the user

  The provider adapter handles format differences: Anthropic expects `tool_result` content blocks with `tool_use_id`, OpenAI expects tool messages with `tool_call_id`. The canonical `ToolResultItem` is provider-agnostic; the adapter translates at `AssembleContext` time

- **Streaming: display tokens as they arrive, buffer for state.** The LLM API call uses streaming when available. Behavior during streaming:

  1. **Text tokens** are written to stdout as they arrive, giving the user real-time feedback. The full text is simultaneously buffered in memory
  2. **Tool-call tokens** (tool name, arguments being generated) are displayed as a compact progress indicator on stderr (e.g., `[calling: edit_file...]`), not streamed verbatim to stdout. Tool call arguments may be partial/invalid mid-stream
  3. **Tool calls are never executed mid-stream.** The engine waits for the provider to signal response completion (`stop_reason`/`finish_reason`) before parsing tool calls and entering `ValidateToolCalls`. This prevents executing on malformed partial JSON arguments
  4. **Partial responses on interruption** are discarded from conversation state (not appended as items). The event stream records that a streaming response was interrupted, including how many tokens were received before cancellation
  5. **Provider differences** are handled in the adapter layer. Some providers stream content blocks incrementally (Anthropic), others stream token deltas (OpenAI). The adapter normalizes into a unified token stream with block-type annotations

- **The turn engine exposes a minimal interface to the rest of the system.** Block 6 is consumed by the CLI interface (Block 10) and the delegation system. The interface:

  - `executeTurn(session, input)` — main entry point. Runs the step loop until yield. Returns the completed `TurnRecord` with outcome
  - `interrupt(level)` — signal cancellation. Two levels: `cancel_operation` and `abort_turn`
  - `getPhase()` — current phase for status display and event rendering

  The turn engine does not manage session lifecycle (creation, loading, saving) — that belongs to the session manager built on Block 5's data model. The turn engine receives a live session and appends to it.

**Deferred:**
- Parallel tool execution for read-only tools
- Adaptive step limits based on task complexity
- Turn resumption after interruption (resume from last completed step)
- Background/detached turn execution
- Per-step timeout (distinct from per-tool timeout)
- Streaming tool output into model context (currently tools buffer to completion)
- Step-level branching (re-running a step with different tool results)

### Block 7: Context Window Management

Every LLM API call is stateless and bounded by a context window. This block defines the mechanics of how conversation history is measured, compressed, and assembled into each request so the agent can sustain arbitrarily long sessions without exceeding the model's limits. It operationalizes the compression tiers defined in System Prompt Assembly, consumes Block 5's conversation data model, and integrates with Block 6's `AssembleContext` phase.

**Core principle: context management is lazy and turn-aligned.** Summaries are not precomputed speculatively. Compression fires only when a real API request is about to exceed budget, and only for the oldest contiguous prefix of completed turns. This keeps the common case (conversation fits) zero-cost and concentrates complexity in the compression path.

**Foundational decisions:**

- **Token counting is a two-stage hybrid: local estimate before the API call, provider-reported count after.** Local estimation is required because the agent must decide what to include *before* sending the request — the API cannot tell us the count of a request we have not yet sent. Provider-reported counts are ground truth for calibration and cost accounting.

  The local estimator operates on the fully serialized request content (not message text alone) using a byte-based heuristic: `ceil(utf8ByteLength / 3)` per text block, plus fixed structural overheads: `+12` per message envelope, `+24` per tool call/result item, `+40` per tool schema definition. This formula is deliberately pessimistic (overestimates) to avoid context-length rejections.

  A per-model calibration multiplier corrects the heuristic over time. After each API call, the agent records the provider-reported `input_tokens` and updates an exponential moving average (EMA) of the ratio `actual / estimated`. The multiplier starts at `1.0` and converges within 3-5 calls. If no provider token count is available (some providers omit it), the multiplier stays at `1.0` and the base heuristic carries the load.

  The safe input budget for each request is: `safeInputBudget = contextLimit - reservedOutputTokens - estimationGuard`, where `estimationGuard = max(512, ceil(contextLimit * 0.08))`. The 8% guard absorbs estimation error. `reservedOutputTokens` is the `max_tokens` parameter for the response (default: 4096). If the provider rejects a request for context length despite the guard, the agent escalates one compression tier and retries once with an additional 10% guard.

  The estimator is a pure function with no external dependencies — no `tiktoken`, no WASM tokenizers, no per-model tokenizer binaries. This keeps the agent lightweight and provider-agnostic. The calibration EMA is the mechanism for per-model accuracy. Calibration state is stored in the session `manifest.json` and does not need to survive across sessions (it re-converges quickly).

- **Summarization uses the same LLM provider as the active agent, with a structured prompt and strict budget.** The summarizer is not a separate service or a cheaper model — it makes a standard LLM API call through the same provider adapter the agent already uses. This is the simplest correct v1: no additional API keys, no model selection logic, no second provider to configure or fail.

  Summarization is invoked only during `AssembleContext` (Block 6 phase 3), only when the compression tier is `medium` or worse, and only for the oldest contiguous prefix of completed turns that are not already covered by an existing `SummaryItem`. The summarizer never touches the current turn or its tool-call/tool-result chain.

  The summarization prompt requests structured JSON output: `{ "summaryText": "...", "pinnedFacts": ["..."], "durableStatePatch": {...} }`. The prompt rules: include only confirmed facts, decisions made, files touched with what changed, errors encountered and how they were resolved, user preferences expressed, and unresolved problems. No speculation, no commentary, no narrative filler.

  Granularity is chunk-based: summarize up to 12 completed turns or 20K estimated tokens per summarization call, whichever is smaller. If the unsummarized prefix is larger, summarize in sequential chunks (oldest first) until context pressure drops below the target tier or the prefix is fully covered. Each chunk becomes one `SummaryItem`.

  Token budget for summarization: the summarization call itself (prompt + response) must cost less than 40% of the tokens it saves. If a chunk would violate this ratio (too few turns, too little savings), skip LLM summarization and use the deterministic fallback: retain the first and last items of the range verbatim, extract a digest of tool calls (tool name + status + key output lines), and discard assistant filler text. This fallback produces a `SummaryItem` without an LLM call.

  An optional `compressionModel` configuration field allows overriding the summarization model in future versions (e.g., using a cheaper model for compression). In v1 this field is accepted but ignored — the active model is always used.

- **`SummaryItem` creation happens inside `AssembleContext` and integrates with Block 5's append-only log and in-memory projection.** When compression fires, the summarizer produces a `SummaryItem` that is appended to `conversation.jsonl` as a new record with a new sequence number. The original items it covers are never modified or deleted on disk — the log remains append-only.

  The in-memory projection maintains a `coverageMap: Map<itemSeq, summarySeq>` that tracks which original items are covered by which summary. The projection exposes a `visibleHistory()` method that returns items in sequence order, skipping any original item whose sequence number appears in the coverage map and including the `SummaryItem` in its place. If a newer summary covers a range that includes an older summary's range, the older summary is also skipped — only the newest applicable summary for any given sequence range is visible.

  Originals are always recoverable from disk. The `visibleHistory()` view is what `AssembleContext` uses to build the API request. Display/UI code can use the full item list with coverage annotations to show the user what was summarized.

  On session resume (rebuilding the projection from `conversation.jsonl`), the coverage map is reconstructed by scanning all `SummaryItem` records and their `coversSeq` ranges. This is O(n) in the number of items and runs once at session load.

- **Context assembly follows a budget-first, newest-first packing algorithm.** The algorithm runs every step (every LLM API call) during `AssembleContext`. It produces the final request payload and determines the compression tier. Steps:

  1. **Compute safe input budget** — `contextLimit - reservedOutputTokens - estimationGuard`, applying the per-model calibration multiplier

  2. **Build pinned sections** — these are never compressed and always included:
     - Core system rules (from the `system` parameter layer)
     - Tool signatures (all enabled tools, every turn — prompt caching makes repetition near-free)
     - Current user message (the message that triggered this turn)
     - Resolved instruction summary (repo/user instruction files)
     - Active errors (non-retryable errors the model needs to address)
     - Durable task state (compact rendering, ~80-150 tokens)
     - Current-turn tool-call/tool-result chain (all items from the current turn — these are required for protocol correctness, as the model must see its own tool calls and their results)

  3. **Estimate full uncompressed request** — sum pinned sections + per-turn context block + all visible history items (from `visibleHistory()`). Determine the compression tier from the ratio `estimatedTotal / contextLimit`:
     - `< 60%` → tier `full`
     - `60-80%` → tier `medium`
     - `80-90%` → tier `aggressive`
     - `> 90%` → tier `emergency`

  4. **Apply tier-specific compression** (detailed in the next decision) — modify per-turn context block, tool descriptions, instruction detail, and conversation history according to the tier. If tier is `medium` or worse, ensure a `SummaryItem` exists for the oldest compressible prefix.

  5. **Pack history newest-first by turn boundary** — starting from the most recent completed turn, add turns verbatim until the budget is exhausted. Then include any available `SummaryItem`s for the remaining older prefix. Stop when the budget is full. Within a turn, all items are included or none (no partial turns except the current turn, which is always fully included as a pinned section).

  6. **Verify fit** — re-estimate the assembled request. If it still exceeds `safeInputBudget`, escalate one tier and re-run steps 4-5. If already at `emergency` tier, include only pinned sections and emit a `context.assembled` event with `warning: "emergency_compression"`.

  7. **Emit `context.assembled` event** — record `estimatedTokens`, `safeInputBudget`, `tier`, `summaryCreated` (boolean), `coveredSeqRange` (if summary was created), `historyItemCount`, `droppedItemCount`.

- **Tier actions operationalize the compression thresholds defined in System Prompt Assembly.** Each tier applies cumulative actions (higher tiers include all lower-tier actions plus additional compression). The actions follow the defined compression order: older conversation first, then project detail, then tool description verbosity, then instruction detail.

  **Tier `full` (< 60%):**
  - All visible history included verbatim
  - Full per-turn context block (OS, shell, cwd, project snapshot, working set, capability health)
  - Full tool descriptions (descriptions + parameter details + examples)
  - Full resolved instruction summary

  **Tier `medium` (60-80%):**
  - *Conversation:* Summarize oldest completed-turn prefix. Keep current turn + last 4-6 completed turns verbatim. Everything older is represented by `SummaryItem`s
  - *Project detail:* Trim per-turn context block — reduce project snapshot to root directory, stack detection line, git branch/status line, and active file paths only (no directory tree)
  - Tool descriptions and instruction detail unchanged

  **Tier `aggressive` (80-90%):**
  - *Conversation:* Summarize everything older than the last 2-3 completed turns. If existing summaries are still too large, re-summarize them into a single shorter summary (summary-of-summaries)
  - *Project detail:* Per-turn context block becomes minimal — cwd, stack one-liner, git branch only. No directory listing, no file details
  - *Tool descriptions:* Switch to short-form tool descriptions — name + one-line purpose + parameter names only (no parameter descriptions, no examples). Tool signatures (the JSON Schema used for validation) remain unchanged and are always sent in full via the provider's tool mechanism
  - Instruction detail unchanged (this is the last thing compressed before emergency)

  **Tier `emergency` (> 90%):**
  - *Conversation:* Drop all historical summaries. Only the current-turn chain survives (pinned). If the current-turn chain alone exceeds budget, truncate older tool results within the current turn to their digest form (see large tool result handling below)
  - *Project detail:* Dropped entirely
  - *Tool descriptions:* Signatures only, no descriptions
  - *Instruction detail:* Core rules only (identity + safety rules). Resolved instruction summary dropped
  - Emit warning to user via stderr: "Context limit reached — operating with minimal history. Consider starting a new session or breaking the task into smaller pieces."

- **The working set (active files) is tracked by a `FileActivityIndex` derived from tool call history.** The index is an in-memory map from file path to an activity score, persisted in `manifest.json` across turns. It is updated deterministically from tool call results — no LLM call needed.

  Activity sources and weights: `edit_file`/`write_file` = +30, `delete_path`/`move_path` = +35 (high because the model needs to know about structural changes), `read_file` = +10, `search_text` match in file = +5, user message path mention = +25, open-loop reference (from durable task state) = +20. Decay: subtract `5 * turnsSinceLastTouch` per turn. Files drop from the working set after 8 inactive turns unless referenced by an active open loop in durable task state.

  The per-turn context block includes the top 5 files by score, rendered as path + role only (e.g., `Active files: src/agent.ts (editing), src/types.ts (reading), test/agent.test.ts (editing)`). File *content* is never auto-injected — the model reads files via `read_file` when it needs them. The working set tells the model *which* files are relevant, not *what* they contain.

  The index is rebuilt from the conversation log on session resume by replaying tool-call items.

- **Durable task state is a structured object stored outside the conversation items, in the session `manifest.json`.** It is not a `ConversationItem` — it is session-level metadata that survives conversation summarization because it is never part of the conversation history that gets compressed.

  Shape:

  | Field | Type | Purpose |
  |---|---|---|
  | `goal` | `string \| null` | Current high-level task. Set from first user message, updated on explicit goal changes |
  | `constraints` | `string[]` | User-stated constraints ("don't modify package.json", "use vitest not jest") |
  | `confirmedFacts` | `string[]` | Facts confirmed by user or verified by tools (e.g., "project uses pnpm", "auth module is in src/auth/") |
  | `decisions` | `string[]` | Design decisions made during the session ("using factory pattern for providers") |
  | `openLoops` | `Array<{ id, text, status, files }>` | Unresolved issues, pending tasks, things to come back to. Status: `open`, `blocked`, `waiting_user`, `done` |
  | `blockers` | `string[]` | Active blockers preventing progress |
  | `filesOfInterest` | `string[]` | Files the agent should be aware of (feeds working set scoring) |
  | `revision` | `number` | Monotonic version counter |
  | `stale` | `boolean` | True if the LLM patch call failed and state may be outdated |

  **Update mechanics:** Durable task state is updated at turn end (after the turn yields), not every step. The update is a two-phase reducer:
  1. **Deterministic updates from runtime facts** — files modified this turn (from tool call items), tool errors encountered, approvals pending, explicit file mentions in user message. These updates are pure data extraction, no LLM needed
  2. **Optional LLM patch call** — a small LLM call that receives the current durable state plus the current turn's items (user message + assistant messages + tool summaries) and returns a JSON patch: which facts to add, which open loops to update, whether the goal changed. This call uses the same provider as the agent. Its prompt + response must fit in ~4K tokens. If the call fails or times out, the deterministic updates still apply and `stale` is set to `true`. The agent never blocks a turn on durable state refresh

  The LLM-visible rendering of durable task state is injected as part of the pinned sections in every request, targeting ~80-150 tokens. It includes: goal (1 line), active blockers (if any), open loops with `open` or `blocked` status (up to 5), and the 3 most recent confirmed facts. The full state is available in `manifest.json` for debugging.

  When summarization fires, the summarization prompt includes the current durable task state as context so the summarizer knows what facts are already captured and does not need to repeat them in the summary text. The `durableStatePatch` field in the summarizer's structured output allows the summarizer to propose state updates (e.g., marking an open loop as `done` if the summarized conversation resolved it).

- **Large tool results receive tier-dependent compression with three rendering modes.** A single tool result can approach 64 KiB (the Tool Runtime Contract cap), which is roughly 10-15K tokens — a significant fraction of a 32K-token model's context. These results need special treatment beyond the standard conversation summarization path.

  Tool results are rendered in three modes during context assembly:

  | Mode | When used | Content |
  |---|---|---|
  | `full` | Current turn, tier `full`/`medium` | The complete model-visible payload from the `ToolResultItem` (already truncated to 32 KiB per Block 6 phase 11) |
  | `truncated` | Recent turns, tier `medium`/`aggressive` | The existing truncated payload as stored in the item |
  | `digest` | Older turns, tier `aggressive`/`emergency`, or when a single result dominates the budget | A compact, deterministic summary computed without an LLM call |

  Digest computation is tool-specific:
  - `read_file` → file path, line range, total lines, `[content omitted — use read_file to re-read]`
  - `exec_command` → command, exit code, stderr headline (first error line), bytes omitted count
  - `search_text`/`find_paths` → query/pattern, match count, top 3 match paths
  - `lsp_query` → operation, target, result count, first result summary
  - All other tools → tool name, status, data size, `[result omitted]`

  Digests are computed deterministically from the `ToolResultItem` fields — no LLM call, no disk read. They are typically 50-150 tokens regardless of original result size. The digest is not persisted as a separate item — it is a rendering choice made during `AssembleContext`.

  During context assembly, the packing algorithm (step 5) checks whether any single item in a verbatim turn exceeds 25% of the remaining budget. If so, that item is downgraded to `truncated` or `digest` mode even though the turn would otherwise be included verbatim. This prevents a single large tool result from crowding out multiple turns of useful history.

- **The context management system is provider-agnostic across model context sizes from 32K to 200K tokens.** The `contextLimit` for each model is stored in the provider configuration and read at session start. All thresholds are percentages of this limit, not absolute token counts, so the same logic works for a 32K model (where 60% is ~19K tokens) and a 200K model (where 60% is ~120K tokens).

  The main behavioral difference across context sizes: small-context models (32K-64K) will hit compression tiers more frequently, potentially every few turns in a tool-heavy session. Large-context models (128K-200K) may run entire sessions without compression. The compression machinery must be efficient enough to run every step without noticeable latency when no compression is needed (the common case for large-context models) and correct enough to maintain coherent conversation when compression fires frequently (the common case for small-context models).

  The summarization LLM call is the only potentially slow operation. On a 32K model where compression fires frequently, each summarization call adds one LLM round-trip (~1-5 seconds) to the step. This is acceptable because: summarization only fires when new turns push past the threshold (not on every step within a turn), the chunk size is bounded (12 turns or 20K tokens max), and the fallback is available if the call fails or would be too expensive.

**Integration with other blocks:**

- **Block 5 (Conversation State Model):** `SummaryItem` is appended to `conversation.jsonl`. The `coversSeq` range links summaries to original items. The `FileActivityIndex` and `DurableTaskState` are persisted in `manifest.json`. On session resume, the in-memory projection (coverage map, visible history, working set scores) is rebuilt from the log
- **Block 6 (Agent Loop):** Context management runs entirely within `AssembleContext` (phase 3). No other phase is modified. The `context.assembled` event carries all compression metadata. If summarization fires, the LLM call happens synchronously within phase 3 before the main LLM call in phase 5 (`CallLLM`)
- **System Prompt Assembly:** Block 7 implements the compression tiers and compression order defined there. The tier thresholds (60/80/90%) and the "never compress" list (core rules, tool signatures, current message, errors) are authoritative from System Prompt Assembly — Block 7 adds the instruction summary and durable task state to the pinned set and defines the mechanical actions at each tier
- **Observability:** The `context.assembled` event records `estimatedTokens`, `safeInputBudget`, `tier`, `summaryCreated`, `coveredSeqRange`, `calibrationMultiplier`, `historyItemCount`, `droppedItemCount`. Post-call, the provider-reported `input_tokens` from the `llm.response` event feeds back into the calibration EMA
- **Tool Runtime Contract:** The 64 KiB output cap and the 32 KiB model-visible truncation (Block 6 phase 11) are upstream constraints. Block 7's digest rendering provides additional compression for older tool results during context assembly

**Deferred:**
- Per-model tokenizer integration (tiktoken, sentencepiece) for higher-accuracy estimation
- Background/async summarization (summarize during user think time)
- Summary quality evaluation (detecting when a summary lost critical information)
- Adaptive compression thresholds (tuning percentages based on observed session patterns)
- Cross-session summary persistence (starting a new session with a summary of the previous one)
- Token budget visualization for the user (showing how context is allocated)
- Compression model selection (using a cheaper model for summarization calls)
- Summary-of-summaries optimization (dedicated prompt for re-summarizing existing summaries)

### Block 8: Permission / Sandbox Model

Safety boundaries that cut across all tools and delegation. The agent may operate on untrusted repositories cloned from GitHub — a malicious `.aca/config.json` in a repo must not be able to auto-approve destructive commands, exfiltrate data, or escape the workspace. This block defines the enforcement layer; Block 9 defines where the policy settings live and how they are loaded.

**Core principle: compute effective authority per tool call, not per session.** Every tool invocation is evaluated against a runtime-resolved `EffectiveAuthority` that combines: agent profile tool permissions (intersection), inherited parent authority (for sub-agents), trusted config policy (from Block 9), and session grants (runtime approvals that persist within a session). The evaluation order for each tool call is: profile check, sandbox/resource check, risk analysis, pre-authorization/session grant match, then `allow | confirm | deny`.

**Foundational decisions:**

- **Workspace root enforcement is hard, not advisory.** All built-in file-system tools (`read_file`, `write_file`, `edit_file`, `delete_path`, `move_path`, `make_directory`, `stat_path`, `find_paths`, `search_text`) and `lsp_query` resolve paths to their canonical absolute form via `fs.realpath` before any operation. Access is denied unless the resolved path falls within an allowed zone. This is enforced in the Tool Runtime Contract layer — individual tool implementations never see paths outside allowed zones.

  **Allowed zones:**

  | Zone | Read | Write | Rationale |
  |---|---|---|---|
  | `workspaceRoot` and all descendants | yes | yes | Primary work area. Detected via Project Awareness (Block: Project Awareness) |
  | `~/.aca/sessions/<current_ses_ULID>/` | yes | yes | Current session's own data (scratch files, blobs) |
  | `/tmp/aca-<ses_ULID>/` | yes | yes | Scoped temporary directory, created on demand, cleaned on session end. Tools needing `/tmp` are redirected here — not bare `/tmp` |
  | User-configured `extraTrustedRoots` | yes | yes | Absolute paths the user explicitly trusts (e.g., a locally-linked package outside the project tree). User config only — project config cannot add these (Block 9) |

  **Everything else is denied**, including `~/.config`, `~/.ssh`, `~/.bashrc`, `/etc`, other users' home directories, and bare `/tmp`. The agent's own internal data at `~/.aca/` (outside the current session directory) is not accessible to tools — the runtime reads it directly, tools do not.

  **Symlink handling:** Symlinks within the workspace that resolve to a target outside all allowed zones are denied. The error message reports the symlink path and its resolved target so the user understands why. If a project has symlinks pointing to external paths (e.g., `node_modules` linking to a local package via `npm link`), the user adds the target to `extraTrustedRoots` in their user config. There is no "follow symlinks" toggle — resolution always happens, and the resolved path is always checked. This prevents escape-via-symlink attacks from untrusted repos.

  **Path traversal:** `../` sequences are collapsed by `fs.realpath` before the zone check. A tool call to `read_file("../../etc/passwd")` resolves to `/etc/passwd`, which is outside all zones, and is denied.

  **`exec_command` is NOT workspace-sandboxed at the filesystem level.** Shell commands run as the user's process and can access anything the user can. Filesystem sandboxing of arbitrary binaries would require OS-level isolation (containers, namespaces) that is out of scope for v1. `exec_command` is sandboxed by its approval class (`external-effect`) and the command risk analyzer described below. This is an explicit trade-off: built-in tools are hard-sandboxed, shell execution is policy-sandboxed.

- **Dangerous command detection uses a multi-tier `CommandRiskAnalyzer`, not a simple blocklist.** The analyzer runs on every `exec_command`, `open_session`, and `session_io` invocation before execution. It extracts a best-effort `argv[0]`, scans the raw shell text with pattern matching, and emits a structured risk assessment.

  **Three risk tiers:**

  | Tier | Behavior | Examples |
  |---|---|---|
  | `forbidden` | Hard deny. Never executed, even with `--no-confirm`. Not overridable by config | `rm -rf /`, `rm -rf ~`, writes to `/dev/sd*` or `/dev/nvme*`, `mkfs.*`, fork bombs (`:(){:|:&};:`), `dd if=* of=/dev/[sh]d*` |
  | `high` | Requires explicit user confirmation. `--no-confirm` can override (user assumes full risk). Pre-authorization rules can auto-approve specific patterns | `curl ... \| bash`, `wget -O- \| sh`, `sudo *`, `git push --force`, `git reset --hard`, `git clean -fdx`, `chmod -R 777`, `chmod` on paths outside workspace, writes to `~/.ssh/*`, `~/.bashrc`, `~/.gitconfig`, `npm install -g`, `pip install` without `--prefix`, `docker run -v /:/host` |
  | `normal` | Standard `external-effect` approval class. Auto-approvable via pre-authorization rules | `npm test`, `git status`, `ls`, `cat`, `python script.py`, `cargo build` |

  **Risk facets (not just binary risk):** The analyzer tags each command with zero or more facets: `filesystem_delete`, `filesystem_recursive`, `network_download`, `pipe_to_shell`, `privilege_escalation`, `credential_touch`, `global_config_write`, `history_rewrite`, `package_install`. Facets are informational — they feed into the confirmation prompt to explain *why* the command is flagged, and into the event log for audit. The risk tier is derived from which facets are present and their combination.

  **Context awareness:** The same command can have different risk depending on context:
  - `rm -rf node_modules` with cwd inside the workspace is `normal` (cleanup)
  - `rm -rf node_modules` with cwd at `/` is `high` (wrong directory)
  - `rm -rf /` is always `forbidden` regardless of cwd
  - `git push` is `normal`; `git push --force` is `high`
  - `curl https://example.com` is `normal`; `curl https://example.com | bash` is `high`

  The analyzer checks the cwd against the workspace root as part of its assessment. Commands that operate on paths outside the workspace are elevated one tier.

  **False positive mitigation:** The analyzer does not use entropy heuristics or fuzzy matching. Patterns are specific and tested. A command like `rm -rf ./build` inside the workspace matches the `filesystem_delete` + `filesystem_recursive` facets but resolves to `normal` tier because the target is within the workspace. Users who find a legitimate command incorrectly flagged can add a pre-authorization rule in their user config (Block 9). Project config cannot add pre-authorization rules.

  **Implementation:** The analyzer is a pure function: `(command: string, cwd: string, env: Record<string,string>) => CommandRiskAssessment`. It does not execute anything. It runs before the approval check so the risk tier can influence the approval decision.

- **Approval escalation composes the four approval classes with policy layers and session grants.** The approval classes defined in the Tool Surface block are the foundation. This section defines how policy turns them into runtime decisions.

  **Approval decision values:** `allow` (proceed without prompting), `confirm` (prompt user), `deny` (refuse, return error to model).

  **Resolution algorithm for each tool call:**

  1. **Profile check** — Is this tool in the agent's allowed tool set (profile intersection with any narrowing overrides)? If not, `deny` with reason "not permitted by agent profile"
  2. **Sandbox check** — For file-system tools, does the resolved path fall within an allowed zone? If not, `deny` with reason "outside workspace boundary"
  3. **Risk analysis** — For `exec_command`/`open_session`/`session_io`, run the `CommandRiskAnalyzer`. If `forbidden`, `deny` immediately. If `high`, set minimum decision to `confirm` (cannot be auto-approved unless the user has a matching pre-authorization rule and `--no-confirm` is active)
  4. **Class-level policy** — Look up the tool's approval class in the merged config:
     - `read-only`: `allow` (always, unless sandbox check failed above)
     - `workspace-write`: `confirm` by default. User config can set to `allow` for the class or per-tool. Delete and move operations escalate to `confirm` even if the class is set to `allow`, unless explicitly overridden per-tool
     - `external-effect`: `confirm` by default. User config can set pre-authorization rules (pattern-matched) that resolve to `allow`. Without a matching rule, always `confirm`
     - `user-facing`: always interactive — `ask_user` and `confirm_action` are inherently user-facing and never auto-approved or denied
  5. **Pre-authorization match** — Check user-config pre-authorization rules (Block 9). Rules are scoped: tool name, optional command regex (for exec_command), optional cwd pattern, optional path glob (for file tools). If a rule matches and its decision is `allow`, the tool proceeds without prompting. Pre-authorization rules exist only in user config — project config cannot define them
  6. **Session grants** — Check runtime session grants issued earlier in this session (e.g., user chose "always approve this" in a confirmation prompt). Session grants are keyed by a fingerprint of the tool call pattern and scoped to the current session. They do not persist across sessions
  7. **Final decision** — If no rule resolved to `allow`, the decision is `confirm`. The confirmation prompt is presented to the root agent (or bubbled up from sub-agents)

  **`--no-confirm` flag semantics:** This is a CLI invocation flag, not a config setting. It means "auto-approve `confirm` decisions without prompting." It does NOT override `deny` decisions (sandbox violations, forbidden commands, profile restrictions). It does NOT override `blocked` risk tier commands. In non-interactive mode (executor, one-shot without a TTY), if a tool requires confirmation and no `--no-confirm` flag is present and no pre-authorization rule matches, the tool returns `approval_required` (for sub-agents) or fails with `user_cancelled` (for root). The agent never silently skips a confirmation — it either confirms automatically or fails explicitly.

  **Confirmation prompt UX (interactive mode):**

  ```
  ⚠ exec_command requires confirmation
    Command: npm install --save lodash
    Risk: network_download, package_install
    Working directory: /home/user/project

    [y] approve    [n] deny    [a] always (this session)    [e] edit command
  ```

  The `[a] always` option creates a session grant with a fingerprint derived from the tool name and (for exec_command) a normalized command pattern. The `[e] edit` option opens the command in `$EDITOR` (or inline editing if no editor is set) and re-runs the risk analysis on the edited command. The prompt times out after the user-interaction timeout (no timeout — waits indefinitely, matching the Tool Runtime Contract's "user interaction: none" timeout category).

  **Composition with agent profiles:** Approval rules and agent profiles compose through intersection. A `researcher` profile has no write tools, so workspace-write approval rules never fire — the profile check denies the tool before approval is evaluated. A `coder` profile with `exec_command` hits the full approval pipeline. Profiles narrow the tool set; approval rules govern what happens with the remaining tools.

- **Sub-agent approval routing uses structural bubbling, not conversational routing.** The existing delegation design specifies that children cannot prompt the user directly and must return `approval_required` to the parent. This section defines the mechanics.

  **Approval request shape returned by child:**

  ```typescript
  {
    type: "approval_required",
    toolCall: { tool, args, riskTier, riskFacets },
    reason: string,        // human-readable explanation
    childLineage: {        // for audit trail
      agentId: string,
      depth: number,
      label: string
    }
  }
  ```

  **Parent receives this as part of the `await_agent` result.** The parent can:
  1. **Satisfy from own authority** — if the action falls within the parent's inherited authority or a session grant, the parent re-issues the grant to the child and the child proceeds. This happens without user interaction
  2. **Bubble up** — if the parent is also a sub-agent (depth > 0) and the action exceeds its own authority, it returns `approval_required` to its own parent, appending its own lineage. The chain continues until it reaches the root agent
  3. **Deny** — the parent can decide the action is unnecessary and instruct the child to use an alternative approach
  4. **Root agent prompts user** — only the root agent (depth 0) presents confirmation prompts to the user. The prompt includes the full lineage chain so the user knows which sub-agent requested the action and why

  **Session grants propagate downward.** When the root agent (or a parent) issues a session grant in response to a child's approval request, the grant is scoped to the requesting child's subtree. The child and its descendants can use the grant for matching actions without further bubbling. The grant does not extend to sibling agents or the parent's other children.

  **Approval fatigue mitigation:** The root agent can issue subtree-scoped session grants proactively at spawn time (e.g., "this coder agent may run `npm test` and `npm run build` without further approval"). These are passed as `preAuthorizedPatterns` in the `spawn_agent` call. Pre-authorized patterns are narrowing-only — they must fall within the parent's own authority. Additionally, the confirmation prompt's `[a] always` option creates a session grant that applies to the entire agent tree, not just the requesting child, reducing repeated prompts for the same action pattern across multiple sub-agents.

  **Depth 2 works identically to depth 1.** A grandchild returns `approval_required` to its parent (the child), which either satisfies it or bubbles to the root. There is no special handling for deeper chains — the algorithm is recursive and uniform.

- **Network egress policy applies to built-in network tools and best-effort detection on shell commands.** The policy governs which tools can make external network requests and to which destinations.

  **Policy structure:**

  | Field | Values | Default |
  |---|---|---|
  | `network.mode` | `off`, `approved-only`, `open` | `approved-only` |
  | `network.allowDomains` | string[] (glob patterns) | `[]` (empty — no pre-approved domains) |
  | `network.denyDomains` | string[] (glob patterns) | `[]` |
  | `network.allowHttp` | boolean | `false` (HTTPS only by default) |

  **Built-in network tools** (`fetch_url`, `web_search`, `lookup_docs`) check the policy before making any request:
  - `mode: off` — all network tools return a typed error (`network_disabled`). The model sees the error and can use alternative approaches
  - `mode: approved-only` — the request URL's domain is checked against `allowDomains` (permit if matched) and `denyDomains` (deny if matched, takes precedence over allow). If the domain is not in either list, the request requires user confirmation (standard `external-effect` approval flow). Non-HTTPS URLs are denied unless `allowHttp` is true
  - `mode: open` — all domains are permitted for built-in network tools (still subject to `denyDomains` blocklist). Standard `external-effect` approval still applies unless pre-authorized

  **`exec_command` network detection is best-effort.** The `CommandRiskAnalyzer` detects obvious network clients (`curl`, `wget`, `ssh`, `scp`, `rsync`, `git clone`, `git fetch`, `git push`, `npm install`, `pip install`, `docker pull`, `apt-get`, `brew`) and tags them with the `network_download` or related facets. When `network.mode` is `off`, detected network commands are denied. When `approved-only`, they require confirmation. However, the agent cannot fully sandbox arbitrary binary network access in v1 without OS-level isolation. The detection is documented as best-effort — it catches common patterns, not all possible network egress. This trade-off is explicit in the architecture, not hidden.

  **Localhost exception:** Requests to `localhost`, `127.0.0.1`, and `::1` are exempt from domain policy checks. Dev servers, local databases, and local APIs are common development needs. This exception applies to built-in network tools only, not to the shell command detection (which uses the standard approval flow regardless).

- **Secrets scrubbing operates at multiple pipeline points with two detection strategies.** Secrets must never reach the LLM context, the conversation log, the event log, or terminal output in plaintext. Scrubbing happens at four points:

  **Scrubbing points (in order of data flow):**

  1. **Tool output** — before the `ToolResultItem` is created. This is the primary scrubbing point. Tool results pass through the `SecretRedactor` before entering the conversation state
  2. **LLM context assembly** — before the API request is sent. Defense-in-depth: catches secrets that entered conversation state through other paths (e.g., user messages mentioning secrets)
  3. **Persistence** — before writing to `conversation.jsonl` and `events.jsonl`. Ensures on-disk data is scrubbed even if in-memory state was missed
  4. **Terminal rendering** — before displaying tool output or LLM responses to the user. Belt-and-suspenders: the user should not see secrets in agent output even if they are present in a file the agent reads

  **Two detection strategies:**

  *Strategy 1: Exact-value redaction for known secrets.* At session start, the runtime loads all configured API keys and secret values from the environment and `~/.aca/secrets.json` (Block 9). These exact values are stored in a `Set<string>` and matched via literal string search. This catches the agent's own secrets appearing in tool output (e.g., if the agent reads a `.env` file that contains the same API key). Exact matching has zero false positives for known values.

  *Strategy 2: Context-sensitive pattern detection for unknown secrets.* Regex patterns detect common secret formats in text that is not a known secret. Patterns are anchored to context — they fire only when a high-entropy string appears adjacent to a secret-indicating label (e.g., `key=`, `token:`, `password=`, `Authorization:`, `Bearer `). Specific patterns:

  | Pattern | Context required | Example match |
  |---|---|---|
  | Provider API key prefixes | None (prefix is sufficient) | `sk-...`, `pk_test_...`, `AKIA...`, `ghp_...`, `ghs_...`, `glpat-...` |
  | Bearer tokens | `Authorization` header or `Bearer` prefix | `Bearer eyJ...` |
  | PEM private keys | `-----BEGIN` block | `-----BEGIN RSA PRIVATE KEY-----` |
  | `.env` file assignments | `=` after key/secret/token/password label | `API_KEY=abc123def456` |
  | Connection strings with credentials | `://user:pass@` pattern | `postgres://admin:secret@host/db` |
  | JWT tokens | Three dot-separated base64 segments | `eyJhbG...eyJzdW...sig` |
  | High-entropy strings with labels | Adjacent to `key`, `token`, `secret`, `password`, `credential`, `auth` (case-insensitive) | `api_key: "a1b2c3d4e5f6..."` |

  **`SecretPattern` interface** — each Strategy 2 pattern is registered as:
  ```typescript
  interface SecretPattern {
    name: string;              // Pattern identifier (e.g., "api_key_prefix", "bearer_token")
    pattern: RegExp;           // Detection regex
    type: string;              // Redaction type label used in placeholder (e.g., "api_key", "bearer", "pem_key")
    contextRequired?: string;  // Optional context that must be adjacent (e.g., "Authorization")
  }
  ```

  **What is NOT scrubbed:** SHA-256 commit hashes, content hashes (e.g., in lockfiles), UUIDs, base64-encoded non-secret data, file checksums, and general hex strings without a secret-indicating label. The pattern detection requires context (a label or known prefix) to avoid false positives on legitimate data. If a pattern has no label context and no known prefix, it is not scrubbed.

  **Redaction format:** Detected secrets are replaced with stable, typed placeholders: `<redacted:api_key:1>`, `<redacted:bearer_token:2>`, `<redacted:env_value:3>`. The numeric suffix is a per-session counter for each redaction instance, enabling correlation across log entries without exposing the value. Redaction metadata (original byte length, detection strategy, pattern name) is recorded in the event log for debugging.

  **False positive recovery:** If a user reports that legitimate content was redacted, they can add patterns to a `scrubbing.allowPatterns` list in their user config (Block 9). Allowed patterns are checked before scrubbing and exempt matching strings from redaction. This is user-config only — project config cannot suppress scrubbing.

**Integration with other blocks:**

- **Tool Runtime Contract:** The sandbox check (zone enforcement) and command risk analysis run inside the Tool Runtime Contract layer, before tool-specific code executes. The approval check is part of the turn engine's `ExecuteToolCalls` phase (Block 6 phase 10), which calls into the approval engine before dispatching to the tool runtime
- **Block 6 (Agent Loop):** The `CheckYieldConditions` phase (phase 8) checks for `approval_required` outcomes. The `ExecuteToolCalls` phase (phase 10) runs the approval resolution algorithm per tool call. If the resolution is `confirm`, the turn yields with `approval_required` outcome
- **Block 5 (Conversation State Model):** Approval decisions, session grants, and risk assessments are recorded in the event log as fields on `tool.invoked` events. The conversation log contains only the final tool results (post-scrubbing)
- **Block 9 (Configuration & Secrets):** All policy settings (auto-approve rules, pre-authorization patterns, extra trusted roots, network policy, scrubbing patterns) are loaded from the merged config (Block 9). The trust boundary (which settings project config can set) is enforced by Block 9's config loader. The permission model reads from the resolved config, never directly from project files
- **Delegation (Agent Profiles):** Agent profiles define the tool set. The permission model intersects the profile's tools with the approval policy. Sub-agent authority is the intersection of parent authority and child profile — it can only narrow, never widen

**Deferred:**
- OS-level sandboxing for `exec_command` (namespaces, seccomp, landlock)
- Fine-grained filesystem ACLs (read-only zones, write-once zones)
- Network egress monitoring via eBPF or proxy
- Secrets scanning of workspace files on session start (proactive detection)
- Per-tool-call audit trail with cryptographic chaining
- Time-boxed approval grants (auto-expire after N minutes)
- Approval policies expressed as a policy language (OPA, Cedar) instead of JSON rules
- Machine-learning-based command risk classification

### Block 9: Configuration & Secrets

How the agent is configured and where sensitive data lives. This block defines the config schema, loading precedence, merge semantics, and trust boundary for per-project overrides. The permission model (Block 8) reads from the resolved config produced here.

**Core principle: project config is untrusted input.** Any `.aca/config.json` checked into a repository could be authored by an adversary. The config system treats project-level config as a quarantined source that can only narrow/restrict behavior, never expand authority. User config and CLI flags are the trusted sources that own the security boundary.

**Foundational decisions:**

- **Config format is JSON with JSON Schema validation.** Config files are named `config.json` and validated against a JSON Schema (Draft 2020-12) at load time. JSON is chosen over TOML and YAML because: it has no ambiguous whitespace semantics, it is natively parseable in Node.js without dependencies, it maps cleanly to TypeScript types, it is harder to inject surprising values (no YAML anchors, no TOML table reordering), and the agent already uses JSON throughout (event log, conversation log, tool schemas). JSON's lack of comments is a minor inconvenience addressed by documenting the schema and supporting a `$schema` reference for IDE autocomplete.

  The schema includes a `schemaVersion: number` field (starting at `1`) for forward compatibility. On load, if the file's `schemaVersion` exceeds the agent's known version, the agent warns and ignores unknown fields rather than rejecting the file. If the `schemaVersion` is missing, it defaults to `1`.

  A JSON Schema definition file ships with the agent and is referenced from config files via `"$schema": "./node_modules/@ACA/schema/config.v1.json"` (or a URL once published). The schema is validated at load time using `ajv` (Already JSON Schema). Validation errors are reported as structured messages with the field path and expected type, not raw `ajv` output.

- **Config file locations and precedence order: CLI flags > environment variables > project config > user config > defaults.** Five sources, merged in priority order. Higher-priority sources override lower-priority ones, subject to per-field merge semantics and trust boundary filtering.

  | Priority | Source | Path / Mechanism | Trust level |
  |---|---|---|---|
  | 1 (highest) | CLI flags | `--model`, `--no-confirm`, `--network-off`, etc. | Trusted (user invocation) |
  | 2 | Environment variables | `ACA_MODEL`, `ACA_NETWORK_MODE`, etc. Prefix: `ACA_` | Trusted (user environment) |
  | 3 | Project config | `.aca/config.json` in workspace root | **Untrusted** (may be checked into repo) |
  | 4 | User config | `~/.aca/config.json` | Trusted (user's home directory) |
  | 5 (lowest) | Defaults | Hardcoded in source | Trusted (agent code) |

  **Merge semantics by field type:**
  - **Scalars** (string, number, boolean): last-wins (higher priority replaces lower)
  - **Objects**: deep-merge by key (higher priority keys override, lower priority keys are preserved)
  - **Arrays**: replace, not concatenate (higher priority array replaces lower priority array entirely). Array merging creates unpredictable ordering — replace semantics are safer and easier to reason about
  - **Permission-like fields**: use **most-restrictive-wins** composition instead of last-wins. Specifically: allowed tool sets intersect (not union), domain allowlists intersect, booleans that reduce authority win over booleans that expand it. This means a project config that restricts tools further than user config is honored, but a project config that tries to allow more tools than user config is ignored

  **Environment variable mapping:** Config fields are mapped to environment variables with the `ACA_` prefix, uppercase, underscores replacing dots and camelCase boundaries. Examples: `model.default` maps to `ACA_MODEL_DEFAULT`, `network.mode` maps to `ACA_NETWORK_MODE`. Arrays in environment variables use comma-separated values: `ACA_NETWORK_ALLOW_DOMAINS=github.com,npmjs.com`. Boolean env vars accept `true`/`false`/`1`/`0`. Unset env vars are treated as absent (no opinion), not as empty/false.

  **Edge cases:**
  - A field set in project config but not in user config: the project config value applies (subject to trust boundary filtering)
  - A field set in both project and user config: the user config value wins for security-sensitive fields; deep-merge applies for safe fields
  - `--no-confirm` CLI flag: overrides the `permissions.nonInteractive` config field and sets all `confirm` decisions to `allow` (but not `deny` decisions, per Block 8)
  - Missing config files: silently ignored. The agent runs with defaults if no config exists
  - Malformed config files: user config triggers a warning and falls back to defaults. Project config triggers a warning and is ignored entirely (fail-safe for untrusted input)

- **Per-project overrides are filtered through a trust boundary before merge.** The config loader maintains two JSON Schema variants: the **full schema** (for user config and CLI flags) and the **project-safe schema** (for project config). The project-safe schema is a strict subset of the full schema. Fields not in the project-safe schema are silently dropped from project config during loading — no error, no prompt, just ignored.

  **Project config CAN set (project-safe fields):**

  | Field | Type | Purpose |
  |---|---|---|
  | `model.default` | string | Preferred model for this project |
  | `model.temperature` | number | Temperature override |
  | `profiles` | object | Additional agent profiles (narrowing-only, per existing agent profile rules) |
  | `project.ignorePaths` | string[] | Additional paths to ignore in find/search (merged with .gitignore) |
  | `project.docAliases` | object | Short names for documentation URLs (used by `lookup_docs`) |
  | `project.conventions` | string | Brief text injected into system prompt describing project conventions |
  | `network.denyDomains` | string[] | Additional domains to block (merged with user deny list) |
  | `permissions.blockedTools` | string[] | Tools to disable for this project (narrowing only) |
  | `limits.maxStepsPerTurn` | number | Override step limit (can only reduce, not increase beyond user config or default) |
  | `limits.maxConcurrentAgents` | number | Override agent limit (can only reduce) |

  **Project config CANNOT set (user-only fields, silently dropped):**

  | Field | Why user-only |
  |---|---|
  | `permissions.preauth` (pre-authorization rules) | A malicious repo could auto-approve destructive commands |
  | `permissions.nonInteractive` / `--no-confirm` | Would allow unattended destruction |
  | `sandbox.extraTrustedRoots` | Would allow filesystem escape |
  | `network.mode` | Would allow `off` → `open` escalation |
  | `network.allowDomains` | Would allow exfiltration to arbitrary domains |
  | `network.allowHttp` | Would enable insecure connections |
  | `provider.*` | Would redirect API calls to attacker-controlled endpoints |
  | `secrets.*` | Would access or suppress scrubbing of secrets |
  | `scrubbing.allowPatterns` | Would suppress secret detection |
  | `workspace.root` | Would relocate the workspace boundary |

  **Trust store for workspace trust levels:** The user config contains an optional `trustedWorkspaces` map: `{ [normalizedAbsolutePath: string]: "trusted" | "untrusted" }`. When a workspace is marked `trusted`, its project config is loaded with an expanded project-safe schema that additionally allows: `model.provider` (model selection, not API endpoint), custom agent profiles with non-default tool sets (still narrowing-only relative to built-in profiles), and `project.systemPromptOverlay` (additional system prompt text). A workspace not in the map defaults to `untrusted`. Trust is set via `aca trust` / `aca untrust` commands or manual config editing. Trust is keyed by the canonical absolute path of the workspace root, not by repository URL or content hash — moving a repository to a different path resets its trust.

- **API keys live in environment variables (primary) or a dedicated secrets file (fallback). Never in config files, never on the command line.**

  **Resolution order:**

  1. `NANOGPT_API_KEY` environment variable (primary provider). Additional provider keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.
  2. `~/.aca/secrets.json` — a dedicated file with `0600` permissions, separate from `config.json`. Contains `{ "nanogpt": "key-value", "anthropic": "key-value" }`. The agent checks file permissions on startup and refuses to load secrets from a file with permissions looser than `0600` (owner read/write only)
  3. No `--api-key` CLI flag. Shell history is a persistent, unencrypted record — passing secrets as arguments is a well-known footgun. The agent does not support it

  **Why not system keyring in v1:** WSL2 has inconsistent keyring support (no `gnome-keyring` or `kwallet` by default, `libsecret` may not be available). Adding a keyring dependency (`keytar` or similar) introduces native compilation, platform-specific behavior, and failure modes that are not worth the complexity for v1. The `secrets.json` with `0600` permissions provides adequate security for a single-user CLI tool. Keyring integration is a v2 enhancement.

  **Secrets file creation:** `aca init` or `aca configure` creates `~/.aca/secrets.json` with the correct permissions. If the file already exists with wrong permissions, the command warns and offers to fix them. The agent never writes secrets to `config.json`.

- **The full config schema covers seven top-level groups.** Each group maps to a specific concern. The resolved config is a single TypeScript type (`ResolvedConfig`) frozen at session start.

  ```
  {
    "schemaVersion": 1,

    "providers": [                   // Provider configurations (Block 17)
      {
        "name": "nanogpt",          // Provider identifier
        "baseUrl": null,             // Custom API endpoint (user-only)
        "timeout": 30000,            // API call timeout in ms
        "priority": 1                // Selection priority (lower = preferred)
      }
    ],

    "defaultProvider": "nanogpt",     // Active provider (must exist in providers array)
    "apiTimeout": 30000,             // Global API call timeout fallback (ms)

    "model": {
      "default": "claude-sonnet-4-20250514",  // Default model
      "compressionModel": null,    // Override for summarization (v1: ignored, uses default)
      "temperature": 0.1,          // Sampling temperature
      "maxOutputTokens": 4096      // Max response tokens
    },

    "permissions": {
      "nonInteractive": false,     // true = --no-confirm behavior
      "preauth": [                 // Pre-authorization rules (user-only)
        {
          "id": "tests",
          "tool": "exec_command",
          "match": {
            "commandRegex": "^(pnpm|npm|yarn) (test|lint|typecheck|build)\\b",
            "cwdPattern": "workspace"
          },
          "decision": "allow",
          "scope": "session"
        }
      ],
      "classOverrides": {          // Per-class default overrides (user-only)
        "workspace-write": "confirm",
        "external-effect": "confirm"
      },
      "toolOverrides": {},         // Per-tool overrides (user-only)
      "blockedTools": []           // Tools to disable entirely
    },

    "sandbox": {
      "extraTrustedRoots": []      // Additional allowed paths (user-only, absolute)
    },

    "network": {
      "mode": "approved-only",     // off | approved-only | open
      "allowDomains": [],          // Glob patterns for pre-approved domains (user-only)
      "denyDomains": [],           // Glob patterns for blocked domains
      "allowHttp": false           // Allow non-HTTPS requests
    },

    "scrubbing": {
      "enabled": true,             // Master switch for secret scrubbing
      "allowPatterns": []          // Patterns exempt from scrubbing (user-only)
    },

    "project": {
      "ignorePaths": [],           // Additional paths to ignore in find/search
      "docAliases": {},            // Short names for doc URLs
      "conventions": ""            // Project conventions text for system prompt
    },

    "limits": {
      "maxStepsPerTurn": 25,
      "maxConsecutiveAutonomousToolSteps": 10,
      "maxConcurrentAgents": 4,
      "maxDelegationDepth": 2,
      "maxTotalAgents": 20
    },

    "trustedWorkspaces": {}        // Trust store: path -> "trusted" | "untrusted" (user-only)
  }
  ```

  Fields marked "(user-only)" are stripped from project config during loading per the trust boundary rules above.

- **Config loading is a deterministic pipeline that runs once at session start.** The `ConfigLoader` produces a frozen `ResolvedConfig` that does not change during the session. Steps:

  1. Load defaults (hardcoded)
  2. Load user config from `~/.aca/config.json` (if exists, validate against full schema)
  3. Load project config from `.aca/config.json` in workspace root (if exists, validate against project-safe schema, drop disallowed fields)
  4. Parse environment variables with `ACA_` prefix
  5. Parse CLI flags
  6. Merge in priority order: defaults ← user config ← project config (filtered) ← env vars ← CLI flags
  7. For permission-like fields, apply most-restrictive-wins composition instead of last-wins
  8. Validate the merged result against the full schema
  9. Freeze and return `ResolvedConfig`

  The resolved config is available to all runtime components via dependency injection, not global state. It is immutable for the session duration. Runtime state changes (session grants, approval decisions) live in the session's in-memory state, not in the config.

**Integration with other blocks:**

- **Block 8 (Permission / Sandbox Model):** The permission model reads all policy from the resolved config: pre-authorization rules, class overrides, network policy, sandbox boundaries. The trust boundary filtering in this block ensures that untrusted project config cannot weaken the security posture set by user config
- **Block 5 (Conversation State Model):** The resolved config is snapshotted in the session `manifest.json` at session start. On session resume, the snapshot is used to detect config drift (current config vs snapshot) and warn if security-relevant settings have changed
- **Observability:** Config loading emits a `config.loaded` event recording which sources were present, which fields came from which source, and whether any project config fields were dropped by the trust filter. This aids debugging when behavior differs between projects
- **Agent Profiles:** Custom profiles defined in project config (trusted workspaces only) are registered in the `AgentRegistry` at session start, alongside built-in profiles. They follow the same narrowing-only rules
- **System Prompt Assembly:** The `project.conventions` field is injected into the per-turn context block. The model name and provider from the resolved config determine the API call target and context limits
- **Secrets in config:** API keys loaded from `secrets.json` or environment variables are added to the exact-value redaction set (Block 8 secrets scrubbing) at session start. They are never written to the conversation log, event log, or config snapshot

**Deferred:**
- System keyring integration for secrets (post-v1, when WSL2 keyring support matures)
- Config encryption at rest
- Remote config sources (team-shared config via URL or registry)
- Config profiles (named config presets switchable via CLI flag)
- `aca config` subcommand for interactive config editing
- Config file watching and hot-reload during session
- Config migration tooling (upgrading schemaVersion across breaking changes)
- Per-directory config cascade (nested .aca/config.json files within a workspace)
- Policy-as-code integration (OPA, Cedar) for complex approval rules

### Block 10: CLI Interface & Modes

The entry point and invocation modes. This block wires the user-facing CLI to the internal engine — it is the part users actually touch. It consumes Block 6's turn engine interface (`executeTurn`, `interrupt`, `getPhase`), Block 9's config loading pipeline, Block 8's approval classes and `--no-confirm` semantics, and the delegation contract's `describe`/`invoke` operations. All human-facing output (prompts, status, progress, errors) goes to `stderr`. `stdout` is reserved for assistant content (interactive/one-shot) or structured JSON (executor), per the observability decision.

**Core principle: modes are entry points, not runtime states.** The mode is determined once at startup and does not change during the session. Each mode defines how input arrives, how output is delivered, and when the process exits. The turn engine (Block 6) does not know which mode it is running in — the mode-specific wrapper calls `executeTurn` and interprets the yield.

**Foundational decisions:**

- **Argument parser: `commander` (v12+).** Commander is the right fit for ACA's command shape: subcommands with independent option schemas, typed options via `.opts<T>()`, built-in help and version generation, and a fluent API that scales to the ~7 subcommands without middleware complexity. `util.parseArgs` (Node 18.3+) lacks subcommand support entirely — adopting it would require rebuilding half of commander. `yargs` is more powerful but its middleware system and `.commandDir()` indirection add complexity without benefit for this use case. Commander's TypeScript definitions provide compile-time safety, and its 130M weekly downloads provide stability confidence.

  **Command tree:**

  | Command | Purpose | Notes |
  |---|---|---|
  | `aca [task]` | Main entry — interactive (no args) or one-shot (with task) | Default command |
  | `aca describe` | Output capability descriptor (delegation contract) | Always JSON on stdout |
  | `aca invoke` | Execute structured task from stdin (delegation contract) | Always JSON on stdin and stdout |
  | `aca init` | Initialize `~/.aca/` directory structure and secrets | Setup command |
  | `aca configure` | Interactive configuration wizard | Setup command |
  | `aca trust [path]` | Mark a workspace as trusted (Block 9) | Modifies `~/.aca/config.json` |
  | `aca untrust [path]` | Remove workspace trust (Block 9) | Modifies `~/.aca/config.json` |
  | `aca stats` | Usage analytics and cost summary (Block 19) | Queries SQLite observability store |

  The main command handles the `[task]` positional argument. Subcommands (`describe`, `invoke`, `init`, `configure`, `trust`, `untrust`, `stats`) are independent entry points with their own option schemas. Global options (`--model`, `--verbose`, `--config`, etc.) are defined on the root program and inherited by all commands.

- **Mode detection: hybrid — subcommands for executor, implicit for human modes, with explicit override.** The mode is resolved once at startup using a deterministic priority chain. Executor mode is always explicit (via subcommand or `--json` flag with piped stdin). Human modes are inferred from context.

  **Resolution rules (evaluated in order, first match wins):**

  | Condition | Resolved mode |
  |---|---|
  | `aca describe` or `aca invoke` subcommand | Executor |
  | `!process.stdin.isTTY && --json` flag present | Executor |
  | Positional `[task]` argument present | One-shot |
  | `!process.stdin.isTTY && command !== 'invoke'` (piped text, not the executor subcommand) | One-shot (piped text becomes the task) |
  | None of the above | Interactive |

  **Edge case resolutions:**
  - `echo "fix the bug" | aca` — one-shot. The piped text is read as the task input.
  - `echo '{"task":"..."}' | aca invoke` — executor. The subcommand is unambiguous; stdin is parsed as the InvokeRequest JSON envelope.
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

  *`aca describe`:* A fast path that outputs the capability descriptor as a single JSON object on stdout and exits. This command skips workspace detection, config loading, session creation, and all other startup phases — the descriptor is a static declaration that depends only on the agent's version and built-in capabilities. The output includes `contract_version`, `schema_version`, capability name, description, input/output schemas, and constraints.

  *`aca invoke`:* Reads a complete JSON request from stdin, executes the task, and writes a structured JSON result to stdout. The stdin envelope matches the universal capability contract's invoke request shape exactly — `contract_version`, `schema_version`, `task`, `input`, `context`, `constraints`, `authority`, `deadline`. Version compatibility is checked before execution; mismatches return a structured `unsupported_version` error on stdout with a non-zero exit code (per the delegation contract's error shape).

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

  **Phase 6 — Initialize runtime services.** Create the process registry for spawned process tracking (Block: Tool Runtime Contract). Initialize the event sink (append-only JSONL writer targeting the session's `events.jsonl`). Emit `session.started` event (or `session.resumed` for resumed sessions). Create the turn controller with all dependencies injected: session, resolved config, process registry, secret redactor, event sink.

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
- **Observability:** The startup sequence emits `session.started`/`session.resumed` events. The mode-specific loops emit events through the shared event sink. Verbose mode (`--verbose`) enables the human-readable event renderer on stderr. Quiet mode (`--quiet`) suppresses non-essential stderr output
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

### Block 11: Error Handling & Recovery

Consistent policy for when things break. This block defines the typed error taxonomy used across all components, retry and fail-fast policies per error category, user-facing error presentation for each invocation mode, degraded capability handling, LLM API error recovery, and error composition across delegation chains. It integrates with the Tool Runtime Contract's output envelope, Block 6's yield conditions, the capability health tracking system, and Block 10's exit codes.

**Core principle: errors are structured data, never ambiguous.** Every error in the system carries a typed code, a human-readable message, a retryable flag, and an optional details object. The agent never surfaces raw stack traces, unstructured error strings, or provider-specific error formats to the model or the user. Errors are normalized into the canonical taxonomy at the boundary where they occur — tool implementations, provider adapters, and delegation handlers each normalize before returning.

**Foundational decisions:**

- **Error taxonomy uses two-level dot-notation codes with a shared `AcaError` shape.** All errors in the system — tool failures, LLM API errors, delegation errors, system errors — use the same shape:

  ```typescript
  interface AcaError {
    code: string;          // Two-level dot-notation (e.g., "tool.timeout")
    message: string;       // Human-readable, one line
    retryable: boolean;    // Whether automatic retry is appropriate
    details?: Record<string, unknown>;  // Error-specific structured data
    cause?: AcaError;      // Nested cause for error chains (delegation)
  }
  ```

  This shape is used in three places: (1) the `error` field of the Tool Runtime Contract's `ToolOutput` envelope for tool-level errors, (2) event payloads for LLM and system errors, and (3) turn outcome metadata. The `cause` field enables error chain traversal for delegation errors without flattening the original error.

  **Error codes (22 codes across 4 categories):**

  | Code | Semantics | Retryable | Details fields |
  |---|---|---|---|
  | **Tool errors** | | | |
  | `tool.validation` | Tool call input failed JSON Schema validation or tool name not found in registry | No | `toolName`, `parameter`, `constraint`, `validationErrors` |
  | `tool.timeout` | Tool exceeded its per-category timeout (file:5s, LSP:10s, web:15s, shell:60s) | Conditional | `toolName`, `timeoutMs`, `category`. Retryable only for idempotent tools; mutation tools get `mutationState: "indeterminate"` |
  | `tool.crash` | Tool implementation threw an unhandled exception or spawned process died | No | `toolName`, `exitCode`, `signal` |
  | `tool.cancelled` | Tool execution interrupted by user (SIGINT) | No | `toolName`, `phase` |
  | `tool.not_found` | Requested resource does not exist (file, path, session) | No | `toolName`, `resourcePath` |
  | `tool.permission_denied` | Sandbox zone check failed or OS permission error | No | `toolName`, `path`, `resolvedPath`, `reason` |
  | `tool.network_error` | Network failure during tool execution, after auto-retry exhaustion | No | `toolName`, `url`, `attempts`, `lastHttpStatus` |
  | `tool.contract_violation` | Tool returned malformed output that does not match the ToolOutput envelope. This is an implementation bug, not a user or model error | No | `toolName`, `violation` |
  | **LLM errors** | | | |
  | `llm.rate_limited` | HTTP 429 from provider, after retry exhaustion | No | `provider`, `attempts`, `totalWaitMs`, `retryAfter` |
  | `llm.context_too_long` | Provider rejected request for exceeding context window, after compression retry | No | `provider`, `estimatedTokens`, `contextLimit`, `compressionTier` |
  | `llm.content_filtered` | Provider safety filter or content policy triggered | No | `provider`, `filterReason` (if provided by API) |
  | `llm.server_error` | HTTP 5xx from provider, after retry exhaustion | No | `provider`, `httpStatus`, `attempts` |
  | `llm.auth_error` | HTTP 401/403 from provider | No | `provider`, `httpStatus` |
  | `llm.timeout` | No response from provider within configured timeout, after retry | No | `provider`, `timeoutMs`, `attempts` |
  | `llm.malformed_response` | Provider returned invalid JSON or response that cannot be parsed, after retry | No | `provider`, `attempts`, `responsePreview` (first 200 chars) |
  | `llm.confused` | Model produced repeated malformed tool calls, hitting the confusion limit | No | `confusionCount`, `lastToolName`, `lastValidationError` |
  | **Delegation errors** | | | |
  | `delegation.child_error` | Sub-agent completed but returned an error outcome | Conditional | `childAgentId`, `childLabel`, `childTurnCount`. `cause` carries the child's original error |
  | `delegation.child_crash` | Sub-agent process exited unexpectedly (non-zero exit, signal) | No | `childAgentId`, `exitCode`, `signal` |
  | `delegation.child_timeout` | Sub-agent exceeded the delegation timeout (120s) | Conditional | `childAgentId`, `elapsedMs`, `childPhase` |
  | **System errors** | | | |
  | `system.resource_exhausted` | Out of memory, disk full, file descriptor limit, or similar OS resource limit | No | `resource` (memory, disk, fd), `usage`, `limit` |
  | `system.internal` | Invariant violation or unexpected state — indicates a bug in the agent | No | `component`, `invariant`, `state` |
  | `system.config_error` | Configuration error detected at runtime (distinct from startup config errors, which use exit code 4) | No | `field`, `reason` |

  **Design rationale:** Two-level codes (`category.type`) provide enough structure for policy grouping (all `llm.*` errors share retry infrastructure, all `tool.*` errors flow through the ToolOutput envelope) without the parsing complexity of deeper nesting. The `details` object carries type-specific context — the model and user can reason about the error without the taxonomy needing a code for every possible detail. 22 codes covers all known failure modes; new codes can be added within categories without breaking existing error handling logic.

  Error codes that appear in ToolOutput's `error.code` field: all `tool.*` codes. Error codes that appear in event payloads and turn metadata: all codes. Error codes the model sees in conversation context: `tool.*` (via ToolResultItem), `llm.*` (via synthetic system message or turn outcome), `delegation.*` (via delegation tool result).

- **Retry and fail-fast policies are defined per error code, with retry logic owned by the component that detects the error.** Tool-level retries are handled by the Tool Runtime Contract (already defined: 3 attempts, exponential backoff, 250ms start, idempotent tools only). LLM-level retries are handled by the provider adapter. Delegation retries are decided by the parent agent (model-driven). Block 11 defines the policies; existing components implement them.

  **LLM API error recovery policies:**

  | Error | Detection | Retry Policy | Backoff | User Feedback |
  |---|---|---|---|---|
  | **Rate limited (429)** | HTTP status. `Retry-After` header parsed when present | 5 attempts (including initial) | Base: `max(Retry-After, 1s)`. Multiplier: 2× per attempt. Jitter: ±20%. Cap: 60s | Interactive: "Rate limited by [provider], retrying in Ns..." on stderr, updated in place. One-shot: silent during retries, message on final failure. Executor: internal, no output until final result |
  | **Context too long** | Provider-specific error message patterns, normalized by adapter | 1 retry. Escalate one compression tier per Block 7, add 10% estimation guard | No backoff (compression is the fix, not waiting) | Interactive: "Context too long, compressing..." on stderr. If second attempt also fails: "Unable to fit in context window. Consider starting a new session." |
  | **Content filter** | Provider-specific refusal/filter indicators, normalized by adapter | No retry. Never retry — the same content will hit the same filter | N/A | Interactive: "Response blocked by [provider] content filter." The error is surfaced to the model as a synthetic system message so it can rephrase or take a different approach. The model is not told to "try again" — it decides its own recovery |
  | **Server errors (5xx)** | HTTP status 500, 502, 503, 504 | 3 attempts | Exponential: 1s base, 2× multiplier, ±20% jitter. Cap: 16s | Silent during retries. Final failure: "Provider [name] is experiencing errors, please try again later" |
  | **Auth errors (401/403)** | HTTP status | No retry. Fail immediately — auth errors never self-resolve within a session | N/A | "Authentication failed with [provider]. Verify your API key." Provider health set to session-terminal `unavailable`. In interactive mode, the agent continues without LLM capability (can only respond to `/` commands). In one-shot/executor, exit code 4 if at startup, yield error if mid-session |
  | **Malformed response** | JSON parse failure on provider response body | 2 attempts (including initial), immediate retry with no backoff | None | Never shown to user (internal). Logged for debugging. If both attempts fail, yield `llm.malformed_response` |
  | **Provider timeout** | Configured timeout exceeded (default 30s from Block 9) | 2 attempts. Second attempt uses 150% of the configured timeout | No exponential — single extended retry | Interactive: "Request timed out, retrying with extended timeout..." Timeout on retry: yield `llm.timeout` |

  **Retry state is per-call, not global.** Each LLM API call maintains its own retry counter and backoff state. A rate limit on call N does not affect the retry budget for call N+1. This prevents head-of-line blocking where one bad call exhausts retry budget for the session.

  **Health state updates after retry exhaustion:** Rate limit exhaustion → provider health `degraded` with cooldown. Server error exhaustion → provider health `degraded`. Auth error → provider health `unavailable` (session-terminal). Timeout exhaustion → provider health `degraded`. These integrate with the existing capability health tracking system — the provider adapter reports health transitions after final retry failure.

  **Tool-level retry policy (confirming existing design, not overriding):** The Tool Runtime Contract's auto-retry (3 attempts, exponential backoff from 250ms, idempotent tools only) handles transient network errors within tool execution. Block 11 does not add a separate retry layer for tools. If auto-retry is exhausted, the tool returns `tool.network_error` with `retryable: false` — the model sees the final failure and decides whether to try an alternative approach.

- **User-facing error presentation is mode-dependent, always structured, never a raw stack trace.** Errors are formatted differently for each invocation mode, but all modes use the same underlying `AcaError` data. The formatting layer is in the CLI (Block 10), not in the error-producing components.

  **Interactive mode (stderr):**

  Tool errors appear as compact single-line messages with optional detail expansion:
  ```
  ! read_file failed: file not found — /src/missing.ts [tool.not_found]
  ```

  LLM retries show progress inline (overwriting the same line):
  ```
  ! Rate limited by nanogpt, retrying in 2.1s... (2/5)
  ```

  Final LLM failures show the error with actionable guidance:
  ```
  ! LLM error: rate limited after 5 retries [llm.rate_limited]
    Wait a moment and try again, or check provider status.
  ```

  System errors include the code for bug reports but not stack traces (stack traces appear only with `--verbose`):
  ```
  ! Internal error [system.internal] — please report this with session ID ses_01JQ7K...
  ```

  **One-shot mode (stderr):**

  Same format as interactive but prefixed with `aca:` for machine parsing when piped:
  ```
  aca: error: tool.timeout — exec_command timed out after 60s
  ```

  Exit code mapping to error categories:
  - Exit 1 (runtime error): `tool.*` (except validation), `llm.*`, `system.*`, `delegation.*`
  - Exit 2 (user cancelled): `tool.cancelled`, SIGINT abort
  - Exit 3 (usage error): `tool.validation` when caused by CLI input, `system.config_error`
  - Exit 4 (startup failure): `llm.auth_error` at startup, `system.config_error` at startup
  - Exit 5 (protocol error): `llm.malformed_response` in executor mode, `delegation.child_crash` with IPC failure

  **Executor mode (stdout JSON):**

  All errors are structured JSON on stdout. The error envelope extends the delegation contract's result shape:
  ```json
  {
    "status": "error",
    "error": {
      "code": "llm.rate_limited",
      "message": "Rate limited by nanogpt after 5 retries",
      "retryable": false,
      "details": {
        "provider": "nanogpt",
        "attempts": 5,
        "totalWaitMs": 47200
      }
    },
    "turnOutcome": "tool_error",
    "sessionId": "ses_01JQ7K..."
  }
  ```

  The `turnOutcome` field maps to Block 5's 8 turn outcome types, giving the caller both the specific error (`error.code`) and the engine-level outcome (`turnOutcome`). Non-zero exit code accompanies the JSON output per Block 10's exit code scheme.

- **Confusion limit prevents infinite loops from persistently malformed LLM tool calls.** The LLM sometimes produces tool calls that fail validation — wrong JSON structure, nonexistent tool names, missing required parameters. Block 6 already specifies that validation failures become synthetic `ToolResultItem`s so the model can correct itself. Block 11 defines the limit on how many times this can happen.

  **Per-turn confusion limit: 3 consecutive invalid tool calls.** A "confusion event" is any tool call that fails validation at Block 6 phase 9 (`ValidateToolCalls`). The counter tracks consecutive failures within a turn — a successful tool call resets the counter to zero.

  Behavior at each threshold:
  1. **Failures 1-2:** Synthetic `ToolResultItem` with `error.code: "tool.validation"` and a clear message describing what went wrong. The model gets another step to correct itself. This is the normal path — models occasionally produce minor schema errors
  2. **Failure 3:** Synthetic `ToolResultItem` appended, then the turn yields with outcome `tool_error` and code `llm.confused`. The yield message informs the user (interactive) or returns the error (executor). The model's last valid text output (if any) is preserved

  **Per-session confusion limit: 10 total confusion events (cumulative, not consecutive).** After 10 confusion events across the session, the engine injects a persistent system message: "Tool call accuracy has been low this session. Use simpler, single-tool approaches. Verify tool names and parameter schemas before calling." This message is added to the pinned sections in context assembly and costs ~30 tokens. It is informational — the engine does not disable tools or restrict the model.

  **Rationale for limits:** 3 consecutive is tight enough to prevent runaway loops (3 failed validations × 1 step each = 3 wasted LLM calls) while allowing recovery from occasional typos. The per-session limit of 10 catches models that make errors intermittently but persistently — a symptom of the model struggling with the tool surface. The system message nudge is lightweight and lets the model self-correct without engine-level restrictions that might prevent legitimate tool use.

  **What counts as a confusion event:** JSON parse failure on tool call arguments, tool name not found in the tool registry, required parameter missing, parameter type mismatch, parameter value outside allowed enum. What does NOT count: tool execution failures (the call was valid, the tool failed), approval denials (valid call, policy blocked it), tool timeout (valid call, timed out).

- **Degraded capability handling is model-driven with automatic tool masking for unavailable capabilities.** The agent does not silently substitute one capability for another. When a capability becomes unavailable, the model is informed and chooses its own fallback strategy. This is consistent with the existing capability health tracking design (health injected into per-turn context) and avoids surprising behavior changes from automatic substitution.

  **Three behaviors by health state:**

  | Health State | Engine Behavior | Model Sees |
  |---|---|---|
  | `available` | Normal operation. Tool in definitions, no health context line | Nothing special |
  | `degraded` | Tool remains in definitions. Health context injected | `Capability status: lsp(ts)=degraded (warming_up)` — model may choose alternatives |
  | `unavailable` | **Tool removed from tool definitions** sent to the LLM. If the model somehow references the tool (via memory of prior turns), the validation phase returns `tool.validation` with a message explaining unavailability and listing alternatives | Tool absent from available tools. If referenced: `"lsp_query is unavailable this session (server crashed). Use search_text or find_paths instead."` |

  **Why tool masking, not just health context:** Removing unavailable tools from the definitions is stronger than relying on the model to read a health context line and decide not to use the tool. Models sometimes ignore context lines and attempt to use tools they remember from earlier in the conversation. Masking prevents the attempt entirely, saving a step and avoiding confusion event accumulation. The health context line remains for `degraded` capabilities where the model should know about reduced quality but the tool is still functional.

  **No automatic fallback exceptions.** Neither LSP-to-text-search nor search-to-fetch nor any other substitution happens automatically. The model reads the health context, sees which tools are available, and makes its own decision. This keeps behavior predictable and auditable. The model is well-equipped to choose — the health context gives it the information, and the tool definitions tell it what is available.

  **Integration with capability health tracking:** The health map is consulted during `AssembleContext` (Block 6 phase 3). Tool definitions are filtered based on health state before being included in the API request. The `context.assembled` event records which tools were masked and why.

- **Delegation error composition uses the `AcaError` shape with nested `cause` for error chain traversal.** When a sub-agent encounters an error, the parent receives a structured result through the normal `await_agent` response. The parent model can reason about the error's root cause and decide whether to retry, try a different decomposition, or yield the error upward.

  **Delegation result shape (extending the existing delegation design):**

  ```typescript
  type DelegationResult =
    | { status: "success"; output: ToolOutput; turnCount: number; tokenUsage: TokenUsage }
    | { status: "approval_required"; request: ApprovalRequest }
    | { status: "error"; error: AcaError; turnCount: number }
    | { status: "crash"; error: AcaError }
    | { status: "timeout"; elapsedMs: number; partialOutput?: string };
  ```

  **Mapping child failures to parent-visible errors:**

  | Child Situation | Parent Receives | `error.code` | `error.cause` |
  |---|---|---|---|
  | Child's tool hit non-retryable error | `status: "error"` | `delegation.child_error` | The child's original `AcaError` (e.g., `tool.permission_denied`) |
  | Child's LLM call failed after retries | `status: "error"` | `delegation.child_error` | `llm.rate_limited` or `llm.server_error` etc. |
  | Child hit confusion limit | `status: "error"` | `delegation.child_error` | `llm.confused` |
  | Child process exited unexpectedly | `status: "crash"` | `delegation.child_crash` | Signal/exit code in details |
  | Child exceeded 120s delegation timeout | `status: "timeout"` | `delegation.child_timeout` | Elapsed time, last known phase |
  | Child needs user approval | `status: "approval_required"` | N/A (not an error) | Per Block 8's approval bubbling |

  **Parent retry policy for delegation errors:**
  - `delegation.child_error` with `cause.retryable: true` — parent may retry by spawning a new sub-agent with the same task. Limited to 1 retry (2 total attempts)
  - `delegation.child_error` with `cause.retryable: false` — parent does not retry. It may try a different decomposition (different agent profile, narrower task) or yield the error to the user
  - `delegation.child_crash` — parent may retry once (new process). If the retry also crashes, yield error
  - `delegation.child_timeout` — parent may retry once with a more constrained task or increased timeout (if within its authority). If retry also times out, yield error

  **Error chain depth:** In a delegation chain (root → child → grandchild), errors nest: the grandchild's `AcaError` becomes the `cause` of the child's `delegation.child_error`, which becomes the `cause` of the root's `delegation.child_error`. Maximum nesting depth is 3 (matching max delegation depth of 2). Each level preserves the original error code so the root agent can pattern-match on the leaf cause (e.g., "the grandchild failed because of `llm.auth_error`").

**Integration with other blocks:**

- **Tool Runtime Contract:** The `error.code` field in `ToolOutput` uses the `tool.*` codes from this taxonomy. The `retryable` field is set according to the per-code policy table. The auto-retry mechanism (3 attempts for transient network errors) runs before the error reaches conversation state — Block 11's retry policies for tools are already implemented by the Tool Runtime Contract
- **Block 6 (Agent Loop):** The confusion limit is checked at `ValidateToolCalls` (phase 9). When the limit is reached, phase 8 (`CheckYieldConditions`) yields with `tool_error` outcome. LLM API retry logic runs within `CallLLM` (phase 5) — the provider adapter handles retries internally, and if all retries fail, the phase produces an error that triggers a yield. Tool masking for unavailable capabilities runs during `AssembleContext` (phase 3)
- **Block 5 (Conversation State):** The 8 turn outcomes remain unchanged. `tool_error` covers confusion limit, non-retryable tool errors, and LLM errors that exhaust retries. `cancelled` covers user interruption. `aborted` covers session-level abort. The `AcaError` is recorded in the `TurnRecord`'s metadata for the `tool_error` and `aborted` outcomes
- **Capability Health Tracking:** LLM error recovery updates provider health state after retry exhaustion (described in the retry policy table). Tool masking for `unavailable` capabilities is a new behavior defined here and implemented in `AssembleContext`. Health context injection for `degraded` capabilities is unchanged from the existing design
- **Block 7 (Context Window):** The `llm.context_too_long` recovery (escalate compression tier + 10% guard, retry once) is confirmed and unchanged. If the retry also fails, the error is surfaced as `llm.context_too_long` with `retryable: false`
- **Block 8 (Permissions):** Sandbox denials produce `tool.permission_denied`. Approval-required is a yield condition, not an error — it uses the existing `approval_required` turn outcome, not an error code. The `--no-confirm` flag overrides `confirm` but not `deny` (unchanged)
- **Block 9 (Configuration):** Provider timeout (default 30s) feeds `llm.timeout` retry policy (retry once at 150% timeout). No new config fields in Block 11 — retry parameters (attempt counts, backoff multipliers) are hardcoded for v1, not configurable. Configurability deferred
- **Block 10 (CLI Interface):** Exit codes map to error categories per the table above. Executor mode error envelope defined. Interactive/one-shot error formatting defined

**Deferred:**
- Configurable retry parameters (attempt counts, backoff multipliers, jitter range)
- Error reporting / telemetry to remote service
- Adaptive retry based on observed provider behavior
- Custom error recovery strategies (user-defined retry policies)
- Error budget tracking (alerting when error rate exceeds threshold)
- Automatic session migration to different provider on persistent errors
- Structured error codes for specific tool failures beyond the generic `tool.*` categories (e.g., `tool.edit_conflict`, `tool.git_merge_conflict`)
- Error correlation across sessions (detecting provider-wide outages from local observations)

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

### System Prompt Assembly

Every LLM API call is stateless — the agent must reconstruct the full context each turn. System prompt assembly is the process of building each API request from layered components: static instructions, tool schemas, dynamic project state, user-defined rules, and conversation history. Getting the structure, priority ordering, and compression strategy right determines whether the agent behaves consistently as conversations grow and context fills up.

**Foundational decisions:**
- **Layered request structure.** Each API call has four distinct layers:
  1. **`system` parameter** — static agent charter: identity, operating rules, tool-use policy, editing rules, response format, mode overlay. ~500-800 tokens. Does not change within a session unless mode changes
  2. **Tool definitions** — tool schemas (JSON Schema format) provided to the model via whatever mechanism the provider supports (e.g., `tools` parameter for Anthropic/OpenAI, or inlined for providers without native tool calling). All enabled tools every turn. Dynamic capabilities from delegation contract register as additional tool entries
  3. **Per-turn context block** — synthetic message at top of history: runtime facts (OS, shell, cwd), project snapshot, resolved instruction summary, active working set. Target 300-800 tokens. Refreshed each turn but only recomputed when underlying state changes
  4. **Conversation history** — recent turns verbatim, older turns summarized or truncated as context fills
- **Instruction precedence** — core system rules > repo/user instruction files > current user request > durable task state > prior conversation. Stated explicitly in the system prompt
- **All enabled tools every turn** — gated by mode and environment, not per-turn relevance guessing. Prompt caching makes repeated schemas near-free
- **Project context is compact by default** — workspace root, languages, framework, git branch, dirty summary, top-level dirs, active files. Full trees/diffs fetched via tools on demand
- **Pinned sections (never compressed)** — core system rules, tool signatures, current user message, resolved instruction summary, active errors
- **Context pressure thresholds:**
  - **< 60%** — full fidelity
  - **60-80%** — summarize older turns, trim project snapshot
  - **80-90%** — aggressive: last 2-3 raw turns, shorten tool descriptions
  - **> 90%** — emergency: pinned sections + current message only, signal user
- **Compression order (first to drop → last):** older conversation → project detail → tool description verbosity → instruction detail → never: core rules, tool signatures, current message, errors
- **Durable task state is separate from chat history** — structured object (goal, confirmed facts, open loops, blockers) persists across turns and survives conversation summarization

**Deferred:**
- Exact system prompt wording (iterate through testing)
- Token budget threshold tuning
- Summarization prompt engineering
- Tool description compression heuristics
- Working set ranking (which files count as "active")

### Observability / Logging

Every agent action — LLM calls, tool executions, delegation, errors — emits a structured event into an append-only log. This is the single source of truth for debugging, cost accounting, and post-hoc session reconstruction. The event stream is designed once and written to from day one; rendering (terminal, dashboards, replay) is layered on top.

**Foundational decisions:**
- **Append-only structured event stream** — every event is a typed JSON object with a universal envelope (`event_id`, `timestamp`, `session_id`, `turn_number`, `agent_id`, `event_type`, `schema_version`). Synchronous writes for crash durability. JSONL file per session
- **Parent-child event chaining** — every event carries optional `parent_event_id` forming a causal tree. Delegation spawns a new `session_id` but preserves the parent chain across agent boundaries. Cheap to add now, painful to retrofit
- **12 core event types** — `session.started/ended`, `turn.started/ended`, `llm.request/response`, `tool.invoked/completed`, `delegation.started/completed`, `context.assembled`, `error`. Each with typed payload. No stream-delta events — log final outcomes and timings
- **Provider-agnostic token accounting** — capture whatever token counts the provider reports (`input_tokens`, `output_tokens`, plus any cache fields if available), along with `model`, `provider`, and `latency_ms`. Different APIs (NanoGPT, Anthropic, OpenAI) report tokens differently — store raw provider response fields, normalize later. Accumulate per-turn and per-session totals, attributed to `agent_id` for sub-agent cost rollup
- **Content by reference, not inline** — events carry content hashes or message IDs pointing to the conversation log. Keeps the event stream small and queryable
- **Dual output: machine log + human terminal** — JSONL event stream is the authoritative record. Separate renderer produces human-readable output on `stderr` in verbose/debug mode. `stdout` reserved for assistant content
- **Tool invocation/result pairing** — `tool.invoked` carries `invocation_id`, `tool.completed` references it. Required for replay and cost attribution
- **Log completeness enables replay** — the event stream plus conversation log must contain enough data to reconstruct the exact sequence. The replay *engine* is deferred; log *completeness* is not

**Deferred:**
- Replay engine
- Cost estimation with live pricing (raw token counts are enough initially)
- Budget warnings and hard limits
- Log rotation, compaction, retention policies
- Metrics aggregation, remote telemetry
- Secrets redaction beyond basic scrubbing

### Tool Runtime Contract

Every tool invocation passes through a shared runtime layer that enforces validation, timeouts, output limits, and cleanup before any tool-specific code runs. This is the safety perimeter between the LLM's tool calls and the actual system.

**Foundational decisions:**
- **Input validation on every call** — JSON Schema per tool, validated before execution. Validation failure returns typed `ValidationError` to the model. No auto-retry — the model must issue a corrected call
- **Standard output envelope** — `{ status, data, error, truncated, bytesReturned, retryable, timedOut, mutationState }`. Validated on return. Malformed output = implementation bug (`ContractViolation`), never passed to the model
- **Per-category timeouts** — file ops: 5s, LSP: 10s, web: 15s, shell: 60s, delegation: 120s, user interaction: none. On timeout: graceful signal → 2s grace → force kill. Mutation tools get `mutationState: "indeterminate"` on timeout
- **Hard output size caps (byte-based)** — 64 KiB per tool result. `read_file`: 64 KiB or 2,000 lines. `exec_command`: 64 KiB combined, retaining head AND tail (errors cluster at end). `search_text`/`find_paths`: 200 matches max. Oversized output truncated with `truncated: true` + `bytesOmitted` metadata
- **Idempotency declared per tool** — read-only and web-read tools are retry-safe. All writes are not. `edit_file` supports conditional idempotency via `expectedHash` precondition
- **Auto-retry for transient network errors on idempotent tools only** — connection reset, timeout, HTTP 429/502/503/504. Exponential backoff with jitter, 250ms start, 3 attempts max. Model sees only final result; retries logged as events
- **Agent owns all spawned processes** — session registry tracks PID, process group, start time. Idle TTL 1h, hard max 4h. Orphan reaping on startup. Process groups for reliable tree-kill
- **Buffered for model, streamed to user** — tool output buffers to completion before entering model context. `exec_command` simultaneously streams to terminal for real-time feedback. No partial results in model context
- **Shared CWD, isolated everything else** — explicit `cwd` for path resolution. `exec_command` doesn't persist shell state. `open_session` for persistent shell

**Deferred:**
- Adaptive token-based result shaping
- Streaming tool output into model context
- Per-call timeout overrides from the model
- Background/detached process support
- Rich artifact channels (binary data, images)

### Checkpointing / Undo

Every mutating turn is a potential mistake. The agent must be able to rewind file system changes without corrupting the user's git history, conversation state, or mental model. Scope is workspace files only — non-file side effects (package installs, API calls) are tracked and warned about but never promised as reversible.

**Foundational decisions:**
- **Storage: shadow refs in the user's git repo** — checkpoint commits live under `refs/aca/checkpoints/<session-id>/`, invisible to `git branch`, `git log`, and normal workflows. Leverages git's content-addressing and delta compression without polluting user history. No separate repo, no stash manipulation, no filesystem snapshots. If no git repo exists, auto-init one
- **Granularity: per-turn, lazy** — checkpoint created before the first workspace-write tool in a turn. Read-only turns produce no checkpoint. The event log records per-tool-call mutations for finer audit, but undo operates at turn level
- **Before/after pair** — each mutating turn records `beforeTurn` (pre-mutation) and `afterTurn` (post-completion). Enables divergence detection: compare live workspace against last `afterTurn` to detect manual edits between turns. Indeterminate `mutationState` marks `afterTurn` as uncertain
- **Conversation stays append-only** — undo rewinds files, not history. Restore events are appended to the log
- **User interface** — `/undo` reverts last mutating turn. `/undo N` reverts last N. `/checkpoints` lists recent checkpoints. `/restore <id>` jumps to specific checkpoint. All restores show preview and require confirmation
- **Conflict handling** — detects manual edits since last `afterTurn` via divergence. Default: block and explain. User can force-overwrite. Never silently discard manual edits
- **Non-file side effects: warn, don't undo** — turns with `exec_command` or delegation carry `externalEffects: true`. On undo, files restore but agent warns about shell commands that may need manual reversal
- **Executor mode** — checkpoint/restore available as structured delegation operations. Caller decides whether to enable. Event log always records mutations regardless

**Deferred:**
- Selective per-file restore
- Named/tagged checkpoints
- Redo after undo
- Checkpoint retention policies and GC
- Automatic reverse-command inference
- Visual diff preview before restore
- Conversation history forking

**Cross-reference note:** Blocks 17-20 extend the surfaces defined in earlier blocks. Before implementation, the following earlier sections should be updated for consistency: Block 5's turn outcome list should include `budget_exceeded` (9th outcome, from Block 19). Block 9's `provider` config schema should reference the `providers` array (Block 17). Block 10's command tree should include `aca stats` (Block 19) and its slash commands should include `/reindex` (Block 20) and `/budget` (Block 19). The Project Awareness section should reference `indexStatus` (Block 20). These are additive extensions, not changes to existing behavior.

### Block 17: Multi-Provider Support

Full provider abstraction enabling seamless switching between LLM providers, model fallback chains, and provider-specific feature negotiation. This block extends the thin `provider` config field (Block 9) into a complete multi-provider architecture, consumed by Block 6's `CallLLM` phase, Block 7's token estimation, and Block 11's LLM error recovery.

**Core principle: model-first, provider-agnostic invocation.** Users and the agent reason about models ("use claude-sonnet"), not providers. The system resolves model names to providers, negotiates capabilities, and normalizes responses behind a uniform streaming interface. Provider-specific complexity never escapes the adapter boundary.

**Foundational decisions:**

- **Every provider implements a `ProviderDriver` with three methods.** This is the total surface area. No provider-specific objects, types, or behaviors are visible outside the driver boundary.

  ```typescript
  interface ProviderDriver {
    capabilities(model: string): ModelCapabilities;
    stream(request: ModelRequest): AsyncIterable<StreamEvent>;
    embed?(texts: string[], model: string): Promise<EmbeddingResult>;
    validate(config: ProviderConfig): Result<void, ConfigError>;
  }
  ```

  `capabilities()` returns static metadata for planning — context limits, feature support, cost. Called once per model at session start and cached. `stream()` is the single invocation method for chat/completion — the agent always streams. Non-streaming providers have their driver yield a single complete event. `embed()` is optional — only providers that support embedding models implement it. It accepts an array of texts and returns an array of float vectors. Block 20 uses this when `indexing.embeddingProvider` is configured. `validate()` catches misconfiguration at startup (Phase 3 of Block 10's startup pipeline), not mid-session.

  **`ModelCapabilities` shape:**

  | Field | Type | Purpose |
  |---|---|---|
  | `maxContext` | number | Context window in tokens |
  | `maxOutput` | number | Max response tokens |
  | `supportsTools` | `'native' \| 'emulated' \| 'none'` | Native tool calling, prompt-injected emulation, or unsupported |
  | `supportsVision` | boolean | Image input support |
  | `supportsStreaming` | boolean | Real-time token streaming |
  | `supportsPrefill` | boolean | Assistant message prefix (Anthropic-style) |
  | `supportsEmbedding` | boolean | Whether the provider offers an embedding API via the `embed()` method |
  | `embeddingModels` | `string[]` | Available embedding model IDs (empty if `supportsEmbedding` is false) |
  | `toolReliability` | `'native' \| 'good' \| 'fair' \| 'poor'` | How reliably the model follows tool schemas. `native` = provider-level enforcement; `good`/`fair`/`poor` = emulated with decreasing accuracy |
  | `costPerMillion` | `{ input: number; output: number; cachedInput?: number }` | USD per million tokens for cost tracking (Block 19) |
  | `specialFeatures` | `Feature[]` | Provider-specific extensions (see below) |

  **`StreamEvent` is a tagged union** normalized by the driver:
  - `{ type: 'text_delta'; text: string }` — incremental text token
  - `{ type: 'tool_call_delta'; index: number; name?: string; arguments?: string }` — incremental tool call
  - `{ type: 'done'; finishReason: string; usage: TokenUsage }` — stream complete with token accounting
  - `{ type: 'error'; error: AcaError }` — provider error (already normalized to Block 11 taxonomy)

  The agent loop (Block 6 phase 5 `CallLLM`) consumes `StreamEvent` without knowing which provider produced it. The `NormalizeResponse` phase (6) receives a complete response reconstructed from the stream events.

- **Model resolution uses a hierarchical registry: exact match, then alias, then default.** The user specifies a model name (e.g., `claude-sonnet`, `gpt-4o`, `deepseek-chat`). Resolution follows a priority chain:

  1. **Exact match** — the model name matches a known model ID in a registered provider's catalog (e.g., `claude-sonnet-4-20250514` resolves to the Anthropic or NanoGPT driver)
  2. **Alias match** — the model name matches a user-defined or built-in alias (e.g., `claude-sonnet` → `claude-sonnet-4-20250514`). Aliases are defined in the model registry
  3. **Default** — if no model is specified, use `model.default` from the resolved config (Block 9)

  No capability-based routing in v1 (e.g., "give me the cheapest model with tool support"). The user picks a model; the system resolves it to a provider. Capability profiles and cost-optimized routing are deferred.

  **Model registry:** A built-in JSON file (`src/providers/models.json`) ships with the agent, containing model IDs, aliases, default capabilities, and cost data for known models. Users can override or extend with entries in their user config (`~/.aca/config.json` under a `models` key). The registry is loaded once at session start and frozen.

- **NanoGPT is one `ProviderDriver` that exposes multiple underlying models.** NanoGPT is a meta-provider — one API key, one base URL, routing to Claude, Kimi, DeepSeek, GPT, and others. In the provider architecture, it is a single driver, not one driver per underlying model.

  The NanoGPT driver's `capabilities()` returns the underlying model's capabilities (context limit, tool support, etc.), not NanoGPT's gateway capabilities. The driver maintains an internal mapping from model ID prefix to underlying provider characteristics (e.g., `claude-*` → Anthropic-style capabilities, `kimi-*` → Moonshot capabilities).

  Users who need to bypass NanoGPT for a specific provider (e.g., direct Anthropic API for prompt caching) can configure an additional provider driver with a higher priority for specific models. NanoGPT remains the default provider for models without a specific override.

- **Provider-specific features use an opt-in extensions system.** Features that affect request behavior (prompt caching, extended thinking, reasoning effort) are requested explicitly via `extensions` in the `ModelRequest`, not auto-detected or silently enabled.

  ```typescript
  interface ModelRequest {
    model: string;
    messages: Message[];
    tools?: Tool[];
    maxTokens: number;
    temperature: number;
    extensions?: ExtensionRequest[];
  }
  ```

  Known extension types:

  | Extension | Provider | Purpose |
  |---|---|---|
  | `anthropic-prompt-caching` | Anthropic | Cache breakpoints for system prompt and tool definitions |
  | `openai-reasoning` | OpenAI | Reasoning effort level for o-series models |
  | `claude-extended-thinking` | Anthropic | Extended thinking budget for complex reasoning |
  | `deepseek-reasoning` | DeepSeek | Include reasoning chain in response |

  Each extension request includes a `required` flag: `{ type: 'anthropic-prompt-caching', required: false, cacheBreakpoints: [0, -2] }`. If `required: true` and the driver does not support the extension, the request fails with `llm.unsupported_feature` error. If `required: false` (default), the driver ignores unknown extensions with a warning logged to the event stream. Extension types are a discriminated union validated against a schema — unknown types are caught at validation time, not silently passed through. The agent loop (Block 6) decides which extensions to request based on `capabilities().specialFeatures`.

- **Model fallback chains are explicit and model-driven, not automatic.** When the primary model is unavailable (rate limited after retries, server errors after retries, auth failure), the agent does not automatically switch to a fallback model. Instead:

  1. The provider adapter returns the error per Block 11's LLM error taxonomy
  2. The agent loop yields with the error
  3. In interactive mode, the user can switch models manually or configure a fallback chain
  4. A configured `fallbackChain` in the user config is consumed by the agent loop, not the provider adapter — the loop decides when to try the next model

  **Rationale:** Automatic fallback risks silent quality degradation (e.g., Claude → GPT-3.5 mid-task). Different models have different tokenizations, context limits, and tool-calling behaviors — switching mid-conversation can corrupt the context. Explicit fallback keeps the user aware of model changes. The `fallbackChain` is a user-level policy, not a provider-level behavior.

  **Fallback semantics when configured:** The agent loop tries the next model in the chain only on provider-level errors (`llm.rate_limited`, `llm.server_error`, `llm.timeout` after retry exhaustion). It does NOT fall back on content errors (`llm.content_filtered`), auth errors (`llm.auth_error`), or context-length errors (`llm.context_too_long`). On each fallback, the agent emits a `model.fallback` event and notifies the user via stderr: "Switching to [fallback model] due to [reason]."

- **Tool calling emulation provides transparent polyfill for providers without native support.** When `capabilities().supportsTools` is `'emulated'`, the driver injects tool definitions into the system prompt as a structured schema block and parses the model's response for tool call patterns (JSON blocks with tool name and arguments).

  The emulation is entirely inside the driver — the agent loop always sees uniform `StreamEvent` with `tool_call_delta` events. The `toolReliability` field in capabilities tells the agent loop how much to trust tool calls from this model, informing the confusion limit (Block 11): models with `'fair'` or `'poor'` reliability may warrant a higher confusion tolerance or simpler tool surfaces.

  **Rationale:** The agent loop (Block 6) must not know or care whether tools are native or emulated. The driver absorbs this complexity. Emulated tool calling works well enough for structured models (DeepSeek, Kimi) but poorly for weaker models — `toolReliability` makes this quality signal explicit.

- **Per-model token counting configuration feeds Block 7's estimator.** Each model's entry in the registry includes a `bytesPerToken` ratio (default: 3.0, overridable per model) that replaces Block 7's hardcoded `ceil(utf8ByteLength / 3)`. The per-model calibration EMA (Block 7) adjusts this ratio at runtime. This is a refinement of Block 7's existing design, not a change — Block 7 already defined the EMA mechanism; Block 17 provides the initial per-model seed values.

**Configuration (Block 9 extension):**

The `provider` config field (Block 9) is extended to support multiple providers:

```json
{
  "providers": [
    {
      "name": "nanogpt",
      "driver": "nanogpt",
      "baseUrl": "https://api.nano-gpt.com/v1",
      "timeout": 30000,
      "priority": 1
    },
    {
      "name": "anthropic-direct",
      "driver": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "timeout": 30000,
      "priority": 2
    }
  ],
  "models": {
    "aliases": {
      "claude-sonnet": "claude-sonnet-4-20250514",
      "fast": "deepseek-chat"
    },
    "fallbackChain": ["claude-sonnet-4-20250514", "gpt-4o", "deepseek-chat"]
  }
}
```

API keys remain in environment variables or `secrets.json` per Block 9's existing rules. The `priority` field determines which provider is tried first when multiple providers can serve the same model. Provider config is user-only — project config cannot set provider endpoints or API keys (Block 9 trust boundary unchanged).

**Built-in drivers shipped with v1:** `nanogpt`, `anthropic`, `openai`. Additional drivers can be added as the ecosystem evolves. Each driver is a module implementing the `ProviderDriver` interface — no plugin loading mechanism in v1.

**Integration with other blocks:**

- **Block 6 (Agent Loop):** `CallLLM` phase resolves the model, gets the driver, calls `driver.stream()`. The loop owns fallback chain logic. `NormalizeResponse` phase receives uniform `StreamEvent` regardless of provider
- **Block 7 (Context Window):** Uses `capabilities().maxContext` for budget calculation. Per-model `bytesPerToken` from registry seeds the estimator. EMA calibration unchanged
- **Block 9 (Configuration):** The nested `provider` config object is replaced by top-level `defaultProvider`, `apiTimeout`, `providers` array, and `models` object. Backward compatible: if legacy `provider` (object) is present, it is migrated to `defaultProvider` + `apiTimeout`
- **Block 11 (Error Handling):** LLM error codes unchanged. The `provider` field in error details identifies which provider produced the error. Fallback chain decisions happen after error recovery — retry within provider first, then fall back
- **Observability:** `llm.request` and `llm.response` events include `provider`, `model.requested`, `model.resolved`, and `extensions.used` fields

**Deferred:**
- Multi-provider load balancing (distributing requests across accounts/keys)
- Cost-optimized routing (selecting cheapest model that meets capability requirements)
- Model performance tracking (EMA of latency, success rate per model for ranking)
- Local model hosting (vLLM, llama.cpp, Ollama integration)
- Provider-specific prompt format optimization (chat vs. instruct templates)
- Fine-tuned model support
- Multi-modal input beyond text+vision (audio, video)

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

### Block 19: Advanced Observability

Comprehensive telemetry for debugging, cost accounting, and performance optimization. This block extends the existing Observability / Logging outline (12 core event types, append-only JSONL, dual output) with queryable storage, cost tracking, budget controls, metrics aggregation, and session analytics. The JSONL event stream remains the authoritative record; this block adds layers on top.

**Core principle: local-first observability with opt-in remote export.** All telemetry is stored locally and queryable locally. No data leaves the machine unless the user explicitly configures a remote backend. Remote telemetry sends only aggregate metrics (token counts, latencies, error rates), never conversation content. Secrets scrubbing (Block 8) runs before any telemetry pipeline.

**Foundational decisions:**

- **SQLite as queryable local store alongside authoritative JSONL.** The JSONL event stream remains the append-only source of truth (crash-safe, grepable, per-session). SQLite is a secondary store built from JSONL events, optimized for cross-session queries, aggregation, and the analytics commands.

  **Database location:** `~/.aca/observability.db` — a single SQLite database for all sessions. Created on first session if it does not exist. Schema managed by the agent (no external migration tool).

  **Core tables:**

  | Table | Purpose | Key columns |
  |---|---|---|
  | `sessions` | Session index | `session_id`, `workspace_id`, `started_at`, `ended_at`, `status`, `model`, `provider`, `total_input_tokens`, `total_output_tokens`, `total_cost_usd`, `turn_count` |
  | `events` | Flattened event index | `event_id`, `session_id`, `event_type`, `timestamp`, `agent_id`, `turn_number`, `latency_ms`, `tokens_in`, `tokens_out`, `cost_usd` |
  | `tool_calls` | Tool invocation index | `event_id`, `session_id`, `tool_name`, `status`, `duration_ms`, `input_bytes`, `output_bytes` |
  | `errors` | Error index | `event_id`, `session_id`, `error_code`, `retryable`, `provider`, `model` |

  **Write path:** Events are written to JSONL synchronously (existing design). A background writer (debounced, 1s interval) batch-inserts events into SQLite. If SQLite writes fail (disk full, corruption), the agent warns on stderr and continues — JSONL is the source of truth. On session resume, any JSONL events not yet in SQLite are backfilled.

  **Rationale:** SQLite enables queries that JSONL cannot efficiently answer: "total cost across last 7 days," "most expensive sessions," "tool failure rate by category." The async write path ensures SQLite never blocks the agent loop. `better-sqlite3` is used (synchronous API, but writes are batched in the background interval — not per-event).

- **Cost tracking maps provider-reported token counts to USD via Block 17's model registry.** The `costPerMillion` field in `ModelCapabilities` (Block 17) is the single source of truth for pricing. There is no separate pricing file — cost data lives with model metadata.

  Costs are USD per million tokens. The cost calculator multiplies provider-reported `input_tokens` and `output_tokens` by the model's `costPerMillion.input` and `costPerMillion.output` rates. If a model's cost data is not available (missing from registry), cost is recorded as `null` (unknown) — never estimated or guessed. Users can override cost rates in their user config under the `models` key (same location as model aliases and metadata overrides).

  **Cost is recorded at three levels:**
  1. Per-event: each `llm.response` event carries `cost_usd` (or null)
  2. Per-turn: accumulated from step events within the turn
  3. Per-session: accumulated from all turns, stored in the session summary

- **Budget controls provide warnings and hard stops at configurable cost thresholds.** Budgets are optional — if not configured, no limits apply.

  **Budget configuration (Block 9 extension):**
  ```json
  {
    "budget": {
      "session": 5.00,
      "daily": 25.00,
      "warning": 0.80
    }
  }
  ```

  `session`: maximum USD per session. `daily`: maximum USD across all sessions in a calendar day. `warning`: fraction of budget at which to warn (default 0.80 = 80%).

  **Enforcement uses in-memory counters, not SQLite queries.** Each session maintains an in-memory `sessionCostAccumulator` that is updated synchronously after every `llm.response` event — this is the authoritative cost for budget enforcement. SQLite is used only for historical cross-session queries (daily budget check at session start), not for real-time enforcement within a session.

  - At 80% (or configured warning threshold): stderr warning: `Budget alert: $4.00 / $5.00 session budget used (80%)`
  - At 100%: hard stop. The turn engine refuses to make further LLM calls. The turn yields with a new outcome: `budget_exceeded`. The user can override with `/budget extend <amount>` in interactive mode or restart with a higher budget
  - Daily budget: checked at session start by querying SQLite for completed sessions today, plus the current session's in-memory accumulator. The check uses per-event timestamps (`llm.response` event time), not session start time, to correctly handle sessions that span midnight

  **Rationale:** LLM API costs can accumulate rapidly during long sessions with multiple sub-agents. Hard stops prevent surprise bills. The 80% warning gives the user time to wrap up or extend. Budget config is user-only — project config cannot set budgets (Block 9 trust boundary).

- **Key metrics are aggregated in SQLite and available via CLI commands.** The agent tracks metrics that inform optimization decisions:

  | Metric | Aggregation | Purpose |
  |---|---|---|
  | Tokens per turn | mean, p50, p95 | Detect context bloat or compression effectiveness |
  | Cost per session | sum, mean | Budget planning |
  | Tool success rate | by tool name | Identify unreliable tools or common failures |
  | LLM latency | by provider/model, p50/p95 | Provider performance comparison |
  | Context compression ratio | per session | Effectiveness of Block 7's compression |
  | Error rate | by error code | Identify recurring issues |
  | Steps per turn | mean, max | Detect runaway loops or inefficient task decomposition |

  Metrics are computed on-demand from SQLite queries, not pre-aggregated. This keeps the write path simple and ensures metrics are always consistent with the underlying data.

- **CLI analytics interface: `aca stats` command.** A new subcommand (extending Block 10's command tree) provides session analytics.

  | Command | Output |
  |---|---|
  | `aca stats` | Summary of last 7 days: total sessions, total cost, tokens used, most-used tools, error rate |
  | `aca stats --session <id>` | Detailed breakdown of a specific session: per-turn cost, tool calls, errors, timing |
  | `aca stats --today` | Today's usage: sessions, cost, remaining daily budget |
  | `aca stats --json` | All stats as JSON for piping to other tools |

  **No web UI in v1.** A local dashboard server (`aca dashboard`) is deferred. The CLI command provides sufficient analytics for v1. If detailed visualization is needed, `aca stats --json` can feed external tools (jq, spreadsheets, Grafana).

- **Log retention: time-based with size cap.** Session data (JSONL + blobs) in `~/.aca/sessions/` and SQLite records are subject to retention policy.

  **Policy:**
  - Keep session data for 30 days by default
  - If total storage exceeds 5 GB, prune oldest sessions first (regardless of age)
  - Sessions older than 7 days are compressed (gzip JSONL files, remove blobs)
  - Retention policy runs on session start (not a background daemon), processing at most 10 expired sessions per startup to avoid slow starts

  **Configuration:** `retention.days` (default 30), `retention.maxSizeGb` (default 5) in user config. Retention is user-only — project config cannot override.

  **SQLite cleanup:** When a session is pruned from disk, its SQLite records are retained (they are small — just index rows). This preserves long-term cost and usage trends even after session data is deleted. A `pruned` flag on the sessions table indicates the session's detail data is no longer available.

- **Remote telemetry is opt-in, aggregate-only, and post-scrubbing.** An optional OpenTelemetry exporter sends aggregate metrics to a configured endpoint. This is for users who want to track usage across machines or teams.

  **What is sent:** Session count, total tokens, total cost, error counts by code, latency percentiles, tool usage counts. All values are numeric aggregates.

  **What is never sent:** Conversation content, tool arguments, tool results, file paths, file content, user messages, assistant messages, error messages, error details. No content of any kind leaves the machine.

  **Configuration:**
  ```json
  {
    "telemetry": {
      "enabled": false,
      "endpoint": "https://otel-collector.example.com",
      "interval": 300
    }
  }
  ```

  `enabled`: must be explicitly set to `true` (default `false`). `endpoint`: OpenTelemetry-compatible OTLP/HTTP endpoint. `interval`: export interval in seconds (default 300 = 5 minutes). Telemetry config is user-only.

  **Implementation:** Uses `@opentelemetry/api` and `@opentelemetry/exporter-metrics-otlp-http` (lightweight, well-maintained). The exporter runs in the background and does not affect agent performance. If the endpoint is unreachable, metrics are silently dropped — telemetry failure never affects agent operation.

**Integration with other blocks:**

- **Observability / Logging (existing outline):** Block 19 extends, not replaces, the existing design. The 12 event types, JSONL format, and event envelope are unchanged. Block 19 adds: SQLite indexer, cost calculator, budget enforcement, CLI stats, retention, and optional remote export
- **Block 6 (Agent Loop):** Budget enforcement hooks into `CheckYieldConditions` (phase 8). If the accumulated session cost exceeds the budget, the check yields with `budget_exceeded` outcome. This adds a 9th turn outcome to Block 5's list
- **Block 9 (Configuration):** New config groups: `budget`, `retention`, `telemetry`. All user-only fields
- **Block 8 (Permissions):** Secrets scrubbing runs before SQLite writes and before telemetry export. The scrubbing pipeline (4 points) is unchanged — SQLite writes happen after the persistence scrubbing point
- **Block 17 (Multi-Provider):** Cost rates come from the model metadata registry. Provider name and model name are indexed in SQLite for per-provider analytics

**Dependencies:**

| Package | Size | Purpose |
|---|---|---|
| `better-sqlite3` | ~2MB + native | Queryable local storage |
| `@opentelemetry/api` | ~200KB | Telemetry API (optional) |
| `@opentelemetry/exporter-metrics-otlp-http` | ~100KB | OTLP export (optional) |

**Deferred:**
- Local web dashboard (`aca dashboard`)
- Real-time streaming to remote dashboard
- Custom metric alerts (webhook, Slack)
- Anomaly detection for cost spikes
- Multi-user/team aggregation
- Compliance audit logging
- Session comparison (diff metrics between sessions)
- Token budget per-turn (not just per-session cost)

### Block 20: Rich Project Indexing & Embeddings

Semantic code understanding beyond basic file-tree detection. This block adds an embedding-based code index, AST-level symbol extraction, and semantic search to the agent's toolkit. It extends the existing Project Awareness outline (basic root detection, shallow stack detection) with deep project understanding that persists across sessions and informs context assembly.

**Core principle: index once, query fast, update incrementally.** The initial index build may take seconds to minutes depending on project size, but subsequent queries are sub-100ms and incremental updates process only changed files. The index is a local optimization — the agent functions without it (all existing tools work independently), but with it, the agent can find relevant code semantically rather than relying solely on text search and the model's own exploration.

**Foundational decisions:**

- **Embedding model runs locally via Transformers.js (WASM), no native dependencies.** The agent uses `@xenova/transformers` (now `@huggingface/transformers`) to run a small embedding model entirely in WASM. This avoids native compilation dependencies, works offline, and keeps embeddings private (no API calls for indexing).

  **Default model:** `Xenova/all-MiniLM-L6-v2` — 384-dimensional embeddings, ~23MB model file, ~80ms per embedding on a modern CPU. This is a general-purpose sentence-transformer that works well for code search (queries like "function that handles authentication" find relevant code).

  **Model download:** The WASM model files are downloaded on first use to `~/.aca/models/` and cached. The download (~23MB) happens once per model version. If the download fails (offline, network restricted), the agent warns and continues without embedding support — all other indexing (symbol extraction, file metadata) still works.

  **Why not API-based embeddings:** API calls for indexing would be slow (network latency per file), costly (thousands of embeddings for a medium project), and require network access. Local WASM embeddings are ~80ms per chunk, free, and work offline. API-based embeddings are available as an opt-in alternative for users who prefer higher-quality embeddings or need to index very large codebases faster (batch API calls).

  **Alternative embedding source (opt-in):** Users can configure `indexing.embeddingProvider` in user config to use an API-based embedding model via the provider system (Block 17). When configured, the indexer uses the provider's embedding API instead of local WASM. This is useful for large codebases where local embedding is too slow, or for users who want code-specific embedding models (e.g., `text-embedding-3-small`).

- **Index storage is per-project in SQLite, keyed by workspace ID.** Each project gets its own index database. The index is a local cache — it can be deleted and rebuilt without data loss.

  **Storage location:** `~/.aca/indexes/<workspaceId>/index.db` where `workspaceId` is the `wrk_<sha256>` from Block 5.

  **Database tables:**

  | Table | Purpose | Key columns |
  |---|---|---|
  | `files` | File metadata index | `path`, `hash` (content SHA-256), `size`, `language`, `last_indexed`, `last_modified` |
  | `chunks` | Indexed text chunks | `chunk_id`, `file_path`, `start_line`, `end_line`, `content_hash`, `embedding` (BLOB, 384 floats) |
  | `symbols` | AST-extracted symbols | `symbol_id`, `file_path`, `name`, `kind` (function, class, interface, etc.), `start_line`, `end_line`, `parent_symbol_id`, `signature` |
  | `metadata` | Index metadata | `key`, `value` (schema version, model name, last full build, file count) |

  **Index size:** For a typical 10K LOC project (~200 source files), the index is approximately 5-15 MB (dominated by embedding vectors: 384 floats × 4 bytes × ~2000 chunks ≈ 3 MB). For a 100K LOC project, approximately 30-80 MB.

- **Indexing scope: source files chunked by semantic boundaries, not fixed character counts.** The indexer processes files matching a configurable set of extensions, respecting `.gitignore` and the existing ignore rules from Project Awareness.

  **Default indexable extensions:** `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.rs`, `.go`, `.java`, `.c`, `.cpp`, `.h`, `.hpp`, `.cs`, `.rb`, `.php`, `.swift`, `.kt`, `.scala`, `.md`, `.json` (package manifests only), `.toml`, `.yaml`/`.yml` (config files only).

  **Skipped always:** `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`, `vendor/`, binary files, generated files (detected by common markers like `// @generated`, `# auto-generated`).

  **Chunking strategy:** Files are split into chunks at semantic boundaries, sized to fit the embedding model's input limit. `all-MiniLM-L6-v2` truncates at 256 word pieces (~50-60 lines of code). Chunks must stay within this limit for accurate embeddings. The chunker prioritizes:
  1. **Function/class/method boundaries** — each top-level function, class, or method becomes one chunk. If a function exceeds 50 lines, it is split into overlapping sub-chunks (10-line overlap) at the nearest statement boundary
  2. **Paragraph boundaries in docs** — markdown files split at heading boundaries
  3. **Fixed-size fallback** — if no semantic boundaries are detected, split at 50 lines with 10-line overlap

  The 50-line default chunk limit is derived from the embedding model's token limit and can be adjusted when a different model is configured. Each chunk stores its file path, line range, content hash, and embedding vector. Chunks are the unit of semantic search — queries return chunks, not whole files.

- **Symbol extraction uses regex-based heuristics, not full AST parsing.** Full AST parsing (tree-sitter) would require WASM grammars per language (~2-5MB each) and complex parser integration. For v1, the symbol extractor uses language-specific regex patterns to extract top-level declarations.

  **Extracted symbol kinds:** `function`, `class`, `interface`, `type`, `enum`, `const`, `method`, `property`, `module`/`namespace`, `export`.

  **Per-language patterns (examples):**
  - TypeScript/JavaScript: `(export\s+)?(async\s+)?function\s+(\w+)`, `(export\s+)?class\s+(\w+)`, `(export\s+)?(const|let)\s+(\w+)\s*=`, `interface\s+(\w+)`, `type\s+(\w+)\s*=`
  - Python: `def\s+(\w+)`, `class\s+(\w+)`, `(\w+)\s*=\s*`
  - Rust: `(pub\s+)?fn\s+(\w+)`, `(pub\s+)?struct\s+(\w+)`, `(pub\s+)?enum\s+(\w+)`, `impl\s+(\w+)`
  - Go: `func\s+(\w+)`, `func\s+\((\w+)\s+\*?(\w+)\)\s+(\w+)`, `type\s+(\w+)\s+struct`

  **Symbol hierarchy:** Methods are linked to their parent class/struct via `parent_symbol_id`. This enables queries like "methods of class Foo" without full AST traversal.

  **Limitations:** Regex-based extraction misses some declarations (complex destructuring, decorated functions, dynamic definitions). This is acceptable for v1 — the symbol index is an optimization for search, not a correctness requirement. The LSP integration (existing `lsp_query` tool) provides accurate symbol information when available.

- **Semantic search is exposed as a new tool: `search_semantic`.** This tool queries the embedding index to find code semantically related to a natural-language query.

  | Tool | What it does | Input | Output |
  |---|---|---|---|
  | `search_semantic` | Find code chunks semantically similar to a query | `query` (string), `limit` (default 10), `file_filter` (optional glob), `min_score` (optional, 0-1) | Ranked results: `{ path, startLine, endLine, score, snippet, symbols }` |

  **Approval class:** `read-only` (no side effects, auto-approved).

  **Search algorithm:** The query string is embedded using the same model as the index. Cosine similarity is computed against all chunk embeddings. Results are ranked by score and filtered by `min_score` (default 0.3). The search runs entirely in-memory — chunk embeddings are loaded from SQLite into a float array at session start (for typical projects, this is < 10MB of memory).

  **Integration with `search_text`:** `search_semantic` complements, not replaces, `search_text`. `search_text` is exact (regex/literal), `search_semantic` is fuzzy (natural language). The model chooses which to use. There is no automatic hybrid search in v1 — the model explicitly calls one or the other.

  **Result shape:** Each result includes the chunk's file path, line range, similarity score (0-1), a snippet of the matching text (first 5 lines), and any symbols defined within the chunk (from the symbol table). This gives the model enough context to decide whether to `read_file` the full section.

- **Incremental updates keep the index fresh as files change during a session.** The index must reflect the current state of the workspace, not the state at session start.

  **Update triggers:**
  1. **Session start:** Compare `files.hash` against current file hashes. Re-index changed files. This catches changes made between sessions (manual edits, git operations)
  2. **After write tools:** When `write_file` or `edit_file` modifies a file, the indexer re-indexes that file's chunks and symbols. This is synchronous but fast (single file ≈ 100-200ms including embedding)
  3. **After `exec_command`:** If the command modifies tracked files (detected by comparing file mtimes before/after), re-index affected files

  **No file watching in v1.** File system watchers (chokidar, fs.watch) add complexity and resource usage. The trigger-based approach covers all changes made through the agent's tools. Changes made outside the agent (e.g., in an editor) are picked up at the next session start or can be manually triggered via a `/reindex` slash command.

  **Hash-based skip:** Files whose content hash matches the indexed hash are skipped during incremental updates. Only changed files are re-embedded.

- **Performance targets and resource limits.**

  | Metric | Target | Limit |
  |---|---|---|
  | Initial index (10K LOC, ~200 files) | < 30s | Hard timeout: 120s |
  | Initial index (100K LOC, ~2000 files) | < 5 min | Hard timeout: 10 min |
  | Incremental update (single file) | < 200ms | — |
  | Semantic query | < 100ms | — |
  | Memory (embeddings loaded) | < 50MB for 10K LOC | Hard cap: 200MB |
  | Disk (index database) | < 15MB for 10K LOC | — |

  **Initial index is deferred to background when possible.** On first session in a project (no existing index), the indexer runs during the startup pipeline (Block 10 Phase 6). If the project is small (< 500 files), indexing completes before the first turn. If large (> 500 files), the indexer starts in the background and the agent proceeds without embedding support — `search_semantic` returns `{ status: "error", code: "indexing_in_progress", retryable: true }` until the index is ready. A stderr progress indicator shows indexing progress.

**Configuration (Block 9 extension):**
```json
{
  "indexing": {
    "enabled": true,
    "embeddingModel": "Xenova/all-MiniLM-L6-v2",
    "embeddingProvider": null,
    "extensions": [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go"],
    "maxFileSize": 102400,
    "maxFiles": 5000
  }
}
```

`enabled`: master switch (default `true`). `embeddingProvider`: if set, use API-based embeddings via Block 17 instead of local WASM. `maxFileSize`: skip files larger than this (default 100KB — large files are usually generated). `maxFiles`: limit total indexed files (default 5000 — prevents runaway indexing on monorepos). All fields are project-safe in config (project config can narrow these, e.g., reduce `maxFiles`).

**Integration with other blocks:**

- **Project Awareness (existing):** Block 20 extends the shallow detection with deep indexing. The `ProjectSnapshot` gains an `indexStatus` field: `{ status: 'ready' | 'building' | 'unavailable', fileCount, chunkCount, symbolCount, lastBuildTime }`
- **Block 7 (Context Window):** The `FileActivityIndex` (Block 7) can be seeded from the project index's symbol table — files with more defined symbols in the user's area of interest score higher. This is a refinement, not a change to Block 7's algorithm
- **Block 6 (Agent Loop):** The `search_semantic` tool is registered like any other tool. No special phase integration needed
- **Block 10 (CLI Interface):** New slash command `/reindex` triggers a full rebuild of the project index. New `aca stats` sub-display shows index status
- **Block 8 (Permissions):** The index database is read-only from the tool's perspective (the model cannot write to it via tools). The indexer writes to it internally. Index files are in `~/.aca/indexes/`, outside the workspace — no sandbox implications

**Dependencies:**

| Package | Size | Purpose |
|---|---|---|
| `@huggingface/transformers` | ~2MB (+ ~23MB WASM model, downloaded on first use) | Local embedding computation |
| `better-sqlite3` | ~2MB + native | Index storage (shared with Block 19) |

**Deferred:**
- Full AST parsing via tree-sitter WASM (accurate symbol extraction, type relationships)
- Cross-reference resolution (find all callers/usages of a symbol)
- Code change impact analysis (which tests cover which functions)
- Import/dependency graph construction
- Architecture pattern detection
- Multi-repository indexing
- Embedding model fine-tuning for code-specific queries
- Hybrid search (combining text and semantic results with rank fusion)
- Code similarity detection (duplicate/near-duplicate code)
- Git-blame-aware indexing (who wrote what, when)

## Deferred to Implementation

| Decision | Why later |
|---|---|
| Sophisticated context compression | Start with truncation, improve later |
| HTTP/IPC transport bindings | CLI-first is sufficient |
| Plugin marketplace / third-party discovery | Delegation contract is sufficient foundation |
| Streaming implementation details | Delivery UX, not architecture |

## Tech Stack

- TypeScript on Node.js
- Runs in Linux terminal (WSL2)
- Provider-agnostic LLM API (NanoGPT primary — access to Kimi, DeepSeek, Claude, and others through one API key)
