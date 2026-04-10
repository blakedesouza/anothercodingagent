# C11 Handoff

**Date:** 2026-04-10 (end of session)
**Status:** C11.1–C11.4 COMPLETE. C11.5 is next.

---

## What C11 Is

System prompt edge-case hardening and per-model tuning. The key insight from C9.6: targeted prompt changes have extraordinary impact (Qwen 2/6 → 6/6 clean). C11 systematically applies this to all 6 models with a baseline-first approach.

**Plan file:** `~/.claude/plans/async-knitting-shamir.md`

---

## C11 Substep Sequence

```
C11.1 → C11.2 → C11.3/4/5/6 (partly parallel) → C11.7
```

| Substep | What | Status |
|---------|------|--------|
| C11.1 | Stress-test battery baseline (no code changes) | **COMPLETE** |
| C11.2 | Per-model hint infrastructure | **COMPLETE** |
| C11.3 | Driver fixes for C11.1 P1/P2 failures | **COMPLETE** |
| C11.4 | Tool description enrichment | **COMPLETE** |
| C11.5 | Consult surface hardening | **NEXT** |
| C11.6 | Tool emulation prompt hardening | pending |
| C11.7 | Regression tests + final validation matrix | pending |

**Test count:** 2617 passing, 14 pre-existing live-integration failures (require real API credentials), 1 skipped.

---

## C11.3 — COMPLETE

### Investigation (this session)

Both C11.1 failures were re-investigated under `NANOGPT_DEBUG=1`. Original diagnoses were wrong for both.

### Qwen P2 — Preamble in `delta.content`, not `reasoning_content`

**Root cause:** NanoGPT proxy converts Qwen's chain-of-thought into a `Thinking...\n> ...` markdown-blockquote prefix inside `delta.content`. The emulation wrapper yielded it verbatim.

**Fix applied (two-part):**

1. `src/providers/tool-emulation.ts` — extracted `stripModelPreamble()` helper:
   ```typescript
   function stripModelPreamble(text: string): string {
       const stripped = text.replace(/^Thinking\.\.\.\n(>.*\n)*\n*/, '');
       return stripped.length > 0 ? stripped : text;
   }
   ```
   Applied universally at **both** yield sites in `wrapStreamWithToolEmulation`:
   - `result.preamble` before tool calls (was missed in the initial fix; covered in post-C11.4 live test follow-up)
   - `bufferedText` on the no-tool-calls path

**Why both sites matter:** C11.3 initially only patched the no-tool-calls branch. Live testing of C11.4 tool descriptions (4-model parallel run) revealed the preamble still leaked through `result.preamble` when Qwen used tools. The fix was universalized by extracting the helper and calling it at both yield sites.

### DeepSeek P1 — Protocol mismatch, NOT context size

**Root cause (corrected):** The C11.1 diagnosis ("empty response after 62KB tool results") was wrong. Actual sequence:
1. Turn 1: DeepSeek emits 3 parallel `read_file` calls as emulation JSON — parsed correctly.
2. The emulation wrapper stores them as `ToolCallPart` items in the conversation history.
3. Turn 2: `buildRequestBody` serializes `ToolCallPart` as native `tool_calls` in the request body, even though `tools: null` in the schema.
4. DeepSeek sees a native-function-calling conversation and responds with native tool calls.
5. NanoGPT has no tool schema → `malformed_tool_call` 502.

**Fix applied:** `src/providers/nanogpt-driver.ts:buildRequestBody` — added `isEmulationMode` detection:
```typescript
const isEmulationMode = !request.tools || request.tools.length === 0;
```
In emulation mode:
- `ToolCallPart` content re-serialized as emulation JSON text (not native `tool_calls`)
- `role: 'tool'` messages converted to `role: 'user'` (no `tool_call_id`)

This fix is **universal** — applied to `buildRequestBody`, which every NanoGPT request goes through.

**Verified:** S2 Qwen clean answer, S4 DeepSeek succeeds with 3-file synthesis.

---

## C11.4 — COMPLETE

### What was done

Expanded all 11 tool descriptions in `src/tools/` from 1-sentence stubs to Anthropic-guideline length.

