# M2.2 Handoff — Shell Execution Tools

**Date:** 2026-03-30
**Status:** M2.1 complete. Ready for M2.2.

## What's Done (M2.1)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `write_file` — create/overwrite, parent mkdir, sha256 hash, atomic 'wx' mode | Complete | 8 |
| `edit_file` — search/replace, expectedHash, applied/rejects report | Complete | 10 |
| `delete_path` — file/dir/recursive, item count | Complete | 7 |
| `move_path` — rename/move, conflict detection | Complete | 6 |
| `make_directory` — recursive parents, created flag | Complete | 5 |
| `stat_path` — lstat, kind/size/mtime/permissions | Complete | 5 |
| `find_paths` — glob walk, .gitignore, type filter, limit/truncation | Complete | 11 |
| `search_text` — regex/exact, file_globs, context lines, binary skip, limit | Complete | 13 |

**Total tests: 263 passing** (198 prior + 65 new).

**Consultation:** 4/4 witnesses, 1 rebuttal round. 4 fixes applied post-review.

## What to Do Next (M2.2)

Implement shell execution tools from `docs/steps/02-milestone2-tools-perms.md` ### M2.2.

### Tools to Implement

- **`exec_command`**: command, cwd, env, timeout → exit_code, stdout, stderr, duration. 64 KiB combined output cap with head+tail preservation. Default timeout 60s. `timeoutCategory: 'shell'`, `approvalClass: 'external-effect'`
- **`open_session`**: command, cwd, env → session_id, initial_output. Register in process registry. `approvalClass: 'external-effect'`
- **`session_io`**: session_id, stdin?, signal?, wait → incremental output, status. `approvalClass: 'external-effect'`
- **`close_session`**: session_id, signal? → final status. Kill process tree. `approvalClass: 'external-effect'`
- **Process registry**: track PID, process group, start time, idle TTL (1h), hard max (4h). Tree-kill via process group. Orphan cleanup on startup.

### Test Coverage Required

- `exec_command`: `echo hello` → stdout="hello\n" exit=0. `false` → exit=1. Timeout → `tool.timeout` + process killed. Output >64 KiB → truncated head+tail. stderr captured. Custom cwd. Custom env vars
- `open_session`: start `cat` → session_id returned, process running
- `session_io`: send stdin to cat → output returned. Send signal → status updated
- `close_session`: close cat → process killed, final status
- Process registry: register, list, orphan detection, idle TTL reap

## Dependencies

- `src/tools/tool-registry.ts` — `ToolSpec`, `ToolImplementation`, `ToolContext`
- `src/tools/tool-runner.ts` — `ToolRunner` (wraps with timeout + 64 KiB cap)
- **New**: process registry is a new stateful module: `src/tools/process-registry.ts`
- `child_process` from Node.js — `spawn`, `spawnSync` or `exec`

## File Locations

| New File | Purpose |
|----------|---------|
| `src/tools/exec-command.ts` | exec_command spec + implementation |
| `src/tools/process-registry.ts` | Shared process registry (session-scoped) |
| `src/tools/open-session.ts` | open_session spec + implementation |
| `src/tools/session-io.ts` | session_io spec + implementation |
| `src/tools/close-session.ts` | close_session spec + implementation |
| `test/tools/exec-command.test.ts` | Tests for exec_command |
| `test/tools/process-registry.test.ts` | Tests for process registry |
| `test/tools/open-session.test.ts` | Tests for open_session |
| `test/tools/session-io.test.ts` | Tests for session_io |
| `test/tools/close-session.test.ts` | Tests for close_session |

## Design Notes

- `exec_command` 64 KiB cap: collect all stdout+stderr, if over limit keep first 32 KiB + last 32 KiB (head+tail). Errors cluster at end, so tail retention is important.
- Process registry is session-scoped — pass session context through `ToolContext`. The registry maps `sessionId → Map<sessionHandle, ProcessRecord>`.
- `open_session` uses `spawn` with `detached: false` (we want to kill the process tree). Track process group via `child.pid`.
- Tree-kill: `process.kill(-pgid, 'SIGTERM')` where `pgid` is the process group id.
- Idle TTL and hard max are enforced by a periodic sweep (or lazy check on access).
- `session_io` `wait` parameter: if true, block until output arrives or timeout. If false, return whatever is buffered immediately.
