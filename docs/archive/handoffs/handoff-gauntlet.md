# Handoff: C11 Full Gauntlet

**Date:** 2026-04-10
**Status:** Ready to run
**Purpose:** End-to-end regression validation of every major C9–C11 fix using real files and real models. Observe only — no fixes during the gauntlet run.

---

## What This Tests

| # | Name | Fix Targeted | Models |
|---|------|-------------|--------|
| 01 | Obfuscation + LOADED_TERMS | C11.6 identifier obfuscation, hyphenated-term blocklist | all 4 witnesses |
| 02 | Symbol lookup navigation | symbol-lookup session | all 4 witnesses |
| 03 | No-tools discipline (conceptual) | C9 guardrails + today's XML backtick fix | all 4 witnesses |
| 04 | Context-request placeholder fix | C11.6 placeholder → real path | all 4 witnesses |
| 05 | Multi-round + tree + round persistence | C11.7 multi-round loop, today's disk persistence | deepseek only |
| 06 | Un-evidenced-absence hardening | C11.5 triage classifier | all 4 witnesses |
| 07 | DeepSeek large context (47KB file) | C11.3 emulation protocol fix | deepseek only |
| 08 | XML backtick fix — tool-call concepts | today's fix | qwen only |
| 09 | Blockquote + obfuscation combo | C11.6 stripBlockquoteMarkers + obfuscation | qwen only |
| 10 | Full pipeline end-to-end | all of the above | all 4 witnesses + triage |

---

## Pass Criteria Per Test

**01 — Obfuscation + LOADED_TERMS**
- `classifyWitnessFirstPass` (camelCase) and `pseudo-tool-call` (hyphenated) appear in question
- Pass: `success_count: 4`, qwen `status: ok` (pre-fix: qwen `status: error`)

**02 — Symbol lookup navigation**
- Question mentions `runWitness` and `buildContinuationPrompt` → `<symbol_locations>` resolved
- Pass: witnesses request `src/cli/consult.ts` or `src/consult/context-request.ts` directly, no ENOENT on wrong guesses from symbol names

**03 — No-tools discipline (conceptual)**
- Pure design question, no repo context needed
- Pass: all 4 witnesses `status: ok`, 0 `accepted_tool_calls` each, no `pseudo-tool-call` errors

**04 — Context-request placeholder fix**
- Witnesses should request real file paths, not `relative/path.ts` or `src/path/to/file.ts`
- Pass: all `context_requests[].path` are real repo-relative paths (confirm no ENOENT on placeholder strings)

**05 — Multi-round + tree + round persistence**
- 3-round max, deepseek should request trees and navigate to correct files
- Pass: `status: ok`; `ls /tmp/aca-consult-deepseek-round-2-*.md` returns a file

**06 — Un-evidenced-absence hardening**
- Witnesses may claim "X is not implemented" — triage must classify these as open questions
- Pass: triage `status: ok`; triage report does NOT promote absence claims into consensus findings

**07 — DeepSeek large context**
- deepseek requests `src/cli/consult.ts` (~47KB) via context-request → receives it in continuation prompt
- Pass: `status: ok` (pre-fix: `llm.malformed` after large tool results)

**08 — XML backtick fix (tool-call concepts)**
- Question contains "tool-call" and "function-call" terminology → witnesses see them in prompts
- Pass: qwen `status: ok` (pre-fix: would trigger pseudo-tool-call on the quoted instruction text)

**09 — Blockquote + obfuscation combo**
- `stripBlockquoteMarkers` (camelCase) → obfuscated; qwen's blockquote reasoning must be stripped before classification
- Pass: qwen `status: ok`

**10 — Full pipeline end-to-end**
- All systems exercised together: symbol lookup, obfuscation, multi-round, triage, structured review
- Pass: `success_count: 4`, `triage.status: ok`, `structured_review.status: ok`

---

## Commands

Run from project root. All results to `/tmp/gauntlet-NN-result.json`. Run sequentially.

