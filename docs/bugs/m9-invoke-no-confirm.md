# Bug: Delegated ACA agents can't use approval-requiring tools

**Filed:** 2026-04-05
**Severity:** P1 — functional limitation, blocks real delegation use cases
**Component:** MCP server (`src/mcp/server.ts`)

## Problem

`defaultSpawn()` at line 73 spawns `aca invoke` without `--no-confirm`:
```typescript
const child = spawn(process.execPath, [acaBin, 'invoke'], { ... });
```

This means any tool requiring approval (`exec_command`, `write_file`, `delete_path`, `move_path`, etc.) fails with `tool_error` in the ephemeral invoke session — there's no TTY to prompt the user, so the approval flow hangs or errors.

**Result:** Delegation is currently limited to read-only tools (`read_file`, `find_paths`, `search_text`, `search_semantic`).

## Observed

During live parallel testing:
- `read_file` tasks: succeed
- `exec_command` task: `tool_error: Turn ended with outcome: tool_error`

## Fix

Pass `--no-confirm` to the invoke subprocess:
```typescript
const child = spawn(process.execPath, [acaBin, 'invoke', '--no-confirm'], { ... });
```

**Rationale:** The parent (Claude) already approved the `aca_run` MCP call. The child agent should auto-approve within its delegated tool set. The `allowed_tools` constraint already restricts what the child can do — that IS the authority boundary. Requiring a second approval prompt in a headless subprocess is both impossible (no TTY) and redundant.

**Consideration:** The `authority` field in InvokeRequest could also be used for fine-grained per-tool approval, but `--no-confirm` is the simple fix that unblocks all delegation.

## Test Plan

- `aca_run` with `allowed_tools: ["read_file", "exec_command"]` and a task like "run `wc -l src/mcp/server.ts`" should succeed
- `aca_run` with `allowed_tools: ["read_file", "write_file"]` and a write task should succeed
