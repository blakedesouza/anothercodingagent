# Post-M11 Follow-On Tracks Plan

Drafted: 2026-04-08

This is a post-M11 extension to the second-pass audit.

It is not a rewrite of the original milestone ladder.

It is a focused re-audit of the current consult, delegation, and specialist-profile product paths, using the same closure bar as the Phase 0-M11 walk:

- full blast-radius review
- live-first validation with targeted local regressions
- bounded live NanoGPT validation
- explicit residual-risk note before closure

## Tracks

The follow-on work is split into seven named tracks.

1. `C1` — Bundled Consult Orchestration
2. `C2` — Raw Scout / Finalization / Triage Protocol
3. `C3` — External Delegation Pipeline and Agentized Offload
4. `C4` — RP Researcher Profile and Workflow
5. `C5` — Residual Closure and Hard-to-Reproduce Cases
6. `C6` — RP Knowledge Pack Import Workflow
7. `C7` — Forced Tool Emulation and Blast-Radius Hardening

Recommended order:

1. `C1`
2. `C2`
3. `C3`
4. `C4`
5. `C5`
6. `C6`
7. `C7`

Reason:

- `C1` is the user-facing workflow and gives immediate confidence in the real product path
- `C2` is the deeper protocol audit that hardens the scout/finalization/triage seam exposed by recent degraded witness output
- `C3` tests whether external callers can actually treat ACA as a bounded fresh-context agent instead of just a helper process
- `C4` hardens the most specialized shipped profile after the consult and delegation paths beneath it are re-proven
- `C5` is the residual closeout pass for bounded leftovers that were important enough to track but not strong enough to block earlier closure
- `C6` productizes the RP import path so a user can research a series for RP and land a targeted LLM-facing knowledge pack under the RP project with the approved schema and timeline gating
- `C7` is the forced-emulation hardening pass: it verifies that ACA's intentional "emulate tools on every NanoGPT tool-enabled model" design stays truthful, safe, and robust across invoke, delegation, witnesses, triage, and RP research before `C6` resumes live Quints regeneration

Current operator-directed order from the current state:

1. pause `C6` with the archived Quints baseline preserved
2. run `C7`
3. resume `C6` from a clean Quints folder after `C7` closes

## Pre-Execution Hardening Gates

Do not start live `C1` through `C7` runs until these gates are checked.

1. Canonical witness parity is explicit.
   - `aca witnesses --json`
   - `src/config/witness-models.ts`
   - consult wrappers under `~/.codex/skills/consult/` and `~/.claude/skills/consult/`
   - docs/comments that still describe legacy witness contracts

2. Focused consult tests are green.
   - `test/cli/consult.test.ts`
   - `test/consult/context-request.test.ts`
   - `test/consult/evidence-pack.test.ts`
   - any directly touched witness-model / executor validation tests

3. Built-artifact path is current.
   - `npm run build`
   - live validation should prefer `node dist/index.js`

4. Artifact retention is understood before live runs.
   - result JSON path
   - raw request path
   - witness response path
   - triage input path
   - any session dirs created by witness ACA subprocesses

5. `consult_ring.py` stays out of the closure critical path unless explicitly chosen.
   - treat it as debug-only unless this audit deliberately re-promotes it
   - do not let raw legacy harness behavior override ACA-native closure decisions

6. External caller surfaces are identified before delegation work starts.
   - `aca_run` / MCP bridge path
   - `aca invoke` executor envelope
   - Claude delegate/orchestrate wrappers
   - any Codex-side equivalent, or an explicit note that the equivalent does not yet exist

7. RP profile contract parity is explicit before `C4`.
   - `src/delegation/agent-registry.ts`
   - `src/cli/executor.ts`
   - `src/cli-main.ts`
   - `src/cli/invoke-output-validation.ts`
   - wrapper docs that tell operators how to call `rp-researcher`

8. RP project target-root and schema contract are explicit before `C6`.
   - local default root on this machine: `/home/blake/projects/rpproject`
   - generic public override path (`--project-root` and/or config/env) is decided
   - slugging rules are explicit for series-folder creation
   - the approved RP-facing file schema is explicit for `world.md`, `world-rules.md`, `world/characters/*.md`, and `world/locations/*.md`
   - the example contract in `/home/blake/projects/rpproject/EXAMPLE` is reflected in the workflow docs instead of living only in chat

