# Native Tool Calls

This note captures ACA's current native tool-call contract for OpenAI-compatible
providers, especially NanoGPT-routed models that have been live-probed.

## Sources Checked

- DeepSeek API docs say the API is OpenAI/Anthropic compatible and list
  `deepseek-v4-pro` and `deepseek-v4-flash` as chat models.
- DeepSeek tool-call docs show the standard loop: send `tools`, receive
  `message.tool_calls`, execute the tool locally, append the assistant message,
  then append a `role: "tool"` message with the matching `tool_call_id`.
- DeepSeek V4 pricing/docs list tool calls as supported for both V4 Pro and
  V4 Flash.
- OpenAI docs describe the same invariant: each tool output must be matched to
  the tool call ID produced by the assistant.

References:

- https://api-docs.deepseek.com/
- https://api-docs.deepseek.com/guides/tool_calls
- https://api-docs.deepseek.com/guides/thinking_mode
- https://api-docs.deepseek.com/quick_start/pricing
- https://api-docs.deepseek.com/api/create-chat-completion
- https://developers.openai.com/api/docs/assistants/tools/function-calling

## ACA Runtime Contract

- Prefer native OpenAI-compatible tools when the selected NanoGPT model advertises
  native tool support.
- Use `tool_choice: "auto"` for NanoGPT native runs. Do not rely on
  `tool_choice: "required"` across routed models.
- Send tool definitions as `tools: [{ type: "function", function: ... }]`.
- Preserve assistant tool-call history as an assistant message with
  `content: null` and a `tool_calls` array.
- Send tool results as `role: "tool"`, `tool_call_id: <assistant tool call id>`,
  and string `content`.
- If a streamed or non-streamed assistant message contains native `tool_calls`,
  ignore simultaneous text content for turn history. DeepSeek V4 Flash can emit
  DSML marker text such as `<|DSML|tool_calls` before the native call.
- Keep ACA's pseudo-call parser active during native NanoGPT runs. Some routed
  models can still fall back to textual pseudo calls.
- Treat blank final responses, pseudo-call final text, and unresolved tool-use
  intent as retryable output validation failures.
- Treat diagnosis-only coding finals as incomplete when edit/write tools are
  available and no filesystem mutation occurred. Route those repair turns through
  the mutation-capable tools first so weaker models do not keep diagnosing.
- Normalize DeepSeek-style `edit_file` edit objects from both native and emulated
  tool calls. Flash may emit `oldText`/`newText` beside, or instead of,
  ACA's `search`/`replace`; strip the extra fields before tool validation.
- Fall back to prompt-level emulation only when the model is not native-capable.

## Probe Command

Run the raw provider probe:

```bash
node --import tsx scripts/native-tool-probe.ts \
  --models deepseek/deepseek-v4-pro,deepseek/deepseek-v4-flash \
  --out /tmp/aca-native-tool-probe-deepseek-v4.json
```

It checks:

- non-stream `tool_choice: "auto"`
- stream `tool_choice: "auto"`
- non-stream `tool_choice: "required"`
- parallel native tool calls
- post-tool continuation with `content: null` assistant history

## 2026-04-25 Probe Result

Output: `/tmp/aca-native-tool-probe-deepseek-v4-20260425.json`

DeepSeek V4 Pro:

- `auto` non-stream: clean native `tool_calls`
- `auto` stream: clean native `delta.tool_calls`
- post-tool continuation: clean final text
- `required`: native `tool_calls`
- parallel: two native `lookup_fact` calls
- full ACA workflow bakeoff: 9/9 pass, 83 accepted tool calls, 0 rejected

DeepSeek V4 Flash:

- `auto` non-stream: native `tool_calls` plus DSML text prefix
- `auto` stream: native `delta.tool_calls` plus DSML text prefix
- post-tool continuation: clean final text on the simple probe
- `required`: blank response in this probe
- parallel: two native calls plus DSML text prefix
- after DSML pseudo-call parsing, coding-completion repair ordering, and native
  argument normalization: basic ACA workflow bakeoff passed 3/3, with 43
  accepted tool calls and 0 rejected
  (`/tmp/aca-deepseek-v4-flash-normalized-basic-20260425`)
- targeted rerun of the hard resume-registry case passed after native
  normalization (`/tmp/aca-flash-registry-debug-Ggn8qd`)

## Current Interpretation

