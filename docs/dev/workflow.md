# ACA Development Workflow

This is an internal development workflow, not the public user guide. Start with
the root `README.md` for normal usage.

Standard operating procedure for every milestone substep. Validated by 4-model consultation (MiniMax, Kimi, Qwen, Llama) on 2026-03-30.

## The Cycle

```
1. Read        → Understand requirements from handoff/step doc
2. Implement   → Write the code
3. Lint        → tsc --noEmit + ESLint (catch compiler issues before consultation)
4. Test        → vitest run (all tests must pass)
5. Consult     → Send implementation to all 4 AI witnesses for review
6. Apply       → Fix consensus findings
7. Re-test     → Confirm fixes don't break anything
8. Update      → Mark checkboxes in step file, update current project-state docs, append changelog
```

## When to Skip Consultation (Step 5)

Consultation spends model budget and wall-clock time. Use it when it adds review value, and keep witness prompts/tool access bounded.

Skip **only** for purely mechanical changes:
- File renames, moves, re-exports
- Documentation-only updates
- Comment/formatting changes

If it touches **logic, types, or I/O** → always consult.

## Consultation Prompt Profiles

Tailor the prompt based on what the substep does:

| Profile | Use When | Focus Directive |
|---------|----------|----------------|
| **Data/Schema** | Type definitions, serialization, parsing | Discriminant coverage, type coercion, array/object confusion, unsafe casts |
| **I/O** | File ops, network, streams | Crash safety, resource cleanup, malformed input, error propagation |
| **Logic/State** | State machines, business rules, control flow | Invariant preservation, exhaustive transitions, race conditions, ordering |
| **Security** | Permissions, exec, sandboxing, secrets | Injection, TOCTOU, privilege escalation, input validation |

Always include the relevant `docs/archive/planning/fundamentals.md` spec block excerpt in the prompt so witnesses can verify semantic correctness (not just syntactic).

## Milestone Boundaries

At the end of each milestone (7 total):
- Run integration smoke test (e.g., M1.10)
- Run full consultation with integration-focused prompt
- Update current project-state docs with milestone completion status

## Known AI Blind Spots

Categories that 4-model consensus consistently misses:

| Category | Why | Mitigation |
|----------|-----|-----------|
| **Semantic bugs** | Code is correct but solves wrong problem | Include spec excerpts in prompt |
| **Performance** | AI optimizes correctness, not efficiency | Manual review for hot paths |
| **Integration** | Each substep reviewed in isolation | Milestone integration tests |
| **Async races** | Happy-path bias in training data | Extra scrutiny on concurrent code |

## Rules

- **Opus is the judge, not a vote counter.** Minority positions with stronger evidence override majority.
- **Track misses.** If a bug is found post-consultation, analyze why witnesses missed it and improve prompts.
- **Include spec context.** Witnesses can't read project files — inline the relevant spec block.
- **Don't skip re-testing.** Consultation fixes can introduce new issues.
