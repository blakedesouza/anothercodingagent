# Session Handoff Prompt — Symbol Lookup in Consult Pipeline

_Copy everything below this line and paste it as your first message in the new session._

---

Read `plan.md` and `docs/handoff-symbol-lookup.md` before doing anything else.

## What we proved last session

The ACA consult pipeline has a navigation bug: when a question contains a literal function
name (e.g. `countHardRejectedToolCalls`), witnesses like kimi and gemma guess plausible-
sounding files instead of finding the actual definition. We ran the same question two ways:

- **Semantic phrasing** ("hard-rejected tool calls"): kimi finds the right file but
  sometimes reports the wrong error code; gemma finds the right file consistently.
- **Literal function name** (`countHardRejectedToolCalls`): kimi goes to `aggregator.ts`,
  `stats.ts`, `turn-engine.ts` — never finds it. Gemma goes to `stats.ts`,
  `sqlite-store.ts` — never finds it. Deepseek finds it immediately in both cases.

This is a **model-level navigation failure**, not a question-phrasing problem.
Model hints don't fix it. The only lever is giving witnesses the file:line upfront.

## The fix

Add a **symbol lookup** step to the consult pipeline. Before witnesses navigate,
the system greps `src/` for any code identifiers in the question and injects their
definition locations into the initial context-request prompt as a `<symbol_locations>`
block. Witnesses then start with the answer to "where does X live" pre-answered.

## What to implement

Three things, all described in `docs/handoff-symbol-lookup.md`:

1. **New file** `src/consult/symbol-lookup.ts` — `extractCodeIdentifiers` +
   `resolveSymbolLocations` functions
2. **Modify** `src/consult/context-request.ts` — add optional `symbolLocations?`
   param to `buildContextRequestPrompt`, inject `<symbol_locations>` block when present
3. **Modify** `src/cli/consult.ts` — call symbol lookup in `runWitness()` before
   building the first prompt

## Pre-written tests

`docs/handoff-symbol-lookup.md` contains the full test code ready to drop into
`test/consult/symbol-lookup.test.ts`, plus 3 live consultation bash commands.
**Drop the unit tests in first** (they'll fail as expected), then implement until
they pass, then run the 3 live tests.

## Source locations verified (do not re-verify, trust these)

- `countHardRejectedToolCalls` → `src/cli/invoke-output-validation.ts:77`
- `buildContextRequestPrompt` → `src/consult/context-request.ts:143`
- `prepareInvokeTurnConfig` → `src/cli/invoke-runtime-state.ts:34`
- `registerInvokeRuntimeTools` → `src/cli/invoke-tooling.ts:110`

## Test baseline going in

2632 passing, 14 pre-existing failures, 1 skipped. Build is clean.
