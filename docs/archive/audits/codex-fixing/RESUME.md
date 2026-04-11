# Resume ACA Re-Audit

If a future Codex session needs to resume this work, start here.

## Read In This Order

1. [LIVING_PROGRESS.md](./LIVING_PROGRESS.md)
2. [AUDIT_FRAMEWORK.md](./AUDIT_FRAMEWORK.md)
3. [AUDIT_STATUS.md](./AUDIT_STATUS.md)
4. [POST_M11_TRACKS_PLAN.md](./POST_M11_TRACKS_PLAN.md)
5. [LIVE_VALIDATION.md](./LIVE_VALIDATION.md)
6. [MILESTONE_AUDIT_TEMPLATE.md](./MILESTONE_AUDIT_TEMPLATE.md)
7. [README.md](./README.md)

## Current State

- The first audit pass was a milestone + blast-radius review.
- A stricter second-pass framework now exists.
- The second-pass milestone walk has restarted.
- Phase 0 is complete under the new framework.
- Milestone 1 is complete under the new framework.
- Milestone 2 is complete under the new framework.
- Milestone 3 is complete under the new framework.
- Milestone 4 is complete under the new framework.
- Milestone 5 is complete under the new framework.
- Milestone 6 is complete under the new framework.
- Milestone 7 is complete under the new framework.
- Milestone 8 is complete under the new framework.
- Milestone 9 is complete under the new framework.
- Milestone 10 is complete under the new framework.
- Milestone 11 is complete under the new framework.
- Phase 0 through Milestone 11 have recorded live NanoGPT validation in `LIVE_VALIDATION.md`.
- Post-M2 hardening added specialist-model fallback so `rp-researcher` can recover from a removed default model when ACA selected it.
- Live executor benchmark artifacts now exist at `/tmp/aca-executor-benchmark.json` and `/tmp/aca-executor-benchmark-deep.json`.
- Current benchmark leader is `zai-org/glm-5`, but the executor-default decision is intentionally deferred until more of the core audit is complete.
- M3 fixed a real invoke/executor parity bug: invoke now does pre-turn summarization, refreshed runtime context injection, and post-turn state persistence.
- M4 fixed a real renderer/output-channel leak: embedding initialization no longer prints raw console warnings into live REPL startup.
- M5 fixed a real startup/runtime liveness gap: retention and resume-time SQLite backfill are now wired into the built CLI instead of existing only as tested helper functions.
- M6 fixed a real indexing parity gap: cold one-shot and cold `invoke` mutation turns now bootstrap semantic indexing runtime before refreshing the index, so writes become searchable without a prior `search_semantic` call.
- M8 fixed a real live-test false negative: standalone live tests now use async child-process helpers, live `invoke` tests pipe stdin through a spawned child, and the slowest `write_file` case has a wider timeout ceiling; fresh built-CLI runs revalidated one-shot, `invoke`, `write_file`, and sandbox denial.
- M9 revalidated the real stdio bridge: built `aca serve` exposed `aca_run`, real child sessions handled read/exec/write tasks, invalid-model errors propagated cleanly, and parallel `aca_run` calls isolated into separate subprocess sessions without a new runtime defect.
- M10 fixed a real consult-path parity bug outside the core runtime: stale `.claude` consult wrappers still forwarded `minimax` into `aca consult`, but the canonical witness set is now `deepseek/kimi/qwen/gemma`; wrapper alias normalization, ACA-native consult context-request flow, tool-enabled witness invoke, and invalid-model failure were all revalidated live.
- M11 revalidated live model utilization in the built runtime: `aca witnesses --json` returned the canonical ACA-native witness contract, a verbose Kimi one-shot surfaced live catalog caps, witness-profile invoke exposed the lifted prompt/tool contract, and invalid-model rejection still failed fast before session creation.
- M11 also fixed contract parity drift: the milestone docs and witness comments now point at NanoGPT `/subscription/v1/models` and the current ACA witness contract instead of the old `/api/v1/models` + MiniMax wording.
- The old pending live-bank item `M2-LIVE-6` is now closed: a real built one-shot attempted `curl -I -s https://example.com` under `--no-confirm`, ACA rejected it with `tool.permission`, and the persisted reason was `network command requires confirmation (--no-confirm cannot override)`.
- `M10.3` remains an open workflow milestone rather than a stable audited runtime contract.
- The Phase 0 through Milestone 11 milestone walk is complete.
- There is no remaining milestone restart point in this walk.
- A post-M11 follow-on extension is now defined in `POST_M11_TRACKS_PLAN.md`.
- `C1` (Bundled Consult Orchestration) is complete under the second-pass framework.
- `C1` fixed three real consult-surface defects: missing `aca witnesses --json` compatibility, stale `.claude` consult-wrapper shared-context/max-context parity, and prompt-contract drift that let missing or unseen evidence become false absence claims.
- `C1` also re-proved degraded witness continuation live: a normal packed consult preserved a DeepSeek empty-final artifact and still produced triage from the surviving witness evidence.
- `C1` residual risk: shared-context still has low recall for semantically named config files unless the prompt or initial pack already points toward them; the repaired behavior now leaves those facts as open questions instead of inventing or asserting a false absence.
- `C2` (Raw Scout / Finalization / Triage Protocol) is complete under the second-pass framework.
- `C2` fixed four real protocol defects: malformed witness first-pass outputs now get one bounded repair attempt, malformed witness finalization outputs now get one bounded repair attempt, repaired witnesses no longer keep stale error strings, and triage now preserves `raw_path` so the first invalid aggregation attempt is not overwritten.
- `C2` also re-proved the real consult protocol live across clean `needs_context -> final`, repaired malformed witness finalization, empty structured final degradation, pseudo-tool degradation, and degraded triage continuation.
- `C2` residual is now closed in `C5`: a fresh 4-witness consult produced a partial first-pass triage artifact at `triage.raw_path`, and ACA repaired it into a complete final triage report on retry without losing the raw artifact.
- `C3` (External Delegation Pipeline and Agentized Offload) is complete under the second-pass framework.
- `C3` fixed the external operator-surface gaps instead of the core runtime: `.claude` orchestrate now forwards the same executor-shaping fields as the delegate wrapper, top-level orchestrate artifacts now record the resolved `ACA_BINARY`, and Codex now has first-party delegate/orchestrate shims plus matching skill docs.
- `C3` also re-proved the live offload claim through real `.claude` delegate/orchestrate runs, a real `.codex` delegate success + invalid-model failure, and a real stdio `aca_run` run that created a child session with persisted parent/root lineage.
- `C3` residual is now closed in `C5`: the delegate wrapper matches shared-`HOME` sessions back to the task text and emits exact `session_id` / `session_dir`, so nested orchestrate artifacts no longer over-report sibling `new_session_dirs`.
- `C4` (RP Researcher Profile and Workflow) is complete under the second-pass framework.
- `C4` fixed three real RP workflow defects exposed by live runs: optional search/browser guidance drift in the `rp-researcher` prompt, missing RP retry on `llm.malformed` aborts, and an old 8-call RP repair-turn clamp that ignored higher caller budgets.
- `C4` also aligned the wrapper/operator surface: `.claude` delegate/orchestrate now accept `--max-tool-calls`, and the RP workflow docs no longer imply the wrapper can satisfy required outputs without an actual `write_file`.
- `C4` re-proved the live RP path through a bounded discovery brief, a fallback write run that created the exact assigned file, and a zero-tool failure that still returned `turn.profile_validation_failed`.
- `C4` residual is now closed in `C5`: durable task state no longer persists neutral `tool.deferred` overflow noise or same-turn self-check `read_file` validation misses as open loops, and fresh RP write/discovery manifests now end with `openLoops: []`.
- `C5` (Residual Closure and Hard-to-Reproduce Cases) is complete under the second-pass framework; the queued residuals from `C2` through `C4` are closed.
- `C6` (RP Knowledge Pack Import Workflow) remains open under the second-pass framework, but it is paused at operator request while `C7` runs first.
- `C7` (Forced Tool Emulation and Blast-Radius Hardening) is complete (closed 2026-04-10).
- `C6` (RP Knowledge Pack Import Workflow) is the active restart point. Quints regen in progress.
- `C3`, `C4`, `C5`, `C6`, and `C7` are live-first tracks: real built-artifact runs are the main confidence bar, and local tests are only targeted regressions for touched deterministic logic.
- `C5` is reserved for bounded leftovers that are important enough to track but do not invalidate the source track's closure.
- If a `C5` item turns out to break the main claim of `C1` through `C4`, reopen that source track instead of keeping the issue in `C5`.
- If `C3` or `C4` surfaces a bounded hard-to-reproduce leftover that does not negate the source track's main claim, record it for `C5` and finish `C5` after `C4`.
- `consult_ring.py` remains a debug-only decision surface rather than a blocking audit track.
- `C6` is a productizing follow-on track rather than a residual bank: it aims to turn "research `<series>` for RP" into a first-class import workflow that defaults to `<rp-project>/<series-slug>/` on this machine, writes the strict RP-facing `.md` schema under `world/`, and calibrates live on the anime version of *The Quintessential Quintuplets* until the operator is satisfied with depth and width.
- `C6` authoring rules are now formalized in `docs/rp/authoring-contract.md`, and the current Quints calibration artifacts were intentionally archived at `<rp-project>/_archive/the-quintessential-quintuplets-c6-pre-regen-2026-04-09` before clearing the live `<rp-project>/the-quintessential-quintuplets` folder for a clean future regeneration pass.
- Active `C6` runtime note: the NanoGPT emulated-tool layer had a real contract bug. NanoGPT requires bare `{"tool_calls":[...]}` JSON, but the shared prompt stack still nudged models toward prose-plus-tool behavior, and the emulation parser only accepted strict JSON while live Kimi/Qwen-family runs often emitted pseudo-tool wrappers like `<tool_calls>[...]</tool_calls>`, `<tool_call>{...}</tool_call>`, or tagged `<function=...>` / `<parameter=...>` forms.
- That emulated-tool bug is now patched in `src/providers/tool-emulation.ts`: the injected emulation prompt explicitly overrides prose-before-tools guidance for NanoGPT runs, and the parser now recovers the pseudo-tool wrapper variants that showed up live.
- Focused validation for the emulation fix passed: `npx vitest run test/providers/tool-emulation.test.ts`, focused ESLint on `src/providers/tool-emulation.ts` + `test/providers/tool-emulation.test.ts`, `npx tsc --noEmit`, and `npm run build`.
- Fresh bounded live evidence moved the old boundary: rebuilt Kimi session `ses_01KNRMH10H3K7YD5FBQTNDB15H` on the Quints `Asahiyama High School` task accepted the initial five `read_file` calls and then accepted real `fetch_mediawiki_page` / `fetch_mediawiki_category` calls instead of stalling immediately in pseudo-tool text.
- Follow-up blast-radius hardening also fixed repeated wrapped pseudo-tool recovery and driver truthfulness: `src/providers/tool-emulation.ts` now recovers repeated wrapped call blocks and filters invalid empty-name entries, and `src/providers/nanogpt-driver.ts` now reports `supportsTools: emulated` for NanoGPT tool-enabled models because forced ACA-managed emulation is intentional product behavior here.
- Expanded follow-up verification passed: `npx vitest run test/providers/tool-emulation.test.ts test/providers/nanogpt-driver.test.ts`, focused ESLint on the driver/emulation files, and `npx tsc --noEmit`.
- `C7` now exists as the formal tool-emulation detour track. It should audit the forced-emulation blast radius across invoke, delegation, witnesses/triage, and RP research before `C6` resumes Quints regeneration from the archived clean slate.
- Active `C7` finding #1: tool-enabled emulation still had cross-workflow parser drift. `src/providers/tool-emulation.ts` now recovers live `<invoke name="..."><parameter ...>` pseudo-tool wrappers, including namespaced forms, and `src/cli/rp-research.ts` now uses that shared parser when salvaging pseudo `write_file` output.
- Active `C7` finding #2: `src/cli-main.ts` had a real Commander parsing defect. The root `--model` option was swallowing subcommand `rp-research --model` overrides, so live `rp-research --model not-real/test` silently fell back to `glm-5` instead of failing fast. `program.enablePositionalOptions()` now keeps subcommand-local `--model` parsing truthful, and `test/cli/rp-research.test.ts` locks the required Commander behavior.
- Fresh focused validation for the active `C7` fixes passed: `npx vitest run test/cli/rp-research.test.ts test/providers/tool-emulation.test.ts test/providers/nanogpt-driver.test.ts test/consult/context-request.test.ts`, focused ESLint on the touched CLI/provider files, `npx tsc --noEmit`, and `npm run build`.
- Fresh live `C7` evidence now exists:
  - built `aca invoke` on `qwen/qwen3-coder-next` still executed real `read_file` under forced emulation and returned `# RP Knowledge Pack Authoring Contract`
  - built `rp-research --model not-real/test` now fails fast with `llm.invalid_request: Model not supported` and creates no new executor session
  - built `invoke` with `profile: "witness"` and `allowed_tools: ["read_file"]` succeeded on the emulated path with one accepted `read_file`
  - built `invoke` with `profile: "rp-researcher"` created `<workspace-parent>/.aca-c7-rp-probe/royal-biblia-academy.md` through accepted `read_file` + `write_file`, then hit a retryable post-write `llm.malformed` abort
  - a built no-tools DeepSeek consult against `docs/rp/authoring-contract.md` stayed in clean `needs_context` / snippet-fulfillment mode and did not drift into pseudo-tool markup
  - a fresh built no-tools Qwen consult on `/tmp/aca-c7-pseudo-tool-prompt.md` now gives the missing degraded replay: Qwen emitted active pseudo-tool markup in the context-request pass, ACA classified it as degraded, and triage still completed from the raw artifact
  - delegate-wrapper bakeoff on `<workspace-parent>` showed `moonshotai/Kimi-K2-Instruct-0905` and `zai-org/glm-5` reaching real read→write completion, but only the `glm-5` run was exact on the bounded heading-copy task; both `qwen/qwen3-coder-next` and `qwen/qwen3-coder` aborted with retryable `llm.malformed` after the first accepted `read_file`
  - a fresh built Qwen size probe showed the smaller-source path is materially healthier but still flaky: one tiny-file run completed end-to-end, a rerun wrote the required output and then still aborted with retryable `llm.malformed`, and the full 7.6 KB contract-file run aborted after the first accepted `read_file` without writing the output
