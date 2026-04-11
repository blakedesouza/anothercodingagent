# M3.3 Handoff — Compression Tier Actions

**Date:** 2026-03-30
**Status:** M3.2 complete. Ready for M3.3.

## What's Done (M3.2)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `determineTier` (4 tiers, boundary-correct) | Complete | 7 |
| `escalateTier` (linear progression, emergency fixed point) | Complete | 4 |
| `estimateItemTokens` (message/tool_result/summary + calibration) | Complete | 5 |
| `groupIntoTurns` (user-message boundaries, preamble, summaries) | Complete | 7 |
| `findToolCallArgs` (toolCallId lookup across items) | Complete | 2 |
| `computeDigest` (6 tool-specific formats + unknown fallback) | Complete | 8 |
| `assembleContext` (7-step algorithm, packing, escalation, guards) | Complete | 20 |

**Total tests: 745 passing** (692 prior + 53 new).

**Consultation:** 4/4 witnesses, 2 consensus fixes applied (25% guard universality, negative budget guard).

## What to Do Next (M3.3)

Implement Compression Tier Actions (Block 7) — the tier-specific content transformations.

### What to Build

- **Tier `full`**: all verbatim, full context block, full tool descriptions, full instructions
- **Tier `medium`**: summarize oldest prefix, trim project snapshot (root + stack + git only), keep recent 4-6 turns verbatim
- **Tier `aggressive`**: summarize all but last 2-3 turns, minimal context block (cwd + stack + git), short-form tool descriptions (name + one-liner + param names only)
- **Tier `emergency`**: drop all history except current turn chain, no project detail, signatures only, core rules only

### Key Test Cases

- Tier full -> all components present, tool descriptions have full detail
- Tier medium -> project snapshot reduced (verify specific fields removed)
- Tier aggressive -> tool descriptions are short-form (no parameter descriptions, no examples)
- Tier emergency -> stderr warning emitted, only always-pinned sections remain
- Cumulative: aggressive includes medium's compression + adds its own

## Dependencies

- M3.2 `assembleContext`, `determineTier`, `estimateItemTokens` (this module)
- M3.0b `assemblePrompt`, `buildContextBlock`, `buildToolDefinitions` (content to transform)
- M3.0a `renderProjectContext`, `ProjectSnapshot` (project detail to trim)

## File Locations

| File | Purpose |
|------|---------|
| `src/core/context-assembly.ts` | Extend with tier action functions |
| `test/core/context-assembly.test.ts` | Add tier action tests |
| `src/core/prompt-assembly.ts` | Context block + tool definitions (dependency) |
| `docs/spec/07-context-window.md` | Block 7 spec |
