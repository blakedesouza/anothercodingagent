# M5.8 Handoff — CLI Wiring + Integration Test

**Date:** 2026-04-03
**Status:** M5.7 complete. Ready for M5.8.

## What's Done (M5.7)

| Deliverable | Status | Tests |
|---|---|---|
| `TelemetryExporter` class (OTLP/HTTP JSON export) | Complete | 11 |
| `formatOtlpPayload` (6 aggregate metrics) | Complete | 8 |
| `telemetry` config in ResolvedConfig + defaults | Complete | 0 (schema validated) |
| Trust boundary: telemetry user-only | Complete | 2 |
| Pre-serialization scrubbing | Complete | 1 |
| Double-start guard | Complete | 1 |
| Concurrent export guard | Complete | 0 (covered by interval tests) |
| NaN/Infinity safety | Complete | 0 (covered by gauge/sum tests) |
| **Total project tests** | | **1257** |

## What to Do Next (M5.8)

**M5.8 — CLI Wiring + Integration Test (All Blocks):**

Wire all M1-M5 modules into `src/index.ts` and verify end-to-end against real NanoGPT API. Much of this is already done (16 tools registered, config loader, renderer, scrubber, cost tracker wired). Remaining work:

- [ ] Wire `WorkspaceSandbox` (zone enforcement) into tool context
- [ ] Wire `ApprovalFlow` (confirm/deny/always) into tool execution
- [ ] Wire `NetworkPolicy` into tool context
- [ ] Wire `EventSink` + `BackgroundWriter` + `SqliteStore` for observability
- [ ] Wire `CostTracker` with budget config into TurnEngine
- [ ] Wire `ProviderRegistry` with fallback chains
- [ ] Wire `TelemetryExporter` (new from M5.7) with config + store + scrubber
- [ ] Real API smoke test: send prompt → receive streamed response
- [ ] Real tool test: `read_file` tool executes and result is used
- [ ] Real write test: approval prompt appears, file is created
- [ ] Real exec test: risk analysis and approval flow

**Note:** M5.8 is the **final substep** of Milestone 5. Post-milestone review (high risk: arch + security + bug hunt) runs after approval.

## Dependencies

- **TelemetryExporter** (`src/observability/telemetry.ts`): new from M5.7, needs wiring
- **All M1-M5 modules**: must be importable and functional
- **NanoGPT API key**: required for real API tests (`~/.api_keys` or `NANOGPT_API_KEY` env)

## File Locations

- Step file: `docs/steps/05-milestone5-provider-obs.md`
- Main entry point: `src/index.ts`
- Telemetry module: `src/observability/telemetry.ts`
- Config schema: `src/config/schema.ts`
