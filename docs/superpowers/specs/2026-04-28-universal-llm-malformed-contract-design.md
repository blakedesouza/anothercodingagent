# Universal LLM Malformed Contract Design

## Goal

Make ACA a reliable, model-agnostic agent harness for `llm.malformed` and adjacent provider failures. Every model should get the same feature support and the same contract checks. If a model still returns empty, invalid, or unusable output after ACA has proven its own request, history, parser, retry, repair, and completion-evidence paths, ACA should classify the result as provider/model nonconformance rather than leaving a vague `llm.malformed` mystery.

This design does not try to make every model equally reliable. It makes ACA's side of the protocol clear enough that model-specific failures are measured and explainable.

## Current Evidence

Recent local and live work already separated several failure classes:

- Raw native tool probes pass for GLM 5.1, Kimi K2.6, and DeepSeek V4 Pro.
- DeepSeek V4 Pro and GLM 5.1 pass the latest basic live workflow matrix.
- Kimi K2.6 still produces post-mutation `llm.malformed` cases: files are changed, tests pass, accepted tool calls are recorded, but the final assistant response is empty.
- The debug UI now exposes current sessions and relevant activity well enough to use it as the main investigation surface.

The remaining issue is not simply "tool calling is broken." It is that ACA needs a universal, evidence-backed boundary between:

- ACA request/history/parser/finalization bugs.
- Provider/model behavior after ACA sent a valid agent contract.
- Salvageable completions where the work is already proven even though final text failed.

## External Contract Context

Official docs support treating tool-using chat as a strict message/tool-result loop:

- NanoGPT exposes an OpenAI-compatible chat completion API, including streaming, reasoning fields, and reasoning controls such as `reasoning.exclude`, `reasoning.delta_field`, and `reasoning_content_compat`.
- Kimi documents `tools`/`tool_calls`, matching `tool_call_id` on tool-result messages, streamed argument accumulation, and the fact that `finish_reason=tool_calls` may include descriptive content before tool calls.
- DeepSeek documents OpenAI-compatible function calling and strict-mode schema constraints, including `additionalProperties: false` and all object properties being required in strict mode.
- Z.AI documents GLM 5.1 as supporting streaming, reasoning content, function calls, and long-horizon agentic coding workflows.

Sources:

- NanoGPT Chat Completion: https://docs.nano-gpt.com/api-reference/endpoint/chat-completion
- Kimi Tool Calls: https://platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls
- DeepSeek Function Calling: https://api-docs.deepseek.com/guides/function_calling/
- Z.AI GLM 5.1: https://docs.z.ai/guides/llm/glm-5.1
- Z.AI Function Calling: https://docs.z.ai/guides/capabilities/function-calling

## Principles

ACA is a contract judge, not a vibes-based model judge.

ACA owns:

- Valid provider request shape.
- Valid tool schema shape.
- Valid assistant tool-call and tool-result history replay.
- Correct streamed text/tool-call accumulation.
- Correct separation of reasoning/internal text from visible assistant output.
- Bounded retry and finalization repair.
- Evidence-based salvage when work is complete.
- Debug artifacts that explain the classification.

The provider/model owns:

- Empty visible output after a valid request and bounded retry.
- Invalid tool arguments after schema guidance and repair.
- Ignoring valid tool results.
- Useless loops after bounded corrective prompts.
- Malformed or contradictory streaming chunks after ACA sent a valid request.

No user-facing view should show raw `llm.malformed` alone. It must be wrapped in an evidence-backed classification.

## Classification Model

Low-level error codes remain useful for storage and compatibility. Higher-level classifications drive reports and UI.

Top-level classifications:

- `salvaged_success`: ACA proved the required work completed, final text failed, and the result can safely be returned as success with a generated factual summary.
- `provider_model_nonconformance`: ACA's request, history, parser, retry, repair, and evidence checks passed, but the model/provider still returned empty, invalid, or unusable output.
- `aca_contract_failure`: ACA sent an invalid request, invalid tool schema, invalid history, mismatched tool result, or otherwise violated the model contract.
- `aca_parser_gap`: provider output contained recoverable information that ACA failed to parse or normalize.
- `aca_final_validation_gap`: ACA accepted a bad final or rejected a good final due to incomplete validation logic.
- `unknown_needs_artifact`: evidence is insufficient; keep the raw low-level error but require artifact capture before claiming provider fault.

Diagnostic sub-buckets:

- `provider_empty_final`
- `provider_invalid_tool_args`
- `provider_ignored_tool_result`
- `provider_stream_malformed`
- `history_tool_result_mismatch`
- `native_request_shape_invalid`
- `emulated_request_shape_invalid`
- `reasoning_leaked_as_visible_output`
- `post_mutation_empty_final`
- `post_required_output_empty_final`

## Harness Design

Add a malformed-focused reproducibility harness, likely `npm run probe:malformed`, separate from the existing broad tool-call conformance probe.

Inputs:

- Model list.
- Suite name.
- Optional provider/profile overrides.
- Output directory.

Suites:

- `basic-coding`: small deterministic edit/test tasks.
- `post-mutation-finalization`: tasks designed to finish work, then force a final answer after tool results.
- `history-replay`: tool-call/result replay and resume-shaped history.
- `streaming-shape`: streamed native tool arguments, text before tool calls, duplicate indexes, reasoning fields.
- `no-tools`: conversational and consultation-style turns that should hide tools or use no tools.

Per-case artifacts:

- Redacted request summary.
- Tool schema summary and lint result.
- Serialized message-history shape summary.
- Stream event summary.
- Accepted and rejected tool-call counts.
- Retry and repair attempts.
- Output validation result.
- Diff/test/required-output evidence.
- Final low-level errors.
- Top-level classification and diagnostic sub-bucket.

The harness should make it cheap to answer:

- Did ACA send the right shape?
- Did the model return a native call, text, reasoning, invalid JSON, or nothing?
- Did ACA preserve the tool-call IDs and tool-result mapping?
- Did work complete despite the final response failing?
- Did retry or repair change the outcome?

## Runtime Design

### Request And History Self-Checks

Before blaming a model, ACA should be able to validate its own outgoing contract:

- Native requests include `tools`, `tool_choice: "auto"`, matching assistant `tool_calls`, and matching `tool` messages.
- Emulated requests strip native `tools`, use `tool_choice: "none"`, and inject the emulation schema.
- Tool-result messages never reference unknown assistant tool-call IDs.
- Assistant messages with native tool calls serialize in provider-compatible form.
- Reasoning fields are captured or ignored according to model/provider settings without contaminating visible output.

These checks should run in deterministic tests and be optionally emitted into live artifacts. They do not need to block every runtime request unless the invalid shape is locally detectable and unsafe.

### Retry And Repair

The retry path should stay bounded:

- Provider errors use existing retry policy aliases.
- Empty assistant responses get an explicit recovery prompt.
- Failed retry-attempt text cannot leak into user-visible output or persisted successful history.
- Fallback happens only after retry exhaustion when configured.
- Interactive mode only retries before visible text has streamed.

Finalization repair:

- If final output is empty, pseudo-tool text, unresolved tool intent, or contradictory after proven work, run a final-result repair turn.
- Repair prompts must ask for either real next tool calls or a brief factual final answer.
- Repair should use the same universal rules for all models.

### Salvaged Success

If a coding task changed files and validation tests pass, or required output paths exist and are non-empty, ACA may return `salvaged_success` after finalization failure.

Rules:

- Strong evidence required: tests pass, changed tests are not the only change, or required output paths are satisfied.
- The generated summary must be factual and derived from diff/test evidence, not invented model prose.
- The low-level `llm.malformed` remains attached for observability.
- The result must say it was salvaged in machine-readable metadata.

This prevents "model returned empty final after completing the work" from becoming a user-visible hard failure.

