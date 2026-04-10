# Project Instructions

## Documentation

All project documentation lives in `/docs/` at the project root. Any documentation — design docs, architecture notes, research, decisions, guides — must be written as a markdown file inside `docs/`.

Do not create documentation files outside of `docs/`.

## File Size Limits (MANDATORY)

No single markdown or documentation file may exceed **300 lines or ~10,000 tokens**. This is a hard project rule — not a guideline.

**Why:** External AI agents (Codex, Kimi, DeepSeek) have context window limits and timeout when processing large files. Monolithic files block multi-model consultation workflows.

**Rules:**
- When a file approaches 300 lines, split it into a directory of smaller files with a `README.md` index
- The original monolithic file may be kept as a canonical source, but split files are the working copies agents read
- Each split file must be self-contained enough to be understood without reading all sibling files
- Split files include a source comment linking back to the original (e.g., `<!-- Source: fundamentals.md lines 100-200 -->`)

**Current split structure:**
- `fundamentals.md` (2389 lines) → `docs/spec/` (22 files, each < 10K tokens)
- `docs/steps.md` (1300 lines) → `docs/steps/` (9 files, each < 7K tokens)

When creating new documentation, prefer multiple focused files over one large file from the start.

## External Agent Consultation

When consulting external AI models (Codex, Kimi, DeepSeek), follow these rules:

- **Codex `-C` flag reads the entire codebase.** With 300K+ bytes of markdown, this always causes timeouts. Never use `-C` with large projects.
- **Feed Codex docs one file at a time** via `codex exec --full-auto` with content inlined in the prompt. Each file takes 2-5 min instead of timing out.
- **Kimi cannot read project files** via tool calls. Inline all content directly in the consultation prompt.
- **DeepSeek** works with the standard consultation flow.
- **File size limits are critical for consultation.** Every doc file must stay under 300 lines / ~10K tokens so any external agent can process it without timeout or context overflow.

## Progress Tracking

After completing each milestone or substep:
- Mark checkboxes `[x]` in the relevant `docs/steps/` file
- Update the handoff doc status (e.g., `docs/handoff-phase0.md` → COMPLETE)
- Create the next handoff doc if entering a new milestone

## Testing Philosophy (MANDATORY)

**Most tests must be live. Local tests are the minority.**

Live tests run the built `aca` binary against real NanoGPT models and prove actual behavior. Local tests (unit, integration with mocks) are useful but secondary — they can pass while live behavior is broken.

**Rules:**
- For any runtime-facing change, live validation is required before the work is considered done
- Run live tests across multiple models (kimi, deepseek, qwen, gemma minimum) — models are volatile and behave differently
- One live run on one model is not sufficient proof
- Local test pass is not a completion signal — it is only a sanity check
- Report live results first; mention local tests second if at all

**Live test format:**
- Use a temp HOME: `HOME=$(mktemp -d -t aca-<feature>-XXXXXX)`
- Run the built dist: `node dist/index.js <command>`
- Write durable artifacts to `/tmp/` with timestamped names
- Inspect actual model output, not just exit codes

**When local-only tests are acceptable:**
- Pure deterministic logic with no model dependency (parsers, validators, aggregators)
- Tests that explicitly mock the provider layer and only test non-model code paths

## Changelog

`docs/changelog.md` is a living document. After completing any meaningful work (gap resolutions, block definitions, implementation milestones, refactors), append a dated entry summarizing what changed, why, and how.
