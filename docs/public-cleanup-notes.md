# Public Cleanup Notes

ACA is currently published as a public WIP. The repository intentionally keeps
design history, milestone notes, and handoff archives visible for traceability.

## Keep For Now

- `docs/spec/` and `docs/steps/`: active design and milestone references.
- `docs/archive/planning/fundamentals.md`, `docs/archive/planning/plan.md`, `docs/archive/planning/goal.md`, and `docs/archive/planning/goal2.md`: design history and historical project-state notes.
- `CLAUDE.md`, `AGENTS.md`, `docs/dev/workflow.md`, and `docs/dev/structure.md`: useful for agent-driven development and contributor context.
- `docs/archive/handoffs/` and `docs/archive/reviews/codex-per-file-results/`: noisy but acceptable WIP archive material while the project is still moving quickly.

## Consider For A Cleaner v1

- Keep new handoffs under `docs/archive/handoffs/`, not the `docs/` root.
- Keep generated review output under `docs/archive/reviews/`, not the `docs/` root.
- Trim or summarize archived planning docs if the repo starts feeling too heavy for new readers.
- Keep the public docs front door focused on `README.md`, `docs/README.md`, `docs/planning/roadmap.md`, `docs/planning/known-issues.md`, `docs/releases/changelog.md`, and `SECURITY.md`.

## Keep Out Of Git

- Local runtime/config: `.aca/`, `.claude/`, `.codex`, `.mcp.json`.
- Generated build/dependency output: `dist/`, `node_modules/`, coverage, test reports.
- Local research/scratch output: `.local/`, `bug-report-*`, generated RP project folders, screenshots, logs, `.env` files.
