Read `plan.md` and `docs/handoff-gauntlet.md` before doing anything else.

▎
▎ Project: Another Coding Agent (ACA) — TypeScript coding agent at
▎ /home/blake/projects/anothercodingagent. Built binary at dist/index.js.
▎ 2661 tests passing going in.
▎
▎ This session runs a 10-test gauntlet to validate that every major fix from
▎ the C9/C10/C11 hardening cycle is holding against real files and real models.
▎
▎ RULES:
▎  - Run all 10 tests sequentially. Do NOT parallelize.
▎  - Do NOT fix anything you find. Observe and document only.
▎  - If a test hangs >10 minutes, kill it, mark TIMEOUT, continue.
▎  - After all 10 complete, report results in a single table.
▎

First run:

  npm run build 2>&1 | tail -3
  SUFFIX=$(date +%s)

Then run each test in order. Full test specs are in docs/handoff-gauntlet.md.
The commands are:

  node dist/index.js consult --witnesses all \
    --question "Review the classifyWitnessFirstPass function — does the pseudo-tool-call detection correctly handle the retryable flag, and what edge cases could cause a false positive?" \
    --max-context-rounds 3 --out /tmp/gauntlet-01-result-$SUFFIX.json 2>/tmp/gauntlet-01-stderr-$SUFFIX.txt

  node dist/index.js consult --witnesses all \
    --question "In runWitness, how does the buildContinuationPrompt function determine roundsRemaining? Could the counter ever allow an extra round beyond maxContextRounds?" \
    --max-context-rounds 3 --out /tmp/gauntlet-02-result-$SUFFIX.json 2>/tmp/gauntlet-02-stderr-$SUFFIX.txt

  node dist/index.js consult --witnesses all \
    --question "What design principles should govern when an AI agent retries a tool call automatically versus escalating to the user? Consider latency, safety, and user trust tradeoffs." \
    --out /tmp/gauntlet-03-result-$SUFFIX.json 2>/tmp/gauntlet-03-stderr-$SUFFIX.txt

  node dist/index.js consult --witnesses all \
    --question "Does the needs_context protocol in src/consult/context-request.ts correctly prevent witnesses from submitting placeholder paths instead of real file paths? What guards exist?" \
    --max-context-rounds 3 --out /tmp/gauntlet-04-result-$SUFFIX.json 2>/tmp/gauntlet-04-stderr-$SUFFIX.txt

  node dist/index.js consult --witnesses deepseek \
    --question "What does the extractCodeIdentifiers function in src/consult/symbol-lookup.ts actually extract, and how does resolveSymbolLocations use that output to populate the symbol_locations block?" \
    --max-context-rounds 3 --skip-triage \
    --out /tmp/gauntlet-05-result-$SUFFIX.json 2>/tmp/gauntlet-05-stderr-$SUFFIX.txt

  node dist/index.js consult --witnesses all \
    --question "Does the ACA consult pipeline handle ENOENT results during context-request fulfillment? Does it fail silently, surface the error to the witness, or substitute empty content?" \
    --max-context-rounds 2 --out /tmp/gauntlet-06-result-$SUFFIX.json 2>/tmp/gauntlet-06-stderr-$SUFFIX.txt

  node dist/index.js consult --witnesses deepseek \
    --question "Review the full runConsult function in src/cli/consult.ts — what are the main phases, and are there any gaps in error handling between the witness aggregation phase and the triage phase?" \
    --max-context-rounds 3 --skip-triage \
    --out /tmp/gauntlet-07-result-$SUFFIX.json 2>/tmp/gauntlet-07-stderr-$SUFFIX.txt

  node dist/index.js consult --witnesses qwen \
    --question "In the ACA tool-emulation system, how does the tool-call detection distinguish between a legitimate tool invocation and a model that accidentally includes tool-call syntax in its prose output?" \
    --max-context-rounds 2 --skip-triage \
    --out /tmp/gauntlet-08-result-$SUFFIX.json 2>/tmp/gauntlet-08-stderr-$SUFFIX.txt

  node dist/index.js consult --witnesses qwen \
    --question "Review the stripBlockquoteMarkers function in src/consult/context-request.ts — what patterns does it handle and what edge cases might it miss?" \
    --max-context-rounds 2 --skip-triage \
    --out /tmp/gauntlet-09-result-$SUFFIX.json 2>/tmp/gauntlet-09-stderr-$SUFFIX.txt

  node dist/index.js consult --witnesses all \
    --question "Review the error handling in runWitness in src/cli/consult.ts — are the retryable versus unrecoverable failure paths correctly distinguished? Are there any cases where a witness failure could be swallowed silently?" \
    --max-context-rounds 3 --out /tmp/gauntlet-10-result-$SUFFIX.json 2>/tmp/gauntlet-10-stderr-$SUFFIX.txt

After each test completes, immediately extract and print the key fields:

  jq '{success_count,degraded,triage:.triage.status,
       witnesses:(.witnesses|to_entries[]|{key,status:.value.status,error:.value.error})}' \
    /tmp/gauntlet-NN-result-$SUFFIX.json

For test 05 also run: ls /tmp/aca-consult-deepseek-round-*-*.md 2>/dev/null

At the end, compile everything into one results table matching the template in
docs/handoff-gauntlet.md. Each row: test number, what it tests, Pass/Fail, notable observations.
Do not fix anything. Flag failures for the next session.
