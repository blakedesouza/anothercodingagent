# Turn-Engine Message History Audit

**Date:** 2026-04-06
**Purpose:** Verify whether ACA's `turn-engine.ts` has the specific bug Anthropic flags in [handling-stop-reasons § "Empty responses with end_turn"](https://platform.claude.com/docs/en/api/handling-stop-reasons): text blocks adjacent to tool_result content in the same user message. If present, that's an independent cause of the M10.2 stall, separate from the system prompt.

## Method

Read the full `assembleMessages` method in `src/core/turn-engine.ts:774-853`. Trace how tool_result items become provider messages. Compare against Anthropic's documented failure mode.

## Key findings

### Finding 1: ACA uses the OpenAI tool-result convention, not the Anthropic convention

From `turn-engine.ts:831-842`:

```typescript
} else if (item.kind === 'tool_result') {
    const toolData = this.scrubber ? this.scrubber.scrub(item.output.data) : item.output.data;
    messages.push({
        role: 'tool',                        // ← separate message with role=tool
        content: JSON.stringify({
            status: item.output.status,
            data: toolData,
            error: item.output.error,
        }),
        toolCallId: item.toolCallId,
    });
}
```

**Each tool result is a separate message with `role: 'tool'`**, one per tool call. This is the OpenAI function-calling convention.

Anthropic's "empty end_turn" bug is specifically about the ANTHROPIC API format, where tool results are `tool_result` content blocks inside a `role: 'user'` message — and the bug fires when that user message *also contains text blocks alongside the tool_result blocks*. **ACA's OpenAI format is structurally immune** to that specific bug because tool results don't share a message with anything else.

**Verdict:** Anthropic's fix #1 ("never add text blocks immediately after tool results") does not apply to the Kimi/Qwen stall on the NanoGPT path. The structural bug doesn't exist there.

**Caveat:** The `AnthropicDriver` converts from this normalized format back into Claude's native `role: 'user'` + `tool_result` blocks format. If that conversion is not careful, the bug could be reintroduced specifically for the Anthropic driver path. Not audited in this pass. Out of M10.2 scope but worth a dedicated look when ACA runs against Claude directly.

### Finding 2: Assistant messages with tool calls CAN include text, but in the observed failure no text was present

From `turn-engine.ts:811-829`:

```typescript
if (toolParts.length > 0) {
    // Assistant message with tool calls → use content parts format
    const contentParts = [];
    for (const tp of textParts) {
        contentParts.push({ type: 'text' as const, text: tp.text });
    }
    for (const tc of toolParts) {
        contentParts.push({ type: 'tool_call' as const, ... });
    }
    messages.push({ role: 'assistant', content: contentParts });
}
```

When the assistant emits both text and tool calls, they're grouped into one assistant message with content parts — correct behavior.

**Checked against the M10.2 Kimi session log** (`~/.aca/sessions/ses_01KNGPGQH4QJK5DX542PZN4ZCP/conversation.jsonl`): Step 1's assistant message had 5 `tool_call` parts and zero text parts. So even in the bug case, no text was adjacent to the tool calls. The assistant message was clean.

### Finding 3: No recovery for empty-end_turn / assistant_final-with-no-tool-calls

Searched `turn-engine.ts` for any retry or continuation logic around turn termination. **There is no recovery when a turn ends with text-only + no tool calls + `finishReason=stop`.** The TurnEngine trusts the model's declaration of completion via `outcome=assistant_final`.

This matches Anthropic's second diagnosed cause verbatim: *"Sending Claude's completed response back without adding anything (Claude already decided it's done, so it will remain done)."* ACA doesn't send the completed response back — it just stops. Either way, the model's "I'm done" declaration is accepted at face value.

**This is a real gap.** The Anthropic-recommended last-resort recovery (append `{"role": "user", "content": "Please continue"}` and retry) could be implemented as automatic one-shot retry in `turn-engine.ts` when the turn ends with text + zero tool calls AND the tool call history doesn't show obvious completion (e.g., no `run tests and report` pattern completed).

**Deferred from M10.2:** this is TurnEngine work, separate from the system prompt rewrite. Flagging as a follow-up substep (M10.2b or similar). Implement after the prompt rewrite is validated — the prompt fix may be sufficient on its own, and adding recovery logic on top risks masking future regressions.

## Other observations

- **Tool result wrapper format:** ACA wraps every tool result in `{status, data, error}` before JSON-stringifying. Semantically fine, but unusual compared to bare provider-native formats. Low priority — not a bug.
- **Fallback default system prompt** at `turn-engine.ts:781-785`: used only when `systemMessages` is not passed (REPL path). That path gets the 7-word `'You are a helpful coding assistant.'` Separate from the invoke path (which we just fixed) but worth noting as a *second* thin-prompt problem for future hardening.

## Updated M10.2 fix priority

After the audit:

| Cause | Status | Coverage |
|---|---|---|
| Thin invoke system prompt (~15 lines) | **Primary** | Addressed by the new `buildInvokeSystemMessages` (~3-5K tokens) with persistence/tool_preambles/safety/tool_results/example blocks |
| Anthropic-style adjacent-text tool_result bug | Not applicable | ACA uses OpenAI format on NanoGPT path; bug does not exist here |
| No auto-retry on empty end_turn | **Secondary — deferred** | Real gap, but TurnEngine work. Flagged for a follow-up substep if the prompt rewrite alone is insufficient |
| Thin tool descriptions | **Unknown — not audited** | Anthropic's 3-4 sentence minimum rule should be checked against all 25 `tool.spec.description` strings in a separate pass |
| One-prompt-fits-all homogeneity | **Latent — architectural** | Cline proves 12-variant architecture is industry standard. Not urgent for M10.2; long-term direction |

## Recommendation for next M10.2 retry

1. Ensure project `.aca/config.json` still points at `moonshotai/kimi-k2.5` (it does, verified current state).
2. Use the SAME `/model` slash command envelope from attempts #1 and #2 — this is the consistent benchmark.
3. Invoke via `aca_run` with the same `timeout_ms: 600000`, omitting `allowed_tools` (peer-level, per user feedback).
4. Watch the session log at `~/.aca/sessions/<id>/conversation.jsonl` for:
   - **Sane first batch:** ≤5 read_file calls, no destructive ops, no `ask_user`, no empty edits
   - **Execution phase present:** Turn 2 or later contains `edit_file` or `write_file` calls — not a stall
   - **Verification phase:** Later turn contains `exec_command` running tests
   - **Final summary turn:** Text-only turn explaining what was done, ONLY after all changes land
5. If kimi succeeds, repeat with the default qwen to confirm cross-model coverage.
6. If kimi fails with a DIFFERENT pattern than before, report the new pattern — that's progress.
7. If kimi fails with the SAME terminal stall pattern, the next suspect is tool descriptions (Anthropic 3-4 sentence rule). Audit `src/tools/*/spec.ts` and retry.