9. Forced-emulation contract parity is explicit before `C7`.
   - NanoGPT forced emulation for tool-enabled runs is treated as intentional product behavior, not an accident
   - provider capabilities report that truthfully as `supportsTools: emulated`
   - prompt-injection, parser, and stream-wrapping expectations are aligned across provider/runtime/tests
   - no-tools consult/triage paths still classify pseudo-tool markup as degradation instead of silently treating it as valid content
   - invoke, delegation, witnesses, and RP research all name the same emulation contract

If any gate fails, harden that surface first and keep the active track `pending` or `in_progress`.

## Validation Weighting

For `C3`, `C4`, `C5`, `C6`, and `C7`, confidence should come primarily from real built-artifact runs.

Working rule:

- live built-CLI or wrapper-driven validation is the primary source of truth
- local tests should be narrow, deterministic regressions for the exact logic or artifact contract being changed
- broad mock-heavy suites are lower-signal and should not delay closure unless they cover the precise surface under audit
- if live behavior and local tests disagree, treat the live path as the first-class signal and investigate the mismatch
- if `C3`, `C4`, `C6`, or `C7` exposes a bounded hard-to-reproduce leftover that does not negate the source track's main claim, record it for a later residual decision instead of silently closing over it
- if that leftover does negate the source track's main claim, keep or reopen the source track instead of moving it out of the way

## Four-Axis Workflow

These tracks are easiest to miss when reviewed as one large feature bucket.

Use these four operating axes on `C1` through `C7`.

### Axis 1. Input and Evidence Acquisition

What this covers:

- question vs prompt-file entry
- `--pack-path` / `--pack-repo`
- evidence-pack truncation and omission behavior
- shared-context request setup
- wrapper argument mapping and defaults

Questions:

- did the user request actually reach the consult runtime unchanged?
- did bundled evidence include the intended files and only the intended files?
- do wrappers and docs describe the same flags and defaults as the CLI?
- are pack modes, delegate envelopes, or profile defaults silently changing the task shape?

### Axis 2. Witness Runtime and Orchestration

What this covers:

- witness selection
- model resolution and fallback
- ACA-native `invoke` path
- tool-enabled vs no-tools witness passes
- `aca_run` / executor path
- internal child-agent path
- deadlines, timeouts, and degraded witness continuation

Questions:

- did each witness actually run through the intended runtime path?
- did a wrapper silently fall back to a different path?
- do invalid-model and unavailable-model failures surface cleanly?
- when one witness, delegate, or child agent degrades, does the overall workflow stay usable?

### Axis 3. Protocol and Aggregation

What this covers:

- raw scout prompt protocol
- `needs_context` parsing
- snippet fulfillment
- first-pass direct final handling
- empty / malformed / pseudo-tool output classification
- finalization pass
- triage prompt building, retry, and report validation
- external retry / takeover / repair prompts
- profile-specific completion validation

Questions:

- do we correctly distinguish `final`, `needs_context`, malformed, and degraded output?
- do bounded snippets stay deterministic and within limits?
- does triage consume degraded witness evidence instead of dropping it?
- do retry rules repair malformed results without hiding the original failure mode?

### Axis 4. Persistence and Operator Surfaces

What this covers:

- result JSON fields and counts
- raw request / response artifacts
- triage input preservation
- delegate/orchestrate result artifacts
- child session lineage
- temp file naming and traceability
- docs, tests, comments, and wrapper help text
- live validation bookkeeping

Questions:

- can we reconstruct what happened from saved artifacts?
- do degraded runs preserve raw evidence for triage and debugging?
- can external callers reconstruct what ACA did from saved artifacts?
- do docs/tests/help text match the live product contract?
- are result summaries truthful about success, degraded state, and remaining uncertainty?

## C1 — Bundled Consult Orchestration

Goal:

Re-audit the end-to-end, user-facing `aca consult` workflow when the task is delivered through bundled evidence and fanned out across witnesses.

Primary product claim:

- `aca consult` is a stable real-runtime workflow, not just a local helper with passing unit tests

### C1 Blast Radius

Primary runtime files:

- `src/cli/consult.ts`
- `src/consult/evidence-pack.ts`
- `src/config/witness-models.ts`
- `src/providers/model-catalog.ts`
- `src/cli/executor.ts`
- `src/cli/invoke-output-validation.ts`
- `src/cli-main.ts`

Primary tests:

- `test/cli/consult.test.ts`
- `test/consult/evidence-pack.test.ts`
- `test/config/witness-models.test.ts`
- any touched executor / invoke validation tests

Operator and wrapper surfaces:

