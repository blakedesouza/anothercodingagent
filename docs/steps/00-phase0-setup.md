# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Phase 0: Pre-Implementation Setup

### 0.1 — Spec Cross-Reference Updates
> Ref: plan.md "Pre-Implementation Cleanup"

Update `fundamentals.md` to propagate Block 17-20 surfaces into earlier blocks:

- [x] Block 5: Add `budget_exceeded` as 9th turn outcome
- [x] Block 9: Update `provider` config to reference `providers` array (Block 17)
- [x] Block 10: Add `aca stats` to command tree, `/reindex` and `/budget` to slash commands
- [x] Project Awareness: Add `indexStatus` field to ProjectSnapshot

**Tests:** N/A (spec-only changes). Verify consistency by grep for each new term.

### 0.2 — Project Scaffolding
> Ref: Tech Stack, all blocks

- [x] `npm init` with `"type": "module"` (ESM)
- [x] Install TypeScript 5.x, configure `tsconfig.json` (strict, ESM, Node 20+ target, path aliases)
- [x] Install vitest, configure `vitest.config.ts` (include `passWithNoTests: true` for initial zero-test state)
- [x] Install `commander` (CLI framework)
- [x] Install development tooling: `tsx` (dev runner), `tsup` (build)
- [x] Create directory structure:
  ```
  src/
    types/          # Block 5 data model types
    core/           # Block 6 turn engine, Block 7 context
    providers/      # Block 17 provider drivers
    tools/          # Tool implementations
    permissions/    # Block 8 sandbox, approval, risk
    config/         # Block 9 config loader
    cli/            # Block 10 CLI entry points
    rendering/      # Block 18 terminal rendering
    observability/  # Block 14/19 events, SQLite
    indexing/       # Block 20 embeddings, symbols
    delegation/     # Sub-agent system
  test/
    (mirrors src/)
    fixtures/       # Test data files
  ```
- [x] Create `src/index.ts` entry point with minimal CLI stub (`commander` setup, `--help` exits cleanly, `--version` shows package version)
- [x] Add npm scripts: `build`, `dev`, `test`, `test:watch`, `lint`
- [x] Git init if needed, initial commit

**Tests:**
- `npm run build` completes without errors
- `npm test` runs and passes (zero test files, `passWithNoTests: true`)
- `node --import tsx src/index.ts --help` exits cleanly (requires the CLI stub above)
- `node --import tsx src/index.ts --version` outputs version from package.json

### 0.3 — Test Infrastructure
> Ref: Cross-Cutting, all milestones

Test infrastructure must exist before M1, as mock provider and fixtures are needed for M1.4+ and snapshot testing is needed for M4.

- [x] Mock NanoGPT HTTP server for provider tests (configurable responses: text, tool calls, errors, streaming delays)
- [x] Test fixture directory with sample files: small text, large (>2000 lines), binary (null bytes), empty, multilingual (UTF-8 with multi-byte chars)
- [x] Test session factory: create sessions with predefined conversation state (items, turns, steps)
- [x] Snapshot testing setup: vitest snapshot configuration for rendering output comparisons
- [x] Path alias resolution aligned across vitest, tsup, and runtime (`@/` → `src/`)

**Acceptance criteria:**
- Mock server starts/stops cleanly in test setup/teardown
- Mock server supports configurable SSE streaming responses
- Test session factory produces valid `Session` objects conforming to Block 5 schema (SessionManager integration verified in M3 when it is implemented)
- Snapshot files stored in `test/__snapshots__/`
- Path aliases resolve identically in tests, build, and `tsx` dev runner

---
