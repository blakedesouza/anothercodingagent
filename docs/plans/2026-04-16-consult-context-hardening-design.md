# Consult Context Hardening Design

## Goal

Make ACA consult context retrieval provenance-driven instead of guess-driven.

The immediate problem is that witnesses can currently request raw line ranges such as `250-300` without proving why those lines are a legitimate next read. ACA clamps those requests and reads from disk deterministically, but the request itself can still bias the review and waste limited retrieval budget.

This design tightens the pipeline so every file-range request is anchored to evidence ACA already verified.

## Status

Implemented on 2026-04-16:

- Phase 1 prompt hardening for witness context requests
- first testable slice of Phase 2 anchor validation
- next testable shared-context hardening slice: tree-first scout continuation
- next testable provenance slice for witness-mode anchored requests and snippets
- next testable observability slice: explicit window-selection metadata for accepted file requests and snippets
- next testable observability slice: first-class request rejection diagnostics in witness and shared-context artifacts
- next testable output-robustness slice: ACA-authored fallback witness reports when grounded retrieval succeeds but no-tools finalization stays malformed
- next testable output-robustness slice: last-chance Markdown-only finalization repair before ACA falls back to a degraded witness note
- next testable output-robustness slice: deterministic salvage of malformed structured finalization output into Markdown before the fallback path
- next testable output-robustness slice: conservative salvage of report-shaped object arrays and alternate finalization section keys into Markdown witness reports
- next testable observability slice: per-attempt witness finalization diagnostics covering final, retry, last-chance, and fallback stages
- next testable observability slice: per-attempt shared-context scout diagnostics covering initial and continuation passes
- next testable shared-context hardening slice: distinguish ACA-opened path-only file requests from explicit model-chosen ranges
- next testable shared-context hardening slice: collapse tree-grounded follow-up ranges into ACA-owned file opens unless the scout is continuing from a prior file snippet
- next testable observability slice: per-attempt witness context-request diagnostics covering initial, retry, continuation, continuation retry, and continuation invoke failures
- next testable observability slice: include witness context-attempt timelines in degraded fallback witness notes
- next testable observability slice: generate degraded shared-context notes with scout attempt timelines and feed them into triage
- next testable shared-context hardening slice: parse continuation requests with anchors so the scout uses path-only file opens or expand requests instead of raw continuation ranges
- next testable shared-context hardening slice: reject raw numeric file ranges in the initial scout pass so shared-context starts on the same path-only/tree contract as continuation
- next testable shared-context hardening slice: seed initial shared-context with pre-verified symbol anchors so the scout can use witness-style `type: "symbol"` from round 1
- next testable shared-context hardening slice: require initial path-only file opens to be grounded by an exact repo path already present in the task or ACA evidence, and record that source in provenance
- next testable observability slice: add first-class shared-context provenance summaries to result artifacts and degraded scout notes so accepted scout reads have a compact human-readable grounding narrative

What is live now:

