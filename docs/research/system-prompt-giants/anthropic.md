# Anthropic Tool-Use Docs — Curated Findings

**Source:** https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/ and related docs, fetched 2026-04-06
**Full notes:** `/tmp/giants-anthropic.md` (488 lines, extensive verbatim quotes)

Anthropic is the authoritative voice on prompting Claude-family models for tool use. One section — [handling-stop-reasons § "Empty responses with end_turn"](https://platform.claude.com/docs/en/api/handling-stop-reasons) — is a **direct hit** on the ACA failure mode and is the single most load-bearing discovery in this research.

---

## The jackpot: "Empty responses with end_turn"

From `api/handling-stop-reasons`, verbatim:

> "Sometimes Claude returns an empty response (exactly 2-3 tokens with no content) with `stop_reason: 'end_turn'`. This typically happens when Claude interprets that the assistant turn is complete, particularly after tool results.
>
> **Common causes:**
> - Adding text blocks immediately after tool results (Claude learns to expect the user to always insert text after tool results, so it ends its turn to follow the pattern)
> - Sending Claude's completed response back without adding anything (Claude already decided it's done, so it will remain done)
>
> **How to prevent empty responses:**
>
> ```python
> # INCORRECT: Adding text immediately after tool_result
> messages = [
>     {"role": "user", "content": "Calculate the sum of 1234 and 5678"},
>     {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_123", ...}]},
>     {
>         "role": "user",
>         "content": [
>             {"type": "tool_result", "tool_use_id": "toolu_123", "content": "6912"},
>             {"type": "text", "text": "Here's the result"},  # Don't add text after tool_result
>         ],
>     },
> ]
>
> # CORRECT: Send tool results directly without additional text
> ```
>
> **Best practices:**
> 1. **Never add text blocks immediately after tool results** - This teaches Claude to expect user input after every tool use
> 2. **Don't retry empty responses without modification** - Simply sending the empty response back won't help
> 3. **Use continuation prompts as a last resort** - Only if the above fixes don't resolve the issue:
>
> ```python
> if response.stop_reason == "end_turn" and not response.content:
>     # CORRECT: Add a continuation prompt in a NEW user message
>     messages.append({"role": "user", "content": "Please continue"})
>     response = client.messages.create(model="claude-opus-4-6", max_tokens=1024, messages=messages)
> ```"

**This is the exact ACA bug, with an exact Anthropic-diagnosed root cause.** Two attributed causes:

1. **Bad message-history formatting**: text blocks adjacent to tool_result blocks teach the model "human takes over after tool results".
2. **Soft prompting**: passive voice, "suggest" language, no explicit action verbs.

**Anthropic-recommended fix order:**
1. Audit message history. Tool_result blocks must be the ONLY content in the user message, with no trailing text.
2. Strengthen verbs in system/user prompts.
3. Add `<default_to_action>` block.
4. Add `<use_parallel_tool_calls>` block if appropriate.
5. As a LAST RESORT for empty responses: append `{"role": "user", "content": "Please continue"}` continuation and re-call.
6. For hard-must-call-a-tool turns, use `tool_choice: "any"` (not compatible with extended thinking).

**Immediate ACA action:** Verify `src/core/turn-engine.ts` does not insert text blocks alongside `tool_result` content in the user-role message it constructs after a tool call. If it does, that is likely 30% or more of the fix on its own.

---

## Canonical agent loop structure

From `how-tool-use-works`, verbatim:

> "The canonical shape is a `while` loop keyed on `stop_reason`:
>
> 1. Send a request with your `tools` array and the user message.
> 2. Claude responds with `stop_reason: 'tool_use'` and one or more `tool_use` blocks.
> 3. Execute each tool. Format the outputs as `tool_result` blocks.
> 4. Send a new request containing the original messages, the assistant's response, and a user message with the `tool_result` blocks.
> 5. Repeat from step 2 while `stop_reason` is `'tool_use'`.
>
> In practice this reads as: while `stop_reason == 'tool_use'`, execute the tools and continue the conversation. The loop exits on any other stop reason (`'end_turn'`, `'max_tokens'`, `'stop_sequence'`, or `'refusal'`)..."

The Computer Use reference loop uses a more permissive variant (`anthropic-quickstarts/computer-use-demo/computer_use_demo/loop.py`):

```python
# If no tools were used, Claude is done - return the final messages
if not tool_results:
    return messages
```

**The presence-of-tool-use-blocks variant tolerates turns that mix text AND tool calls**, treating it as "still working". ACA's current implementation ends on `finishReason=stop` without tool calls, which is strictly the tutorial variant. Consider whether to switch to the more permissive form.

---

## Stop reason semantics

From `handling-stop-reasons`:

