# M2.6 Handoff — Approval Flow

**Date:** 2026-03-30
**Status:** M2.5 complete. Ready for M2.6.

## What's Done (M2.5)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| JSON Schema definition + ajv validation | Complete | 3 |
| 5-source precedence (CLI > env > project > user > defaults) | Complete | 5 |
| Trust boundary filtering (allowlist, silently drops user-only fields) | Complete | 4 |
| Merge semantics (deep-merge, arrays=replace, permissions=most-restrictive-wins) | Complete | 8 |
| `ACA_` prefix env var mapping (13 vars) | Complete | 4 |
| `ResolvedConfig` type: frozen, immutable | Complete | 2 |
| 9-step config loading pipeline | Complete | 7 |
| Secrets loading (env vars + secrets.json with 0600 check) | Complete | 5 |
| Config drift detection | Complete | 3 |
| `trustedWorkspaces` map + expanded schema | Complete | 1 |
| `providers` array config | Complete | 1 |
| Prototype pollution guard (`__proto__` skip) | Complete | 1 |

**Total tests: 414 passing** (370 prior + 44 new).

**Consultation:** 4/4 witnesses. 2 consensus fixes applied (__proto__ guard, fail-closed validation).

## What to Do Next (M2.6)

Implement the Approval Flow — permission resolution for each tool call. Depends on M2.5 (config) for resolved policy.

### What to Build

- Approval classes per tool: read-only (auto), workspace-write (confirm), external-effect (confirm), user-facing (interactive)
- 7-step approval resolution algorithm: profile check → sandbox check → risk analysis → class-level policy → pre-auth match → session grants → final decision
- Session grants: fingerprinted by tool+pattern, persist within session
- `--no-confirm` flag: auto-approve `confirm`, never override `confirm_always` or `deny`
- Interactive confirmation prompt: `[y] approve [n] deny [a] always [e] edit`
- `[a] always` creates session grant
- `confirm_always` approval level for destructive operations (delete_path, move_path)

### Key Test Cases

- read_file → auto-approved (read-only class)
- write_file → requires confirmation (workspace-write)
- exec_command with `--no-confirm` → auto-approved
- Forbidden command with `--no-confirm` → still denied
- delete_path/move_path with `--no-confirm` → still requires confirmation (confirm_always)
- Session grant: approve with [a] → next same call auto-approved
- Pre-auth rule matching: regex patterns
- Profile/sandbox/risk checks block before approval

## Dependencies

- `src/config/loader.ts` — `loadConfig()` produces `ResolvedConfig` with permissions, preauth rules
- `src/tools/tool-registry.ts` — `ApprovalClass`, `ToolSpec`
- `src/tools/command-risk-analyzer.ts` — risk analysis for exec_command/open_session/session_io
- `src/tools/workspace-sandbox.ts` — `checkZone()` for sandbox check

## File Locations

| File | Purpose |
|------|---------|
| `src/permissions/approval.ts` | 7-step approval resolution algorithm |
| `src/permissions/session-grants.ts` | Session grant storage and matching |
| `src/permissions/preauth.ts` | Pre-authorization rule matching |
| `test/permissions/*.test.ts` | All approval flow test cases |
