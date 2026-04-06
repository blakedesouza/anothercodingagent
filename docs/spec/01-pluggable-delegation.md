<!-- Source: fundamentals.md lines 16-196 -->
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

- `aca describe --json` returns the capability descriptor including both `contract_version` and `schema_version`
- `aca invoke --json` reads structured input from stdin and returns structured output on stdout
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
