# Aider System Prompts — Curated Findings

**Source:** https://github.com/Aider-AI/aider (branch `main`, fetched 2026-04-06)
**Full notes:** `/tmp/giants-aider.md` (487 lines, extensive verbatim quotes)

Aider takes a fundamentally different approach than tool-based agents. It uses **edit formats** (SEARCH/REPLACE blocks, unified diffs, whole-file rewrites, V4A patches) parsed out-of-band from assistant text. **There are no tool calls.** The format IS the interface. This contrast is valuable: it illustrates what happens when you design an agent loop where narration and action cannot be separated.

---

## Prompt files

- `aider/coders/base_prompts.py` — shared base class (`CoderPrompts`)
- `aider/coders/editblock_prompts.py` — SEARCH/REPLACE format (primary edit format)
- `aider/coders/udiff_prompts.py` — unified-diff format
- `aider/coders/wholefile_prompts.py` — whole-file rewrite format
- `aider/coders/patch_prompts.py` — OpenAI "V4A" patch format
- `aider/coders/architect_prompts.py` — architect half of architect/editor split
- `aider/coders/editor_editblock_prompts.py` — editor half of architect/editor split
- `aider/coders/base_coder.py:1174-1331` — runtime assembly logic

## Template lengths

| Prompt class | main_system | system_reminder |
|---|---|---|
| `EditBlockPrompts` | ~264 tokens | ~541 tokens |
| `UnifiedDiffPrompts` | ~100 | ~370 |
| `WholeFilePrompts` | ~84 | ~219 |
| `PatchPrompts` (V4A) | ~277 | ~599 |
| `ArchitectPrompts` | ~119 | (empty) |
| `EditorEditBlockPrompts` | ~67 | (inherits editblock reminder) |

Effective on-wire system payload for EditBlock: **~1.5–3K tokens** including few-shot example pairs, repo map, and `{final_reminders}`.

---

## Key quotes

### Task framing

From `editblock_prompts.py:8-30` (`main_system`):
> ```
> Act as an expert software developer.
> Always use best practices when coding.
> Respect and use existing conventions, libraries, etc that are already present in the code base.
> {final_reminders}
> Take requests for changes to the supplied code.
> If the request is ambiguous, ask questions.
>
> Once you understand the request you MUST:
>
> 1. Decide if you need to propose *SEARCH/REPLACE* edits to any files that haven't been added to the chat. ...
> 2. Think step-by-step and explain the needed changes in a few short sentences.
> 3. Describe each change with a *SEARCH/REPLACE block* per the examples below.
>
> All changes to files must use this *SEARCH/REPLACE block* format.
> ONLY EVER RETURN CODE IN A *SEARCH/REPLACE BLOCK*!
> ```

Note step (2) is the **only narration slot**: "explain the needed changes in a few short sentences." Everything else is constrained to machine-parseable blocks.

### Format pressure — the anti-stall mechanism

The sentence `ONLY EVER RETURN CODE IN A *SEARCH/REPLACE BLOCK*!` appears three times:

1. `editblock_prompts.py:28` — end of `main_system`
2. `editblock_prompts.py:157` — end of `system_reminder`
3. `editor_editblock_prompts.py:11` — end of the minimized editor variant

**Aider's answer to stalling is format pressure, not negative warnings.** The model is told three times in different positions that the only valid output is a SEARCH/REPLACE block. There is no branch of the response grammar that allows "I'll now do X" without a block following it.

### Two full worked few-shot examples

From `editblock_prompts.py:31-118`, the first example pair (user → assistant):

> User: "Change get_factorial() to use math.factorial"
>
> Assistant: "To make this change we need to modify `mathweb/flask/app.py` to:
>
> 1. Import the math package.
> 2. Remove the existing factorial() function.
> 3. Update get_factorial() to call math.factorial instead.
>
> Here are the *SEARCH/REPLACE* blocks:
>
> mathweb/flask/app.py
> ```python
> <<<<<<< SEARCH
> from flask import Flask
> =======
> import math
> from flask import Flask
> >>>>>>> REPLACE
> ```
> ..."