- `~/.codex/skills/consult/scripts/run_consult.py`
- `~/.claude/skills/consult/scripts/run_consult.py`
- `~/.claude/skills/consult/scripts/run_packed_consult.py`
- `~/.claude/skills/consult/SKILL.md`
- `docs/steps/10-milestone10-payoff.md`
- `docs/steps/11-milestone11-model-utilization.md`

Debug-only parity surface:

- `~/.claude/skills/consult/consult_ring.py`

### C1 Four-Axis Checks

Axis 1. Input and Evidence Acquisition

- `question` vs `promptFile`
- `packPath` vs `packRepo`
- truncation / omitted-file behavior
- wrapper defaults and alias normalization

Axis 2. Witness Runtime and Orchestration

- witness lineup from `aca witnesses --json`
- model fallback / invalid-model failure
- shared-context on/off
- tool-enabled witness invoke path
- degraded single-witness continuation

Axis 3. Protocol and Aggregation

- result handoff from witnesses into triage
- mixed `ok` and degraded witness sets
- skip-triage vs triage-enabled behavior
- bounded no-tools behavior where applicable

Axis 4. Persistence and Operator Surfaces

- result JSON correctness
- raw request / response / triage artifact paths
- wrapper output and help text
- live validation notes recorded in `LIVE_VALIDATION.md`

### C1 Minimum Validation Set

Local:

- build
- focused consult/evidence-pack/witness-model tests
- any touched executor validation tests

Live:

- built `aca consult` with `--pack-path`
- built `aca consult` with shared-context enabled
- wrapper-driven consult run using the canonical witness contract
- invalid-model or unavailable-witness scenario
- degraded witness still reaches triage with raw evidence preserved

### C1 Likely Hardening Triggers

Harden before closure if any of these are observed:

- wrappers drift from the canonical witness set or CLI flags
- packed evidence silently drops critical files without result visibility
- shared-context fallback changes model/runtime shape without being recorded
- degraded witness output is not preserved into triage inputs

## C2 — Raw Scout / Finalization / Triage Protocol

Goal:

Re-audit the no-tools consult protocol from the initial scout pass through bounded snippet fulfillment, finalization, degraded classification, and triage repair.

Primary product claim:

- consult protocol handling is resilient when witnesses do not cleanly return final Markdown on the first pass

### C2 Blast Radius

Primary runtime files:

- `src/cli/consult.ts`
- `src/consult/context-request.ts`
- `src/review/witness-finding.ts`

Primary tests:

- `test/cli/consult.test.ts`
- `test/consult/context-request.test.ts`
- `test/review/witness-finding.test.ts`

Connected runtime consumers:

- triage/fallback model selection inside `src/cli/consult.ts`
- shared-context scout path inside `src/cli/consult.ts`
- any result readers relying on `response_path`, `raw_request_path`, or `triage_input_path`

### C2 Four-Axis Checks

Axis 1. Input and Evidence Acquisition

- raw context-request prompt construction
- shared-context scout protocol shape
- prompt retry instructions after malformed first pass

Axis 2. Witness Runtime and Orchestration

- no-tools context-request pass
- finalization pass after snippet fulfillment
- fallback-model use for triage / shared context
- provider-specific degraded output behavior

Axis 3. Protocol and Aggregation

- direct Markdown final
- structured `action: "final"` with non-empty markdown
- empty structured final
- `needs_context` request parsing and normalization
- malformed JSON
- pseudo-tool output
- incomplete or malformed triage report retry

Axis 4. Persistence and Operator Surfaces

- raw degraded witness body retained for triage
- result JSON counts and statuses remain truthful
- triage input path points to the right artifact
- live-bank entries preserve enough evidence to debug a repeated provider issue

### C2 Minimum Validation Set

Local:

- focused consult/context-request/review tests
- explicit regression for empty structured final degradation
- focused lint/typecheck/build for touched files

Live:

- clean first-pass final case
- `needs_context` -> snippet fulfillment -> final report case
- degraded empty structured final case
- degraded pseudo-tool-call case
- malformed or incomplete triage output repaired by retry

### C2 Likely Hardening Triggers

Harden before closure if any of these are observed:

- degraded outputs are misclassified as success
- degraded outputs are dropped instead of preserved for triage
- snippet normalization accepts broad or unsafe paths
- triage retry hides the original witness failure mode
- provider-specific empty-final behavior repeats often enough that a bounded retry or stronger classification rule is needed

## C3 — External Delegation Pipeline and Agentized Offload

Goal:

