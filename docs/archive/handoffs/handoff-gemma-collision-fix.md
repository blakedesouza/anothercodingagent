# Handoff — Gemma Parallel Tool-Call Collision Fix (RESOLVED 2026-04-06)

**Date:** 2026-04-06
**Status:** **COMPLETE.** Fix landed, tests added, empirical verification passed (17/17). M10.3 unblocked. Safe to delete this file once a milestone closes the loop.

## Summary

The "intermittent gemma empty tool args → llm.confused → tool_error" issue tracked in `docs/handoff-consult-aca-mode.md` has been fully diagnosed and fixed. It was an OpenAI streaming spec violation by NanoGPT's gemma short-id backend that ACA's accumulator did not anticipate.

## Root cause

`src/core/turn-engine.ts:normalizeStreamEvents` keyed `toolCallAccum` on `event.index`. NanoGPT's `chatcmpl-<3-digit>` gemma backend emits **all parallel tool calls at `index:0`** (each with a distinct `id`), instead of using sequential indices per the OpenAI spec. ACA merged all calls into one entry — last `name` won, all `arguments` strings were concatenated → `JSON.parse` threw → tool result became `tool.validation: Malformed JSON in tool call arguments` → 3 strikes → `llm.confused` → `tool_error`.

The drivers also dropped the provider-supplied `tc.id` entirely, so the accumulator had no signal to detect the collision.

## Smoking gun

- `/tmp/aca-gemma-fail-sse-2.txt` (captured during diagnostic repro): four deltas from one stream all at `"index":0`, ids `call_bao4exy4`, `call_bffx74vu`, `call_chezyjpy`, `call_3o0n7un8`, names `read_file`/`read_file`/`read_file`/`exec_command`, full JSON args each.
- `/tmp/aca-gemma-fail-body-2.json` body 2 msg 2: ACA's reconstructed assistant message had **one** `tool_call`, `name=exec_command` (last-write-wins), `arguments="{}"` (parse-failure fallback). Confirms the accumulator merge.

## Fix surface

Six files changed:

| File | Change |
|---|---|
| `src/types/provider.ts` | Added `id?: string` to `ToolCallDeltaEvent` with explanatory JSDoc |
| `src/providers/nanogpt-driver.ts` | Extract and yield `tc.id`; **also removed temp `ACA_DUMP_BODY` + `ACA_DUMP_SSE` debug blocks** |
| `src/providers/openai-driver.ts` | Same: extract and yield `tc.id` |
| `src/providers/anthropic-driver.ts` | Extract `block.id` from `content_block_start` for `tool_use` blocks |
| `src/providers/tool-emulation.ts` | Synthesize `emulated_${i}` ids for type uniformity |
| `src/core/turn-engine.ts` | `normalizeStreamEvents` rewritten: insertion-ordered `toolCallSlots` array + `currentSlotByIndex: Map<number,number>`. Collision detection: when an incoming delta has an `id` that differs from the existing slot's id at the same index, allocate a new slot. Standard OpenAI streaming preserved (later chunks with no `id` accumulate into the existing slot) |

## Validation

- `npx tsc --noEmit` — clean
- `npm run build` — clean (459.72 KB ESM bundle)
- `npx vitest run` — **2325 passed | 1 skipped** (was 2320 + 5 new regression tests in `test/core/turn-engine.test.ts > tool_call_delta accumulation`):
  1. Standard OpenAI streaming (id on first chunk only, args chunked across later deltas) → 1 reconstructed call
  2. Standard parallel (distinct indices, each with own id) → 3 reconstructed calls
  3. Legacy parallel (distinct indices, no ids anywhere) → 2 reconstructed calls (backward compat)
  4. **Gemma collision (4 deltas all index 0, distinct ids, complete args)** → 4 reconstructed calls, no `tool.validation` errors
  5. Gemma collision with mixed names → each call keeps its own name (no last-write-wins)
- **Empirical re-run via `/tmp/aca-gemma-repro2.sh`**: 17/17 successful iters of the exact witness-verification task that originally failed. Zero `tool.validation` errors anywhere in any captured session log. Pre-fix this task collapsed within 1-2 iters.

## Hypotheses tested and rejected during diagnosis

1. *"gemma sends arguments as a JSON object (not a string)"* — empirically scanned all 30+ captured streams; every `arguments` field was a proper string. Rejected.
2. *"NanoGPT subscription endpoint fails differently from paid"* — already addressed in the prior endpoint switch. Rejected.
3. *"Too many tools confuses gemma"* — earlier 1/3/5/8/11 tool curl runs already rejected this. Failing case has 16 tools.
4. *"Race in SSE multi-line parsing"* — checked `src/providers/sse-parser.ts:66-82`. The parser correctly handles multi-line `data:` joining. Not the issue.

## Risk register

- *Theoretical edge case*: a provider that interleaves a parallel tool call (delta with new id at index N) with a chunked continuation of an earlier tool call (delta with no id, also at index N). My fix routes the no-id continuation into the most-recent slot for that index, which would silently truncate the earlier call. No observed provider does this. Documented but not engineered for.
- *Anthropic driver fix is preventive*: Anthropic's protocol uses `content_block_start` with distinct indices per parallel tool call, so the collision case can't occur today. The id wiring is for consistency / future-proofing.

## Files changed (uncommitted, part of broader pre-commit-mode state)

```
~ src/types/provider.ts                       (+ id field)
~ src/providers/nanogpt-driver.ts             (+ id wiring, - ACA_DUMP_BODY/SSE temp debug)
~ src/providers/openai-driver.ts              (+ id wiring)
~ src/providers/anthropic-driver.ts           (+ id wiring)
~ src/providers/tool-emulation.ts             (+ synthetic id)
~ src/core/turn-engine.ts                     (accumulator collision detection)
~ test/core/turn-engine.test.ts               (+ 5 regression tests)
+ docs/handoff-gemma-collision-fix.md         (this file)
~ docs/handoff-consult-aca-mode.md            (pointer to this file)
~ docs/changelog.md                           (full entry: "Gemma Parallel Tool-Call Index Collision Fix")
~ plan.md                                     (entry marked COMPLETE)
```

## Verified state at handoff

- `npm run build` clean (459.72 KB)
- `npx vitest run` 2325 passed | 1 skipped
- Gemma reaches the model in ~16s and correctly handles parallel tool calls.
- M10.3 unblocked.

## Suggested next session

Either kick off M10.3 (Self-Building: ACA builds ACA via `/build` with delegation, using witnesses-with-tools to review delegated code) or first do a M10 review pass that confirms gemma's now in the witness panel.
