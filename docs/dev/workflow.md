# ACA Development Workflow

This is an internal development workflow, not the public user guide. Start with
the root `README.md` for normal usage.

Standard operating procedure for every milestone substep. Current default consultation uses the `minimax + gemma` witness pair unless a task explicitly needs a different lineup.

## The Cycle

```
1. Route       → Decide whether this is repo work, `aca consult`, `aca invoke`, or another ACA workflow
2. Read        → Understand requirements from handoff/step doc, `CONTEXT.md`, and relevant source
3. Classify    → Name the change class, affected contracts, likely blast radius, and strongest risk
4. Implement   → Write the smallest complete slice
5. Validate    → Run focused checks first, then `npm run verify` when the change warrants the full gate
6. Consult     → Send implementation to the default witness pair for review when logic, types, I/O, safety, or contracts changed
7. Apply       → Fix grounded findings, then rerun the affected checks
8. Update      → Mark task docs, update current project-state docs, and append changelog only when project convention expects it
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

Include bounded evidence with the prompt: relevant spec chunks, source excerpts, changed files, failing output, or an evidence pack. Prefer `docs/spec/` chunks over the monolithic foundation unless the exact archived source block is needed.

## Milestone Boundaries

At the end of each milestone (7 total):
- Run integration smoke test (e.g., M1.10)
- Run full consultation with integration-focused prompt
- Update current project-state docs with milestone completion status

## Known AI Blind Spots

Categories that witness-pair consensus can still miss:

| Category | Why | Mitigation |
|----------|-----|-----------|
| **Semantic bugs** | Code is correct but solves wrong problem | Include spec excerpts or an evidence pack in prompt |
| **Performance** | AI optimizes correctness, not efficiency | Manual review for hot paths |
| **Integration** | Each substep reviewed in isolation | Milestone integration tests |
| **Async races** | Happy-path bias in training data | Extra scrutiny on concurrent code |

## Rules

- **Opus is the judge, not a vote counter.** Minority positions with stronger evidence override majority.
- **Track misses.** If a bug is found post-consultation, analyze why witnesses missed it and improve prompts.
- **Include bounded evidence.** Witnesses can request context, but the prompt should still provide the key spec/source/test evidence needed for the review.
- **Don't skip re-testing.** Consultation fixes can introduce new issues.
