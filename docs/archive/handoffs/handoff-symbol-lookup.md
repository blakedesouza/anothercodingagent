# Handoff: Symbol Lookup in Consult Pipeline

## Status

**Open.** Implementation not started. Tests pre-written below.

---

## Bug

When a consult question contains a literal function name (e.g. `countHardRejectedToolCalls`),
witnesses navigate to the wrong files and declare the function absent — even though the 3-level
directory tree exposes the correct file. The kimi and gemma witnesses guessed plausible-sounding
locations (`aggregator.ts`, `stats.ts`, `sqlite-store.ts`) and never looked at
`src/cli/invoke-output-validation.ts`.

## Diagnosis (proved experimentally, 2026-04-10)

Two question phrasings were tested:

| Phrasing | kimi result | gemma result | deepseek result |
|----------|-------------|--------------|-----------------|
| Semantic: "hard-rejected tool calls" | Finds right file, sometimes wrong detail | Finds right file | Correct |
| Literal: `countHardRejectedToolCalls` | Looks in wrong files, declares absent | Looks in wrong files, declares absent | Correct immediately |

**Conclusion: the failure is model-level navigation, not question ambiguity.** Changing the
question phrasing changes *which* wrong files witnesses pick, but does not fix the underlying
problem. The model hints help with file selection in the semantic case but have no lever on
the literal-name case.

**Deepseek is reliable** in both phrasings — it requests the root tree, sees the 3-level listing,
and navigates directly. Kimi and gemma over-infer domain from function names.

## Fix: Pre-located Symbol Injection

Before witnesses start navigating, the consult pipeline should grep the project for any
code identifiers found in the question and inject their definition locations as a grounding
block in the initial context-request prompt.

This short-circuits witness navigation for the "where does X live" step — witnesses receive
the file:line pre-answered and only need to read and analyze.

### New module: `src/consult/symbol-lookup.ts`

```ts
export interface SymbolLocation {
    identifier: string;
    file: string;    // relative path from project root, e.g. "src/cli/invoke-output-validation.ts"
    line: number;    // 1-indexed definition line
    snippet: string; // the definition line itself, trimmed
}

/**
 * Extracts camelCase and PascalCase identifiers from question text.
 * Filters out words shorter than 6 chars and common English words to avoid noise.
 * Examples: "countHardRejectedToolCalls" → extracted; "invoke" → filtered out.
 */
export function extractCodeIdentifiers(question: string): string[];

/**
 * Greps src/ inside projectDir for export/function definition lines matching each identifier.
 * Uses child_process.execFile with rg or grep — no shell injection risk (args passed directly).
 * Returns at most one location per identifier (the first definition match).
 * Returns [] for identifiers with no match.
 */
export async function resolveSymbolLocations(
    identifiers: string[],
    projectDir: string,
): Promise<SymbolLocation[]>;
```

### Wiring

**`src/consult/context-request.ts` — `buildContextRequestPrompt`:**
- Add optional parameter `symbolLocations?: SymbolLocation[]`
- When non-empty, inject a `<symbol_locations>` block before the navigation guidance:

```
<symbol_locations>
The following code identifiers were found in the question. Their definition
locations in this project are pre-verified — use them as your starting point:

- countHardRejectedToolCalls → src/cli/invoke-output-validation.ts line 77
</symbol_locations>
```

**`src/cli/consult.ts` — `runWitness()`:**
- Before calling `buildContextRequestPrompt`, call `extractCodeIdentifiers(prompt)` then
  `resolveSymbolLocations(identifiers, projectDir)`
- Pass result as `symbolLocations` to the prompt builder

### Implementation constraints

- Grep runs only over `src/` (not `node_modules`, `dist`, `test`)
- Definition patterns to match (ripgrep `-e` alternatives):
  - `export function {id}(`
  - `export async function {id}(`
  - `export const {id} `
  - `export class {id}`
  - `export interface {id}`
  - `export type {id} `
