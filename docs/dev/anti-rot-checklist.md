# Anti-Rot Checklist

Use this before calling a milestone, handoff, or fix "done".

This exists to prevent the exact failure mode we just hit:
- a local change looks correct
- downstream consumers drift
- persistence/replay metadata is wrong
- tests only validate the local slice

## Core Rule

If you change a symbol, contract, schema, counter, prompt, default, or tool shape, you must search for what it affects and update those places too.

Do not stop at the first passing test.

## 1. Classify The Change

Before editing, state which of these buckets the change touches:

- Local logic only
- Shared helper used by multiple modules
- Tool input or output shape
- Prompt or protocol wording
- On-disk schema or persisted metadata
- Replay/resume/rebuild logic
- Derived state, digest, summary, or cache
- Default model/config selection
- Retry/error/guardrail behavior
- Counter, sequence, or turn numbering

If the answer is anything except `Local logic only`, assume there is blast radius.

## 2. Mandatory Blast-Radius Search

For every changed symbol or contract, search these surfaces:

- Producers
  Example: where values are created, written, emitted, or serialized
- Consumers
  Example: where values are parsed, read, displayed, or enforced
- Persistence
  Example: manifest, JSONL, checkpoints, cache, session state
- Replay / resume
  Example: rebuild-from-log, restore, replay, recovery paths
- Derived views
  Example: digests, summaries, indexes, working sets, stats, reports
- Prompts and examples
  Example: system prompts, few-shots, repair prompts, docs
- Tests and fixtures
  Example: unit tests, integration tests, mock payloads, snapshots

Minimum search pattern:

```bash
rg -n "SymbolName|field_name|error.code|tool_name|old_shape|new_shape" src test docs
```

If a field crosses layers, also search for semantic aliases, not just exact names.

## 3. Required Questions

Answer these before you stop:

1. What writes this value?
2. What reads this value?
3. Is it persisted anywhere?
4. Is it reconstructed later from disk or logs?
5. Is there any derived representation of it?
6. Are tests asserting the old shape or old assumption?
7. Are prompts or docs teaching the old behavior?

If any answer is "I don't know", the work is not done.

## 4. Invariant Checks

These are the invariants that commonly rot in LLM-built systems:

- Counters actually increment across iterations.
- IDs and sequence numbers remain unique across turns.
- Persisted metadata round-trips correctly through save/load/resume.
- Resume/replay rebuilds the same state a live run would produce.
- The same file/resource has one canonical identity.
- Compressed or summarized context still matches raw source behavior.
- Prompt examples match real tool schemas and current runtime behavior.
- Defaults, fallbacks, and repair flows use the same contract as the main flow.
- Tests cover second-turn / second-run behavior, not only first-run behavior.

If the change touches one of these, add or update a test for it.

## 5. Red-Flag Patterns

Treat these as debt markers, not harmless comments:

- `for now`
- `placeholder`
- `v1`
- `caller should provide`
- `TODO(...)`
- `deferred`
- `hardcoded`

If one appears in a core runtime path, do one of these:

- remove it now
- add a test that exposes the limitation
- record it as an explicit blocker in the handoff

Do not silently build another milestone on top of it.

## 6. Definition Of Done

A change is not done until all relevant surfaces are aligned:

- runtime logic
- persistence
- replay/resume
- derived state/digests/summaries
- prompts/examples
- tests/fixtures
- operator-facing docs if behavior changed

Local correctness is not sufficient.

## 7. Required Output Format For The Implementer

Before editing:

- Change class:
- Primary symbols/contracts affected:
- Likely blast radius:
- Strongest risk:

After editing:

- Files changed:
- Producers updated:
- Consumers updated:
- Persistence/replay updated:
- Derived views updated:
- Tests added or updated:
- Residual risk:

If any line is empty, the review is incomplete.

## 8. Copy-Paste Prompt Template

Use this with an LLM before milestone or handoff work:

```text
Before making changes, do a blast-radius audit.

1. Classify the requested change:
- local logic
- shared helper
- tool/schema contract
- persisted metadata
- replay/resume
- derived state/digest/summary
- prompt/protocol
- retry/guardrail/default behavior

2. List the exact symbols, fields, error codes, tool names, prompts, and files likely affected.

3. Search for all producers, consumers, persistence paths, replay/resume paths, derived views, prompts/examples, and tests that reference those things.

4. Do not stop at the local fix. If the change affects any shared contract, update the related readers, writers, rebuild paths, summaries/digests, and tests too.

5. Add at least one test that covers the second-turn / second-run / resumed-state case when the change touches counters, metadata, persistence, or replay.

6. Call out any placeholder, "for now", "v1", "deferred", or hardcoded assumption you find in the affected runtime path. Either remove it or explicitly mark it as unresolved risk.

Return this before editing:
- Change class
- Affected surfaces
- Planned file edits
- Tests to update
- Highest-risk invariant
```

## 9. Short Version

If you want the compressed rule:

1. Fix the thing.
2. Search who writes it.
3. Search who reads it.
4. Search where it is persisted.
5. Search how it is replayed.
6. Search how it is summarized or derived.
7. Update the tests that prove all of that still matches.