- The old no-tools degradation gap is now closed. The main remaining `C7` decision is whether the Qwen `llm.malformed` cases, especially the post-write abort after a satisfied required output, warrant workflow-level salvage or should remain documented model-quality/runtime-shape notes.
- `C6` remains open but paused. After `C7` closes, `C6` should resume from the fixed NanoGPT baseline and regenerate Quints from scratch rather than continue from the deleted draft folder.

## Core Rule

Do not audit only the milestone file.

Audit:

- the milestone
- its full blast zone
- every runtime, persistence, parity, and failure-path surface touched by that blast zone

## Structural Hotspot To Keep In Mind

Internal delegation was a structural hotspot.

The core runtime gap is now fixed:

- `spawn_agent` launches a real child runtime
- child lineage is persisted correctly
- one-shot, `invoke`, and nested delegation now have live NanoGPT proof on `moonshotai/kimi-k2.5`

Residual caution:

- built-in profiles still do not expose user-facing tools, so live child-approval bubbling remains unproven
- weaker models still emit malformed delegation references, so negative-path handling remains important

## Immediate Next Step

`C6` is the active restart point. See `docs/handoff-c6-quints-regen.md` in the anothercodingagent project for the full execution plan and copy-paste inline prompt.

Keep bookkeeping current in:

- [AUDIT_STATUS.md](./AUDIT_STATUS.md)
- [LIVING_PROGRESS.md](./LIVING_PROGRESS.md)
- [LIVE_VALIDATION.md](./LIVE_VALIDATION.md)
