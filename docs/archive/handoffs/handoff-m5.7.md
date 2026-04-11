# M5.7 Handoff — Remote Telemetry

**Date:** 2026-04-03
**Status:** M5.6 complete. Ready for M5.7.

## What's Done (M5.6)

| Deliverable | Status | Tests |
|---|---|---|
| `runRetention()` 3-phase policy (prune/compress/size-cap) | Complete | 4 |
| SQLite `pruned` column + migration | Complete | 1 |
| `markSessionPruned()` (only on success) | Complete | 1 |
| `RetentionConfig` in `ResolvedConfig` (user-only) | Complete | 0 (schema validated) |
| Max 10 sessions per startup | Complete | 1 |
| Null store support | Complete | 1 |
| Edge cases (empty dir, nonexistent, already compressed) | Complete | 3 |
| **Total project tests** | | **1237** |

## What to Do Next (M5.7)

**M5.7 — Remote Telemetry (Block 19, opt-in):**

- [ ] `telemetry` config: `enabled` (default false), `endpoint` (OTLP/HTTP URL), `interval` (seconds, default 300)
- [ ] Telemetry config is user-only (project config cannot enable)
- [ ] `@opentelemetry/api` + `@opentelemetry/exporter-metrics-otlp-http` for export
- [ ] Exports aggregate metrics only: session count, total tokens, total cost, error counts by code, latency percentiles, tool usage counts
- [ ] Never exports: conversation content, tool arguments/results, file paths/content, user/assistant messages, error details
- [ ] Secrets scrubbing (Block 8) runs before telemetry export
- [ ] Background export at configured interval, non-blocking
- [ ] Unreachable endpoint → silently drop metrics, never affect agent operation

## Dependencies

- **SqliteStore** (`src/observability/sqlite-store.ts`): aggregate queries for metrics
- **SecretScrubber** (`src/permissions/secret-scrubber.ts`): runs before export
- **Config** (`src/config/schema.ts`): needs `telemetry` config group (user-only)
- **Trust boundary** (`src/config/trust-boundary.ts`): telemetry must be user-only

## File Locations

- Step file: `docs/steps/05-milestone5-provider-obs.md`
- Spec: Block 19 in `docs/spec/19-observability-advanced.md`
- New source: `src/observability/telemetry.ts` (suggested)
- New deps: `@opentelemetry/api`, `@opentelemetry/exporter-metrics-otlp-http`
- Modify: `src/config/schema.ts` (add telemetry config)
- Modify: `src/config/trust-boundary.ts` (telemetry user-only)
