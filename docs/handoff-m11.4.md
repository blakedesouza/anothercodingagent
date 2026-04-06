# M11.5 Handoff — Witness Limit Uplift

**Date:** 2026-04-05
**Status:** M11.4 complete. Ready for M11.5.

## What's Done (M11.4)

| Deliverable | Status | Tests |
|---|---|---|
| Idle timeout pattern verified (3 drivers) | Complete | — |
| Enhanced idle vs hard timeout comments | Complete | — |
| MockNanoGPTServer `hangAfterSend` | Complete | — |
| MockAnthropicServer `raw_stream` + `chunkDelayMs` | Complete | — |
| Slow-but-active stream survival tests (3 drivers) | Complete | 3 |
| Mid-stream silence timeout tests (3 drivers) | Complete | 3 |
| **Total** | **M11.4 complete** | **6 new** |

## What to Do Next (M11.5)

From `docs/steps/11-milestone11-model-utilization.md`:

- [ ] Update `consult_ring.py` WITNESSES dict: set `max_tokens` to each model's actual `max_output_tokens` from the API (minimax: 131072, kimi: 65536, qwen: 65536, gemma: 131072). Add comment noting source: NanoGPT `/api/v1/models?detailed=true` queried 2026-04-05
- [ ] **Pull witness config into ACA:** Create `src/config/witness-models.ts` (or similar) that defines the witness model list and their configs. `consult_ring.py` can read this via `aca describe --json` or a new `aca witnesses --json` command, so there's a single source of truth inside ACA
- [ ] Verify ACA-mode witnesses (via `aca invoke`) inherit the catalog limits from M11.2
- [ ] Test: ACA-mode witness invocation uses catalog limits, not old hardcoded values

## Dependencies

- M11.2: Catalog integration (done — driver uses real limits when available)
- M11.4: Idle timeout formalized (done — all drivers tested)
- `consult_ring.py` at `~/.claude/skills/consult/consult_ring.py`

## File Locations

- Witness config: `src/config/witness-models.ts` (new file to create)
- Consult ring: `~/.claude/skills/consult/consult_ring.py` (update WITNESSES dict)
- Model catalog: `src/providers/model-catalog.ts` (existing, provides runtime limits)
- Agent registry: `src/delegation/agent-registry.ts` (witness profile)
