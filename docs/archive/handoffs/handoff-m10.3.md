# M10.3 Handoff — Self-Building: ACA Builds ACA

**Date:** 2026-04-06
**Status:** M10.2 complete, witness/consult tool-access uplift complete. Ready for M10.3.

## What's Done Since M10.1c

### M10.2 — First Real Delegated Coding Task (complete)

| Deliverable | Status | Notes |
|---|---|---|
| Claude designs a small feature | Done | `/model` slash command — chosen because `/version` already existed |
| Delegation via `aca_run` MCP tool | Done | Model: `moonshotai/kimi-k2.5`, same model that failed attempt #2 |
| ACA coder agent reads → edits → verifies | Done | parallel read batch → `edit_file ×2` → vitest → tsc → summary |
| Claude reviews the result | Done | git-independent diff inspection + re-ran vitest + tsc myself |
| Iterate if needed | N/A | first attempt produced a clean, surgical diff |
| Feature works, tests pass, code is clean | Done | 3/3 commands tests, 2318/2319 total |
| **Total** | **M10.2 complete** | **2318 passing, 1 skipped** |

**Key pipeline validation:** the new 11-section `buildInvokeSystemMessages` prompt rewrite unblocked the exact scenario that failed twice before with thin prompt. Same model, same task envelope, same config pin — different outcome.

**Notable pattern observed:** kimi still produced the anti-pattern text *"Now I have all the context I need. Let me make the edits..."* from the stall cases, but then **called tools**. The stall signal is the absence of a following tool call, not the phrase itself. See changelog entry for 2026-04-06 M10.2 for the full analysis. Logged as "watch across more runs" — not a rewrite trigger.

### Witness/Consult Tool-Access Uplift (complete, prerequisite for M10.3)

Expanded both the in-process witness profile and the consult-mode witness invocation path from their respective minimal tool sets to an 11-tool peer-review set:

| Surface | Before | After |
|---|---|---|
| `agent-registry.ts` `WITNESS_TOOLS` | 10 non-mutating tools | 10 + `exec_command` |
| `agent-registry.ts` `REVIEWER_TOOLS` | 10 non-mutating tools | 10 + `exec_command` |
| `consult_ring.py` `ACA_WITNESS_TOOLS` | 4 tools (read, search, find, lsp) | 11 tools matching witness profile |

**Rationale:** witnesses need to *run* verification commands (`npm test`, `tsc --noEmit`, `grep`, `wc`, `git blame`) to ground findings in evidence instead of imagining how code behaves. Still excludes write/edit/delete — review integrity requires witnesses to observe rather than mutate what they review.

**Not full peer:** `coder` still gets write/edit/delete via `resolveCoderTools`. The witness/reviewer stop-short-of-mutation boundary is intentional. If M10.3 reveals a case where a witness legitimately needs to mutate (e.g. running a migration to reproduce a claim), revisit then.

## What to Do Next (M10.3)

From `docs/steps/10-milestone10-payoff.md`:

- [ ] Attempt a full `/build` substep using ACA delegation:
  - Claude reads the substep requirements
  - Claude delegates code writing to ACA coder agent
  - Claude delegates testing to ACA test-runner agent (or coder with exec_command — existing profile already has this)
  - Claude delegates review to ACA witness agents (with the newly expanded tool access)
  - Claude applies fixes based on review findings
  - Claude runs the gate (human confirmation)
- [ ] Measure: context usage, time, quality compared to the old Claude-does-everything approach
- [ ] Document: what worked, what didn't, what needs tuning in agent profiles/prompts
- [ ] Update `goal.md` and `goal2.md` with actual results

**Tests (qualitative):**
- A real substep completes end-to-end with delegation
- Code quality is comparable to Claude-written code (reviews catch issues)
- Opus context usage is measurably lower than the baseline (Claude doing it all)
- Wall-clock time is comparable or faster (parallel agents)

## Candidate Substep for the First Self-Build

M10.3 needs a target substep that:
1. Is narrow enough that delegation failure modes are debuggable
2. Is big enough that the delegation actually saves context vs. doing it inline
3. Exercises multiple agent roles (coder, witness)
4. Has clear acceptance criteria (tests, lint)

**Not recommended:**
- Post-milestone reviews (M12+ substeps would be needed — we've done M1-M11 reviews already)
- Wiring/integration substeps (cross-cutting, hard to scope for delegation)
- Spec work (non-code, delegation doesn't help)

**Candidate pool:**
- A small follow-up enhancement to the `/model` command — print model capabilities (max context, max output, tool-calling native/emulated) from the ModelCatalog. Exercises coder + witness, narrow scope, clear verification.
- A small test-coverage addition to an under-tested area (e.g. error-path tests for one of the tools).
- A rename/refactor with clear before/after (e.g. unify two similar helpers in `src/core/`).

Claude should pick one and construct a task envelope at M10.3 kick-off. The first self-build is the learning pass; the second is where self-building starts paying rent.

## Dependencies

- **M10.2** (done): delegation pipeline verified with real kimi-k2.5 task
- **Witness/consult uplift** (done): witnesses can now run tests + linters + grep to verify claims
- **M10.1** (done): witness profile exists, `consult_ring.py --mode aca` path works
- **M9.2/M9.2b** (done): `aca_run` MCP tool reliable
- **M11.7** (done): peer agent profiles — coder has full tool set

## File Locations

- **Delegate skill**: `~/.claude/skills/delegate/SKILL.md`
- **Consult skill + ring**: `~/.claude/skills/consult/` (SKILL.md + consult_ring.py)
- **MCP server**: `src/mcp/server.ts`
- **Invoke handler**: `src/index.ts` (around line 894+)
- **Agent registry**: `src/delegation/agent-registry.ts`
- **TurnEngine**: `src/core/turn-engine.ts`
- **Invoke prompt**: `src/core/prompt-assembly.ts:buildInvokeSystemMessages` (the 11-section rewrite)

## Known Caveats

- **Model pin still at kimi-k2.5**: `.aca/config.json` left pinned for continued pipeline validation. Flip to default (`qwen/qwen3-coder-next`) whenever M10.3 needs a different model profile.
- **Kimi usage test skipped**: `test/cli/first-run.test.ts` has one `it.skip` for the invoke usage-reporting test. Kimi's SSE stream doesn't emit per-message token counts for trivial prompts; qwen does. Unrelated to M10.2; re-enable when NanoGPT driver gains per-model usage handling or the default model flips.
- **Narration-before-action pattern**: kimi produces the exact stall text from prior failures but follows it with tool calls. Not a bug today, but watch across the first few M10.3 runs — if it ever *doesn't* call tools after the narration, we need a harder prompt constraint.
- **Witness write access deliberately withheld**: if a witness needs to mutate workspace state to verify a claim, the current profile will block it. Revisit if M10.3 surfaces a legitimate case.

## Quick Start for M10.3

1. Pick a candidate substep from the pool above (or propose your own narrow, verifiable unit of work).
2. Construct the task envelope for the coder — match the M10.2 style: explicit paths, constraints, verification commands.
3. Invoke via `aca_run` with `allowed_tools` scoped to what the coder actually needs.
4. On success: delegate review to witnesses via `/consult --mode aca`. The witnesses now have `exec_command` + semantic search + LSP + web research, so they can actually run tests and verify claims against real docs.
5. Apply fixes from witness findings (use rebuttal loop for non-consensus — see the `rebuttal_mandatory` feedback memory).
6. Gate for human confirmation.
7. Measure vs baseline: was the total Opus context used less than Claude-doing-it-all would have been? What was the quality delta?
