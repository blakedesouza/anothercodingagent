# ACA Live Validation

This file records bounded real-provider validation runs for the audit.

Rules:

- prefer the built artifact (`node dist/index.js`) unless the milestone specifically targets dev/runtime loader behavior
- use the real NanoGPT path when the audit claim concerns runtime functionality, not only local helpers
- keep scenarios bounded and explicit
- record session directories or artifact paths when a scenario writes durable state

## Scenario Template

- Scenario ID:
- Milestone:
- Goal:
- Command shape:
- Workspace / HOME isolation:
- Expected result:
- Actual result:
- Evidence:
- Status:

## M0-M2 Live Scenario Bank

- `M0-LIVE-1`: built CLI reaches the real NanoGPT provider path
- `M1-LIVE-1`: one-shot writes manifest and conversation log through the real provider path
- `M1-LIVE-2`: `aca invoke` returns a structured success response through the real provider path
- `M2-LIVE-1`: real `read_file` execution
- `M2-LIVE-2`: real `write_file` execution
- `M2-LIVE-3`: real `exec_command` execution
- `M2-LIVE-4`: real sandbox denial
- `M2-LIVE-5`: real approved-only shell-network confirmation path
- `M2-LIVE-6`: `--no-confirm` does not bypass approved-only shell-network confirmation

## Recorded Runs

- Scenario ID: `M0-LIVE-1`
- Milestone: `M0`
- Goal: prove the built CLI reaches the real NanoGPT provider path
- Command shape: `node dist/index.js "Reply with exactly ACA_LIVE_M0_OK and nothing else."`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: exact assistant text `ACA_LIVE_M0_OK`
- Actual result: returned `ACA_LIVE_M0_OK`
- Evidence: session dir `/tmp/aca-live-home-QzTTor/.aca/sessions/ses_01KNQCV2TPSTX7NJ6HTYZ8QCM9`
- Status: `passed`

- Scenario ID: `M1-LIVE-1`
- Milestone: `M1`
- Goal: prove one-shot writes manifest and conversation log through the real provider path
- Command shape: `node dist/index.js "Reply with exactly ACA_LIVE_M1_ONE_SHOT and nothing else."`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: exact assistant text plus persisted session artifacts
- Actual result: returned `ACA_LIVE_M1_ONE_SHOT`; manifest and conversation log persisted
- Evidence: session dir `/tmp/aca-live-home-QzTTor/.aca/sessions/ses_01KNQCVNBCHN382Q0GAN54VQXC`
- Status: `passed`

- Scenario ID: `M1-LIVE-2`
- Milestone: `M1`
- Goal: prove `aca invoke` returns a structured success response through the real provider path
- Command shape: `node dist/index.js invoke < /tmp/aca-live-home-QzTTor/m1-invoke-request.json`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: JSON success response with non-empty `result`
- Actual result: returned JSON success with `result: "ACA_LIVE_M1_INVOKE_OK"`
- Evidence: request file `/tmp/aca-live-home-QzTTor/m1-invoke-request.json`
- Status: `passed`

- Scenario ID: `M2-LIVE-1`
- Milestone: `M2`
- Goal: prove real `read_file` execution against the live provider path
- Command shape: built CLI one-shot with `--no-confirm` and a prompt requiring `read_file sample.txt`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: tool execution plus final text `live read sample`
- Actual result: `read_file` executed and returned `live read sample`
- Evidence: temp workspace file `/tmp/aca-live-ws-AiVfT5/sample.txt`
- Status: `passed`

- Scenario ID: `M2-LIVE-2`
- Milestone: `M2`
- Goal: prove real `write_file` execution against the live provider path
- Command shape: built CLI one-shot with `--no-confirm` and a prompt requiring exact content `ACA_LIVE_WRITE_OK`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: file written with exact content
- Actual result: `write_file` executed and `/tmp/aca-live-ws-AiVfT5/live-write.txt` contained `ACA_LIVE_WRITE_OK`
- Evidence: output file `/tmp/aca-live-ws-AiVfT5/live-write.txt`
- Status: `passed`

- Scenario ID: `M2-LIVE-3`
- Milestone: `M2`
- Goal: prove real `exec_command` execution against the live provider path
- Command shape: built CLI one-shot with `--no-confirm` and a prompt requiring `exec_command` `echo ACA_LIVE_EXEC_OK`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: tool execution plus final text confirming `ACA_LIVE_EXEC_OK`
- Actual result: `exec_command` executed and final text confirmed `ACA_LIVE_EXEC_OK`
- Evidence: terminal output from the live run
- Status: `passed`

- Scenario ID: `M2-LIVE-4`
- Milestone: `M2`
- Goal: prove sandbox denial on out-of-workspace file write
- Command shape: built CLI one-shot with `--no-confirm` and a prompt requiring `write_file /root/aca-live-m0m2-test.txt`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: tool failure and no file created
- Actual result: `write_file` failed and `/root/aca-live-m0m2-test.txt` remained absent
- Evidence: absence check returned `MISSING`
- Status: `passed`

- Scenario ID: `M2-LIVE-5`
- Milestone: `M2`
- Goal: prove the approved-only shell-network path reaches explicit confirmation
- Command shape: built CLI one-shot requiring `exec_command` `curl -I -s https://example.com`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: confirmation prompt before execution
- Actual result: reached `exec_command requires confirmation` with `Network policy: network command requires approval (mode: approved-only)` before the run was intentionally interrupted
- Evidence: interactive PTY output from the interrupted run
- Status: `observed`

- Scenario ID: `M2-LIVE-6`
- Milestone: `M2`
- Goal: prove `--no-confirm` does not bypass approved-only shell-network confirmation
- Command shape: same as `M2-LIVE-5`, but with `--no-confirm`
- Workspace / HOME isolation: isolated temp HOME `/tmp/aca-m2-live6-home-7RVMXy` and isolated temp workspace `/tmp/aca-m2-live6-ws-yeBLEf`
- Expected result: the shell-network command should not execute; `--no-confirm` should still fail safe because approved-only network confirmation escalates beyond normal auto-confirm
- Actual result: the built one-shot runtime attempted `exec_command("curl -I -s https://example.com")`, recorded a `tool.permission` error with `Requires confirmation but no interactive prompt available: network command requires confirmation (--no-confirm cannot override)`, then finalized with exact assistant text `ACA_M2_LIVE6_BLOCKED`
- Evidence:
  - stdout capture `/tmp/aca-m2-live6-stdout-5vw4jC`
  - stderr capture `/tmp/aca-m2-live6-stderr-kDG0pC`
  - session dir `/tmp/aca-m2-live6-home-7RVMXy/.aca/sessions/ses_01KNQYMSPMQ7XKBC809F2W9GV3`
  - manifest `/tmp/aca-m2-live6-home-7RVMXy/.aca/sessions/ses_01KNQYMSPMQ7XKBC809F2W9GV3/manifest.json`
  - conversation log `/tmp/aca-m2-live6-home-7RVMXy/.aca/sessions/ses_01KNQYMSPMQ7XKBC809F2W9GV3/conversation.jsonl`
- Status: `passed`

## Specialist Model Resilience

- Scenario ID: `MODEL-FALLBACK-LIVE-1`
- Milestone: `post-M2 runtime hardening`
- Goal: prove `rp-researcher` does not brick when the user-level default model is pinned to a removed NanoGPT model
- Command shape: `node dist/index.js invoke` with `context.profile: "rp-researcher"`, no explicit `context.model`, temp HOME config pinned to `zai-org/glm-5.1`
- Workspace / HOME isolation: isolated temp HOME and isolated temp workspace with a minimal `package.json`
- Expected result: successful invoke response and an ephemeral session manifest showing a fallback model instead of `zai-org/glm-5.1`
- Actual result: returned success with result `aca-rp-fallback-live`; manifest recorded `model: "zai-org/glm-5"`
- Evidence:
  - session dir `/tmp/aca-rp-fallback-home-4XGOi1/.aca/sessions/ses_01KNQDV5E047WRY296G89BNVSS`
  - temp workspace `/tmp/aca-rp-fallback-ws-XXXXXX/package.json` during the live run
- Status: `passed`

## M3 Invoke Runtime Validation

- Scenario ID: `M3-LIVE-1`
- Milestone: `M3`
- Goal: prove real `aca invoke` now persists per-turn manifest state in executor mode instead of leaving `turnCount` at `0`
- Command shape: `node dist/index.js invoke` with a bounded exact-text task and explicit `context.model: "zai-org/glm-5"`
- Workspace / HOME isolation: isolated temp HOME and isolated temp workspace
- Expected result: invoke success plus ephemeral manifest `turnCount: 1`
- Actual result: invoke returned `ACA_M3_INVOKE_TURNCOUNT`; ephemeral manifest recorded `turnCount: 1`
- Evidence:
  - session dir `/tmp/aca-m3-live-home-Oetx7I/.aca/sessions/ses_01KNQFQ6FM1NWMSBHNT5Z1RKQR`
- Status: `passed`

- Scenario ID: `M3-LIVE-2`
- Milestone: `M3`
- Goal: prove real `aca invoke` now persists file-activity state after a write turn in executor mode
- Command shape: `node dist/index.js invoke` with explicit `context.cwd`, `allowed_tools: ["write_file"]`, and `required_output_paths: ["live-m3.txt"]`
- Workspace / HOME isolation: isolated temp HOME and isolated temp workspace
- Expected result: invoke success, output file written in the isolated workspace, ephemeral manifest with non-null `fileActivityIndex`
- Actual result: invoke returned `WROTE`; `/tmp/aca-m3-live-ws-LvTGJq/live-m3.txt` contained `ACA_M3_WRITE_STATE\n`; manifest recorded `turnCount: 1` and non-null `fileActivityIndex`
- Evidence:
  - session dir `/tmp/aca-m3-live-home-yVfQdv/.aca/sessions/ses_01KNQFRG6VQFSYV03HPTX4VEWV`
  - output file `/tmp/aca-m3-live-ws-LvTGJq/live-m3.txt`
- Status: `passed`

- Scenario ID: `M3-LIVE-3`
- Milestone: `M3`
- Goal: prove one-shot resume continuity on the real NanoGPT path
- Command shape: two built one-shot runs in the same isolated workspace, second run with `--resume`, both using `zai-org/glm-5`
- Workspace / HOME isolation: isolated temp HOME and isolated temp workspace
- Expected result: same session reused, both exact replies succeed, manifest `turnCount: 2`
- Actual result: both exact replies succeeded; the same session directory was reused; manifest recorded `turnCount: 2`
- Evidence:
  - session dir `/tmp/aca-m3-resume-home-sQPVgI/.aca/sessions/ses_01KNQFZV5X62TZJH9QGR7FF4RR`
- Status: `passed`

- Scenario ID: `M3-LIVE-4`
- Milestone: `M3`
- Goal: prove live summary creation under context pressure on the real NanoGPT path
- Command shape: eight resumed one-shot runs in the same isolated workspace using `Mistral-Nemo-12B-Instruct-2407`, each with a large filler prompt and exact bounded reply
- Workspace / HOME isolation: isolated temp HOME and isolated temp workspace
- Expected result: session reaches `turnCount: 8` and `conversation.jsonl` contains real `summary` records
- Actual result: all eight turns completed; manifest recorded `turnCount: 8`; `conversation.jsonl` contained `5` summary records
- Evidence:
  - session dir `/tmp/aca-m3-summary-home-kZQ2jK/.aca/sessions/ses_01KNQG25V5491DMEMYTDRHADZA`
- Status: `passed`

## M4 Rendering Validation

- Scenario ID: `M4-LIVE-1`
- Milestone: `M4`
- Goal: prove one-shot mode keeps the final assistant text on stdout while renderer/status output stays on stderr
- Command shape: `node dist/index.js --model zai-org/glm-5 "Reply with exactly ACA_M4_SPLIT_OK and nothing else."`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: stdout exactly `ACA_M4_SPLIT_OK`; stderr contains only ACA-rendered status output
- Actual result: stdout was exactly `ACA_M4_SPLIT_OK`; stderr contained a single ACA status line `[16:40:06] Thinking...`
- Evidence:
  - stdout capture `/tmp/aca-m4-live-stdout-CTcr9S`
  - stderr capture `/tmp/aca-m4-live-stderr-awUx1K`
  - session dir `/tmp/aca-m4-live-home-QzOMCe/.aca/sessions/ses_01KNQGKK2XTC0F7SFBVXHSCDDJ`
