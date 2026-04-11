# ACA Re-Audit Living Progress

Last updated: 2026-04-09

This is the living record of what the audit is doing, what has already been learned, and where the next session should restart.

## Mission

Re-audit ACA from Phase 0 through Milestone 11 with stricter methodology than the first pass, then extend the same method to any named post-M11 residual tracks that still need closure.

The goal is not just to find local bugs.

The goal is to verify that claimed systems are:

- live in real runtime paths
- coherent across modes
- correct on disk and on resume
- truthful in prompts, tests, and docs
- resilient in degraded and failure paths

## Current Method

The audit unit is:

- the current milestone
- plus the full blast zone of everything that milestone touches

Every pass applies these lenses across that expanded scope:

- blast radius / dependency tracing
- live runtime topology
- persistence / replay / resume
- negative and degraded behavior
- contract and mode parity
- dead-code / fake-completion detection
- bounded live NanoGPT validation for runtime-facing changes

For post-M11 follow-on work, use the four-axis overlay in `POST_M11_TRACKS_PLAN.md`:

- input and evidence acquisition
- witness runtime and orchestration
- protocol and aggregation
- persistence and operator surfaces

## What The First Pass Already Proved

The earlier blast-radius audit found multiple real issues and fixed many of them. It also proved that blast-radius review alone is not enough.

Important patterns already discovered:

- some helpers and subsystems were implemented but not actually live in runtime
- some persisted contracts drifted away from writers/readers and replay paths
- some tests proved local helpers but not real execution paths
- some docs and milestone claims overstated what the runtime actually does

## Known Structural Hotspots

These deserve extra scrutiny whenever they are touched:

- turn engine
- session manager / replay / resume
- prompt assembly / context assembly / summarization
- approval / authority / preauth
- provider abstraction / fallback
- invoke / executor mode
- consult / witness path
- consult evidence-pack / shared-context path
- consult triage / degraded-artifact retention path
- internal delegation runtime
- observability / sqlite analytics

## Most Important Structural Finding So Far

Internal ACA delegation was a structural hotspot, and the second-pass M7 audit fixed the core runtime gap.

What was proven before the fix:

- `spawn_agent` created metadata and tracker state but did not launch a real child runtime
- delegation was bound to a root caller context instead of a per-agent caller context
- child-session lineage factories were wrong for nested delegation
- lifecycle and messaging code existed, but live tracker progression depended on test-only helpers

What is true now:

- `spawn_agent` launches a real in-process child runtime
- child sessions carry correct parent/root lineage
- one-shot, `invoke`, and nested delegation all passed live NanoGPT validation on `moonshotai/kimi-k2.5`
- `await_agent` / `message_agent` now resolve live model shorthands like `$spawn_agent` and child labels
- empty model follow-up responses no longer count as silent `assistant_final` success

Residual note:

- built-in profiles still do not expose `ask_user` / `confirm_action` to sub-agents, so live child-approval bubbling remains unproven even though the lower-level wrapper path exists

## Current Re-Audit State

The second-pass framework is established and the Phase 0 through Milestone 11 re-walk is complete.

Current restart point:

- No remaining milestone restart point in the Phase 0-M11 walk
- `C1` through `C5` are complete under the post-M11 follow-on plan
- `C7` is complete under the post-M11 follow-on plan (closed 2026-04-10)
- `C6` is the active track — Quints regen in progress
- Current restart point is `C6`
- `C5` closed the queued residuals:
  - `C2`: a fresh 4-witness consult produced a partial first-pass triage artifact, preserved it at `triage.raw_path`, and succeeded on repaired final triage
  - `C3`: parallel shared-`HOME` orchestrate runs now emit task-matched `session_id` / `session_dir` and no longer over-report sibling `new_session_dirs`
  - `C4`: successful RP discovery/write runs no longer persist neutral deferred-call overflow or same-turn self-check `read_file` validation noise as durable open loops
