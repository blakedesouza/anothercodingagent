# C9 Close Handoff

**Date:** 2026-04-09
**Status:** C9 is 4/6 substeps complete. C9.6 (consult verify) and C9.7 (changelog) remain. C10 is CLOSED — original premise was wrong.

---

## What This Session Did

### 1. Model Echo Feature (new)

Every ACA invoke path now prints `[aca] model: <model-id>` to stderr as the very first line, before any work begins.

| Path | Where added | File |
|---|---|---|
| One-shot | `outputChannel.stderr(...)` right after renderer init | `src/cli-main.ts:1109` |
| Executor (`aca invoke`) | `process.stderr.write(...)` after model validation | `src/cli-main.ts:1740` |
| Interactive/REPL | Already had `renderer.startup()` — no change needed | — |

Verified live on deepseek, qwen3.5-397b, minimax. `[aca] model:` is always the first line of output.

---

### 2. C9 Live Matrix Re-Validation

C9's prior live matrix was tainted (all runs hit Qwen3-Coder-Next via hardcoded default — fixed last session). Re-ran two tests × three models:

- **File task**: `"Read src/core/prompt-assembly.ts and tell me what buildAnalyticalSystemMessages does"` → must call `read_file`
- **Conceptual task**: `"Explain what a binary search tree is..."` → must use 0 tools

Results:

| Model | File task | Conceptual | Result |
|---|---|---|---|
| `minimax/minimax-m2.7` | ✓ | ✓ | PASS |
| `qwen/qwen3.5-397b-a17b` | ✓ | ✓ | PASS |
| `zai-org/glm-5:thinking` | ✗ initially → ✓ after fix | ✓ | PASS after fix |

---

### 3. GLM-5 Investigation and Fix

**Root cause (not flakiness):** NanoGPT routes `zai-org/glm-5:thinking` to multiple backends. On the **short-thinking path** (9 reasoning chunks: "Let me read the file first."), GLM-5 attempts a native tool call. `tool_choice: none` blocks it at the API level, producing empty `delta.content` and `finish_reason: stop`. Result: emulation buffer empty, no tool executes.

The **long-thinking path** (80–100 reasoning chunks) works fine — the model reasons through the emulation instructions and outputs the JSON in `delta.content`.

Sampling confirmed: original prompt → 3/15 pass rate (20%). The short-thinking path was the dominant path.

**Fix:** Strengthened `buildToolSchemaPrompt` in `src/providers/tool-emulation.ts`:

```
## TOOL USE — MANDATORY

Native/API-level function calling is NOT available in this session.
The ONLY way to invoke a tool is by writing the JSON object below directly
into your response text. Attempting a native API function call will produce
no result — the tool will not execute and your task will fail silently.
```

Key additions:
- Explicit header `## TOOL USE — MANDATORY`
- "Native/API-level function calling is NOT available" — directly names what GLM-5 was attempting
- "your task will fail silently" — consequence of the wrong path
- This is global (all emulation-mode models), not GLM-5-specific

Result: 3/15 → **15/15** pass rate on file task. 5/5 pass on conceptual (no regression).

This fix applies to all models using emulation mode. MiniMax, Qwen, DeepSeek were already passing and continue to pass.

---

### 4. C9.4 Unit Tests — COMPLETE

Added 21 new tests across 3 new describe blocks + 3 regression tests in existing block. All 72/72 pass.

**`buildAnalyticalSystemMessages` (8 tests):**
- Single system message returned
- ACA identity present
- `<tool_policy>` block with correct tool-vs-conceptual guidance
- `<environment>` with working directory
- `<tool_reference>` present/absent based on toolNames
- **C9 regression:** `<mode>` and `<persistence>` absent (even with profile)
- Profile injection when profilePrompt provided

**`buildSynthesisSystemMessages` (6 tests):**
- Single system message returned
- "Tools are NOT available" text
- Tool markup explicitly forbidden in prompt
- No `<tool_reference>`
- No `<mode>` or `<persistence>`
- Profile injection when provided