**Every worked example uses the same preamble shape:** *"To make this change we need to modify X to: 1. ..., 2. ..., 3. ... Here are the *SEARCH/REPLACE* blocks:"* immediately followed by blocks. The preamble is a demo of the allowed narration slot from step (2) of `main_system`. The few-shot examples teach the model exactly how much narration is allowed and where it must end.

A second example at lines 81-117 demonstrates file creation (empty SEARCH section) and code move (delete block + insert block).

### Reminder welding — the drift-proofing technique

From `base_coder.py:1261-1331`, the reminder re-injection logic:

> ```python
> if self.main_model.reminder == "sys":
>     chunks.reminder = reminder_message
> elif self.main_model.reminder == "user" and final and final["role"] == "user":
>     # stuff it into the user message
>     new_content = (
>         final["content"]
>         + "\n\n"
>         + self.fmt_system_prompt(self.gpt_prompts.system_reminder)
>     )
>     chunks.cur[-1] = dict(role=final["role"], content=new_content)
> ```

The `system_reminder` (~541 tokens of SEARCH/REPLACE rules) is:

1. Included in the system prompt at the top of context, AND
2. Re-injected every turn — either as a final system message (`reminder == "sys"`) or **physically concatenated to the end of the user's latest message** (`reminder == "user"`, the default for most models).