| Value | Meaning |
|---|---|
| `end_turn` | "The most common stop reason. Indicates Claude finished its response naturally." |
| `tool_use` | "Claude is calling a tool and expects you to execute it." |
| `max_tokens` | "Claude stopped because it reached the `max_tokens` limit specified in your request." |
| `stop_sequence` | "Claude encountered one of your custom stop sequences." |
| `pause_turn` | "Returned when the server-side sampling loop reaches its iteration limit while executing server tools... To let Claude finish processing, continue the conversation by sending the response back as-is." |
| `refusal` | "Claude refused to generate a response due to safety concerns." |
| `model_context_window_exceeded` | "Claude stopped because it reached the model's context window limit." |

**Relevance to ACA:** The `pause_turn` mechanism (re-send as-is to resume) is the architectural precedent for the `"Please continue"` recovery pattern. ACA's drivers may need to handle `pause_turn` explicitly for Anthropic — and the general pattern (re-send on weird stops) is reusable.

---

## `tool_choice` parameter

From `define-tools`:

> "When working with the tool_choice parameter, there are four possible options:
>
> - `auto` allows Claude to decide whether to call any provided tools or not. This is the default value when `tools` are provided.
> - `any` tells Claude that it must use one of the provided tools, but doesn't force a particular tool.
> - `tool` forces Claude to always use a particular tool.
> - `none` prevents Claude from using any tools. This is the default value when no `tools` are provided."

Critical behavioral quote:
> "Note that when you have `tool_choice` as `any` or `tool`, the API prefills the assistant message to force a tool to be used. This means that the models will not emit a natural language response or explanation before `tool_use` content blocks, even if explicitly asked to do so."

And:
> "Guaranteed tool calls with strict tools — Combine `tool_choice: {'type': 'any'}` with strict tool use to guarantee both that one of your tools will be called AND that the tool inputs strictly follow your schema."

Important constraint:
> "When using extended thinking with tool use, `tool_choice: {'type': 'any'}` ... are not supported and will result in an error."

**`tool_choice: "any"` is the strongest structural anti-narration mechanism Anthropic offers.** It prefills the assistant turn so the model cannot emit natural-language narration before the tool call. But it forces a tool call on EVERY turn, which is incompatible with the "final text summary" turn of ACA's workflow. The pragmatic pattern: use `auto` by default and prompt-level guardrails.

---

## Parallel tool use guidance

From `parallel-tool-use`, verbatim recommended system prompt fragment:

> "For Claude 4 models (Opus 4, and Sonnet 4), add this to your system prompt:
>
> ```text
> For maximum efficiency, whenever you need to perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially.
> ```
>
> For even stronger parallel tool use (recommended if the default isn't sufficient), use:
>
> ```text
> <use_parallel_tool_calls>
> For maximum efficiency, whenever you perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially. Prioritize calling tools in parallel whenever possible. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. When running multiple read-only commands like `ls` or `list_dir`, always run all of the commands in parallel. Err on the side of maximizing parallel tool calls rather than running too many tools sequentially.
> </use_parallel_tool_calls>
> ```"

Anthropic also flags the message-history failure mode:
> "❌ Wrong: Sending separate user messages for each tool result
> ✅ Correct: All tool results must be in a single user message"

**This is directly transferable to ACA.** Kimi already emitted 5 parallel reads in its first batch without explicit instruction, which suggests this prompt is less critical for Kimi than for Claude, but it's cheap to include and should push parallel-call reliability higher.

---

## `<default_to_action>` — the anti-suggestion block

From the prompting best-practices page:

> "Claude's latest models are trained for precise instruction following and benefit from explicit direction to use specific tools. If you say 'can you suggest some changes,' Claude will sometimes provide suggestions rather than implementing them, even if making changes might be what you intended.
>
> For Claude to take action, be more explicit:
>
> **Less effective (Claude will only suggest):** `Can you suggest some changes to improve this function?`
> **More effective (Claude will make the changes):** `Change this function to improve its performance.`
>
> To make Claude more proactive about taking action by default, you can add this to your system prompt:
>
> ```text
> <default_to_action>
> By default, implement changes rather than only suggesting them. If the user's intent is unclear, infer the most useful likely action and proceed, using tools to discover any missing details instead of guessing. Try to infer the user's intent about whether a tool call (e.g., file edit or read) is intended or not, and act accordingly.
> </default_to_action>
> ```"

**This is one of the two most directly transferable blocks in the entire research set** (the other is OpenAI's `<persistence>`). It targets the specific pattern of "model described its plan instead of executing it".

---

## Dial-back vs dial-up per model

From `define-tools`:
> "Claude Opus 4.5 and Claude Opus 4.6 are also more responsive to the system prompt than previous models. If your prompts were designed to reduce undertriggering on tools or skills, these models may now overtrigger. The fix is to dial back any aggressive language. Where you might have said 'CRITICAL: You MUST use this tool when...', you can use more normal prompting like 'Use this tool when...'."

**This is Anthropic's explicit acknowledgment that prompt strength must vary per model.** Strong imperatives that overtrigger Claude 4.6 may be exactly right for Kimi/Qwen. ACA's per-model variant architecture (long-term) must account for this.

---

## Tool description writing

From `define-tools`, "Best practices for tool definitions":

> "Provide extremely detailed descriptions. This is by far the most important factor in tool performance. Your descriptions should explain every detail about the tool, including:
> - What the tool does
> - When it should be used (and when it shouldn't)
> - What each parameter means and how it affects the tool's behavior
> - Any important caveats or limitations ...
> **Aim for at least 3-4 sentences per tool description, more if the tool is complex.**"

> "Consolidate related operations into fewer tools. Rather than creating a separate tool for every action (`create_pr`, `review_pr`, `merge_pr`), group them into a single tool with an `action` parameter. Fewer, more capable tools reduce selection ambiguity and make your tool surface easier for Claude to navigate."

**Immediate ACA action:** Audit `src/tools/*/spec.ts` — do all 25 tools have at least 3-4 sentence descriptions? If not, the tool schemas sent to the model are under-spec'd and this is an independent cause of confusion.

---

## Computer Use reference system prompt

From `anthropic-quickstarts/computer-use-demo/computer_use_demo/loop.py`, verbatim:

> ```text
> <SYSTEM_CAPABILITY>
> * You are utilising an Ubuntu virtual machine using {platform.machine()} architecture with internet access.
> * You can feel free to install Ubuntu applications with your bash tool. Use curl instead of wget.
> * To open firefox, please just click on the firefox icon. ...
> * Using bash tool you can start GUI applications, but you need to set export DISPLAY=:1 ...
> * When using your bash tool with commands that are expected to output very large quantities of text, redirect into a tmp file ...
> * When viewing a page it can be helpful to zoom out ...
> * When using your computer function calls, they take a while to run and send back to you. Where possible/feasible, try to chain multiple of these calls all into one function calls request.
> * The current date is {datetime.today().strftime("%A, %B %-d, %Y")}.
> </SYSTEM_CAPABILITY>
>
> <IMPORTANT>
> * When using Firefox, if a startup wizard appears, IGNORE IT. Do not even click "skip this step". Instead, click on the address bar where it says "Search or enter address", and enter the appropriate search term or URL there.
> * If the item you are looking at is a pdf, ... use curl to download the pdf, install and use pdftotext to convert it to a text file, and then read that text file directly with your str_replace_based_edit_tool.
> </IMPORTANT>
> ```

**This is strikingly minimal — ~15 bullets across two XML sections.** It does NOT contain anti-narration guidance, completion-signal markers, or explicit "you must call a tool" phrasing. It relies entirely on Claude's training. **ACA cannot rely on this for Kimi/Qwen.** Anthropic's canonical minimal prompt is a thin domain primer that works because the model is pre-trained for agentic tool use — a luxury ACA's executor models do not have.

Also from `computer-use` on prompting tips:
> "Claude sometimes assumes outcomes of its actions without explicitly checking their results. To prevent this you can prompt Claude with `After each step, take a screenshot and carefully evaluate if you have achieved the right outcome. Explicitly show your thinking: 'I have evaluated step X...' If not correct, try again.`"

---

## Transferable patterns (ranked by applicability to ACA)

1. **Message-history audit** — Critical. Verify `turn-engine.ts` doesn't add text alongside tool_result blocks. Possibly 30% of the fix.
2. **`<default_to_action>` block** — Direct. Drop-in adaptation for ACA invoke prompt.
3. **`<use_parallel_tool_calls>` block** — Direct. Drop-in.
4. **Tool description audit (3-4 sentences minimum)** — Direct. Audit all 25 tools.
5. **`"Please continue"` retry on empty `end_turn`** — Direct. `turn-engine.ts` can implement automatic retry.
6. **`tool_choice: "any"` for forced-tool turns** — Deferred. Incompatible with final summary turn.
7. **Dial-back vs dial-up per model** — Long-term. Feeds per-model variants.
8. **Computer Use reference prompt structure** — Reference only. Too thin for ACA's executor models.
9. **Canonical loop variant** — Already implemented in ACA.

## Full source references

- https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/overview
- https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/how-tool-use-works
- https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/build-a-tool-using-agent
- https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/define-tools
- https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/handle-tool-calls
- https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/parallel-tool-use
- https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/troubleshooting-tool-use
- https://platform.claude.com/docs/en/api/handling-stop-reasons
- https://platform.claude.com/docs/en/docs/build-with-claude/prompt-engineering/system-prompts
- https://platform.claude.com/docs/en/docs/agents-and-tools/computer-use
- https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-demo/computer_use_demo/loop.py
- https://www.anthropic.com/engineering/writing-tools-for-agents

**Dead URLs:** `platform.claude.com/docs/en/docs/agents-and-tools/tool-use/tool-use-best-practices` (content folded into `define-tools` and `troubleshooting-tool-use`).
