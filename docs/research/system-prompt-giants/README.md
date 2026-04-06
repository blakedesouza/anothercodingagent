# System Prompt Research — Learning From the Giants

**Date:** 2026-04-06
**Status:** Research complete. No code changes yet. Awaits user review.
**Purpose:** ACA's thin ~15-line invoke system prompt causes BOTH Kimi-K2.5 and Qwen3-Coder-Next to stall at the same terminal step during M10.2 delegation. This folder documents what four battle-tested agent prompting systems do and extracts patterns ACA should adopt.

---

## The bug being fixed

During M10.2, two completely different models hit the same failure mode:

- **Qwen3-Coder-Next:** chaotic first batch (including `delete_path` on project root), then stalled with *"Now I have all the context I need. Let me make the modifications:"* + zero tool calls → turn ended.
- **Kimi-K2.5:** disciplined first batch (5 clean reads, constraints honored), then stalled with *"Now I have all the context I need. Let me make the modifications:"* + zero tool calls → turn ended.

Same terminal text, same `finishReason=stop`, same `outcome=assistant_final`, zero files written. Two different vendors, two different training pipelines, same failure → **the system prompt is the bug, not the models**.

Anthropic has an official name for it: **"Empty responses with `end_turn`"** ([handling-stop-reasons](https://platform.claude.com/docs/en/api/handling-stop-reasons)).

## Sources consulted

| Source | Type | URL | Full notes |
|---|---|---|---|
| **Cline** | Battle-tested multi-model coding agent (VS Code) | https://github.com/cline/cline | [cline.md](cline.md) |
| **Aider** | Format-based (non-tool-call) edit loop | https://github.com/Aider-AI/aider | [aider.md](aider.md) |
| **Anthropic** | Claude-family official tool-use docs + Computer Use | https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/overview | [anthropic.md](anthropic.md) |
| **OpenAI** | GPT-5/5.1 prompting guide + cookbook | https://cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide | [openai.md](openai.md) |

All fetched 2026-04-06 against live sources (not training data).

---

## Consensus findings — what 3+ sources agree on

### 1. **Persistence / "keep going" is a first-class prompt concern**

Three of four sources explicitly address premature termination with named prompt blocks:

- **OpenAI GPT-5 `<persistence>` block (verbatim):**
  > `- You are an agent - please keep going until the user's query is completely resolved, before ending your turn and yielding back to the user.`
  > `- Only terminate your turn when you are sure that the problem is solved.`
  > `- Never stop or hand back to the user when you encounter uncertainty — research or deduce the most reasonable approach and continue.`
  > `- Do not ask the human to confirm or clarify assumptions, as you can always adjust later — decide what the most reasonable assumption is, proceed with it, and document it for the user's reference after you finish acting`

- **OpenAI GPT-5.1 `<solution_persistence>` (tighter, more aggressive):**
  > `- Treat yourself as an autonomous senior pair-programmer ... proactively gather context, plan, implement, test, and refine without waiting for additional prompts at each step.`
  > `- Persist until the task is fully handled end-to-end within the current turn whenever feasible`
  > `- Be extremely biased for action.`

- **Anthropic prompting best practices (from the Claude Code context-awareness guidance):**
  > `"... do not stop tasks early due to token budget concerns ... Always be as persistent and autonomous as possible and complete tasks fully ... Never artificially stop any task early regardless of the context remaining."`

- **Anthropic `<default_to_action>` fragment:**
  > `"By default, implement changes rather than only suggesting them. If the user's intent is unclear, infer the most useful likely action and proceed, using tools to discover any missing details instead of guessing."`

- **Aider `lazy_prompt` (opt-in per model):**
  > `"You are diligent and tireless! You NEVER leave comments describing code without implementing it! You always COMPLETELY IMPLEMENT the needed code!"`

Cline is the exception: Cline has no "keep going" block because its entire prompt design assumes a responsive human is waiting after every tool call. **Cline is not a valid reference for ACA's autonomous invoke mode** — its anti-stall pressure depends on an interactive dynamic that ACA's delegation path does not have.

### 2. **Repetition of critical rules at 3+ positions**

Every source in the study redundantly encodes its most load-bearing instructions:

- **Cline** repeats "use one tool per message, wait for the result" three times (`tool_use/index.ts:24`, `tool_use/guidelines.ts:15`, `rules.ts:40`) and `attempt_completion` gates three times (`tools/attempt_completion.ts:11`, `objective.ts:12`, `rules.ts:22`).
- **Aider** repeats `"ONLY EVER RETURN CODE IN A *SEARCH/REPLACE BLOCK*!"` three times (front of `main_system`, end of `main_system`, end of `system_reminder`), and **welds the whole 541-token system_reminder to the end of every user message** for drift-prone models.
- **Anthropic** repeats the tool-choice guidance in parallel docs (define-tools, troubleshooting, prompt-engineering) and publishes parallel-call guidance as a reusable fragment.

**Load-bearing rules in agent prompts are not stated once — they are stated 3+ times, at different positions in the prompt and sometimes outside the system message entirely.**

### 3. **Completion is a positive signal, not the absence of tool calls**

All four sources define "done" explicitly, not implicitly:

- **Cline:** A dedicated `attempt_completion` tool is the only legal exit. `"Once you've completed the user's task and verified the result, you must use the attempt_completion tool to present the result of the task to the user."`
- **Aider:** The parser is the arbiter. A turn with no SEARCH/REPLACE block triggers `"I didn't see any properly formatted edits in your reply?!"` and a retry — completion is encoded in the parser, not the prompt.
- **OpenAI:** "Only terminate your turn when you are sure that the problem is solved" + a recommended `<plan_tool_usage>` block with explicit status tracking.
- **Anthropic:** The tutorial loop predicate is `while stop_reason == "tool_use"`, but the computer-use reference loop uses `if not tool_results: return` (presence-of-tool-use-blocks), which tolerates turns with text + tool calls interleaved.

**ACA's current code does the structurally correct thing** (`turn-engine.ts` ends on no-tool-calls), but the prompt never tells the model what "done" means. The model has no anchor, so it stops when it feels like it's done planning.

### 4. **Tool descriptions are the single highest-leverage text**

- **Anthropic** explicitly calls this out: *"Provide extremely detailed descriptions. This is by far the most important factor in tool performance ... Aim for at least 3-4 sentences per tool description, more if the tool is complex."*
- **Cline** ships prose tool declarations INSIDE the system prompt (~1.3K tokens of tools in the compact qwen3 variant), plus examples, plus the native JSON schema separately.
- **OpenAI** recommends "single responsibility, clear boundaries, descriptive names, constrained parameters, useful descriptions: include examples, edge cases, return format".

**ACA's current system prompt lists tool NAMES ONLY** (`Available tools (25): read_file, edit_file, ...`). Tool schemas are sent separately via the API's `tools` field. Need to audit whether ACA's tool descriptions are at least 3-4 sentences each and include examples.

### 5. **Few-shot examples matter — except in the tiniest prompts**

- **Aider** ships TWO full worked user/assistant pairs showing the exact allowed preamble shape (*"To make this change we need to modify X to: 1. ..., 2. ..., 3. ... Here are the *SEARCH/REPLACE* blocks:"*) immediately followed by blocks.
- **Cline** ships SIX concrete tool-use examples (`components/tool_use/examples.ts:28-137`).
- **OpenAI** recommends "enforce structured tool use with examples" in its GPT-5 coding agent guidance.
- **Anthropic's** reference computer-use prompt has ZERO few-shot examples — but it targets a model (Sonnet 4+) trained specifically for computer use.

**ACA has zero few-shot examples.** For models not specifically trained for its tool surface, this is a gap.

### 6. **Ship per-model variants, not one uniform prompt**

- **Cline** ships **12 per-model variants** of the entire system prompt (`variants/{generic,next-gen,native-next-gen,gpt-5,native-gpt-5,native-gpt-5-1,gemini-3,glm,devstral,hermes,trinity,xs}`) PLUS per-tool prose variants per model. They explicitly gave up on "one prompt fits all models." The Qwen3-Coder variant (`compact-system-prompt.ts`, ~1.3K tokens) is structurally different from the Claude Sonnet 4 variant (~14.8K tokens).
- **Aider** ships 4 prompt classes by edit format (EditBlock, UDiff, WholeFile, Patch) and 2 more by role (Architect, Editor), each with different text.
- **Anthropic** ships ONE prompt pattern but explicitly warns that prompting strength must vary per model: *"Claude Opus 4.5 and 4.6 are more responsive to the system prompt ... dial back any aggressive language. Where you might have said 'CRITICAL: You MUST use this tool when...', you can use more normal prompting."*
- **OpenAI** ships different persistence blocks for GPT-5 (4 bullets) vs GPT-5.1 (3 bullets, more aggressive bias-to-action).

**The consensus is loud: uniform prompts don't scale across model families.** ACA currently has ONE invoke prompt that is sent to Kimi, Qwen, GPT, Claude alike. This is the single largest architectural gap.

---

## Divergence — where sources disagree

### A. Interactive vs. autonomous framing

- **Cline** assumes a human is in the loop. Its entire "wait for user confirmation after each tool use" philosophy is built on this. The YOLO mode flag only REMOVES the ask-clarifying-questions branch; it does not ADD autonomous framing.
- **Aider** assumes a human is in the loop — that's the whole architect/editor/user handoff model.
- **OpenAI GPT-5** assumes an autonomous rollout and provides the `<persistence>` block to enforce it. *"Never stop or hand back to the user when you encounter uncertainty."*
- **Anthropic** is bimodal: the Computer Use reference prompt is lean and assumes a responsive user; the Claude Code context-awareness guidance is fully autonomous.

**ACA invoke mode is autonomous. OpenAI's GPT-5 persistence pattern is the closest prior art.**

### B. Anti-narration technique

- **Aider:** format pressure (`ONLY EVER RETURN CODE IN A SEARCH/REPLACE BLOCK!` × 3, welded reminders).
- **Cline:** structural (`<thinking>` tags as sanctioned planning channel + "one tool per message" + `attempt_completion` as the only legal exit).
- **Anthropic:** message-history formatting fix (tool_result blocks must be alone in user messages, no trailing text) + `tool_choice: "any"` as structural override.
- **OpenAI:** named `<tool_preambles>` block that ACCEPTS narration but channels it into a specific format before tool calls.

**Each is valid. None is universal.** OpenAI's `<tool_preambles>` is the most ACA-compatible because it acknowledges the model will narrate and gives it a safe place to do so.

### C. Tool declaration format

- **Cline:** XML prose in system prompt + native JSON schema (both sent).
- **Aider:** No tool schemas at all. Format is the interface.
- **Anthropic:** Native JSON schema only, rich descriptions. *Three to four sentences per tool minimum.*
- **OpenAI:** Native JSON schema only, clear descriptions with examples.

**ACA sends native JSON schemas (correct) but its tool descriptions are too thin and the system prompt lists tool NAMES only.**

### D. Completion mechanism

- **Cline:** Dedicated `attempt_completion` tool.
- **Aider:** Absence of edit blocks.
- **Anthropic:** `stop_reason == "tool_use"` loop predicate; fallback `"Please continue"` continuation prompt on empty `end_turn`.
- **OpenAI:** `"Only terminate your turn when you are sure that the problem is solved"` + `tool_choice: "required"` for hard-must-call-tool flows.

**ACA uses Anthropic's implicit model (loop ends on no tool calls) but has none of the recovery mechanisms: no `"Please continue"` retry, no `tool_choice: "any"` escape hatch, no `attempt_completion`-style done signal.**

---

## Patterns that directly address ACA's terminal-stall bug

Ranked by evidence strength and applicability:

### P1. OpenAI-style `<persistence>` block (strongest prior art)
Source: OpenAI GPT-5/5.1 Prompting Guide. Directly names the failure mode ("premature termination in minimal-reasoning rollouts") and ships a verbatim XML block that addresses it. This is almost a drop-in fix.

### P2. Anthropic message-history formatting audit
Source: Anthropic `handling-stop-reasons`. The "Empty responses with end_turn" section attributes the failure to message-history shape: tool_result blocks should be alone in user messages, with NO trailing text. **ACA needs to verify `turn-engine.ts` does not insert text blocks alongside tool_result blocks.** This may be 30% of the fix on its own.

### P3. OpenAI `<tool_preambles>` block
Source: OpenAI GPT-5 Prompting Guide. Acknowledges models will narrate and channels it: "rephrase goal → outline plan → narrate execution → summarize". By making narration a NAMED pre-tool phase, it prevents the model from treating free-form planning text as a turn boundary.

### P4. Triple repetition of the critical rule
Source: Cline + Aider consensus. Whatever the most-important sentence is, it should appear at the top, middle, and bottom of the prompt AND be welded to the end of every user message (Aider's "stuff it into the user message" technique, [base_coder.py:1322](https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/base_coder.py)).

### P5. Anthropic `"Please continue"` recovery
Source: Anthropic `handling-stop-reasons` last-resort pattern. If the turn ends with empty content + `end_turn`, append `{"role": "user", "content": "Please continue"}` and retry. ACA's `turn-engine.ts` could implement this as automatic one-shot retry on empty-text `outcome=assistant_final`.

### P6. Few-shot examples in the system prompt
Source: Cline + Aider consensus. Concrete worked examples showing the allowed response shape are more effective than abstract rules. ACA has zero.

### P7. Per-model prompt variants
Source: Cline (12 variants), Aider (6 prompt classes), OpenAI (GPT-5 vs 5.1 split), Anthropic (dial-back warning). ACA has one prompt for all models. This is architectural, not a quick fix, but it's the long-term direction.

---

## ACA-specific adaptation notes

Not every pattern from these sources fits ACA. Constraints:

1. **ACA is autonomous in invoke mode, interactive in REPL mode.** The invoke prompt must not assume a responsive user. Cline's entire philosophy does not transfer — its anti-stall pressure depends on "wait for user, then react".
2. **ACA's tool surface has ~25 tools at peer-level.** Cline compact variant uses ~15. Anthropic recommends fewer-but-more-capable tools. ACA may need to audit whether all 25 are necessary for every task or whether to dynamically narrow per task type.
3. **ACA uses native tool schemas, not XML prose.** Cline's XML-in-prompt pattern is unnecessary — ACA's models get structured tool schemas via the API.
4. **ACA's `ask_user` and `confirm_action` tools are BLOCKED in invoke mode.** Qwen still tried to call `ask_user` because nothing in the prompt says it's unavailable. Cline handles this by OMISSION (tool is not in prompt). ACA should either omit these from the registry when `isSubAgent=true`, or declare them unavailable in the prompt.
5. **ACA's `delete_path` is DANGEROUS.** Qwen attempted it on project root. Sandbox caught it. Prompt should explicitly say destructive ops require the task to ask for them.
6. **Budget is not 2K.** The M11.6 "<2K token" target was premature optimization and is abandoned. 5–8K tokens is the new working budget. See [../../src/core/prompt-assembly.ts](../../../src/core/prompt-assembly.ts) and verified: no compression or packer applies to the invoke path (`turn-engine.ts:778` just prepends unchanged).

---

## Proposed ACA prompt structure (sketch only — not final)

Based on the synthesis, here is a structural outline. **This is not the final prompt text.** The user reviews this, then we draft the actual text together.

```
<identity>                    <- 2-3 lines, role
<mode>                        <- declare non-interactive/autonomous or interactive
<persistence>                 <- OpenAI GPT-5 block, adapted
<tool_use_discipline>         <- one rule: narrate via preambles, never stop on planning text
<tool_preambles>              <- OpenAI block, adapted: rephrase → plan → narrate → summarize
<workflow>                    <- explicit read → plan → edit → verify phases
<unavailable_tools>           <- ask_user, confirm_action are not callable
<safety>                      <- no destructive ops outside task scope
<environment>                 <- cwd, stack, git (existing)
<tool_reference>              <- brief prose summary of tool categories (not full schemas)
<examples>                    <- 1-2 few-shot examples of good turns
<closing_reminder>            <- single sentence: "complete all edits before your final text"
```

**Target length: 3K–5K tokens.** Tool JSON schemas remain separate (via API `tools` field) and need independent audit to meet Anthropic's "3-4 sentences per tool" rule.

---

## Open questions

These need user input before writing the actual prompt:

1. **Per-model variants now or later?** Ship one autonomous-mode prompt first and iterate, or invest upfront in variant infrastructure (Cline-style)?
2. **`attempt_completion` tool or implicit done?** Add a dedicated "I'm done" tool (Cline pattern), or rely on text-only = done (Anthropic tutorial pattern)?
3. **Message-history audit scope.** Does ACA's `turn-engine.ts` currently insert text blocks alongside tool_result blocks? This needs verification — might be a meaningful chunk of the fix independently.
4. **Auto-retry on empty end_turn.** Implement the Anthropic `"Please continue"` recovery pattern in `turn-engine.ts`, or leave it to the prompt?
5. **`ask_user` / `confirm_action` handling.** Remove from registry when `isSubAgent=true`, or declare unavailable in the prompt, or both?
6. **Few-shot examples.** Use ACA's own tool names in examples, or generic `<tool>` / `<another_tool>` placeholders?

---

## Test plan (for when we implement the fix)

1. **Verification task:** Same envelope used in M10.2 attempt #1 and #2 — add a `/model` slash command. Three target files, fully specified, includes verification commands.
2. **First retry:** Kimi-K2.5 (project `.aca/config.json` already set to this).
3. **Success criteria:**
   - First turn: sane batch of 5 file reads, no destructive ops, no `ask_user`/`confirm_action`, no `delete_path`.
   - Second turn: tool calls to `edit_file` on all three target files. No "let me make the modifications:" bare text with zero tool calls.
   - Third turn: `exec_command` running `npx vitest run test/cli/commands.test.ts`.
   - Final turn: text summary of what was done + verification output. Files actually changed on disk.
4. **If Kimi succeeds:** rerun with Qwen3-Coder-Next as a consistency check. If Qwen also succeeds, the prompt fix is validated cross-model.
5. **If Kimi fails:** examine session log for the new failure mode. Is it the same terminal stall, or a new failure? Either way, report back before trying additional changes.

---

## Sources

All fetched 2026-04-06:

- **Cline:** [cline/cline @ 841402c1789d](https://github.com/cline/cline)
- **Aider:** [Aider-AI/aider main](https://github.com/Aider-AI/aider)
- **Anthropic:** [platform.claude.com tool-use docs](https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/overview), [anthropic-quickstarts computer-use-demo](https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-demo/computer_use_demo/loop.py), [handling-stop-reasons](https://platform.claude.com/docs/en/api/handling-stop-reasons)
- **OpenAI:** [GPT-5 Prompting Guide](https://cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide), [GPT-5.1 Prompting Guide](https://cookbook.openai.com/examples/gpt-5/gpt-5-1_prompting_guide), [tool_choice=required cookbook](https://cookbook.openai.com/examples/using_tool_required_for_customer_service)

Per-source detail: [cline.md](cline.md), [aider.md](aider.md), [anthropic.md](anthropic.md), [openai.md](openai.md).

Raw research notes (subagent output, verbatim quotes, larger): `/tmp/giants-cline.md`, `/tmp/giants-aider.md`, `/tmp/giants-anthropic.md`.
