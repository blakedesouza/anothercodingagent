# M7.14 Handoff — OpenTelemetry Export (Block 19)

**Date:** 2026-04-04
**Status:** M7.12 complete. Ready for M7.14.

## What's Done (M7.12)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `aca "task"` one-shot execution | Complete | 3 |
| Piped input `echo "task" \| aca` | Complete | — |
| `--no-confirm` flag (autoConfirm) | Complete | 2 |
| `-r, --resume [session]` one-shot | Complete | 2 |
| TTY inline approval prompts | Complete | 2 |
| Exit code mapping (0/1/2/3/4) | Complete | 7 |
| session.ended + manifest in finally | Complete | — |
| 4 consultation fixes applied | Complete | — |
| **Total** | **M7.12 complete** | **15 new, 2118 total** |

## What to Do Next (M7.14)

From `docs/steps/07c-milestone7-capabilities.md`:

- Opt-in via `telemetry.enabled: true`
- `@opentelemetry/api` + `@opentelemetry/exporter-metrics-otlp-http`
- Aggregate metrics only: session count, tokens, cost, error counts, latency percentiles
- Never sends: content, file paths, messages, arguments
- Configurable endpoint and interval (default 300s)
- Failure → silent drop, no impact on agent

## Dependencies

- M5.7: TelemetryExporter (already built — custom OTLP/HTTP export)
- Block 19: Advanced Observability spec
- Config: `telemetry` section in ResolvedConfig (already defined)

## File Locations

- Existing telemetry: `src/observability/telemetry.ts` (TelemetryExporter with custom OTLP)
- Config schema: `src/config/schema.ts` (telemetry config section)
- CLI wiring: `src/index.ts` (TelemetryExporter already instantiated)
- Spec: `docs/spec/19-advanced-observability.md`