- witness-mode prompts no longer encourage raw `line_start` / `line_end` guesses
- witness-mode parsing accepts `symbol`, `file`, `expand`, and `tree`
- blind raw file-range guesses are rejected when anchor validation is enabled
- `symbol` requests resolve against pre-verified symbol locations
- `file` requests require a path ACA already exposed, such as via a prior tree listing
- `expand` requests require an already exposed anchor line
- shared-context scout prompt and JSON schema now allow `type: "tree"`
- shared-context scout can take a second bounded round after tree discovery or ENOENT/error responses
- shared-context artifacts now record multi-round scout safety when a continuation round is used
- witness-mode anchored requests now emit provenance metadata in result artifacts
- fulfilled witness snippets preserve provenance metadata from the accepted request
- accepted file requests/snippets now distinguish ACA-chosen windows from model-specified ranges via `window_source` and `window_policy`
- shared-context file ranges now record direct `model_range` window selection and preserve that metadata when later grounded by tree/snippet evidence
- witness and shared-context artifacts now accumulate `context_request_diagnostics` when models emit rejected or partially rejected `needs_context` requests
- when a witness retrieves grounded context but still fails no-tools finalization, ACA now writes a degraded fallback report for triage instead of passing only raw malformed output downstream
- before ACA falls back to that degraded witness note, it now issues one stricter Markdown-only last-chance finalization repair prompt
- malformed structured finalization objects with explicit `findings` / `open_questions` content are now reformatted into valid Markdown witness reports instead of being treated as hard failures
- salvage now also accepts a narrow set of report-shaped object items such as `{title, detail}` and `{message}` under common finalization keys like `findings` and `questions`
- witness artifacts now record `finalization_diagnostics` so each final/report, retry, last-chance repair, and fallback generation attempt is visible without reconstructing the path from raw tmp files
- shared-context artifacts now record `scout_attempt_diagnostics` so initial vs continuation scout outcomes are visible without reconstructing them from raw tmp files
- shared-context path-only `type: "file"` requests now record ACA-owned `file_open_head_v1` windows instead of being misclassified as explicit model ranges
- shared-context continuation now collapses tree-grounded follow-up ranges into ACA-owned `file_open_head_v1` windows; explicit ranges remain only when grounded by a prior file snippet
- witness artifacts now record `context_attempt_diagnostics` so initial vs retry vs continuation retrieval failures are visible without reconstructing them from raw tmp files
- degraded fallback witness notes now include the witness context-attempt timeline, so triage can see retrieval-stage failure/retry history without opening the JSON artifact
- degraded shared-context notes now include the scout attempt timeline and can be included in triage as weak evidence instead of living only in result JSON
- shared-context continuation now uses anchored parsing, so follow-up scout requests must be `tree`, path-only `file`, or `expand`; raw continuation ranges are rejected instead of preserved
- shared-context initial parsing now rejects raw numeric file ranges, so the scout must start with path-only `file` opens or `tree` discovery instead of speculative line windows
- shared-context initial prompts now include pre-verified `symbol_locations`, and the initial scout can request `type: "symbol"` to get ACA-chosen symbol windows with symbol provenance from round 1
- shared-context initial path-only `file` opens are now accepted only when ACA can trace that exact repo path back to the task text or evidence pack, and accepted requests record `prompt_path:` or `evidence_pack_path:` provenance instead of generic `model_request`
- shared-context result artifacts now include `provenance_summary`, and degraded scout notes surface the same narrative so triage can see why each accepted scout read was legitimate without decoding raw provenance fields

What is not done yet:

- shared-context initial direct file opens are now prompt/evidence grounded, but they are still weaker than symbol/tree anchors because ACA is trusting path mentions from text rather than verified code structure
- the remaining practical issue from live runs is that salvage still covers only a conservative subset of structured-output shapes; more irregular nested payloads still depend on last-chance repair or fallback degradation
- future Phase 6 / C1 candidate: address witness under-response on open-ended management/review prompts where a model technically complies but returns an unhelpful "no bug found" style answer while peer witnesses provide substantive analysis. DeepSeek has shown this failure mode in live use and it should be treated as unacceptable witness quality, even when the protocol is technically satisfied. Reference consult record: `1776387146279-131713`.
- Phase 6 / C1 investigation update (2026-04-17): the root cause is broader than the literal `No bug found.` string. DeepSeek was following the generic review framing too literally, so advisory prompts now use advisory-specific framing and ACA rejects trivial `No bug found.` / `No issues found.` answers on advisory tasks. Live re-checks show a deeper residual issue remains: DeepSeek often treats advisory prompts as repo-inspection tasks, emits `type: "tree"` requests against `.` even after retry, and may also fail with `llm.malformed: Model returned an empty response` on similar prompts. That means the remaining C1 problem is now best described as "advisory-task mode collapse into repo-context fishing or empty-response failure," not just "short no-bug answer." Evidence: original consult `1776387146279-131713`, plus live canaries `/tmp/aca-live-consult-114.json` through `/tmp/aca-live-consult-117.json`.
- Phase 6 / C1 follow-up (2026-04-17): ACA now sends an advisory-specific retry prompt when it rejects repo-context fishing or a trivial advisory `No bug found.` answer. This improved live behavior but did not fully stabilize DeepSeek. New live evidence: `/tmp/aca-live-consult-118.json` recovered from initial repo-context fishing into a substantive advisory answer on retry; `/tmp/aca-live-consult-119b.json` and `/tmp/aca-live-consult-120b.json` still failed after the advisory retry with `llm.malformed: Model returned an empty response`; `/tmp/aca-live-consult-121c.json` answered substantively on the first pass without repo fishing. Current C1 verdict: retry guidance helps, but DeepSeek remains high-variance on advisory prompts and may still collapse into retry-time empty responses.
- Phase 6 / C1 substantial slices (2026-04-17): advisory witnesses now default to direct-answer mode instead of entering the repo-oriented context-request loop, and advisory failures now have a dedicated retry plus advisory last-chance recovery path. Live re-checks after this change are materially better: `/tmp/aca-live-consult-123.json`, `/tmp/aca-live-consult-124.json`, and `/tmp/aca-live-consult-125.json` all answered substantively on the first pass with zero context requests; `/tmp/aca-live-consult-122.json` still failed with `llm.malformed: Model returned an empty response` on the initial direct-answer pass. Current C1 verdict after the two substantial slices: the advisory-mode collapse is much smaller than before, but DeepSeek still has a residual empty-response failure mode even when repository context is fully removed from the protocol surface.
- Phase 6 / C1 empty-response recovery slice (2026-04-17): advisory witnesses now treat an initial `llm.empty` / empty-response invoke failure as retryable instead of terminal. ACA sends a much smaller Markdown-only recovery prompt first, then a final minimal recovery prompt if the retry also fails empty. Unit coverage now proves both the retry-recovery and repeated-empty last-chance paths. Live re-checks are still required to determine whether the residual DeepSeek empty-response issue is prompt-sensitive or mostly irreducible provider/model variance.
- Phase 6 / C1 advisory quality gate slice (2026-04-17): DeepSeek advisory witnesses now use a stricter substantive rubric instead of a mere validity check. ACA requires `Recommendation`, `Why`, `Tradeoffs`, and `Caveats` sections for DeepSeek advisory answers and rejects under-specified but syntactically valid filler so the retry path can demand a richer answer shape. Unit coverage now proves that shallow advisory paragraphs are rejected and recovered. Live re-checks on `/tmp/aca-live-consult-130.json` through `/tmp/aca-live-consult-133.json` all passed and all four saved reports adopted the stricter structure with materially more concrete tradeoffs/caveats than the earlier generic-paragraph outputs.
- remaining diagnostics gap: shared-context provenance is now easier to read, but prompt/evidence-grounded direct opens still do not distinguish stronger ACA-evidence anchors from weaker task-text path mentions in any machine-graded way beyond the `source_ref` string

## Current State

Relevant product path:

- `src/cli/consult.ts`
- `src/consult/context-request.ts`
- `src/consult/symbol-lookup.ts`
- `test/consult/context-request.test.ts`
- `test/cli/consult.test.ts`

Current behavior:

- ACA pre-seeds verified symbol definition locations when identifiers appear in the question.
- Witnesses may request `type: "file"` snippets with arbitrary numeric ranges.
- The prompt tells witnesses to use `type: "tree"` if exact lines are unclear.
- ACA validates numeric fields, clamps line counts, and fulfills accepted requests from disk.
- ENOENT and missing snippets are treated as missing evidence, not proof of absence.

Current weakness:

- A witness can still issue an unanchored range request.
- ACA currently validates shape and bounds, but not provenance.
- That means the request can be syntactically valid while still being epistemically weak.

## Target Invariants

After this hardening work, the consult path should obey these rules:

1. ACA never accepts an unanchored file-range request.
2. Every accepted file-range request must cite an anchor ACA already knows.
3. Valid anchors are limited to:
   - a pre-verified symbol location
   - a previously fulfilled file snippet
   - a previously fulfilled directory tree listing
   - an explicit file/range already present in an ACA-built evidence pack
