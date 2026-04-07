<!-- Source: fundamentals.md lines 859-1043 -->
### Block 8: Permission / Sandbox Model

Safety boundaries that cut across all tools and delegation. The agent may operate on untrusted repositories cloned from GitHub — a malicious `.aca/config.json` in a repo must not be able to auto-approve destructive commands, exfiltrate data, or escape the workspace. This block defines the enforcement layer; Block 9 defines where the policy settings live and how they are loaded.

**Core principle: compute effective authority per tool call, not per session.** Every tool invocation is evaluated against a runtime-resolved `EffectiveAuthority` that combines: agent profile tool permissions (intersection), inherited parent authority (for sub-agents), trusted config policy (from Block 9), and session grants (runtime approvals that persist within a session). The evaluation order for each tool call is: profile check, sandbox/resource check, risk analysis, pre-authorization/session grant match, then `allow | confirm | deny`.

**Foundational decisions:**

- **Workspace root enforcement is hard, not advisory.** All built-in file-system tools (`read_file`, `write_file`, `edit_file`, `delete_path`, `move_path`, `make_directory`, `stat_path`, `find_paths`, `search_text`) and `lsp_query` resolve paths to their canonical absolute form via `fs.realpath` before any operation. Access is denied unless the resolved path falls within an allowed zone. This is enforced in the Tool Runtime Contract layer — individual tool implementations never see paths outside allowed zones.

  **Allowed zones:**

  | Zone | Read | Write | Rationale |
  |---|---|---|---|
  | `workspaceRoot` and all descendants | yes | yes | Primary work area. Detected via Project Awareness (Block: Project Awareness) |
  | `~/.aca/sessions/<current_ses_ULID>/` | yes | yes | Current session's own data (scratch files, blobs) |
  | `/tmp/aca-<ses_ULID>/` | yes | yes | Scoped temporary directory, created on demand, cleaned on session end. Tools needing `/tmp` are redirected here — not bare `/tmp` |
  | User-configured `extraTrustedRoots` | yes | yes | Absolute paths the user explicitly trusts (e.g., a locally-linked package outside the project tree). User config only — project config cannot add these (Block 9) |

  **Everything else is denied**, including `~/.config`, `~/.ssh`, `~/.bashrc`, `/etc`, other users' home directories, and bare `/tmp`. The agent's own internal data at `~/.aca/` (outside the current session directory) is not accessible to tools — the runtime reads it directly, tools do not.

  **Symlink handling:** Symlinks within the workspace that resolve to a target outside all allowed zones are denied. The error message reports the symlink path and its resolved target so the user understands why. If a project has symlinks pointing to external paths (e.g., `node_modules` linking to a local package via `npm link`), the user adds the target to `extraTrustedRoots` in their user config. There is no "follow symlinks" toggle — resolution always happens, and the resolved path is always checked. This prevents escape-via-symlink attacks from untrusted repos.

  **Path traversal:** `../` sequences are collapsed by `fs.realpath` before the zone check. A tool call to `read_file("../../etc/passwd")` resolves to `/etc/passwd`, which is outside all zones, and is denied.

  **`exec_command` is NOT workspace-sandboxed at the filesystem level.** Shell commands run as the user's process and can access anything the user can. Filesystem sandboxing of arbitrary binaries would require OS-level isolation (containers, namespaces) that is out of scope for v1. `exec_command` is sandboxed by its approval class (`external-effect`) and the command risk analyzer described below. This is an explicit trade-off: built-in tools are hard-sandboxed, shell execution is policy-sandboxed.