Re-audit how external callers such as Claude and Codex can invoke ACA as a bounded fresh-context agent through the executor / MCP / delegation stack, rather than burning main-model context on direct execution.

Primary product claim:

- ACA can be treated as an agentized execution surface with bounded authority, auditable results, and lower main-caller context pressure

### C3 Blast Radius

Primary runtime files:

- `src/mcp/server.ts`
- `src/cli/executor.ts`
- `src/cli/invoke-tooling.ts`
- `src/cli/invoke-runtime-state.ts`
- `src/cli/invoke-output-validation.ts`
- `src/delegation/agent-registry.ts`
- `src/delegation/spawn-agent.ts`
- `src/delegation/message-agent.ts`
- `src/delegation/await-agent.ts`
- `src/delegation/agent-runtime.ts`
- `src/permissions/approval.ts`

Primary tests:

- `test/mcp/server.test.ts`
- `test/cli/executor.test.ts`
- `test/cli/invoke-tooling.test.ts`
- `test/cli/invoke-runtime-state.test.ts`
- `test/delegation/spawn-agent.test.ts`
- `test/delegation/message-agent.test.ts`
- `test/delegation/await-agent.test.ts`
- `test/delegation/agent-runtime.test.ts`
- `test/delegation/approval-routing.test.ts`
- `test/integration/m7-wiring.test.ts`

Operator and wrapper surfaces:

- `~/.claude/skills/delegate/SKILL.md`
- `~/.claude/skills/delegate/scripts/run_delegate.py`
- `~/.claude/skills/orchestrate/SKILL.md`
- `~/.claude/skills/orchestrate/scripts/run_orchestrate.py`

Explicit gap to assess:

- whether Codex has an equivalent first-party delegate/orchestrate entrypoint, or whether that remains a documented parity gap

### C3 Four-Axis Checks

Axis 1. Input and Evidence Acquisition

- executor request envelope: task, model, profile, allowed tools, authority, deadlines, required outputs
- delegate/orchestrate wrapper defaults
- narrowing-only behavior for allowed tools and authority
- caller-facing task prompt size vs offload goal

Axis 2. Witness Runtime and Orchestration

- `aca_run` -> `aca invoke` path
- internal `spawn_agent` / `message_agent` / `await_agent` path
- child-session creation and lineage
- bounded parallel offload through orchestrate wrapper
- invalid profile / invalid model / timeout behavior

Axis 3. Protocol and Aggregation

- structured success/error propagation back to external callers
- progress snapshot and approval bubbling behavior
- retry / takeover semantics in wrapper guidance
- conflict detection for parallel delegation

Axis 4. Persistence and Operator Surfaces

- delegate/orchestrate result JSON artifacts
- child session artifacts and lineage
- external wrapper docs and help text
- parity between runtime contract and caller instructions

### C3 Minimum Validation Set

Live:

- real bounded external `aca_run` path
- delegate-wrapper run against the built artifact
- bounded orchestrate parallel run
- failure case proving tool/profile restriction or timeout/error propagation
- at least one child-agent runtime scenario where lineage and completion are inspectable

Local:

- targeted MCP, executor, invoke-tooling, and delegation regressions only for the exact deterministic logic touched during the pass
- focused lint/typecheck/build for touched surfaces
- do not treat broad mock-heavy delegation suites as a closure gate unless they cover the precise contract being changed

### C3 Likely Hardening Triggers

Harden before closure if any of these are observed:

- external wrappers silently widen tools, authority, or deadlines
- Claude-facing wrappers and runtime contract drift apart
- Codex lacks an equivalent usable entrypoint and the gap is undocumented
- progress, approval, or child completion state fails to propagate back to the caller
- the supposed context-saving path still inlines too much project context to justify delegation

Residual routing note:

- if `C3` exposes a bounded hard-to-reproduce or non-blocking leftover after the main live claim is proven, record it for `C5`
- if the leftover breaks the main `C3` claim, do not move it; keep `C3` open or reopen it

## C4 — RP Researcher Profile and Workflow

Goal:

Re-audit the `rp-researcher` profile as a specialized research/write workflow, including model selection, profile prompt injection, tool bounds, required-output enforcement, and real RP-facing file generation behavior.

Primary product claim:

- `rp-researcher` can complete source-grounded RP discovery/write tasks without drifting into plan-only narration or generic coder behavior

### C4 Blast Radius

Primary runtime files:

- `src/delegation/agent-registry.ts`
- `src/core/prompt-assembly.ts`
- `src/cli/executor.ts`
- `src/cli-main.ts`
- `src/cli/invoke-output-validation.ts`
- RP-facing web/file tools used by the profile

