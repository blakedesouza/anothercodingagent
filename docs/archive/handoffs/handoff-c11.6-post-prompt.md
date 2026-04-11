# Handoff Prompt: C11.6 Post — Obfuscation Live Validation

Read plan.md and docs/handoff-c11.6-post.md before doing anything else.

▎
▎ Project: Another Coding Agent (ACA) — TypeScript coding agent at
▎ /home/blake/projects/anothercodingagent. Built binary at dist/index.js.
▎ Tests: npx vitest run. Build: npm run build. 2655 tests passing going in.
▎
▎ This session's only job is live-validating the identifier obfuscation feature
▎ that was implemented last session but not yet tested against a real model.
▎
▎ BACKGROUND:
▎ Empirical testing showed qwen/qwen3.5-397b-a17b fires a pseudo-tool-call error
▎ when camelCase identifiers containing loaded terms appear in the question text
▎ (e.g. "wrapStreamWithToolEmulation", "execCommand", "spawnAgent"). The model
▎ sees the compound name, associates it with tool-call JSON format, and emits
▎ {"tool_calls":[...]} in a no-tools context-request pass.
▎
▎ Fix implemented: src/consult/identifier-obfuscation.ts — preprocessing step
▎ in runConsult() that detects camelCase/PascalCase/multi-part snake_case tokens
▎ and replaces them with neutral labels (A, B, C...) with a legend prepended to
▎ the question. Symbol-lookup still runs on the legend text (which contains real
▎ names) so <symbol_locations> is unaffected. Evidence packs are NOT obfuscated.
▎
▎ THREE LIVE TESTS — run in order, one at a time:
▎
▎ TEST A (most important — the original failing case):
▎ SUFFIX=$(date +%s) && HOME=$(mktemp -d -t aca-obfusc-verify-XXXXXX) \
▎   node dist/index.js consult \
▎   --question "What does wrapStreamWithToolEmulation do, what streaming events does it emit, and what file defines it?" \
▎   --project-dir /home/blake/projects/anothercodingagent \
▎   --max-context-rounds 1 \
▎   2>&1 | python3 -c "
▎ import sys, json
▎ data = json.load(sys.stdin)
▎ q = data['witnesses']['qwen']
▎ print('qwen status:', q['status'])
▎ print('qwen retried:', 'context_request_retry' in q.get('safety', {}))
▎ print('qwen context_requests:', len(q.get('context_requests', [])))
▎ print('success_count:', data['success_count'])
▎ "
▎ Pass: qwen status ok, context_requests > 0, no retry needed.
▎
▎ TEST B (execCommand — confirmed trigger pre-fix):
▎ Same pattern, question: "What does execCommand do in this codebase and where
▎ is it defined?"
▎ Pass: qwen status ok, context_requests > 0.
▎
▎ TEST C (regression — neutral question should be unaffected):
▎ Question: "What does formatOtlpPayload do, what does it return, and what file
▎ defines it?" with --max-context-rounds 3
▎ Pass: success_count 4, all witnesses non-empty context_requests.
▎
▎ After all three pass: update plan.md (mark obfuscation live-validated),
▎ append changelog entry, done.
▎
▎ Full checklist and exact test commands in docs/handoff-c11.6-post.md.
