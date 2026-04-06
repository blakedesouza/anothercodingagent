# ACA Implementation Steps — Milestone 9: The Bridge (Claude → ACA)

Make Claude Code able to invoke ACA as a tool. The bridge is an MCP server that wraps `aca invoke --json`, so Claude can delegate tasks to ACA agents without holding file contents or tool calls in its own context.

**Test framework:** vitest + manual Claude Code verification
**Test location:** `test/` mirroring `src/` structure
**Prerequisite:** M8 complete (ACA runs standalone)

---

## Milestone 9: Claude → ACA Bridge

### M9.1 — MCP Server for ACA

- [x] Create `src/mcp/server.ts` — MCP server using `@modelcontextprotocol/sdk`
- [x] Expose `aca_run` tool: takes `task` (string), optional `allowed_tools` (string[]), optional `timeout_ms` (number)
- [x] `aca_run` invokes `aca invoke --json` as a subprocess with the task mapped to InvokeRequest
- [x] Capture stdout (JSON response), parse InvokeResponse, return result text to Claude
- [x] Capture stderr for errors, surface in MCP error response
- [x] Timeout: configurable deadline (default 5 min), maps to InvokeRequest.deadline
- [x] Add `aca serve` CLI command that starts the MCP server on stdio transport
- [x] Package.json: add `@modelcontextprotocol/sdk` and `zod` dependencies

**Tests:**
- MCP server starts and responds to `tools/list` → includes `aca_run`
- `aca_run` with simple task → subprocess invoked, result returned
- `aca_run` with timeout → deadline propagated to invoke, timeout error returned
- `aca_run` with bad task → error response with useful message
- `aca_run` captures token usage from InvokeResponse.usage

### M9.2 — Claude Code Integration

- [x] Create `.claude/settings.json` (or user-level) MCP server config pointing to `aca serve`
- [x] Verify Claude Code discovers `aca_run` tool
- [x] Test: ask Claude "use aca_run to read package.json and tell me the version" → ACA reads file, returns result
- [x] Authority mapping: `allowed_tools` parameter restricts what the ACA agent can do
- [x] Error propagation: ACA error → Claude sees structured error, can retry or adjust
- [x] Create `/delegate` skill that wraps `aca_run` with task decomposition prompts

**Tests (manual + scripted):**
- Claude Code shows `aca_run` in tool list
- Round-trip: Claude → aca_run → ACA reads file → result flows back to Claude
- `allowed_tools: ["read_file", "search_text"]` → ACA agent can only use those tools
- ACA timeout → Claude gets error, doesn't hang

### M9.2b — Runtime Bug Hunt & Fix

Discovered during M9.2 manual verification: `aca invoke` returns empty success with 0 tokens (LLM never called), and pre-existing test failures in `test/cli/build.test.ts` and `test/cli/first-run.test.ts` confirm broader runtime issues.

- [x] Investigate `aca invoke` empty success: TurnEngine.executeTurn returns without calling LLM (0 input tokens)
- [x] Investigate pre-existing test failures: `build.test.ts` unknown subcommand exit code, `first-run.test.ts` missing assistant response in conversation.jsonl
- [x] Fix root causes — invoke path, one-shot path, or shared TurnEngine logic
- [x] Verify round-trip: `echo '{"contract_version":"1.0.0",...,"task":"Read package.json"}' | node dist/index.js invoke` returns actual LLM response
- [x] Verify via MCP: `aca_run` called from Claude Code returns real file content
- [x] All pre-existing test failures resolved
- [x] Full test suite green (no pre-existing failures)

**Tests:**
- `aca invoke` with simple task → non-empty result, non-zero token usage
- `aca "say hello"` one-shot → non-empty stdout
- Pre-existing test failures in build.test.ts and first-run.test.ts pass
- MCP round-trip: Claude → aca_run → actual result

### M9.3 — Multi-Agent Orchestration

- [x] Claude spawns 2+ ACA tasks in parallel (via multiple `aca_run` calls)
- [x] Each ACA task runs in its own subprocess with its own session
- [x] Results from parallel tasks are collected and synthesized by Claude
- [x] Cost tracking: each invoke returns token usage, Claude can track total delegation cost
- [x] Create `/orchestrate` skill that plans → delegates → reviews → synthesizes

**Tests (manual):**
- Two parallel aca_run calls complete independently
- Claude synthesizes results from both
- Token usage from both reported correctly

### M9.3b — Delegated Tool Approval Bug Fix

Discovered during M9.3 live testing: `exec_command` (and likely all approval-requiring tools) fail with `tool_error` in delegated ACA sessions. The MCP server spawns `aca invoke` but the approval flow doesn't auto-approve tools in headless ephemeral sessions.

- [x] Investigate: trace `exec_command` failure path in invoke mode (is `--no-confirm` wired through to ApprovalFlow?)
- [x] Fix: ensure delegated invoke sessions auto-approve tools within the `allowed_tools` constraint
- [x] Verify: `aca_run` with `allowed_tools: ["exec_command"]` succeeds on a simple command
- [x] Verify: `aca_run` with `allowed_tools: ["write_file"]` succeeds on a file write
- [x] Test: parallel delegation with write tools works end-to-end

**Tests:**
- `aca_run` with exec_command task → success (not tool_error)
- `aca_run` with write_file task → success
- Approval-requiring tools respect allowed_tools constraint (denied tools still denied)

---

## Post-Milestone Review (M9)
<!-- risk: medium — MCP integration, subprocess management -->
<!-- final-substep: M9.3b -->
- [x] Architecture review (4 witnesses): MCP contract, subprocess lifecycle, error handling
- [x] Bug hunt (4 witnesses): process leaks, timeout edge cases, concurrent invocations
- [x] Critical findings fixed and verified
- [x] Review summary appended to changelog