- Status: `passed`

- Scenario ID: `M4-LIVE-2`
- Milestone: `M4`
- Goal: prove one-shot mutation rendering still emits tool/progress output on stderr while the exact assistant result stays on stdout
- Command shape: `node dist/index.js --model zai-org/glm-5 --no-confirm "<bounded write_file task>"`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: stdout exactly `WROTE`; stderr shows ACA-rendered `write_file` status and create summary; output file contains exact content
- Actual result: stdout was exactly `WROTE`; stderr showed `▶ write_file`, `✓ write_file`, and `+ Created m4-live.txt (1 line)`; output file contained `ACA_M4_WRITE_OK`
- Evidence:
  - stdout capture `/tmp/aca-m4-live-stdout-0a4nR1`
  - stderr capture `/tmp/aca-m4-live-stderr-lAOUDp`
  - output file `/tmp/aca-m4-live-ws-jzYtop/m4-live.txt`
  - session dir `/tmp/aca-m4-live-home-Zb3A52/.aca/sessions/ses_01KNQGP4FX3JSKAFHKEE1JYBRQ`
- Status: `passed`

- Scenario ID: `M4-LIVE-3`
- Milestone: `M4`
- Goal: prove live REPL startup no longer leaks raw embedding/library warnings outside ACA's renderer
- Command shape: `script -qfec "node dist/index.js --model zai-org/glm-5" <transcript>` with an immediate `/exit`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: ACA header, prompt, and exit only; no raw `[EmbeddingModel] ...` warning line
- Actual result: transcript showed the ACA header, prompt, `/exit`, and `Goodbye.` with no raw embedding warning
- Evidence:
  - transcript `/tmp/aca-m4-repl-transcript-uTI7jX`
- Status: `passed`

## M5 Observability Validation

- Scenario ID: `M5-LIVE-1`
- Milestone: `M5`
- Goal: prove a real NanoGPT session lands in SQLite and `aca stats --session` can reconstruct the session detail from the built runtime
- Command shape: built one-shot on `qwen/qwen3-coder-next`, followed by `node dist/index.js stats --session <id> --json`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: exact one-shot reply plus JSON session detail with one turn, non-zero tokens, and non-zero cost
- Actual result: one-shot returned `ACA_M5_STATS_SEED`; `aca stats --session` returned one ended turn with `3400` input tokens, `7` output tokens, and `$0.0005205` total cost
- Evidence:
  - session dir `/tmp/aca-m5-live-home-TSBAAt/.aca/sessions/ses_01KNQH72YZ1P5H2PGJJDMEGVDV`
- Status: `passed`

- Scenario ID: `M5-LIVE-2`
- Milestone: `M5`
- Goal: prove resume-time JSONL→SQLite backfill is live after deleting `observability.db`
- Command shape: first built one-shot on `qwen/qwen3-coder-next`, then delete the temp `observability.db`, then run a built `--resume` one-shot, then query `aca stats --session <id> --json`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: the resumed session should still show both turns in `aca stats`, proving the first turn was backfilled from JSONL into the recreated SQLite database
- Actual result: first run returned `ACA_M5_BACKFILL_ONE`; resumed run returned `ACA_M5_BACKFILL_TWO`; `aca stats --session` showed two ended turns with combined tokens and cost
- Evidence:
  - session dir `/tmp/aca-m5-backfill-home-4HsFGp/.aca/sessions/ses_01KNQH7N878RADX1KDRKNVQJHV`
- Status: `passed`

- Scenario ID: `M5-LIVE-3`
- Milestone: `M5`
- Goal: prove startup retention is live in the built CLI and preserves the SQLite `pruned` marker
- Command shape: seed an isolated temp HOME with a 45-day-old session directory and matching SQLite session row, then run a built one-shot on `qwen/qwen3-coder-next`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: stale session directory removed during startup; SQLite row retained with `pruned = 1`
- Actual result: one-shot returned `ACA_M5_RETENTION_OK`; the stale session directory was removed; SQLite row became `{\"pruned\":1}`
- Evidence:
  - temp HOME `/tmp/aca-m5-retention-home-ILmync`
  - pruned session id `ses_OLDM500000000000000000001`
- Status: `passed`

## M6 Indexing Validation

- Scenario ID: `M6-LIVE-1`
- Milestone: `M6`
- Goal: prove a cold one-shot mutation turn updates the persistent semantic index without any prior `search_semantic` warm-up
- Command shape: built one-shot on `qwen/qwen3-coder-next` with `--no-confirm`, requiring `write_file src/sentinel.ts`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: exact reply `WROTE_SENTINEL`; persistent index DB contains `src/sentinel.ts`
- Actual result: one-shot returned `WROTE_SENTINEL`; index DB recorded `fileCount: 3` and `sentinelExists: true`
- Evidence:
  - temp HOME `/tmp/aca-m6-live-home-m903oS`
  - temp workspace `/tmp/aca-m6-live-ws-GyHE2i`
  - index DB `/tmp/aca-m6-live-home-m903oS/.aca/indexes/wrk_fe48cd6f2e527cf16b7f79981c41e0fed96ac2d53d39e60d8ee8f7ad1c6db14f/index.db`
- Status: `passed`

- Scenario ID: `M6-LIVE-2`
- Milestone: `M6`
- Goal: prove the one-shot mutation result is immediately searchable through the real NanoGPT `search_semantic` path
- Command shape: second built one-shot on the same isolated HOME/workspace, requiring `search_semantic` to find `sentinelAuthToken`
- Workspace / HOME isolation: reused isolated temp HOME and temp workspace from `M6-LIVE-1`
- Expected result: exact reply `SEARCHED_SENTINEL`
- Actual result: one-shot invoked `search_semantic` and returned `SEARCHED_SENTINEL`
- Evidence:
  - temp HOME `/tmp/aca-m6-live-home-m903oS`
  - temp workspace `/tmp/aca-m6-live-ws-GyHE2i`
- Status: `passed`

- Scenario ID: `M6-LIVE-3`
- Milestone: `M6`
- Goal: prove a cold `aca invoke` mutation turn updates the persistent semantic index without any prior `search_semantic` warm-up
- Command shape: built `aca invoke` on `qwen/qwen3-coder-next` with `allowed_tools: ["write_file"]`, requiring `write_file src/invoke-sentinel.ts`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: JSON success with result `WROTE_INVOKE_SENTINEL`; persistent index DB contains `src/invoke-sentinel.ts`
- Actual result: invoke returned structured success with `result: "WROTE_INVOKE_SENTINEL"`; index DB recorded `fileCount: 3` and `sentinelExists: true`
- Evidence:
  - temp HOME `/tmp/aca-m6-invoke-home-k8y53W`
  - temp workspace `/tmp/aca-m6-invoke-ws-CbjplK`
  - index DB `/tmp/aca-m6-invoke-home-k8y53W/.aca/indexes/wrk_8d4470a1303043b04b94550562d03acfa6f07cfca6719e01e73a129b611219ea/index.db`
- Status: `passed`

- Scenario ID: `M6-LIVE-4`
- Milestone: `M6`
- Goal: prove the `invoke` mutation result is immediately searchable through the real NanoGPT `search_semantic` path
- Command shape: second built `aca invoke` on the same isolated HOME/workspace with `allowed_tools: ["search_semantic"]`, requiring a match on `invokeSentinelAuthToken`
- Workspace / HOME isolation: reused isolated temp HOME and temp workspace from `M6-LIVE-3`
- Expected result: JSON success with result `SEARCHED_INVOKE_SENTINEL`
- Actual result: invoke returned structured success with `result: "SEARCHED_INVOKE_SENTINEL"`
- Evidence:
  - temp HOME `/tmp/aca-m6-invoke-home-k8y53W`
  - temp workspace `/tmp/aca-m6-invoke-ws-CbjplK`
- Status: `passed`

## M7 Delegation Validation

- Scenario ID: `M7-LIVE-1`
- Milestone: `M7`
- Goal: prove one-shot parent→child delegation executes live on NanoGPT
- Command shape: built one-shot on `moonshotai/kimi-k2.5` with `--no-confirm`, requiring `spawn_agent`, `await_agent`, and exact final text `PARENT_OK`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: parent spawns child, child returns `CHILD_OK`, parent returns `PARENT_OK`
- Actual result: parent called `spawn_agent`, then `await_agent`, then returned exact `PARENT_OK`; child session completed with exact `CHILD_OK`
- Evidence:
  - parent session dir `/tmp/aca-m7-live-home-kimi-FBGwHl/.aca/sessions/ses_01KNQNFRYEF94EZG7C014X0PES`
  - child session dir `/tmp/aca-m7-live-home-kimi-FBGwHl/.aca/sessions/ses_01KNQNG0GRT0AEPS26SEQY8X4P`
- Status: `passed`

- Scenario ID: `M7-LIVE-2`
- Milestone: `M7`
- Goal: prove `aca invoke` delegation parity in the built runtime
- Command shape: built `node dist/index.js invoke` on `moonshotai/kimi-k2.5` with `allowed_tools: ["spawn_agent", "await_agent"]`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: JSON success response with exact `result: "PARENT_OK"` and a completed child session
- Actual result: returned structured success JSON with `result: "PARENT_OK"`; invoke session persisted the spawn/await chain and the child session completed with `CHILD_OK`
- Evidence:
  - invoke HOME `/tmp/aca-m7-invoke-home-C87a2E`
  - parent session dir `/tmp/aca-m7-invoke-home-C87a2E/.aca/sessions/ses_01KNQNHDQFVFBKS4R414VVNP16`
  - child session dir `/tmp/aca-m7-invoke-home-C87a2E/.aca/sessions/ses_01KNQNHHB5PDG8GSDCRGM4SKDZ`
- Status: `passed`

- Scenario ID: `M7-LIVE-3`
- Milestone: `M7`
- Goal: prove nested child→grandchild delegation works with per-agent caller context and inherited non-interactive approval posture
- Command shape: built one-shot on `moonshotai/kimi-k2.5` with `--no-confirm`, requiring parent→child→grandchild execution and exact final text `PARENT_OK`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: root spawns child, child spawns grandchild, grandchild returns `GRANDCHILD_OK`, child returns `CHILD_OK`, parent returns `PARENT_OK`
- Actual result: the first nested awaits used placeholder references, ACA surfaced those tool errors, the model repaired on later steps, and the full nested chain completed with exact `PARENT_OK`
- Evidence:
  - parent session dir `/tmp/aca-m7-live-home-nested2-UtzuOv/.aca/sessions/ses_01KNQNS58SG7QQRMCAGT3JDVMW`
  - child session dir `/tmp/aca-m7-live-home-nested2-UtzuOv/.aca/sessions/ses_01KNQNTD8DZ6JWV69C2H9XYJ1Y`
  - grandchild session dir `/tmp/aca-m7-live-home-nested2-UtzuOv/.aca/sessions/ses_01KNQNV0JXCQVCYKY18QFC3THA`
- Status: `passed`

- Scenario ID: `M7-LIVE-4`
- Milestone: `M7`
- Goal: prove malformed delegation references fail safe instead of becoming false success
- Command shape: built one-shot on `qwen/qwen3-coder-next` with `--no-confirm`, same parent→child delegation task as `M7-LIVE-1`
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: if the model emits a malformed agent reference, ACA should surface a real error path rather than silently report success
- Actual result: Qwen emitted an empty `agent_id` after `spawn_agent`; ACA surfaced `llm.malformed` instead of incorrectly marking the turn `assistant_final`
- Evidence:
  - parent session dir `/tmp/aca-m7-live-home-qwen3-7hiK6l/.aca/sessions/ses_01KNQNFRXN12BHB17EHV565C80`
- Status: `observed`

## M8 Standalone Validation

- Scenario ID: `M8-LIVE-1`
- Milestone: `M8`
- Goal: prove the built standalone entrypoint works outside the repo cwd for fast-path packaging surfaces
- Command shape: absolute `node /home/blake/projects/anothercodingagent/dist/index.js --version`, `--help`, and `describe --json` from `/tmp`
- Workspace / HOME isolation: invoked from `/tmp`; no session state required
- Expected result: version prints `0.1.0`; help starts with ACA usage text; `describe --json` parses as ACA capability metadata
- Actual result: `--version` printed `0.1.0`; help began with `Usage: aca [options] [prompt]`; `describe --json` parsed as `aca 1.0.0 1.1.0`
- Evidence:
  - built entry `/home/blake/projects/anothercodingagent/dist/index.js`
