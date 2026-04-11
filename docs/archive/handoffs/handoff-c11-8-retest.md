# C11.8 Retest Handoff — Fix Qwen/Kimi Issues, Then Run 4 Live Tests

## Context

C11.8 Bug 1 (path navigation — `buildDirectoryTree` maxDepth 2→3) was fixed in commit `0912435`.
Three live tests were run to validate it. Two produced failures that need fixing before they count as clean passes.

### Failure 1 — Kimi wrong-file-choice (test 1)

Kimi requested a tree of `src/`, received a listing that **included** `src/cli/invoke-output-validation.ts`,
but still chose to read `src/core/turn-engine.ts` instead. It answered about `CONFUSION_ERROR_CODES`
and `tool.validation` — which is the confusion-tracking circuit breaker, not the hard-rejection counter.

**Root cause:** kimi saw the right filename in the tree but anchored on the phrase
"hard-rejected tool calls" and associated it with the confusion-tracking mechanism
(which also rejects tool calls, just differently). No model hint currently tells kimi to
prefer the literal filename match over inference.

**Fix:** Add a kimi-specific hint in `src/prompts/model-hints.ts` (prefix: `moonshotai/kimi`).
The hint must tell kimi that when a function is named in the task, locate the file containing
that exact function — do not substitute a file that handles a similar concept.

### Failure 2 — Qwen blockquote deliberation (test 3)

Qwen3.5-397b-a17b wrapped its entire response in `>` blockquote syntax across every round —
including the `needs_context` JSON. ACA may have extracted the JSON in round 1, but qwen's
subsequent and final responses were all deliberation prose with no findings.

The `NO_PROTOCOL_DELIBERATION` guard in `src/prompts/prompt-guardrails.ts` targets tool-call
markup, not reasoning prose. It doesn't stop this.

**Root cause:** qwen3.5 externalizes chain-of-thought as blockquoted text when the question
is complex. This is a different failure mode from the `reasoning_content` leakage (P2 in
`docs/archive/audits/c11/failure-catalog.md`), which was a streaming delta issue fixed in C11.3.

**Fix:** Add a qwen-specific hint in `src/prompts/model-hints.ts` (prefix: `qwen/qwen3`
or `qwen/qwen3.5`). The hint must explicitly forbid wrapping output in blockquote syntax
and require direct output only.

---

## Fixes to Apply

### Fix A — kimi model hint

File: `src/prompts/model-hints.ts`

Add an entry for `moonshotai/kimi` (check if one already exists and extend it). The hint text:

> When the task names a specific function, type, or constant, locate the file that literally
> defines it — do not substitute a different file that handles a conceptually related feature.
> Use the exact name as your search anchor in the directory tree.

### Fix B — qwen model hint

File: `src/prompts/model-hints.ts`

Add an entry for `qwen/qwen3` (or the specific model, check existing entries). The hint text:

> Do not wrap your output in blockquote syntax (lines starting with `>`).
> Do not show your reasoning process or deliberation steps in the response.
> Output only: the `needs_context` JSON object if you need more context,
> or final Markdown findings if you are ready to finalize. Nothing else.

### After applying fixes

1. `npx tsc --noEmit` — must be clean
2. `npm run build` — must succeed
3. `npm test` — must stay at 2632 passing, 14 pre-existing failures, 1 skipped

---

## Test Suite — Run in Order, Not in Parallel

Run each test sequentially with a fresh `HOME`. Check the triage artifact after each.

### Test 1 (repeat — kimi wrong-file fix)

**Target file:** `src/cli/invoke-output-validation.ts`
**Expected facts (grounded in source):**
- Function: `countHardRejectedToolCalls`
- Error code checked: `tool.max_tool_calls`
- Condition: `item.kind === 'tool_result'` AND `item.output.status === 'error'` AND `item.output.error?.code === 'tool.max_tool_calls'`
- File is in `src/cli/`, NOT `src/core/` or `src/types/`

```bash
SUFFIX=$(date +%s) && HOME=$(mktemp -d -t aca-retest1-XXXXXX) \
  node dist/index.js consult \
  --question "What error code does the invoke pipeline use to identify hard-rejected tool calls? Find the function that counts them, explain what condition it checks, and name the file it lives in." \
  --project-dir <repo> \
  --max-context-rounds 3 \
  2>&1 | tee /tmp/aca-retest1-${SUFFIX}.txt
```

**Pass criteria:** All 4 witnesses name `src/cli/invoke-output-validation.ts` and report `tool.max_tool_calls`.

---

### Test 3 (repeat — qwen blockquote fix)

