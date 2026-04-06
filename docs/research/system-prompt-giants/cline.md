# Cline System Prompt — Curated Findings

**Source:** https://github.com/cline/cline (branch `main` @ `841402c1789d`, fetched 2026-04-06)
**Full notes:** `/tmp/giants-cline.md` (373 lines, extensive verbatim quotes)

Cline is the most battle-tested open-source multi-model coding agent. It ships 12 per-model prompt variants because "one prompt fits all models" does not work. This chapter extracts the patterns relevant to ACA.

---

## Architecture at a glance

Cline no longer ships a single `system.ts` file. The prompt is assembled at runtime from:

- **Components** — `src/core/prompts/system-prompt/components/{agent_role,tool_use,rules,objective,editing_files,capabilities,...}.ts`
- **Per-tool prose** — `src/core/prompts/system-prompt/tools/<tool>.ts` (one file per tool, with `_variants` arrays exporting multiple versions)
- **Variants** — `src/core/prompts/system-prompt/variants/{generic,next-gen,native-next-gen,gpt-5,native-gpt-5,native-gpt-5-1,gemini-3,glm,devstral,hermes,trinity,xs}/` each with its own `config.ts` + `template.ts`

**There is also a legacy compact prompt at `src/core/prompts/system-prompt-legacy/families/local-models/compact-system-prompt.ts`** (145 lines, ~1.3K tokens) used specifically for small/local models like Qwen3-Coder. This is the most ACA-relevant artifact in the Cline repo — it is the prompt Cline ships to the exact class of models ACA uses.

## Snapshot lengths (from `__tests__/__snapshots__/`)

| Variant | Bytes | ~Tokens |
|---|---|---|
| `anthropic_claude_sonnet_4` | 59,124 | ~14,800 |
| `openai_gpt_5` | 57,927 | ~14,500 |
| `cline_devstral` | 59,144 | ~14,800 |
| `cline_claude_4_5_sonnet` (hosted) | 12,658 | ~3,200 |
| **`lmstudio_qwen3_coder` (compact)** | **5,287** | **~1,300** |
| `cline_native_next_gen.tools` | 28,614 | ~7,100 |

ACA's current invoke prompt is **~700 chars (~180 tokens)** — shorter than Cline's smallest production prompt by an order of magnitude.

## Section assembly order

From `variants/generic/template.ts`:

```
{{AGENT_ROLE_SECTION}}        <- identity, short
{{TOOL_USE_SECTION}}          <- formatting + tools + examples + guidelines
{{TASK_PROGRESS_SECTION}}
{{MCP_SECTION}}
{{EDITING_FILES_SECTION}}
{{ACT_VS_PLAN_SECTION}}
{{CAPABILITIES_SECTION}}
{{SKILLS_SECTION}}
{{FEEDBACK_SECTION}}
{{RULES_SECTION}}
{{SYSTEM_INFO_SECTION}}
{{OBJECTIVE_SECTION}}         <- operational "how to drive a turn" drive, LAST
{{USER_INSTRUCTIONS_SECTION}}
```

**The OBJECTIVE block (the operational drive) sits at the END, right before user instructions.** Identity is at the top, but the "how to act" text is the closer — research suggests this placement gives it primacy in attention.

---

## Key quotes

### Identity (short)

From `components/agent_role.ts:5-9`:
> "You are Cline, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices."

Three lines. That's the entire identity block.

### Tool-use discipline (repeated three times)

From `components/tool_use/index.ts:22-24`:
> "You have access to a set of tools that are executed upon the user's approval. You can use one tool per message, and will receive the result of that tool use in the user's response. You use tools step-by-step to accomplish a given task, with each tool use informed by the result of the previous tool use."

From `components/tool_use/guidelines.ts:17-23`:
> "It is crucial to proceed step-by-step, waiting for the user's message after each tool use before moving forward with the task. This approach allows you to: 1. Confirm the success of each step before proceeding. 2. Address any issues or errors that arise immediately. 3. Adapt your approach based on new information or unexpected results. 4. Ensure that each action builds correctly on the previous ones."

