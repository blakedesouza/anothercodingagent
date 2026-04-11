# C11.7 Handoff — Multi-Round Context-Request Loop + Directory Tree Support

## Status: Steps 1–3 done (uncommitted), Steps 4–9 remaining

### What was built in the previous session

**Goal:** Witnesses kept hallucinating file paths (wrong directories) and answering from truncated files. Fix: multi-round context loop so witnesses can explore, then fetch, and receive full files.

**Steps 1–3 COMPLETE — changes in working tree, not yet committed:**

`src/consult/context-request.ts`:
- `ContextRequest` — added `type?: 'file' | 'tree'`
- `ContextSnippet` — added `type?: 'file' | 'tree'`
- `ContextRequestLimits` — added `maxRounds: number`
- Defaults raised: `maxSnippets` 3→8, `maxLines` 120→300, `maxBytes` 8K→24K, `maxRounds: 3`
- `normalizeContextRequests()` — parses `type: 'tree'` from witness JSON, sets `line_start: 0, line_end: 0`
- `buildDirectoryTree(root, relPath, maxDepth=2)` — new function, uses exported `IGNORE_DIRS`, returns formatted 2-level tree
- `fulfillContextRequests()` — branches on `type === 'tree'`: resolves path, checks it's a directory, calls `buildDirectoryTree`, returns tree text as a `ContextSnippet`
- `renderContextSnippets()` — tree snippets get `### tree: path` heading (no `:line-line`); also fixed silent `[truncated]` → actionable marker

`src/consult/evidence-pack.ts`:
- `IGNORE_DIRS` changed from `const` to `export const` so context-request.ts can import it

`plan.md`: updated with C11.7 progress

**Baseline confirmed:** `npm run build` clean, `npm test` → 2617 passing, 14 pre-existing failures

---

### Steps 4–9 remaining

Full plan at: `/home/blake/.claude/plans/tender-dazzling-sundae.md`

**Step 4 — `buildContinuationPrompt()` in `context-request.ts`**
New exported function for rounds 2+. Shows: original prompt + all previously fulfilled snippets + round status + context-request protocol (allowing more requests). Signature:
```ts
export function buildContinuationPrompt(
    originalPrompt: string,
    priorSnippets: ContextSnippet[],
    roundsRemaining: number,
    limits: ContextRequestLimits,
    model?: string,
): string
```

**Step 5 — Update `buildContextRequestPrompt()` in `context-request.ts`**
Add `roundsRemaining?: number` and `totalRounds?: number` parameters.
- Add round status line: "You have N context-request rounds remaining."
- Final round: "**This is your final context-request round.** After receiving snippets, produce your final answer."
- Add `type: "tree"` to JSON example in the protocol section
- Update "Do not request broad directories" → "Use `type: 'tree'` for 2-level directory listing. Do not request whole-repo searches."

**Step 6 + 8 — Multi-round loop in `runWitness()` + `ConsultOptions` plumbing (`consult.ts`)**
This is the core structural change. `runWitness()` (lines 507–677) currently does one context-request pass then one finalization pass.

Replace with a `while (roundsUsed < maxRounds)` loop:
- Each iteration: invoke → `classifyWitnessFirstPass` → if `needs_context`, fulfill + continue; if `report`, break; if `invalid`+retryable, one retry
- Accumulate all snippets and requests across rounds into `allSnippets[]` and `allRequests[]`
- After loop or if witness kept requesting past maxRounds: forced finalization via existing `buildFinalizationPrompt(prompt, lastRequestText, allSnippets, witness.model)` + existing retry logic
- `runWitness` signature: add `maxContextRounds` to its limits param
- `ConsultOptions` (line 30): add `maxContextRounds?: number`
- Limits block (line 844): add `maxContextRounds: options.maxContextRounds ?? 3`
- `WitnessResult.safety`: adapt for multi-round (accumulate per-round safety, or use array)