```bash
SUFFIX=$(date +%s)

# 01 — Obfuscation + LOADED_TERMS
node dist/index.js consult --witnesses all \
  --question "Review the classifyWitnessFirstPass function — does the pseudo-tool-call detection correctly handle the retryable flag, and what edge cases could cause a false positive?" \
  --max-context-rounds 3 \
  --out /tmp/gauntlet-01-result-$SUFFIX.json 2>/tmp/gauntlet-01-stderr-$SUFFIX.txt

# 02 — Symbol lookup navigation
node dist/index.js consult --witnesses all \
  --question "In runWitness, how does the buildContinuationPrompt function determine roundsRemaining? Could the counter ever allow an extra round beyond maxContextRounds?" \
  --max-context-rounds 3 \
  --out /tmp/gauntlet-02-result-$SUFFIX.json 2>/tmp/gauntlet-02-stderr-$SUFFIX.txt

# 03 — No-tools discipline (conceptual)
node dist/index.js consult --witnesses all \
  --question "What design principles should govern when an AI agent retries a tool call automatically versus escalating to the user? Consider latency, safety, and user trust tradeoffs." \
  --out /tmp/gauntlet-03-result-$SUFFIX.json 2>/tmp/gauntlet-03-stderr-$SUFFIX.txt

# 04 — Context-request placeholder fix
node dist/index.js consult --witnesses all \
  --question "Does the needs_context protocol in src/consult/context-request.ts correctly prevent witnesses from submitting placeholder paths instead of real file paths? What guards exist?" \
  --max-context-rounds 3 \
  --out /tmp/gauntlet-04-result-$SUFFIX.json 2>/tmp/gauntlet-04-stderr-$SUFFIX.txt

# 05 — Multi-round + tree + round persistence (check /tmp after)
node dist/index.js consult --witnesses deepseek \
  --question "What does the extractCodeIdentifiers function in src/consult/symbol-lookup.ts actually extract, and how does resolveSymbolLocations use that output to populate the <symbol_locations> block?" \
  --max-context-rounds 3 --skip-triage \
  --out /tmp/gauntlet-05-result-$SUFFIX.json 2>/tmp/gauntlet-05-stderr-$SUFFIX.txt

# 06 — Un-evidenced-absence hardening
node dist/index.js consult --witnesses all \
  --question "Does the ACA consult pipeline handle ENOENT results during context-request fulfillment? Does it fail silently, surface the error to the witness, or substitute empty content?" \
  --max-context-rounds 2 \
  --out /tmp/gauntlet-06-result-$SUFFIX.json 2>/tmp/gauntlet-06-stderr-$SUFFIX.txt

# 07 — DeepSeek large context (runConsult is in 47KB file)
node dist/index.js consult --witnesses deepseek \
  --question "Review the full runConsult function in src/cli/consult.ts — what are the main phases, and are there any gaps in error handling between the witness aggregation phase and the triage phase?" \
  --max-context-rounds 3 --skip-triage \
  --out /tmp/gauntlet-07-result-$SUFFIX.json 2>/tmp/gauntlet-07-stderr-$SUFFIX.txt

# 08 — XML backtick fix (tool-call concepts in question)
node dist/index.js consult --witnesses qwen \
  --question "In the ACA tool-emulation system, how does the tool-call detection distinguish between a legitimate tool invocation and a model that accidentally includes tool-call syntax in its prose output?" \
  --max-context-rounds 2 --skip-triage \
  --out /tmp/gauntlet-08-result-$SUFFIX.json 2>/tmp/gauntlet-08-stderr-$SUFFIX.txt

# 09 — Blockquote + obfuscation combo
node dist/index.js consult --witnesses qwen \
  --question "Review the stripBlockquoteMarkers function in src/consult/context-request.ts — what patterns does it handle and what edge cases might it miss?" \
  --max-context-rounds 2 --skip-triage \
  --out /tmp/gauntlet-09-result-$SUFFIX.json 2>/tmp/gauntlet-09-stderr-$SUFFIX.txt

# 10 — Full pipeline end-to-end
node dist/index.js consult --witnesses all \
  --question "Review the error handling in runWitness in src/cli/consult.ts — are the retryable vs. unrecoverable failure paths correctly distinguished? Are there cases where a failure could be swallowed silently?" \
  --max-context-rounds 3 \
  --out /tmp/gauntlet-10-result-$SUFFIX.json 2>/tmp/gauntlet-10-stderr-$SUFFIX.txt
```

---

## What to Report Per Test

For each result JSON, extract:
```bash
jq '{success_count, total_witnesses, degraded,
     witnesses: (.witnesses | to_entries[] | {key, status:.value.status, error:.value.error, context_requests:(.value.context_requests|length)}),
     triage_status: .triage.status,
     structured_review: .structured_review.status}' /tmp/gauntlet-NN-result-$SUFFIX.json
```

For test 05 specifically, also run:
```bash
ls /tmp/aca-consult-deepseek-round-*-*.md 2>/dev/null
```

Collect all results and report in a single table. Do not fix anything found — document failures for the next session.

---

## Build State Going In

- `2661 tests passing, 14 pre-existing failures, 1 skipped`
- `dist/index.js` built from commit on main (post-C11.7 battery + XML backtick fix)
- Build: `npm run build` before running if in doubt