- `consult_ring.py` remains a separate debug-only decision surface, but it is not a blocking audit restart point
- `C6` is a new productizing follow-on track rather than a bug-only residual pass: it turns the RP research workflow into a first-class "research `<series>` for RP" import path, defaulting to `<rp-project>/<series-slug>/` on this machine and calibrating the output format on the anime version of *The Quintessential Quintuplets*
- `C6` now has a formal authoring contract in `docs/rp/authoring-contract.md`, and the current Quints calibration pack was intentionally archived at `<rp-project>/_archive/the-quintessential-quintuplets-c6-pre-regen-2026-04-09` before deleting the live `<rp-project>/the-quintessential-quintuplets` folder so future regeneration can start clean
- Active `C6` subfinding: the NanoGPT emulated-tool path had a real runtime contract bug, not just a model-quality issue. The shared prompt stack was telling tool-using models to mix prose with tool use while the NanoGPT driver required bare `{"tool_calls":[...]}` JSON, and the emulation parser only accepted strict JSON while live models often emitted pseudo-tool wrappers such as `<tool_calls>[...]</tool_calls>`, `<tool_call>{...}</tool_call>`, or tagged `<function=...>` / `<parameter=...>` forms.
- That `C6` emulated-tool bug is now patched in `src/providers/tool-emulation.ts`: the emulation schema prompt explicitly overrides prose-before-tools guidance for NanoGPT runs, and the parser now recovers the pseudo-tool wrapper variants that were showing up live.
- Fresh focused validation passed after the patch: `test/providers/tool-emulation.test.ts`, focused ESLint on the emulation files, `npx tsc --noEmit`, and `npm run build`.
- Fresh bounded live evidence also moved the old failure boundary: a rebuilt Kimi `rp-researcher` replay on the same Quints `Asahiyama High School` task created session `ses_01KNRMH10H3K7YD5FBQTNDB15H`, accepted the initial five `read_file` calls, then accepted real `fetch_mediawiki_page` and `fetch_mediawiki_category` calls instead of dying immediately in pseudo-tool text. `C6` remains open, but the emulated-tool runtime is no longer failing at the same early step.
- Follow-up comprehensive bug hunt on the same blast radius found two more emulation-path issues and fixed them: repeated wrapped pseudo-tool blocks could still be truncated to a single recovered call or an empty recovered set, and NanoGPT driver capabilities were still advertising many tool-enabled models as `supportsTools: native` even though this provider intentionally forces ACA-managed emulation for every tool-enabled run. `src/providers/tool-emulation.ts` now recovers repeated wrapped call blocks and discards invalid empty-name entries, and `src/providers/nanogpt-driver.ts` now reports forced emulation truthfully.
- Expanded verification also passed after the follow-up fix set: `test/providers/tool-emulation.test.ts`, `test/providers/nanogpt-driver.test.ts`, focused ESLint on the driver/emulation files, `npx tsc --noEmit`, and a bounded Kimi live replay. An extra bounded Qwen probe was started and then intentionally stopped once the local/provider-level verification set was complete because the operator wanted to pause this detour.
- `C7` is the formal next track because the operator wants a dedicated deep pass on forced emulation before more Quints work. `C7` should widen the blast radius from the provider layer into invoke, delegation, witnesses/triage, and RP research, then hand control back to `C6`.
- `C7` is now actively in progress rather than only queued.
- Active `C7` finding #1: `src/providers/tool-emulation.ts` had another real blast-radius gap. Tool-enabled emulation could not recover live `<invoke name="..."><parameter ...>` pseudo-tool wrappers even though the no-tools consult path already classified those same wrappers as pseudo-tools. The emulation parser now recovers invoke/parameter wrappers, including namespaced variants, and `extractPseudoWriteFileCall()` in `src/cli/rp-research.ts` now reuses the shared parser instead of recognizing only the older `<tool_call>write_file<arg_key>...` shape.
- Active `C7` finding #2: `src/cli-main.ts` had a real Commander parsing defect. The root `--model` option was swallowing subcommand `rp-research --model` overrides, so live `rp-research --model not-real/test` silently fell back to `glm-5` and ran until `max_steps` instead of failing fast. `program.enablePositionalOptions()` now keeps subcommand-local `--model` parsing truthful, and `test/cli/rp-research.test.ts` locks the Commander behavior ACA relies on.
- Fresh focused validation passed for the new `C7` fixes: `npx vitest run test/cli/rp-research.test.ts test/providers/tool-emulation.test.ts test/providers/nanogpt-driver.test.ts test/consult/context-request.test.ts`, focused ESLint on the touched CLI/provider files, `npx tsc --noEmit`, and `npm run build`.
- Fresh live `C7` evidence now exists:
  - built `aca invoke` on `qwen/qwen3-coder-next` still executed real `read_file` under forced emulation and returned `# RP Knowledge Pack Authoring Contract`
  - built `rp-research --model not-real/test` now fails fast with `llm.invalid_request: Model not supported` and creates no new executor session, proving the old silent `glm-5` fallback is gone
  - built `invoke` with `profile: "witness"` and `allowed_tools: ["read_file"]` succeeded on the emulated path with one accepted `read_file`
  - built `invoke` with `profile: "rp-researcher"` created `<workspace-parent>/.aca-c7-rp-probe/royal-biblia-academy.md` through accepted `read_file` + `write_file`, then hit a retryable post-write `llm.malformed` abort; the write path itself is live, but the model can still terminate badly after satisfying the file contract
  - a built no-tools DeepSeek consult against `docs/rp/authoring-contract.md` stayed in clean `needs_context` / snippet fulfillment mode and did not drift into pseudo-tool markup
  - a fresh built no-tools Qwen consult on `/tmp/aca-c7-pseudo-tool-prompt.md` now gives the missing degraded replay: Qwen emitted active pseudo-tool markup in the context-request pass, ACA classified it as degraded, and triage still completed from the raw artifact
  - delegate-wrapper bakeoff on `<workspace-parent>` showed `moonshotai/Kimi-K2-Instruct-0905` and `zai-org/glm-5` reaching real read→write completion, but only the `glm-5` run was exact on the bounded heading-copy task; both `qwen/qwen3-coder-next` and `qwen/qwen3-coder` aborted with retryable `llm.malformed` after the first accepted `read_file`
  - a fresh built Qwen size probe showed the smaller-source path is materially healthier but still flaky: one tiny-file run completed end-to-end, a rerun wrote the required output and then still aborted with retryable `llm.malformed`, and the full 7.6 KB contract-file run aborted after the first accepted `read_file` without writing the output