- Status: `passed`

- Scenario ID: `M8-LIVE-2`
- Milestone: `M8`
- Goal: prove the built standalone one-shot path reaches real NanoGPT, returns exact text, and writes durable session artifacts under isolated HOME/workspace
- Command shape: `HOME=<temp> node /home/blake/projects/anothercodingagent/dist/index.js --model zai-org/glm-5 "Reply with exactly ACA_M8_ONE_SHOT_OK and nothing else."`
- Workspace / HOME isolation: isolated temp HOME `/tmp/aca-m8-live-home-JZE4RD` and isolated temp workspace `/tmp/aca-m8-live-ws-1LrNcN`
- Expected result: exact assistant text `ACA_M8_ONE_SHOT_OK`; new session manifest and conversation log under the isolated HOME
- Actual result: stdout was exactly `ACA_M8_ONE_SHOT_OK`; manifest recorded `turnCount: 1`; `conversation.jsonl` contained `5` records
- Evidence:
  - stdout capture `/tmp/aca-m8-live-stdout-ZpYkp8`
  - stderr capture `/tmp/aca-m8-live-stderr-5yXZKw`
  - session dir `/tmp/aca-m8-live-home-JZE4RD/.aca/sessions/ses_01KNQQJJ5V0YCMN3XZFKWMYFQS`
- Status: `passed`

- Scenario ID: `M8-LIVE-3`
- Milestone: `M8`
- Goal: prove the built `aca invoke` path still works as a standalone packaged entrypoint with a real NanoGPT response and durable session state
- Command shape: `HOME=<temp> node /home/blake/projects/anothercodingagent/dist/index.js invoke < <request.json>` with `context.cwd` set to an isolated temp workspace and `context.model: "zai-org/glm-5"`
- Workspace / HOME isolation: isolated temp HOME `/tmp/aca-m8-invoke-home-UDkOKI` and isolated temp workspace `/tmp/aca-m8-invoke-ws-HKdE3U`
- Expected result: structured JSON success with exact `result: "ACA_M8_INVOKE_OK"` plus an isolated ephemeral session
- Actual result: response JSON returned exact `result: "ACA_M8_INVOKE_OK"`; manifest recorded `turnCount: 1`
- Evidence:
  - request file `/tmp/aca-m8-invoke-request-pfo3f2.json`
  - response file `/tmp/aca-m8-invoke-response-y3m4lZ.json`
  - session dir `/tmp/aca-m8-invoke-home-UDkOKI/.aca/sessions/ses_01KNQQKFQ8J61F8KH0DE95V2K7`
- Status: `passed`

- Scenario ID: `M8-LIVE-4`
- Milestone: `M8`
- Goal: prove the built standalone tool path performs a real `write_file`, preserves the exact assistant result, records tool artifacts, and keeps the NanoGPT key scrubbed from the conversation log
- Command shape: `HOME=<temp> node /home/blake/projects/anothercodingagent/dist/index.js --model zai-org/glm-5 --no-confirm "<bounded absolute-path write_file task>"`
- Workspace / HOME isolation: isolated temp HOME `/tmp/aca-m8-tool-home-S0mr7j` and isolated temp workspace `/tmp/aca-m8-tool-ws-ZkFQ6p`
- Expected result: stdout exactly `WROTE`; target file contains `ACA_M8_WRITE_OK`; conversation log contains tool-call/tool-result evidence and zero raw NanoGPT key hits
- Actual result: stdout was exactly `WROTE`; `/tmp/aca-m8-tool-ws-ZkFQ6p/m8-live.txt` contained `ACA_M8_WRITE_OK`; conversation log contained one `tool_call`, one `tool_result`, and `0` raw NanoGPT key hits
- Evidence:
  - stdout capture `/tmp/aca-m8-tool-stdout-SJuXol`
  - stderr capture `/tmp/aca-m8-tool-stderr-W7wUNd`
  - output file `/tmp/aca-m8-tool-ws-ZkFQ6p/m8-live.txt`
  - session dir `/tmp/aca-m8-tool-home-S0mr7j/.aca/sessions/ses_01KNQQM30QFS5QVMCCPZNY8RXX`
- Status: `passed`

- Scenario ID: `M8-LIVE-5`
- Milestone: `M8`
- Goal: prove `--no-confirm` does not bypass the standalone sandbox boundary on a real NanoGPT tool turn
- Command shape: `HOME=<temp> node /home/blake/projects/anothercodingagent/dist/index.js --model zai-org/glm-5 --no-confirm "<bounded /root write_file task>"`
- Workspace / HOME isolation: isolated temp HOME `/tmp/aca-m8-sandbox-home-em729t` and isolated temp workspace `/tmp/aca-m8-sandbox-ws-WDXKcl`
- Expected result: tool failure with `tool.sandbox`; no `/root/aca-m8-sandbox.txt` created
- Actual result: assistant reported the expected failure; the conversation log recorded `tool.sandbox`; `/root/aca-m8-sandbox.txt` remained absent
- Evidence:
  - stdout capture `/tmp/aca-m8-sandbox-stdout-8ZHNLu`
  - stderr capture `/tmp/aca-m8-sandbox-stderr-eOjeXA`
- session dir `/tmp/aca-m8-sandbox-home-em729t/.aca/sessions/ses_01KNQQN5YS3G9HC3TQWNC5QS0K`
- Status: `passed`

## M9 Bridge Validation

- Scenario ID: `M9-LIVE-1`
- Milestone: `M9`
- Goal: prove the built MCP bridge exposes `aca_run` over real stdio transport
- Command shape: spawn `node /home/blake/projects/anothercodingagent/dist/index.js serve` through the MCP stdio client transport and call `tools/list`
- Workspace / HOME isolation: bridge launched from `/tmp`
- Expected result: tool list contains `aca_run`
- Actual result: MCP `tools/list` returned exactly one tool name: `aca_run`
- Evidence:
  - built entry `/home/blake/projects/anothercodingagent/dist/index.js`
- Status: `passed`

- Scenario ID: `M9-LIVE-2`
- Milestone: `M9`
- Goal: prove the real stdio bridge can spawn child ACA sessions that perform read, exec, and write tasks under the delegated `allowed_tools` boundary
- Command shape: real MCP client connected to built `aca serve`, then sequential `aca_run` calls for `read_file`, `exec_command`, and `write_file`
- Workspace / HOME isolation: isolated temp HOME `/tmp/aca-m9-live-home-SggQjB` and isolated temp workspace `/tmp/aca-m9-live-ws-Sn0Gqt`
- Expected result: read task returns the temp package name, exec task returns `ACA_M9_EXEC_OK`, write task creates `bridge-write.txt` with exact content `ACA_M9_WRITE_OK`
- Actual result: the child read session returned `m9-live-bridge`; the child exec session ran `printf ACA_M9_EXEC_OK` and returned `ACA_M9_EXEC_OK`; the child write session created `/tmp/aca-m9-live-ws-Sn0Gqt/bridge-write.txt` containing `ACA_M9_WRITE_OK`
- Evidence:
  - read session dir `/tmp/aca-m9-live-home-SggQjB/.aca/sessions/ses_01KNQSFPWG6NQTP04JV5ES1PWV`
  - exec session dir `/tmp/aca-m9-live-home-SggQjB/.aca/sessions/ses_01KNQSGFYBW3BMJ9NTDXW6RER3`
  - write session dir `/tmp/aca-m9-live-home-SggQjB/.aca/sessions/ses_01KNQSGRD7XTJ20WP96F219JB1`
  - output file `/tmp/aca-m9-live-ws-Sn0Gqt/bridge-write.txt`
- Status: `passed`

- Scenario ID: `M9-LIVE-3`
- Milestone: `M9`
- Goal: prove bridge error propagation on a bad model selection through the real stdio path
- Command shape: real MCP client connected to built `aca serve`, then `aca_run` with `model: "nonexistent/fake-model-xyz"`
- Workspace / HOME isolation: isolated temp HOME `/tmp/aca-m9-neg-home-laUtlI` and isolated temp workspace `/tmp/aca-m9-neg-ws-d0f1ZS`
- Expected result: MCP tool call returns an error containing `protocol.invalid_model` without hanging
- Actual result: MCP returned `protocol.invalid_model: Unknown model "nonexistent/fake-model-xyz"` with `isError: true`; no child session directory was created
- Evidence:
  - temp HOME `/tmp/aca-m9-neg-home-laUtlI`
- Status: `passed`

- Scenario ID: `M9-LIVE-4`
- Milestone: `M9`
- Goal: prove parallel `aca_run` calls complete as separate child sessions through the real stdio bridge
- Command shape: real MCP client connected to built `aca serve`, then two concurrent `aca_run` calls that each read an explicit in-workspace file path
- Workspace / HOME isolation: isolated temp HOME `/tmp/aca-m9-par-home-DGj2lk` and isolated temp workspace `/tmp/aca-m9-par-ws-tGGYQB`
- Expected result: one call returns `ALPHA_DONE`, the other returns `BETA_DONE`, and the bridge writes two child session dirs
- Actual result: both calls returned success with `ALPHA_DONE` and `BETA_DONE`; the isolated HOME contained two child session dirs
- Evidence:
  - session dir `/tmp/aca-m9-par-home-DGj2lk/.aca/sessions/ses_01KNQSV6JC6B0HH202BC45A6R5`
  - session dir `/tmp/aca-m9-par-home-DGj2lk/.aca/sessions/ses_01KNQSV6NBG1CE7K98J534KKQ2`
- Status: `passed`

## M10 Witness / Delegation Validation

- Scenario ID: `M10-LIVE-1`
- Milestone: `M10`
- Goal: reproduce the live consult-wrapper compatibility bug that exposed M10 drift
- Command shape: built `node dist/index.js consult --question "Read package.json and report the package name." --project-dir /home/blake/projects/anothercodingagent --witnesses minimax,kimi --skip-triage`
- Workspace / HOME isolation: isolated temp HOME created inline; no session state kept because the command failed before witness invocation
- Expected result: the stale `minimax` alias should fail against the current canonical witness set
- Actual result: command exited early with `consult failed: unknown witness: minimax`
- Evidence:
  - stderr line `consult failed: unknown witness: minimax`
- Status: `observed`

- Scenario ID: `M10-LIVE-2`
- Milestone: `M10`
- Goal: prove the repaired `.claude` consult wrapper normalizes the stale `minimax` alias to the canonical `deepseek` witness and that the current `aca consult` product path still fulfills bounded context requests
- Command shape: `ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' python3 /home/blake/.claude/skills/consult/scripts/run_consult.py --witnesses minimax --question "You do not have code in the prompt. Inspect package.json and report the package name and whether the package type is module. Do not guess." --project-dir /home/blake/projects/anothercodingagent --skip-triage`
- Workspace / HOME isolation: isolated temp HOME created inline; consult artifacts written under `/tmp`
- Expected result: successful consult run with witness key `deepseek`, a bounded `package.json` context request, and a final report grounded in the fulfilled snippet
- Actual result: wrapper completed with `success_count: 1`, witness key `deepseek`, one `context_requests` entry for `package.json:1-30`, one fulfilled snippet, and a final report identifying `anothercodingagent` with `"type": "module"`
- Evidence:
  - result JSON `/tmp/aca-consult-result-1775695138110-34714.json`
  - witness report `/tmp/aca-consult-deepseek-response-1775695138110-34714.md`
- Status: `passed`

