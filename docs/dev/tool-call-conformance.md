# Tool Call Conformance

ACA supports two tool-call transports:

- Native provider tool calls, where the driver sends `tools` and receives structured tool-call deltas.
- ACA emulation, where the driver injects tool schemas into the system prompt and parses text tool calls.

The conformance stack catches regressions in request shape, streaming aggregation, schema hygiene, history roundtrip, emulated pseudo-call parsing, and live model behavior.

## Local Gate

Run:

```bash
npm run test:tool-calls
```

This gate is deterministic and should pass without API keys.

It covers:

- Tool schema lint.
- NanoGPT native request shape.
- NanoGPT emulated request shape.
- Native assistant history with `content: null` and `tool_calls`.
- Emulated assistant history as text JSON.
- Native streamed argument aggregation.
- Duplicate stream indices with distinct tool IDs.
- Malformed arguments becoming tool validation errors.
- Emulated parser recovery for JSON, fenced JSON, DSML, XML invoke tags, and bracket pseudo-calls.
- Final-output validation for leaked pseudo-call text.

## Optional Live Probe

Run:

```bash
npm run probe:tool-calls -- --live --models zai-org/glm-5.1,moonshotai/kimi-k2.6,deepseek/deepseek-v4-pro
```

If `NANOGPT_API_KEY` is missing, live probing is skipped. Live artifacts are written under `/tmp` unless `--out` is provided.

The command exits non-zero when local checks fail, the raw native probe fails, or any live workflow case has `overallPass: false` in `results.json`.

Live failures are not automatically code bugs. First classify whether:

- ACA sent the wrong request shape.
- ACA normalized raw provider output incorrectly.
- The model/provider returned malformed or low-quality behavior while ACA handled it correctly.
- The workflow failed after valid tool calls due model autonomy, timeout, or provider availability.

## Live Failure Classifications

`npm run probe:tool-calls -- --live` writes additive classification fields into live workflow case results:

- `server_error_before_mutation`: provider/server failure before any file changes.
- `server_error_after_mutation`: provider/server failure after file changes; inspect diff before rerun.
- `post_mutation_malformed_salvage_candidate`: tests passed and files changed, but final LLM response malformed.
- `malformed_after_tool_results`: malformed response after accepted tool calls, without a verified patch.
- `contradictory_final_after_mutation`: final text claims failure despite successful mutation evidence.
- `unknown_workflow_failure`: not enough evidence for a known bucket.

`salvageCandidate: true` means the artifact may contain a useful patch or completed output even when the invoke result failed.

For non-interactive turns, retryable provider failures are retried within the active model before ACA falls back to the next model. Empty assistant responses are retried as `llm.malformed`. Live probes remain opt-in because retries can spend provider quota and make slow transient failures slower.

## Failure Classes

- `schema_hygiene`: tool schema is hard for models or strict providers to call.
- `native_request_shape`: native request omitted `tools`, used wrong `tool_choice`, or malformed history.
- `emulated_request_shape`: emulation leaked native `tools` or failed to inject schema prompt.
- `native_stream_parse`: streamed arguments, IDs, or parallel calls accumulated incorrectly.
- `emulated_parse`: pseudo-call text was not recovered.
- `history_roundtrip`: prior assistant call/result history cannot be replayed.
- `final_validation`: final answer leaked raw tool syntax or unresolved tool intent.
- `live_model_behavior`: local contract passed, but a live model behaved poorly.

## Strict Mode Policy

Do not enable strict mode globally without a live probe. OpenAI, Anthropic, DeepSeek, Gemini, and Mistral expose similar ideas with different schema subsets and mode names. ACA should first lint schemas for strict-readiness, then enable strict behavior per provider/model only when a live probe proves compatibility.

## Adding Parser Cases

Add a parser case only when all are true:

- The raw text is clearly intended as a tool call.
- The shape appears in live artifacts from a model ACA supports.
- The shape can be parsed without broad false positives in normal prose.
- A deterministic regression test is added before the parser change.

Prefer model-specific compatibility notes when the model simply chooses the wrong tool, omits needed work, or returns invalid arguments that should be fed back as a tool error.
