<!-- Source: 07-milestone7-delegation.md (reordered and split) -->
# ACA Implementation Steps — Milestone 7, Part A: Error Handling, Health, Security

Error taxonomy, health tracking, and security extensions must be defined BEFORE the delegation, LSP, browser, and web tools that depend on them.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure

---

## Milestone 7A: Error Handling + Health + Security Extensions

### M7.7a — Error Taxonomy + LLM Retry Policies (Block 11)

> **Must be first in M7.** Error codes are referenced by retry logic, health tracking, tool masking, and delegation error chains.

- [x] Full 22 error codes across 4 categories (tool, llm, delegation, system)
- [x] `AcaError` shape construction and serialization for all codes
- [x] LLM retry policies (total attempts including initial): rate limit 5, server 3, timeout 2, malformed 2, context 1+compress, auth/filter 0 (fail immediately)
- [x] Per-call retry state (not global) — each LLM call has own retry counter/backoff
- [x] Health state updates after retry exhaustion (rate limit → degraded w/ cooldown, server error → degraded, timeout → degraded, auth → unavailable session-terminal)
- [x] Mode-dependent error formatting (interactive, one-shot, executor)

**Tests:**
- Individual error code construction (parameterized, 22 cases): for each code in `[tool.not_found, tool.validation, tool.execution, tool.timeout, tool.permission, tool.sandbox, llm.rate_limit, llm.server_error, llm.timeout, llm.malformed, llm.context_length, llm.auth_error, llm.content_filtered, llm.confused, delegation.spawn_failed, delegation.timeout, delegation.depth_exceeded, delegation.message_failed, system.io_error, system.config_error, system.budget_exceeded, system.internal]` → construct with message + optional details → serializes to JSON with `{ code, message, retryable, details? }` shape
- Retry policy table (parameterized, all 22 codes):
  - `tool.*` (not_found, validation, execution, permission, sandbox): retryable=false, attempts=1 (no retry)
  - `tool.timeout`: retryable=conditional (idempotent only), attempts=3, backoff=250ms exponential
  - `llm.rate_limit`: attempts=5, backoff=2x exponential with ±20% jitter, cap=60s → health=degraded
  - `llm.server_error`: attempts=3, backoff=1s base exponential, cap=16s → health=degraded
  - `llm.timeout`: attempts=2, timeout scaled to 150% → health=degraded
  - `llm.malformed`: attempts=2, no backoff (immediate retry)
  - `llm.context_length`: attempts=1+compress (escalate tier + 10% guard, retry once)
  - `llm.auth_error`: attempts=1 (no retry) → health=unavailable (session-terminal)
  - `llm.content_filtered`: attempts=1 (no retry), surfaced as system message
  - `llm.confused`: attempts=1 (no retry, handled by confusion limits)
  - `delegation.spawn_failed`: attempts=1 (no retry)
  - `delegation.timeout`: attempts=2 (retry once)
  - `delegation.depth_exceeded`: attempts=1 (no retry)
  - `delegation.message_failed`: attempts=2 (retry once if cause.retryable)
  - `system.*` (io_error, config_error, budget_exceeded, internal): attempts=1 (no retry)
- Rate limit retry: mock 429 → 5 total attempts (4 retries) with backoff → yields error after exhaustion
- Server error: mock 500 → 3 total attempts (2 retries) → provider health marked `degraded` after exhaustion
- Timeout: mock slow response → retries once with 150% timeout → provider health marked `degraded` after exhaustion
- Auth error: mock 401 → no retry, immediate `llm.auth_error`, provider marked unavailable
- Content filter: mock refusal → no retry, surfaced to model as system message
- Malformed response: mock bad JSON → 2 total attempts (1 retry), immediate retry with no backoff delay (retries instantly, not after exponential wait)
- Context too long: mock rejection → escalate compression tier + 10% guard, retry once
- Per-call state: rate limit on call N does not affect call N+1 retry budget
- Interactive error format → compact stderr line
- Executor error format → structured JSON on stdout

### M7.7b — Confusion Limits (Block 11)

- [x] Per-turn confusion counter: consecutive invalid tool calls
- [x] Threshold 1-2: synthetic ToolResultItem with validation error, model gets another step
- [x] Threshold 3: turn yields with outcome `tool_error` and error code `llm.confused`
- [x] Per-session cumulative limit: 10 total confusion events
- [x] At 10 cumulative: inject persistent system message nudging simpler tool use

**Tests:**
- Confusion failure 1: 1 bad tool call → synthetic ToolResultItem with validation error injected, model gets another step (turn does NOT yield)
- Confusion failure 2: 2 consecutive bad tool calls → same behavior as failure 1 (synthetic error + continue, still under threshold)
- Confusion failure 3: 3 consecutive bad tool calls → turn yields with outcome `tool_error` and error code `llm.confused`
- Counter reset: bad call → bad call → successful tool call → bad call → counter is 1 (not 3), model continues
- Per-turn limit boundary: exactly 3 consecutive bad calls → turn yields. 2 consecutive → does NOT yield (threshold is 3, not 2)
- Per-session cumulative limit boundary: 9 cumulative confusion events → no system message. 10th event → persistent system message injected nudging simpler tool use
- Cumulative counter does NOT reset between turns (session-wide)
- What counts: JSON parse failure, unknown tool name, missing required param, type mismatch, parameter value outside allowed enum
- What doesn't count: tool execution failure, approval denial, tool timeout

