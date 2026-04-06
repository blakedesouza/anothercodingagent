# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Cross-Cutting Concerns

These apply throughout implementation, not in a single milestone.

### Test Infrastructure

> **Moved to Phase 0.3.** M1 and M4 depend on mock provider, fixtures, and snapshot testing. These must exist before implementation begins.

### Continuous Integration

- [ ] All tests run on every push and PR (CI pipeline trigger; local pre-commit hook is optional and separate)
- [ ] TypeScript strict mode, no `any` escape hatches — add ESLint rules: `@typescript-eslint/no-explicit-any`, `@typescript-eslint/ban-ts-comment` (covers `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error` without description)
- [ ] Build produces a runnable binary
- [ ] Mock provider ordering: NanoGPT mock is built in Phase 0.3 and used from M1 onward. Multi-provider fixtures (Anthropic/OpenAI response shapes) are added as a pre-M5 extension — they are not needed until M5 provider normalization tests

---