**5 priority tools** (read_file, edit_file, exec_command, search_text, write_file) — expanded to 3–4 sentences documenting:
- `read_file`: 2K line / 64 KiB cap, binary detection by extension, 10 MiB rejection
- `edit_file`: exact-once search requirement, atomic multi-edit, hash guard against stale files
- `exec_command`: ~62 KiB head+tail cap, 60s default timeout, cwd/env params
- `search_text`: file_globs filter, context_lines, limit/exact params, regex vs literal
- `write_file`: create vs overwrite modes, auto-mkdir, "prefer edit_file" guidance

**6 secondary tools** (stat_path, move_path, delete_path, make_directory, find_paths, ask_user) — bumped from 1 sentence to 2–3.

**New test:** `test/tools/tool-descriptions.test.ts` — 16 assertions: 3+ sentences for priority tools, 2+ for all others.

### Live validation results (4 models, parallel)

Task exercised: `read_file` with `line_start`/`line_end` + `search_text` with `file_globs`.

| Model | Tool params used correctly | Result clean |
|-------|--------------------------|--------------|
| kimi | ✅ line_start/line_end, file_globs, parallel calls | ✅ |
| qwen | ✅ line_start/line_end, file_globs, parallel calls | ⚠️ preamble leak (fixed post-test) |
| deepseek | ✅ line_start/line_end, file_globs; broad retry on 0 results | ✅ |
| gemma | ✅ line_start/line_end, file_globs | ✅ |

Note: The 0 search results are correct — the task searched for `approvalClass: workspace-write` without quotes, but the source has `approvalClass: 'workspace-write'` with quotes.

---

## Architecture Notes Established This Session

### Tool emulation message flow (important for future work)

For all NanoGPT models (`supportsTools: 'emulated'`):
1. Tool schemas are injected into the **system prompt** (not the API `tools` field)
2. The model generates tool calls as plain JSON text: `{"tool_calls": [...]}`
3. `wrapStreamWithToolEmulation` parses this JSON from the stream
4. The parsed calls are stored as `ToolCallPart` items in the conversation history
5. **Critical:** Turn 2 requests must NOT send these as native `tool_calls` — use emulation JSON text instead, and convert `role: 'tool'` to `role: 'user'`

### Preamble stripping scope

`stripModelPreamble()` in `tool-emulation.ts` covers all invoke paths because all profiles have tools (WITNESS_TOOLS, CODER tools, etc.), so `wrapStreamWithToolEmulation` is always called during invoke. The consult path (no tools) is separately hardened by `NO_PROTOCOL_DELIBERATION` guardrail in system prompts.

### Universal fix principle (new feedback memory saved)

When fixing a driver/parser bug: fix at the single choke point all calls pass through. If you must fix in a branching wrapper, extract a named helper and call it at **every** yield site — not just the one that surfaced the symptom.

---

## C11.5 — NEXT: Consult Surface Hardening

**Goal:** Harden the consult pipeline's prompt surfaces.

### Surfaces to touch

| Surface | File | What to change |
|---------|------|---------------|
| `buildNoToolsConsultSystemMessages` | `src/cli/consult.ts:407` | Wire model hints using `witness.model` (already passed at call sites from C11.2) |
| `buildContextRequestPrompt` | `src/consult/context-request.ts:133` | Add a concrete bad-vs-good JSON example to the format instructions — Qwen's deliberation on context-request format was partly caused by ambiguous instructions |
| `buildTriagePrompt` | (find in consult.ts or consult/) | Harden against false-positive "un-evidenced claim" patterns |
| `buildFinalizationPrompt` | (find in consult.ts) | Add model hints |

### How to approach C11.5

1. Read `src/cli/consult.ts` and `src/consult/context-request.ts` in full — understand each prompt surface
2. Read `docs/c11/failure-catalog.md` S3 findings — specifically which witnesses had consult issues
3. Run a baseline consult: `node dist/index.js consult --question "Should an agent retry tool calls immediately or wait for user input?" --out /tmp/c11-5-baseline.json`
4. Make changes (start with `buildContextRequestPrompt` — highest impact from C11.1 data)
5. Run live consult validation (all 4 witnesses, 2+ runs)
6. Acceptance: zero pseudo-tool-call failures across 6 consult runs

### What C11.2 already wired for C11.5

