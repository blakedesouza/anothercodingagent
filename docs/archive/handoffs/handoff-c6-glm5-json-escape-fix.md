# Handoff: C6 GLM-5 JSON Escape Fix + Codebase-Wide Sanitization

**Date:** 2026-04-10
**Status:** Code complete, build clean, live Quints run NOT yet attempted with fixes

---

## What Happened / Why This Exists

During the first live C6 Quints discovery run (`aca rp-research "The Quintessential Quintuplets" --model zai-org/glm-5 --network-mode open`), GLM-5 successfully researched the series and drafted a full `discovery-plan.md`, but the run ended with `turn.required_outputs_missing` — no files on disk.

**Root cause confirmed via session forensics** (`ses_01KNX6QYXV3M07JJB3A92GDHJ1`):

GLM-5 emitted a `write_file` pseudo-tool-call with the plan content, but the JSON in the `arguments` field contained `\-` (backslash-dash), which is an invalid JSON escape per RFC 8259. `JSON.parse` threw a `SyntaxError`. The salvage path's `catch { continue }` swallowed it silently. No file was written. The discovery manifest was never attempted.

This is a genuine new failure mode — not covered by C9–C11. Those fixes addressed:
- C9.5: GLM-5 trying native tool calls → `NO_NATIVE_FUNCTION_CALLING`
- C8.8: GLM-5 `delta.reasoning` field name
- C11.3: Qwen preamble strip
- C11.6: CORRECT/WRONG examples in `buildToolSchemaPrompt`

The `\-` escape is produced when GLM-5 writes Markdown list items inside a JSON string. Markdown sometimes uses `\-` as a literal dash escape; GLM-5 carries this into its JSON content strings.

---

## Opus Audits Performed

Two Opus agents ran before implementation:

1. **Targeted audit** (`/tmp/agent-findings-rp-audit.md`) — found the root cause and 5 gaps in `rp-research.ts` and `tool-emulation.ts`
2. **Spider-web audit** (`/tmp/agent-findings-spider-audit.md`) — confirmed regex safety, found regex fallback overcapture bug (introduced and fixed same session), found 5 more unguarded `JSON.parse` sites across the codebase, confirmed no test snapshot impact

---

## All Changes Made

### `src/providers/tool-emulation.ts`

1. **Added `sanitizeModelJson(text: string): string`** (exported)
   - Strips invalid JSON escape sequences: `/\\([^"\\\/bfnrtu])/g` → `'$1'`
   - Valid escapes (`\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX`) are preserved
   - `\\-` (double backslash) is correctly left alone
   - Only limitation: malformed `\uZZZZ` (non-hex after `\u`) not repaired — pre-existing edge case

2. **Applied `sanitizeModelJson` at all three internal `JSON.parse` sites:**
   - `parseToolCallObject` (line ~138)
   - `parseToolCallArray` (line ~214)
   - `parseSingleToolCallObject` (line ~226)

3. **Added escape-validity guidance to `buildToolSchemaPrompt`:**
   - New bullet: `\-`, `\.`, `\<`, `\>` are forbidden — write the literal character instead

4. **Fixed raw angle-bracket placeholders in `buildToolSchemaPrompt`:**
   - `<tool_name>` → `TOOL_NAME`
   - `<arguments>` → `ARGUMENTS`
   - `<tool_call>`, `<function_calls>`, `<invoke>` in the "do not emit" line → backtick-wrapped

### `src/cli/rp-research.ts`

1. **Imported `sanitizeModelJson`** from `tool-emulation.js`

2. **Fixed `extractPseudoWriteFileCall`:**
   - `JSON.parse(call.arguments)` → `JSON.parse(sanitizeModelJson(call.arguments))`
   - Silent `catch { continue }` → stderr log + regex fallback
   - Regex fallback uses `/((?:[^"\\]|\\.)*)/s` for content — properly JSON-string-aware, not greedy (`[\s\S]*` overcapture bug was introduced and fixed same session)

3. **Fixed JSON template placeholders in `buildDiscoveryTask`:**
   - Wrapped entire JSON template in a ` ```json ``` ` fence
   - Replaced `<canonical title>`, `<series slug>`, `<brief summary>` etc. with `CANONICAL_TITLE`, `SERIES_SLUG`, `BRIEF_SUMMARY` etc. (all-caps, no angle brackets)
   - Same pattern as C11.7 XML backtick fix — prevents Qwen/model from echoing them as XML

### Codebase-wide `sanitizeModelJson` applied to model-output `JSON.parse` sites

All of these parse text that came from an LLM and had no prior sanitization:

| File | Location | What it parses |
|---|---|---|
| `src/core/turn-engine.ts` | `~line 1603` | Native tool-call arguments from stream |
| `src/consult/context-request.ts` | `~line 363` | `needs_context` JSON from witness response |
| `src/cli/consult.ts` | `~line 235` | Consult response JSON object |
| `src/core/summarizer.ts` | `~line 413` | LLM summarization response JSON |
| `src/core/durable-task-state.ts` | `~line 460` | LLM durable-state patch response JSON |
| `src/review/witness-finding.ts` | `~line 138` | Structured witness finding JSON |

---

## What Was NOT Changed (Intentionally)

- `src/consult/identifier-obfuscation.ts` — consult-only, handles semantic priming not JSON escapes
- `src/consult/context-request.ts:extractJsonPayload` — strips fences only, orthogonal
- Anthropic/OpenAI drivers — they don't use `parseEmulatedToolCalls`; native tool calls go through `turn-engine.ts` which is now covered
- `RP_FRESH_RETRYABLE_INVOKE_ERROR_CODES` — not changed; `turn.required_outputs_missing` is still non-retryable by design (salvage path handles it)

---

## Current C6 State

- `aca rp-research` command: fully wired, builds clean
- Quints folder: `/home/blake/projects/rpproject/the-quintessential-quintuplets/` — skeleton created, **no content files yet**
- Discovery artifacts: **none on disk** (previous run failed before writing)
- **Next action: rerun Quints discovery with the fixed binary**

```bash
node dist/index.js rp-research "The Quintessential Quintuplets" \
  --model zai-org/glm-5 \
  --network-mode open
```

Expected behavior after fix:
1. GLM-5 runs discovery, emits write_file pseudo-call with `\-` in content
2. `sanitizeModelJson` strips the `\-` → valid JSON
3. `JSON.parse` succeeds → discovery-plan.md written
4. Repeat for discovery-manifest.json
5. Timeline gate fires: prints options, exits with `timeline_required`
6. Re-run with `--blank-timeline` to generate world/ files

---

## Remaining C6 Work (After Next Session Validates Discovery)

- [ ] Run discovery, confirm both research files land
- [ ] Re-run with `--blank-timeline` → world.md, world-rules.md, locations/, characters/
- [ ] Review generated files against EXAMPLE format and authoring contract
- [ ] Iterate depth/width until approved
- [ ] Update `docs/changelog.md` with C6 completion entry

---

## Key Files for Next Session

- `src/cli/rp-research.ts` — the full RP import workflow
- `src/providers/tool-emulation.ts` — `sanitizeModelJson` lives here
- `RP_RESEARCH_WORKFLOW.md` — durable workflow doc
- `RP_AUTHORING_CONTRACT.md` — the format rules (character sections, world/rules split, location rules)
- `/home/blake/projects/rpproject/EXAMPLE/` — reference format (use .md, not .txt)
- `plan.md` — C6 status updated