- Scenario ID: `M10-LIVE-3`
- Milestone: `M10`
- Goal: prove the tool-enabled witness-profile `invoke` path is still live, tool-filtered, and persisted on disk
- Command shape: built `node /home/blake/projects/anothercodingagent/dist/index.js invoke < <request.json>` with `context.profile: "witness"`, `allowed_tools: ["exec_command"]`, and the task `Use exec_command to run pwd and return only the absolute working-directory path. Do not guess.`
- Workspace / HOME isolation: isolated temp HOME `/tmp/aca-m10-invoke-home-TNE921` and repo workspace `/home/blake/projects/anothercodingagent`
- Expected result: structured JSON success, exactly one accepted `exec_command`, final result equal to the repo path, and an ephemeral executor session on disk
- Actual result: invoke returned success with `result: "/home/blake/projects/anothercodingagent"`; `safety.accepted_tool_calls_by_name.exec_command` was `1`; the session manifest recorded `mode: "executor"` and `conversation.jsonl` persisted the `exec_command("pwd")` tool call and final answer
- Evidence:
  - session dir `/tmp/aca-m10-invoke-home-TNE921/.aca/sessions/ses_01KNQTV3P334BYRGYQBSP22ZGC`
  - manifest `/tmp/aca-m10-invoke-home-TNE921/.aca/sessions/ses_01KNQTV3P334BYRGYQBSP22ZGC/manifest.json`
  - conversation log `/tmp/aca-m10-invoke-home-TNE921/.aca/sessions/ses_01KNQTV3P334BYRGYQBSP22ZGC/conversation.jsonl`
- Status: `passed`

- Scenario ID: `M10-LIVE-4`
- Milestone: `M10`
- Goal: prove executor-mode negative-path handling still fails fast on an invalid model without creating session state
- Command shape: built `node /home/blake/projects/anothercodingagent/dist/index.js invoke < <request.json>` with `context.model: "nonexistent/fake-model-xyz"`
- Workspace / HOME isolation: isolated temp HOME `/tmp/aca-m10-neg-home-qTRlRV`
- Expected result: structured `protocol.invalid_model` error and no session directory
- Actual result: invoke returned `{"code":"protocol.invalid_model","message":"Unknown model \"nonexistent/fake-model-xyz\""}` and the isolated HOME contained no session directories
- Evidence:
  - temp HOME `/tmp/aca-m10-neg-home-qTRlRV`
- Status: `passed`

## M11 Model Utilization Validation

- Scenario ID: `M11-LIVE-1`
- Milestone: `M11`
- Goal: prove the built artifact exports the current ACA-native witness contract instead of stale external wrapper state
- Command shape: `node dist/index.js witnesses`
- Workspace / HOME isolation: isolated temp HOME created inline; no provider call or session state expected
- Expected result: JSON witness export contains exactly `deepseek`, `kimi`, `qwen`, and `gemma` with the current max-token ceilings
- Actual result: stdout returned the canonical four-witness export with `deepseek/kimi/qwen = 65536` and `gemma = 131072`
- Evidence:
  - direct built-CLI stdout from the bounded live run
- Status: `passed`

- Scenario ID: `M11-LIVE-2`
- Milestone: `M11`
- Goal: prove the built runtime still consumes live NanoGPT catalog limits on startup and surfaces them through the verbose provider line
- Command shape: `node dist/index.js --verbose --model moonshotai/kimi-k2.5 "Reply with exactly ACA_M11_VERBOSE_OK and nothing else."`
- Workspace / HOME isolation: isolated temp HOME `/tmp/aca-m11-verbose-home-5nKLE6` and isolated temp workspace `/tmp/aca-m11-verbose-ws-7OPQnQ`
- Expected result: exact assistant reply plus a verbose stderr line showing Kimi's live context and max-output ceiling
- Actual result: stdout was exactly `ACA_M11_VERBOSE_OK`; stderr included `[provider] nanogpt:moonshotai/kimi-k2.5 context=256000 maxOutput=65536`; the built runtime persisted a real session directory
- Evidence:
  - stdout capture `/tmp/aca-m11-verbose-stdout-Txhaz9`
  - stderr capture `/tmp/aca-m11-verbose-stderr-DRRxOh`
  - session dir `/tmp/aca-m11-verbose-home-5nKLE6/.aca/sessions/ses_01KNQWC51FA3ZRK5CBWWKS7928`
  - manifest `/tmp/aca-m11-verbose-home-5nKLE6/.aca/sessions/ses_01KNQWC51FA3ZRK5CBWWKS7928/manifest.json`
- Status: `passed`

- Scenario ID: `M11-LIVE-3`
- Milestone: `M11`
- Goal: prove the live invoke path uses the lifted witness profile and prompt assembly rather than the old bare system prompt
- Command shape: built `node dist/index.js invoke < <request.json>` with `context.model: "zai-org/glm-5"`, `context.profile: "witness"`, `context.cwd` set to an isolated temp workspace, and a bounded task that asks the model to report the working directory and whether `search_semantic`, `web_search`, and `exec_command` are available without calling tools
- Workspace / HOME isolation: isolated temp HOME `/tmp/aca-m11-invoke-home-y0pZSr` and isolated temp workspace `/tmp/aca-m11-invoke-ws-3sly54`
- Expected result: structured success, no tool calls, exact cwd echo from the system prompt, and `yes` for the lifted witness tools
- Actual result: invoke returned success with `cwd=/tmp/aca-m11-invoke-ws-3sly54`, `search_semantic=yes`, `web_search=yes`, and `exec_command=yes`; no tool calls were accepted; the ephemeral executor session persisted with `turnCount: 1` and `model: "zai-org/glm-5"`
- Evidence:
  - request file `/tmp/aca-m11-invoke-request-qLGXZ3.json`
  - output file `/tmp/aca-m11-invoke-output-gI0vkb.json`
  - session dir `/tmp/aca-m11-invoke-home-y0pZSr/.aca/sessions/ses_01KNQWCRTM0QH27S57AYY6PJ2E`
  - manifest `/tmp/aca-m11-invoke-home-y0pZSr/.aca/sessions/ses_01KNQWCRTM0QH27S57AYY6PJ2E/manifest.json`
- Status: `passed`

- Scenario ID: `M11-LIVE-4`
- Milestone: `M11`
- Goal: prove the live NanoGPT catalog path still rejects an unknown model before creating executor session state
- Command shape: built `node dist/index.js invoke < <request.json>` with `context.model: "nonexistent/m11-invalid-model"`
- Workspace / HOME isolation: isolated temp HOME `/tmp/aca-m11-invalid-home-ZipZGR`
- Expected result: structured `protocol.invalid_model` error and no session directory
- Actual result: invoke returned `{"code":"protocol.invalid_model","message":"Unknown model \"nonexistent/m11-invalid-model\""}` and the isolated HOME contained no session directories
- Evidence:
  - request file `/tmp/aca-m11-invalid-request-741kds.json`
  - temp HOME `/tmp/aca-m11-invalid-home-ZipZGR`
- Status: `passed`

## C1 — Bundled Consult Orchestration

- Scenario ID: `C1-LIVE-1`
- Milestone: `C1`
- Goal: prove the built witness export accepts the documented/programmatic `--json` alias as well as the bare JSON default
- Command shape: `node dist/index.js witnesses --json`
- Workspace / HOME isolation: no provider call; no session state expected
- Expected result: canonical JSON export for exactly `deepseek`, `kimi`, `qwen`, and `gemma`
- Actual result: built CLI accepted `--json` and returned the canonical four-witness JSON export with the expected model IDs and ceilings
- Evidence:
  - direct built-CLI stdout from the bounded live run
- Status: `passed`

- Scenario ID: `C1-LIVE-2`
- Milestone: `C1`
- Goal: prove a bounded packed consult still succeeds end to end on the rebuilt artifact
- Command shape: `node dist/index.js consult --question "Using the packed evidence and any bounded follow-up snippets you need, report the package name and the canonical witness keys. Do not guess." --project-dir /home/blake/projects/anothercodingagent --witnesses kimi --pack-path package.json --pack-path src/config/witness-models.ts --out /tmp/aca-c1-pack-post.json`
- Workspace / HOME isolation: direct built-CLI consult run in the repo workspace; artifacts written under `/tmp`
- Expected result: non-degraded result with two packed files, one successful witness report, and a successful triage report
- Actual result: consult returned `success_count: 1`, `degraded: false`, `included_files: 2`, a successful Kimi witness report, and `triage.status: "ok"`
- Evidence:
  - result JSON `/tmp/aca-c1-pack-post.json`
  - witness report `/tmp/aca-consult-kimi-response-1775703491088-46126.md`
  - triage report `/tmp/aca-consult-triage-1775703491088-46126.md`
- Status: `passed`

- Scenario ID: `C1-LIVE-3`
- Milestone: `C1`
- Goal: prove degraded witness output is preserved and still reaches triage in a normal packed consult
- Command shape: `node dist/index.js consult --question "Using the packed evidence and any bounded follow-up snippets you need, report the package name and the canonical witness keys. Do not guess." --project-dir /home/blake/projects/anothercodingagent --witnesses deepseek,kimi --pack-path package.json --pack-path src/config/witness-models.ts --out /tmp/aca-c1-pack.json`
- Workspace / HOME isolation: direct built-CLI consult run in the repo workspace; artifacts written under `/tmp`
- Expected result: even if one witness degrades, ACA should preserve the raw artifact and continue triage with surviving witness evidence
- Actual result: DeepSeek emitted `{"action":"final","findings_markdown":"","needs_context":[]}` in the no-tools context-request pass, ACA marked that witness degraded, preserved the raw request artifact, accepted the Kimi report, and still produced `triage.status: "ok"`
- Evidence:
  - result JSON `/tmp/aca-c1-pack.json`
  - degraded witness artifact `/tmp/aca-consult-deepseek-context-request-1775703088820-45078.md`
  - surviving witness report `/tmp/aca-consult-kimi-response-1775703088820-45078.md`
  - triage report `/tmp/aca-consult-triage-1775703088820-45078.md`
- Status: `passed`

- Scenario ID: `C1-LIVE-4`
- Milestone: `C1`
- Goal: prove the repaired shared-context path leaves unsupported facts as open questions instead of turning missing evidence into a false absence claim
- Command shape: `node dist/index.js consult --question "Report the package name and the canonical witness keys. Do not guess." --project-dir /home/blake/projects/anothercodingagent --witnesses kimi --shared-context --out /tmp/aca-c1-shared-post2.json`
- Workspace / HOME isolation: direct built-CLI consult run in the repo workspace; artifacts written under `/tmp`
- Expected result: package name should be grounded from `package.json`; unsupported witness-key claims should remain uncertain instead of being promoted as facts
- Actual result: shared-context stayed enabled, the witness explicitly requested `package.json`, confirmed `anothercodingagent`, and left canonical witness keys as `Unknown`; triage kept witness keys in `Open Questions` instead of asserting a false absence
- Evidence:
  - result JSON `/tmp/aca-c1-shared-post2.json`
  - witness context-request artifact `/tmp/aca-consult-kimi-context-request-1775703714768-46890.md`
  - witness report `/tmp/aca-consult-kimi-response-1775703714768-46890.md`
  - triage report `/tmp/aca-consult-triage-1775703714768-46890.md`
- Status: `passed`

- Scenario ID: `C1-LIVE-5`
- Milestone: `C1`
- Goal: prove the `.claude` consult wrapper now forwards shared-context flags through to ACA-native consult
- Command shape: `ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' python3 /home/blake/.claude/skills/consult/scripts/run_consult.py --witnesses kimi --shared-context --skip-triage --question "Report the package name. Do not guess." --project-dir /home/blake/projects/anothercodingagent`
- Workspace / HOME isolation: wrapper-driven consult run in the repo workspace; artifacts written under `/tmp`
- Expected result: wrapper accepts `--shared-context`, ACA shared-context requests `package.json`, and the witness returns a successful bounded report
- Actual result: wrapper completed successfully with `shared_context.status: "ok"`, one `package.json` shared-context request, and a successful Kimi witness response; triage was intentionally skipped by flag
- Evidence:
  - result JSON `/tmp/aca-consult-result-1775703833593-47034.json`
  - shared-context artifact `/tmp/aca-consult-shared-context-1775703833593-47034.md`
  - witness report `/tmp/aca-consult-kimi-response-1775703833593-47034.md`
- Status: `passed`

