# Foundation Review - 2026-05-10

## Scope

Reviewed the core foundations for the Windows migration and ongoing development:

- Runtime loop, conversation items, turn outcomes, tool calls, and persistence.
- Secret scrubbing through conversation, runtime event, and terminal paths.
- Permission, approval, network, sandbox, and command-risk boundaries.
- Project root detection, git state detection, checkpoint scoping, and repo safety.
- CLI, invoke, REPL, MCP, provider, delegation, indexing, observability, and build/test wiring.
- Foundation docs/spec drift against current implementation.

## Fixes Applied

- Scrubbed `TurnEngine` observability and storage copies before event/log persistence:
  - `turn.started.inputPreview` now uses scrubbed user input.
  - Stored assistant tool-call arguments are scrubbed.
  - `tool.started` and `tool.completed` events receive scrubbed argument/output copies.
  - Tool execution still receives raw arguments, preserving behavior.
  - Provider runtime error messages are scrubbed before emission.
- Extended shell network detection to match the documented common egress set:
  - Added `git fetch`, `git push`, `apt-get install/update/upgrade`, and `brew install/update/upgrade`.
- Fixed Windows shell context:
  - CLI/REPL/invoke prompt context now uses `SHELL`, then Windows `ComSpec`/`COMSPEC`, then `cmd.exe`, instead of reporting `unknown` on Windows.
- Fixed ancestor-git leakage on Windows:
  - Project git state now only reports git for the requested project root, not an ancestor repo.
  - Project root detection will not select the user home directory as a project root.
  - Checkpoint auto-init now initializes the requested workspace if it is merely inside an ancestor repo.
- Aligned foundation docs with implemented permission semantics:
  - `confirm_always` is documented.
  - `--no-confirm` does not bypass `confirm_always` or high-risk shell commands by itself.
- Removed stale `TurnOutcome` value-count comment.

## Health Assessment

The main foundations are in good shape after this pass:

- Conversation/session persistence has second-turn and resume coverage.
- Tool result envelopes and runtime limits are enforced centrally in `ToolRunner`/`TurnEngine`.
- Approval and sandbox behavior is explicit and covered by focused tests.
- Windows process cleanup uses platform-specific process tree handling.
- Build/test/package wiring now passes on Windows with the full deterministic verification suite.

Remaining caveats:

- Streaming text delta scrubbing is still per-chunk. A secret split across provider chunks can evade redaction until a streaming-window scrubber is implemented.
- `exec_command` remains policy-sandboxed, not filesystem-sandboxed. That is documented architecture, not a hidden guarantee.
- WSL/Linux paths remain intended-supported, but this pass verified Windows locally; WSL was not rerun here.

## Validation

Full deterministic verification passed on Windows:

```powershell
npm run verify
```

Result:

- Typecheck passed.
- ESLint passed.
- Vitest passed: 141 files, 2931 tests.
- Build passed via `tsup`.

Additional focused checks were run while debugging:

```powershell
npm exec vitest -- run test/core/turn-engine.test.ts test/permissions/secret-scrubber.test.ts
npm exec vitest -- run test/permissions/network-policy.test.ts test/permissions/network-egress-integration.test.ts test/permissions/approval.test.ts
npm exec vitest -- run test/core/session-resume.test.ts test/core/path-comparison.test.ts test/tools/workspace-sandbox.test.ts
npm exec vitest -- run test/cli/invoke-runtime-state.test.ts test/cli/invoke-tooling.test.ts test/cli/executor.test.ts
npm exec vitest -- run test/providers/tool-calling-contract.test.ts test/providers/tool-emulation.test.ts test/providers/openai-driver.test.ts test/providers/anthropic-driver.test.ts test/providers/nanogpt-driver.test.ts
npm exec vitest -- run test/delegation/spawn-agent.test.ts test/delegation/agent-runtime.test.ts test/delegation/approval-routing.test.ts test/delegation/await-agent.test.ts test/delegation/message-agent.test.ts
npm exec vitest -- run test/mcp/server.test.ts test/integration/wiring.test.ts test/integration/smoke.test.ts
npm exec vitest -- run test/core/project-awareness.test.ts test/checkpointing/checkpoint-manager.test.ts
```
