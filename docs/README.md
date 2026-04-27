# ACA Documentation

Start here:

- [README](../README.md): install, configuration, and common commands.
- [Roadmap](planning/roadmap.md): current state, known limits, and next work.
- [Changelog](releases/changelog.md): concise release-facing summary.
- [Publication checklist](dev/publication-checklist.md): pre-GitHub checks.
- [Known issues](planning/known-issues.md): current test/product caveats.
- [Security](../SECURITY.md): safe-use notes for a tool-running local agent.

For the exact live command surface, prefer the root `README.md` plus `aca --help`
and subcommand help such as `aca consult --help`. The spec files below are design
references, not the canonical source for every current flag or subcommand detail.

Design references:

- [Spec](spec/): protocol and architecture notes.
- [Implementation steps](steps/): milestone-level engineering history.
- [Archive](archive/): historical handoffs, reviews, planning notes, and audit workstreams.
- [Workflow](dev/workflow.md): internal development/review loop.
- [Tool call conformance](dev/tool-call-conformance.md): native/emulated tool-call contract, local gate, and optional live probe.
- [Structure](dev/structure.md): how the design docs were split for agent consumption.

Archive notes:

- `archive/handoffs/`: session handoffs and restart prompts.
- `archive/reviews/`: review outputs, including the former `codex-per-file-results/`.
- `archive/planning/`: `fundamentals.md`, `plan.md`, `goal*.md`, and the older monolithic `steps.md`.
- `archive/audits/`: completed or paused audit workstreams.

Archive files can contain dated diagnostics or historical assumptions that are superseded by later work. They are kept for traceability and are not the primary user guide.