Primary tests:

- `test/delegation/agent-registry.test.ts`
- `test/core/prompt-assembly.test.ts`
- `test/cli/executor.test.ts`
- `test/cli/invoke-output-validation.test.ts`
- `test/cli/provider-selection.test.ts`

Operator and wrapper surfaces:

- `~/.claude/skills/delegate/SKILL.md`
- `~/.claude/skills/delegate/scripts/run_delegate.py`
- `~/.claude/skills/orchestrate/SKILL.md`
- `~/.claude/skills/orchestrate/scripts/run_orchestrate.py`
- docs/comments that instruct users how to run `rp-researcher`

### C4 Four-Axis Checks

Axis 1. Input and Evidence Acquisition

- profile selection through executor context
- required output paths
- discovery vs write task framing
- network mode and tool list expectations in wrappers
- assigned output-path discipline

Axis 2. Witness Runtime and Orchestration

- profile prompt injection into invoke mode
- effective-model selection and fallback for `rp-researcher`
- first-message tool-use enforcement
- file creation flow for world / character outputs
- rejected-tool and missing-output repair loop behavior

Axis 3. Protocol and Aggregation

- plan-only vs valid completion classification
- profile repair prompt quality
- discovery brief vs final write distinction
- sequential multi-character workflow guidance in delegate/orchestrate docs

Axis 4. Persistence and Operator Surfaces

- required-output validation against actual written files
- RP output artifact traceability
- wrapper docs and examples
- parity between registry prompt, executor schema, and live wrapper usage

### C4 Minimum Validation Set

Live:

- bounded `rp-researcher` discovery-style run
- bounded `rp-researcher` write run with exact required output path
- failure case for plan-only / zero-tool completion
- model-fallback scenario for unavailable default model
- artifact check showing the expected RP-facing file was actually written

Local:

- targeted RP profile regressions in agent-registry, prompt-assembly, executor, invoke-output-validation, and provider-selection only where they lock down deterministic repaired behavior
- focused lint/typecheck/build for touched surfaces
- do not let broad non-runtime profile suites outweigh the real built-profile runs

### C4 Likely Hardening Triggers

Harden before closure if any of these are observed:

- plan-only completions still slip through without repair
- wrapper guidance drifts from the real profile tool set or output contract
- required output paths are not enforced tightly enough
- model fallback for `rp-researcher` differs across docs, wrappers, and runtime
- profile prompt and operator guidance encourage broad unbounded research instead of assigned-file execution

Residual routing note:

- if `C4` exposes a bounded hard-to-reproduce or non-blocking leftover after the main live claim is proven, record it for `C5`
- if the leftover breaks the main `C4` claim, do not move it; keep `C4` open or reopen it

## C5 — Residual Closure and Hard-to-Reproduce Cases

Goal:

Re-audit the bounded leftovers that remain after `C1` through `C4`, especially hard-to-reproduce live defects, unresolved residual risks, and operator-surface questions that still deserve the full audit method.

Primary product claim:

- residual issues are tracked, reproduced, hardened, or explicitly retired with the same discipline as earlier tracks instead of being left as vague notes

Critical guardrail:

- `C5` is not a dumping ground for real blockers
- if a residual issue negates the core product claim of `C1`, `C2`, `C3`, or `C4`, reopen that originating track instead of laundering it into `C5`
- only move an item to `C5` when the originating track is otherwise closed and the leftover is bounded, explicit, and worth a dedicated closure pass

Examples of valid `C5` candidates:

- live triage-retry scenarios that remain test-covered but are hard to trigger deterministically with the current provider set
- operator-surface residuals like debug-only harness retirement or documented parity gaps
- live quirks that were proven safe enough not to block closure, but still deserve a final reproduction or instrumentation pass

Examples that do not belong in `C5`:

- a confirmed runtime bug that breaks the main claim of an earlier track
- a docs/runtime mismatch that invalidates a prior closure note
- a live failure that shows the earlier track never really passed its required path

### C5 Blast Radius

Primary runtime files:

- item-defined; start from the residual source track and widen only as far as the leftover actually propagates
- likely hubs include `src/cli/consult.ts`, `src/consult/context-request.ts`, `src/mcp/server.ts`, `src/cli/executor.ts`, `src/delegation/*`, `src/cli/invoke-output-validation.ts`, and wrapper surfaces under `~/.claude/skills/` or `~/.codex/skills/`