**Step 7 — CLI args (`cli-main.ts`)**
- Add `--max-context-rounds <n>` (default 3)
- Raise existing defaults: `--max-context-snippets` 3→8, `--max-context-lines` 120→300, `--max-context-bytes` 8000→24000

**Step 9 — Tests**

Unit tests (`test/consult/context-request.test.ts`):
- `parseContextRequests` with `type: 'tree'` in JSON
- `fulfillContextRequests` tree request against a real temp directory
- `fulfillContextRequests` ENOENT for tree path
- `buildContinuationPrompt` output format (includes prior snippets, round countdown)
- `buildContextRequestPrompt` with round info
- `renderContextSnippets` tree heading format

Integration tests (`test/cli/consult.test.ts`) — mock `runAcaInvoke`:
- Multi-round: needs_context → continuation → needs_context → continuation → report
- Round cap: witness keeps requesting → forced finalization after maxRounds
- Backward compat: witness finalizes in round 1 (existing behavior unchanged)

---

### Implementation order for this session

1. Commit the step 1–3 work (already in working tree)
2. Implement steps 4+5 (prompt layer) → build + unit tests → commit
3. Implement steps 6+8 (loop refactor) → build + unit tests → commit
4. Implement step 7 (CLI flags) → build → commit
5. Write step 9 integration tests → confirm baseline still holds
6. **Run 5 live tests** (see below)

---

### Live Tests (run after all steps are committed and built)

Run each test with `HOME=$(mktemp -d -t aca-c11-7-XXXXXX) node dist/index.js consult ...`. Write artifacts to `/tmp/c11-7-test-N-*.json`.

**Test 1 — Baseline round 1 (warm-up)**
Question about a simple fact in the codebase. Witness should finalize in round 1 with no context requests. Confirms backward compat and that the new defaults don't break the happy path.

Suggested question: "What is the default value of `maxOutputTokens` in the ACA config schema, and where is it defined?"

**Test 2 — Tree request (path discovery)**
Question that requires knowing directory structure but no file content. Witness should emit a tree request for `src/consult/` or `src/providers/`, receive the listing, then finalize.

Suggested question: "List all TypeScript files in the consult pipeline and briefly describe what each one does."

**Test 3 — Tree → file (two-round)**
Question that requires discovering a path then reading a file. Witness should do tree round 1, file request round 2, finalize round 3 (or finalize after round 2 if the tree was enough).

Suggested question: "What prompt does ACA send to witnesses during the finalization pass, and what guardrails does it include?"

**Test 4 — Multi-file deep read (generous limits)**
Question requiring several files read in full. With old 120-line cap, witnesses would answer from truncated files. With new 300-line cap, they should get complete files.

Suggested question: "Review the full context-request protocol in context-request.ts — does the finalization prompt correctly prevent further tool calls? Cite specific lines."

**Test 5 — Full adversarial (hardest)**
A question that previously caused DeepSeek to hallucinate paths. Witness should use tree request to orient itself, then request the correct files, then produce a grounded answer. Confirm zero ENOENT in fulfilled snippets.

Suggested question: "In the NanoGPT driver, where exactly is tool emulation activated, and what happens to requests that have tools when the model is invoked with allowedTools: []? Trace the full call path."

For each test: read the result JSON, check `context_snippets`, `context_requests`, `triage.path`. Report whether witnesses used tree requests, how many rounds each took, and whether any fulfilled snippets had ENOENT errors.

---

### Key files to read before starting

- `/home/blake/.claude/plans/tender-dazzling-sundae.md` — full implementation plan
- `src/consult/context-request.ts` — the file with all step 1–3 changes (read before editing)
- `src/cli/consult.ts` — `runWitness()` lines 507–677, `ConsultOptions` lines 30–49, limits block lines 844–848
- `src/cli-main.ts` — CLI arg parsing lines 1470–1472

### Test baseline
- `npm run build` → clean
- `npm test` → 2617 passing, 14 pre-existing live-integration failures, 1 skipped
