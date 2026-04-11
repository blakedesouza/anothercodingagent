# M1.4 Handoff — Provider Interface + NanoGPT Driver

**Date:** 2026-03-30
**Status:** M1.3 complete. Ready for M1.4 implementation.

## What's Done (M1.3)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `SessionManager.create(workspaceRoot)`: generate ID, create dir, write manifest | Complete | 12 tests |
| `SessionManager.load(sessionId)`: read manifest, rebuild projection from JSONL | Complete | Covered above |
| `manifest.json` schema (sessionId, workspaceId, status, turnCount, etc.) | Complete | Covered above |
| `workspaceId` derivation: `wrk_<sha256(normalizedAbsolutePath)>` | Complete | Covered above |
| In-memory projection (items, turns, steps, sequence counter, current turn) | Complete | Covered above |
| Atomic manifest writes (write-to-temp-then-rename) | Complete | Covered above |
| `TypedError` class (throwable Error with AcaError fields) | Complete | Covered above |
| Session ID format validation (ULID regex) | Complete | Covered above |

**Total tests: 73 passing** (61 prior + 12 new).

**Consultation:** 4 witnesses reviewed M1.3 (all responded). 3 fixes applied:
1. Atomic manifest writes via write-to-temp-then-rename (crash safety)
2. JSON.parse wrapped in try/catch → `session.corrupt` TypedError
3. Session ID format validation before path construction

## What to Do Next (M1.4)

Execute M1.4 from `docs/steps/01-milestone1-agent-loop.md`.

### M1.4 — Provider Interface + NanoGPT Driver (Block 17 minimal)

- [ ] `ProviderDriver` interface: `capabilities(model)`, `stream(request)`, `validate(config)`
- [ ] `ModelCapabilities` type: maxContext, maxOutput, supportsTools, supportsStreaming, costPerMillion, bytesPerToken (default 3.0)
- [ ] Minimal hardcoded model registry: map of model ID → `ModelCapabilities`
- [ ] `ModelRequest` type: model, messages, tools?, maxTokens, temperature, extensions?
- [ ] `StreamEvent` tagged union: `text_delta`, `tool_call_delta`, `done`, `error`
- [ ] `NanoGptDriver` implementation (validate, capabilities, stream)
- [ ] SSE stream parser: handle `data: [DONE]`, partial chunks, connection errors
- [ ] Response normalization: NanoGPT format → canonical `StreamEvent`
- [ ] Error mapping: 429→rate_limited, 401→auth_error, 5xx→server_error, timeout→timeout

### Tests Required

- `validate()` with missing API key returns ConfigError
- `capabilities()` returns correct maxContext for known models
- Mock HTTP server: text stream, tool call stream, 429, 500, timeout, malformed SSE
- StreamEvent reconstruction from deltas
- Stream interruption, slow stream, empty stream

## Dependencies

- M1.1 types: already defined in `src/types/provider.ts` (ProviderDriver, ModelCapabilities, ModelRequest, StreamEvent, etc.)
- `TypedError` from `src/types/errors.ts` (for error wrapping)
- Mock HTTP server helper: `test/helpers/mock-nanogpt-server.ts` (already exists from Phase 0)

## File Locations

| New File | Purpose |
|----------|---------|
| `src/providers/nanogpt-driver.ts` | NanoGPT driver implementing ProviderDriver |
| `src/providers/model-registry.ts` | Hardcoded model→capabilities mapping |
| `src/providers/sse-parser.ts` | SSE stream parser |
| `test/providers/nanogpt-driver.test.ts` | All M1.4 tests |

## Architecture Notes

- Provider types already exist in `src/types/provider.ts` (defined in Phase 0)
- NanoGPT uses OpenAI-compatible chat completions API
- SSE parser should be its own module (reusable for future providers)
- Model registry is a simple hardcoded Map for now; M5.1 replaces with file-based `models.json`