Current board expectation:

- only milestones or follow-on tracks explicitly updated in `AUDIT_STATUS.md` should be treated as re-audited under the new method

## Planned Follow-On Tracks

The original milestone walk is closed, but consult still warrants a dedicated hardening extension.

Planned tracks:

- `C1` — Bundled Consult Orchestration
- `C2` — Raw Scout / Finalization / Triage Protocol
- `C3` — External Delegation Pipeline and Agentized Offload
- `C4` — RP Researcher Profile and Workflow
- `C5` — Residual Closure and Hard-to-Reproduce Cases
- `C6` — RP Knowledge Pack Import Workflow
- `C7` — Forced Tool Emulation and Blast-Radius Hardening

Current rule for both:

- do not start the live pass until the pre-execution hardening gates in `POST_M11_TRACKS_PLAN.md` are checked
- treat them like milestones for bookkeeping and closure
- for `C3`, `C4`, and `C5`, weight real built-artifact live runs above broad local suites; use local tests mainly as focused regressions on touched deterministic logic

## Latest Completed Pass

`C7` is complete under the second-pass framework. `C6` is the active track — Quints regen has begun.

Major findings:

- the queued `C3` residual was real: a fresh shared-`HOME` orchestrate run reproduced the coarse wrapper bug, with both nested delegate artifacts reporting both new session directories instead of their own task-matched session
- the queued `C4` residual was also real: the durable task-state layer was still converting neutral `tool.deferred` overflow noise and same-turn self-check `read_file` validation misses into persistent open loops even when the RP discovery brief or written file was correct
- the queued `C2` residual was not a dead note after all: a fresh 4-witness consult produced a partial first-pass triage artifact, preserved it under `triage.raw_path`, and then repaired it into a complete final triage report on retry
- `C6` exposed a new live runtime defect in the NanoGPT emulated-tool layer: the shared prompt contract told tool-using models to mix prose with tool use, while the NanoGPT driver simultaneously required bare tool-call JSON and only parsed one strict JSON shape; live Kimi and Qwen-family runs instead produced XML-ish pseudo-tool wrappers and stalled the RP workflow

Fixes made:

- hardened `<claude-home>/skills/delegate/scripts/run_delegate.py` so shared-`HOME` runs now match the created ACA session back to the task text and emit exact `session_id` / `session_dir`, then aligned the `.claude` and `.codex` delegate/orchestrate skill docs to that artifact shape
- narrowed `src/core/durable-task-state.ts` so neutral `tool.deferred` overflow results and same-turn `read_file` self-check validation misses on files written earlier in the turn no longer become durable open loops; added focused regressions in `test/core/durable-task-state.test.ts`
- reran build, typecheck, focused ESLint, focused durable-task-state tests, Python wrapper compilation, a fresh shared-`HOME` orchestrate live repro/fix pass, fresh RP write/discovery live passes, and a fresh 4-witness consult live pass against the rebuilt artifact
- hardened `src/providers/tool-emulation.ts` so NanoGPT emulation now explicitly forbids prose-before-tools in the injected schema prompt and accepts wrapped pseudo-tool variants (`<tool_calls>...</tool_calls>`, `<tool_call>{...}</tool_call>`, `<tool_call>name<arg_key>...`, and `<function=...><parameter=...>...`) instead of only strict `{"tool_calls":[...]}` JSON; added focused regressions in `test/providers/tool-emulation.test.ts`
- reran `test/providers/tool-emulation.test.ts`, focused ESLint, `npx tsc --noEmit`, `npm run build`, and a bounded rebuilt Kimi `rp-researcher` replay that crossed the old pseudo-tool failure boundary on the Quints `Asahiyama High School` task

