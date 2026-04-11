# Handoff: C11.6 — Tool Emulation Hardening + Qwen Blockquote Fix

**Date:** 2026-04-10
**Status:** Not started. Tests pre-written below.
**Test count going in:** 2641 passing, 14 pre-existing failures, 1 skipped.

---

## Scope

Two parts. Do Part A first (smaller, unblocks live validation), then Part B.

| Part | What | File |
|------|------|------|
| A | Qwen blockquote stripping in consult path | `src/consult/context-request.ts`, `src/cli/consult.ts` |
| B | Tool emulation prompt hardening | `src/providers/tool-emulation.ts` |

---

## Part A — Qwen Blockquote Stripping

### Problem

`qwen/qwen3.5-397b-a17b` wraps its entire output — including the `needs_context` JSON it intends to emit — in `>` blockquote lines via `delta.content`. Confirmed with `NANOGPT_DEBUG`: the stream starts `"Thinking...\n> The"` and everything follows as `> text`. The `classifyWitnessFirstPass` parser never sees bare JSON, treats the response as a final (empty) report, and the witness contributes nothing.

The model hint ("don't wrap in blockquotes") is in the system message and qwen acknowledges it inside its own reasoning — then ignores it.

### Fix

Add `stripBlockquoteMarkers` to `src/consult/context-request.ts` (exported so it's testable). In `runWitness()`, pass the stripped text to `classifyWitnessFirstPass` for classification while keeping the original text for disk artifacts and retry prompts.

### New function: `src/consult/context-request.ts`

Add after the existing exports, before `parseContextRequests`:

```ts
/**
 * Strips `> ` blockquote markers from the start of each line.
 * Used to recover parseable JSON from models (e.g. Qwen3) that wrap
 * their entire response in blockquote syntax via delta.content.
 */
export function stripBlockquoteMarkers(text: string): string {
    return text
        .split('\n')
        .map(line => line.replace(/^> ?/, ''))
        .join('\n');
}
```

### Wiring: `src/cli/consult.ts`

1. Import `stripBlockquoteMarkers` from `../consult/context-request.js` (add to existing import block around line 6–22).

2. Line ~593 — classification of the live round:
   ```ts
   // BEFORE:
   let classification = classifyWitnessFirstPass(roundText, limits);

   // AFTER:
   let classification = classifyWitnessFirstPass(stripBlockquoteMarkers(roundText), limits);
   ```

3. Line ~605 — classification of the retry response:
   ```ts
   // BEFORE:
   const retryClass = classifyWitnessFirstPass(retryResponse.response.result ?? '', limits);

   // AFTER:
   const retryClass = classifyWitnessFirstPass(stripBlockquoteMarkers(retryResponse.response.result ?? ''), limits);
   ```

Keep `roundText` (NOT stripped) for:
- Writing to `responsePath` on disk (raw response preserved for debugging)
- `buildContextRequestRetryPrompt(prompt, roundText, limitsObj)` (retry prompt references original)
- `lastEffectiveResponseText` (the report the triage receives)

---

## Part B — Tool Emulation Prompt Hardening

### Problem

`buildToolSchemaPrompt` in `src/providers/tool-emulation.ts:24` shows the format once but gives no example of what a correct vs. incorrect emission looks like. MiniMax (S1 P3 from the C11.1 failure catalog) interleaves prose with the emulation JSON instead of emitting the JSON object alone.

### Fix

Extend `buildToolSchemaPrompt` with a concrete worked example (correct) and two explicit anti-patterns (wrong). Keep the example short — models parse examples better than rules.

Add after the existing `'- After tool results arrive, call another tool or give your final text answer.'` line:

```ts
'',
'CORRECT — entire response is only the JSON object:',
'{"tool_calls":[{"name":"read_file","arguments":{"path":"src/main.ts"}}]}',
'',
'WRONG — prose before the JSON:',
'I will read the file now. {"tool_calls":[...]}',
'',
'WRONG — JSON split across lines or wrapped in fences:',
'```json',
'{"tool_calls":[...]}',
'```',
```

### Acceptance

Run an S4-style invoke battery (multi-turn tool use, large context) across kimi, qwen, deepseek, gemma. Zero tool-schema-format failures (no `llm.malformed` from bad JSON, no prose-before-JSON interleaving).

---

## Pre-written Unit Tests

**File:** `test/consult/blockquote-strip.test.ts` (new file — create before implementing)

```ts
import { describe, it, expect } from 'vitest';
import {
    stripBlockquoteMarkers,
    parseContextRequests,
} from '../../src/consult/context-request.js';

const limits = { maxSnippets: 5, maxLines: 100, maxBytes: 50_000, maxRounds: 3 };

describe('stripBlockquoteMarkers', () => {
    it('strips > prefix from every line', () => {
        const input = '> line one\n> line two\n> line three';
        expect(stripBlockquoteMarkers(input)).toBe('line one\nline two\nline three');
    });

    it('handles qwen-style indented blockquote content', () => {
        // Qwen emits ">     {" — strip the "> " leaving "    {"
        const input = '>     {\n>       "key": "value"\n>     }';
        const stripped = stripBlockquoteMarkers(input);
        expect(stripped).toBe('    {\n      "key": "value"\n    }');
        // And the resulting JSON is parseable
        expect(() => JSON.parse(stripped.trim())).not.toThrow();
    });

    it('leaves non-blockquoted lines unchanged', () => {
        const input = 'normal line\n> blockquoted\nnormal again';
        expect(stripBlockquoteMarkers(input)).toBe('normal line\nblockquoted\nnormal again');
    });
});

describe('parseContextRequests with qwen-style blockquoted response', () => {
    it('extracts needs_context JSON buried in blockquoted deliberation', () => {
        // Mirrors the actual qwen response pattern observed in live testing 2026-04-10
        const qwenResponse = [
            '> 1. Analyze the request.',
            '> 2. I cannot see the function body. Need to read the file.',
            '>     {',
            '>       "needs_context": [',
            '>         {',
            '>           "type": "file",',
            '>           "path": "src/observability/telemetry.ts",',
            '>           "line_start": 256,',
            '>           "line_end": 290,',
            '>           "reason": "Inspect formatOtlpPayload implementation and return type"',
            '>         }',
            '>       ]',
            '>     }',
        ].join('\n');

        const stripped = stripBlockquoteMarkers(qwenResponse);
        const requests = parseContextRequests(stripped, limits);
        expect(requests).toHaveLength(1);
        expect(requests[0].path).toBe('src/observability/telemetry.ts');
        expect(requests[0].line_start).toBe(256);
        expect(requests[0].reason).toContain('formatOtlpPayload');
    });
});
```

---

## Live Tests

### Live Test A — Qwen blockquote fix

Source-verified: `formatOtlpPayload` is at `src/observability/telemetry.ts:256`.
Previously: qwen's `context_requests` array was `[]` (request swallowed due to blockquotes).

```bash
SUFFIX=$(date +%s) && HOME=$(mktemp -d -t aca-c116-qwen-XXXXXX) \
  node dist/index.js consult \
  --question "What does formatOtlpPayload do, what does it return, and what file defines it?" \
  --project-dir <repo> \
  --max-context-rounds 3 \
  2>&1 | tee /tmp/aca-c116-qwen-${SUFFIX}.txt
```

**Pass criteria:** qwen's `context_requests` array is **non-empty** — it requests `src/observability/telemetry.ts` and receives a real snippet.

### Live Test B — Tool emulation (after Part B)

After Part B, run the existing invoke battery from C11.1 (S4-style multi-tool) across kimi/qwen/deepseek/gemma. Zero format failures. Add new live test command after implementing Part B.

---

## Verification Checklist

Before starting:
- [ ] `src/consult/context-request.ts` does NOT yet export `stripBlockquoteMarkers`
- [ ] `test/consult/blockquote-strip.test.ts` does not yet exist

After Part A:
- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run build` — clean
- [ ] `npm test` — 2641 + new tests passing, 14 pre-existing failures, 1 skipped
- [ ] Live Test A: qwen `context_requests` non-empty, `src/observability/telemetry.ts` in the path

After Part B:
- [ ] `npm test` — still passing
- [ ] Live Test B: zero tool-schema-format failures across 4 models
