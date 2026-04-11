# M10.1 Handoff — Witness Agents with Tool Access

**Date:** 2026-04-05
**Status:** M9 complete (all substeps + post-milestone review). Ready for M10.1.

## What's Done (M9)

| Deliverable | Status | Tests |
|---|---|---|
| MCP Server (`src/mcp/server.ts`) | Complete | 17 |
| Executor Mode (`src/cli/executor.ts`) | Complete | 35 |
| Claude Code Integration (`.claude/settings.json`) | Complete | 9 |
| Runtime Bug Fixes (M9.2b) | Complete | 3 |
| Multi-Agent Orchestration (M9.3) | Complete | 6 |
| Delegated Tool Approval Fix (M9.3b) | Complete | 6 |
| Post-Milestone Review (arch + bug hunt) | Complete | 0 (fixes verified by typecheck) |

**Total tests:** 2202 passing.

## What to Do Next (M10.1)

### Witness Agents with Tool Access

1. Create `witness` agent profile in AgentRegistry: `read_file`, `search_text`, `find_paths`, `lsp_query` (read-only tools)
2. Modify `consult_ring.py` to support `--mode aca` flag: instead of raw NanoGPT API call, invoke `aca invoke --json` with witness model + tool access
3. Witness ACA agent gets: the review prompt as task, the workspace as context, read-only tools to explore the code
4. Witness output: same structured finding format (consult_ring.py handles parsing)
5. Fallback: if ACA invoke fails, fall back to raw NanoGPT call (current behavior)
6. Performance: ACA witness may take longer (tool calls) but produces more grounded reviews

### Tests

- `/consult --mode aca` invokes witnesses as ACA agents
- Witness uses read_file to examine actual source code (not just the inlined excerpt)
- Witness findings reference real file paths and line numbers from tool calls
- Fallback: ACA timeout → falls back to raw API call, still produces review
- Compare: same review prompt, ACA mode vs raw mode → ACA mode cites more specific evidence

## Dependencies

- AgentRegistry (`src/delegation/agent-registry.ts`) — add witness profile
- `consult_ring.py` (`~/.claude/skills/consult/consult_ring.py`) — add ACA mode
- MCP server (`src/mcp/server.ts`) — already supports `allowed_tools` constraint
- Executor mode (`src/cli/executor.ts` + `src/index.ts`) — already handles invoke with tool restrictions

## File Locations

- Agent profiles: `src/delegation/agent-registry.ts`
- Consult script: `~/.claude/skills/consult/consult_ring.py`
- MCP server: `src/mcp/server.ts`
- Executor/invoke: `src/index.ts` (lines 848-1052)

## Known Gaps from M9 Review

- `request.authority` parsed but not applied (only affects direct `aca invoke` callers, not MCP)
- `denied_tools` parsed but not used (`allowedTools` is the enforcement mechanism)
- These may need addressing if M10 witness agents use authority grants