From `rules.ts:40` (third repetition):
> "It is critical you wait for the user's response after each tool use, in order to confirm the success of the tool use. For example, if asked to make a todo app, you would create a file, wait for the user's response it was created successfully, then create another file if needed, wait for the user's response it was created successfully, etc."

**The rule appears three times in three different sections.** Redundancy is deliberate. Critical operational rules get triple-redundant placement.

### Anti-conversational-opener rule

From `components/rules.ts:33`:
> "You are STRICTLY FORBIDDEN from starting your messages with \"Great\", \"Certainly\", \"Okay\", \"Sure\". You should NOT be conversational in your responses, but rather direct and to the point. For example you should NOT say \"Great, I've updated the CSS\" but instead something like \"I've updated the CSS\"."

**Caveat:** This targets conversational *openers*, NOT "I'll now do X" planning narration. Cline does not have a lexical rule against "let me make the modifications:" — the anti-stall pressure comes from structural enforcement (one tool per message + `attempt_completion` as only legal exit), not from lexical bans.

### Completion as a dedicated tool

From `tools/attempt_completion.ts:11-12`:
> "After each tool use, the user will respond with the result of that tool use ... Once you've received the results of tool uses and can confirm that the task is complete, use this tool to present the result of your work to the user. IMPORTANT NOTE: This tool CANNOT be used until you've confirmed from the user that any previous tool uses were successful. Failure to do so will result in code corruption and system failure."

The GPT-5 variant (`tools/attempt_completion.ts:45-46`) strengthens this:
> "This tool CANNOT be used until you've confirmed from the user that any previous tool uses were successful and **all tasks have been completed in full**."

**The diff between generic and GPT-5 variants is failure-mode evidence** — the team learned GPT-5 specifically needed the "all tasks completed in full" reinforcement.

### Six concrete tool-use examples

From `components/tool_use/examples.ts:28-137`, six copy-pastable XML examples covering `execute_command`, `write_to_file`, `new_task`, `replace_in_file`, and two MCP variants. Example 1:

```xml
<execute_command>
<command>npm run dev</command>
<requires_approval>false</requires_approval>
</execute_command>
```

**ACA has zero few-shot examples.** Cline ships six, minimum.

### Unavailable tools are REMOVED, not mentioned

Tool gating is done at the registry level (`variants/next-gen/config.ts:50-71` enumerates exact `ClineDefaultTool.*` IDs) and via `contextRequirements` callbacks in `spec.ts`. Browser and CLI rules use template placeholders (`rules.ts:46-54`: `BROWSER_RULES`, `CLI_RULES`) that resolve to empty strings when the capability is off.

**There is no language like "do not call tool X, it is not available" anywhere in Cline's prompts.** The discipline is enforced by omission.

### Safety as a required parameter

From `tools/execute_command.ts:19-21`:
> "A boolean indicating whether this command requires explicit user approval before execution in case the user has auto-approve mode enabled. Set to 'true' for potentially impactful operations like installing/uninstalling packages, deleting/overwriting files, system configuration changes, network operations, or any commands that could have unintended side effects. Set to 'false' for safe operations like reading files/directories, running development servers, building projects, and other non-destructive operations."

**Safety is encoded as a required `requires_approval: true|false` parameter**, not a prompt instruction. The model must make an explicit safety judgment per call. ACA has no equivalent.

### `<thinking>` tag as sanctioned planning channel

From `components/objective.ts:11`:
> "Before calling a tool, do some analysis within <thinking></thinking> tags."

From `tool_use/guidelines.ts:6`:
> "In <thinking> tags, assess what information you already have and what information you need to proceed with the task."

**This is critical for ACA's failure mode.** Cline gives the model an explicit channel for planning text that would otherwise leak as bare prose and end the turn. ACA's observed stall — *"Now I have all the context I need. Let me make the modifications:"* — looks exactly like thinking-content that escaped the tags.

---

