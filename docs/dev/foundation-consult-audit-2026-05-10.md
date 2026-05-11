# Foundation Consult Audit - 2026-05-10

## Scope

Audited ACA foundations with `aca consult --witnesses default,dissent --triage never`, after changing `default` to the Kimi K2.6 + GLM 5.1 witness pair and `dissent` to DeepSeek V4 Pro.

Audit points:

- Witness defaults, dissent preset, raw model IDs, and NanoGPT model discovery.
- CLI routing, config precedence, secrets loading, and config snapshots.
- Runtime loop, conversation persistence, resume/replay, durable task state, and file activity state.
- Tool execution, workspace sandbox, shell/session handling, network policy, approvals, and secret scrubbing.
- Provider drivers, native/emulated tool calls, prompt assembly, output validation, and model capabilities.
- Consult context requests, evidence packs, structured review, delegation, and MCP.
- Observability, SQLite/debug UI surfaces, model catalog display, and indexing.
- Windows/Git/build/test operations and docs alignment.

Evidence directory:

```text
C:\Users\Blake\AppData\Local\Temp\aca-foundation-consult-audit-20260510-195939
```

## Consult Results

| Audit point | Result | Notes |
| --- | --- | --- |
| `witness-defaults-model-catalog` | 3/3 witnesses | GLM raised stale hardcoded non-witness model candidates; verified as not blocking consult defaults. |
| `cli-config-secrets` | 2/3 witnesses | GLM degraded on context-request format; Kimi raised Windows secrets/setup concerns. |
| `runtime-state-resume` | 2/3 witnesses | Kimi degraded; GLM/DeepSeek raised persistence caveats, mostly known/design-level. |
| `tool-permission-security` | 2/3 witnesses | DeepSeek degraded; several Kimi findings were rejected after local code verification. |
| `provider-toolcall-contracts` | 3/3 witnesses | Several findings came from truncated snippets and were rejected after local verification. |
| `consult-delegation-mcp` | 3/3 witnesses | Findings mostly design tradeoffs; no confirmed P0/P1 correctness bug. |
| `observability-debug-index` | 2/3 witnesses | Kimi degraded; accepted debug UI metadata and background writer resilience fixes. |
| `windows-git-build-tests-docs` | 3/3 witnesses | Accepted Windows temp-path and stale network-policy comment fixes. |

## Fixes Applied

- Consult defaults now use `kimi26,glm51`; DeepSeek V4 Pro is available via the `dissent` preset, and `full` expands to all three.
- `scripts/consult-live-canary.mjs` now uses `os.tmpdir()` for its default output directory instead of hardcoded POSIX `/tmp`.
- Debug UI metadata containing the local auth token is written with mode `0o600`.
- `BackgroundWriter` now retains queued observability events if a SQLite batch insert fails instead of dropping them.
- Network-policy top-level docs now match implemented shell network detection.
- M11 witness docs now describe the Kimi/GLM default pair plus DeepSeek dissent preset.

## Rejected Or Deferred Witness Claims

- Tool crash continuation was already guarded: `ToolRunner` marks mutating crashes/timeouts as `mutationState: 'indeterminate'`, and `TurnEngine` yields `tool_error`.
- Shell network detection already covers `git fetch`, `git push`, `apt-get`, and `brew`; only the header comment was stale.
- Static model fallback already includes `moonshotai/kimi-k2.6`, `zai-org/glm-5.1`, and `deepseek/deepseek-v4-pro`.
- Observability, debug UI, and indexing do have tests under `test/`; witnesses looked for colocated tests under `src/`.
- SQLite `sessions.pruned` exists through `runMigrations()`, even though it is not in the original DDL.
- Several provider/tool-call claims were based on truncated source around `nanogpt-driver.ts` and `invoke-output-validation.ts`; focused tests already cover those contracts.

## Validation

Focused validation passed:

```powershell
npm exec vitest -- run test/config/witness-models.test.ts test/cli/consult.test.ts test/cli/build.test.ts test/debug-ui/app-html.test.ts test/observability/sqlite-store.test.ts test/permissions/network-policy.test.ts
```

Result: 6 test files, 216 tests passed.

Full deterministic validation also passed:

```powershell
npm run verify
```

Result: typecheck, lint, 142 test files / 2945 tests, and build passed.

Built live consult smoke passed:

```text
default: 2/2 witnesses (kimi26, glm51)
default,dissent: 3/3 witnesses (kimi26, glm51, deepseek)
```
