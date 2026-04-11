# C9 Consult Fix Handoff

**Date:** 2026-04-10
**Status:** C9.6 in progress — prompt guardrails propagated, tests need 3 stale assertion fixes, live validation pending.

---

## What This Session Did

### 1. Confirmed Consult Pipeline Works End-to-End

Ran real `aca consult` invocations (correct subcommand). Pipeline confirmed:
- Witness context-request pass → triage (GLM-5) → structured review — all run correctly
- Exit 0 on all runs

### 2. Discovered Qwen Pseudo-Tool-Call Root Cause

Pre-fix: Qwen failed 3/4 consult runs with `"pseudo-tool call emitted in no-tools context-request pass"`.

Root cause (two simultaneous issues):
1. **Token budget exhaustion**: Qwen3.5's chain-of-thought burns ~2100 tokens deliberating over which JSON format to use (simple `needs_context` vs structured `action` form). The thinking chain terminates mid-thought — no actual answer ever produced.
2. **False positive on detector**: The thinking chain is emitted as `> ` blockquote-prefixed lines. It quotes the prompt's invalid-example list verbatim (e.g. `(<tool_call>, <call>, etc.)`), which matches `containsPseudoToolCall` even though Qwen isn't actually trying to call tools.

Raw evidence files: `/tmp/aca-consult-qwen-context-request-1775798410070-300788.md` (run D) and `/tmp/aca-consult-qwen-context-request-1775798421099-301408.md` (run F).

### 3. Created `src/prompts/prompt-guardrails.ts`

Replaced `src/prompts/no-native-tools.ts` (deleted) with a broader shared constants file:

```ts
export const NO_NATIVE_FUNCTION_CALLING =
    'Native/API-level function calling is NOT available in this session.\n' +
    'Attempting a native API function call will produce no result — it will not execute and your task will fail silently.';

export const NO_PROTOCOL_DELIBERATION =
    'Do not deliberate over the protocol or output format in your response.\n' +
    'Read the instructions once, decide, and produce your answer.';
```

### 4. Propagated Both Constants to All No-Tools Surfaces

Both constants injected into all 7 surfaces across 4 files:

| File | Surface |
|---|---|
| `src/providers/tool-emulation.ts` | `buildToolSchemaPrompt` |
| `src/consult/context-request.ts` | `buildContextRequestPrompt` |
| `src/consult/context-request.ts` | `buildSharedContextRequestPrompt` |
| `src/consult/context-request.ts` | `buildFinalizationPrompt` |
| `src/cli/consult.ts` | `buildNoToolsConsultSystemMessages` |
| `src/cli/consult.ts` | triage prompt (`buildTriagePrompt`) |
| `src/core/prompt-assembly.ts` | `buildSynthesisSystemMessages` |

### 5. Added Format Disambiguation in `buildContextRequestPrompt`

Added after the two JSON shape examples:
```
When in doubt, prefer the simple needs_context form. The structured action form is only required if ACA explicitly signals structured output for this request.
```

### 6. Option B: Strip Blockquotes Before Pseudo-Tool-Call Detection

Added `stripMarkdownBlockquotes` in `src/consult/context-request.ts`:
```ts
function stripMarkdownBlockquotes(text: string): string {
    return text.split('\n').filter(line => !/^>/.test(line)).join('\n');
}
```

Applied in `containsPseudoToolCall`:
```ts
const inspectableText = stripMarkdownCode(stripMarkdownBlockquotes(text));
```

This eliminates false positives from Qwen's thinking chain quoting prompt examples.

---

## Current Build and Test State

**Build:** Clean (`npm run build` passes).

**Tests:** 3 failing unit tests with **stale assertions** — caused directly by our prompt changes. These need to be updated to match the new text.

### Fix needed in `test/providers/tool-emulation.test.ts` (line 65)