- Cap: max 5 identifiers extracted, max 5 locations resolved (avoid prompt bloat)
- If `rg` is unavailable, fall back to `grep -rn`
- Silently skip any identifier that resolves to 0 matches

---

## Pre-written Unit Tests

**File:** `test/consult/symbol-lookup.test.ts`

These import from `src/consult/symbol-lookup.ts` which does not exist yet. Tests will
fail with `MODULE_NOT_FOUND` until the module is created. Add them to the test suite
before implementing — they drive the implementation.

All line numbers are grounded in source read on 2026-04-10:

```ts
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    extractCodeIdentifiers,
    resolveSymbolLocations,
} from '../../src/consult/symbol-lookup.js';

const PROJECT_DIR = join(fileURLToPath(import.meta.url), '../../../');

// ─── Test 1: identifier extraction ───────────────────────────────────────────

describe('extractCodeIdentifiers', () => {
    it('extracts a camelCase function name from a question', () => {
        const ids = extractCodeIdentifiers(
            'What does countHardRejectedToolCalls do and what file is it in?',
        );
        expect(ids).toContain('countHardRejectedToolCalls');
    });

    it('extracts a PascalCase type name from a question', () => {
        const ids = extractCodeIdentifiers(
            'Where is PrepareInvokeTurnConfigOptions defined?',
        );
        expect(ids).toContain('PrepareInvokeTurnConfigOptions');
    });

    it('does not extract short common words', () => {
        const ids = extractCodeIdentifiers(
            'What does the invoke pipeline do and how does it handle errors?',
        );
        // none of these are code identifiers — too short or plain English
        expect(ids).not.toContain('What');
        expect(ids).not.toContain('does');
        expect(ids).not.toContain('invoke');
        expect(ids).not.toContain('handle');
        expect(ids).not.toContain('errors');
    });

    it('caps output at 5 identifiers', () => {
        const ids = extractCodeIdentifiers(
            'findFooBar findBazQux findAlphaBeta findGammaTheta findDeltaSigma findEpsilonZeta',
        );
        expect(ids.length).toBeLessThanOrEqual(5);
    });
});

// ─── Test 2: symbol resolution against real codebase ─────────────────────────

describe('resolveSymbolLocations', () => {
    it('finds countHardRejectedToolCalls in invoke-output-validation.ts at line 77', async () => {
        const locs = await resolveSymbolLocations(
            ['countHardRejectedToolCalls'],
            PROJECT_DIR,
        );
        expect(locs).toHaveLength(1);
        expect(locs[0].identifier).toBe('countHardRejectedToolCalls');
        expect(locs[0].file).toContain('invoke-output-validation.ts');
        expect(locs[0].line).toBe(77);
        expect(locs[0].snippet).toContain('countHardRejectedToolCalls');
    });

    it('finds buildContextRequestPrompt in context-request.ts at line 143', async () => {
        const locs = await resolveSymbolLocations(
            ['buildContextRequestPrompt'],
            PROJECT_DIR,
        );
        expect(locs).toHaveLength(1);
        expect(locs[0].file).toContain('context-request.ts');
        expect(locs[0].line).toBe(143);
    });

    it('returns empty array for a nonexistent identifier', async () => {
        const locs = await resolveSymbolLocations(
            ['nonExistentFunctionXyzAbcDef'],
            PROJECT_DIR,
        );
        expect(locs).toHaveLength(0);
    });
});

// ─── Test 3: prompt injection ─────────────────────────────────────────────────
// Import buildContextRequestPrompt and verify the <symbol_locations> block appears
// when symbolLocations are passed.

import { buildContextRequestPrompt } from '../../src/consult/context-request.js';

describe('buildContextRequestPrompt with symbol locations', () => {
    const limits = { maxSnippets: 5, maxLines: 100, maxBytes: 50000, maxRounds: 3 };

    it('includes symbol_locations block when locations are provided', () => {
        const prompt = buildContextRequestPrompt(
            'What does countHardRejectedToolCalls do?',
            limits,
            3,
            3,
            [{
                identifier: 'countHardRejectedToolCalls',
                file: 'src/cli/invoke-output-validation.ts',
                line: 77,
                snippet: 'export function countHardRejectedToolCalls(items: readonly ConversationItem[]): number {',
            }],
        );
        expect(prompt).toContain('symbol_locations');
        expect(prompt).toContain('countHardRejectedToolCalls');
        expect(prompt).toContain('src/cli/invoke-output-validation.ts');
        expect(prompt).toContain('line 77');
    });

    it('omits symbol_locations block when no locations are provided', () => {
        const prompt = buildContextRequestPrompt(
            'What does countHardRejectedToolCalls do?',
            limits,
            3,
            3,
        );
        expect(prompt).not.toContain('symbol_locations');
    });
});
```

