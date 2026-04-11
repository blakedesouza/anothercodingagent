# Another Coding Agent — Handoff

## Current State (2026-03-29)

All foundational design complete (20 blocks). Implementation steps created, reviewed by 3 AI models, and consolidated. 21 high-severity Codex findings applied. Pre-implementation cleanup done. Per-file Codex re-review completed. All 43 Codex per-file findings fixed (8 batches). All 3 Kimi/DeepSeek consultation items fixed (batch 9). Pre-implementation spec cleanup is COMPLETE.

**Test coverage audit completed.** ~547 tests across all step files, ~87% concrete. The remaining ~13% (~72 items) have been reviewed by 3 external models (MiniMax M2.7, Kimi K2.5, DeepSeek V3.2 Thinking) with full consensus on resolutions. **~38 fixes need to be applied to step files before Phase 0 coding begins.** See `docs/handoff-test-audit.md` for the full task list.

## Progress on Codex Per-File Findings

Results live at `docs/codex-per-file-results/` (11 files).

### Completed

| Task | File | Findings | Status |
|------|------|----------|--------|
| M2 fixes | `docs/steps/02-milestone2-tools-perms.md` | 4 HIGH | Done |
| M1 fixes | `docs/steps/01-milestone1-agent-loop.md` | 2 HIGH, 1 MED | Done |
| M3 fixes | `docs/steps/03-milestone3-context-state.md` | 2 HIGH, 3 MED | Done |
| M6 fixes | `docs/steps/06-milestone6-indexing.md` | 3 HIGH, 2 MED | Done |
| M5 fixes | `docs/steps/05-milestone5-provider-obs.md` | 2 HIGH, 3 MED | Done |
| M4 fixes | `docs/steps/04-milestone4-rendering.md` | 1 HIGH, 1 MED | Done |
| M7a fixes | `docs/steps/07a-milestone7-error-health.md` | 2 HIGH, 3 MED | Done |
| M7b fixes | `docs/steps/07b-milestone7-delegation.md` | 1 HIGH, 3 MED | Done |
| M7c fixes | `docs/steps/07c-milestone7-capabilities.md` | 2 HIGH, 2 MED | Done |
| Phase 0 + cross-cutting | `docs/steps/00-phase0-setup.md`, `docs/steps/08-cross-cutting.md` | 3 MED, 1 LOW | Done |

**M2 changes made:**
1. Domain array merge semantics → set-union for deny/block, set-intersection for allow (was plain replace)
2. `delete_path`/`move_path` `--no-confirm` → auto-approves `confirm`, cannot override `deny` (was "always require confirmation")
3. `fs.realpath` → ancestor resolution for create ops + `openat(dirfd)` TOCTOU pattern (was broken for nonexistent paths)
4. Secrets scrubbing → added Strategy 2 baseline patterns (API key prefixes, Bearer, PEM) to M2.8 (was deferred entirely to M7.8)

**M1 changes made:**
1. Yield mechanics → split pre-execution (`CheckYieldConditions`) and post-execution (`LoopOrYield`) yield checks (was all in phase 8)
2. Sub-agent `ask_user` → clarified tools excluded from profile + approval routing is separate mechanism (was contradictory)
3. Deferred tool calls → added synthetic `tool.deferred` error results so model knows which calls were skipped (was silent drop)

**M3 changes made:**
1. Current-turn contradiction → split pinned into "always-pinned" (all tiers) and "pinned except emergency" (instruction summary, durable task state). Emergency digests oversized current-turn tool results
2. Emergency tier vs pinned → clarified emergency drops instruction summary + durable task state; only always-pinned survive
3. Tier boundaries → made explicit: `≥ 60%` = medium, `≥ 80%` = aggressive, `≥ 90%` = emergency (inclusive lower bounds)
4. Durable task state resume → added manifest.json reload to M3.7 rebuild list
5. 8% guard + EMA → specified formula `estimationGuard = max(512, ceil(contextLimit * 0.08))`, default reservedOutputTokens=4096, added concrete budget calculations to tests

**M6 changes made:**
1. Schema columns → `lines` → `start_line`/`end_line`, `parent_id` → `parent_symbol_id` (matches Block 20)
2. Extension whitelist → aligned with Block 20: added `.tsx`, `.jsx`, `.hpp`, `.cs`, `.php`, `.scala`, `.yml`; removed `.html`, `.css`, `.sql`, `.sh`; added "package manifests only" / "config files only" qualifiers
3. Guardrail limits → `1 MB` → `100 KB` (102400), `10,000` → `5,000` (matches Block 20 config defaults)
4. Skip rules → added `coverage/` exclusion, binary file detection, generated file markers (`// @generated`, `# auto-generated`)
5. Markdown chunking → added heading-boundary chunking for `.md` files
6. Deletion cascade → file removal now requires deleting file row + chunk rows + symbol rows (was chunks only)

**M5 changes made:**
1. Cost formula → split into `(input_tokens * costPerMillion.input + output_tokens * costPerMillion.output) / 1_000_000` (was single rate)
2. Daily budget → added `dailyBaselineCost` loaded at session start from SQLite, carried into per-response checks with per-event timestamps for midnight handling. Added mid-session daily cap crossing test
3. Alias test → made provider-agnostic (test configures single provider, was hardcoded NanoGPT)
4. Stream tests → added `finishReason`/`usage` verification in `done` event for both providers
5. Remote telemetry → added M5.7 step covering opt-in OTLP export, user-only config, aggregate-only data, secrets scrubbing (was entirely missing)