### M7.13 — Capability Health Tracking (Block 1: Health)

> **Before tool masking (M7.7c).** Health states must exist before tools can be masked based on them.

- [x] `CapabilityHealthMap`: per-session, in-memory, keyed by capability identifier
- [x] 4 states: unknown, available, degraded, unavailable
- [x] State transitions: defined per the transition table in spec
- [x] Asymmetric policies: local processes (restart once → unavailable) vs HTTP (cooldown + circuit breaker)
- [x] Circuit breaker: 2 consecutive failures → unavailable with cooldown
- [x] LLM visibility: only degraded/unavailable injected into context

**Tests:**
- Initial state → unknown
- Successful invocation → available
- Retryable failure → degraded
- Non-retryable failure → unavailable
- Local process crash → restart once → available. Second crash → unavailable (session-terminal)
- HTTP rate limit → degraded with cooldown (base 5s) → cooldown expires → state reverts to unknown → next success → available
- Cooldown timing: base=5s, exponential backoff on repeated failures, cap=60s. Verify with fake timers: first cooldown=5s, second=10s, third=20s, fourth=40s, fifth=60s (capped)
- Circuit breaker: 2 consecutive final failures → unavailable with cooldown. Cooldown expiry → unknown (not directly available)
- LLM context: degraded capability → health line present. Available → no health line
- Session-terminal unavailable (local) → no cooldown expiry, stays unavailable

### M7.7c — Degraded Capability Handling + Tool Masking (Block 11)

> Depends on M7.13 (health states) and M7.7a (error codes).

- [x] `available`: normal operation, tool in definitions, no health line
- [x] `degraded`: tool stays in definitions, health context injected
- [x] `unavailable`: tool REMOVED from definitions sent to LLM
- [x] If model references masked tool: `tool.validation` with alternatives message
- [x] Delegation error chains: nested `cause` for root-cause traversal across depth

**Tests:**
- Tool masking: mark LSP unavailable → lsp_query removed from tool definitions sent to LLM
- Degraded capability → health line present in context block, tool still available
- Model tries masked tool → `tool.validation` error with alternatives listed
- Delegation error chain: grandchild error → nested cause through child → root sees leaf cause
- Error chain depth: root → child → grandchild → 3 levels of nested cause

### M7.10 — Network Egress Integration (Block 8, extends M2.7)

> Foundation built in M2.7. This step extends with advanced integration. **Must precede M7.5 (Web Capabilities).**

- [x] Integrate network policy into Playwright/browser tool calls (domain check before navigation)
- [x] Integrate network policy into `fetch_url` tier selection (HTTP vs Playwright fallback)
- [x] Localhost exception refinement: auto-allowed for `fetch_url`/`web_search` but NOT for `exec_command` shell detection (shell can do anything once running)
- [x] Shell command network detection: extend M2.7's basic detection with `ssh`, `scp`, `rsync`, `docker pull`, `pip install`, `cargo install`
- [x] Network events: `network.checked` event with domain, mode, decision

**Tests:**
- Browser navigate to denied domain → blocked before page load
- `fetch_url` with mode=off → `network_disabled` error
- `fetch_url` HTTP fallback to Playwright → Playwright also checks network policy
- Localhost exception: `fetch_url http://localhost:3000` → allowed. `exec_command "curl localhost"` → best-effort detection, not auto-allowed
- Shell network detection (parameterized, 6 commands): each of `ssh user@host`, `scp file host:`, `rsync -a dir host:`, `docker pull image`, `pip install package`, `cargo install crate` with network mode=off → denied with `network_disabled` error
- Network event emitted with decision details

### M7.8 — Secrets Scrubbing — Pattern Detection (Block 8, extends M2.8)

> Foundation built in M2.8 (exact-value redaction). This step adds pattern-based detection for unknown secrets.

- [x] Strategy 2: pattern detection — API key prefixes (`sk-`, `pk_test_`, `AKIA`, `ghp_`, `ghs_`, `glpat-`), Bearer tokens, PEM keys, `.env` assignments, connection strings, JWTs
- [x] False positive recovery: `scrubbing.allowPatterns` in user config
- [x] NOT scrubbed: SHA-256 hashes, UUIDs, base64 non-secrets, hex strings without labels
- [x] Integration with M2.8's 4-point pipeline (same scrub function, extended patterns)

**Tests:**
- `sk-` prefix string → redacted (provider key prefix)
- `Bearer eyJ...` → redacted
- `-----BEGIN RSA PRIVATE KEY-----` → redacted
- `API_KEY=abc123` in .env-style output → redacted
- `postgres://user:password@host/db` → connection string redacted
- SHA-256 hash → NOT redacted
- UUID → NOT redacted
- Hex string without secret label → NOT redacted
- allowPatterns: add pattern → matching string exempt from redaction
- Combined pipeline: both exact-value (M2.8) and pattern detection active simultaneously

---