- **Dangerous command detection uses a multi-tier `CommandRiskAnalyzer`, not a simple blocklist.** The analyzer runs on every `exec_command`, `open_session`, and `session_io` invocation before execution. It extracts a best-effort `argv[0]`, scans the raw shell text with pattern matching, and emits a structured risk assessment.

  **Three risk tiers:**

  | Tier | Behavior | Examples |
  |---|---|---|
  | `forbidden` | Hard deny. Never executed, even with `--no-confirm`. Not overridable by config | `rm -rf /`, `rm -rf ~`, writes to `/dev/sd*` or `/dev/nvme*`, `mkfs.*`, fork bombs (`:(){:|:&};:`), `dd if=* of=/dev/[sh]d*` |
  | `high` | Requires explicit user confirmation. `--no-confirm` can override (user assumes full risk). Pre-authorization rules can auto-approve specific patterns | `curl ... \| bash`, `wget -O- \| sh`, `sudo *`, `git push --force`, `git reset --hard`, `git clean -fdx`, `chmod -R 777`, `chmod` on paths outside workspace, writes to `~/.ssh/*`, `~/.bashrc`, `~/.gitconfig`, `npm install -g`, `pip install` without `--prefix`, `docker run -v /:/host` |
  | `normal` | Standard `external-effect` approval class. Auto-approvable via pre-authorization rules | `npm test`, `git status`, `ls`, `cat`, `python script.py`, `cargo build` |

  **Risk facets (not just binary risk):** The analyzer tags each command with zero or more facets: `filesystem_delete`, `filesystem_recursive`, `network_download`, `pipe_to_shell`, `privilege_escalation`, `credential_touch`, `global_config_write`, `history_rewrite`, `package_install`. Facets are informational — they feed into the confirmation prompt to explain *why* the command is flagged, and into the event log for audit. The risk tier is derived from which facets are present and their combination.

  **Context awareness:** The same command can have different risk depending on context:
  - `rm -rf node_modules` with cwd inside the workspace is `normal` (cleanup)
  - `rm -rf node_modules` with cwd at `/` is `high` (wrong directory)
  - `rm -rf /` is always `forbidden` regardless of cwd
  - `git push` is `normal`; `git push --force` is `high`
  - `curl https://example.com` is `normal`; `curl https://example.com | bash` is `high`

  The analyzer checks the cwd against the workspace root as part of its assessment. Commands that operate on paths outside the workspace are elevated one tier.

  **False positive mitigation:** The analyzer does not use entropy heuristics or fuzzy matching. Patterns are specific and tested. A command like `rm -rf ./build` inside the workspace matches the `filesystem_delete` + `filesystem_recursive` facets but resolves to `normal` tier because the target is within the workspace. Users who find a legitimate command incorrectly flagged can add a pre-authorization rule in their user config (Block 9). Project config cannot add pre-authorization rules.

  **Implementation:** The analyzer is a pure function: `(command: string, cwd: string, env: Record<string,string>) => CommandRiskAssessment`. It does not execute anything. It runs before the approval check so the risk tier can influence the approval decision.

