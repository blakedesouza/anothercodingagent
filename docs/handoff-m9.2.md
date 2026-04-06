# M9.2 Handoff — Claude Code Integration

**Date:** 2026-04-05
**Status:** M9.1 complete. Ready for M9.2.

## What's Done (M9.1)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `src/mcp/server.ts` — MCP server | Complete | 12 |
| `aca_run` tool (task, allowed_tools, timeout_ms) | Complete | 8 |
| `aca serve` CLI command (stdio transport) | Complete | — |
| `parseInvokeOutput` response parser | Complete | 5 |
| `runAcaInvoke` with DI spawn | Complete | 4 |
| Graceful shutdown (child tracking) | Complete | — |
| @modelcontextprotocol/sdk + zod deps | Complete | — |
| **Total** | **M9.1 complete** | **17 new, 2178 total** |

## What to Do Next (M9.2)

From `docs/steps/09-milestone9-bridge.md`:

- [ ] Create `.claude/settings.json` (or user-level) MCP server config pointing to `aca serve`
- [ ] Verify Claude Code discovers `aca_run` tool
- [ ] Test: ask Claude "use aca_run to read package.json and tell me the version" → ACA reads file, returns result
- [ ] Authority mapping: `allowed_tools` parameter restricts what the ACA agent can do
- [ ] Error propagation: ACA error → Claude sees structured error, can retry or adjust
- [ ] Create `/delegate` skill that wraps `aca_run` with task decomposition prompts

Tests (manual + scripted):
- Claude Code shows `aca_run` in tool list
- Round-trip: Claude → aca_run → ACA reads file → result flows back to Claude
- `allowed_tools: ["read_file", "search_text"]` → ACA agent can only use those tools
- ACA timeout → Claude gets error, doesn't hang

## Dependencies

- M9.1 MCP server (`src/mcp/server.ts`)
- Built binary (`npm run build` → `dist/index.js`)
- NanoGPT API key configured
- Claude Code installed and running

## File Locations

- MCP server: `src/mcp/server.ts`
- CLI entry: `src/index.ts` (serve command at ~line 830)
- Executor: `src/cli/executor.ts` (InvokeRequest/Response types)
- Build output: `dist/index.js` (the aca binary)
- Test pattern: `test/mcp/server.test.ts`
