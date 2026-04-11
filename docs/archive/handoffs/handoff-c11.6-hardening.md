# Handoff: C11.6 Post-Validation Hardening

**Date:** 2026-04-10
**Status:** COMPLETE
**Tests:** 2661 passing, 14 pre-existing failures, 1 skipped.

---

## What Was Done This Session

### 1. Obfuscation Live Validation (Tests A/B/C)

Validated the identifier obfuscation feature (implemented last session) against real models.

- **Test A** (`wrapStreamWithToolEmulation`): qwen `status: ok`, `success_count: 4`. Primary goal met — no pseudo-tool-call error.
- **Test B** (`execCommand`): qwen `status: ok`, `context_requests: 1`, `success_count: 4`, `degraded: False`. Full pass.
- **Test C** (neutral regression, `formatOtlpPayload`): 4/4 ok on final run. One earlier run had qwen error — pre-existing non-determinism.

### 2. Context-Request Prompt Placeholder Fix

**Problem discovered:** qwen copied the example path `"relative/path.ts"` from the `needs_context` JSON template verbatim rather than substituting a real path from `<symbol_locations>`. Its chain-of-thought reasoning identified the correct file (`src/consult/identifier-obfuscation.ts`) but the JSON output had the placeholder.

**Fix:** `src/consult/context-request.ts` — three prompt builders updated:
- `buildContextRequestPrompt` (line ~174)
- `buildContinuationPrompt` (line ~265)
- `buildSharedContextRequestPrompt` (line ~321)

Change: `"relative/path.ts"` → `"src/path/to/file.ts"` (visually distinct placeholder) + added instruction immediately after each example: *"Replace `src/path/to/file.ts` with a real repo-relative path from the symbol locations listed above or a prior tree response. Do not copy this placeholder."*

**Live-validated:** `obfuscateIdentifiers` question → qwen requested `src/consult/identifier-obfuscation.ts` (correct). Pre-fix: ENOENT on `relative/path.ts`, answered without file content.

### 3. LOADED_TERMS Blocklist

**Problem discovered:** Hyphenated compounds (`pseudo-tool-call`, `tool-call`, etc.) bypass the camelCase/snake_case regex but are equally contaminating. Confirmed: question with `"pseudo-tool-call"` literal → qwen `status: error` even with `classifyWitnessFirstPass` already obfuscated.

**Fix:** `src/consult/identifier-obfuscation.ts` — `LOADED_TERMS` constant added:
```
pseudo-tool-call, pseudo-tool-use, function-call, tool-call, api-call, tool-use
```
- Longest-first ordering (prevents `tool-call` from matching inside `pseudo-tool-call` before the superset is replaced)
- Case-insensitive detection and replacement (`i`/`gi` flags)
- Shares same A/B/C label sequence with programming identifiers — identifiers get earlier labels, loaded terms get subsequent ones

**Live-validated:** `classifyWitnessFirstPass` + `"pseudo-tool-call"` in same question → qwen `status: ok`, `success_count: 4`, 7 context requests. Pre-fix: `status: error`.

**Tests:** 6 new unit tests in `test/consult/identifier-obfuscation.test.ts` (16 total in file).

---

## Open Items (Next Session)

### 1. Continuation Round Disk Persistence (carried from symbol-lookup session)

In `runWitness()` in `src/cli/consult.ts`, write each extra round's response to disk:
```
/tmp/aca-consult-{witness}-round-{n}-{suffix}.md
```
Currently only the first context-request and final response are persisted. Mid-loop failures leave no forensic artifacts.

### 2. Stress-Test Battery Re-Run (C11.7 regression validation)

Re-run the C11.1 battery (5 scenarios × 6 models) to confirm the C11 hardening work holds:
- S1: Simple single-tool task
- S2: Multi-tool chain
- S3: Consult pipeline (4 witnesses)
- S4: Large tool results (62KB — was P1 for DeepSeek pre-fix)
- S5: Model-specific stress

Reference: `docs/archive/audits/c11/failure-catalog.md` for baseline failure modes.