V4 Pro is conformant enough for native/hybrid ACA tool use. V4 Flash supports the
native transport but is weaker as an autonomous coding worker: it may diagnose
without editing, emit DSML pseudo-call wrappers, or return malformed/blank output
when the gateway rejects malformed native calls. The driver should not disable
native tools for Flash solely because of DSML marker text; it should ignore marker
text when real native tool calls are present, parse DSML pseudo-call fallback text
when present, normalize known argument-shape drift, and rely on workflow
validation to catch incomplete work.

## 2026-04-25 Qwen / GLM / Kimi Probe

Output: `/tmp/aca-native-tool-probe-qwen-glm-kimi-20260425.json`

- `qwen/qwen3-coder-next`: native calls worked for auto, streaming, required,
  parallel, and post-tool continuation in the raw probe. ACA basic workflow rerun
  was only 2/3 (`/tmp/aca-native-tools-qwen-basic-rerun-20260425`): one
  `llm.malformed` failure and poor final text on two passing cases.
- `zai-org/glm-5`: native calls worked for auto, streaming, required, and
  continuation. Parallel probe emitted one native tool call for a two-call
  request, so do not assume reliable parallel compliance. ACA basic passed 3/3;
  full workflow passed 8/9 with one `llm.malformed` hard-case failure
  (`/tmp/aca-native-tools-glm-kimi-all-20260425`).
- `moonshotai/kimi-k2.5`: native calls worked for auto, streaming, required,
  parallel, and continuation. Full ACA workflow passed 9/9 with 90 accepted tool
  calls and 0 rejected (`/tmp/aca-native-tools-glm-kimi-all-20260425`).

## 2026-04-25 GLM 5.1 / Kimi 2.6 / Qwen 3.5 Probe

Outputs:

- `/tmp/aca-native-tool-probe-glm51-kimi26-qwen35-20260425.json`
- `/tmp/aca-native-tools-glm51-kimi26-qwen35-basic-20260425`
- `/tmp/aca-native-tools-glm51-kimi26-all-20260425`

Results:

- `zai-org/glm-5.1`: raw native probe passed auto, streaming, required,
  parallel, and continuation. ACA basic passed 3/3; full workflow passed 9/9
  with 115 accepted tool calls and 0 rejected.
- `moonshotai/kimi-k2.6`: raw native probe showed imperfect `auto` behavior
  (non-stream auto answered in text; stream auto mixed text with a native tool
  call), but required and parallel native calls worked. ACA basic passed 3/3;
  full workflow passed 9/9 with 103 accepted tool calls and 0 rejected.
- `qwen/qwen3.5-397b-a17b`: raw native probe passed auto, streaming, required,
  parallel, and continuation. ACA basic workflow passed only 1/3: failures were
  a timeout/parse failure on `optional-capability-fix` and an `llm.server_error`
  on `resume-handle-fix`, even though validation tests passed after its patches.

## 2026-04-25 Stress Suite

Added `--suite stress` to `scripts/live-workflow-bakeoff.ts` with six harder
fixtures:

- persisted task-state counter roundtrip after resume
- native tool-event persistence and history rebuild
- derived transcript handling for native tool calls plus stray prose
- atomic JSON disk save with temp/rename/cleanup requirements
- project file walking with ignored directories and symlink avoidance
- content-addressed blob storage with safe id validation

Output: `/tmp/aca-native-tools-glm51-kimi26-dsv4pro-stress-20260425`

Results:

- `zai-org/glm-5.1`: 6/6, 64 accepted tool calls, 0 rejected
- `moonshotai/kimi-k2.6`: 6/6, 64 accepted tool calls, 0 rejected
- `deepseek/deepseek-v4-pro`: 6/6, 41 accepted tool calls, 0 rejected

## 2026-04-25 Native-Preferred Impact Smokes

Outputs:

- `/tmp/aca-native-impact-delegation-20260425`
- `/tmp/aca-native-impact-rp-researcher-20260425`

Results:

- Recursive delegation through `spawn_agent` / `await_agent`: `zai-org/glm-5.1`,
  `moonshotai/kimi-k2.6`, and `deepseek/deepseek-v4-pro` each passed. Each run
  delegated to a child coder agent, awaited completion, and verified the required
  output file. All had 0 rejected tool calls.
- `rp-researcher` profile with local source/style files and required output:
  `zai-org/glm-5.1`, `moonshotai/kimi-k2.6`, and `deepseek/deepseek-v4-pro`
  each passed. Each read local notes/style files and wrote the required
  RP-facing character Markdown file. All had 0 rejected tool calls.
