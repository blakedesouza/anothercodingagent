# Public Cleanup Notes

ACA is currently published as a public WIP. The repository intentionally keeps
design history, milestone notes, and handoff archives visible for traceability.

## Keep For Now

- `fundamentals.md`, `docs/spec/`, `docs/steps/`, `plan.md`, `goal.md`, and `goal2.md`: design history and current direction.
- `CLAUDE.md`, `AGENTS.md`, `WORKFLOW.md`, and `STRUCTURE.md`: useful for agent-driven development and contributor context.
- `docs/handoff-*` and `docs/codex-per-file-results/`: noisy but acceptable WIP archive material while the project is still moving quickly.

## Consider For A Cleaner v1

- Move `docs/handoff-*` into `docs/archive/` or a separate private notes repo.
- Move or trim `docs/steps.md` and `fundamentals.md` if the repo starts feeling too heavy for new readers.
- Move `docs/codex-per-file-results/` into an archive if casual GitHub readers do not need per-file review history.
- Keep the public docs front door focused on `README.md`, `docs/README.md`, `docs/roadmap.md`, `docs/known-issues.md`, and `SECURITY.md`.

## Keep Out Of Git

- Local runtime/config: `.aca/`, `.claude/`, `.codex`, `.mcp.json`.
- Generated build/dependency output: `dist/`, `node_modules/`, coverage, test reports.
- Local research/scratch output: `bug-report-*`, generated `rpproject/`, screenshots, logs, `.env` files.
