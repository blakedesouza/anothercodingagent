# Project Structure

How this project is organized and why. Follow this pattern for any new project.

## The Pipeline

```
Foundation  →  Spec Chunks  →  Steps  →  Handoffs  →  Code
(creative)     (split for AI)  (testable)  (auto-generated)  (built per workflow)
```

Each stage feeds the next. Don't skip ahead.

## 1. Foundation (`docs/archive/planning/fundamentals.md`)

The monolithic design document. Created through iterative brainstorming, consultation, and refinement across multiple sessions.

- **What it is:** The complete spec — every block, every decision, every type definition
- **How it's made:** Back-and-forth with AI consultation. Expect multiple sessions of drafting, reviewing, consulting witnesses, and revising
- **Rule:** This is the source of truth. When anything disagrees, this wins
- **Lesson learned:** Witnesses CANNOT read this file directly — it's 2389 lines / ~80K tokens. Always use the split chunks instead

## 2. Spec Chunks (`docs/spec/`)

The foundation split into digestible pieces for AI consumption.

- **What it is:** 22 files, each <300 lines / <10K tokens
- **How it's made:** Split the foundation after it's stable. Each chunk is self-contained with a source comment linking back
- **Rule:** Every file must stay under 300 lines. This is a hard limit — external AI agents timeout on larger files
- **When to split:** After the foundation is solid. Don't split too early (you'll be editing two places) or too late (witnesses can't review)

```
docs/spec/
├── 01-pluggable-delegation.md
├── 02-tool-surface.md
├── 03-web-capabilities.md
├── ...
└── 20-rich-indexing.md
```

## 3. Steps (`docs/steps/`)

Concrete, testable implementation steps derived from the spec.

- **What it is:** One file per milestone, each containing numbered substeps with checkboxes and test requirements
- **How it's made:** Derived from the spec chunks. Each substep references its source blocks
- **Rule:** Every substep must have testable acceptance criteria. No vague "implement X" — specify what to test and how
- **Metadata:** Each substep should include `<!-- spec: ... -->` references to relevant spec chunks

```
docs/steps/
├── 00-phase0-setup.md
├── 01-milestone1-agent-loop.md
├── 02-milestone2-tools-perms.md
├── ...
└── 08-cross-cutting.md
```

## 4. Handoffs (`docs/archive/handoffs/`)

Created as substeps complete. Everything the next session needs to pick up where you left off.

- **What it is:** A summary of what's done, what's next, key decisions made, and open questions
- **How it's made:** Generated at the end of each substep (by `/build` or manually)
- **Rule:** Must be self-contained. A new session should be able to start from just the handoff plus current project-state docs.

## 5. Supporting Files

| File | Purpose |
|------|---------|
| `docs/archive/planning/plan.md` | Historical high-level project state |
| `docs/dev/workflow.md` | The standard development cycle (read → implement → lint → test → consult → apply → retest) |
| `docs/dev/structure.md` | This file — how the project is organized |
| `docs/releases/changelog.md` | Living record of what changed and why |

## Key Lessons

1. **Never let AI witnesses read the monolithic foundation.** Always use spec chunks
2. **Split at 300 lines.** External AI agents timeout above ~10K tokens
3. **Foundation first, code last.** The creative design phase takes multiple sessions — don't rush it
4. **Every substep gets consulted.** 4 AI witnesses review every piece of code before it's finalized
5. **Handoffs preserve context.** Sessions end, context windows clear — handoffs are how you survive that
