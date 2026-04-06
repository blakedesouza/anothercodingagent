<!-- Source: 07-milestone7-delegation.md (reordered and split) -->
# ACA Implementation Steps — Milestone 7, Part B: Delegation

Sub-agent system: profiles, spawning, messaging, approval routing.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure

---

## Milestone 7B: Delegation

### M7.1a — Agent Registry + Profiles (Block 2: Delegation)

- [x] `AgentRegistry`: resolved once at session start, frozen for session
- [x] 4 built-in profiles: general, researcher, coder, reviewer (with default tools, delegation permissions, system prompt overlay)
- [x] Project-config profiles (from `.aca/config.json` in trusted workspaces)
- [x] Agent identity type: `agt_<ulid>`, parentAgentId, rootAgentId, depth, spawnIndex, label
- [x] Profile narrowing validation: overrides may only restrict, never widen

**Tests:**
- Registry loads 4 built-in profiles at session start
- Project config adds custom profile → registered alongside built-ins
- Profile lookup by name → correct tools, delegation permissions
- Narrowing validation: attempt to add tool not in profile → rejected
- Non-delegating enforcement: `researcher` profile calls `spawn_agent` → rejected (`delegation_not_permitted`)
- Non-delegating enforcement: `reviewer` profile calls `spawn_agent` → rejected (`delegation_not_permitted`)

### M7.1b — `spawn_agent` Tool + Child Sessions (Block 2: Delegation, Block 5)

- [x] `spawn_agent` tool: agent_type, task, context, allowed_tools (narrowing only), authority (narrowing only), label
- [x] Child session creation: separate `ses_<ulid>` with parentSessionId, rootSessionId lineage
- [x] Tool set intersection: profile defaults ∩ caller overrides
- [x] Limits enforcement at spawn time: 4 concurrent, depth 2, 20 total per session
- [x] On limit violation: typed `limit_exceeded` error with current/allowed values
- [x] Pre-authorization transport: parent can pass subtree pre-auth patterns at spawn time via `preAuthorizedPatterns` parameter. Child inherits these for matching tool calls without bubbling approval
- [x] Inherited pre-auths are narrowing-only: parent cannot grant wider authority than it holds

**Tests:**
- Agent identity shape: spawned agent has `agt_<ulid>` format ID (26 alphanumeric chars after prefix), `parentAgentId` = spawner's ID, `rootAgentId` = root agent's ID, `depth` = parent depth + 1, `spawnIndex` = sequential counter per parent (0-based), `label` = provided label string
- Spawn general agent → child session created with correct lineage, profile tools
- Spawn with narrowing `allowed_tools` → tool set is intersection
- Spawn with widening `allowed_tools` → rejected (narrowing only)
- Limit: 5th concurrent agent → `limit_exceeded` error
- Depth limit: root (depth=0) spawns child (depth=1) → succeeds. Child spawns grandchild (depth=2) → succeeds. Grandchild (depth=2) tries to spawn (would be depth=3) → `limit_exceeded` error with `{ current: 2, allowed: 2 }`
- Total limit: 21st agent in session → `limit_exceeded`
- Child session has own `ses_<ulid>` with parentSessionId set
- Pre-auth transport: parent passes `^npm test$` pattern → child auto-approves `npm test` without bubbling
- Spawn with narrowing `authority` → child authority is intersection of parent's and override
- Spawn with widening `authority` → rejected (narrowing only)
- Pre-auth widening: parent tries to grant authority it doesn't hold → rejected

### M7.1c — `message_agent` + `await_agent` + Lifecycle (Block 2: Delegation)

- [x] `message_agent` tool: agent_id, message → ack/status
- [x] `await_agent` tool: agent_id, timeout (0=poll) → result or progress snapshot
- [x] Lifecycle phases: booting, thinking, tool, waiting
- [x] Progress snapshot: status, phase, activeTool, lastEventAt, elapsedMs, summary
- [x] Final result: structured output, token usage, tool call summary
- [x] Children cannot use `ask_user`/`confirm_action` directly → return `approval_required`

**Tests:**
- Await with timeout=0 → returns progress snapshot (status, phase, elapsed)
- Await with timeout=5000 → blocks up to 5s, returns result or snapshot
- Child completes → await returns final result with token usage
- Child uses ask_user → returns `approval_required` to parent. Question text preserved in `approval_required` payload so parent can read and respond
- ask_user routing end-to-end: child asks "Which DB?" → parent receives `approval_required` with question text "Which DB?" → parent answers "PostgreSQL" → answer routed back to child → child receives "PostgreSQL" as ask_user result
- Message agent → child receives and processes
- message_agent with invalid/nonexistent agent ID → `delegation.message_failed` error with "agent not found"
- message_agent to completed/closed child → `delegation.message_failed` error with "agent terminated"
- Lifecycle phases transition correctly: booting → thinking → tool → thinking → done

### M7.2 — Sub-Agent Approval Routing (Block 8)

- [x] Child returns `approval_required` with toolCall details and lineage
- [x] Parent can: satisfy from own authority, bubble up, or deny
- [x] Root agent prompts user with full lineage chain
- [x] Session grants propagate downward to requesting child's subtree
- [x] Pre-authorized patterns at spawn time (via M7.1b pre-auth transport)

**Tests:**
- Child needs approval, parent has authority → auto-satisfied, no user prompt
- Child needs approval, parent lacks authority, parent is root → user prompted with child lineage
- Child needs approval, parent is depth 1, grandparent is root → bubbles twice, root prompts
- Session grant from root → child can reuse for matching actions
- Pre-authorized pattern at spawn → child auto-approves matching actions
- Subtree-scoped grant: grant given to child A → sibling child B cannot use it (subtree only, per spec)
- Whole-tree grant via `[a] always`: user selects `[a] always` → grant applies to entire agent tree, sibling B can use it

---