- Scenario ID: `C1-LIVE-6`
- Milestone: `C1`
- Goal: prove an invalid shared-context model degrades cleanly without preventing witness completion or triage
- Command shape: `node dist/index.js consult --question "Report the package name. Do not guess." --project-dir /home/blake/projects/anothercodingagent --witnesses kimi --shared-context --shared-context-model not-a-real/model --out /tmp/aca-c1-invalid-post2.json`
- Workspace / HOME isolation: direct built-CLI consult run in the repo workspace; artifacts written under `/tmp`
- Expected result: shared-context should record a structured `protocol.invalid_model` failure, the witness should still complete, and triage should still succeed with the available witness evidence
- Actual result: `shared_context.status` was `error` with `protocol.invalid_model: Unknown model "not-a-real/model"`, the Kimi witness still completed successfully, and `triage.status` remained `ok`
- Evidence:
  - result JSON `/tmp/aca-c1-invalid-post2.json`
  - witness report `/tmp/aca-consult-kimi-response-1775703833562-47023.md`
  - triage report `/tmp/aca-consult-triage-1775703833562-47023.md`
- Status: `passed`

- Scenario ID: `C1-LIVE-7`
- Milestone: `C1`
- Goal: prove a real 4-witness packed consult run completes on the built artifact and capture any remaining multi-witness degradation shape
- Command shape: `node dist/index.js consult --question "Using the packed evidence and any bounded follow-up snippets you need, report the package name and the canonical witness keys. Do not guess." --project-dir /home/blake/projects/anothercodingagent --witnesses all --pack-path package.json --pack-path src/config/witness-models.ts --out /tmp/aca-c1-four-way.json`
- Workspace / HOME isolation: direct built-CLI consult run in the repo workspace; artifacts written under `/tmp`
- Expected result: four-witness consult completes with either full success or bounded degraded continuation plus successful triage
- Actual result: consult returned `success_count: 3` / `total_witnesses: 4` with `degraded: true`; `kimi`, `qwen`, and `gemma` succeeded; `deepseek` degraded during no-tools finalization after requesting `src/config/witness-models.ts`, because it emitted a bespoke JSON object (`{"package_name":"anothercodingagent","canonical_witness_keys":[...]}`) instead of a Markdown final report; ACA preserved the degraded artifact and triage still completed successfully with the three valid witness reports
- Evidence:
  - result JSON `/tmp/aca-c1-four-way.json`
  - triage report `/tmp/aca-consult-triage-1775704259055-47355.md`
  - degraded DeepSeek artifact `/tmp/aca-consult-deepseek-response-1775704259055-47355.md`
  - successful Kimi witness report `/tmp/aca-consult-kimi-response-1775704259055-47355.md`
- Status: `passed`

## C2 — Raw Scout / Finalization / Triage Protocol

- Scenario ID: `C2-LIVE-1`
- Milestone: `C2`
- Goal: prove the built no-tools consult path still handles a normal `needs_context -> final` witness flow
- Command shape: `node dist/index.js consult --question "Report the package name. Do not guess." --project-dir /home/blake/projects/anothercodingagent --witnesses kimi --out /tmp/aca-c2-needs-context.json`
- Workspace / HOME isolation: direct built-CLI consult run in the repo workspace; artifacts written under `/tmp`
- Expected result: one witness asks for bounded raw context, ACA fulfills it, the witness finalizes successfully, and triage succeeds
- Actual result: Kimi requested `package.json:1-30`, ACA fulfilled that bounded snippet request, the witness finalized successfully, and triage returned `status: "ok"` with `success_count: 1`
- Evidence:
  - result JSON `/tmp/aca-c2-needs-context.json`
  - witness request artifact `/tmp/aca-consult-kimi-context-request-1775704911814-49698.md`
  - witness report `/tmp/aca-consult-kimi-response-1775704911814-49698.md`
  - triage report `/tmp/aca-consult-triage-1775704911814-49698.md`
- Status: `passed`

- Scenario ID: `C2-LIVE-2`
- Milestone: `C2`
- Goal: prove malformed witness finalization output can be repaired once without losing the original bad artifact
- Command shape: `node dist/index.js consult --question "Using the packed evidence and any bounded follow-up snippets you need, report the package name and the canonical witness keys. Do not guess." --project-dir /home/blake/projects/anothercodingagent --witnesses all --pack-path package.json --pack-path src/config/witness-models.ts --out /tmp/aca-c2-four-way.json`
- Workspace / HOME isolation: direct built-CLI consult run in the repo workspace; artifacts written under `/tmp`
- Expected result: if a witness emits malformed custom JSON instead of a Markdown final, ACA should repair it once, preserve the original malformed final artifact, and still complete the consult
- Actual result: the 4-witness run completed with `success_count: 4` and `degraded: false`; DeepSeek first emitted bespoke JSON during finalization, ACA repaired that witness into a valid Markdown report on retry, preserved the original malformed final artifact, and triage still completed successfully. This same live run also exposed the separate truthfulness bug fixed during `C2`: the repaired DeepSeek witness still carried a stale error string in the result JSON even though the recovered report was usable.
- Evidence:
  - result JSON `/tmp/aca-c2-four-way.json`
  - repaired DeepSeek witness report `/tmp/aca-consult-deepseek-response-1775704911812-49697.md`
  - original malformed DeepSeek final artifact `/tmp/aca-consult-deepseek-final-raw-1775704911812-49697.md`
  - triage report `/tmp/aca-consult-triage-1775704911812-49697.md`
- Status: `passed`

- Scenario ID: `C2-LIVE-3`
- Milestone: `C2`
- Goal: prove empty structured witness finals still degrade cleanly and remain available to triage
- Command shape: `node dist/index.js consult --prompt-file /tmp/aca-c1-degraded-prompt.md --project-dir /home/blake/projects/anothercodingagent --witnesses deepseek --out /tmp/aca-c2-empty-final.json`
- Workspace / HOME isolation: direct built-CLI consult run in the repo workspace; artifacts written under `/tmp`
- Expected result: DeepSeek emits the known empty structured final shape, ACA marks it degraded after one bounded retry, preserves the raw artifact, and triage still succeeds from degraded evidence
- Actual result: consult returned `success_count: 0`, `degraded: true`; DeepSeek emitted `{"action":"final","findings_markdown":"","needs_context":[]}`, ACA retried once, still classified it as degraded, preserved the raw witness artifact, and triage returned `status: "ok"`
- Evidence:
  - result JSON `/tmp/aca-c2-empty-final.json`
  - degraded witness artifact `/tmp/aca-consult-deepseek-context-request-1775705107577-50659.md`
  - triage report `/tmp/aca-consult-triage-1775705107577-50659.md`
- Status: `passed`

- Scenario ID: `C2-LIVE-4`
- Milestone: `C2`
- Goal: prove pseudo-tool witness output is still classified as degraded no-tools output and forwarded to triage as raw evidence
- Command shape: `node dist/index.js consult --prompt-file /tmp/aca-c2-pseudo-tool-prompt.md --project-dir /home/blake/projects/anothercodingagent --witnesses deepseek --out /tmp/aca-c2-pseudo-tool.json`
- Workspace / HOME isolation: direct built-CLI consult run in the repo workspace; artifacts written under `/tmp`
- Expected result: DeepSeek emits literal pseudo-tool-call markup, ACA classifies it as degraded no-tools witness output, preserves the raw artifact, and triage succeeds from the degraded evidence
- Actual result: consult returned `success_count: 0`, `degraded: true`; DeepSeek emitted literal pseudo-tool-call markup in the context-request pass, ACA classified it as `pseudo-tool call emitted in no-tools context-request pass`, preserved the raw witness artifact, and triage returned `status: "ok"`
- Evidence:
  - result JSON `/tmp/aca-c2-pseudo-tool.json`
  - degraded witness artifact `/tmp/aca-consult-deepseek-context-request-1775705148089-50743.md`
  - triage report `/tmp/aca-consult-triage-1775705148089-50743.md`
- Status: `passed`

- Scenario ID: `C2-LIVE-5`
- Milestone: `C2`
- Goal: prove the bounded repair path does not hide repeated malformed witness finals and that raw triage artifacts are preserved even when triage did not need repair
- Command shape: `node dist/index.js consult --prompt-file /tmp/aca-c2-triage-json-prompt.md --project-dir /home/blake/projects/anothercodingagent --witnesses kimi --pack-path package.json --out /tmp/aca-c2-triage-json.json`
- Workspace / HOME isolation: direct built-CLI consult run in the repo workspace; artifacts written under `/tmp`
- Expected result: if the witness keeps returning custom JSON after one repair attempt, ACA should preserve the malformed final artifact, mark the witness degraded, and still save the first triage attempt separately via `triage.raw_path`
- Actual result: Kimi kept returning custom JSON in finalization under the JSON-only adversarial prompt, ACA marked the witness degraded, preserved the malformed final artifact, and triage still completed successfully with both `triage.path` and `triage.raw_path` recorded
- Evidence:
  - result JSON `/tmp/aca-c2-triage-json.json`
  - malformed Kimi final artifact `/tmp/aca-consult-kimi-final-raw-1775705590313-51615.md`
  - triage raw artifact `/tmp/aca-consult-triage-raw-1775705590313-51615.md`
  - triage report `/tmp/aca-consult-triage-1775705590313-51615.md`
- Status: `passed`

Residual note for `C2` live coverage:

- I did not recover a deterministic live malformed-triage response from the current provider set even after adversarial prompts aimed at forcing non-Markdown or pseudo-tool-shaped aggregation output.
- The triage retry path is covered by focused tests and the live run now proves `triage.raw_path` preservation, but a standalone live triage-repair capture remains unproven in this pass.

## C3 — External Delegation Pipeline and Agentized Offload

- Scenario ID: `C3-LIVE-1`
- Milestone: `C3`
- Goal: prove the built `.claude` delegate wrapper can shape a real offload run with an explicit profile and narrowed tool set
- Command shape: `ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' python3 /home/blake/.claude/skills/delegate/scripts/run_delegate.py --project-dir /home/blake/projects/anothercodingagent --profile reviewer --allowed-tools read_file --max-steps 8 --max-total-tokens 80000 --timeout-ms 120000 --task "Read package.json and reply with only the package name."`
- Workspace / HOME isolation: isolated temp `HOME` under `/tmp/aca-c3-del-home-*`; repo workspace unchanged
- Expected result: wrapper forwards `profile=reviewer`, narrows tools to `read_file`, returns the package name, and records the created session directory
- Actual result: delegate returned `anothercodingagent` with `accepted_tool_calls_by_name.read_file = 1`; the saved wrapper artifact captured the real built `aca_bin` and one new session directory under the isolated `HOME`
- Evidence:
  - result JSON `/tmp/delegate-result-1775707440198611733.json`
  - session dir `/tmp/aca-c3-del-home-nw4hEV/.aca/sessions/ses_01KNR6JHNQNJ4VE9GK1NTS7TWB`
- Status: `passed`

- Scenario ID: `C3-LIVE-2`
- Milestone: `C3`
- Goal: prove the repaired `.claude` orchestrate wrapper forwards top-level defaults plus per-task overrides for profile/required outputs/fail-on-rejected and stays auditable in a real parallel run
- Command shape: `ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' python3 /home/blake/.claude/skills/orchestrate/scripts/run_orchestrate.py --project-dir /tmp/aca-c3-orch-ws2-zLbxVw --tasks-json /tmp/aca-c3-orch2-tasks-kPEnby.json --profile coder --allowed-tools read_file,make_directory,write_file --max-steps 8 --max-total-tokens 80000 --timeout-ms 120000 --fail-on-rejected-tool-calls --concurrency 2`
- Workspace / HOME isolation: isolated temp workspace `/tmp/aca-c3-orch-ws2-zLbxVw` and temp `HOME` `/tmp/aca-c3-orch-home-final-CUiwZ6`
- Expected result: both tasks complete in parallel, required output paths are satisfied, the top-level artifact records the resolved `aca_bin`, and nested delegate artifacts remain inspectable
- Actual result: orchestrate returned `success_count: 2`; task `alpha` used top-level `profile=coder`, task `beta` overrode to `profile=general`, both created their assigned files, and the top-level artifact now records the real built `aca_bin` instead of the stale default `./dist/index.js`
- Evidence:
  - result JSON `/tmp/orchestrate-result-1775707819825713324.json`
  - task spec `/tmp/aca-c3-orch2-tasks-kPEnby.json`
  - output file `/tmp/aca-c3-orch-ws2-zLbxVw/notes/alpha.txt`
  - output file `/tmp/aca-c3-orch-ws2-zLbxVw/notes/beta.txt`
- Status: `passed`

