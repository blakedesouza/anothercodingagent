<!-- Source: fundamentals.md lines 1747-1768 -->
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