**M4 changes made:**
1. FORCE_COLOR vs non-TTY → reconciled M4.0 rule: non-TTY = no ANSI unless `FORCE_COLOR` overrides color output; cursor control (`\r`, spinners) stays suppressed regardless. Updated M4.2/M4.3/M4.4 non-TTY references consistently
2. Per-stream capabilities → `TerminalCapabilities` now detects per-stream (`stdout`/`stderr` each get own `isTTY`, `colorDepth`, `columns`; shared: `rows`, `unicode`). Added piped-stdout+TTY-stderr test

**M7a changes made:**
1. `llm.confused` outcome → clarified: turn outcome is `tool_error`, error code is `llm.confused` (was described as outcome itself)
2. Retry counts → changed from ambiguous "retries N×" to explicit "N total attempts (M retries)" matching spec's inclusive-of-initial semantics
3. Health-update coverage → added server-error→degraded and timeout→degraded after retry exhaustion (was only rate-limit and auth)
4. Confusion-event list → added "parameter value outside allowed enum" (was missing from what-counts list)
5. Secret pattern prefixes → fixed to match spec: `pk_live_`→`pk_test_`, added `ghs_`, `glpat-`

**M7b changes made:**
1. Grant scope → split sibling-reuse test into: subtree grant does NOT extend to siblings (negative test) + `[a] always` whole-tree grant DOES extend to siblings (was single incorrect test claiming siblings share grants)
2. `preauth` → renamed to `preAuthorizedPatterns` to match spec (was misnamed `preauth`)
3. `spawn_agent` → added `authority (narrowing only)` parameter + 2 tests for authority narrowing/widening (was missing entirely)
4. Non-delegating profiles → added 2 tests: `researcher` and `reviewer` calling `spawn_agent` → rejected with `delegation_not_permitted` (was untested)

**M7c changes made:**
1. Browser checkpointing → clarified: workspace file writes (screenshot PNGs) ARE checkpointed; browser state (cookies, DOM) is excluded. `externalEffects: true` triggers warning on undo + session close (was "checkpointing exclusion" implying no checkpoint at all). Added screenshot→undo test
2. Divergence/force → made explicit that divergence detection + `--force` override apply to BOTH `/undo` and `/restore` (was "block restore" implying `/restore` only). Added 2 `/restore` divergence tests
3. `aca describe` schema → changed singular "capability name" and plural "capabilities" to explicit JSON field names: `name`, `description`, `input_schema`, `output_schema`, `constraints` (was inconsistent between spec and test)
4. `0600` permissions → made platform-conditional: POSIX `0600`, Windows owner-only ACL via `icacls`. Added Windows-specific test (was Unix-only, unsatisfiable on Windows)

**Phase 0 + cross-cutting changes made:**
1. `commander` install → added explicit `Install commander (CLI framework)` step in 0.2 (was missing)
2. `tsx` invocation → changed bare `tsx` to `npx tsx` in 0.2 test commands (was assuming global install)
3. SessionManager forward dep → 0.3 acceptance criterion now validates `Session` objects against Block 5 schema; SessionManager integration deferred to M3 (was untestable in Phase 0)
4. Mock provider ordering → clarified: NanoGPT mock in Phase 0.3, multi-provider fixtures added pre-M5 (was internally contradictory)
5. CI trigger → "every commit" → "every push and PR" with note that local pre-commit hook is separate (was ambiguous)
6. Lint rule gap → added `@typescript-eslint/ban-ts-comment` alongside `no-explicit-any` to cover `@ts-ignore`/`@ts-nocheck`/`@ts-expect-error` (was incomplete)

### All Codex Per-File Findings: DONE

All 43 findings across 8 batches have been resolved.

### Batch 9: Kimi/DeepSeek Consultation Findings (3 items) — DONE

1. M7a "5 categories" → fixed to "4 categories" in `fundamentals.md` and `docs/spec/11-error-handling.md`
2. `provider.default` nested field → replaced with top-level `defaultProvider` + `apiTimeout` in `fundamentals.md`, `docs/spec/09-config-secrets.md`, `docs/spec/17-multi-provider.md`, `docs/steps/02-milestone2-tools-perms.md`
3. `SecretPattern` interface → added to `docs/steps/02-milestone2-tools-perms.md` (M2.8), `fundamentals.md`, `docs/spec/08-permissions-sandbox.md`

## Next Step

**DONE.** All 38 test audit fixes applied. Phase 0 coding begins. See `docs/handoff-phase0.md`.

## Key Files

| File | Purpose |
|------|---------|
| `fundamentals.md` | Complete spec (20 blocks, ~2400 lines). Monolithic source of truth |
| `docs/spec/` | Split spec — 22 files, each < 10K tokens. Agent-readable |
| `docs/steps/` | Split steps — 11+ files per milestone. **Being actively edited** |
| `docs/codex-per-file-results/` | Raw Codex review findings (11 files) |
| `docs/changelog.md` | Full session history |
| `plan.md` | High-level roadmap (7 milestones) |

## Tech Stack (unchanged)
- TypeScript on Node.js, ESM, strict mode
- WSL2 (Linux)
- NanoGPT API (primary provider)
- vitest for testing
