# AGENTS.md

## Defaults

- Prefer `rg` over `grep`.
- Keep changes minimal and focused.
- Explain tradeoffs briefly when multiple approaches are viable.

## Reliability

- When uncertain about facts, APIs, or versions, verify with tools or official docs before answering.
- Never guess. If verification is inconclusive, state that clearly.
- For version-sensitive APIs and unfamiliar libraries, check documentation before coding.

## Workflow

- For non-trivial tasks, share a brief approach before major edits.
- Avoid unrelated refactors or dependency additions unless requested.
- Add `TODO` notes for intentional placeholders/stubs.

## Verification

- Run relevant validation after code changes: tests, lint, typecheck, or the closest project equivalent.
- Do not report success unless verification passed, or explicitly state what could not be run.

## Debugging

- Start with 2-3 hypotheses and validate the strongest one with evidence before fixing.
- If a fix fails, reassess assumptions before attempting another.
- After 2 failed attempts on the same issue, summarize findings and ask for direction.

## Git Safety

- Never run destructive git commands without explicit approval.
- Never delete files/folders or revert existing changes without explicit confirmation.
- Before any destructive action, list exactly what will be affected.

## Environment

- The maintainer may work from WSL while running deliverables on Windows.
- For Windows deliverables in WSL workflows, prefer Windows-compatible build targets and instructions.
