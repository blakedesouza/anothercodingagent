# C10 Handoff — C9 Tainted, Requires Re-Validation

**Date:** 2026-04-09
**Status:** C9 live matrix is invalid. C10 premise is unconfirmed. Must re-run C9 before C10 means anything.

---

## The Core Problem

C9's entire live matrix was Qwen 3 Coder Next — not deepseek, not GLM-5, not Qwen 397B, not MiniMax.

**Why:** Commander's `--model` option had a hardcoded default of `'qwen/qwen3-coder-next'` that wins over all config. Every `aca` invocation without an explicit `--model` flag hit Qwen 3 Coder Next silently.

**This session fixed it:** `--model` is now required and errors immediately if not specified. But the damage to C9 results is done.

**Consequence for C10:** C10 was created to fix a "MiniMax M2.7 tool emulation bug" observed in C9's live matrix. That observation was on Qwen 3 Coder Next, not MiniMax. The MiniMax bug may not exist. C10 has no confirmed premise.

---

## What This Session Changed (Infrastructure)

### `--model` Is Now Required — No Defaults, No Fallbacks

```bash
# This now errors immediately:
node dist/index.js --no-confirm "task"
# Error: no model specified. Use --model <model>
# exit: 4

# All live tests must be explicit:
node dist/index.js --model minimax/minimax-m2.7 --no-confirm "task"
```

### Qwen 3 Coder Next Removed From All Defaults

| File | Change |
|---|---|
| `src/cli-main.ts` | Main `--model` option: no default |
| `src/cli-main.ts` | `rp-research --model`: no default |
| `src/cli-main.ts` | `invoke` handler: removed `\|\| 'qwen/qwen3-coder-next'` |
| `src/cli-main.ts` | `RP_RESEARCHER_MODEL_CANDIDATES`: Qwen removed |
| `src/cli/consult.ts` | `TRIAGE_MODEL_CANDIDATES`: Qwen removed |
| `src/config/schema.ts` | `CONFIG_DEFAULTS.model.default`: `null` (was `'qwen/qwen3-coder-next'`) |
| `src/config/schema.ts` | `ResolvedConfig.model.default` type: `string \| null` |

### `NANOGPT_DEBUG=1` Debug Logging Added

Still in production code. Logs raw SSE data and emulation buffer state to stderr.

```bash
NANOGPT_DEBUG=1 node dist/index.js --model <model> --no-confirm "task" 2>/tmp/debug.txt
```

**Verify which model NanoGPT actually routed to:**
```bash
grep '"model"' /tmp/debug.txt | head -1
```
The SSE data includes `"model":"..."` — always check this matches what you asked for.

---

## What Must Happen Next: Re-Run C9

### C9 Fixes That Need Real Validation

Three changes in `src/core/prompt-assembly.ts` `buildInvokeSystemMessages()`:

1. `<tool_preambles>`: "when tools are available" → "when the task requires tools"
2. `<mode>`: text-only = conversation ends → "ONLY valid text-only = final summary after all work done"
3. `<persistence>`: "never stop" → "applies while work remains"

These were validated on Qwen 3 Coder Next. Need to re-test on:

| Model | Test 1 (coder + file task) | Test 2 (coder + conceptual) |
|---|---|---|
| `deepseek/deepseek-v3.2` | must call `read_file` | must use 0 tools |
| `zai-org/glm-5:thinking` | must call `read_file` | must use 0 tools |
| `qwen/qwen3.5-397b-a17b` | must call `read_file` | must use 0 tools |
| `minimax/minimax-m2.7` | must call `read_file` | must use 0 tools |

**Test commands:**
```bash
# File task
node dist/index.js --model <model-id> --no-confirm \
  "Read the file src/core/prompt-assembly.ts and tell me what buildAnalyticalSystemMessages does"

# Conceptual task
node dist/index.js --model <model-id> --no-confirm \
  "Explain what a binary search tree is and when to use it instead of a hash map"
```

**Pass criteria:**
- File task: `▶ read_file` appears in output
- Conceptual task: no `▶` tool call lines in output, direct answer given

### C9.4 — Deferred Unit Tests (still pending)

Unit tests for:
- `buildAnalyticalSystemMessages` — includes profile but NOT `<mode>` or `<persistence>`
- `buildSynthesisSystemMessages` — includes "tools are NOT available"
- `buildSystemMessagesForTier` — routes to correct builder
- `buildInvokeSystemMessages` — regression: softened qualifiers present

---

## C10 Status After Re-Validation

**If all 4 models pass C9 re-validation:**
- C9 is complete
- MiniMax M2.7 never had a bug (it was Qwen 3 Coder Next all along)
- C10 is CLOSED — no work needed
- Remove `NANOGPT_DEBUG=1` logging from the codebase

**If MiniMax M2.7 fails (0 tool calls on file task):**
- C10 is real
- Use `NANOGPT_DEBUG=1 --model minimax/minimax-m2.7` to capture the actual raw stream
- One real MiniMax run was captured this session and showed `[TOOL_CALL]` format that parsed correctly — but only one run, inconclusive
- Follow the C10 plan at `<claude-home>/plans/jazzy-exploring-wind.md`

**If deepseek still shows bias (tool calls on conceptual, or `llm.malformed`):**
- The C9 prompt fixes didn't actually work
- Re-diagnose `buildInvokeSystemMessages` with `--model deepseek/deepseek-v3.2`

---

## Architecture Note: Emulation Is Intentional

ACA forces tool emulation for ALL NanoGPT models regardless of catalog `tool_calling: true`. This is deliberate — uniformity over native-per-model divergence. Do NOT change `supportsTools: 'emulated'` to `'native'` in `nanogpt-driver.ts`. A previous attempt to do this was reverted this session.

---

## Other Unresolved Items

- 2 pre-existing test failures — not investigated this session
- User wanted to add a debugging feature — interrupted before discussion
- `NANOGPT_DEBUG=1` logging is still in `src/providers/nanogpt-driver.ts` and `src/providers/tool-emulation.ts` — remove after C10 resolved or formalize as permanent tooling
