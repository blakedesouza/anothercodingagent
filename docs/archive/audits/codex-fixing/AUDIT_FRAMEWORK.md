# ACA Re-Audit Framework

This is the concrete framework for the second-pass audit.

The first pass answered: "what is in the milestone blast radius?"

This pass also answers:

- does the code have a live runtime caller?
- does it behave the same across modes?
- does its state round-trip through disk and resume?
- do degraded and failure paths work?
- do docs, tests, schemas, and runtime all describe the same thing?

## Scope

Run this from Phase 0 through Milestone 11.

Post-M11 follow-on tracks may be added when a residual product surface needs the same closure bar.

Current follow-on plan:

- `codex-fixing/POST_M11_TRACKS_PLAN.md` (`C1` through `C7`)

Primary source inputs:

- `docs/steps/*.md`
- `codex-fixing/README.md`
- `docs/anti-rot-checklist.md`

Primary output artifacts:

- `codex-fixing/AUDIT_STATUS.md`
- `codex-fixing/LIVING_PROGRESS.md`
- `codex-fixing/RESUME.md`
- `codex-fixing/POST_M11_TRACKS_PLAN.md`
- milestone-specific notes derived from `codex-fixing/MILESTONE_AUDIT_TEMPLATE.md`

## Post-M11 Follow-On Rule

The original step ladder ends at Milestone 11.

If residual work remains, track it as a named follow-on pass instead of pretending it belongs to an unfinished original milestone.

Rules:

- use the same closure bar as a milestone
- give it an explicit blast radius
- define required local and live validation up front
- update the same audit bookkeeping files as the milestone walk

## Consult Four-Axis Overlay

The general audit axes still apply.

For post-M11 follow-on work, use this four-axis operating overlay from `POST_M11_TRACKS_PLAN.md` so user-facing workflow, protocol seams, delegation plumbing, and specialist-profile behavior are not blurred together:

1. input and evidence acquisition
2. witness runtime and orchestration
3. protocol and aggregation
4. persistence and operator surfaces

## Mandatory Live Validation Rule

Local tests are necessary but not sufficient.

For post-M11 follow-on tracks, the weighting is explicit:

- live built-artifact validation is the primary confidence source
- focused local regressions support the live pass by locking down deterministic logic and artifact truthfulness
- broad mock-heavy suites are lower-signal and should not substitute for a missing live proof

Every milestone may only be closed when it also has bounded live validation against the real NanoGPT path for the milestone's runtime-facing claims.

Minimum rule:

- if the milestone touches runtime behavior, it must have at least one real-provider scenario
- if the milestone touches more than one runtime mode, live validation must cover the most important affected mode plus the highest-risk parity edge
- if the milestone touches persistence or resume, one live scenario must inspect the resulting on-disk state
- if the milestone has no meaningful runtime surface, record why live validation is `n/a` instead of silently skipping it

Closure rule:

- no milestone is `done` until both local validation and required live validation are recorded
- live runs must be written into `codex-fixing/LIVE_VALIDATION.md`
- if live validation fails, the milestone stays `in_progress` or `blocked` until the failure is understood

## Core Scope Rule

The unit of audit is not just the milestone.

The unit of audit is:

- the milestone
- the milestone's full blast radius
- every live runtime path, persisted surface, parity surface, and failure path touched by that blast radius

Practical rule:

- start from the milestone step file
- expand to everything the milestone touches
- then run every audit axis across that expanded scope

If a milestone touches a structural subsystem, the subsystem is in scope even if parts of it nominally belong to other milestones.

## Audit Axes

Every milestone re-audit must be judged on these axes.

### 1. Blast Radius

Find the step and its dependency chain.

Questions:

- what earlier contracts does this milestone depend on?
- what later systems inherit it?
- what shared helpers, schemas, prompts, or persisted fields does it touch?

Minimum input:

- milestone step file
- connection map in `codex-fixing/README.md`

Output:

- the list of files, contracts, persisted artifacts, entrypoints, and downstream systems that are in scope for this milestone pass

### 2. Live Runtime Topology

Prove the code is actually live.

Questions:

- what real entrypoints execute this path?
- does the runtime call the intended helper, or is the helper dead?
- is there any mode where the feature is claimed but not wired?

Entrypoints to consider:

- one-shot
- repl
- invoke
- mcp
- consult
- internal delegation
- startup/bootstrap paths

Default rule:

- helper code with only test callers is suspect until a live caller is proven

### 3. Persistence / Replay / Resume

Treat on-disk state as a first-class contract.

Questions:

- what gets written to disk?
- what reads it back?
- what rebuilds from it later?
- can live state and resumed state diverge?

Surfaces:

- session manifest
- conversation log
- turn records
- step records
- summaries
- durable task state
- checkpoints
- sqlite rows
- delegation tracker state
- index / cache artifacts

### 4. Contract Parity

Check every layer that claims the same contract.

Questions:

- do writers and readers agree?
- do schemas and validators agree?
- do prompts/examples match live tool contracts?
- do docs/changelog/test names overstate reality?
- do different modes expose the same behavior?

Typical parity drifts:

- writer updated, reader stale
- helper updated, live caller stale
- docs/test names describe behavior the assertions do not prove
- one mode uses a new path, another mode still uses a legacy path

### 5. Negative / Degraded Paths

Audit failure behavior, not just happy-path success.

Questions:

- what happens on auth failure?
- malformed model output?
- rate limit?
- timeout / no output?
- partial write?
- approval denied?
- child failure?
- crash and resume?

Default rule:

- for core runtime systems, "happy path passed" is not evidence of completeness

### 6. Dead Code / Fake Completion

Look for implementation that exists on paper but not in reality.

Search for:

- code with only test callsites
- structs carrying fields that no runtime path fills
- methods with no runtime caller
- feature docs without a live path
- comments such as `placeholder`, `for now`, `deferred`, `v1`, `TODO`

Default rule:

- if the runtime never reaches it, it is not complete

## Required Procedure Per Milestone

### Step 1. Read The Step File

Read the milestone step file and note:

- explicit claims
- implicit contracts
- required entrypoints
- persisted artifacts
- operator-visible behavior

### Step 2. Build A Capability List

For that milestone, list each capability introduced or changed.

For each capability, map:

- entrypoint(s)
- primary files
- state written
- state read
- downstream dependents
- likely failure modes

Do this for the milestone plus the connected blast zone, not only the files named in the step doc.

### Step 3. Prove Liveness

For each capability:

- identify the live caller
- identify the execution path
- identify where it becomes visible to users or other subsystems

If no live caller exists, record it as a finding immediately.

### Step 4. Check Parity Surfaces

Search:

```bash
rg -n "symbol|field|tool_name|error_code|prompt_fragment" src test docs
```

Verify:

- producers
- consumers
- persistence
- replay / resume
- derived views
- prompts / examples
- tests / fixtures

### Step 5. Exercise Negative Paths

Select the most important failure modes for that milestone and verify them.

Minimum expectation for core runtime milestones:

- one degraded or error path
- one persistence or resume path if state exists
- one cross-mode parity check if more than one mode is affected

### Step 6. Fix Confirmed Bugs

Fix the confirmed defects in the current milestone blast zone.

Rules:

- keep fixes minimal and focused
- if the real bug lives in another module, fix it there
- update the milestone worksheet with what was touched outside the nominal milestone

### Step 7. Validate

Run the closest relevant validation:

- focused tests
- integration tests
- `tsc --noEmit`
- build
- targeted lint if appropriate

Do not report success without passing validation.

### Step 8. Run Live Validation

Run bounded real-provider validation for the milestone's runtime-facing claims.

Record:

- scenario ID
- command shape
- workspace / HOME isolation
- expected result
- actual result
- durable evidence path
- pass / fail / pending state

If the milestone touches multiple important runtime surfaces, use a small scenario bank instead of a single smoke test.

### Step 8. Live Validation Gate

For runtime-facing milestones, local validation is not enough by itself.

Minimum rule:

- if a milestone touches the built CLI, provider path, turn engine, tool execution, approval flow, or invoke path, run at least one bounded real NanoGPT scenario through the built artifact
- if a fix changes execution or approval semantics, run a targeted live scenario that proves the changed behavior
- record the scenario, command shape, result, and artifact/session path in `codex-fixing/LIVE_VALIDATION.md`

Default expectation for early runtime milestones:

- Phase 0: built artifact boots and reaches the real provider path
- Milestone 1: one-shot and/or invoke succeed against the real provider path and write durable artifacts
- Milestone 2: at least one real tool-execution scenario and one real denial/approval scenario

If live validation cannot be run:

- state exactly why
- do not treat the milestone as fully closed

### Step 8. Update Audit Status

Update `codex-fixing/AUDIT_STATUS.md` after every milestone pass.

A milestone should be one of:

- `pending`
- `in_progress`
- `blocked`
- `done`

Do not mark `done` unless all required axes for that milestone are satisfied.

### Step 9. Update Living Progress

Update `codex-fixing/LIVING_PROGRESS.md` with:

- what milestone was just audited
- what was fixed
- what structural blockers or hotspots were discovered
- what the next restart point is

If the session may be resumed later, also refresh `codex-fixing/RESUME.md`.

## Severity Rules

Use these to decide whether to widen the audit or stop the line.

### Stop-The-Line

- dead live path
- persistence corruption
- wrong lineage / identity / authority propagation
- runtime path materially different from documented/tested path
- helper-only implementation for a user-visible feature

### High

- mode parity break
- negative path broken in a core subsystem
- stale schema / reader mismatch
- resume or replay mismatch

### Medium

- docs/tests overstating behavior
- incomplete validation coverage
- stale examples or prompts that can mislead runtime behavior

## Exit Criteria

A milestone is only done when:

- the blast radius is mapped
- the live caller path is proven
- required persistence / replay surfaces are checked
- at least one meaningful negative path was checked when applicable
- parity surfaces are aligned
- fixes are validated
- residual risk is explicitly stated

## Cross-Cutting Subsystems To Revisit Repeatedly

These should be rechecked whenever a milestone touches them:

- turn engine
- session manager / replay
- prompt assembly / context assembly / summarization
- approval / authority / preauth
- provider abstraction / fallback
- invoke / executor mode
- consult / witness pipeline
- internal delegation
- observability / SQLite analytics

## Restart Order

Restart from:

1. Phase 0
2. Milestone 1
3. Milestone 2
4. Milestone 3
5. Milestone 4
6. Milestone 5
7. Milestone 6
8. Milestone 7
9. Milestone 8
10. Milestone 9
11. Milestone 10
12. Milestone 11

The earlier blast-radius pass is supporting evidence only. Treat this framework as the new source of truth for closure.