- Scenario ID: `C3-LIVE-3`
- Milestone: `C3`
- Goal: prove Codex now has a first-party delegate entrypoint that behaves the same way as the canonical `.claude` wrapper
- Command shape: `ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' python3 /home/blake/.codex/skills/delegate/scripts/run_delegate.py --project-dir /home/blake/projects/anothercodingagent --profile reviewer --allowed-tools read_file --max-steps 8 --max-total-tokens 80000 --timeout-ms 120000 --task "Read package.json and reply with only the package name."`
- Workspace / HOME isolation: isolated temp `HOME` under `/tmp/aca-c3-codex-home-*`; repo workspace unchanged
- Expected result: the `.codex` surface succeeds through the same bounded delegate contract and records a new session directory
- Actual result: the `.codex` shim returned `anothercodingagent`, recorded the real built `aca_bin`, and saved one new session directory under the isolated `HOME`
- Evidence:
  - result JSON `/tmp/delegate-result-1775707541060975233.json`
  - session dir `/tmp/aca-c3-codex-home-V4QqEg/.aca/sessions/ses_01KNR6NMANTNCJ0R9S0C12WE6S`
- Status: `passed`

- Scenario ID: `C3-LIVE-4`
- Milestone: `C3`
- Goal: prove failure propagation still reaches the external caller cleanly after the Codex parity surface is added
- Command shape: `ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' python3 /home/blake/.codex/skills/delegate/scripts/run_delegate.py --project-dir /home/blake/projects/anothercodingagent --model nonexistent/c3-invalid-model --allowed-tools read_file --max-steps 8 --max-total-tokens 80000 --timeout-ms 120000 --task "Read package.json and reply with only the package name."`
- Workspace / HOME isolation: isolated temp `HOME` under `/tmp/aca-c3-codex-fail-home-*`; repo workspace unchanged
- Expected result: wrapper returns a structured invalid-model error and does not create a session directory
- Actual result: the `.codex` delegate wrapper exited `5` with `protocol.invalid_model: Unknown model "nonexistent/c3-invalid-model"` and `new_session_dirs: []`
- Evidence:
  - result JSON `/tmp/delegate-result-1775707554070230381.json`
- Status: `passed`

- Scenario ID: `C3-LIVE-5`
- Milestone: `C3`
- Goal: prove the real stdio MCP `aca_run` path can offload a bounded task, spawn a child agent, and persist correct parent/root lineage on disk
- Command shape: `node --input-type=module` client script that spawned `node dist/index.js serve`, called `aca_run` once for a direct read-only task and once for a `spawn_agent` + `await_agent` task, then dumped the resulting session manifests
- Workspace / HOME isolation: isolated temp `HOME` `/tmp/aca-c3-mcp-home-EhDGpl`; repo workspace unchanged
- Expected result: tool list includes `aca_run`; the read-only task succeeds; the child-agent task succeeds; one child session manifest records the parent/root lineage of the second top-level session
- Actual result: the stdio client saw only `aca_run`; the read-only call returned `anothercodingagent`; the child-agent call also returned `anothercodingagent` with `4` steps and `3` accepted tool calls; three session manifests were created on disk, including child session `ses_01KNR6SC2MQ2C74EH1J2C1869Q` with `parentSessionId = rootSessionId = ses_01KNR6S6GMBH20G4JEPJE4WRWJ`
- Evidence:
  - artifact `/tmp/aca-c3-mcp-live.json`
  - session home `/tmp/aca-c3-mcp-home-EhDGpl`
- Status: `passed`

Residual note for `C3` live coverage:

- The core C3 claim is proven: external callers can treat ACA as a bounded offload agent through real `.claude` / `.codex` wrappers and through real stdio `aca_run`, with inspectable child-lineage on disk.
- The remaining wrapper artifact issue is bounded and has been routed to `C5`: in parallel orchestrate runs that share one `HOME`, each nested delegate can report the same `new_session_dirs` list because the wrapper tracks session creation with a coarse before/after directory diff.
- That traceability gap does not negate C3 closure because the run-level artifact, nested delegate `result_path` files, and on-disk session manifests still preserve what happened; it should only be reopened if later passes need exact per-task session-dir attribution from the wrapper envelope alone.

## C4 — RP Researcher Profile and Workflow

- Scenario ID: `C4-LIVE-1`
- Milestone: `C4`
- Goal: expose whether the broad RP discovery workflow can fail safe when optional search/browser paths are unavailable or noisy instead of silently pretending discovery is complete
- Command shape: `ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' HOME=/tmp/aca-c4-home-O7N2oG python3 /home/blake/.claude/skills/delegate/scripts/run_delegate.py --project-dir /tmp/aca-c4-ws-qOphFr --profile rp-researcher --model zai-org/glm-5 --allowed-tools read_file,find_paths,search_text,web_search,fetch_url,fetch_mediawiki_category,fetch_mediawiki_page --max-steps 10 --max-total-tokens 100000 --timeout-ms 300000 --network-mode open --thinking enabled --temperature 1.0 --task "Research Trinity Seven canon and return a Markdown discovery brief only. Do not write files. The brief must include main character candidates, high-value world/topic files, concrete source notes, and exact proposed output paths under world/characters/ and world/."`
- Workspace / HOME isolation: isolated temp workspace `/tmp/aca-c4-ws-qOphFr` and isolated temp `HOME` `/tmp/aca-c4-home-O7N2oG`
- Expected result: either a grounded discovery brief or a clearly surfaced failure that shows where RP discovery/operator guidance is drifting
- Actual result: the built wrapper failed openly with `turn.max_steps` after `33` accepted tool calls; the run burned budget across optional search/browser/category paths instead of converging on a bounded discovery brief, which exposed the need to harden the RP prompt/operator contract before closure
- Evidence:
  - result JSON `/tmp/delegate-result-1775708478295352096.json`
  - session dir `/tmp/aca-c4-home-O7N2oG/.aca/sessions/ses_01KNR7J7GTSZ494ZRFW772XR5M`
- Status: `observed`

- Scenario ID: `C4-LIVE-2`
- Milestone: `C4`
- Goal: expose whether RP repair turns honor a widened tool budget when the wrapper requests more than the old default
- Command shape: `ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' HOME=/tmp/aca-c4-home3-N4BCci python3 /home/blake/.claude/skills/delegate/scripts/run_delegate.py --project-dir /tmp/aca-c4-ws3-U5Euzo --profile rp-researcher --model zai-org/glm-5 --allowed-tools read_file,find_paths,search_text,fetch_mediawiki_page --max-steps 10 --max-tool-calls 20 --max-total-tokens 100000 --timeout-ms 300000 --network-mode open --thinking enabled --temperature 1.0 --task "Using only fetch_mediawiki_page against https://trinity-seven.fandom.com/api.php plus local file tools, produce a Markdown discovery brief for Trinity Seven. Do not write files. Use Trinity Seven, Arata Kasuga, Lilith Asami, Lieselotte Sherlock, Levi Kazama, Akio Fudo, Mira Yamana, Yui Kurata, Iscariot, Royal Biblia Academy, and Breakdown Phenomenon as the starting page set. The brief must include main character candidates, 4-6 high-value world/topic files, concrete source notes, and exact proposed output paths under world/characters/ and world/."`
- Workspace / HOME isolation: isolated temp workspace `/tmp/aca-c4-ws3-U5Euzo` and isolated temp `HOME` `/tmp/aca-c4-home3-N4BCci`
- Expected result: the repaired RP discovery turn should honor the widened budget instead of silently falling back to the old 8-call cap
- Actual result: before the repair-cap hardening, the same bounded discovery task failed with `turn.max_tool_calls` after `8` accepted calls even though the wrapper requested `20`, proving the RP repair path was still clamped to the old fallback limit
- Evidence:
  - result JSON `/tmp/delegate-result-1775709515242344469.json`
  - session dir `/tmp/aca-c4-home3-N4BCci/.aca/sessions/ses_01KNR8HW3382S7HTD70DAZBDWW`
- Status: `observed`

- Scenario ID: `C4-LIVE-3`
- Milestone: `C4`
- Goal: prove the hardened direct-MediaWiki RP discovery path now returns a grounded discovery brief without writing files
- Command shape: same as `C4-LIVE-2`, rerun after hardening
- Workspace / HOME isolation: same isolated temp workspace `/tmp/aca-c4-ws3-U5Euzo` and isolated temp `HOME` `/tmp/aca-c4-home3-N4BCci`
- Expected result: a source-grounded Markdown discovery brief with character candidates, world/topic files, source notes, and exact output paths
- Actual result: the rerun completed successfully and returned a grounded Trinity Seven discovery brief after `15` accepted tool calls. The artifact still begins with a one-sentence intent preface and the session manifest kept two bounded deferred-call open loops from front-loading more than `10` tool calls in the first message, but the discovery brief itself was correct and usable
- Evidence:
  - result JSON `/tmp/delegate-result-1775709652047731108.json`
  - session dir `/tmp/aca-c4-home3-N4BCci/.aca/sessions/ses_01KNR8P1PYGGD7FFNZ5CVXAKVX`
  - manifest `/tmp/aca-c4-home3-N4BCci/.aca/sessions/ses_01KNR8P1PYGGD7FFNZ5CVXAKVX/manifest.json`
- Status: `passed`

- Scenario ID: `C4-LIVE-4`
- Milestone: `C4`
- Goal: prove `rp-researcher` can still create the exact assigned RP file when the user-level default model is unavailable and fallback is required
- Command shape: `ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' HOME=/tmp/aca-c4-home3-N4BCci ACA_MODEL_DEFAULT='zai-org/glm-5.1' python3 /home/blake/.claude/skills/delegate/scripts/run_delegate.py --project-dir /tmp/aca-c4-ws3-U5Euzo --profile rp-researcher --allowed-tools read_file,find_paths,search_text,fetch_mediawiki_page,make_directory,write_file --max-steps 10 --max-tool-calls 20 --max-total-tokens 100000 --timeout-ms 300000 --network-mode open --thinking enabled --temperature 1.0 --required-output-path world/characters/lilith-asami.md --fail-on-rejected-tool-calls --task "Using only fetch_mediawiki_page against https://trinity-seven.fandom.com/api.php plus local file tools, research Lilith Asami and write exactly world/characters/lilith-asami.md as grounded Markdown. Do not write any other file. Keep Relationships compact with at most 6 important dynamics. Avoid Japanese script unless it is needed to disambiguate a named ability."`
- Workspace / HOME isolation: isolated temp workspace `/tmp/aca-c4-ws3-U5Euzo` and isolated temp `HOME` `/tmp/aca-c4-home3-N4BCci`
- Expected result: the wrapper should succeed without an explicit model, the runtime should fall back away from unavailable `zai-org/glm-5.1`, and the required output file should exist on disk
- Actual result: the run succeeded, wrote `world/characters/lilith-asami.md`, and the session manifest recorded `configSnapshot.model = "zai-org/glm-5"` even though `ACA_MODEL_DEFAULT` was pinned to unavailable `zai-org/glm-5.1`. The file artifact was correct; one bounded open loop remained from a malformed self-check `read_file`, which did not block required-output validation
- Evidence:
  - result JSON `/tmp/delegate-result-1775709348020467053.json`
  - output file `/tmp/aca-c4-ws3-U5Euzo/world/characters/lilith-asami.md`
  - session dir `/tmp/aca-c4-home3-N4BCci/.aca/sessions/ses_01KNR8CRSP5BN4V2P3H16YV3V6`
  - manifest `/tmp/aca-c4-home3-N4BCci/.aca/sessions/ses_01KNR8CRSP5BN4V2P3H16YV3V6/manifest.json`
- Status: `passed`