`model` is already passed to `buildNoToolsConsultSystemMessages` at all witness call sites in `consult.ts`. `getModelHints()` is ready to use — `MODEL_HINTS` registry just needs entries added if per-model hints are needed. The `<model_hints>` XML block will auto-inject when hints exist.

### Key files for C11.5

```
src/cli/consult.ts            — witness invocation, triage, buildNoToolsConsultSystemMessages
src/consult/context-request.ts — buildContextRequestPrompt (context-request pass)
src/prompts/model-hints.ts    — MODEL_HINTS registry (currently empty)
src/prompts/prompt-guardrails.ts — NO_NATIVE_FUNCTION_CALLING, NO_PROTOCOL_DELIBERATION
```

---

## Key Prompt Surfaces Reference

| Surface | File | Used By |
|---------|------|---------|
| `buildInvokeSystemMessages` | `src/core/prompt-assembly.ts` ~line 543 | general, coder, rp-researcher |
| `buildAnalyticalSystemMessages` | `src/core/prompt-assembly.ts` ~line 836 | researcher, reviewer, witness |
| `buildSynthesisSystemMessages` | `src/core/prompt-assembly.ts` ~line 903 | triage |
| `buildToolSchemaPrompt` | `src/providers/tool-emulation.ts:24` | all NanoGPT models with tools |
| `buildContextRequestPrompt` | `src/consult/context-request.ts:133` | consult witnesses (context-request pass) |
| `buildNoToolsConsultSystemMessages` | `src/cli/consult.ts` ~line 407 | consult witnesses, triage |

---

## Per-Model Status After C11.1–C11.4

| Model | Issue | Status |
|-------|-------|--------|
| qwen/qwen3.5-397b-a17b | `Thinking...\n> ...` preamble in results | **FIXED** — `stripModelPreamble()` at all yield sites |
| qwen/qwen3.5-397b-a17b | Pseudo-tool-calls in consult (no-tools) | **FIXED** C9.6 — `NO_PROTOCOL_DELIBERATION` |
| deepseek/deepseek-v3.2 | `malformed_tool_call` on multi-turn tool use | **FIXED** — emulation mode message rewrite in `buildRequestBody` |
| moonshotai/kimi-k2.5 | Agentic stall (narrates plan without tool calls) | Partially mitigated (anti-pattern example); C11.6 may address further |
| google/gemma-4-31b-it | Parallel tool calls same index | **FIXED** C8 (driver fix) |
| zai-org/glm-5:thinking | Native API tool calls | **FIXED** C9 — `NO_NATIVE_FUNCTION_CALLING` |
| minimax/minimax-m2.7 | Prose interleaved with emulation JSON | Untested post-C9; C11.6 target |

---

## Commits This Session

```
22193e5  C11.3: fix Qwen reasoning preamble leak and DeepSeek emulation protocol mismatch
c4a781b  changelog: C11.3 entry
db51226  C11.4: enrich tool descriptions to 3+ sentences (priority) / 2+ (all)
309a55f  docs: C11.4 changelog and handoff update
f47b116  fix: apply Qwen preamble strip universally to all tool-emulation yield sites
```

---

## How to Run Live Tests

```bash
# Build first
npm run build

# Invoke (write input JSON to file to avoid shell escaping issues)
python3 -c "
import json
print(json.dumps({
    'contract_version': '1.0.0',
    'schema_version': '1.0.0',
    'task': 'YOUR TASK HERE',
    'context': {'model': 'MODEL_ID', 'profile': 'coder', 'cwd': '/home/blake/projects/anothercodingagent'},
}))
" > /tmp/input.json
cat /tmp/input.json | HOME=$(mktemp -d -t aca-test-XXXXXX) node dist/index.js invoke --json

# Debug mode (raw SSE to stderr)
cat /tmp/input.json | NANOGPT_DEBUG=1 HOME=$(mktemp -d -t aca-debug-XXXXXX) node dist/index.js invoke --json > /tmp/out.json 2>/tmp/debug.txt

# Consult
node dist/index.js consult --question "YOUR QUESTION" --out /tmp/consult-out.json
```

**Model IDs:**
- `moonshotai/kimi-k2.5`
- `qwen/qwen3.5-397b-a17b`
- `deepseek/deepseek-v3.2`
- `google/gemma-4-31b-it`
- `zai-org/glm-5:thinking`
- `minimax/minimax-m2.7`
