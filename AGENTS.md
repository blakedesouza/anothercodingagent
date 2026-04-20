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
- If you change a symbol, contract, schema, counter, prompt, default, or tool shape, search for what it affects and update those places too.
- Do not stop at the first passing test.

## Change Blast Radius

- Before editing, classify the change: local logic, shared helper, tool/schema contract, persisted metadata, replay/resume, derived state, prompt/protocol, retry/guardrail/default behavior, or counter/sequence/turn numbering.
- If the change is anything other than local logic, assume blast radius.
- For every changed symbol or contract, search producers, consumers, persistence, replay/resume, derived views, prompts/examples, and tests/fixtures.
- Minimum search: `rg -n "SymbolName|field_name|error.code|tool_name|old_shape|new_shape" src test docs`
- Before stopping, answer: what writes this value, what reads it, whether it is persisted, whether it is reconstructed later, whether there is any derived representation, whether tests assert the old shape, and whether prompts/docs teach the old behavior.
- If any of those answers is unknown, the work is not done.

## Invariants

- Counters increment across iterations.
- IDs and sequence numbers stay unique across turns.
- Persisted metadata round-trips through save/load/resume.
- Resume/replay rebuilds the same state as a live run.
- One canonical identity exists per file/resource.
- Compressed context still matches raw behavior.
- Prompts/examples match real tool schemas.
- Repair/fallback/default paths follow the same contract as the main path.
- Tests cover second-turn, second-run, and resumed-state behavior.

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
- When driving Linux-side work from PowerShell 7 on this machine, prefer the local `iwsl` helper for ad hoc scripts and `wtask` for repeatable workflows to avoid quoting and CRLF mangling across the Windows/WSL boundary.