The comment `# stuff it into the user message` ([base_coder.py:1322](https://raw.githubusercontent.com/Aider-AI/aider/main/aider/coders/base_coder.py)) is the most candid design-rationale comment in the entire Aider codebase. For drift-prone models, the reminder is welded to the user turn so the model cannot miss it.

### Stall recovery via parser

From `base_prompts.py:4` and `:8`:

> `files_content_gpt_edits = "I committed the changes with git hash {hash} & commit msg: {message}"`
>
> `files_content_gpt_no_edits = "I didn't see any properly formatted edits in your reply?!"`

If the model produces a turn with no SEARCH/REPLACE blocks, Aider injects the "I didn't see..." message as a user reply and re-calls the model. This is a **parser-level stall recovery mechanism**: the harness catches the failure and demands a retry.

### Anti-lazy prompt (opt-in per model)

From `base_prompts.py:12-15`:

> ```python
> lazy_prompt = """You are diligent and tireless!
> You NEVER leave comments describing code without implementing it!
> You always COMPLETELY IMPLEMENT the needed code!
> """
> ```

Applied only to models flagged `lazy: True` in `models.py:123` (GPT-4-turbo and some GPT-4o variants). Aider does not ship this to every model — they found it unnecessary for non-lazy models.

### Anti-overeager prompt (counterpart)

From `base_prompts.py:17-20`:

> ```python
> overeager_prompt = """Pay careful attention to the scope of the user's request.
> Do what they ask, but no more.
> Do not improve, comment, fix or modify unrelated parts of the code in any way!
> """
> ```

### Synthetic assistant acks — behavior anchoring

From `base_prompts.py:30`:
> `files_content_assistant_reply = "Ok, any changes I propose will be to those files."`

From `base_coder.py:1249-1259`:
> ```python
> example_messages += [
>     dict(role="user", content="I switched to a new code base. Please don't consider the above files or try to edit them any longer."),
>     dict(role="assistant", content="Ok."),
> ]
> ```

Aider **puts words in the model's mouth** as prior conversation turns. The model "commits" to a behavior by having a prior assistant ack. This is a conversation-level commitment pattern that the prompt alone cannot achieve.

### Architect/editor split

From `architect_prompts.py:7-16`:
> ```
> main_system = """Act as an expert architect engineer and provide direction to your editor engineer.
> Study the change request and the current code.
> Describe how to modify the code to complete the request.
> The editor engineer will rely solely on your instructions, so make them unambiguous and complete.
> Explain all needed code changes clearly and completely, but concisely.
> Just show the changes needed.
>
> DO NOT show the entire updated function/file/etc!
> """
> ```

`system_reminder = ""` — the architect has NO format-rules reminder because the architect produces free-form English, not edits.

From `editor_editblock_prompts.py:7-12` (the minimized editor):
> ```
> Act as an expert software developer who edits source code.
> {final_reminders}
> Describe each change with a *SEARCH/REPLACE block* per the examples below.
> All changes to files must use this *SEARCH/REPLACE block* format.
> ONLY EVER RETURN CODE IN A *SEARCH/REPLACE BLOCK*!
> ```

Four lines. The editor variant strips out the entire "ask before editing unknown files" protocol, shell commands, rename tips, and go-ahead tips, because the architect has already decided what needs to change. **Each stage has a dramatically different prompt scoped to its job.**

---

## Why Aider's approach matters for ACA

Aider does not use tool calls, so most of its mechanics do not transfer directly. But the **contrast** teaches three things:

1. **Why tool-based agents stall that Aider-style agents don't.** In Aider, there is no legitimate turn that ends without a format block (except "I need more context, add files to chat"). The grammar of the assistant turn is constrained to "narrate a little, emit blocks, stop". Tool-based agents like ACA have a legitimate "text only" turn (the final summary), which is what the model exploits when it emits "Let me now do X" and stops. **The ambiguity is the bug.** ACA's prompt must close the ambiguity by telling the model explicitly when text-only is legal (only after all work is done).

2. **Format-pressure repetition works.** `ONLY EVER RETURN CODE IN A *SEARCH/REPLACE BLOCK*!` three times in three positions. If ACA can identify an equivalent single-sentence rule and drill it in similarly, the effect should be similar.

3. **Reminder welding is an escape hatch.** For models that drift or under-attend to the system prompt, Aider welds the most important rules onto the user message. ACA's `prompt-assembly.ts` could implement the same pattern: attach a short "critical reminders" block to the user's task envelope itself in invoke mode.

---

## Transferable patterns

| Pattern | Applicability | Adaptation |
|---|---|---|
| **Triple repetition of critical rules** | Direct | Pick ACA's single most load-bearing rule. Repeat in 3 positions. |
| **Few-shot examples showing allowed narration shape** | Direct | Aider shows the exact preamble ("To make this change we need to modify X to: 1. 2. 3. Here are the blocks:"). ACA should show the equivalent for tool calls. |
| **Reminder welding to user message** | Direct | `src/core/prompt-assembly.ts` can append a short reminder block to the task envelope when `isSubAgent=true`. |
| **`lazy_prompt` per-model opt-in** | Direct | ACA can flag some models (Kimi? Qwen?) as lazy and inject a stronger "keep going" block only for them. |
| **Synthetic assistant acks** | Indirect | ACA could inject a prior synthetic assistant turn committing to behavior. Riskier — may confuse some models. Deferred. |
| **Architect/editor split** | Indirect | Conceptually maps to Claude-plans / ACA-executes (the M9/M10 delegation pattern). Not a new pattern — ACA already has the split structurally. |
| **Parser-level stall recovery** | Indirect | Aider's `"I didn't see any properly formatted edits..."` has no direct equivalent in tool-based agents. Anthropic's `"Please continue"` (see anthropic.md) is the closest analog and transfers directly. |

## Patterns that do NOT transfer

| Pattern | Why not |
|---|---|
| **Format-as-interface (SEARCH/REPLACE, UDiff, V4A)** | ACA uses native tool schemas. Not applicable. |
| **Architect with empty `system_reminder`** | ACA's architect is Claude in the outer loop, not an ACA component. Already handled architecturally. |
| **`files_no_full_files_with_repo_map` protocol** | Aider's "tell me which files I should add, then stop" protocol assumes a human will add files. ACA has `search_semantic` and direct file system access — different interaction model. |

---

## Full source references

All under `https://raw.githubusercontent.com/Aider-AI/aider/main/`:

- `aider/coders/base_prompts.py`
- `aider/coders/editblock_prompts.py`
- `aider/coders/udiff_prompts.py`
- `aider/coders/wholefile_prompts.py`
- `aider/coders/patch_prompts.py`
- `aider/coders/architect_prompts.py`
- `aider/coders/editor_editblock_prompts.py`
- `aider/coders/editor_whole_prompts.py`
- `aider/coders/base_coder.py` (lines ~1174-1331 for assembly logic)
- `aider/models.py` (lines ~118-135 for reminder/lazy defaults)

**Not fetched:** Aider blog posts explaining the SEARCH/REPLACE vs unified diff rationale are public but not in the source tree. Aider's test files assert on parser correctness, not prompt content.
