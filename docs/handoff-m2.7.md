# M2.7 Handoff — Network Egress Policy Foundation

**Date:** 2026-03-30
**Status:** M2.6 complete. Ready for M2.7.

## What's Done (M2.6)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| 7-step approval resolution algorithm | Complete | 18 |
| Session grants (fingerprinted by tool+pattern) | Complete | 12 |
| Pre-auth rule matching (commandRegex, cwdPattern) | Complete | 16 |
| confirm_always escalation (delete_path, move_path) | Complete | 9 |
| --no-confirm flag semantics | Complete | 6 |
| Interactive confirmation prompt formatting | Complete | 3 |
| Prompt response parsing ([y]/[n]/[a]/[e]) | Complete | 8 |
| Config override validation (invalid values ignored) | Complete | 2 |
| Consultation fixes (confirm_always guard, empty cmd normalization) | Complete | 9 |

**Total tests: 497 passing** (414 prior + 83 new).

**Consultation:** 4/4 witnesses, immediate consensus. 4 fixes applied (session grant bypass, override validation, empty string normalization, regex length limit).

## What to Do Next (M2.7)

Implement the Network Egress Policy Foundation — domain-level network access control. Depends on M2.5 (config) for `network` settings and M2.6 (approval) for integration.

### What to Build

- `NetworkPolicy` type: mode (`off`, `approved-only`, `open`), allowDomains (glob[]), denyDomains (glob[]), allowHttp (boolean)
- Policy resolver: read from `ResolvedConfig`, evaluate domain against allow/deny lists
- 3 modes: `off` → all network denied, `approved-only` → allowlist or confirmation, `open` → allowed (still subject to denyDomains)
- denyDomains takes precedence over allowDomains
- Localhost exception: `127.0.0.1`, `::1`, `localhost` auto-allowed in all modes except `off`
- HTTPS-only default: HTTP URLs denied unless `allowHttp: true`
- Best-effort shell command detection: `curl`, `wget`, `ssh`, `git clone`, `npm install` in `exec_command` → evaluate against network policy
- Integration point: `ToolRunner` calls network policy check before executing network-capable tools

### Key Test Cases

- Mode=off → network tools return `network_disabled` error
- Mode=approved-only, domain in allowDomains → auto-allowed
- Mode=approved-only, domain in denyDomains → denied
- Mode=approved-only, unknown domain → requires confirmation
- Mode=open → all allowed (still subject to denyDomains)
- denyDomains precedence: domain in both allow and deny → denied
- Localhost → auto-allowed in approved-only and open modes
- HTTP URL with allowHttp=false → denied with clear error
- 5 shell command detection tests (curl, wget, ssh, git clone, npm install)

## Dependencies

- `src/config/schema.ts` — `ResolvedConfig.network` (mode, allowDomains, denyDomains, allowHttp)
- `src/permissions/approval.ts` — `resolveApproval()` for approval integration
- `src/tools/command-risk-analyzer.ts` — existing `network_download` facet detection

## File Locations

| File | Purpose |
|------|---------|
| `src/permissions/network-policy.ts` | NetworkPolicy type, domain resolver, mode evaluation |
| `test/permissions/network-policy.test.ts` | All network policy test cases |
