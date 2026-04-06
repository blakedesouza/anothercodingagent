<!-- Source: fundamentals.md lines 1044-1239 -->
### Block 9: Configuration & Secrets

How the agent is configured and where sensitive data lives. This block defines the config schema, loading precedence, merge semantics, and trust boundary for per-project overrides. The permission model (Block 8) reads from the resolved config produced here.

**Core principle: project config is untrusted input.** Any `.aca/config.json` checked into a repository could be authored by an adversary. The config system treats project-level config as a quarantined source that can only narrow/restrict behavior, never expand authority. User config and CLI flags are the trusted sources that own the security boundary.

**Foundational decisions:**

- **Config format is JSON with JSON Schema validation.** Config files are named `config.json` and validated against a JSON Schema (Draft 2020-12) at load time. JSON is chosen over TOML and YAML because: it has no ambiguous whitespace semantics, it is natively parseable in Node.js without dependencies, it maps cleanly to TypeScript types, it is harder to inject surprising values (no YAML anchors, no TOML table reordering), and the agent already uses JSON throughout (event log, conversation log, tool schemas). JSON's lack of comments is a minor inconvenience addressed by documenting the schema and supporting a `$schema` reference for IDE autocomplete.

  The schema includes a `schemaVersion: number` field (starting at `1`) for forward compatibility. On load, if the file's `schemaVersion` exceeds the agent's known version, the agent warns and ignores unknown fields rather than rejecting the file. If the `schemaVersion` is missing, it defaults to `1`.

  A JSON Schema definition file ships with the agent and is referenced from config files via `"$schema": "./node_modules/@ACA/schema/config.v1.json"` (or a URL once published). The schema is validated at load time using `ajv` (Already JSON Schema). Validation errors are reported as structured messages with the field path and expected type, not raw `ajv` output.