- **Approval escalation composes the four approval classes with policy layers and session grants.** The approval classes defined in the Tool Surface block are the foundation. This section defines how policy turns them into runtime decisions.

  **Approval decision values:** `allow` (proceed without prompting), `confirm` (prompt user), `deny` (refuse, return error to model).

  **Resolution algorithm for each tool call:**

  1. **Profile check** — Is this tool in the agent's allowed tool set (profile intersection with any narrowing overrides)? If not, `deny` with reason "not permitted by agent profile"
  2. **Sandbox check** — For file-system tools, does the resolved path fall within an allowed zone? If not, `deny` with reason "outside workspace boundary"
  3. **Risk analysis** — For `exec_command`/`open_session`/`session_io`, run the `CommandRiskAnalyzer`. If `forbidden`, `deny` immediately. If `high`, set minimum decision to `confirm` (cannot be auto-approved unless the user has a matching pre-authorization rule and `--no-confirm` is active)
  4. **Class-level policy** — Look up the tool's approval class in the merged config:
     - `read-only`: `allow` (always, unless sandbox check failed above)
     - `workspace-write`: `confirm` by default. User config can set to `allow` for the class or per-tool. Delete and move operations escalate to `confirm` even if the class is set to `allow`, unless explicitly overridden per-tool
     - `external-effect`: `confirm` by default. User config can set pre-authorization rules (pattern-matched) that resolve to `allow`. Without a matching rule, always `confirm`
     - `user-facing`: always interactive — `ask_user` and `confirm_action` are inherently user-facing and never auto-approved or denied
  5. **Pre-authorization match** — Check user-config pre-authorization rules (Block 9). Rules are scoped: tool name, optional command regex (for exec_command), optional cwd pattern, optional path glob (for file tools). If a rule matches and its decision is `allow`, the tool proceeds without prompting. Pre-authorization rules exist only in user config — project config cannot define them
  6. **Session grants** — Check runtime session grants issued earlier in this session (e.g., user chose "always approve this" in a confirmation prompt). Session grants are keyed by a fingerprint of the tool call pattern and scoped to the current session. They do not persist across sessions
  7. **Final decision** — If no rule resolved to `allow`, the decision is `confirm`. The confirmation prompt is presented to the root agent (or bubbled up from sub-agents)

  **`--no-confirm` flag semantics:** This is a CLI invocation flag, not a config setting. It means "auto-approve `confirm` decisions without prompting." It does NOT override `deny` decisions (sandbox violations, forbidden commands, profile restrictions). It does NOT override `blocked` risk tier commands. In non-interactive mode (executor, one-shot without a TTY), if a tool requires confirmation and no `--no-confirm` flag is present and no pre-authorization rule matches, the tool returns `approval_required` (for sub-agents) or fails with `user_cancelled` (for root). The agent never silently skips a confirmation — it either confirms automatically or fails explicitly.

  **Confirmation prompt UX (interactive mode):**

  ```
  ⚠ exec_command requires confirmation
    Command: npm install --save lodash
    Risk: network_download, package_install
    Working directory: /home/user/project

    [y] approve    [n] deny    [a] always (this session)    [e] edit command
  ```

  The `[a] always` option creates a session grant with a fingerprint derived from the tool name and (for exec_command) a normalized command pattern. The `[e] edit` option opens the command in `$EDITOR` (or inline editing if no editor is set) and re-runs the risk analysis on the edited command. The prompt times out after the user-interaction timeout (no timeout — waits indefinitely, matching the Tool Runtime Contract's "user interaction: none" timeout category).

  **Composition with agent profiles:** Approval rules and agent profiles compose through intersection. A `researcher` profile has no write tools, so workspace-write approval rules never fire — the profile check denies the tool before approval is evaluated. A `coder` profile with `exec_command` hits the full approval pipeline. Profiles narrow the tool set; approval rules govern what happens with the remaining tools.

- **Sub-agent approval routing uses structural bubbling, not conversational routing.** The existing delegation design specifies that children cannot prompt the user directly and must return `approval_required` to the parent. This section defines the mechanics.

  **Approval request shape returned by child:**

  ```typescript
  {
    type: "approval_required",
    toolCall: { tool, args, riskTier, riskFacets },
    reason: string,        // human-readable explanation
    childLineage: {        // for audit trail
      agentId: string,
      depth: number,
      label: string
    }
  }
  ```

  **Parent receives this as part of the `await_agent` result.** The parent can:
  1. **Satisfy from own authority** — if the action falls within the parent's inherited authority or a session grant, the parent re-issues the grant to the child and the child proceeds. This happens without user interaction
  2. **Bubble up** — if the parent is also a sub-agent (depth > 0) and the action exceeds its own authority, it returns `approval_required` to its own parent, appending its own lineage. The chain continues until it reaches the root agent
  3. **Deny** — the parent can decide the action is unnecessary and instruct the child to use an alternative approach
  4. **Root agent prompts user** — only the root agent (depth 0) presents confirmation prompts to the user. The prompt includes the full lineage chain so the user knows which sub-agent requested the action and why

  **Session grants propagate downward.** When the root agent (or a parent) issues a session grant in response to a child's approval request, the grant is scoped to the requesting child's subtree. The child and its descendants can use the grant for matching actions without further bubbling. The grant does not extend to sibling agents or the parent's other children.

  **Approval fatigue mitigation:** The root agent can issue subtree-scoped session grants proactively at spawn time (e.g., "this coder agent may run `npm test` and `npm run build` without further approval"). These are passed as `preAuthorizedPatterns` in the `spawn_agent` call. Pre-authorized patterns are narrowing-only — they must fall within the parent's own authority. Additionally, the confirmation prompt's `[a] always` option creates a session grant that applies to the entire agent tree, not just the requesting child, reducing repeated prompts for the same action pattern across multiple sub-agents.

  **Depth 2 works identically to depth 1.** A grandchild returns `approval_required` to its parent (the child), which either satisfies it or bubbles to the root. There is no special handling for deeper chains — the algorithm is recursive and uniform.

- **Network egress policy applies to built-in network tools and best-effort detection on shell commands.** The policy governs which tools can make external network requests and to which destinations.

  **Policy structure:**

  | Field | Values | Default |
  |---|---|---|
  | `network.mode` | `off`, `approved-only`, `open` | `approved-only` |
  | `network.allowDomains` | string[] (glob patterns) | `[]` (empty — no pre-approved domains) |
  | `network.denyDomains` | string[] (glob patterns) | `[]` |
  | `network.allowHttp` | boolean | `false` (HTTPS only by default) |

  **Built-in network tools** (`fetch_url`, `web_search`, `lookup_docs`) check the policy before making any request:
  - `mode: off` — all network tools return a typed error (`network_disabled`). The model sees the error and can use alternative approaches
  - `mode: approved-only` — the request URL's domain is checked against `allowDomains` (permit if matched) and `denyDomains` (deny if matched, takes precedence over allow). If the domain is not in either list, the request requires user confirmation (standard `external-effect` approval flow). Non-HTTPS URLs are denied unless `allowHttp` is true
  - `mode: open` — all domains are permitted for built-in network tools (still subject to `denyDomains` blocklist). Standard `external-effect` approval still applies unless pre-authorized

  **`exec_command` network detection is best-effort.** The `CommandRiskAnalyzer` detects obvious network clients (`curl`, `wget`, `ssh`, `scp`, `rsync`, `git clone`, `git fetch`, `git push`, `npm install`, `pip install`, `docker pull`, `apt-get`, `brew`) and tags them with the `network_download` or related facets. When `network.mode` is `off`, detected network commands are denied. When `approved-only`, they require confirmation. However, the agent cannot fully sandbox arbitrary binary network access in v1 without OS-level isolation. The detection is documented as best-effort — it catches common patterns, not all possible network egress. This trade-off is explicit in the architecture, not hidden.

  **Localhost exception:** Requests to `localhost`, `127.0.0.1`, and `::1` are exempt from domain policy checks. Dev servers, local databases, and local APIs are common development needs. This exception applies to built-in network tools only, not to the shell command detection (which uses the standard approval flow regardless).

- **Secrets scrubbing operates at multiple pipeline points with two detection strategies.** Secrets must never reach the LLM context, the conversation log, the event log, or terminal output in plaintext. Scrubbing happens at four points:

  **Scrubbing points (in order of data flow):**

  1. **Tool output** — before the `ToolResultItem` is created. This is the primary scrubbing point. Tool results pass through the `SecretRedactor` before entering the conversation state
  2. **LLM context assembly** — before the API request is sent. Defense-in-depth: catches secrets that entered conversation state through other paths (e.g., user messages mentioning secrets)
  3. **Persistence** — before writing to `conversation.jsonl` and `events.jsonl`. Ensures on-disk data is scrubbed even if in-memory state was missed
  4. **Terminal rendering** — before displaying tool output or LLM responses to the user. Belt-and-suspenders: the user should not see secrets in agent output even if they are present in a file the agent reads

  **Two detection strategies:**

  *Strategy 1: Exact-value redaction for known secrets.* At session start, the runtime loads all configured API keys and secret values from the environment and `~/.aca/secrets.json` (Block 9). These exact values are stored in a `Set<string>` and matched via literal string search. This catches the agent's own secrets appearing in tool output (e.g., if the agent reads a `.env` file that contains the same API key). Exact matching has zero false positives for known values.

  *Strategy 2: Context-sensitive pattern detection for unknown secrets.* Regex patterns detect common secret formats in text that is not a known secret. Patterns are anchored to context — they fire only when a high-entropy string appears adjacent to a secret-indicating label (e.g., `key=`, `token:`, `password=`, `Authorization:`, `Bearer `). Specific patterns:

  | Pattern | Context required | Example match |
  |---|---|---|
  | Provider API key prefixes | None (prefix is sufficient) | `sk-...`, `pk_test_...`, `AKIA...`, `ghp_...`, `ghs_...`, `glpat-...` |
  | Bearer tokens | `Authorization` header or `Bearer` prefix | `Bearer eyJ...` |
  | PEM private keys | `-----BEGIN` block | `-----BEGIN ... PRIVATE KEY-----` |
  | `.env` file assignments | `=` after key/secret/token/password label | `API_KEY=abc123def456` |
  | Connection strings with credentials | `://user:pass@` pattern | `postgres://admin:secret@host/db` |
  | JWT tokens | Three dot-separated base64 segments | `eyJhbG...eyJzdW...sig` |
  | High-entropy strings with labels | Adjacent to `key`, `token`, `secret`, `password`, `credential`, `auth` (case-insensitive) | `api_key: "a1b2c3d4e5f6..."` |

  **`SecretPattern` interface** — each Strategy 2 pattern is registered as:
  ```typescript
  interface SecretPattern {
    name: string;              // Pattern identifier (e.g., "api_key_prefix", "bearer_token")
    pattern: RegExp;           // Detection regex
    type: string;              // Redaction type label used in placeholder (e.g., "api_key", "bearer", "pem_key")
    contextRequired?: string;  // Optional context that must be adjacent (e.g., "Authorization")
  }
  ```

  **What is NOT scrubbed:** SHA-256 commit hashes, content hashes (e.g., in lockfiles), UUIDs, base64-encoded non-secret data, file checksums, and general hex strings without a secret-indicating label. The pattern detection requires context (a label or known prefix) to avoid false positives on legitimate data. If a pattern has no label context and no known prefix, it is not scrubbed.

  **Redaction format:** Detected secrets are replaced with stable, typed placeholders: `<redacted:api_key:1>`, `<redacted:bearer_token:2>`, `<redacted:env_value:3>`. The numeric suffix is a per-session counter for each redaction instance, enabling correlation across log entries without exposing the value. Redaction metadata (original byte length, detection strategy, pattern name) is recorded in the event log for debugging.

  **False positive recovery:** If a user reports that legitimate content was redacted, they can add patterns to a `scrubbing.allowPatterns` list in their user config (Block 9). Allowed patterns are checked before scrubbing and exempt matching strings from redaction. This is user-config only — project config cannot suppress scrubbing.

**Integration with other blocks:**

- **Tool Runtime Contract:** The sandbox check (zone enforcement) and command risk analysis run inside the Tool Runtime Contract layer, before tool-specific code executes. The approval check is part of the turn engine's `ExecuteToolCalls` phase (Block 6 phase 10), which calls into the approval engine before dispatching to the tool runtime
- **Block 6 (Agent Loop):** The `CheckYieldConditions` phase (phase 8) checks for `approval_required` outcomes. The `ExecuteToolCalls` phase (phase 10) runs the approval resolution algorithm per tool call. If the resolution is `confirm`, the turn yields with `approval_required` outcome
- **Block 5 (Conversation State Model):** Approval decisions, session grants, and risk assessments are recorded in the event log as fields on `tool.invoked` events. The conversation log contains only the final tool results (post-scrubbing)
- **Block 9 (Configuration & Secrets):** All policy settings (auto-approve rules, pre-authorization patterns, extra trusted roots, network policy, scrubbing patterns) are loaded from the merged config (Block 9). The trust boundary (which settings project config can set) is enforced by Block 9's config loader. The permission model reads from the resolved config, never directly from project files
- **Delegation (Agent Profiles):** Agent profiles define the tool set. The permission model intersects the profile's tools with the approval policy. Sub-agent authority is the intersection of parent authority and child profile — it can only narrow, never widen

**Deferred:**
- OS-level sandboxing for `exec_command` (namespaces, seccomp, landlock)
- Fine-grained filesystem ACLs (read-only zones, write-once zones)
- Network egress monitoring via eBPF or proxy
- Secrets scanning of workspace files on session start (proactive detection)
- Per-tool-call audit trail with cryptographic chaining
- Time-boxed approval grants (auto-expire after N minutes)
- Approval policies expressed as a policy language (OPA, Cedar) instead of JSON rules
- Machine-learning-based command risk classification
