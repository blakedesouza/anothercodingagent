# M1.5 Handoff — Tool Runtime Contract

**Date:** 2026-03-30
**Status:** M1.4 complete. Ready for M1.5 implementation.

## What's Done (M1.4)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `ProviderDriver` interface (capabilities, stream, validate) | Complete | 22 tests |
| `ModelCapabilities` type with `bytesPerToken` | Complete | Covered above |
| Hardcoded model registry (7 models) | Complete | Covered above |
| `ModelRequest` type, `StreamEvent` tagged union | Complete (Phase 0 types) | Covered above |
| `NanoGptDriver` (validate, capabilities, stream) | Complete | Covered above |
| SSE stream parser (reusable module) | Complete | Covered above |
| Error mapping (429/401/5xx/timeout/400) | Complete | Covered above |

**Total tests: 95 passing** (73 prior + 22 new).

**Consultation:** 4 witnesses reviewed M1.4 (all responded, 1 rebuttal round). 4 fixes applied:
1. Timeout covers full request+stream lifecycle (was only fetch handshake)
2. response.body.cancel() on all exit paths (TCP cleanup)
3. releaseLock() wrapped in try/catch (defensive)
4. HTTP 400 → llm.invalid_request (was server_error)

## What to Do Next (M1.5)

Execute M1.5 from `docs/steps/01-milestone1-agent-loop.md`.

### M1.5 — Tool Runtime Contract (Block 15 minimal)

- [ ] `ToolRegistry`: register tools by name, look up tool by name, list all tools
- [ ] `ToolDefinition`: name, description, inputSchema (JSON Schema), approvalClass, idempotent, timeoutCategory
- [ ] `ToolRunner.execute(toolName, args, context)`: lookup → validate args → apply timeout → call impl → validate output → enforce 64 KiB cap → return ToolOutput
- [ ] Validation failure → ToolOutput with `status: "error"`, `error.code: "tool.validation"`
- [ ] Timeout handling: graceful signal → 2s grace → force kill
- [ ] Auto-retry for transient errors on idempotent tools (3 attempts, exponential backoff 250ms)
- [ ] Non-idempotent tools: no auto-retry

### Tests Required

- Register/lookup/list tools
- Valid/invalid args → execute or validation error
- 64 KiB output truncation
- Timeout → tool.timeout error
- Contract violation (malformed output)
- Tool exception → tool.crash error
- Retry with fake timers (idempotent vs non-idempotent)

## Dependencies

- `ToolOutput` type from `src/types/conversation.ts` (already defined in M1.1)
- `AcaError` / `TypedError` from `src/types/errors.ts`
- `ajv` package needed for JSON Schema validation (not yet in package.json)

## File Locations

| New File | Purpose |
|----------|---------|
| `src/tools/tool-registry.ts` | ToolRegistry class + ToolDefinition type |
| `src/tools/tool-runner.ts` | ToolRunner class (execute with validation, timeout, retry) |
| `test/tools/tool-runner.test.ts` | All M1.5 tests |

## Architecture Notes

- `ajv` must be added as a dependency for JSON Schema validation
- Timeout categories: `file` (5s), `shell` (60s), `network` (30s), `compute` (120s)
- The 64 KiB cap applies to serialized ToolOutput.data, not the entire envelope
- Auto-retry only for: connection reset, timeout, 429, 502, 503, 504
