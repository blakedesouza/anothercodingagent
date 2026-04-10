# C11 Handoff

**Date:** 2026-04-10
**Status:** C11.1 COMPLETE. C11.2 (per-model hint infrastructure) is the immediate next action.

---

## What C11 Is

System prompt edge-case hardening and per-model tuning. The key insight from C9.6: targeted prompt changes have extraordinary impact (Qwen 2/6 → 6/6 clean). C11 systematically applies this to all 6 models with a baseline-first approach.

**Plan file:** `~/.claude/plans/async-knitting-shamir.md`

---

## Where C9 Left Off (COMPLETE)

- C9.6: Consult pipeline verified. `NO_PROTOCOL_DELIBERATION` + `stripMarkdownBlockquotes` fixed Qwen pseudo-tool-calls. 6/6 consults 4/4 witnesses clean.
- C9.7: Changelog written (`docs/changelog.md`).
- 3 stale test assertions fixed. Build clean. 2584 passing, 14 pre-existing live-integration failures (first-run, tool-execution, provider-selection, config — all require real API credentials, expected in CI).
- `NANOGPT_DEBUG`: kept as permanent toggleable debug tooling (user decision).

---

## C11 Substep Sequence

```
C11.1 → C11.2 → C11.3/4/5/6 (partly parallel) → C11.7
```

| Substep | What | Status |
|---------|------|--------|
| C11.1 | Stress-test battery baseline (no code changes) | **COMPLETE** |
| C11.2 | Per-model hint infrastructure | **COMPLETE** |
| C11.3 | Driver fixes for P1/P2 failures | **COMPLETE** |
| C11.4 | Tool description enrichment | **COMPLETE** |
| C11.5 | Consult surface hardening | **NEXT** |
| C11.6 | Tool emulation prompt hardening | pending |
| C11.7 | Regression tests + final validation matrix | pending |

---

## C11.3 — COMPLETE (driver fixes, not prompt changes)

**Goal was:** populate MODEL_HINTS for C11.1 failures. Actual execution: NANOGPT_DEBUG=1 re-investigation revealed both P1/P2 root causes were driver bugs, not prompt gaps.

### Qwen P2 fix — `src/providers/tool-emulation.ts`

NanoGPT proxy emits Qwen's chain-of-thought as plain `delta.content` (not `delta.reasoning_content`) using a `Thinking...\n> ...` markdown-blockquote prefix. The emulation wrapper yielded this verbatim.

**Fix:** strip `/^Thinking\.\.\.\n(>.*\n)*\n*/` from buffered text on the no-tool-calls result path (line ~479).

### DeepSeek P1 fix — `src/providers/nanogpt-driver.ts`

**Original C11.1 diagnosis was wrong** — this was NOT a context-size issue. Actual sequence: emulated tool calls are stored as `ToolCallPart` items → `buildRequestBody` serialized them as native `tool_calls` in turn 2 → DeepSeek sees native-function-calling protocol → responds with native tool calls → NanoGPT rejects (no tool schema) → `malformed_tool_call` 502.

**Fix:** `isEmulationMode` detection (`!request.tools || request.tools.length === 0`). In emulation mode: re-serialize `ToolCallPart` as emulation JSON text; convert `role: 'tool'` → `role: 'user'` (no `tool_call_id`).

Both verified: S2 Qwen clean, S4 DeepSeek success. 2601 tests passing.

---

## C11.1 — What To Do Next Session

**Goal:** Establish a per-model failure catalog before writing any code. This data drives C11.3.

**No code changes.** Output goes to `docs/c11/failure-catalog.md`.

### 5 Scenarios to Run

**Scenario 1 — Agentic stall test** (`aca invoke`, coder profile)
- Task: read `src/core/prompt-assembly.ts` lines 543-600, then write a 2-line comment at the top of the function explaining what it does. Verify with `head -n 5 src/core/prompt-assembly.ts`.
- What to watch: does the model terminate after a planning message with no tool calls?
- Run on: kimi, qwen, minimax (the stall-prone models)

