# M2.5 Handoff — Configuration System

**Date:** 2026-03-30
**Status:** M2.4 complete. Ready for M2.5.

## What's Done (M2.4)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `checkZone(path, context)` — zone check with realpath resolution | Complete | 14 |
| 4 allowed zones (workspace, session dir, scoped tmp, extraTrustedRoots) | Complete | 7 |
| Symlink handling — resolve target, deny if outside zones | Complete | 4 |
| Path traversal — `../` collapsed before zone check | Complete | 3 |
| Null byte injection guard | Complete | 3 |
| sessionId format validation in computeZones | Complete | 1 |
| extraTrustedRoots validation (absolute, not /, no null bytes) | Complete | 3 |
| Integration into all 9 file system tools | Complete | 7 |

**Total tests: 370 passing** (328 prior + 42 new).

**Consultation:** 4/4 witnesses. 3 consensus fixes applied (null byte, sessionId, extraTrustedRoots). TOCTOU deferred (3-1 consensus: acceptable for threat model).

## What to Do Next (M2.5)

Implement the full configuration loading pipeline from `docs/steps/02-milestone2-tools-perms.md` ### M2.5.

### What to Build

Full config system with 5-source precedence, trust boundary filtering, and frozen resolved config.

- JSON Schema definition for config (using `ajv` for validation)
- 5-source precedence: CLI flags > env vars > project config > user config > defaults
- Trust boundary filtering: project-safe schema (subset), silently drop disallowed fields
- Merge semantics: scalars=last-wins, objects=deep-merge, arrays=replace, permissions=most-restrictive-wins
- `ACA_` prefix env var mapping
- `ResolvedConfig` type: frozen, immutable for session duration
- 9-step config loading pipeline
- Secrets loading: env vars primary, `~/.aca/secrets.json` fallback, 0600 permission check
- Config drift detection on resume
- `trustedWorkspaces` map in user config
- `providers` array config (Block 17)

### Key Test Cases

- Defaults only → valid ResolvedConfig
- 5-level precedence chain (CLI > env > project > user > defaults)
- Project config with disallowed fields → silently dropped
- Permission arrays: denyDomains union, allowDomains intersection, blockedTools union
- Malformed configs → warning + fallback
- Secrets file permissions (0600 required)
- Frozen config → TypeError on mutation
- Trust boundary completeness (user-only fields dropped from project config)

## Dependencies

- `ajv` package (may need to install)
- Existing `ToolContext.extraTrustedRoots` — config system will populate this field
- `workspaceRoot` and `sessionId` already threaded through ToolContext

## File Locations

| File | Purpose |
|------|---------|
| `src/config/schema.ts` | JSON Schema definition, ResolvedConfig type |
| `src/config/loader.ts` | 9-step loading pipeline |
| `src/config/merge.ts` | Merge semantics (deep merge, most-restrictive permissions) |
| `src/config/secrets.ts` | Secrets loading (env vars + secrets.json) |
| `src/config/trust-boundary.ts` | Project config filtering |
| `test/config/*.test.ts` | All config test cases |
