# ACA Re-Audit Status

This is the tracking board for the second-pass audit.

Rule:

- previous blast-radius findings still matter
- no milestone is considered closed until it passes the new multi-axis audit in `AUDIT_FRAMEWORK.md`
- each milestone pass covers the milestone plus its full blast zone, not only the local step file

## Status Key

- `pending`: not yet re-audited under the new framework
- `in_progress`: active milestone
- `blocked`: structural blocker found; do not treat as complete
- `done`: passed the new framework with validation and explicit residual-risk note

## Current Order

Original walk:

- Phase 0 through Milestone 11

Post-M11 follow-on order:

- `C1`
- `C2`
- `C3`
- `C4`
- `C5`
- `C6`
- `C7`

## Milestone Board

| Milestone | Primary step file | Blast Radius | Live Runtime | Persistence / Resume | Negative Paths | Contract Parity | Docs / Tests | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Phase 0 | `docs/steps/00-phase0-setup.md` | done | done | done | done | done | done | done | Closed: bootstrap/build/test-helper audit complete; malformed mock JSON crash fixed |
| Milestone 1 | `docs/steps/01-milestone1-agent-loop.md` | done | done | done | done | done | done | done | Closed: auto-confirm `confirm_action` no longer falsely yields `approval_required` |
| Milestone 2 | `docs/steps/02-milestone2-tools-perms.md` | done | done | done | done | done | done | done | Closed: approved-only shell network commands now route through explicit approval instead of silently executing |
| Milestone 3 | `docs/steps/03-milestone3-context-state.md` | done | done | done | done | done | done | done | Closed: invoke/executor now shares M3 lifecycle hooks; pre-turn summarization, refreshed runtime context, and post-turn state persistence are live and validated |
| Milestone 4 | `docs/steps/04-milestone4-rendering.md` | done | done | done | done | done | done | done | Closed: embedding initialization no longer leaks raw console warnings into REPL startup; one-shot and REPL rendering both passed fresh live NanoGPT validation |
| Milestone 5 | `docs/steps/05-milestone5-provider-obs.md` | done | done | done | done | done | done | done | Closed: startup now runs retention and resume-time JSONL→SQLite backfill; live NanoGPT validation proved stats, backfill, and retention in the built runtime |
| Milestone 6 | `docs/steps/06-milestone6-indexing.md` | done | done | done | done | done | done | done | Closed: cold one-shot and cold `invoke` mutation turns now bootstrap semantic indexing runtime before refresh, so post-write indexing is live instead of depending on prior `search_semantic` use |
| Milestone 7 | `docs/steps/07a-milestone7-error-health.md`, `docs/steps/07a5-milestone7-review-aggregation.md`, `docs/steps/07b-milestone7-delegation.md`, `docs/steps/07c-milestone7-capabilities.md` | done | done | done | done | done | done | done | Closed: real child runtime, per-agent caller context, and invoke delegation are live; Kimi passed one-shot, invoke, and nested NanoGPT delegation validation |
| Milestone 8 | `docs/steps/08-milestone8-standalone.md` | done | done | done | done | done | done | done | Closed: built standalone one-shot, invoke, write_file, and sandbox denial revalidated; long live M8 tests now use async child-process helpers so Vitest no longer times out on valid slow runs |
| Milestone 9 | `docs/steps/09-milestone9-bridge.md` | done | done | done | done | done | done | done | Closed: built `aca serve`/`aca_run` bridge revalidated over real stdio MCP; read, exec, write, invalid-model error propagation, and parallel subprocess isolation passed without a new runtime defect |
| Milestone 10 | `docs/steps/10-milestone10-payoff.md` | done | done | done | done | done | done | done | Closed: current consult product path is ACA-native context-request mode; fixed stale `.claude` consult-wrapper `minimax` alias drift against the canonical witness set; live validation re-proved wrapper alias normalization, bounded snippet fulfillment, witness-profile `exec_command`, and invalid-model failure. `M10.3` remains an open workflow milestone rather than a stable runtime contract |
| Milestone 11 | `docs/steps/11-milestone11-model-utilization.md` | done | done | done | done | done | done | done | Closed: live NanoGPT catalog behavior was re-proved through built `aca witnesses`, verbose Kimi caps logging, witness-profile invoke prompt/tool exposure, and invalid-model rejection; fixed M11 doc/comment parity drift so the milestone now points at `/subscription/v1/models` and the current ACA witness contract instead of the old `/api/v1/models` + MiniMax wording. Legacy raw `consult_ring.py` remains debug-only rather than a canonical product path |
| C1 | `codex-fixing/POST_M11_TRACKS_PLAN.md` | done | done | done | done | done | done | done | Closed: built `aca consult` pack-path, shared-context, degraded-witness continuity, wrapper parity, and invalid shared-context-model behavior were re-proved live; fixed missing `aca witnesses --json` compatibility, synced `.claude` consult wrappers to the current shared-context/max-context CLI surface, and hardened consult prompt/triage contracts so missing or unseen evidence stays an open question instead of becoming a false absence claim. Residual risk: shared-context still has low recall for semantically named config files unless the prompt or pack already points it there |
| C2 | `codex-fixing/POST_M11_TRACKS_PLAN.md` | done | done | done | done | done | done | done | Closed: no-tools consult now gives malformed witness first-pass/finalization outputs one bounded repair attempt, clears stale error strings after repair, and preserves `triage.raw_path` so the first invalid triage attempt is not lost. Built live runs re-proved clean `needs_context -> final`, repaired malformed finalization, empty-final degradation, pseudo-tool degradation, degraded continuation, and now a real partial first-pass triage artifact with repaired finalization in `C5` |
| C3 | `codex-fixing/POST_M11_TRACKS_PLAN.md` | done | done | done | done | done | done | done | Closed: the external offload path is live through real `.claude`/`.codex` delegate wrappers, repaired `.claude` orchestrate passthrough, and real stdio `aca_run` child-lineage; added first-party `.codex` delegate/orchestrate shims/docs and fixed top-level orchestrate artifact truthfulness for `ACA_BINARY`. `C5` closed the shared-`HOME` attribution residual by teaching the delegate wrapper to emit task-matched `session_id` / `session_dir` and narrow `new_session_dirs` accordingly |
| C4 | `codex-fixing/POST_M11_TRACKS_PLAN.md` | done | done | done | done | done | done | done | Closed: live `rp-researcher` discovery, exact-output write, zero-tool failure, and unavailable-default fallback were re-proved through the built delegate wrapper. Fixed RP prompt/operator drift around optional search/browser tools, added bounded `llm.malformed` retry for RP aborts, widened RP repair turns to a 20-call cap that respects lower caller limits, aligned wrapper/docs on `--max-tool-calls` plus exact file-creation expectations, and then closed the remaining session-noise residual in `C5` by filtering neutral `tool.deferred` overflow noise plus same-turn self-check `read_file` validation misses from durable open loops |
| C5 | `codex-fixing/POST_M11_TRACKS_PLAN.md` | done | done | done | done | done | done | done | Closed: the queued residual bank from `C2` through `C4` is now resolved. `C2` got a live partial first-pass triage artifact with preserved `triage.raw_path` and repaired final output, `C3` now reports exact per-task session attribution under shared `HOME`, and `C4` RP discovery/write manifests no longer keep fake open loops from deferred over-batching or same-turn self-check `read_file` validation noise. Remaining note: `consult_ring.py` is still debug-only, but it is not a blocking audit track |
| C6 | `codex-fixing/POST_M11_TRACKS_PLAN.md` | pending | pending | pending | pending | pending | pending | in_progress | Paused at operator request so Quints can be regenerated cleanly after `C7`. Current calibration pack is archived at `/home/blake/projects/rpproject/_archive/the-quintessential-quintuplets-c6-pre-regen-2026-04-09`, the live `/home/blake/projects/rpproject/the-quintessential-quintuplets` folder was cleared, and `C6` will resume from that clean slate after the tool-emulation detour closes |
| C7 | `codex-fixing/POST_M11_TRACKS_PLAN.md` | in_progress | in_progress | in_progress | in_progress | in_progress | in_progress | in_progress | Active: fixed two real forced-emulation blast-radius defects so far. `tool-emulation` now recovers invoke/parameter pseudo-tool wrappers that the no-tools consult path already classified as degraded, and `cli-main` now calls `program.enablePositionalOptions()` so the root `--model` flag no longer swallows `rp-research --model` overrides and silently falls back to `glm-5`. Fresh live proof now includes built `invoke` success on the emulated path, a fixed `rp-research --model not-real/test` fast failure before session creation, witness-profile tool success, a bounded `rp-researcher` write that created the required file before a retryable post-write `llm.malformed`, a fresh no-tools Qwen degraded replay where active pseudo-tool markup was classified correctly, and a delegate bakeoff where `glm-5` completed the bounded read→write task exactly, `Kimi-K2-Instruct-0905` completed the tool path but paraphrased the exact heading-copy target, and both Qwen delegate runs aborted with retryable `llm.malformed`. The fresh built size probe now supports treating the remaining Qwen failures as a size-sensitive model-quality/runtime-shape split rather than the original parser bug, but it also leaves an open salvage question once required outputs already exist. Remaining open item: decide whether the post-write / large-read Qwen aborts need workflow-level salvage before `C7` can close |

## Known Cross-Cutting Hotspots

These are already proven worthy of extra scrutiny during the re-audit:

- turn numbering / checkpoint identity
- context compression / summarization liveness
- path identity normalization
- runtime observability liveness
- invoke prompt/runtime parity
- consult witness / triage no-tools path
- internal delegation runtime and approval flow

## Resume Notes

When resuming after a break:

1. read `RESUME.md`
2. read `LIVING_PROGRESS.md`
3. read `AUDIT_FRAMEWORK.md`
4. check the current row in this file
5. use `MILESTONE_AUDIT_TEMPLATE.md`
6. use `README.md` for dependency tracing

If a milestone uncovers a structural cross-cutting defect, record it in the milestone notes and leave the row `blocked` or `in_progress` until the structural issue is resolved.
