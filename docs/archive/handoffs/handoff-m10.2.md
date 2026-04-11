# M10.2 Handoff — First Real Delegated Coding Task

**Date:** 2026-04-06
**Status:** M10.1c complete. Ready for M10.2.

## What's Done (M10.1c)

| Deliverable | Status | Tests |
|---|---|---|
| Part A1: Removed generic non-retryable tool error termination (only `mutationState='indeterminate'` terminates) | Done | 2 |
| Part A2: `assembleToolDefinitions()` filters by `allowedTools` before LLM request | Done | 3 |
| Part A3: Widened `CONFUSION_ERROR_CODES` to `{not_found, validation, execution, timeout, crash}` | Done | 1 (C1) |
| Part A4: `tool.crash` reports `mutationState='indeterminate'` for mutating tools | Done | 2 |
| Part A5: Masked-tool alternatives filtered by `allowedTools` | Done | 1 (C2) |
| Part B1: NanoGptCatalog → `/subscription/v1/models?detailed=true` | Done | URL assertion updated |
| Part B2: NanoGptCatalog empty-entries → fallback | Done | 1 |
| Part B3: Default model → `qwen/qwen3-coder-next` (CONFIG_DEFAULTS + Commander + invoke + models.json) | Done | config.test assertion updated |
| **Total** | **M10.1c complete** | **11 new, 2312 passing** |

### Key pipeline changes to be aware of in M10.2

1. **Tool errors are now non-fatal by default.** Delegated agents will see tool errors in the conversation and can course-correct. If M10.2 observes repeated identical failures, the widened confusion counter fires `llm.confused` after 3 consecutive errors (threshold preserved for recovery attempts).
2. **Constraints `allowed_tools` are now reflected in the API request.** When the MCP spawn path or invoke handler passes `allowed_tools`, the model only sees those tools in its tool list. This should materially improve tool-use accuracy on small-context models.
3. **Default model is `qwen/qwen3-coder-next`.** If M10.2 fails with this model, re-evaluate with `moonshotai/kimi-k2.5` as the first alternative (also works post-fixes per the harder benchmark).
4. **NanoGptCatalog now reports subscription-only models.** If a non-subscription model is requested, it will miss the catalog and fall back to StaticCatalog limits (which are reasonable defaults).

## What to Do Next (M10.2)

From `docs/steps/10-milestone10-payoff.md`:

- [ ] Claude designs a small feature (e.g., add a `/version` slash command to the REPL — BUT `/version` already exists per `src/cli/commands.ts:28`, pick a different small feature)
- [ ] Claude delegates implementation to ACA coder agent via `aca_run`
- [ ] ACA coder agent: reads existing code, writes the implementation, runs tests
- [ ] Claude reviews the result (either directly or via ACA witness agents)
- [ ] Iterate: if review finds issues, Claude sends feedback to a new ACA agent to fix
- [ ] Final: feature works, tests pass, code is clean

**Tests (manual end-to-end):**
- ACA coder agent produces working code that passes lint and tests
- ACA witness agent reviews the code and provides structured findings
- Claude makes the final accept/reject decision
- Total Opus context used is less than if Claude had written the code itself

### Candidate feature ideas (pick one)

Since `/version` already exists, choose something small but non-trivial:
- `/cost` — print current session cost from CostTracker
- `/model` — print the current model and capabilities (name, max context, max output, tool-calling native/emulated)
- `/clear` — clear REPL history for the current session (without ending the session)
- `/history` — print the last N user/assistant messages from the current session

Small scope, isolated change, measurable success (new command works + existing tests still pass). Pick one that exercises the `coder` profile's full toolkit (read_file, search_text, edit_file, exec_command for running tests).

## Dependencies

- **M10.1c** (done): TurnEngine error recovery + model default change
- **M10.1b** (done): MCP spawn path hardened
- **M10.1** (done): witness profile and ACA mode
- **M9.2** (done): Claude Code integration with `aca_run` tool
- **M8.3** (done): Real tool execution with live LLM

## File Locations

- **Delegate skill**: `~/.claude/skills/delegate/SKILL.md` (the workflow for invoking ACA via aca_run)
- **MCP server**: `src/mcp/server.ts`
- **Invoke handler**: `src/index.ts` (the `invoke` command, around line 894+)
- **Coder profile**: `src/delegation/agent-registry.ts` (peer-level tool set from M11.7)
- **TurnEngine**: `src/core/turn-engine.ts` (error handling + tool filtering — just modified in M10.1c)

## Known Caveats

- **Model validation n=1**: qwen/qwen3-coder-next was picked based on a 2-task benchmark with one sample per task per model. M10.2 will be the first real-world validation across multiple realistic tasks. If the model underperforms, the pick should be revisited.
- **qwen/qwen3-coder-next may inherit the >5-tool XML bug** from its lineage. M10.1c Part A2 (tool filtering) mitigates this for delegation scenarios where `allowed_tools` narrows the set, but a coder-profile delegation uses ~25 tools. Watch for XML-format responses during the first M10.2 run.
- **NanoGptCatalog pricing field mismatch** (pre-existing): pricing silently evaluates to 0 because the API uses `prompt`/`completion` but the parser reads `input`/`output`. Cost tracking will show 0 for NanoGPT-fetched pricing; static catalog fallback (for Anthropic/OpenAI models) still works correctly. Out of scope for M10.1c; flag for a follow-up substep.
- **Confusion counter widening may false-positive on legitimate multi-step exploration**. Threshold=3 preserves recovery, but if a model legitimately needs 4+ sequential tool calls with some failures (e.g., trying 4 paths before finding the right file), the counter fires early. Worth watching in M10.2 — if it becomes a problem, consider raising the threshold or refining the reset behavior.

## Quick Start for M10.2

1. Pick a feature from the candidate list above (or propose your own small feature)
2. In Claude Code, run the `/delegate` skill with the task
3. Observe: does the coder agent complete the task? Does `aca_run` return success?
4. If yes: run tests (`npm test`), review the diff, accept/reject
5. If no: examine stderr, check if it's a model quality issue (try kimi-k2.5) or a pipeline issue (check MCP spawn, invoke handler logs)
6. Record what worked and what didn't in the M10.2 changelog entry
