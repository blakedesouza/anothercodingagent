# Phase 0 Handoff — COMPLETE

**Date:** 2026-03-29
**Status:** DONE. Committed as `7f65065`. 27 tests passing, build clean, lint clean. Reviewed by 3 external AI witnesses — 2 compliance fixes applied. Proceed to `docs/handoff-milestone1.md`.

## What's Done

| Work | Status |
|------|--------|
| Spec (`fundamentals.md`, 20 blocks) | Complete |
| Split spec (`docs/spec/`, 22 files < 10K tokens each) | Complete |
| Step files (`docs/steps/`, 11 files) | Complete |
| Codex review — round 1 (21 findings) | All fixed |
| Codex review — round 2 per-file (43 findings, 8 batches) | All fixed |
| Kimi/DeepSeek consultation (3 findings, batch 9) | All fixed |
| Test audit (38 items: 6 contradictions, 20 vague tests, 9 missing groups, 6 spec-only suites) | All fixed |
| 5 deferred items (U5, U6, U8, U9, U11 — undefined spec areas) | Documented in handoff-test-audit.md |

## What to Do First

Execute `docs/steps/00-phase0-setup.md` in order:

### 0.1 — Spec Cross-References (already done in fundamentals.md, verify only)
- `budget_exceeded` in Block 5, `providers` array in Block 9, `aca stats`/`/reindex`/`/budget` in Block 10, `indexStatus` in ProjectSnapshot

### 0.2 — Project Scaffolding
1. `npm init` with `"type": "module"` (ESM) — package.json exists but needs ESM + scripts
2. Install: `typescript@5.x`, `vitest`, `commander`, `tsx`, `tsup`
3. Configure: `tsconfig.json` (strict, ESM, Node 20+, path aliases `@/` → `src/`)
4. Configure: `vitest.config.ts` (passWithNoTests, path aliases)
5. Create directory structure (see 00-phase0-setup.md for full tree)
6. Create `src/index.ts` CLI stub (commander, --help, --version)
7. npm scripts: build, dev, test, test:watch, lint
8. ESLint: `@typescript-eslint/no-explicit-any` + `@typescript-eslint/ban-ts-comment`
9. Git commit

### 0.3 — Test Infrastructure
1. Mock NanoGPT HTTP server (configurable SSE streaming, errors)
2. Test fixtures (small text, large >2000 lines, binary, empty, UTF-8 multibyte)
3. Test session factory (valid Block 5 Session objects)
4. Snapshot testing config
5. Path alias resolution verified across vitest, tsup, tsx

### Then: Milestone 1
After 0.2 + 0.3 pass, proceed to `docs/steps/01-milestone1-agent-loop.md`.

## Key Files

| File | Purpose |
|------|---------|
| `fundamentals.md` | Complete spec, 20 blocks (~2400 lines). Source of truth |
| `docs/spec/` | Split spec — 22 files, each < 10K tokens. Feed to external agents |
| `docs/steps/00-phase0-setup.md` | **Start here.** Scaffolding + test infra |
| `docs/steps/01-milestone1-agent-loop.md` | M1: minimal agent loop (first real code) |
| `docs/steps/02-milestone2-tools-perms.md` | M2: tools + permissions |
| `docs/steps/03-milestone3-context-state.md` | M3: context + state |
| `docs/steps/04-milestone4-rendering.md` | M4: terminal rendering |
| `docs/steps/05-milestone5-provider-obs.md` | M5: multi-provider + observability |
| `docs/steps/06-milestone6-indexing.md` | M6: project intelligence |
| `docs/steps/07a-milestone7-error-health.md` | M7A: error handling + health |
| `docs/steps/07b-milestone7-delegation.md` | M7B: delegation |
| `docs/steps/07c-milestone7-capabilities.md` | M7C: LSP, browser, checkpointing |
| `docs/steps/08-cross-cutting.md` | CI, lint rules, mock provider ordering |
| `docs/changelog.md` | Full design decision history |
| `docs/handoff-test-audit.md` | Test audit task list (all resolved) |
| `plan.md` | High-level roadmap + current state |

## Tech Stack

- **Language:** TypeScript, strict mode, ESM
- **Runtime:** Node.js 20+
- **Environment:** WSL2 (Linux). GUI apps run on Windows side natively
- **LLM Provider:** NanoGPT API (primary). Anthropic/OpenAI added in M5
- **Testing:** vitest
- **Build:** tsup (bundler), tsx (dev runner)
- **CLI:** commander

## Architecture (7 Milestones)

```
M1: Agent Loop     → providers/, core/, types/, tools/read_file
M2: Tools + Perms  → tools/*, permissions/, config/
M3: Context        → core/context, core/summarizer, core/durable-state
M4: Rendering      → rendering/
M5: Multi-Provider → providers/anthropic, providers/openai, observability/
M6: Indexing       → indexing/
M7: Advanced       → delegation/, tools/lsp, tools/browser, core/checkpoint
```

## Decisions to Remember

1. **NanoGPT-only in M1.** Multi-provider abstraction comes in M5. Don't over-engineer the provider interface early.
2. **Step files are the implementation guide.** Each step has concrete tests. Follow them sequentially within each milestone.
3. **Split files for external agents.** Any doc > 300 lines must be split. External models (Codex, Kimi, DeepSeek) timeout on large files.
4. **Test-first.** Each step specifies tests. Write tests before or alongside implementation.
5. **No `any`.** TypeScript strict mode enforced by ESLint. No `@ts-ignore` without description.
6. **Mock provider ordering.** NanoGPT mock in Phase 0.3. Anthropic/OpenAI mocks added pre-M5.
7. **M7 is split into 3 files** (7a: error/health, 7b: delegation, 7c: capabilities). 7a must be done first — error codes and health states are referenced by everything else.

## Session Rules

- Small batches (1-2 tasks then checkpoint)
- Read before edit
- Context7 before guessing APIs
- No delete/revert without confirmation
- Update plan.md after each milestone step
- Update changelog.md after meaningful work
