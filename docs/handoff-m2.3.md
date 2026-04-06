# M2.3 Handoff — Command Risk Analyzer

**Date:** 2026-03-30
**Status:** M2.2 complete. Ready for M2.3.

## What's Done (M2.2)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `exec_command` — shell execution, 62 KB head+tail cap, timeout, tree-kill | Complete | 10 |
| `open_session` — persistent shell spawn, 10 MiB buffer cap, promise-safe | Complete | 5 |
| `session_io` — buffered read/write, wait support, drain resets byte counter | Complete | 6 |
| `close_session` — idempotent close, SIGTERM + 5s + SIGKILL fallback | Complete | 5 |
| `ProcessRegistry` — session-scoped, idle TTL 1h, hard max 4h, orphan reap | Complete | 14 |

**Total tests: 303 passing** (263 prior + 40 new).

**Consultation:** 4/4 witnesses. 3 fixes applied post-review: promise leak (critical), unbounded output buffer (critical), stream destroy on timeout (improvement).

## What to Do Next (M2.3)

Implement `CommandRiskAnalyzer` from `docs/steps/02-milestone2-tools-perms.md` ### M2.3.

### What to Build

Pure function `analyzeCommand(command: string, cwd: string, env?: Record<string,string>) → CommandRiskAssessment`.

```typescript
export type RiskTier = 'forbidden' | 'high' | 'normal';

export type RiskFacet =
    | 'filesystem_delete'
    | 'filesystem_recursive'
    | 'network_download'
    | 'pipe_to_shell'
    | 'privilege_escalation'
    | 'credential_touch'
    | 'global_config_write'
    | 'history_rewrite'
    | 'package_install';

export interface CommandRiskAssessment {
    tier: RiskTier;
    facets: RiskFacet[];
    reason: string;
}
```

### Risk Tiers

- **forbidden**: `rm -rf /`, `rm -rf ~`, `/dev/sd*` writes, `mkfs.*`, fork bombs (`:(){ ... }:`), `dd if=* of=/dev/`
- **high**: `curl|bash`, `sudo`, `git push --force`, `git reset --hard`, `chmod -R 777`, writes to `~/.ssh/`, `npm install -g`
- **normal**: `npm test`, `git status`, `ls`, `python script.py`

### Context Awareness

- `rm -rf node_modules` or `rm -rf ./build` with cwd inside a workspace → normal
- Same command with cwd `/` or outside workspace → high
- Workspace detection: cwd is "inside workspace" if it starts with workspaceRoot

### Evasion Detection

- Command obfuscation: `r'm' -rf /` → forbidden (strip shell quoting before pattern match)
- Subshell substitution: `$(echo rm) -rf /` → forbidden (detect `$(...)` with destructive payload)
- Variable expansion — 3 forms:
  - `$CMD -rf /` → minimum `high` (unresolvable variable in destructive position)
  - `${CMD} -rf /` → same as above
  - `$(echo rm) -rf /` → forbidden

### Integration Points

- `open_session`: analyze `command` arg at spawn time. Forbidden → error before spawn.
- `session_io`: analyze `stdin` before delivery to shell. Forbidden → error, stdin NOT sent.

### New File

`src/tools/command-risk-analyzer.ts` — pure function export, no side effects, no I/O

### Test File

`test/tools/command-risk-analyzer.test.ts` — all test cases from step file (22+ assertions)

## Dependencies

- No new dependencies — pure regex/string logic
- `src/tools/exec-command.ts` — will be integrated in M2.6 (Approval Flow), not yet
- `src/tools/open-session.ts` — `open_session` integration can be added now
- `src/tools/session-io.ts` — `session_io` stdin analysis can be added now

## File Locations

| File | Purpose |
|------|---------|
| `src/tools/command-risk-analyzer.ts` | Pure risk analysis function |
| `test/tools/command-risk-analyzer.test.ts` | All 22+ test cases |

## Design Notes

- The analyzer is intentionally a pure function (no side effects) — makes it easy to test and compose
- Pattern matching should normalize the command string before testing: strip redundant quotes, collapse whitespace
- Subshell detection: scan for `$(...)` patterns, then classify the inner command using the same logic
- The "workspace context" parameter (`cwd`) is compared against a workspace root to determine if a potentially destructive operation is scoped
- Keep patterns as named constants (not inline regex literals) — they'll be extended in M7.8 (Secrets Scrubbing patterns share this registry)