4. If no anchor exists, the only legal discovery action is a narrow `type: "tree"` request.
5. ACA, not the witness, determines the final line window around an anchor.
6. Final witness findings must remain tied to ACA-read snippets, not inferred unseen code.
7. Failed or invalid requests must degrade safely without turning missing evidence into false absence claims.

## Design Direction

### 1. Replace free-form line requests with anchored requests

Change the context-request contract so witnesses request evidence by anchor, not by speculative raw range.

Proposed request shapes:

```json
{
  "needs_context": [
    {
      "type": "symbol",
      "symbol": "buildContextRequestPrompt",
      "reason": "Need surrounding implementation to verify witness prompt constraints"
    }
  ]
}
```

```json
{
  "needs_context": [
    {
      "type": "expand",
      "path": "src/consult/context-request.ts",
      "anchor_line": 165,
      "reason": "Need nearby lines around previously cited prompt rule"
    }
  ]
}
```

```json
{
  "needs_context": [
    {
      "type": "tree",
      "path": "src/consult",
      "reason": "Need to discover the correct consult module before asking for a file"
    }
  ]
}
```

Interpretation:

- `symbol`: witness asks ACA to resolve a known symbol and return a server-chosen window around its verified line.
- `expand`: witness asks ACA to expand around a line ACA has already shown or verified.
- `tree`: witness asks ACA for a narrow directory listing to discover a valid next path.

The witness no longer chooses arbitrary `line_start` / `line_end` for normal file requests.

### 2. Track provenance explicitly

ACA should store anchor provenance for every fulfilled snippet.

Add metadata to the internal snippet/request model such as:

- `anchor_type`: `symbol | snippet | tree | evidence_pack`
- `anchor_source`: identifier, prior snippet id, or tree request id
- `anchor_line`
- `window_before`
- `window_after`

This serves two purposes:

- validation: future requests can only expand from known anchors
- explainability: ACA can show why a snippet was considered legitimate

This metadata does not have to be exposed in the user-facing report immediately, but it should exist in the witness result JSON for debugging and audits.

### 3. Move line-window control from the witness to ACA

ACA should own the final line range around anchors.

Recommended policy:

- `symbol` request:
  - return `symbol.line - 40` through `symbol.line + 120`
  - clamp to file bounds and byte budget
- `expand` request:
  - require `anchor_line` to match a line ACA already exposed
  - expand by a fixed policy such as `-60/+140`
  - reject jumps that are not adjacent to previously seen material
- `tree` request:
  - unchanged in spirit, but remains the only discovery path when no file anchor exists

This removes witness freedom to say “give me 250-300” unless ACA itself can justify why 250 is a known anchor.

### 4. Make prompt instructions strict and explicit

The current prompt warns against uncertain numeric ranges. That should become a hard protocol rule.

New witness instructions should say, in substance:

- never request a raw file line range unless ACA already exposed that anchor
- if you do not have an anchored file path, request `type: "tree"`
- if you know a symbol name from the question or evidence, request `type: "symbol"`
- do not invent paths from project conventions
- do not invent line numbers from intuition
- a request without a valid anchor will be rejected and wastes your round

The retry prompts and finalization prompts should repeat the same rule so malformed first passes do not regress into blind ranges.

### 5. Add a validator that rejects epistemically weak requests

`parseContextRequests` should stop being only a shape parser. It should either:

- return raw parsed requests and let a new `validateContextRequestsAgainstAnchors(...)` step reject them, or
- become a two-stage parser/validator with access to an `AnchorCatalog`

The validator should reject:

- file-range requests with no anchor
- `expand` requests whose `anchor_line` was never exposed
- requests for paths not present in symbol locations, prior snippets, prior trees, or the evidence pack
- large cross-file jumps that bypass `tree`
- placeholder values and malformed numeric fields

Rejected requests should be recorded as invalid-request diagnostics in witness artifacts.

### 6. Keep a safe fallback path

The stricter protocol should not turn minor witness formatting drift into a dead consult.

Fallback behavior:

- if a request is invalid but repairable, ACA sends one retry prompt explaining why
- if a request is invalid and unrecoverable, ACA forces finalization with explicit “open question” guidance
- ACA should never silently reinterpret a speculative raw range as an anchored request