## What transfers to ACA

| Pattern | Applicability | Notes |
|---|---|---|
| **Per-model variant architecture** | Long-term yes | Major investment. Start with one autonomous-mode variant. |
| **Compact prompt for small models** | Directly | The 1.3K-token `compact-system-prompt.ts` is a structural reference for the size ACA should target. |
| **Section ordering: operational drive LAST** | Yes | Put ACA's persistence/workflow instructions near the end, not the top. |
| **Triple repetition of critical rules** | Yes | Whatever the most-load-bearing sentence is, repeat at 3+ positions. |
| **`<thinking>` tag as planning channel** | Yes — with caveat | Need to verify ACA's drivers pass `<thinking>` content back into the model. If they strip it, the technique doesn't work. |
| **Few-shot examples in the system prompt** | Yes | ACA has zero. Add 2+ concrete examples. |
| **Unavailable tools removed from registry** | Yes | Remove `ask_user`, `confirm_action` from the registry when `isSubAgent=true` rather than declaring them unavailable in text. |
| **Safety as required parameter** | Deferred | Interesting but not M10.2-scoped. Consider for M10.3+. |

## What does NOT transfer

| Pattern | Why not |
|---|---|
| **"Wait for user confirmation after each tool use"** | Cline assumes a responsive human. ACA invoke mode is autonomous. Importing this would make ACA's stall *worse*. |
| **`attempt_completion` as dedicated exit tool** | Possible but Anthropic's implicit "no tool calls = done" is simpler and already partially implemented. Keep it as an open question. |
| **XML-as-interface for tool calls** | ACA uses native tool schemas. No need. |
| **Per-tool prose variants per model** | Overkill for ACA's current scale. Start with one variant per prompt section, not per tool. |
| **Ask-followup-question tool** | ACA `ask_user` is blocked in invoke mode. Remove from registry when `isSubAgent`. |

---

## Key takeaways for ACA

1. **Cline shipped 12 variants because they tried fewer and it didn't work.** ACA will hit the same wall. Not urgent, but plan for it.
2. **The compact-system-prompt.ts variant (~1.3K tokens) is the relevant size benchmark**, not the full ~14.8K token frontier prompt. ACA doesn't need to match frontier length to be effective — it needs to match compact-variant structure.
3. **Planning text without a sanctioned channel is the ACA bug.** Cline gives models `<thinking>` tags. ACA does not. If ACA does not add a similar channel, ACA must explicitly forbid pre-tool narration — and forbidding it lexically is hard (as Cline's own rules illustrate: their anti-narration rule only catches "Great"/"Certainly" openers, not "Let me start by..." middles).
4. **Cline is NOT a reference for autonomous-mode framing.** Its entire design assumes interactive. For the autonomous piece of ACA's puzzle, OpenAI's GPT-5 persistence block is a better reference.

## Full source references

All under `https://raw.githubusercontent.com/cline/cline/main/`:

- `src/core/prompts/system-prompt/components/agent_role.ts`
- `src/core/prompts/system-prompt/components/objective.ts`
- `src/core/prompts/system-prompt/components/rules.ts`
- `src/core/prompts/system-prompt/components/tool_use/index.ts`
- `src/core/prompts/system-prompt/components/tool_use/guidelines.ts`
- `src/core/prompts/system-prompt/components/tool_use/examples.ts`
- `src/core/prompts/system-prompt/components/tool_use/formatting.ts`
- `src/core/prompts/system-prompt/tools/attempt_completion.ts`
- `src/core/prompts/system-prompt/tools/execute_command.ts`
- `src/core/prompts/system-prompt/variants/generic/template.ts`
- `src/core/prompts/system-prompt/variants/next-gen/template.ts`
- `src/core/prompts/system-prompt/variants/next-gen/config.ts`
- `src/core/prompts/system-prompt/__tests__/__snapshots__/lmstudio_qwen3_coder-basic.snap`
- `src/core/prompts/system-prompt-legacy/families/local-models/compact-system-prompt.ts`
