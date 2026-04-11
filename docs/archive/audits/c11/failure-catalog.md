<!-- Source: C11.1 stress-test battery — 2026-04-10 -->
# C11 Failure Catalog

**Date:** 2026-04-10
**Purpose:** Baseline per-model failure data before C11.2–C11.6 prompt hardening.
**Build:** dist/index.js (post-C9/C10/M11 stack)

---

## Result Matrix (model × scenario)

| Model | S1 Stall | S2 Tool-bias | S3 No-tools | S4 Parallel | S5 Error |
|-------|:--------:|:------------:|:-----------:|:-----------:|:--------:|
| kimi (`moonshotai/kimi-k2.5`) | **Pass** | — | **Pass** | **Pass** | **Pass** |
| qwen (`qwen/qwen3.5-397b-a17b`) | **Pass** | **Partial** | **Pass** | **Pass** | **Pass** |
| deepseek (`deepseek/deepseek-v3.2`) | — | **Pass** | **Pass\*** | **FAIL** | — |
| gemma (`google/gemma-4-31b-it`) | — | **Pass** | **Pass** | — | **Pass** |
| minimax (`minimax/minimax-m2.7`) | **Pass** | — | — | — | — |
| glm-5 (`zai-org/glm-5`) | — | — | **Pass** (triage) | — | — |

\* Minor: deepseek hallucinated 3 non-existent file paths in context-request phase; final answer still clean.

---

## Per-Scenario Results

### S1 — Agentic Stall Test (`coder` profile, `invoke`)

**Task:** Read `src/core/prompt-assembly.ts:543–600`, write a 2-line comment at the top of the function, verify with `head -n 5`.
**Watch:** Does the model narrate a plan without calling tools?

#### kimi — PASS
- 5 steps, 4 tool calls: `read_file×2`, `edit_file×1`, `exec_command×1`
- Executed immediately. No stall, no narration.
- Tool calls verified the edit at the correct location.

#### qwen — PASS
- 5 steps, 4 tool calls: `read_file×2`, `edit_file×1`, `exec_command×1`
- Self-corrected on verify step: recognized `head -n 5` shows imports, not line 543 — used `read_file` instead to confirm.
- No stall. Thinking content NOT present in result for coder profile (only leaks on witness profile, see S2).

#### minimax — PASS (with caveats)
- 10 steps, 9 tool calls: `read_file×1`, `edit_file×3`, `exec_command×5`
- Required 3 edit attempts due to incorrect `old_string` targeting (matched wrong lines first, then duplicated a line, then fixed).
- **Result leakage:** Final `result` field contains verbose task-narration preamble:
  `"The user wants me to: 1. read_file src/core/prompt-assembly.ts lines 543 through 600..."`
  Model writes its planning process as literal result output.
- Completed correctly despite extra cycles.

**S1 overall:** All 3 stall-prone models called tools and completed the task. Anti-pattern example in invoke system prompt is working. No stalls observed.

---

### S2 — Conceptual Question / Tool-Use Bias (`witness` profile, `invoke`)

**Task:** "What is the difference between a hard timeout and an idle timeout in a streaming API client? Answer directly."
**Watch:** Does the model call tools on a pure knowledge question?

#### deepseek — PASS
- 1 step, 0 tool calls.
- Concise accurate answer. Clean.

#### qwen — PARTIAL
- 1 step, 0 tool calls. Correct answer.
- **`reasoning_content` leakage:** Result prefixed with:
  `"Thinking...\n> The user is asking a conceptual question about streaming API clients... According to my tool_policy, I should answer conceptual or general knowledge questions directly...\n>\n"`
  `delta.reasoning_content` (captured as `text_delta` per C9 fix in nanogpt-driver) is flowing through into the `result` string.
- **New finding.** Affects any Qwen 3.5 response in invoke mode.

#### gemma — PASS
- 1 step, 0 tool calls.
- Comprehensive answer with comparison table. Clean.

**S2 overall:** Tool-use bias is not triggering on any model. The `reasoning_content` leakage in qwen is a new issue orthogonal to tool-use.

---

### S3 — No-Tools Discipline (`aca consult`, all 4 witnesses)

**Question:** "Should an LLM agent retry a failed tool call immediately or wait for user input? What are the tradeoffs?"
**Watch:** Pseudo-tool-calls, tool markup in responses.

#### All 4 witnesses — PASS
- deepseek: 0 tool calls in context-request + final passes.
- kimi: 0 tool calls, no context requests.
- qwen: 0 tool calls, no context requests.
- gemma: 0 tool calls, no context requests.
- triage (glm-5): 0 tool calls.
- No tool markup found in any witness response text.

#### deepseek — minor context-request hallucination
- Requested 3 non-existent files during context-request phase:
  - `src/core/agent/tool-call-handler.ts` (does not exist)
  - `docs/agent-design.md` (does not exist)
  - `config/agent-config.yaml` (does not exist)
- All returned ENOENT. Final witness answer still clean (received empty snippets, answered from knowledge).
- Not a hard failure but wastes context-request budget on hallucinated paths.

**S3 overall:** `NO_PROTOCOL_DELIBERATION` fix from C9.6 is holding. No pseudo-tool-calls from Qwen. Consult pipeline clean.

---

### S4 — Parallel Tool Calls (`coder` profile, `invoke`)

**Task:** "Read src/core/prompt-assembly.ts, src/prompts/prompt-guardrails.ts, and src/providers/tool-emulation.ts simultaneously. Report what constant each file exports."
**Watch:** All 3 reads in one turn (parallel) vs sequential.

#### kimi — PASS
- 2 steps, `read_file×3` in step 1 (parallel).
- Correctly reported: `prompt-guardrails.ts` exports `NO_NATIVE_FUNCTION_CALLING` + `NO_PROTOCOL_DELIBERATION`; other two files export no constants.