### Provider/Model Nonconformance

If there is no completion evidence, or if tool arguments/history remain invalid after bounded repair, ACA returns `provider_model_nonconformance` with low-level error details and artifact pointers.

This classification requires:

- Request self-check passed or no invalid request evidence exists.
- History/tool-result self-check passed.
- Parser did not leave known recoverable output unparsed.
- Retry/repair budget was spent when eligible.
- No safe salvage evidence exists.

## Debug UI Design

The debug UI should use classifications as first-class labels.

Relevant Activity:

- Prioritize `aca_contract_failure` and `aca_parser_gap`.
- Show `salvaged_success` as healthy but annotated.
- Group repeated `provider_model_nonconformance` rows behind a model/provider filter when they are historical.

Session detail:

- Add a "Contract" or "Blame" panel with pass/fail rows:
  - Request shape.
  - Tool schema.
  - History replay.
  - Parser/normalizer.
  - Retry/repair.
  - Completion evidence.
  - Final classification.
- Link to harness/live artifact path when present.
- Show raw `llm.malformed` only as the low-level code under the classification.

Consult/detail views:

- Use the same classification language for no-tools consultation failures.
- Distinguish model empty output from ACA malformed parsing.

## Data Model

Persisted events can stay backward compatible by adding optional fields:

- `classification`
- `diagnostic_bucket`
- `salvage_candidate`
- `salvaged`
- `artifact_path`
- `request_contract`
- `history_contract`
- `completion_evidence`
- `retry_attempts`
- `repair_attempts`

Older sessions without these fields should display as `unknown_needs_artifact` when no better classification can be derived.

## Model Support Policy

Every model receives the same feature support:

- Native tools when the provider/model supports them.
- Emulated tools when native support is unavailable or disabled.
- No-tools mode when the task does not need tools.
- Universal retry/repair/salvage behavior.
- Universal classification and debug artifacts.

Models may still differ by confidence tier:

- `preferred`: passes current harness for target workflows.
- `supported`: works but may need retry or salvage.
- `degraded`: usable with visible warning; repeated provider/model nonconformance.
- `blocked`: known invalid contract behavior that ACA cannot safely recover.

These tiers describe observed conformance, not feature entitlement.

## Testing Strategy

Deterministic tests:

- Request-shape self-check tests for native and emulated modes.
- History/tool-result matching tests.
- Parser-gap tests with known pseudo-call, streamed-argument, reasoning-field, and empty-final cases.
- Retry tests proving no failed-attempt text leaks.
- Salvaged-success tests for post-mutation empty final and required-output empty final.
- Classification tests for every top-level bucket.
- Debug UI tests for label, grouping, and artifact-link rendering.

Live probes:

- Keep live probes opt-in.
- Run a small matrix across GLM, Kimi, DeepSeek, and any additional user-selected models.
- Store JSON artifacts under `/tmp` by default.
- Do not make `npm run verify` depend on live providers.

## Success Criteria

- A post-mutation empty final becomes either repaired final text or `salvaged_success`.
- A true malformed model/provider response becomes `provider_model_nonconformance` only after ACA evidence passes.
- Any ACA-side request/history/parser bug is classified as an ACA failure, not blamed on the model.
- Debug UI never presents raw `llm.malformed` without a higher-level classification.
- Live artifacts are sufficient to reproduce or defend the classification.
- Existing local verification remains deterministic.

## Out Of Scope

- Guaranteeing equal pass rates for every model.
- Migrating providers to a new API family.
- Enabling strict schema mode by default for all providers.
- Adding unlimited retries.
- Accepting incomplete work as success.
- Treating weak or ambiguous evidence as model fault.

## Spec Self-Review

- Placeholder scan: no placeholders remain.
- Internal consistency: universal feature support is separate from model confidence tiers.
- Scope check: one implementation plan can cover harness, runtime classification, salvage, and UI labels.
- Ambiguity check: provider/model fault requires evidence; raw `llm.malformed` alone is never enough.