**Scenario 2 — Conceptual question / tool-use bias** (`aca invoke`, witness profile)
- Task: "What is the difference between a hard timeout and an idle timeout in a streaming API client? Answer directly."
- What to watch: does the model call tools unnecessarily on a pure-knowledge question?
- Run on: deepseek, qwen, gemma

**Scenario 3 — No-tools discipline** (`aca consult`)
- Question: "Should an LLM agent retry a failed tool call immediately or wait for user input? What are the tradeoffs?"
- What to watch: Qwen pseudo-tool-calls (guardrails should prevent now), any other model emitting tool markup
- Run on: all 4 witnesses (standard `aca consult`)

**Scenario 4 — Parallel tool calls** (`aca invoke`, coder profile)
- Task: "Read src/core/prompt-assembly.ts, src/prompts/prompt-guardrails.ts, and src/providers/tool-emulation.ts simultaneously. Report what constant each file exports."
- What to watch: does the model call all 3 in parallel, or sequentially?
- Run on: kimi, qwen, deepseek

**Scenario 5 — Error recovery** (`aca invoke`, coder profile)
- Task: "Read the file src/core/nonexistent-file.ts and report its contents."
- What to watch: does the model retry with a different path, explain the error, or just give up?
- Run on: kimi, qwen, gemma

### How To Run

Use a temp HOME for all invoke runs:
```bash
HOME=$(mktemp -d -t aca-c11-XXXXXX) node dist/index.js invoke --json '{"task":"...","model":"moonshotai/kimi-k2.5"}'
```

For consult:
```bash
node dist/index.js consult --question "..." --out /tmp/c11-consult-s3.json
```

Write timestamped artifacts to `/tmp/c11-s<N>-<model>.json`.

### Failure Catalog Format

`docs/c11/failure-catalog.md` should have:
- A 6×5 matrix (model × scenario) with Pass/Fail/Partial
- Per-failure: exact failure mode, representative output snippet, whether it's a new failure or known from prior sessions
- Prioritized list of which model+surface combinations need the most intervention

---

## Key Prompt Surfaces (For Reference When C11.2 Starts)

| Surface | File | Used By |
|---------|------|---------|
| `buildInvokeSystemMessages` | `src/core/prompt-assembly.ts:543` | general, coder, rp-researcher |
| `buildAnalyticalSystemMessages` | `src/core/prompt-assembly.ts:836` | researcher, reviewer, witness |
| `buildSynthesisSystemMessages` | `src/core/prompt-assembly.ts:903` | triage |
| `buildToolSchemaPrompt` | `src/providers/tool-emulation.ts:24` | all NanoGPT models with tools |
| `buildContextRequestPrompt` | `src/consult/context-request.ts:133` | consult witnesses (context-request pass) |
| `buildNoToolsConsultSystemMessages` | `src/cli/consult.ts:407` | consult witnesses, triage |

**`InvokePromptOptions`** (src/core/prompt-assembly.ts) currently has NO `model` field — adding this is C11.2's first action.

## Known Per-Model Failure Modes (Pre-C11.1)

| Model | Known failure | Fixed? |
|-------|--------------|--------|
| qwen/qwen3.5-397b-a17b | Token budget deliberation on format → pseudo-tool-call | For no-tools (C9.6) ✓; agentic **untested** |
| moonshotai/kimi-k2.5 | Narrates plan without tool calls → stall | Partially mitigated by anti-pattern example; not eliminated |
| deepseek/deepseek-v3.2 | Tool-use bias on conceptual questions | Fixed by analytical tier (C9) ✓ |
| google/gemma-4-31b-it | Parallel tool calls with same index | Driver fix (C8) ✓; may wrap output in markdown |
| zai-org/glm-5:thinking | Native API tool calls on short-thinking path | Fixed by NO_NATIVE_FUNCTION_CALLING (C9) ✓ |
| minimax/minimax-m2.7 | Prose interleaved with JSON tool call syntax | Tool emulation parser issue; **untested post-C9** |
