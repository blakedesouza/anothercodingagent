Read plan.md and docs/handoff-c11.6.md before doing anything else.

  ▎
  ▎ Project: Another Coding Agent (ACA) — a TypeScript coding agent built at
  ▎ <repo>. Built binary at dist/index.js.
  ▎ Tests: npx vitest run. Build: npm run build. 2641 tests passing going in.
  ▎
  ▎ C11 is system-prompt edge-case hardening. C11.1–C11.5 + symbol-lookup are COMPLETE.
  ▎ C11.6 is next. It has two parts — do Part A first, then Part B.
  ▎
  ▎ PART A — Qwen blockquote stripping (small, do first):
  ▎
  ▎ Problem: qwen/qwen3.5-397b-a17b wraps its entire output in > blockquote lines via
  ▎ delta.content (confirmed with NANOGPT_DEBUG: stream starts "Thinking...\n> The").
  ▎ The needs_context JSON qwen intends to emit is buried inside the blockquotes.
  ▎ classifyWitnessFirstPass never finds bare JSON, treats the whole response as an
  ▎ empty final report, and the witness contributes nothing. The model hint in the
  ▎ system message says "don't wrap in blockquotes" — qwen acknowledges it in its
  ▎ own reasoning and then ignores it.
  ▎
  ▎ Fix: export stripBlockquoteMarkers(text: string): string from
  ▎ src/consult/context-request.ts. Implementation: split on \n, strip /^> ?/ from
  ▎ each line, rejoin. In src/cli/consult.ts runWitness(), pass
  ▎ stripBlockquoteMarkers(roundText) to classifyWitnessFirstPass at the two call
  ▎ sites (~lines 593 and 605). Keep roundText (not stripped) for disk artifacts,
  ▎ retry prompts, and lastEffectiveResponseText.
  ▎
  ▎ PART B — Tool emulation prompt hardening:
  ▎
  ▎ buildToolSchemaPrompt in src/providers/tool-emulation.ts:24 needs a concrete
  ▎ worked example. Add after the existing bullet list: a CORRECT example (bare JSON
  ▎ only), a WRONG example (prose before JSON), and a WRONG example (JSON in a
  ▎ markdown fence). MiniMax (S1 P3 from C11.1 failure catalog) interleaves prose
  ▎ with the emulation JSON — the example targets that pattern.
  ▎
  ▎ TESTS (pre-written — drop in first, implement until they pass):
  ▎ File: test/consult/blockquote-strip.test.ts (create this file)
  ▎ Full test code is in docs/handoff-c11.6.md.
  ▎ Four tests total (3 unit + 1 live).
  ▎
  ▎ LIVE TEST A (after Part A):
  ▎ SUFFIX=$(date +%s) && HOME=$(mktemp -d -t aca-c116-qwen-XXXXXX) \
  ▎   node dist/index.js consult \
  ▎   --question "What does formatOtlpPayload do, what does it return, and what file defines it?" \
  ▎   --project-dir <repo> \
  ▎   --max-context-rounds 3 \
  ▎   2>&1 | tee /tmp/aca-c116-qwen-${SUFFIX}.txt
  ▎ Pass: qwen context_requests is non-empty (previously was [] due to blockquote swallow).
  ▎
  ▎ Read docs/handoff-c11.6.md for the full checklist, exact line numbers, and
  ▎ Part B live test details.