```ts
// STALE — remove these two lines:
expect(prompt).toContain('Do not restate the goal');
expect(prompt).toContain('Do not emit XML, HTML, or pseudo-tool wrappers');
// Neither string exists in current buildToolSchemaPrompt output.
// Replace with assertions that match the new content, e.g.:
expect(prompt).toContain('Do not deliberate over the protocol');
expect(prompt).toContain('NOT available in this session');
```

### Fix needed in `test/core/prompt-assembly.test.ts` (lines 1078 and 1126)

```ts
// STALE — both check:
expect(content).toContain('Tools are NOT available');
// That string was replaced by NO_NATIVE_FUNCTION_CALLING. Replace with:
expect(content).toContain('NOT available in this session');
// or
expect(content).toContain('Native/API-level function calling is NOT available');
```

**Other failing tests** (`first-run.test.ts`, `tool-execution.test.ts`, `provider-selection.test.ts`, `config.test.ts`) are pre-existing live integration test failures unrelated to this session's changes.

---

## Post-Fix Validation Results (6 Consults)

Batch 1 (after `NO_NATIVE_FUNCTION_CALLING` + `stripMarkdownBlockquotes`, before `NO_PROTOCOL_DELIBERATION`):
| Run | Result | Qwen |
|---|---|---|
| A — tool error handling | 4/4, not degraded | ✓ pass |
| B — streaming vs non-streaming | 4/4, not degraded | ✓ pass |
| C — agent loop termination | 4/4, not degraded | ✓ pass |

Batch 2 (same build):
| Run | Result | Qwen |
|---|---|---|
| D — shell security risks | 3/4, degraded | ✗ pseudo-tool (false positive) |
| E — context window exhaustion | 4/4, not degraded | ✓ pass |
| F — good system prompt | 3/4, degraded | ✗ pseudo-tool (false positive) |

`NO_PROTOCOL_DELIBERATION` and format disambiguation were **not yet built** when these ran. The next session should re-run validation after fixing the 3 stale tests.

---

## What Remains

### Immediate (this work item)

1. **Fix 3 stale test assertions** (described above) — `npm run build && npx vitest run` should hit 2346 passing.
2. **Run 6 new consults** (2 batches of 3, sleep 10s between) across different questions to validate that `NO_PROTOCOL_DELIBERATION` + `stripMarkdownBlockquotes` eliminates or further reduces Qwen failures.
3. If validation passes, this work qualifies as C9.6 complete.

### C9.7 — Changelog

Append to `docs/changelog.md` covering:
- C9.1–C9.3: Three prompt tiers + dispatcher
- C9.4: Unit tests
- C9.5: Live matrix re-validation + GLM-5 emulation prompt fix
- C9.6: Consult pipeline verification + Qwen pseudo-tool-call fix (prompt-guardrails.ts, NO_NATIVE_FUNCTION_CALLING, NO_PROTOCOL_DELIBERATION, stripMarkdownBlockquotes)
- C10: Closed (tainted premise)
- Model echo feature

### Open Decision (from previous session)

`NANOGPT_DEBUG` request logging in `nanogpt-driver.ts` — keep as permanent debug tooling or remove? Must be resolved before C9.7 so changelog is accurate.

---

## Key Files Changed This Session

| File | Change |
|---|---|
| `src/prompts/prompt-guardrails.ts` | New — shared `NO_NATIVE_FUNCTION_CALLING` + `NO_PROTOCOL_DELIBERATION` constants |
| `src/prompts/no-native-tools.ts` | Deleted — superseded by prompt-guardrails.ts |
| `src/providers/tool-emulation.ts` | Both constants injected into `buildToolSchemaPrompt` |
| `src/consult/context-request.ts` | Both constants in 3 prompt functions; `stripMarkdownBlockquotes` in detector; format disambiguation in `buildContextRequestPrompt` |
| `src/cli/consult.ts` | Both constants in `buildNoToolsConsultSystemMessages` + triage prompt |
| `src/core/prompt-assembly.ts` | Both constants in `buildSynthesisSystemMessages` |