Residual note:

- the queued `C2` through `C4` residual bank is now closed; no blocking `C5` items remain
- `C1` still has a documented non-blocking recall note around semantically named config files, and `consult_ring.py` remains a debug-only decision surface rather than a canonical product path
- the older M7 child-approval bubbling caution remains historically unproven, but it was not part of the active `C5` residual queue and was not reopened by this pass
- `C6` remains the paused productizing track and still depends on live Quints calibration plus operator approval of the resulting RP pack depth/width
- `C7` has now re-proved more of the NanoGPT emulated-tool boundary, but not all of it: the forced-emulation path is live for built `invoke`, witness-profile tool use, fixed `rp-research --model` parsing, and at least two delegate-wrapper models that reached read→write completion (`Kimi-K2-Instruct-0905`, `glm-5`)
- `C7` also exposed a new live model-quality/runtime-shape split rather than a parser bug: on the same delegate-wrapper read→write task, both Qwen models aborted with retryable `llm.malformed` after the initial accepted `read_file`, Kimi completed the tool path but paraphrased the exact heading-copy target, and GLM completed the full read→write path exactly. A fresh built Qwen size probe now supports that classification more narrowly: smaller-source runs are materially healthier than the 7.6 KB contract-file run, but even the smaller-source path can still write the required file and then abort, which leaves an open workflow-level salvage question.
- the no-tools consult pseudo-tool degradation branch is now freshly re-proved on the rebuilt `C7` baseline: Qwen emitted active pseudo-tool markup in the no-tools context-request pass, ACA classified it as degraded, and triage still completed from the raw degraded artifact

## Live Validation Rule

The audit now requires a bounded real NanoGPT scenario bank for runtime-facing milestones.

Current status:

- Phase 0 through Milestone 11 now have recorded live NanoGPT validation in `LIVE_VALIDATION.md`
- the former pending live-bank item `M2-LIVE-6` is now closed: a real built one-shot on `zai-org/glm-5` attempted `curl -I -s https://example.com`, ACA rejected it with `tool.permission`, and the persisted reason was `network command requires confirmation (--no-confirm cannot override)`
- post-M2 runtime hardening also proved `rp-researcher` falls back from a removed default model (`zai-org/glm-5.1`) to `zai-org/glm-5` in a real invoke run
- deeper live executor benchmarking now exists for `qwen/qwen3-coder-next` vs `zai-org/glm-5`
- current benchmark leader is `zai-org/glm-5`, but executor-default decisions are intentionally deferred until more of the core audit is complete

## Working Rules

- do not treat prior milestone closure as final
- do not mark a milestone done unless its live path is proven
- if a structural blocker is found, stop and resolve or mark it blocked
- when a fix lands outside the nominal milestone, keep bookkeeping anchored to the milestone that exposed it

## Next Action

The milestone walk is complete.

If more follow-up time is available, use:

1. `RESUME.md`
2. `AUDIT_FRAMEWORK.md`
3. `AUDIT_STATUS.md`
4. `LIVE_VALIDATION.md`
5. `MILESTONE_AUDIT_TEMPLATE.md`
6. `README.md`

Then update this file after any residual pass with:

- milestone audited
- major findings
- fixes made
- open blockers
- next restart point

Current next restart point:

- `C7`
- start by reading the new `C7` section in `POST_M11_TRACKS_PLAN.md`
- continue from the active `C7` fixes and live evidence instead of restarting from the old Quints emulation bug
- next highest-value decision is whether the remaining Qwen `llm.malformed` cases, especially the post-write abort after a satisfied required output, warrant workflow-level salvage or should stay as documented model-quality/runtime-shape notes
- after that, either close `C7` with an explicit residual note or harden the workflow surface that still treats satisfied required-output creation as a failed run
- after `C7` closes, resume `C6` from the archived Quints baseline and regenerate the live folder from scratch

## Executor Benchmark Note

Real built-CLI executor benchmarks were run through the live NanoGPT path and recorded in:

- `/tmp/aca-executor-benchmark.json`
- `/tmp/aca-executor-benchmark-deep.json`

Current read:

- `zai-org/glm-5` is the stronger executor candidate right now
- the stronger signal came from the deeper benchmark, especially the real bug-fix task
- the default-model decision is intentionally deferred until more of the audit is complete, because runtime flaws still distort model comparisons