#### qwen — PASS
- 2 steps, `read_file×3` in step 1 (parallel).
- Same correct report. `reasoning_content` leaked in result (same as S2).

#### deepseek — FAIL
- Step 1: `read_file×3` in 1 turn (parallel reads DID work — 62,402 bytes received).
- Step 2: **`llm.malformed` — "Model returned an empty response"** (`retryable: true`).
- Model issued parallel reads successfully but failed to generate any response after receiving ~62KB of tool results.
- **New finding.** DeepSeek cannot generate after large tool result payloads. Likely a context window or response-generation threshold issue.
- `safety.outcome: "aborted"` — invoke returned `status: "error"`.

**S4 overall:** Kimi and Qwen handle parallel reads correctly. DeepSeek fails silently after large tool context. Gemma not tested (was known to have index=0 collision — now fixed in driver; test omitted from plan).

---

### S5 — Error Recovery (`coder` profile, `invoke`)

**Task:** "Read the file src/core/nonexistent-file.ts and report its contents."
**Watch:** Does the model retry with different path, explain the error, or give up?

#### kimi — PASS
- 2 steps, `read_file×1`.
- Result: "The file does not exist... `read_file` returned a 'File not found' error, which is expected."
- Explains error clearly. Did not retry or stall.

#### qwen — PASS
- 2 steps, `read_file×1`. Correct report.
- `reasoning_content` leaked again: `"Thinking...\n> The user wants me to read a file called 'src/core/nonexistent-file.ts'..."`.

#### gemma — PASS
- 2 steps, `read_file×1`.
- Terse but correct: "The file `src/core/nonexistent-file.ts` does not exist."

**S5 overall:** All 3 models handle ENOENT gracefully. None stall, retry the same path, or hallucinate contents.

---

## Prioritized Failure List

| Priority | Model | Scenario | Failure Mode | New? |
|----------|-------|----------|--------------|------|
| **P1** | deepseek | S4 | `llm.malformed` (empty response) after 62KB tool results. Invoke aborted. | NEW |
| **P2** | qwen | S2, S4, S5 | `reasoning_content` leaks into `result` text as `"Thinking...\n> ..."` prefix. | NEW |
| **P3** | minimax | S1 | Task-narration prose leaks into `result` (`"The user wants me to: 1. read_file..."`). | Known (pre-C11) |
| **P4** | deepseek | S3 | Hallucinated file paths in context-request (wastes budget, but doesn't fail). | Observed first time |

---

## What This Means for C11.2–C11.6

### C11.3 — Model Hints
- **Qwen:** Add model hint to suppress or strip `reasoning_content` from invoke results. The C9 fix that captures `reasoning_content` as `text_delta` is correct for preserving thinking in REPL, but for invoke callers the raw thinking preamble is noise. Options: (a) strip `Thinking...\n>` prefix in result assembly, (b) model hint telling Qwen not to emit thinking markers in results.
- **MiniMax:** Add model hint suppressing task-narration in results ("Do not repeat or narrate the task in your final answer. Begin directly with your response.").
- **DeepSeek:** Add model hint or per-model tool-result chunking to avoid `llm.malformed` on large contexts. May need `max_tool_result_bytes` constraint for deepseek invoke calls.

### C11.4 — Tool Description Enrichment
- No tool description failures observed. S4 parallel-read hint in invoke system prompt is working for kimi/qwen.

### C11.5 — Consult Surface Hardening
- DeepSeek context-request hallucination warrants a note in context-request prompt: "Only request files you are confident exist. If uncertain, skip the request." But this is low priority since the final answer was clean.

### C11.6 — Tool Emulation Hardening
- No tool emulation failures observed in this battery. Qwen `NO_PROTOCOL_DELIBERATION` fix is holding.

---

## Regressions vs Prior Known Issues

| Known Issue (pre-C11) | Status After C11.1 |
|-----------------------|--------------------|
| Kimi stall (narrates plan without tool calls) | **Not reproduced** — S1 passed cleanly |
| Qwen pseudo-tool-calls (no-tools context) | **Not reproduced** — S3 passed for all witnesses |
| DeepSeek tool-use bias (conceptual questions) | **Not reproduced** — S2 passed |
| Gemma parallel tool-call index=0 collision | **Not tested** (S4 omitted for gemma per plan) |
| MiniMax prose interleaved with output | **Confirmed** in S1 (verbose result narration) |

---

## Artifacts

| File | Contents |
|------|----------|
| `/tmp/c11-s1-kimi.json` | S1 invoke response (kimi) |
| `/tmp/c11-s1-qwen.json` | S1 invoke response (qwen) |
| `/tmp/c11-s1-minimax.json` | S1 invoke response (minimax) |
| `/tmp/c11-s2-deepseek.json` | S2 invoke response (deepseek) |
| `/tmp/c11-s2-qwen.json` | S2 invoke response (qwen) |
| `/tmp/c11-s2-gemma.json` | S2 invoke response (gemma) |
| `/tmp/c11-consult-s3.json` | S3 consult result (all 4 witnesses) |
| `/tmp/c11-s4-kimi.json` | S4 invoke response (kimi) |
| `/tmp/c11-s4-qwen.json` | S4 invoke response (qwen) |
| `/tmp/c11-s4-deepseek.json` | S4 invoke response (deepseek — FAIL) |
| `/tmp/c11-s5-kimi.json` | S5 invoke response (kimi) |
| `/tmp/c11-s5-qwen.json` | S5 invoke response (qwen) |
| `/tmp/c11-s5-gemma.json` | S5 invoke response (gemma) |
