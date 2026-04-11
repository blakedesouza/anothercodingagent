# M3.1 Handoff — Token Estimation + `estimate_tokens` Tool

**Date:** 2026-03-30
**Status:** M3.0b complete. Ready for M3.1.

## What's Done (M3.0b)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| 4-layer prompt structure (system, tools, context, history) | Complete | 5 |
| Instruction precedence (5-level, explicit in system prompt) | Complete | 2 |
| Capability health injection (degraded/unavailable) | Complete | 3 |
| Active errors pinned section | Complete | 3 |
| Tool definitions (all registered tools every turn) | Complete | 1 |
| Per-turn context (project, working set, durable task state) | Complete | 4 |
| Conversation message conversion (user/assistant/tool/summary) | Complete | 6 |
| Model request structure (model, maxTokens, temperature) | Complete | 2 |
| buildContextBlock, buildToolDefinitions, buildConversationMessages | Complete | 2 |

**Total tests: 645 passing** (617 prior + 28 new).

**Consultation:** 4/4 witnesses, 1 fix applied (activeErrors pinned section).

## What to Do Next (M3.1)

Implement Token Estimation + `estimate_tokens` Tool (Block 7, Block 2).

### What to Build

- Byte-based heuristic: `ceil(utf8ByteLength / 3)` per text block
- Structural overheads: +12 per message, +24 per tool call/result, +40 per tool schema
- Per-model `bytesPerToken` from model registry (default 3.0)
- Per-model calibration EMA: ratio `actual / estimated`, starts at 1.0, updated after each LLM call
- Safe input budget: `safeInputBudget = contextLimit - reservedOutputTokens - estimationGuard`
- `estimate_tokens` tool: input (text or file paths, model) → token count, fits-in-context flag

### Key Test Cases

- Empty string → 0 tokens
- ASCII/Unicode byte counting
- Message + tool call overheads
- EMA calibration convergence (5-call convergence, ratio shift, missing data)
- Safe budget calculations (200K and 32K contexts)
- Per-model bytesPerToken override
- `estimate_tokens` tool: text input + file paths

## Dependencies

- M3.0b `assemblePrompt` (just completed — provides the structure being estimated)
- M1.4 NanoGPT driver / model registry (for `bytesPerToken` per model)
- M1.5 ToolRegistry (for registering `estimate_tokens` tool)

## File Locations

| File | Purpose |
|------|---------|
| `src/core/token-estimator.ts` | Byte-based heuristic, overheads, EMA calibration, safe budget |
| `test/core/token-estimator.test.ts` | All token estimation tests |
| `src/tools/estimate-tokens.ts` | `estimate_tokens` tool implementation |
| `test/tools/estimate-tokens.test.ts` | Tool-level tests |
| `src/core/prompt-assembly.ts` | Dependency — the structure being estimated |
| `src/types/provider.ts` | ModelCapabilities.bytesPerToken |
