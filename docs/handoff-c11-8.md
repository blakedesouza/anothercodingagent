# C11.8 Handoff — Classification Bug Fixed; Path Navigation Open

## Status

| Bug | Status |
|-----|--------|
| Bug 2 — `extractPlainMarkdownReport` misclassifies Markdown with inline `{}` | **FIXED** — commit `9da83a0` |
| Bug 1 — Model never explored `src/cli/` (path navigation) | **FIXED** — commit `0912435` |
| Continuation round responses not persisted to disk | **Open** |

**Test baseline:** `npm run build` → clean. `npm test` → 2630 passing, 14 pre-existing failures, 1 skipped.

---

## Bug 2 — FIXED

### Root cause

`extractJsonPayload` in `src/cli/consult.ts` had a fallback heuristic:

```ts
const start = stripped.indexOf('{');
const end = stripped.lastIndexOf('}');
if (start >= 0 && end > start) return stripped.slice(start, end + 1);
```

When a witness response contained `` `Record<string, string[]> = {}` `` in inline backtick code, `indexOf('{')` and `lastIndexOf('}')` found the `{` and `}` from `= {}`, extracted `"{}"`, and `JSON.parse('{}')` succeeded. `parseJsonObject` returned `{}` (truthy), causing `extractPlainMarkdownReport` to return `null` — misclassifying a valid Markdown report as invalid.

### Fix (`src/cli/consult.ts` line ~220)

```ts
const searchable = stripped.replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));
const start = searchable.indexOf('{');
const end = searchable.lastIndexOf('}');
if (start >= 0 && end > start) return stripped.slice(start, end + 1);
```

Inline code spans are blanked with spaces (preserving positions) before scanning. The heuristic's intended use case — prose-wrapped JSON like `"Here is the response: {...}"` — is unaffected.

### Live validation

7 consult runs across all 4 models. Key trigger hits:

| Test | Model | Trigger pattern in response | Status |
|------|-------|-----------------------------|--------|
| 1 | kimi | `` `{}` `` (MODEL_HINTS) | ok ✓ |
| 2 | deepseek | `` `Record<string, number> = {};` `` | ok ✓ |
| 2 | kimi | `` `Record<string, number> = {}` `` | ok ✓ |
| 3 | deepseek | `` `Record<string, unknown> = {};` `` | ok ✓ |
| 4 | deepseek | `` `const args: Record<string, unknown> = {};` `` | ok ✓ |
| 6 | gemma | entire response = single inline span `` `private readonly errors: Record<string, number> = {};` `` | ok ✓ |
| 7 | qwen | inline code in thinking trace: `` `const config: Record<string, unknown> = {};` `` | ok ✓ |

Test 6 (gemma) is the definitive forced-trigger test: the entire response was the trigger pattern, and the fix prevented misclassification.

---

## Bug 1 — Open: Model never explored `src/cli/`

### What happened (C11.7 test 3)

DeepSeek received a 2-level tree of `.` which showed `src/cli/` as a directory but not its contents. It inferred that consult logic lives in `src/consult/` (reasonable but wrong — the orchestration is in `src/cli/consult.ts`). It never requested a tree of `src/cli/`, guessed `src/consult/consult.ts` and `src/prompts/consult.ts`, got ENOENT on both, and produced a forced-finalization report saying "the file doesn't exist."

### Fix applied (commit `0912435`)

Both hypotheses were applied together:

**A — `maxDepth=3` (primary fix):** `buildDirectoryTree` default changed from 2→3. At maxDepth=2, a root tree showed `src/cli/` as a directory entry but blocked its contents (walk-depth 3 > maxDepth 2). At maxDepth=3, `src/cli/consult.ts` is now directly visible in any root tree. Root listing size at depth 3 is ~300-500 lines — well within 24KB snippet cap. Two regression tests added: one confirming depth-3 exposes files in second-level dirs, one confirming depth-4 is still blocked.

**B — Prompt guidance (belt-and-suspenders):** Added to both `buildContextRequestPrompt` and `buildContinuationPrompt` Limits sections: "If a domain-named directory (e.g., `consult/`) doesn't appear to contain the expected file, request a tree of sibling generically-named directories (`cli/`, `cmd/`, `commands/`, `bin/`) before concluding it is absent — entry-point orchestration code often lives in those directories and delegates to domain modules."

Also updated "2-level listing" text to "3-level listing" throughout both prompts.

**Test baseline:** 2632 passing, 14 pre-existing failures, 1 skipped.

### Live validation (3 runs, all post-fix)

| # | Question target | Target file | Score | Notes |
|---|-----------------|-------------|-------|-------|
| 1 | Hard-rejected tool call error code | `src/cli/invoke-output-validation.ts` | 3/4 | kimi found confusion tracking (`tool.validation`, `turn-engine.ts`) instead |
| 2 | TOOL_NAMES constant + MediaWiki entries | `src/cli/tool-names.ts` | 4/4 | Unanimous; both `fetch_mediawiki_page` + `fetch_mediawiki_category` exact |
| 3 | Runtime context system message logic | `src/cli/invoke-runtime-state.ts` | 3/4 | qwen emitted deliberation only (no findings); deepseek/kimi/gemma correct |

**Navigation mechanism verified (test 2):** DeepSeek opened with `{ "type": "tree", "path": "." }`, the 3-level root listing exposed `src/cli/tool-names.ts` directly, and it navigated to the correct file without any ENOENT. Pre-fix this file would have been invisible in the root tree.

---

## Open: Continuation round responses not persisted

Currently only the round-1 context-request (`raw_request_path`) and the final pass (`finalRawPath`) are written to disk. Round 2 and 3 responses have no artifact, making post-mortem debugging hard.

- [ ] In `runWitness()` in `src/cli/consult.ts`, write each round's response to `/tmp/aca-consult-{witness}-round-{n}-{suffix}.md`
- [ ] Decide priority: is this worth doing before Bug 1, or after?

---

## Key files

- `src/cli/consult.ts` — `extractJsonPayload` (line ~215), `extractPlainMarkdownReport` (line ~255), `classifyWitnessFinal` (line ~320), `runWitness` (line ~507)
- `src/consult/context-request.ts` — `buildContextRequestPrompt` (~133), `buildDirectoryTree`, `buildContinuationPrompt`
- `src/consult/evidence-pack.ts` — `buildDirectoryTree`, `IGNORE_DIRS`