- Scenario ID: `C4-LIVE-5`
- Milestone: `C4`
- Goal: prove plan-only / zero-tool RP completions still fail instead of being accepted as valid research output
- Command shape: `ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' HOME=/tmp/aca-c4-home3-N4BCci python3 /home/blake/.claude/skills/delegate/scripts/run_delegate.py --project-dir /tmp/aca-c4-ws3-U5Euzo --profile rp-researcher --model zai-org/glm-5 --allowed-tools '' --max-steps 4 --max-tool-calls 4 --max-total-tokens 40000 --timeout-ms 120000 --task "Do not use tools. Just describe how you would research Trinity Seven and what files you would probably create."`
- Workspace / HOME isolation: isolated temp workspace `/tmp/aca-c4-ws3-U5Euzo` and isolated temp `HOME` `/tmp/aca-c4-home3-N4BCci`
- Expected result: the RP profile should reject the run because no research or file-inspection tools were actually used
- Actual result: the wrapper returned `turn.profile_validation_failed` with `rp-researcher run ended without any accepted tool calls; RP research/write tasks must inspect sources or local files before completion`
- Evidence:
  - result JSON `/tmp/delegate-result-1775709470395604461.json`
  - session dir `/tmp/aca-c4-home3-N4BCci/.aca/sessions/ses_01KNR8GG7S1JK6ZY9SD7DHQ20V`
- Status: `passed`

Residual note for `C4` live coverage:

- The main live `C4` claim is proven: the built RP profile now completes bounded discovery and exact-output write tasks without collapsing into plan-only narration, and the wrapper/runtime pair re-proved fallback plus output enforcement on the real NanoGPT path.
- The remaining `C4` leftovers are bounded and are routed to `C5`: successful RP sessions can still keep non-blocking open loops from deferred extra calls or malformed self-check `read_file` arguments, and the broadest discovery shape is still noisier than ideal even after the prompt/operator hardening.

## C5 — Residual Closure and Hard-to-Reproduce Cases

- Scenario ID: `C5-LIVE-1`
- Milestone: `C5`
- Goal: verify the queued `C3` residual is still real on the current built artifact before changing the wrapper
- Command shape: `HOME=/tmp/aca-c5-c3-home-j9xD5T ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' python3 /home/blake/.claude/skills/orchestrate/scripts/run_orchestrate.py --project-dir /tmp/aca-c5-c3-ws-0Z191M --tasks-json /tmp/aca-c5-c3-tasks-kJd0Qx.json --allowed-tools make_directory,write_file,find_paths,read_file --max-steps 8 --max-tool-calls 8 --max-total-tokens 80000 --timeout-ms 180000 --concurrency 2`
- Workspace / HOME isolation: isolated temp workspace `/tmp/aca-c5-c3-ws-0Z191M` and isolated temp `HOME` `/tmp/aca-c5-c3-home-j9xD5T`
- Expected result: if the residual is still real, each nested delegate artifact will over-report both new session dirs instead of its own task-matched session
- Actual result: the residual reproduced exactly; both nested delegate artifacts reported the same two `new_session_dirs`, so per-task session attribution was still coarse under shared `HOME`
- Evidence:
  - result JSON `/tmp/orchestrate-result-1775710580314187695.json`
  - nested delegate result `/tmp/delegate-result-1775710580337747593.json`
  - nested delegate result `/tmp/delegate-result-1775710580338024687.json`
- Status: `observed`

- Scenario ID: `C5-LIVE-2`
- Milestone: `C5`
- Goal: prove the rebuilt delegate/orchestrate surface now attributes shared-`HOME` sessions to the correct task
- Command shape: `HOME=/tmp/aca-c5-c3-home-fixed-CLwkWT ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' python3 /home/blake/.claude/skills/orchestrate/scripts/run_orchestrate.py --project-dir /tmp/aca-c5-c3-ws-fixed-51vBS1 --tasks-json /tmp/aca-c5-c3-tasks-fixed-1CRWdM.json --allowed-tools make_directory,write_file,find_paths,read_file --max-steps 8 --max-tool-calls 8 --max-total-tokens 80000 --timeout-ms 180000 --concurrency 2`
- Workspace / HOME isolation: isolated temp workspace `/tmp/aca-c5-c3-ws-fixed-51vBS1` and isolated temp `HOME` `/tmp/aca-c5-c3-home-fixed-CLwkWT`
- Expected result: each nested delegate artifact reports its own `session_id` / `session_dir` and a single task-matched `new_session_dirs` entry
- Actual result: both nested delegate artifacts now emit exact `session_id` / `session_dir`, and each `new_session_dirs` list contains only the task-matched ACA session created for that delegated run
- Evidence:
  - result JSON `/tmp/orchestrate-result-1775710771408154096.json`
  - nested delegate result `/tmp/delegate-result-1775710771432316665.json`
  - nested delegate result `/tmp/delegate-result-1775710771431538923.json`
- Status: `passed`

- Scenario ID: `C5-LIVE-3`
- Milestone: `C5`
- Goal: prove the queued `C4` write-path session-noise residual is gone after narrowing durable task-state error tracking
- Command shape: `HOME=/tmp/aca-c5-c4-home-write-Pwnwwy ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' ACA_MODEL_DEFAULT='zai-org/glm-5.1' python3 /home/blake/.claude/skills/delegate/scripts/run_delegate.py --project-dir /tmp/aca-c5-c4-ws-write-k2xbZA --profile rp-researcher --allowed-tools read_file,find_paths,search_text,fetch_mediawiki_page,make_directory,write_file --max-steps 10 --max-tool-calls 20 --max-total-tokens 100000 --timeout-ms 300000 --network-mode open --thinking enabled --temperature 1.0 --required-output-path world/characters/lilith-asami.md --fail-on-rejected-tool-calls --task "Using only fetch_mediawiki_page against https://trinity-seven.fandom.com/api.php plus local file tools, research Lilith Asami and write exactly world/characters/lilith-asami.md as grounded Markdown. Do not write any other file. Keep Relationships compact with at most 6 important dynamics. Avoid Japanese script unless it is needed to disambiguate a named ability."`
- Workspace / HOME isolation: isolated temp workspace `/tmp/aca-c5-c4-ws-write-k2xbZA` and isolated temp `HOME` `/tmp/aca-c5-c4-home-write-Pwnwwy`
- Expected result: the required output file still succeeds, fallback still lands on `zai-org/glm-5`, and the session manifest ends with `openLoops: []` instead of a self-check `read_file` validation loop
- Actual result: the run succeeded, wrote the required character file, persisted `session_id = ses_01KNR9SE828V2R1KNEQK2QTCYN`, and the manifest durable task state ended with an empty `openLoops` array
- Evidence:
  - result JSON `/tmp/delegate-result-1775710811560060331.json`
  - output file `/tmp/aca-c5-c4-ws-write-k2xbZA/world/characters/lilith-asami.md`
  - session dir `/tmp/aca-c5-c4-home-write-Pwnwwy/.aca/sessions/ses_01KNR9SE828V2R1KNEQK2QTCYN`
  - manifest `/tmp/aca-c5-c4-home-write-Pwnwwy/.aca/sessions/ses_01KNR9SE828V2R1KNEQK2QTCYN/manifest.json`
- Status: `passed`

- Scenario ID: `C5-LIVE-4`
- Milestone: `C5`
- Goal: prove the queued `C4` discovery-path deferred-overflow noise is also gone in the built runtime
- Command shape: `HOME=/tmp/aca-c5-c4-home-discovery-Aw4Dza ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' python3 /home/blake/.claude/skills/delegate/scripts/run_delegate.py --project-dir /tmp/aca-c5-c4-ws-discovery-jT1ORe --profile rp-researcher --model zai-org/glm-5 --allowed-tools read_file,find_paths,search_text,fetch_mediawiki_page --max-steps 10 --max-tool-calls 20 --max-total-tokens 100000 --timeout-ms 300000 --network-mode open --thinking enabled --temperature 1.0 --task "Using only fetch_mediawiki_page against https://trinity-seven.fandom.com/api.php plus local file tools, produce a Markdown discovery brief for Trinity Seven. Do not write files. Use Trinity Seven, Arata Kasuga, Lilith Asami, Lieselotte Sherlock, Levi Kazama, Akio Fudo, Mira Yamana, Yui Kurata, Iscariot, Royal Biblia Academy, and Breakdown Phenomenon as the starting page set. The brief must include main character candidates, 4-6 high-value world/topic files, concrete source notes, and exact proposed output paths under world/characters/ and world/."`
- Workspace / HOME isolation: isolated temp workspace `/tmp/aca-c5-c4-ws-discovery-jT1ORe` and isolated temp `HOME` `/tmp/aca-c5-c4-home-discovery-Aw4Dza`
- Expected result: even if the model again front-loads more than 10 tool calls, the final durable task state should no longer keep fake open loops for neutral deferred overflow
- Actual result: the discovery brief succeeded with `12` accepted tool calls and `3` rejected calls, but the session manifest still ended with `openLoops: []`, so the old deferred-overflow noise is gone
- Evidence:
  - result JSON `/tmp/delegate-result-1775710999738867518.json`
  - session dir `/tmp/aca-c5-c4-home-discovery-Aw4Dza/.aca/sessions/ses_01KNR9Z5RAG2Z8W5R4VC3AQKN2`
  - manifest `/tmp/aca-c5-c4-home-discovery-Aw4Dza/.aca/sessions/ses_01KNR9Z5RAG2Z8W5R4VC3AQKN2/manifest.json`
- Status: `passed`

- Scenario ID: `C5-LIVE-5`
- Milestone: `C5`
- Goal: resolve the queued `C2` repro gap by checking whether a malformed or partial first-pass triage artifact can now be captured live and preserved
- Command shape: `CONSULT_ACA_MAX_STEPS=4 CONSULT_ACA_MAX_TOTAL_TOKENS=50000 CONSULT_LLM_TIMEOUT_S=180 ACA_BINARY='node /home/blake/projects/anothercodingagent/dist/index.js' python3 /home/blake/.codex/skills/consult/scripts/run_consult.py --mode aca --witnesses deepseek,kimi,qwen,gemma --pack-path src/cli/consult.ts --pack-path src/consult/context-request.ts --question "Review ACA's no-tools consult triage path. Focus on malformed or partial triage output risk, raw triage artifact preservation, and literal pseudo-tool markup like <invoke> or <tool_call>." --project-dir /home/blake/projects/anothercodingagent`
- Workspace / HOME isolation: repo workspace reused intentionally; no temp `HOME` requirement for consult
- Expected result: either clean triage with preserved raw artifact or a real first-pass malformed/partial triage capture that shows the retry/preservation path live
- Actual result: all four witnesses succeeded, the first triage artifact was partial and preserved at `triage.raw_path`, and ACA repaired it into a complete final triage report at `triage.path`; the raw and final reports differ on disk, which proves the live retry/preservation path instead of leaving it only test-covered
- Evidence:
  - result JSON `/tmp/aca-consult-result-1775711129314-59089.json`
  - raw triage artifact `/tmp/aca-consult-triage-raw-1775711129314-59089.md`
  - repaired final triage `/tmp/aca-consult-triage-1775711129314-59089.md`
- Status: `passed`

Residual note for `C5` live coverage:

- The queued residual bank from `C2` through `C4` is now closed under live proof rather than by assumption.
- `C2` is no longer just "test-covered": a real partial first-pass triage artifact was preserved and repaired live.
- `C3` no longer needs coarse wrapper interpretation: shared-`HOME` runs now expose exact per-task session attribution directly in the delegate artifact.
- `C4` no longer leaves fake durable open loops for neutral deferred overflow or same-turn `read_file` self-check validation misses.
- Remaining note: `consult_ring.py` is still a debug-only decision surface, but it is not part of the blocking audit queue.

## C7 Forced Emulation Validation

- Scenario ID: `C7-LIVE-1`
- Milestone: `C7`
- Goal: prove built `aca invoke` still executes a real tool under forced NanoGPT emulation after the parser/prompt hardening
- Command shape: built `invoke` with `context.model = "qwen/qwen3-coder-next"`, `context.profile = "general"`, `allowed_tools = ["read_file"]`, and a bounded heading-extraction task against `RP_AUTHORING_CONTRACT.md`
- Workspace / HOME isolation: repo workspace reused intentionally
- Expected result: one accepted `read_file` and exact final heading text
- Actual result: returned `# RP Knowledge Pack Authoring Contract` with one accepted `read_file`
- Evidence:
  - invoke response captured in shell history for the `C7` pass
- Status: `passed`