- **Config file locations and precedence order: CLI flags > environment variables > project config > user config > defaults.** Five sources, merged in priority order. Higher-priority sources override lower-priority ones, subject to per-field merge semantics and trust boundary filtering.

  | Priority | Source | Path / Mechanism | Trust level |
  |---|---|---|---|
  | 1 (highest) | CLI flags | `--model`, `--no-confirm`, `--network-off`, etc. | Trusted (user invocation) |
  | 2 | Environment variables | `ACA_MODEL`, `ACA_NETWORK_MODE`, etc. Prefix: `ACA_` | Trusted (user environment) |
  | 3 | Project config | `.aca/config.json` in workspace root | **Untrusted** (may be checked into repo) |
  | 4 | User config | `~/.aca/config.json` | Trusted (user's home directory) |
  | 5 (lowest) | Defaults | Hardcoded in source | Trusted (agent code) |

  **Merge semantics by field type:**
  - **Scalars** (string, number, boolean): last-wins (higher priority replaces lower)
  - **Objects**: deep-merge by key (higher priority keys override, lower priority keys are preserved)
  - **Arrays**: replace, not concatenate (higher priority array replaces lower priority array entirely). Array merging creates unpredictable ordering — replace semantics are safer and easier to reason about
  - **Permission-like fields**: use **most-restrictive-wins** composition instead of last-wins. Specifically: allowed tool sets intersect (not union), domain allowlists intersect, booleans that reduce authority win over booleans that expand it. This means a project config that restricts tools further than user config is honored, but a project config that tries to allow more tools than user config is ignored

  **Environment variable mapping:** Config fields are mapped to environment variables with the `ACA_` prefix, uppercase, underscores replacing dots and camelCase boundaries. Examples: `model.default` maps to `ACA_MODEL_DEFAULT`, `network.mode` maps to `ACA_NETWORK_MODE`. Arrays in environment variables use comma-separated values: `ACA_NETWORK_ALLOW_DOMAINS=github.com,npmjs.com`. Boolean env vars accept `true`/`false`/`1`/`0`. Unset env vars are treated as absent (no opinion), not as empty/false.

  **Edge cases:**
  - A field set in project config but not in user config: the project config value applies (subject to trust boundary filtering)
  - A field set in both project and user config: the user config value wins for security-sensitive fields; deep-merge applies for safe fields
  - `--no-confirm` CLI flag: overrides the `permissions.nonInteractive` config field and sets all `confirm` decisions to `allow` (but not `deny` decisions, per Block 8)
  - Missing config files: silently ignored. The agent runs with defaults if no config exists
  - Malformed config files: user config triggers a warning and falls back to defaults. Project config triggers a warning and is ignored entirely (fail-safe for untrusted input)

- **Per-project overrides are filtered through a trust boundary before merge.** The config loader maintains two JSON Schema variants: the **full schema** (for user config and CLI flags) and the **project-safe schema** (for project config). The project-safe schema is a strict subset of the full schema. Fields not in the project-safe schema are silently dropped from project config during loading — no error, no prompt, just ignored.

  **Project config CAN set (project-safe fields):**

  | Field | Type | Purpose |
  |---|---|---|
  | `model.default` | string | Preferred model for this project |
  | `model.temperature` | number | Temperature override |
  | `profiles` | object | Additional agent profiles (narrowing-only, per existing agent profile rules) |
  | `project.ignorePaths` | string[] | Additional paths to ignore in find/search (merged with .gitignore) |
  | `project.docAliases` | object | Short names for documentation URLs (used by `lookup_docs`) |
  | `project.conventions` | string | Brief text injected into system prompt describing project conventions |
  | `network.denyDomains` | string[] | Additional domains to block (merged with user deny list) |
  | `permissions.blockedTools` | string[] | Tools to disable for this project (narrowing only) |
  | `limits.maxStepsPerTurn` | number | Override step limit (can only reduce, not increase beyond user config or default) |
  | `limits.maxConcurrentAgents` | number | Override agent limit (can only reduce) |

  **Project config CANNOT set (user-only fields, silently dropped):**

  | Field | Why user-only |
  |---|---|
  | `permissions.preauth` (pre-authorization rules) | A malicious repo could auto-approve destructive commands |
  | `permissions.nonInteractive` / `--no-confirm` | Would allow unattended destruction |
  | `sandbox.extraTrustedRoots` | Would allow filesystem escape |
  | `network.mode` | Would allow `off` → `open` escalation |
  | `network.allowDomains` | Would allow exfiltration to arbitrary domains |
  | `network.allowHttp` | Would enable insecure connections |
  | `provider.*` | Would redirect API calls to attacker-controlled endpoints |
  | `secrets.*` | Would access or suppress scrubbing of secrets |
  | `scrubbing.allowPatterns` | Would suppress secret detection |
  | `workspace.root` | Would relocate the workspace boundary |

  **Trust store for workspace trust levels:** The user config contains an optional `trustedWorkspaces` map: `{ [normalizedAbsolutePath: string]: "trusted" | "untrusted" }`. When a workspace is marked `trusted`, its project config is loaded with an expanded project-safe schema that additionally allows: `model.provider` (model selection, not API endpoint), custom agent profiles with non-default tool sets (still narrowing-only relative to built-in profiles), and `project.systemPromptOverlay` (additional system prompt text). A workspace not in the map defaults to `untrusted`. Trust is set via `aca trust` / `aca untrust` commands or manual config editing. Trust is keyed by the canonical absolute path of the workspace root, not by repository URL or content hash — moving a repository to a different path resets its trust.

- **API keys live in environment variables (primary) or a dedicated secrets file (fallback). Never in config files, never on the command line.**

  **Resolution order:**

  1. `NANOGPT_API_KEY` environment variable (primary provider). Additional provider keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.
  2. `~/.aca/secrets.json` — a dedicated file with `0600` permissions, separate from `config.json`. Contains `{ "nanogpt": "key-value", "anthropic": "key-value" }`. The agent checks file permissions on startup and refuses to load secrets from a file with permissions looser than `0600` (owner read/write only)
  3. No `--api-key` CLI flag. Shell history is a persistent, unencrypted record — passing secrets as arguments is a well-known footgun. The agent does not support it

  **Why not system keyring in v1:** WSL2 has inconsistent keyring support (no `gnome-keyring` or `kwallet` by default, `libsecret` may not be available). Adding a keyring dependency (`keytar` or similar) introduces native compilation, platform-specific behavior, and failure modes that are not worth the complexity for v1. The `secrets.json` with `0600` permissions provides adequate security for a single-user CLI tool. Keyring integration is a v2 enhancement.

  **Secrets file creation:** `aca init` or `aca configure` creates `~/.aca/secrets.json` with the correct permissions. If the file already exists with wrong permissions, the command warns and offers to fix them. The agent never writes secrets to `config.json`.

- **The full config schema covers seven top-level groups.** Each group maps to a specific concern. The resolved config is a single TypeScript type (`ResolvedConfig`) frozen at session start.

  ```
  {
    "schemaVersion": 1,

    "providers": [                   // Provider configurations (Block 17)
      {
        "name": "nanogpt",          // Provider identifier
        "baseUrl": null,             // Custom API endpoint (user-only)
        "timeout": 30000,            // API call timeout in ms
        "priority": 1                // Selection priority (lower = preferred)
      }
    ],

    "defaultProvider": "nanogpt",     // Active provider (must exist in providers array)
    "apiTimeout": 30000,             // Global API call timeout fallback (ms)

    "model": {
      "default": "claude-sonnet-4-20250514",  // Default model
      "compressionModel": null,    // Override for summarization (v1: ignored, uses default)
      "temperature": 0.1,          // Sampling temperature
      "maxOutputTokens": 4096      // Max response tokens
    },

    "permissions": {
      "nonInteractive": false,     // true = --no-confirm behavior
      "preauth": [                 // Pre-authorization rules (user-only)
        {
          "id": "tests",
          "tool": "exec_command",
          "match": {
            "commandRegex": "^(pnpm|npm|yarn) (test|lint|typecheck|build)\\b",
            "cwdPattern": "workspace"
          },
          "decision": "allow",
          "scope": "session"
        }
      ],
      "classOverrides": {          // Per-class default overrides (user-only)
        "workspace-write": "confirm",
        "external-effect": "confirm"
      },
      "toolOverrides": {},         // Per-tool overrides (user-only)
      "blockedTools": []           // Tools to disable entirely
    },

    "sandbox": {
      "extraTrustedRoots": []      // Additional allowed paths (user-only, absolute)
    },

    "network": {
      "mode": "approved-only",     // off | approved-only | open
      "allowDomains": [],          // Glob patterns for pre-approved domains (user-only)
      "denyDomains": [],           // Glob patterns for blocked domains
      "allowHttp": false           // Allow non-HTTPS requests
    },

    "scrubbing": {
      "enabled": true,             // Master switch for secret scrubbing
      "allowPatterns": []          // Patterns exempt from scrubbing (user-only)
    },

    "project": {
      "ignorePaths": [],           // Additional paths to ignore in find/search
      "docAliases": {},            // Short names for doc URLs
      "conventions": ""            // Project conventions text for system prompt
    },

    "limits": {
      "maxStepsPerTurn": 25,
      "maxConsecutiveAutonomousToolSteps": 10,
      "maxConcurrentAgents": 4,
      "maxDelegationDepth": 2,
      "maxTotalAgents": 20
    },

    "trustedWorkspaces": {}        // Trust store: path -> "trusted" | "untrusted" (user-only)
  }
  ```

  Fields marked "(user-only)" are stripped from project config during loading per the trust boundary rules above.

- **Config loading is a deterministic pipeline that runs once at session start.** The `ConfigLoader` produces a frozen `ResolvedConfig` that does not change during the session. Steps:

  1. Load defaults (hardcoded)
  2. Load user config from `~/.aca/config.json` (if exists, validate against full schema)
  3. Load project config from `.aca/config.json` in workspace root (if exists, validate against project-safe schema, drop disallowed fields)
  4. Parse environment variables with `ACA_` prefix
  5. Parse CLI flags
  6. Merge in priority order: defaults ← user config ← project config (filtered) ← env vars ← CLI flags
  7. For permission-like fields, apply most-restrictive-wins composition instead of last-wins
  8. Validate the merged result against the full schema
  9. Freeze and return `ResolvedConfig`

  The resolved config is available to all runtime components via dependency injection, not global state. It is immutable for the session duration. Runtime state changes (session grants, approval decisions) live in the session's in-memory state, not in the config.

**Integration with other blocks:**

- **Block 8 (Permission / Sandbox Model):** The permission model reads all policy from the resolved config: pre-authorization rules, class overrides, network policy, sandbox boundaries. The trust boundary filtering in this block ensures that untrusted project config cannot weaken the security posture set by user config
- **Block 5 (Conversation State Model):** The resolved config is snapshotted in the session `manifest.json` at session start. On session resume, the snapshot is used to detect config drift (current config vs snapshot) and warn if security-relevant settings have changed
- **Observability:** Config loading emits a `config.loaded` event recording which sources were present, which fields came from which source, and whether any project config fields were dropped by the trust filter. This aids debugging when behavior differs between projects
- **Agent Profiles:** Custom profiles defined in project config (trusted workspaces only) are registered in the `AgentRegistry` at session start, alongside built-in profiles. They follow the same narrowing-only rules
- **System Prompt Assembly:** The `project.conventions` field is injected into the per-turn context block. The model name and provider from the resolved config determine the API call target and context limits
- **Secrets in config:** API keys loaded from `secrets.json` or environment variables are added to the exact-value redaction set (Block 8 secrets scrubbing) at session start. They are never written to the conversation log, event log, or config snapshot

**Deferred:**
- System keyring integration for secrets (post-v1, when WSL2 keyring support matures)
- Config encryption at rest
- Remote config sources (team-shared config via URL or registry)
- Config profiles (named config presets switchable via CLI flag)
- `aca config` subcommand for interactive config editing
- Config file watching and hot-reload during session
- Config migration tooling (upgrading schemaVersion across breaking changes)
- Per-directory config cascade (nested .aca/config.json files within a workspace)
- Policy-as-code integration (OPA, Cedar) for complex approval rules
