# Milestone 1 Handoff — Minimal Agent Loop

**Date:** 2026-03-30
**Status:** M1.1 complete (51 tests). M1.2+ in progress. See `docs/handoff-m1.2.md` for next step.

## What's Done (Phase 0)

| Deliverable | Commit | Tests |
|-------------|--------|-------|
| ESM TypeScript project (strict, Node 20+, path aliases) | 7f65065 | Build passes |
| CLI stub (commander, --help, --version) | 7f65065 | CLI exits cleanly |
| vitest + snapshot config + path alias resolution | 7f65065 | 27 tests pass |
| ESLint (no-explicit-any, ban-ts-comment) | 7f65065 | Lint clean |
| Block 5 types (Session, Turn, Step, ConversationItem, DelegationRecord, TurnOutcome) | 7f65065 | Factory tests |
| Block 17 types (ProviderDriver, StreamEvent, ModelRequest, ModelCapabilities, Result) | 7f65065 | Type-checked |
| Mock NanoGPT HTTP server (SSE, tool calls, errors, delays) | 7f65065 | 9 server tests |
| Test session factory | 7f65065 | 11 factory tests |
| Test fixtures (small, large, binary, empty, multibyte) | 7f65065 | 5 fixture tests |

**Phase 0 Consultation:** 3 external AI witnesses reviewed. 2 fixes applied (DelegationRecord, validate() return type). All other findings rejected with reasoning.

**M1 Pre-flight Consultation (2026-03-29):** MiniMax M2.7 + Kimi K2.5 reviewed (DeepSeek empty). 5 type reconciliation issues confirmed valid. Fixes applied to this handoff: (1) keep `kind` in-memory, map to `recordType` at serialization, (2) `ToolOutput.error` → `AcaError`, (3) add `stepNumber` to StepRecord, (4) add `bytesPerToken` to ModelCapabilities, (5) use `ToolRegistration` name for system-facing tool definition.

## What to Do Next

Execute `docs/steps/01-milestone1-agent-loop.md` — 10 substeps, sequentially.

### M1.1 — Core Data Types (Block 5)
Most types already exist from Phase 0. Remaining work:
- Replace `generateId()` placeholder with proper ULID (install `ulid` package)
- Add `AcaError` type (code, message, retryable, details?, cause?)
- Change `ToolOutput.error` from `string` to `AcaError` (M1.5 requires `error.code`)
- Add `bytesOmitted` to ToolOutput envelope
- Add `stepNumber: number` to `StepRecord`
- Add monotonic sequence number generator (class, not module-level counter)
- Serialization round-trip tests

**Discriminator note:** Keep `kind` as the in-memory discriminator on ConversationItem variants. The JSONL serialization layer (M1.2) will map `kind` → `recordType` at the write boundary. Do NOT rename `kind` → `recordType` on the types themselves.

### M1.2 — JSONL Conversation Log
- ConversationWriter (append) + ConversationReader (parse)
- Crash-safe writes, malformed line handling

### M1.3 — Session Manager
- Create/load sessions at `~/.aca/sessions/<ses_ULID>/`
- manifest.json lifecycle, workspace ID derivation

### M1.4 — Provider Interface + NanoGPT Driver
- Real NanoGPT driver (SSE parsing, error mapping)
- Add `bytesPerToken: number` to `ModelCapabilities` (default 3.0, needed by M3.1)
- Mock server from Phase 0 is ready for testing

### M1.5 — Tool Runtime Contract
- `ToolRegistration` type (distinct from LLM-facing `ToolDefinition`): name, llmSchema, inputSchema, approvalClass, idempotent, timeoutCategory
- ToolRegistry, ToolRunner with validation (ajv), timeouts, 64 KiB cap
- Auto-retry for idempotent tools

### M1.6 — read_file Tool
- First real tool, exercises the full pipeline

### M1.6b — User Interaction Tools
- ask_user, confirm_action (TTY-dependent)

### M1.7 — Agent Loop / Turn Engine
- The heart: 12-phase state machine, step limits, tool execution
- Depends on M1.1–M1.6b

### M1.8 — Basic REPL
- readline-based interactive CLI
- Slash commands (/exit, /quit, /help, /status)
- SIGINT handling

### M1.9 — Event System
- EventSink, 12 event types, JSONL event writer

### M1.10 — Integration Smoke Test
- End-to-end: user input → tool call → tool result → response
- Verify conversation.jsonl, events.jsonl, manifest.json

## Key Files

| File | Purpose |
|------|---------|
| `docs/steps/01-milestone1-agent-loop.md` | **Detailed step spec with tests** |
| `docs/spec/05-conversation-state.md` | Block 5 type definitions |
| `docs/spec/06-agent-loop.md` | Turn engine phases |
| `docs/spec/17-multi-provider.md` | Provider driver interface |
| `docs/spec/15-tool-runtime.md` | Tool runtime contract |
| `src/types/` | Existing type definitions (extend, don't rewrite) |
| `test/helpers/mock-nanogpt-server.ts` | Mock server (ready for M1.4) |
| `test/helpers/session-factory.ts` | Session factory (ready for M1.3) |

## Architecture Notes

- **NanoGPT only in M1.** Multi-provider abstraction comes in M5
- **No context compression in M1.** AssembleContext sends full history
- **Sequential tool execution.** Parallel execution is M2+
- **readFile is the only tool.** Other tools come in M2
- **No config file loading in M1.** API key from env var only

## Session Rules

- Small batches (1-2 substeps then checkpoint)
- Test-first: write tests before/alongside implementation
- Update plan.md after each substep
- Update changelog.md after meaningful work
- Consult external AI after completing the full milestone
