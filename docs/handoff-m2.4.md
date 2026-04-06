# M2.4 Handoff — Workspace Sandbox

**Date:** 2026-03-30
**Status:** M2.3 complete. Ready for M2.4.

## What's Done (M2.3)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `analyzeCommand` pure function — 3 tiers, 9 facets | Complete | 25 |
| Forbidden patterns: rm -rf /, fork bomb, dd, mkfs, block device writes | Complete | 4 |
| High patterns: curl\|bash, sudo, git --force, git reset --hard, chmod -R 777, ~/.ssh/, npm -g | Complete | 5 |
| Context-aware rm: workspace relative vs. absolute/outside | Complete | 3 |
| Evasion: quote obfuscation, $() subshell, backtick subshell, $VAR expansion | Complete | 4 |
| `open_session` integration: forbidden command blocked before spawn | Complete | 1 |
| `session_io` integration: forbidden stdin blocked before delivery | Complete | 1 |

**Total tests: 328 passing** (303 prior + 25 new).

**Consultation:** 4/4 witnesses. 2 fixes post-review: backtick subshell (critical gap), npm --global long form.

## What to Do Next (M2.4)

Implement `WorkspaceSandbox` from `docs/steps/02-milestone2-tools-perms.md` ### M2.4.

### What to Build

Hard filesystem boundary enforcement for all file system tools.

```typescript
// Zone check for existing paths:
// resolve via fs.realpath, verify resolved path starts with allowed zone

// Zone check for create operations (path may not exist):
// resolve nearest existing ancestor, verify ancestor in zone,
// validate remaining components contain no traversal (..)

// Allowed zones:
// - workspaceRoot
// - ~/.aca/sessions/<ses_ULID>/
// - /tmp/aca-<ses_ULID>/
// - user-configured extraTrustedRoots

// Symlink handling: resolve target, deny if outside all zones
// Path traversal: ../ collapsed before zone check
```

### Integration

- All file system tools (`read_file`, `write_file`, `edit_file`, `delete_path`, `move_path`, `make_directory`, `stat_path`, `find_paths`, `search_text`) must call zone check before any operation
- `exec_command` is NOT sandboxed (policy-sandboxed via risk analyzer instead)

### Key Test Cases

- Path within workspace → allowed
- Path in session dir → allowed
- Path in scoped tmp → allowed
- Path in extraTrustedRoots → allowed
- `/etc/passwd` → denied with `tool.permission_denied`
- Path traversal `../../etc/passwd` from workspace → denied
- Symlink within workspace pointing outside → denied
- Symlink within workspace pointing inside → allowed
- `/tmp/random-dir` (not scoped) → denied
- `/tmp/aca-<correct_id>/file` → allowed
- `~/.ssh/id_rsa` → denied
- TOCTOU: atomic check-and-open with `O_NOFOLLOW` / `openat` pattern

## Dependencies

- All M2.1 file system tool implementations (`src/tools/*.ts`)
- Session ID available in `ToolContext.sessionId`
- `workspaceRoot` available in `ToolContext.workspaceRoot`

## File Locations

| File | Purpose |
|------|---------|
| `src/tools/workspace-sandbox.ts` | Zone check logic, new file |
| `src/tools/read-file.ts` | Add zone check call |
| `src/tools/write-file.ts` | Add zone check call |
| `src/tools/edit-file.ts` | Add zone check call |
| `src/tools/delete-path.ts` | Add zone check call |
| `src/tools/move-path.ts` | Add zone check call (both src + dst) |
| `src/tools/make-directory.ts` | Add zone check call |
| `src/tools/stat-path.ts` | Add zone check call |
| `src/tools/find-paths.ts` | Add zone check call |
| `src/tools/search-text.ts` | Add zone check call |
| `test/tools/workspace-sandbox.test.ts` | All sandbox test cases |
