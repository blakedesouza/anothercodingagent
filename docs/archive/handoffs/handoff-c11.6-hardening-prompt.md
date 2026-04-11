# Handoff Prompt: C11.6 Hardening Complete — Next: Disk Persistence + C11.7 Battery

Read plan.md and docs/handoff-c11.6-hardening.md before doing anything else.

▎
▎ Project: Another Coding Agent (ACA) — TypeScript coding agent at
▎ <repo>. Built binary at dist/index.js.
▎ Tests: npx vitest run. Build: npm run build. 2661 tests passing going in.
▎
▎ This session has two tasks in priority order:
▎
▎ TASK 1 — Continuation round disk persistence (open since symbol-lookup session)
▎ In runWitness() in src/cli/consult.ts, write each extra round's response to:
▎   /tmp/aca-consult-{witness}-round-{n}-{suffix}.md
▎ Currently only the first context-request and final response are persisted.
▎ Mid-loop round failures leave no artifacts for post-mortem debugging.
▎ This is a small targeted addition — no new tests needed beyond confirming
▎ the files appear after a multi-round live consult run.
▎
▎ TASK 2 — Stress-test battery re-run (C11.7 regression validation)
▎ Re-run the C11.1 battery across models to confirm C11 hardening holds.
▎ Reference: docs/archive/audits/c11/failure-catalog.md for the original failure catalog.
▎ Key regressions to watch: DeepSeek S4 (large tool results, was llm.malformed),
▎ Qwen reasoning_content leakage (fixed C11.3), MiniMax result-narration.
▎ Run at minimum: kimi, deepseek, qwen, gemma across S1/S3/S4.
▎
▎ Do Task 1 first (small, self-contained). Then Task 2.
▎ Both are live tests — local-only is not sufficient.
▎
