# OpenAI Prompting & Agentic Loop Guidance — Curated Findings

**Source:** OpenAI Cookbook GPT-5/5.1 Prompting Guides, OpenAI Cookbook function calling notebooks, OpenAI API docs. Fetched 2026-04-06.

OpenAI's GPT-5 Prompting Guide ships **named XML-tagged prompt blocks** for exactly the concerns ACA needs: persistence, tool preambles, exploration, completion. The GPT-5 `<persistence>` block is the single strongest prior art for fixing ACA's terminal-stall bug.

---

## The jackpot: `<persistence>` block

From [cookbook.openai.com GPT-5 Prompting Guide](https://cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide) (verbatim from the notebook):

```xml
<persistence>
- You are an agent - please keep going until the user's query is completely resolved, before ending your turn and yielding back to the user.
- Only terminate your turn when you are sure that the problem is solved.
- Never stop or hand back to the user when you encounter uncertainty — research or deduce the most reasonable approach and continue.
- Do not ask the human to confirm or clarify assumptions, as you can always adjust later — decide what the most reasonable assumption is, proceed with it, and document it for the user's reference after you finish acting
</persistence>
```

Minimal-reasoning variant:
> "Remember, you are an agent - please keep going until the user's query is completely resolved, before ending your turn and yielding back to the user. Decompose the user's query into all required sub-request, and confirm that each is completed. Do not stop after completing only part of the request."

OpenAI's own diagnosis of why this matters:
> "Disambiguating tool instructions to the maximum extent possible and inserting agentic persistence reminders as shared above, are particularly critical at minimal reasoning to maximize agentic ability in long-running rollouts and prevent premature termination."

**OpenAI explicitly names "premature termination" as a documented failure mode** — the same one ACA is observing with Kimi and Qwen. The verbatim XML block addresses every symptom we saw:

| Symptom | Addressed by bullet |
|---|---|
| Kimi stalled at "Let me make the modifications:" | Bullet 1 — keep going until resolved |
| No explicit "done" signal, turn ended on text-only | Bullet 2 — only terminate when sure |
| Qwen's `ask_user` attempt (forwarding task) | Bullet 4 — don't ask human to confirm |

---

## `<solution_persistence>` — GPT-5.1 evolution

From [cookbook.openai.com GPT-5.1 Prompting Guide](https://cookbook.openai.com/examples/gpt-5/gpt-5-1_prompting_guide):

```xml
<solution_persistence>
- Treat yourself as an autonomous senior pair-programmer: once the user gives a direction, proactively gather context, plan, implement, test, and refine without waiting for additional prompts at each step.
- Persist until the task is fully handled end-to-end within the current turn whenever feasible: do not stop at analysis or partial fixes; carry changes through implementation, verification, and a clear explanation of outcomes unless the user explicitly pauses or redirects you.
- Be extremely biased for action. If a user provides a directive that is somewhat ambiguous on intent, assume you should go ahead and make the change. If the user asks a question like "should we do x?" and your answer is "yes", you should also go ahead and perform the action. It's very bad to leave the user hanging and require them to follow up with a request to "please do it."
</solution_persistence>
```

Rationale (from GPT-5.1 guide):
> "On long agentic tasks, we've noticed that GPT-5.1 may end prematurely without reaching a complete solution, but we have found this behavior is promptable, using instructions that tell the model to avoid premature termination and unnecessary follow-up questions."

**Key evolution:** GPT-5.1 uses 3 denser bullets with more aggressive bias-to-action language. "Be extremely biased for action" and the specific example ("If the user asks 'should we do x?' and your answer is 'yes', you should also go ahead and perform the action") are concrete guidance against the exact failure mode ACA is hitting.

---

## `<tool_preambles>` — channeling narration

From GPT-5 Prompting Guide, verbatim:

```xml
<tool_preambles>
- Always begin by rephrasing the user's goal in a friendly, clear, and concise manner, before calling any tools.
- Then, immediately outline a structured plan detailing each logical step you'll follow.
- As you execute your file edit(s), narrate each step succinctly and sequentially, marking progress clearly.
- Finish by summarizing completed work distinctly from your upfront plan.
</tool_preambles>
```

OpenAI's explanation:
> "GPT-5 is trained to provide clear upfront plans and consistent progress updates via 'tool preamble' messages."

**This is the critical insight for the ACA stall pattern.** The model *wants* to narrate its plan before acting. Cline tries to prevent this (with `<thinking>` tags). Aider tries to prevent this (with format pressure). OpenAI's approach is different: **accept that the model will narrate, and channel it into a specific shape.** The `<tool_preambles>` block tells the model:

1. Rephrase the goal (narration slot 1, pre-tools)
2. Outline a structured plan (narration slot 2, pre-tools)
3. Narrate execution (narration slot 3, DURING tool calls, not instead of them)
4. Summarize (narration slot 4, post-tools)

The Kimi failure — *"Now I have all the context I need. Let me make the modifications: 1. ... 2. ... 3. ..."* — is exactly the *outline-a-structured-plan* phase. Kimi did step 1 (implicitly) and step 2 (the numbered list), but then stopped instead of continuing into step 3 (narrating execution WITH tool calls). The `<tool_preambles>` block would tell it to continue.

**This is the most ACA-relevant prompt fragment in the entire research set for the specific failure mode.** Adopt it.

---

## `<exploration>` — pre-coding checklist

From GPT-5 Prompting Guide:

```xml
<exploration>
If you are not sure about file content or codebase structure pertaining to the user's request, use your tools to read files and gather the relevant information: do NOT guess or make up an answer.
Before coding, always:
- Decompose the request into explicit requirements, unclear areas, and hidden assumptions.
- Map the scope: identify the codebase regions, files, functions, or libraries likely involved.
- Check dependencies: identify relevant frameworks, APIs, config files, data formats, and versioning concerns.
- Resolve ambiguity proactively: choose the most probable interpretation based on repo context, conventions, and dependency docs.
- Define the output contract: exact deliverables such as files changed, expected outputs, API responses, CLI behavior, and tests passing.
- Formulate an execution plan: research steps, implementation sequence, and testing strategy.
</exploration>
```

**Transferable with adaptation.** ACA should include a pre-coding phase instruction. The specific 6-step checklist may be overkill for simple tasks — consider a condensed version.

---

## Completion verification language

From GPT-5 Prompting Guide:
> "Always verify your changes extremely thoroughly. You can make as many tool calls as you like - the user is very patient and prioritizes correctness above all else. Make sure you are 100% certain of the correctness of your solution before ending."

**Applicable to ACA's verification step** (running tests after edits).

---

## Tool-choice options

From [OpenAI Function Calling Guide](https://developers.openai.com/api/docs/guides/function-calling):

> "Auto (Default): tool_choice: 'auto' - Call zero, one, or multiple functions.
> Required: tool_choice: 'required' - Call one or more functions.
> Forced Function: tool_choice: {type: function, name: get_weather} - Call exactly one specific function.
> Allowed Tools: ... Use case: You might want to configure an allowed_tools list in case you want to make only a subset of tools available..."

And:
> "`parallel_tool_calls` ... can be set to false, which ensures exactly zero or one tool is called."

**`tool_choice: "required"` is OpenAI's equivalent of Anthropic's `tool_choice: "any"`.** It forces at least one function call per turn. Same limitation: incompatible with the final-summary turn pattern. Useful for specific sub-flows but not a general fix for ACA.

---

## Customer service cookbook — `tool_choice="required"` with loop exit

From [using_tool_required_for_customer_service cookbook](https://cookbook.openai.com/examples/using_tool_required_for_customer_service), verbatim system prompt:

```python
assistant_system_prompt = """You are a customer service assistant. Your role is to answer user questions politely and competently.
You should follow these instructions to solve the case:
- Understand their problem and get the relevant instructions.
- Follow the instructions to solve the customer's problem. Get their confirmation before performing a permanent operation like a refund or similar.
- Help them with any other problems or close the case.

Only call a tool once in a single message.
If you need to fetch a piece of information from a system or document that you don't have access to, give a clear, confident answer with some dummy values."""
```

Loop code:
```python
while respond is False:
    messages = [{"role": "system", "content": assistant_system_prompt}]
    [messages.append(x) for x in conversation_messages]

    response = client.chat.completions.create(
        model=GPT_MODEL,
        messages=messages,
        temperature=0,
        tools=tools,
        tool_choice='required'
    )

    conversation_messages.append(response.choices[0].message)
    respond, conversation_messages = execute_function(
        response.choices[0].message,
        conversation_messages
    )
```

Markdown guidance:
> "This adds an element of determinism to how you build your wrapping application, as you can count on a tool being provided with every call."

**The key architectural pattern:** the loop exits via a dedicated `speak_to_user` tool. The model cannot end the turn with text — it can only end by calling that tool. This mirrors Cline's `attempt_completion` pattern. **It's a "completion-as-a-tool" design.** ACA could adopt this (add a `complete_task` tool as the only legal exit), but that's a larger architectural change.

---

## Three core practices for GPT-5 agents

From the GPT-5 Prompting Guide meta-level guidance:
> "For agentic and long-running rollouts with GPT-5, focus your prompts on three core practices: plan tasks thoroughly to ensure complete resolution, provide clear preambles for major tool usage decisions, and use a TODO tool to track workflow and progress in an organized manner."

The three:
1. **Plan thoroughly** — covered by `<exploration>` and `<tool_preambles>` step 2.
2. **Provide preambles** — covered by `<tool_preambles>`.
3. **Use a TODO tool** — OpenAI recommends a dedicated state-tracking tool. ACA has `durable_task_state` internally (from M3.5) but the executor model doesn't call it directly — it's managed by the TurnEngine. **Question for future work:** should the executor model have a `update_task_state` tool it can call?

---

## Transferable patterns (ranked by applicability)

1. **`<persistence>` block (GPT-5 version)** — Direct drop-in. Highest-leverage single fix.
2. **`<tool_preambles>` block** — Direct drop-in. Addresses the "narrate then stop" pattern by channeling narration into a structured shape that continues through tool calls.
3. **`<solution_persistence>` (GPT-5.1 version)** — Alternative / evolution of `<persistence>`. More aggressive.
4. **`<exploration>` block** — Adaptable. Use a condensed version.
5. **"Make as many tool calls as you like" language** — Direct. Addresses model's possible assumption of a tool-call budget.
6. **`tool_choice: "required"` pattern** — Deferred. Incompatible with summary turn. Useful for specific sub-flows if ACA adopts a `complete_task` tool.
7. **TODO tool pattern** — Future. Currently managed by TurnEngine, not exposed to model.

## Full source references

- https://cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide
- https://cookbook.openai.com/examples/gpt-5/gpt-5-1_prompting_guide
- https://cookbook.openai.com/examples/using_tool_required_for_customer_service
- https://cookbook.openai.com/examples/orchestrating_agents (canonical agent loop pattern)
- https://cookbook.openai.com/examples/how_to_call_functions_with_chat_models
- https://cookbook.openai.com/examples/reasoning_function_calls (loop for o3/o4-mini)
- https://developers.openai.com/api/docs/guides/function-calling
- https://openai.com/index/unrolling-the-codex-agent-loop/ (not fetchable — openai.com returns 403)

**Notes on fetch issues:**
- `openai.com/index/*` returns 403 to our WebFetch.
- `platform.openai.com/docs/*` 308-redirects to `developers.openai.com/api/docs/*`, which is fetchable.
- `cookbook.openai.com/*` 308-redirects to `developers.openai.com/cookbook/*`, which is fetchable.
- GitHub raw URLs (`raw.githubusercontent.com/openai/openai-cookbook/*`) work reliably — use for verbatim notebook content.

**Persistence prompt provenance:** Verbatim text confirmed via direct fetch of the notebook at [raw.githubusercontent.com/openai/openai-cookbook/main/examples/gpt-5/gpt-5_prompting_guide.ipynb](https://raw.githubusercontent.com/openai/openai-cookbook/main/examples/gpt-5/gpt-5_prompting_guide.ipynb). The text is canonical OpenAI-published guidance, not a paraphrase.
