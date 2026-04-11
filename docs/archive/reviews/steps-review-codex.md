# Codex Review of Implementation Steps

Codex (gpt-5.4/o3) reviewed all 9 split steps files individually on 2026-03-29.
Total tokens used: ~200K across 9 reviews.

## Summary by Severity

| Milestone | High | Medium | Low | Total |
|-----------|------|--------|-----|-------|
| Phase 0 | 2 | 2 | 4 | 8 |
| M1: Agent Loop | 4 | 4 | 1 | 9 |
| M2: Tools/Perms | 4 | 3 | 0 | 7 |
| M3: Context/State | 1 | 4 | 1 | 6 |
| M4: Rendering | 1 | 2 | 2 | 5 |
| M5: Provider/Obs | 2 | 3 | 0 | 5 |
| M6: Indexing | 1 | 3 | 1 | 5 |
| M7: Delegation | 5 | 3 | 1 | 9 |
| M8: Cross-Cutting | 1 | 3 | 0 | 4 |
| **Total** | **21** | **27** | **10** | **58** |

## High-Severity Findings (must fix)

### Phase 0
1. `npm test` with zero test files needs `passWithNoTests` config in vitest
2. `tsx src/index.ts --help` asserts behavior no step creates (no CLI stub in Phase 0)

### Milestone 1
3. `DelegationRecord` missing from M1.1 types — Block 5 defines 6 types, only 5 listed
4. `ToolOutput` missing `bytesOmitted` field — later steps depend on it
5. `CheckYieldConditions` missing `tool_error` and `mutationState: "indeterminate"` yield cases
6. Event system missing `delegation.started/completed` and `error` event types (only 9 of 12)

### Milestone 2
7. Risk analysis only on `exec_command`, not `open_session`/`session_io` — persistent shell bypass
8. `$(echo rm) -rf /` classified as `high` not `forbidden` — breaks hard-deny guarantee
9. No steps for network egress policy (Block 8) — entire surface missing
10. Secrets loaded but no scrubbing pipeline — 4-point scrubbing unimplemented

### Milestone 3
11. Instruction summary omitted from pinned sections; durable task state not pinned — both can be compressed away

### Milestone 4
12. No output-channel contract (stderr vs stdout, executor suppression) — untestable

### Milestone 5
13. `models.json` introduced in M5 but M3 already depends on `bytesPerToken` — ordering conflict
14. `embed()`/`supportsEmbedding` missing from ProviderDriver — blocks M6

### Milestone 6
15. No indexing guardrails (gitignore, extension whitelist, maxFileSize/maxFiles) — could index node_modules

### Milestone 7
16. M7.5 depends on network policies from M7.10 — ordering broken
17. Error codes/health states used before Block 11/Block 1 machinery defined
18. `spawn_agent` missing approval model transport for subtree pre-authorizations
19. `/restore` missing preview/confirmation flow (Block 16 safety)
20. Executor mode incomplete for universal capability contract

### Cross-Cutting
21. Test infrastructure placed last but M1/M4 depend on it — should be Phase 0 or early M1

## Medium-Severity Findings (should fix)

### Phase 0
- `lint` npm script with no linter scaffolded
- `path aliases` in tsconfig with no resolution alignment across vitest/tsup/runtime

### Milestone 1
- `tool.completed` uses `parent_event_id` for invocation pairing — needs dedicated correlation field
- Auto-retry (3 attempts, backoff, idempotent-only) unplanned and untested in M1.5
- `ask_user`/`confirm_action` depend on one-shot/`--no-confirm` not available in M1 scope
- SIGINT tests only cover idle readline — no streaming/tool-batch cancellation tests

### Milestone 2
- `delete_path`/`move_path` missing confirmation escalation override
- Config/Approval sections contain each other's content (swapped labels)
- No `trustedWorkspaces` step

### Milestone 3
- Root detection missing `pom.xml`/`build.gradle`
- Budget guard missing `max(512, ...)` floor and 10% retry guard
- Ignore rules missing `include_ignored` flag and `.git/` hard-block
- FileActivityIndex missing open-loop boost (+20) preventing eviction

### Milestone 4
- `ACA_COLUMNS` and width adaptation omitted from TerminalCapabilities
- LLM streaming status line (tier 1 of progress) has no test

### Milestone 5
- Fallback tests only cover 429, not server_error/timeout
- Budget tests miss midnight-spanning daily rollup
- No trust-boundary tests for new config fields (providers, budget, retention)

### Milestone 6
- Storage schema uses `lines`/`parent_id` instead of spec's `start_line`/`end_line`/`parent_symbol_id`
- No `indexStatus` state transition tests
- Chunking omits markdown heading-aware splitting

### Milestone 7
- Approval grant tests miss sibling-reuse across parallel agents
- "5 categories" text names only 4
- Localhost exception too broad (should exclude exec_command)

### Cross-Cutting
- No acceptance criteria for mock server/fixtures/snapshot harness
- TypeScript `strict` doesn't prevent explicit `any` — needs lint rule
- Mock provider scoped to NanoGPT only, too narrow for M5 tests
