# M3.0b Handoff — System Prompt Assembly

**Date:** 2026-03-30
**Status:** M3.0a complete. Ready for M3.0b.

## What's Done (M3.0a)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| Root detection (walk up, .git/ strongest) | Complete | 9 |
| Language/toolchain detection (21 markers) | Complete | 10 |
| Git state (branch, dirty/clean, staged) | Complete | 7 |
| ProjectSnapshot type | Complete | 3 |
| Context rendering (< 200 tokens) | Complete | 6 |
| Ignore rules (hardcoded + config) | Complete | 4 |
| Empty repo handling ((unborn) fallback) | Complete | 1 |

**Total tests: 617 passing** (577 prior + 40 new).

**Consultation:** 4/4 witnesses, 2 fixes applied (maxBuffer, empty repo branch fallback).

## What to Do Next (M3.0b)

Implement System Prompt Assembly (Block 13). This replaces M1.7's minimal AssembleContext with the full 4-layer structure.

### What to Build

- 4-layer structure:
  1. System parameter: identity, rules, tool-use policy (~500-800 tokens)
  2. Tool definitions: all enabled tools via provider mechanism
  3. Per-turn context block: OS, shell, cwd, project snapshot, working set, capability health
  4. Conversation history: recent verbatim + older summarized
- Instruction precedence: core rules > repo/user instructions > user request > durable state > prior conversation
- Capability health injection: degraded/unavailable states as context lines
- All enabled tools every turn (prompt caching makes repetition cheap)

### Key Test Cases

- Assemble with no conversation → system + tools + context block present
- Assemble with 5 turns → all included (under budget)
- Instruction precedence: verify ordering in assembled prompt
- Capability health: LSP=degraded → health line present in context block
- Tool definitions: all registered tools present in assembled request
- Per-turn context: project snapshot, working set, durable task state → all present

## Dependencies

- M3.0a `ProjectSnapshot` + `renderProjectContext` (just completed)
- M1.7 TurnEngine `AssembleContext` phase (will be replaced/extended)
- M1.5 ToolRegistry (for tool definitions)
- Provider types from `src/types/provider.ts` (for ModelRequest structure)

## File Locations

| File | Purpose |
|------|---------|
| `src/core/prompt-assembly.ts` | 4-layer system prompt assembly |
| `test/core/prompt-assembly.test.ts` | All prompt assembly tests |
| `src/core/project-awareness.ts` | ProjectSnapshot (dependency, just built) |
| `src/core/turn-engine.ts` | TurnEngine AssembleContext phase (to integrate with) |