**Target file:** `src/cli/invoke-runtime-state.ts`
**Expected facts (grounded in source):**
- Controlling parameter: `includeRuntimeContextMessage`
- Default: `false`
- When `true`: calls `appendRuntimeContextMessage`, adds a system role message
- Content: `cwd`, `shell`, `projectSnapshot`, `workingSet`, `capabilities`, `durableTaskState`
- Built by `buildContextBlock` from `src/core/prompt-assembly.ts`
- File is in `src/cli/`, NOT `src/core/` or `src/invoke/`

```bash
SUFFIX=$(date +%s) && HOME=$(mktemp -d -t aca-retest3-XXXXXX) \
  node dist/index.js consult \
  --question "In the invoke runtime state module, when does a TurnEngine turn receive a runtime context system message? What parameter controls this, what is its default, and what content does the system message contain when it is included?" \
  --project-dir <repo> \
  --max-context-rounds 3 \
  2>&1 | tee /tmp/aca-retest3-${SUFFIX}.txt
```

**Pass criteria:** All 4 witnesses name `src/cli/invoke-runtime-state.ts` and identify `includeRuntimeContextMessage` with default `false`. Qwen must produce actual findings (not blockquote deliberation).

---

### Test A (new — executor exit codes and constraint fields)

**Target file:** `src/cli/executor.ts`
**Expected facts (grounded in source):**
- `EXIT_SUCCESS = 0`, `EXIT_RUNTIME = 1`, `EXIT_PROTOCOL = 5`
- `InvokeConstraints` fields include: `max_steps`, `max_tool_calls`, `max_tool_calls_by_name`,
  `max_tool_result_bytes`, `max_input_tokens`, `max_repeated_read_calls`, `max_total_tokens`,
  `required_output_paths`, `fail_on_rejected_tool_calls`, `allowed_tools`, `denied_tools`
- File is in `src/cli/`, NOT `src/invoke/` or `src/core/`

```bash
SUFFIX=$(date +%s) && HOME=$(mktemp -d -t aca-retest-a-XXXXXX) \
  node dist/index.js consult \
  --question "What are the exit codes defined in the executor module, and what fields does InvokeConstraints expose for capping tool usage? Name the exact file these are defined in." \
  --project-dir <repo> \
  --max-context-rounds 3 \
  2>&1 | tee /tmp/aca-retest-a-${SUFFIX}.txt
```

**Pass criteria:** All 4 witnesses name `src/cli/executor.ts`, report the three exit codes with correct values, and list at least 5 of the 11 `InvokeConstraints` fields accurately.

---

### Test B (new — runInit directories and secrets protection)

**Target file:** `src/cli/setup.ts`
**Expected facts (grounded in source):**
- `runInit` creates: `~/.aca/` (or override dir), `~/.aca/sessions/`, `~/.aca/indexes/`
- Uses `writeIfAbsent` helper — existing files are preserved, never overwritten
- `secrets.json` gets restricted permissions via `setRestrictedPermissions` (POSIX 0600 / Windows icacls)
- All writes happen at end of `runConfigure` so cancellation mid-wizard leaves no partial state
- File is in `src/cli/`, NOT `src/config/` or `src/commands/`

```bash
SUFFIX=$(date +%s) && HOME=$(mktemp -d -t aca-retest-b-XXXXXX) \
  node dist/index.js consult \
  --question "What directories does runInit create, and what protection does it apply to the secrets file? Also: what is the write strategy for runConfigure to avoid partial config on cancellation? Name the file these functions live in." \
  --project-dir <repo> \
  --max-context-rounds 3 \
  2>&1 | tee /tmp/aca-retest-b-${SUFFIX}.txt
```

**Pass criteria:** All 4 witnesses name `src/cli/setup.ts`, list the three directories, describe `writeIfAbsent` / restricted permissions for secrets, and mention end-of-wizard buffered writes.

---

## How to Inspect Results

After each test, find the triage artifact in the console output (look for `"path": "/tmp/aca-consult-triage-..."`), then:

```bash
cat /tmp/aca-consult-triage-<timestamp>-<pid>.md
```

Also check each witness's context-request artifact for how they navigated:

```bash
cat /tmp/aca-consult-kimi-context-request-<timestamp>-<pid>.md
cat /tmp/aca-consult-qwen-context-request-<timestamp>-<pid>.md
```

For qwen specifically: the response should NOT contain lines starting with `>`. If it does, the model hint is not working.
For kimi specifically: the response should cite `src/cli/` as the source file, not `src/core/`.

---

## After All Tests Pass

Update `docs/handoff-c11-8.md` live-validation table with the retest results.
The remaining open item in C11.8 is still: **continuation round responses not persisted to disk**
(`runWitness()` in `src/cli/consult.ts` — write each round's raw response to
`/tmp/aca-consult-{witness}-round-{n}-{suffix}.md`).