**`buildSystemMessagesForTier` (4 tests):**
- `'analytical'` → routes to `buildAnalyticalSystemMessages` (has `<tool_policy>`, no `<mode>`)
- `'synthesis'` → routes to `buildSynthesisSystemMessages` (has "Tools are NOT available")
- `'agentic'` → routes to `buildInvokeSystemMessages` (has `<mode>`, `<persistence>`)
- `undefined` → routes to `buildInvokeSystemMessages`

**`buildInvokeSystemMessages` regressions (3 new tests):**
- `<mode>` has final-summary escape hatch (`The ONLY valid text-only response is your final summary`)
- `<persistence>` has softened qualifier (`This applies while work remains`)
- `<tool_preambles>` gates on task requirement (`When the task requires tools`)
- Also fixed stale pre-C9 assertion: `'ENDS THE CONVERSATION'` → `'ends the conversation'` (lowercased in C9)

---

### 5. C10 — CLOSED

C10 was created to fix a "MiniMax M2.7 tool emulation bug" observed in the tainted C9 matrix. That observation was actually on Qwen3-Coder-Next. MiniMax passes cleanly (file + conceptual, multiple runs). C10 has no valid premise. No work needed.

---

## What Remains on C9

### C9.6 — Consult Pipeline Verify

Run a real `aca consult` invocation and confirm the pipeline is intact end-to-end. The consult pipeline was last verified in `a42ae88`/`200af40`/`c36b731` (C1 wiring, 2026-04-09). Since then: no changes to `src/cli/consult.ts`. Low risk but should be confirmed before closing C9.

**How to run:**
```bash
cd /home/blake/projects/anothercodingagent
node dist/index.js --model deepseek/deepseek-v3.2 --no-confirm "consult: Is the buildAnalyticalSystemMessages function missing any important tool policy guidance?"
```
Or use the consult command directly if wired. Check that 4 witnesses fire and structured review is produced.

### C9.7 — Changelog

Append an entry to `docs/changelog.md` covering:
- C9.1–C9.3: Three prompt tiers + dispatcher
- C9.4: Unit tests (this session)
- C9.5: Live matrix re-validation + GLM-5 emulation prompt fix
- C10: Closed (tainted premise)
- Model echo feature

---

## Cleanup Needed After C9 Closes

`NANOGPT_DEBUG` debug logging is still in production code in two places:

1. **`src/providers/nanogpt-driver.ts`** — SSE event logging + request body summary (added this session for GLM-5 diagnosis)
2. **`src/providers/tool-emulation.ts`** — emulation buffer parse success/failure logging (existed before this session)

These are gated on `process.env.NANOGPT_DEBUG === '1'` so they don't affect production unless the env var is set. Decide: formalize as permanent debug tooling (document in README) or remove before closing C9.

---

## Key Files Changed This Session

| File | Change |
|---|---|
| `src/cli-main.ts` | Model echo in one-shot path (`:1109`) and executor path (`:1740`) |
| `src/providers/tool-emulation.ts` | Strengthened `buildToolSchemaPrompt` — explicit native-disabled instruction |
| `src/providers/nanogpt-driver.ts` | Request body debug logging under `NANOGPT_DEBUG` |
| `test/core/prompt-assembly.test.ts` | 21 new tests + 3 regressions + stale assertion fix |

---

## Test State

```
2325 passed | 1 skipped  (pre-session baseline)
+21 new tests this session
= 2346 expected passing | 1 skipped
```

Run to confirm: `npm run build && npx vitest run`

---

## Decision Needed

The `NANOGPT_DEBUG` request logging added this session (request body summary, tools array, tool_choice) is useful for diagnosing future model routing issues. Keep it as permanent debug tooling or remove it? Should be decided before C9.7 (changelog) so the changelog accurately reflects what's shipped.
