# Consult Harness Impact Audit

Date: 2026-04-17
Mode: architect / REVIEW
Scope: consult harness drift, blast radius, and missing impact points after the intentional `deepseek -> minimax` witness-seat swap.

## Goal

Map the important consult-harness change surfaces, identify the real blast radius of each one, and isolate the highest-risk drift that is still being missed.

This is an audit artifact, not an implementation plan. The purpose is to make the remaining consult work committable and debuggable instead of leaving it as an ambiguous dirty slice.

## Assumption

The intentional product decision is:

- MiniMax is now the real first witness seat.
- Historic `deepseek` references are compatibility leftovers unless explicitly retained as policy.

If that assumption changes, parts of this audit need to be reinterpreted as compatibility work rather than drift.

## Current Runtime Status

Observed consult state in the repo:

- `src/config/witness-models.ts` now makes `minimax/minimax-m2.7` the first witness seat.
- `src/cli/consult.ts` `selectWitnesses()` accepts `deepseek` only as a compatibility alias and resolves it to the MiniMax seat.
- `~/.codex/skills/consult/scripts/run_consult.py` now normalizes `deepseek -> minimax` instead of rewriting MiniMax back to a stale DeepSeek label.
- `src/cli/consult.ts` applies strict advisory handling to the primary reliability seat rather than keying off a dead DeepSeek model string.

Result:

- consult has an intentional seat swap that is now reflected in the mainline runtime
- the remaining drift is concentrated in stale utilities, scripts, and current docs that still describe old DeepSeek-era assumptions

## Validation Evidence

Targeted local validation:

- `npm run build` passed.
- `npm run test -- test/config/witness-models.test.ts` passed.
- `npm run test -- test/consult/context-request.test.ts` passed.
- `npm run test -- test/cli/consult.test.ts` failed `10/32`.

Failure pattern from `test/cli/consult.test.ts`:

- tests still hardcode `deepseek/deepseek-v3.2`
- tests still expect DeepSeek-specific advisory behavior and witness naming
- degraded/triage expectations still refer to `deepseek` as the concrete model

Live witness status established outside this file:

- the current clean default pair is `minimax + gemma`
- `qwen` remains useful as an opt-in diversity seat, but it is too flaky on advisory prompts for default duty
- `glm-5` remains strongest as triage, not yet the default second witness

## Decisions Applied

Implemented on 2026-04-17:

- default consult witness pair is now `minimax + gemma`
- `deepseek` remains only as an input compatibility alias; the mainline runtime/test surface now uses `minimax`
- default ACA triage mode is now `auto` instead of always-on
- consult CLI now accepts `--triage auto|always|never`
- `--skip-triage` is preserved as compatibility and maps to `never`
- local debug UI no longer hardcodes a DeepSeek-era 4-seat roster; fallback witness cards are now seedable through `ACA_DEBUG_UI_WITNESS_SEED`
- active helper scripts no longer default to a stale DeepSeek witness/triage lineup
- witness-mode anchored file opens now accept prompt/evidence-pack-grounded paths, aligning that path with shared-context grounding
- direct non-repo questions now route to advisory mode instead of falling back to review mode by default
- strict advisory rubrics are skipped for explicit exact-format prompts such as `Answer with exactly: 4`
- advisory retry prompts now stay inside the advisory protocol instead of re-embedding the repo-oriented context-request contract
- advisory witness validation now rejects prompt/protocol reflection leakage instead of accepting it as a valid report

Validation after implementation:

- `npm run test -- test/consult/context-request.test.ts test/cli/consult.test.ts`
- `npm run test -- test/cli/build.test.ts test/debug-ui/manager.test.ts test/config/witness-models.test.ts`
- `npm run test -- test/consult/context-request.test.ts test/cli/consult.test.ts test/consult/symbol-lookup.test.ts test/cli/build.test.ts test/debug-ui/manager.test.ts test/config/witness-models.test.ts test/prompts/model-hints.test.ts`
- `npm run build`
- live canaries after rebuild:
  - `deepseek` compatibility alias resolves to real `minimax`
  - direct exact-answer consults now save clean final artifacts (`4`) instead of review-style witness dumps
  - broader canaries on the current default pair `minimax + gemma` completed cleanly without triage escalation

## Major Change Surfaces

### 1. Witness identity and alias policy

Relevant code:

- `src/config/witness-models.ts`
- `src/cli/consult.ts` `selectWitnesses()`
- `~/.codex/skills/consult/scripts/run_consult.py`
- `test/cli/build.test.ts`
- `test/cli/consult.test.ts`

Current behavior:

- runtime canonicalizes `deepseek -> minimax`
- wrapper canonicalizes `deepseek -> minimax`
- outward result artifacts now show the real witness seat name and concrete model

Impact radius:

- CLI and skill-wrapper compatibility surface
- result JSON keys and human-readable witness labels
- triage sections that print witness name plus concrete model
- tests that assert exact witness keys or exact model IDs
- docs and handoffs that still describe DeepSeek as active

Risk:

- operator sees `deepseek` while ACA actually used MiniMax
- debugging becomes ambiguous because seat identity and model identity diverge
- external tooling can treat compatibility labels as ground truth and draw the wrong conclusion

Audit conclusion:

- this is not a single bug
- it is a policy boundary that has not been made explicit
- the repo needs one canonical answer to: is `deepseek` a compatibility alias only, or still a public seat name

### 2. Advisory-mode routing and rubric gating

Relevant code:

- `src/cli/consult.ts` `inferConsultTaskMode()`
- `src/cli/consult.ts` `runWitness()`
- `src/cli/consult.ts` `classifyAdvisoryWitnessAnswer()`
- `src/cli/consult.ts` `usesStrictAdvisoryRubric()`
- `src/consult/context-request.ts` advisory prompt builders

Current behavior:

- advisory tasks bypass the normal repo-oriented witness context loop
- advisory retries and last-chance prompts now exist
- stricter substantive rubric is activated only when the model string contains `deepseek`

Impact radius:

- advisory answer quality
- empty-response recovery behavior
- malformed-answer recovery
- witness comparability across seats
- test expectations for advisory structure

Risk:

- the active first seat is MiniMax, but DeepSeek-only advisory hardening no longer fires there
- the strongest instruction-following seat is no longer the seat getting the strictest advisory constraints
- quality regressions can look like model weakness when they are actually rubric-selection drift

Audit conclusion:

- advisory hardening is currently attached to the wrong identity boundary
- if the real policy is “apply strict advisory structure to the primary seat” or “apply it to models with this failure shape,” the code does not express that
- task-mode routing itself was also part of the blast radius: advisory prompts that did not match the narrow keyword list were falling into review mode and bypassing the advisory guardrails entirely

### 3. Advisory retry prompt drift

Relevant code:

- `src/consult/context-request.ts` `buildAdvisoryContextRequestRetryPrompt()`
- `src/consult/context-request.ts` `buildContextRequestPrompt()`

Current behavior:

- `buildAdvisoryContextRequestRetryPrompt()` starts by embedding the full witness context-request protocol via `buildContextRequestPrompt()`
- then it appends advisory instructions saying not to request repo trees/files/symbols for advisory tasks

Impact radius:

- retry behavior after an invalid advisory answer
- prompt clarity
- malformed-response rate on advisory retries

Risk:

- the retry prompt reintroduces the full repo-inspection protocol surface into a path that is supposed to discourage repo inspection
- that contradiction can pull models back toward `needs_context` JSON or repo fishing during retries

Audit conclusion:

- this is a genuine prompt-design inconsistency
- it is small in code size but large in behavioral leverage

### 4. Witness-mode anchored retrieval contract

Relevant code:

- `src/consult/context-request.ts` `inspectContextRequests()`
- `src/consult/context-request.ts` `normalizeAnchoredContextRequests()`
- `src/consult/context-request.ts` `resolveFileRequestProvenance()`
- `src/consult/context-request.ts` `resolveExpandRequestProvenance()`

Current behavior:

- anchored witness parsing accepts `symbol`, `file`, `expand`, and `tree`
- anchored file requests are grounded only by:
  - pre-verified symbol locations
  - prior snippets
  - prior tree listings

Impact radius:

- all witness no-tools retrieval after the first pass
- packed review behavior
- repo-fact witness behavior
- file reopen / continuation behavior

Risk:

- witness-mode grounding does not currently include prompt/evidence-pack-grounded direct file sources
- so a witness can be shown a file in the ACA-built evidence pack and still be unable to reopen that file through the anchored path unless a prior snippet/tree happens to ground it

Audit conclusion:

- this is the highest-signal missed impact point in the current harness
- it directly matches the observed `qwen` packed-review failure mode where already-packed files were requested again and rejected

### 5. Shared-context scout versus witness grounding mismatch

Relevant code:

- `src/cli/consult.ts` `buildSharedContext()`
- `src/consult/context-request.ts` `extractPromptGroundedFileSources()`
- `src/consult/context-request.ts` `inspectContextRequests()` with `groundedDirectFileSources`

Current behavior:

- shared-context initial parsing supports prompt/evidence-pack-grounded direct file opens
- it explicitly passes `groundedDirectFileSources`
- witness anchored parsing does not accept those same prompt/evidence-pack anchors

Impact radius:

- mismatch between scout behavior and witness behavior on the same consult input
- difficulty interpreting packed evidence consistently across phases

Risk:

- shared context can legally open a file that the witness phase later treats as not grounded
- that makes the consult pipeline internally inconsistent and harder to reason about

Audit conclusion:

- the scout and witness grounding models are no longer aligned
- the design document says they should be

### 6. Finalization salvage and degraded triage input

Relevant code:

- `src/cli/consult.ts` `extractSalvageableFinalReport()`
- `src/cli/consult.ts` fallback witness-note generation
- `src/cli/consult.ts` `buildTriagePrompt()`
- `src/review/markdown-adapter.ts`

Current behavior:

- ACA now salvages some malformed structured finalization output into Markdown
- if that fails, ACA produces degraded fallback witness notes and feeds those into triage
- structured review consumes the same triage-facing witness artifacts

Impact radius:

- witness result quality under failure
- triage quality
- operator debugging via `/tmp` artifacts
- deterministic structured aggregation

Risk:

- degraded witness notes are useful, but they increase the number of weak-evidence paths the rest of the pipeline must interpret correctly
- if naming/rubric/grounding drift remains unresolved, triage and structured review will be analyzing a noisy mix of valid reports and degraded recovery artifacts

Audit conclusion:

- this area is not the primary root cause of the current drift
- but it amplifies the cost of the earlier drift because more fallback artifacts now enter downstream stages

### 7. Triage invocation policy

Relevant code:

- `src/cli/consult.ts` `runConsult()`

Current behavior:

- ACA still runs LLM triage whenever `!skipTriage && triageableCount > 0`

Impact radius:

- latency
- cost
- malformed-output surface
- operator trust in final consult output

Risk:

- with a reduced 2-witness setup, always-on triage makes the judge a routine formatting stage instead of a disagreement resolver
- that expands failure surface without always adding signal

Audit conclusion:

- this is not the root cause of the current malformed witness results
- but it should be revisited after the naming and grounding drift is fixed

### 8. External blast radius beyond the consult core

Relevant files already showing drift:

- utility scripts still default to DeepSeek-era model IDs or pairings
- current planning docs still describe the abandoned `minimax + qwen` branch as if it were the mainline default
- local fixture/artifact directories can still contain historical DeepSeek-named files, even when the current runtime no longer uses that seat

Impact radius:

- test suite credibility
- tool-wrapper compatibility
- prompt hint selection
- local operator expectations

Risk:

- the repo can appear half-broken even when the runtime is following an intentional seat-policy change
- conversely, real regressions can be obscured by compatibility noise

Audit conclusion:

- the current red test surface is a genuine signal, but not all of it is product breakage
- some of it is evidence that compatibility policy was never fully codified

## Highest-Risk Missing Impact Point

The most important thing still being missed is:

- witness-mode anchored parsing does not accept evidence-pack-grounded direct file anchors, even though the shared-context path does and the design explicitly says evidence-pack anchors are valid.

Why this matters more than the rest:

- it directly affects packed consults, which are the most important low-noise witness mode
- it matches an observed real-model failure, not just a test mismatch
- it explains why a strong witness can still look malformed under ACA even when the evidence pack already contains the right files

## What Is Intentional Versus Drift

Intentional:

- MiniMax replacing DeepSeek as the real first witness seat
- advisory-mode direct-answer path
- stronger fallback/salvage handling
- anchored retrieval hardening

Unintentional drift:

- stale DeepSeek-era assumptions in helper scripts and current docs
- witness quality calibration still lagging behind the now-stable protocol layer

## Recommended Fix Order

### 1. Decide and codify witness naming policy

Pick one explicit rule:

- `deepseek` remains a compatibility alias only, with result artifacts clearly showing the real model, or
- `deepseek` is removed from the mainline surface and tests/wrappers/docs move to `minimax`

This must be settled first because it affects tests, wrappers, operator output, and prompt-policy selection.

### 2. Move advisory strictness to a real policy boundary

Possible boundaries:

- primary witness seat
- explicit witness name
- explicit model family list
- per-model failure-profile config

Current `model.includes('deepseek')` logic is stale under the current seat policy.

### 3. Fix the advisory retry prompt contradiction

Make the advisory retry prompt advisory-native instead of embedding the full context-request protocol and then trying to undo it with extra instructions.

### 4. Extend witness grounding to honor evidence-pack anchors

Bring witness-mode anchored parsing into line with:

- the design doc target invariants
- shared-context initial parsing
- actual packed-review behavior needs

### 5. Realign tests and wrapper behavior

After the runtime policy is settled:

- update `test/cli/consult.test.ts`
- update `test/cli/build.test.ts`
- update the consult skill wrapper
- update any utility scripts or docs that still target dead DeepSeek behavior

### 6. Revisit triage policy after the core drift is fixed

Then decide whether default consult should move to:

- `2 witnesses + external judge`
- ACA triage only on disagreement/degradation/synthesis demand

## Recommended Next Validation Pass

After fixes, re-run:

- `npm run test -- test/consult/context-request.test.ts`
- `npm run test -- test/cli/consult.test.ts`
- `npm run test -- test/cli/build.test.ts`

Then repeat live canaries for:

- advisory direct-answer task
- repo-fact task
- packed review task

Recommended seat focus:

- `minimax + gemma`

## Bottom Line

The consult harness is no longer “generally messy.” It is concentrated around one real unfinished branch of work:

- intentional witness-seat policy changed
- but the harness still has stale identity assumptions and one important grounding gap

The highest-value next step is not broad refactoring. It is to close the policy drift and the evidence-pack grounding mismatch so the harness stops making strong witness seats look malformed for ACA-specific reasons.