That preserves the current “bounded degradation” behavior while removing silent acceptance of weak retrieval logic.

## Implementation Plan

### Phase 1: Contract and prompt hardening

Scope:

- update `ContextRequest` types in `src/consult/context-request.ts`
- revise first-pass, continuation, retry, and finalization prompts
- keep `tree` support
- add explicit anchor terminology to prompt text

Success criteria:

- no prompt examples encourage raw speculative `line_start` / `line_end`
- witnesses are told exactly which request types are legal

### Phase 2: Anchor catalog and validator

Scope:

- introduce an internal `AnchorCatalog`
- seed it from:
  - symbol lookup results
  - fulfilled snippets
  - fulfilled tree listings
  - evidence-pack file references when present
- validate all incoming requests against that catalog before fulfillment

Success criteria:

- ACA rejects unanchored file reads before touching disk
- witness artifacts preserve rejection reasons

### Phase 3: ACA-owned window selection

Scope:

- implement fixed expansion policies for symbol and snippet anchors
- optionally support small named window presets such as `focus`, `local`, `wide`
- remove witness control of arbitrary line ends in normal requests

Success criteria:

- accepted requests always produce ACA-selected ranges
- no accepted request can originate from a blind line guess

### Phase 4: Observability and auditability

Scope:

- record anchor provenance in witness result JSON
- surface invalid-request counts and reasons in degraded witness metadata
- preserve enough trace data to explain why ACA accepted or rejected a request

Success criteria:

- post-mortem review can reconstruct the retrieval chain for each snippet

### Phase 5: Tests and live re-proof

Scope:

- expand unit coverage in `test/consult/context-request.test.ts`
- expand consult orchestration coverage in `test/cli/consult.test.ts`
- add regression tests for known bad patterns from `docs/archive/audits/c11/failure-catalog.md`
- run at least one live consult smoke pass after implementation

Success criteria:

- blind range requests fail
- anchored symbol requests succeed
- tree -> file expansion flow succeeds
- malformed requests degrade safely
- final answers still complete under the tighter protocol

## Test Matrix

Required new tests:

1. Reject raw `type: "file"` request with invented `line_start` / `line_end` and no anchor.
2. Accept `type: "symbol"` when the symbol exists in the pre-verified symbol block.
3. Reject `type: "expand"` when `anchor_line` was never exposed.
4. Accept `tree` -> `expand` progression when the file path came from the tree.
5. Reject file path guesses not present in symbol locations, prior snippets, prior trees, or evidence pack references.
6. Preserve current safety rule that ENOENT is not evidence of absence.
7. Preserve bounded retry behavior for malformed no-tools witness outputs.
8. Preserve forced finalization with open questions when the witness cannot obtain a valid anchor.

## Risks And Tradeoffs

### Risk: Lower recall

If the anchor rules are too strict, witnesses may miss legitimate evidence that was not pre-seeded.

Mitigation:

- keep `tree` as the escape hatch
- allow one extra context round if strict validation rejects an otherwise plausible request
- consider optional shared-context scout seeding for larger consults

### Risk: More rounds and latency

Tree-first discovery is slower than blind direct file requests.

Mitigation:

- keep the tree listing depth useful enough to expose likely next files
- let symbol requests bypass tree discovery when identifiers are already known

### Risk: Overfitting to current repo layout

Rules based on current `src/...` patterns would be fragile.

Mitigation:

- anchor acceptance must depend on ACA-provided evidence, not directory conventions

## Recommended Order

1. Land prompt and type-contract changes behind the current consult path.
2. Add the anchor catalog and request validator.
3. Switch fulfillment to ACA-owned windows.
4. Add provenance fields to artifacts.
5. Run targeted tests, then a live consult smoke test.

## Definition Of Done

This work is done when:

- ACA rejects blind line-range requests by construction
- every fulfilled file snippet can be traced to a prior ACA-known anchor
- witnesses still complete consults without excessive degradation
- the consult artifacts make the retrieval chain inspectable after the fact
- tests cover both strict acceptance and safe rejection paths