---

## Pre-written Live Tests

Run after implementation and unit tests pass. Each targets a function in `src/cli/` —
the directory that witnesses historically fail to navigate to when guessing from a
literal function name.

All bash commands use `node dist/index.js` (build first with `npm run build`).

### Live Test 1 — `countHardRejectedToolCalls`

Source-verified: `src/cli/invoke-output-validation.ts:77`

```bash
SUFFIX=$(date +%s) && HOME=$(mktemp -d -t aca-symlookup1-XXXXXX) \
  node dist/index.js consult \
  --question "What does countHardRejectedToolCalls do — what condition does it filter on, what error code does it check, and what file is it defined in?" \
  --project-dir /home/blake/projects/anothercodingagent \
  --max-context-rounds 3 \
  2>&1 | tee /tmp/aca-symlookup1-${SUFFIX}.txt
```

**Pass criteria:** All 4 witnesses name `src/cli/invoke-output-validation.ts` and report
`tool.max_tool_calls`. (Pre-fix: kimi and gemma declared the function absent.)

---

### Live Test 2 — `prepareInvokeTurnConfig`

Source-verified: `src/cli/invoke-runtime-state.ts:34`

```bash
SUFFIX=$(date +%s) && HOME=$(mktemp -d -t aca-symlookup2-XXXXXX) \
  node dist/index.js consult \
  --question "What does prepareInvokeTurnConfig do, what options does it accept, and what file is it defined in?" \
  --project-dir /home/blake/projects/anothercodingagent \
  --max-context-rounds 3 \
  2>&1 | tee /tmp/aca-symlookup2-${SUFFIX}.txt
```

**Pass criteria:** All 4 witnesses name `src/cli/invoke-runtime-state.ts`.

---

### Live Test 3 — `registerInvokeRuntimeTools`

Source-verified: `src/cli/invoke-tooling.ts:110`

```bash
SUFFIX=$(date +%s) && HOME=$(mktemp -d -t aca-symlookup3-XXXXXX) \
  node dist/index.js consult \
  --question "What does registerInvokeRuntimeTools do and what file defines it?" \
  --project-dir /home/blake/projects/anothercodingagent \
  --max-context-rounds 3 \
  2>&1 | tee /tmp/aca-symlookup3-${SUFFIX}.txt
```

**Pass criteria:** All 4 witnesses name `src/cli/invoke-tooling.ts`.

---

## Verification Checklist (for implementing session)

Before starting implementation:
- [ ] `src/consult/symbol-lookup.ts` does not yet exist (new file)
- [ ] `src/consult/context-request.ts` exports `buildContextRequestPrompt` at line 143
- [ ] `src/cli/consult.ts` contains `runWitness` function
- [ ] `test/consult/symbol-lookup.test.ts` does not yet exist (create it)

After implementation:
- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run build` — clean
- [ ] `npm test` — 2632 + (new tests) passing, 14 pre-existing failures, 1 skipped
- [ ] Live test 1 — all 4 witnesses name `invoke-output-validation.ts`
- [ ] Live test 2 — all 4 witnesses name `invoke-runtime-state.ts`
- [ ] Live test 3 — all 4 witnesses name `invoke-tooling.ts`