- Scenario ID: `C7-LIVE-2`
- Milestone: `C7`
- Goal: prove `rp-research --model <id>` no longer silently falls back to `glm-5`
- Command shape: `node dist/index.js rp-research "Tiny Test" --project-root /tmp/aca-c7-model-fixed --discover-only --refresh-discovery --model not-real/test --network-mode open --max-steps 1 --max-tool-calls 1 --json`
- Workspace / HOME isolation: isolated temp project root `/tmp/aca-c7-model-fixed`
- Expected result: fast invalid-model failure before any executor session is created
- Actual result: failed fast with `llm.invalid_request: Model not supported`; no new `/tmp/aca-c7-model-fixed` executor session appeared under `~/.aca/sessions`
- Evidence:
  - stderr from the built command
  - absence of a new `/tmp/aca-c7-model-fixed` manifest under `~/.aca/sessions`
- Status: `passed`

- Scenario ID: `C7-LIVE-3`
- Milestone: `C7`
- Goal: prove the witness-profile tool path still works on forced emulation
- Command shape: built `invoke` with `context.model = "qwen/qwen3-coder-next"`, `context.profile = "witness"`, `allowed_tools = ["read_file"]`, and a bounded heading-extraction task against `RP_AUTHORING_CONTRACT.md`
- Workspace / HOME isolation: repo workspace reused intentionally
- Expected result: one accepted `read_file` and exact final heading text
- Actual result: returned `# RP Knowledge Pack Authoring Contract` with one accepted `read_file` and no rejected tools
- Evidence:
  - invoke response captured in shell history for the `C7` pass
- Status: `passed`

- Scenario ID: `C7-LIVE-4`
- Milestone: `C7`
- Goal: prove the `rp-researcher` write path still reaches real `write_file` under forced emulation
- Command shape: built `invoke` with `context.model = "qwen/qwen3-coder-next"`, `context.profile = "rp-researcher"`, `cwd = "/home/blake/projects"`, `allowed_tools = ["read_file","write_file"]`, `required_output_paths = ["/home/blake/projects/.aca-c7-rp-probe/royal-biblia-academy.md"]`, and a bounded rewrite task from `EXAMPLE/world/locations/royal_biblia_academy.txt`
- Workspace / HOME isolation: shared `/home/blake/projects` workspace with output under `/home/blake/projects/.aca-c7-rp-probe`
- Expected result: accepted `read_file` + `write_file`, required output created, and ideally a clean final response
- Actual result: the required output file was created and the session recorded accepted `read_file` + `write_file`, but the outer invoke ended with retryable `llm.malformed` after the write completed
- Evidence:
  - output file `/home/blake/projects/.aca-c7-rp-probe/royal-biblia-academy.md`
  - session dir `/home/blake/.aca/sessions/ses_01KNSWT69DH0TZHQ8GZR21BK1J`
  - manifest `/home/blake/.aca/sessions/ses_01KNSWT69DH0TZHQ8GZR21BK1J/manifest.json`
- Status: `observed`

- Scenario ID: `C7-LIVE-5`
- Milestone: `C7`
- Goal: prove the no-tools consult path still behaves cleanly on a local-file question without silently turning pseudo-tool intent into valid output
- Command shape: `node dist/index.js consult --question "Inspect the local file /home/blake/projects/anothercodingagent/RP_AUTHORING_CONTRACT.md and tell me its first Markdown heading." --witnesses deepseek --skip-triage --out /tmp/aca-c7-consult-deepseek.json`
- Workspace / HOME isolation: repo workspace reused intentionally
- Expected result: either disciplined `needs_context` or degraded pseudo-tool classification, but not a false direct answer
- Actual result: DeepSeek stayed disciplined, emitted a valid `needs_context` request for `RP_AUTHORING_CONTRACT.md:1-10`, ACA fulfilled the snippet, and the run completed without degradation
- Evidence:
  - result JSON `/tmp/aca-c7-consult-deepseek.json`
  - context-request artifact `/tmp/aca-consult-deepseek-context-request-1775764501922-6835.md`
  - final witness artifact `/tmp/aca-consult-deepseek-response-1775764501922-6835.md`
- Status: `passed`

- Scenario ID: `C7-LIVE-6`
- Milestone: `C7`
- Goal: run a small multi-model NanoGPT delegate bakeoff on the same forced-emulation read→write task
- Command shape: repeated `.codex` delegate-wrapper runs against `/home/blake/projects` with `allowed_tools = ["read_file","write_file"]`, required output paths under `/home/blake/projects/.aca-c7-bakeoff/`, and models `qwen/qwen3-coder-next`, `qwen/qwen3-coder`, `moonshotai/Kimi-K2-Instruct-0905`, and `zai-org/glm-5`
- Workspace / HOME isolation: shared `/home/blake/projects` workspace with disjoint output files under `.aca-c7-bakeoff/`
- Expected result: at least one successful full delegate read→write path, plus comparative signal on the current forced-emulation candidates
- Actual result:
  - `qwen/qwen3-coder-next`: aborted with retryable `llm.malformed` after the first accepted `read_file`
  - `qwen/qwen3-coder`: aborted with retryable `llm.malformed` after the first accepted `read_file`
  - `moonshotai/Kimi-K2-Instruct-0905`: completed the accepted `read_file` + `write_file` path and created `/home/blake/projects/.aca-c7-bakeoff/kimi-k2-0905.md`, but the written heading was paraphrased as `# RP Authoring Contract` instead of copying the exact first heading line
  - `zai-org/glm-5`: completed accepted `read_file` + `write_file` and created `/home/blake/projects/.aca-c7-bakeoff/glm-5.md` with the exact heading line `# RP Knowledge Pack Authoring Contract`
- Evidence:
  - Kimi delegate result `/tmp/delegate-result-1775764429818050640.json`
  - GLM delegate result `/tmp/delegate-result-1775764429847102983.json`
  - Qwen delegate result `/tmp/delegate-result-1775764388289912409.json`
  - Qwen3 delegate result `/tmp/delegate-result-1775764429812332631.json`
  - output file `/home/blake/projects/.aca-c7-bakeoff/kimi-k2-0905.md`
  - output file `/home/blake/projects/.aca-c7-bakeoff/glm-5.md`
- Status: `observed`

- Scenario ID: `C7-LIVE-7`
- Milestone: `C7`
- Goal: prove the no-tools consult path still degrades active pseudo-tool markup instead of treating it as valid witness output
- Command shape: `node dist/index.js consult --prompt-file /tmp/aca-c7-pseudo-tool-prompt.md --project-dir /home/blake/projects/anothercodingagent --witnesses qwen --out /tmp/aca-c7-pseudo-tool-qwen.json`
- Workspace / HOME isolation: repo workspace reused intentionally
- Expected result: the witness should be marked degraded if it emits active pseudo-tool markup in the no-tools context-request pass, and triage should still complete from the raw degraded artifact
- Actual result: Qwen emitted a long no-tools context-request reply containing active pseudo-tool markup copied into the response, ACA classified it as `pseudo-tool call emitted in no-tools context-request pass`, set `success_count: 0` / `degraded: true`, and still produced a successful triage report from the raw degraded artifact
- Evidence:
  - adversarial prompt `/tmp/aca-c7-pseudo-tool-prompt.md`
  - result JSON `/tmp/aca-c7-pseudo-tool-qwen.json`
  - degraded witness artifact `/tmp/aca-consult-qwen-context-request-1775765715695-8440.md`
  - triage raw `/tmp/aca-consult-triage-raw-1775765715695-8440.md`
  - triage final `/tmp/aca-consult-triage-1775765715695-8440.md`
- Status: `passed`

- Scenario ID: `C7-LIVE-8`
- Milestone: `C7`
- Goal: distinguish a remaining parser bug from a size-sensitive model/runtime-shape split on the built Qwen executor path
- Command shape: two built `invoke` runs with `context.model = "qwen/qwen3-coder-next"`, identical `allowed_tools = ["read_file","write_file"]`, identical `required_output_paths = ["out.md"]`, and the same heading-copy task against `source.md`, once with a tiny file and once with `RP_AUTHORING_CONTRACT.md`
- Workspace / HOME isolation: isolated temp HOME and workspaces at `/tmp/aca-c7-sizeprobe-small` and `/tmp/aca-c7-sizeprobe-large`
- Expected result: if the parser/runtime is still broken generically, both runs should fail in the same way; if the issue is model/runtime-shape sensitivity, the tiny run should behave materially better than the larger read-result run
- Actual result: the tiny-source path behaved materially better than the large-source path, but not perfectly. An initial built run completed with accepted `read_file` + `write_file` and final text `Completed. Extracted and wrote the first Markdown heading line (\`# Small Heading\`) to out.md.`. A follow-up rerun still wrote `/tmp/aca-c7-sizeprobe-small/out.md` with `# Small Heading`, but the outer invoke ended with retryable `llm.malformed`. By contrast, the large-source run aborted with retryable `llm.malformed` after the first accepted `read_file` and never wrote `out.md`. This supports a size-sensitive Qwen model/runtime-shape split and also leaves open a workflow-level salvage question once required outputs already exist
- Evidence:
  - tiny rerun response `/tmp/aca-c7-sizeprobe-small-response.json`
  - large rerun response `/tmp/aca-c7-sizeprobe-large-response.json`
  - tiny source `/tmp/aca-c7-sizeprobe-small/source.md`
  - tiny output `/tmp/aca-c7-sizeprobe-small/out.md`
  - large source `/tmp/aca-c7-sizeprobe-large/source.md`
  - large-run session under HOME `/tmp/aca-c7-sizeprobe-home-large/.aca/sessions/`
- Status: `observed`

Residual note for `C7` live coverage:

- The forced-emulation path is now re-proved live for built `invoke`, witness-profile tool use, fixed `rp-research --model` parsing, and successful delegate-wrapper runs on at least `Kimi-K2-Instruct-0905` and `glm-5`.
- The forced-emulation path is now re-proved live for built `invoke`, witness-profile tool use, fixed `rp-research --model` parsing, and full delegate-wrapper read→write completion on at least `Kimi-K2-Instruct-0905` and `glm-5`, but only the `glm-5` bakeoff run was exact on the bounded heading-copy task.
- Qwen-family delegate runs are still showing retryable `llm.malformed` aborts after the first accepted `read_file`, and the fresh built size probe now supports treating that as a size-sensitive model-quality/runtime-shape split rather than the original parser bug. The smaller-source probe is healthier, but not fully stable.
- The `rp-researcher` write path is live through accepted `write_file`, but the current Qwen probe still terminated badly after satisfying the required output.
- The no-tools consult pseudo-tool degradation branch now has a fresh live degraded replay on the rebuilt `C7` baseline.

## Executor Benchmarking

- Scenario ID: `EXECUTOR-BENCH-LIVE-1`
- Milestone: `post-M2 runtime benchmarking`
- Goal: compare the built `invoke` executor path on `qwen/qwen3-coder-next` vs `zai-org/glm-5` using the same bounded read-only tasks
- Command shape: repeated `node dist/index.js invoke` runs with explicit `context.model` overrides and identical allowed tool sets
- Workspace / HOME isolation: isolated temp HOME and temp workspace
- Expected result: enough live data to compare exact-output discipline, semantic correctness, and latency
- Actual result:
  - `qwen/qwen3-coder-next`: exact `0/3`, semantic `2/3`, avg elapsed `11.7s`
  - `zai-org/glm-5`: exact `1/3`, semantic `2/3`, avg elapsed `22.9s`
- Evidence:
  - artifact `/tmp/aca-executor-benchmark.json`
- Status: `recorded`

- Scenario ID: `EXECUTOR-BENCH-LIVE-2`
- Milestone: `post-M2 runtime benchmarking`
- Goal: compare the same two executor candidates on a deeper mix of read-only, write, and real bug-fix tasks
- Command shape: repeated built `invoke` runs across slash-command extraction, confusion-set extraction, consult-triage extraction, a write task, and a real bug-fix task
- Workspace / HOME isolation: isolated temp HOME and temp workspaces per task group
- Expected result: stronger signal for executor-default decisions than the shallow read-only benchmark
- Actual result:
  - `qwen/qwen3-coder-next`: exact `0/8`, semantic `3/8`, avg elapsed `39.3s`
  - `zai-org/glm-5`: exact `3/8`, semantic `4/8`, avg elapsed `40.0s`
  - most important signal: `zai-org/glm-5` passed the real bug-fix task exactly; `qwen/qwen3-coder-next` failed it
- Evidence:
  - artifact `/tmp/aca-executor-benchmark-deep.json`
- Status: `recorded`
