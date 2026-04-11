# M8.3 Handoff — Real Tool Execution

**Date:** 2026-04-04
**Status:** M8.2 complete. Ready for M8.3.

## What's Done (M8.2)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| One-shot with real NanoGPT | Complete | 1 |
| Session artifacts verified | Complete | 2 |
| Auth error → exit 4 | Complete | 2 |
| Invalid model → stderr error | Complete | 1 |
| lastError in TurnResult | Complete | 1 |
| Non-TTY stdin fix | Complete | 0 (manual) |
| Test isolation (temp HOME) | Complete | 0 (infra) |
| **Total** | **M8.2 complete** | **7 new, 2154 total** |

## What to Do Next (M8.3)

From `docs/steps/08-milestone8-standalone.md`:

- [ ] `aca "read the file package.json and tell me the project name"` → uses read_file tool, returns "anothercodingagent"
- [ ] `aca "create a file /tmp/aca-test-output.txt with the content 'hello from aca'"` → uses write_file, file exists after
- [ ] `aca "run the command 'echo hello world'"` → uses exec_command, output contains "hello world"
- [ ] Tool approval flow works: workspace-write tools prompt for confirmation (unless --no-confirm)
- [ ] `aca --no-confirm "create /tmp/aca-smoke.txt with 'smoke test'"` → auto-approves, file created
- [ ] Sandbox enforcement: write outside workspace → blocked with clear error
- [ ] SecretScrubber: API key doesn't appear in conversation.jsonl or stdout

**Tests (scripted integration):**
- read_file tool returns correct file content via real LLM
- write_file creates file at expected path
- exec_command runs and returns output
- conversation.jsonl contains tool_call and tool_result items
- Grep conversation.jsonl for NanoGPT API key → zero matches

## Dependencies

- NanoGPT API key in `~/.api_keys` (verified working in M8.2)
- Real API access (qwen/qwen3-coder confirmed working)
- Tool registry with all tools registered (from index.ts)
- Approval flow (M2.6) and sandbox (M2.4) already implemented

## File Locations

- Entry point: `src/index.ts` — tool registration at lines 361-399
- Tool implementations: `src/tools/` (read-file.ts, write-file.ts, exec-command.ts, etc.)
- Approval flow: `src/permissions/approval.ts`
- Sandbox: `src/permissions/workspace-sandbox.ts`
- Secret scrubber: `src/permissions/secret-scrubber.ts`
- Test pattern: `test/cli/first-run.test.ts` (use runAca helper with TEST_HOME isolation)

## Key Risks

- LLM may not reliably produce tool calls for simple prompts — may need prompt engineering or model selection
- Approval prompts need TTY — non-TTY tests must use `--no-confirm`
- Sandbox enforcement uses `checkZone()` which needs `workspaceRoot` — verify it's set correctly in one-shot mode