Primary tests:

- item-defined focused regressions only
- if no direct focused test exists, add one before closure when feasible

Operator and bookkeeping surfaces:

- `codex-fixing/LIVE_VALIDATION.md`
- `codex-fixing/AUDIT_STATUS.md`
- `codex-fixing/LIVING_PROGRESS.md`
- `codex-fixing/RESUME.md`
- any wrapper/docs/help text that still describe the residual surface

### C5 Four-Axis Checks

Axis 1. Input and Evidence Acquisition

- is the residual triggered by a specific prompt, wrapper mode, packed evidence shape, or caller contract?
- can the reproduction be made deterministic enough to distinguish product defect from provider noise?

Axis 2. Witness Runtime and Orchestration

- does the residual depend on one provider, one wrapper, one runtime path, or a broader orchestration seam?
- is the current behavior safe degradation, silent corruption, or a true runtime failure?

Axis 3. Protocol and Aggregation

- do retries, repairs, and degraded classifications remain truthful for this residual?
- does the residual expose a missing guardrail, missing artifact, or missing classification rule?

Axis 4. Persistence and Operator Surfaces

- are the relevant raw artifacts preserved well enough to debug a repeat occurrence?
- do bookkeeping, docs, and operator guidance say exactly what is still unresolved?

### C5 Minimum Validation Set

Live:

- at least one bounded live attempt that either reproduces the residual or demonstrates why it remains non-deterministic
- preserved artifact paths for every live attempt
- a final disposition for each item: fixed, retired, reclassified as harmless, or escalated back to its source track

Local:

- focused tests for the exact residual surface only when they add real deterministic signal, or an explicit note that no meaningful local harness exists yet
- focused lint/typecheck/build for any touched files
- do not create or chase broad suites in `C5`; the point is to close residual live questions, not inflate mocked coverage

### C5 Likely Hardening Triggers

Harden before closure if any of these are observed:

- the supposedly residual item actually breaks the primary claim of an earlier track
- the live residual cannot be understood because raw artifacts are missing or misleading
- provider-specific drift repeats often enough that a stronger runtime classification or retry rule is needed
- the same residual shows up across multiple tracks and really belongs to a shared structural subsystem

## C6 — RP Knowledge Pack Import Workflow

Goal:

Productize the RP import path so that a request like "research `<series>` for RP" creates a targeted LLM-facing knowledge pack under the RP project instead of a fandom encyclopedia.

Primary product claim:

- ACA can resolve a series name, create the correct series folder under the RP project, research the series with timeline gating, and write a strict RP-facing pack in `.md` format under that folder

Calibration anchor:

- the live calibration case for `C6` is the anime version of *The Quintessential Quintuplets*
- `C6` is not closed just because the pipeline runs once; it closes only when the Quints pack reaches approval-quality depth and width for the operator

Design locks:

- local default target root on this machine is `/home/blake/projects/rpproject`
- public behavior must stay configurable through explicit flags and/or config/env overrides
- series folders are created from a normalized kebab-case slug
- `RP_AUTHORING_CONTRACT.md` is the source of truth for final-file placement, portrayal-first writing, and guidance bans; the runtime prompts and workflow docs must stay aligned with it
- the RP-facing payload lives under:
  - `research/`
  - `world/world.md`
  - `world/world-rules.md`
  - `world/characters/*.md`
  - `world/locations/*.md`
- final files are LLM-facing RP operating docs, not encyclopedia entries
- final files should provide shape, not guidance: they should describe facts and portrayal rather than coach the model how to roleplay
- character files use only the approved section schema and omit non-applicable sections instead of inventing new headings
- character profiles are the primary vehicle of the pack; `world.md` and `world-rules.md` are support layers rather than characterization overflow
- `world.md` and `world-rules.md` stay separate:
  - `world.md` is the greater setting, stable background, and relevant pre-arc context
  - `world-rules.md` is mandatory but may be brief; it holds only factual cross-cutting mechanics, constraints, and special rules
- location files stay factual and tight:
  - the location itself
  - relevant background only when it materially explains why the place matters
  - notable sublocations
  - no daily-life filler or beat-by-beat usage
- final files forbid narrator guidance, tone guidance, spoiler/timeline constraints, `normal / unusual / forbidden` taxonomy, and generic genre explanation
- the workflow researches major arcs before final file generation, then either asks for a timeline choice or keeps the pack timeline-neutral without mixing incompatible arc states

### C6 Blast Radius

Primary runtime files:

- `src/cli-main.ts`
- `src/cli/executor.ts`
- `src/delegation/agent-registry.ts`
- `src/cli/invoke-output-validation.ts`
- `RP_RESEARCH_WORKFLOW.md`
- any new RP-import command, helper, slug/path logic, or schema enforcement surfaces added during this track

Primary tests:

- focused deterministic tests for any touched RP-import command/helper surfaces
- focused executor / output-validation tests only where they lock down the repaired contract

Operator and wrapper surfaces:

- `~/.claude/skills/delegate/`
- `~/.claude/skills/orchestrate/`
- `~/.codex/skills/delegate/`
- `~/.codex/skills/orchestrate/`
- `/home/blake/projects/rpproject/workflow.md`
- `/home/blake/projects/rpproject/TRINITY_SEVEN_RP_HANDOFF.md`
- `/home/blake/projects/rpproject/EXAMPLE`

### C6 Four-Axis Checks

Axis 1. Intake and Timeline Gating

- series-name resolution and slug creation
- default RP-root resolution vs explicit overrides
- major-arc discovery before final generation
- blank-timeline vs chosen-arc behavior
- refusal to merge incompatible arc states into one supposedly neutral pack

Axis 2. Runtime Generation Path

- real built runtime creates the series folder and RP pack skeleton
- exact output paths are enforced
- delegate/orchestrate or direct command paths preserve the task shape truthfully
- fallback and retry behavior keep file placement and schema intact

Axis 3. Output Contract Fidelity

- character files stay inside the approved section set with no extra headings
- non-applicable sections are omitted and depth is pushed into the remaining valid sections
- character writing preserves behavioral shape and faithful portrayal instead of collapsing into adjective stacks or trope labels
- `world.md` and `world-rules.md` stay in their own lanes
- location files remain factual and concise
- the pack avoids encyclopedia drift, RP hooks, creeping plotlines, fluff, and any guidance-like prose that tells the model how to roleplay

Axis 4. Iteration and Operator Acceptance

- the produced pack is reviewable and repairable in bounded follow-up passes
- depth can be increased without schema creep
- width can be increased without trivia sprawl
- closure depends on explicit operator approval of the Quints calibration pack

### C6 Minimum Validation Set

Live:

- Quints discovery pass that stops at timeline choice
- Quints blank-timeline pack build
- Quints arc-scoped pack build
- Quints repair/regeneration pass after operator feedback
- Quints width-expansion pass proving side-character and location coverage can be widened cleanly
- bounded RP-consumer smoke test showing the generated pack actually improves portrayal/usefulness for RP

Local:

- `npm run build`
- `npx tsc --noEmit`
- focused lint/tests only for touched deterministic logic
- `python3 -m py_compile` for changed wrappers

### C6 Likely Hardening Triggers

Harden before closure if any of these are observed:

- the target root is not resolved predictably between local default and generic public overrides
- the workflow writes the right files but in the wrong schema or with extra headings
- timeline-neutral generation still leaks incompatible later-state facts into the same pack
- width expansion drifts into fandom completeness instead of RP utility
- repair passes "improve" files by adding new sections instead of deepening the approved ones
- operator feedback cannot be translated into bounded regeneration without rebuilding the whole pack manually

## C7 — Forced Tool Emulation and Blast-Radius Hardening

Goal:

Re-audit ACA's intentional forced-tool-emulation design on NanoGPT and harden the full blast radius around it before more live RP import work resumes.

Primary product claim:

- forced tool emulation on NanoGPT is intentional product behavior, and ACA can keep that behavior truthful, safe, and robust across tool-enabled and no-tools workflows without silently breaking delegation, witnesses, triage, or RP research

Design locks:

- forced emulation for NanoGPT tool-enabled runs is intentional and should stay explicit
- capability surfaces should report that truthfully as `supportsTools: emulated`
- emulation prompt injection must override prose-before-tools behavior strongly enough for real NanoGPT models
- emulation parsing must recover the pseudo-tool variants that occur live without widening into unsafe garbage acceptance
- no-tools consult/triage paths must still classify pseudo-tool markup as degraded output rather than silently treating it as valid content
- `C7` does not replace `C6`; it is a detour track that runs first, then `C6` resumes from its archived Quints baseline

### C7 Blast Radius

Primary runtime files:

- `src/providers/tool-emulation.ts`
- `src/providers/nanogpt-driver.ts`
- `src/providers/model-catalog.ts`
- `src/providers/model-registry.ts`
- `src/types/provider.ts`
- `src/cli-main.ts`
- `src/mcp/server.ts`
- `src/cli/invoke-output-validation.ts`
- `src/cli/consult.ts`
- `src/consult/context-request.ts`
- `src/cli/rp-research.ts`
- any shared prompt or stream-normalization surface touched by the emulation contract

Primary tests:

- `test/providers/tool-emulation.test.ts`
- `test/providers/nanogpt-driver.test.ts`
- focused invoke / consult / RP workflow tests only where they lock down deterministic emulation behavior

High-risk downstream callers:

- tool-enabled built `aca invoke`
- external delegation via delegate/orchestrate
- consult witness runs that enable tools
- no-tools consult scout/final/triage paths that must degrade pseudo-tool output cleanly
- `rp-researcher` / `C6`

### C7 Four-Axis Checks

Axis 1. Capability and Prompt Contract

- do capability surfaces consistently report forced emulation instead of native tools on NanoGPT?
- do prompt builders and system injection make the "JSON only, no pseudo-tool wrappers" contract explicit enough for live models?
- do no-tools workflows tell the model not to emit pseudo-tool markup in a way that matches their runtime validators?

Axis 2. Runtime Parsing and Stream Behavior

- does the parser recover the live wrapper variants we actually see (`<tool_calls>`, repeated `<tool_call>`, arg-tag forms, function-tag forms, truncated JSON)?
- does it reject empty-name or otherwise invalid calls instead of widening into unsafe acceptance?
- do streamed native-like tool-call deltas and emulated tool-call text stay normalized truthfully?

Axis 3. Cross-Workflow Blast Radius

- does forced emulation hold up on built `invoke` tool use?
- does it hold up across delegate/orchestrate child runs?
- do witness workflows behave correctly both when tools are enabled and when tools are forbidden?
- does RP research still satisfy exact required output paths through the emulated contract?

Axis 4. Persistence and Operator Surfaces

- are saved artifacts and error codes truthful about whether a run used emulated tools?
- do docs/tests/help text describe forced emulation honestly?
- can a degraded pseudo-tool case be distinguished from a valid tool run from the saved artifacts alone?

### C7 Minimum Validation Set

Live:

- built `aca invoke` tool-enabled run on NanoGPT proving forced emulation still executes a real tool
- built delegation run proving a child/offloaded task can complete through the emulated tool path
- built witness/tool-enabled run proving a witness can still use tools under forced emulation
- built no-tools consult or triage run proving pseudo-tool markup is classified as degraded instead of treated as valid content
- built `rp-researcher` run proving exact required-output creation still works on the emulated path
- at least a small multi-model NanoGPT bakeoff on representative candidates used in this repo's real workflows

Local:

- focused provider/emulation regressions
- focused invoke / consult / RP tests only where they lock down deterministic repaired behavior
- `npm run build`
- `npx tsc --noEmit`
- focused lint on touched surfaces

### C7 Likely Hardening Triggers

Harden before closure if any of these are observed:

- capability reporting still says `native` anywhere that the runtime forces emulation
- the parser accepts malformed garbage that should stay rejected
- a live model still prefers pseudo-tool wrappers or prose-before-tools despite the current prompt contract
- no-tools consult paths silently quote or absorb pseudo-tool content instead of degrading it
- one downstream workflow passes only because another surface is masking the emulation defect
- wrapper/docs/help text still imply native tools on NanoGPT when the runtime is emulating them

## Closure Notes

`C1` through `C7` should be tracked exactly like milestones:

- keep the board row `pending` until execution starts
- move to `in_progress` during the active pass
- only mark `done` after focused local validation, bounded live validation, and a residual-risk note

If `C1` exposes a protocol defect, fix it where it lives but keep bookkeeping anchored to `C1`.

If `C2` exposes wrapper or runtime drift, record the blast radius explicitly and update both tracks if needed.

If `C3` exposes a caller-surface gap, record whether the gap is runtime, wrapper, or product-shape drift rather than collapsing it into generic delegation failure.

If `C4` exposes RP-specific drift, keep the fix anchored to `C4` even when the code lives in shared invoke/profile infrastructure.

If `C6` exposes RP-import workflow drift, keep the fix anchored to `C6` even when the code lives in shared executor/profile/path infrastructure.

If `C7` exposes tool-emulation drift, keep the fix anchored to `C7` even when the code lives in shared provider/runtime/prompt infrastructure.

If a residual is parked in `C5`, keep a pointer back to the source track and reopen that source track if the residual turns out to be a disguised blocker.
