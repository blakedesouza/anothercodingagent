# C1 Independent Verification Pass (Opus)

**Date:** 2026-04-09  
**Auditor:** Claude Opus 4.6 (independent of Codex)  
**Methodology:** Same 6-axis framework as `AUDIT_FRAMEWORK.md`, applied from scratch without trusting Codex's closure claims  
**Scope:** C1 "Bundled Consult Orchestration" — consult/witness pipeline, blast radius, wiring, tests, live NanoGPT re-proof  
**Output file:** `codex-fixing/C1_VERIFICATION_PASS_OPUS.md` (grows batch by batch)

---

## SYSTEMIC CONDITION (read before any finding)

**The entire project working tree since `4378038` (2026-04-07) is uncommitted.**

- `git diff --stat HEAD` reports: **111 files changed, 5934 insertions, 2283 deletions**
- `codex-fixing/` — entirely untracked (`??`)
- `src/cli-main.ts` — untracked (`??`)
- 18+ new source files untracked: `src/cli/rp-research.ts`, `src/cli/tool-names.ts`, `src/cli/invoke-runtime-state.ts`, `src/core/pre-turn-summarization.ts`, `src/delegation/agent-runtime.ts`, etc.
- All tracked source files under `src/` show as modified (`M`)

**Implication for audit:** Every Codex claim of "validation passed", "build clean", "tests pass", "fixes applied" is made against a HEAD + uncommitted working-directory state with no verifiable git history. No individual "C1 fix" is captured in an atomic commit. Claims cannot be verified by `git show <sha>` for the post-C1 period. The only verifiable history ends at `4378038 2026-04-07`.

This is not unique to C1 — it affects C2–C7 equally. It is **not** a code defect, but it means: (a) the audit trail is narrative documentation only, not git history; (b) accidental `git reset --hard` would erase months of work; (c) the diff between "what Codex said it fixed" and "what actually changed" cannot be isolated per-claim via commit.

**Recommendation:** Commit before any destructive operation. This finding should be surfaced to the user independently of C1 verdict.

---

## Batch A — Claim Trace via Git Log

**Status:** Complete  
**Goal:** Attach each of Codex's 3 C1 claims to a specific commit, files touched, and tests touched.

### C1 commit window (all 2026-04-07)

The 6 commits that constitute the C1 pass, in execution order:

| SHA | Time (CDT) | Subject |
|---|---|---|
| `94e222b` | 16:18 | fix(consult): harden no-tools witness prompts |
| `276473f` | 16:22 | fix(consult): ignore cited pseudo-tool examples |
| `b1e85f5` | 16:43 | feat(consult): add shared raw context pack |
| `5d9ce56` | 17:01 | fix(consult): retry no-tools finalization violations |
| `e6f1f58` | 17:27 | fix(consult): harden no-tools protocol accounting |
| `4378038` | 17:45 | fix(consult): replace minimax witness with deepseek |

Pre-window context: `6e19733` (01:50) introduced the entire consult pipeline from scratch (`src/cli/consult.ts` +382, `src/consult/context-request.ts` +210, `src/consult/evidence-pack.ts` +207). C1 fixes are hardening of code introduced the same day.

### Claim 1: "fixed missing `aca witnesses --json` compatibility"

**Mapped commit:** `4378038` — "fix(consult): replace minimax witness with deepseek"

**Files touched:** `src/config/witness-models.ts`, `src/cli/consult.ts`, `src/consult/context-request.ts`, `src/providers/models.json`  
**Tests touched:** `test/config/witness-models.test.ts` (+38 lines), `test/consult/context-request.test.ts` (+18 lines), `test/providers/model-registry.test.ts` (+9 lines)

**What actually changed:** `WITNESS_MODELS[0]` entry was `minimax/minimax-m2.7` → `deepseek/deepseek-v3.2`. Comment JSDoc updated to reflect deepseek. The `aca witnesses --json` command was already working (introduced in M11.5, 2276 tests). The "compatibility" fix was a data correctness issue: MiniMax is no longer a valid subscription model; `aca witnesses --json` was returning a MiniMax entry that would fail any real consult attempt.

**Verdict:** Claim is truthful but description is misleading. This is a **data correctness fix** (wrong witness in the canonical list), not a CLI compatibility fix. The `--json` flag itself needed no repair.

**Gate:** Commit exists ✓, files changed ✓, tests updated ✓. But test scope: `test/config/witness-models.test.ts` — does it assert the specific deepseek model string? TBD in Batch D.

---

### Claim 2: "synced `.claude` consult wrappers to the current shared-context/max-context CLI surface"

**Mapped commit:** None found in git history.

**Finding:** Neither `~/.claude/skills/consult/` nor `~/.codex/skills/consult/` are git repositories (`fatal: not a git repository`). There is no verifiable record of when these files were last modified or what was changed. The "sync" claim is undocumented.

**Independent wrapper audit (from Phase 1):**
- `run_consult.py` is byte-identical in both locations (md5 `7cdf67a29db127af1ef49d7ab6a49327`)
- Both wrappers do forward `--shared-context`, `--shared-context-model`, `--shared-context-max-*`, `--max-context-*` flags ✓
- `--aca-max-tool-calls` is parsed but NOT forwarded (deprecated — parity drift)
- No bare `--max-context` flag exists — only the `--max-context-{snippets,lines,bytes}` triplet. Codex's "max-context CLI surface" wording is loose but not wrong.
- **Asymmetry:** `.codex/skills/consult/` lacks `run_packed_consult.py`, `build_evidence_pack.py`, `consult_ring.py`, and tests that exist in `.claude/skills/consult/`. "Synced" implies parity; parity is not achieved.
- No changelog, no "synced" comment, no 2026 date in any Codex-side wrapper file.

**Verdict:** Claim is **partially verified**. The flags that matter (`--shared-context`, `--shared-context-model`) are present in both wrappers. But (a) no git proof the sync happened during C1, (b) Codex-side is still missing 3 scripts Claude-side has, (c) no test exercises the wrapper end-to-end. **Low-severity open item**, not a reopen trigger given the explicit "wrappers are thin adapters, not the safety boundary" policy established 2026-04-06.

---

### Claim 3: "hardened consult prompt/triage contracts so missing or unseen evidence stays an open question"

**Mapped commits:** `94e222b`, `276473f`, `b1e85f5`, `5d9ce56`, `e6f1f58`

**Files touched across these commits:**
- `src/consult/context-request.ts` — all 5 commits (this is the core claim file; **notably absent from Codex's scope list** — see Batch B)
- `src/cli/consult.ts` — `b1e85f5`, `5d9ce56`, `e6f1f58`
- `src/providers/tool-emulation.ts` — `e6f1f58` only (**not in Codex's scope list** — see Batch B)
- `src/index.ts` — `b1e85f5` (adds `--shared-context` CLI flags; see architecture note below)

**Architecture note — index.ts vs cli-main.ts:**  
At C1 time, the full Commander CLI lived in `src/index.ts`. The C1 commits modify `src/index.ts` for consult options. After C1 (in the uncommitted working tree), the CLI was refactored: `src/cli-main.ts` (currently **untracked**) now holds the full Commander wiring, and `src/index.ts` was reduced to a 106-line bootstrap that `await import('./cli-main.js')`. Codex's scope list names `src/cli-main.ts` — but at C1 time this file didn't exist in this form. The scope list mixes C1-era and post-C1 file names.

**Tests touched:** `test/consult/context-request.test.ts` in all 5 commits (+17, +11, +38, +17, +40 lines respectively = ~123 new test lines for this file across C1). `test/providers/tool-emulation.test.ts` in `e6f1f58` (+30 lines).

**Verdict:** Commits exist ✓, `context-request.ts` was the main target ✓, tests were updated ✓. The specific behavioral claim ("missing evidence stays an open question") is functional language — Batch D will verify whether the tests actually assert this behavior specifically.

**Blast radius gap:** `src/providers/tool-emulation.ts` was modified in `e6f1f58` (adds `stripJsonMarkdownFence()` + applies it to `parseEmulatedToolCalls`). This file is not in Codex's C1 scope list. Change is real, with 30 new test lines. Classified as a missed scope item, not a defect (change is a correctness improvement). See Batch B.

---

### Claim Trace Table

| Codex claim | Commit(s) | src files touched | test files touched | Commit proves it? |
|---|---|---|---|---|
| `aca witnesses --json` compatibility | `4378038` | `witness-models.ts`, `consult.ts`, `context-request.ts`, `models.json` | `witness-models.test.ts`, `context-request.test.ts`, `model-registry.test.ts` | Partial — data fix, not CLI fix |
| `.claude` wrapper sync | None in git | `~/.claude/skills/consult/run_consult.py` (unversioned) | None | No git proof; functionally present |
| Prompt/triage contract hardening | `94e222b`, `276473f`, `b1e85f5`, `5d9ce56`, `e6f1f58` | `context-request.ts`, `consult.ts`, `tool-emulation.ts`, `index.ts` | `context-request.test.ts`, `tool-emulation.test.ts` | Yes — commits exist, tests added |

**Batch A gate: No claim has ZERO commits** (Claim 2 has no git proof but is verifiable by inspection). No immediate reopen trigger from claim trace alone.

---

## Batch B — Blast Radius Verification

**Status:** Complete  
**Goal:** Prove Codex's scope list is complete. Unlisted consumers = finding.

### Codex's scope list vs independent map

| File | In Codex scope? | In independent map? | Role |
|---|---|---|---|
| `src/cli/consult.ts` | ✓ | ✓ | Pipeline orchestrator |
| `src/consult/evidence-pack.ts` | ✓ | ✓ | Evidence building |
| `src/config/witness-models.ts` | ✓ | ✓ | Witness configs |
| `src/providers/model-catalog.ts` | ✓ | ✓ | Model caps |
| `src/cli/executor.ts` | ✓ | Partial | Listed; not a core consult file |
| `src/cli/invoke-output-validation.ts` | ✓ | Partial | Listed; used in invoke path not consult |
| `src/cli-main.ts` | ✓ | ✓ (as refactored form of index.ts) | CLI entrypoint |
| `src/consult/context-request.ts` | **✗ MISSING** | ✓ | **Protocol core — all 5 hardening commits land here** |
| `src/providers/tool-emulation.ts` | **✗ MISSING** | Implicit | **Modified in `e6f1f58`; parseEmulatedToolCalls behavior change** |
| `src/index.ts` (C1-era CLI) | Indirect only | ✓ | CLI at C1 time; now refactored out |
| `src/mcp/server.ts` | ✗ | Indirect | Coupled via `runAcaInvoke` in consult.ts:21 |

### Blast radius gap finding

**GAP-1 (High):** `src/consult/context-request.ts` is absent from Codex's scope list but received the most code changes of any file across C1 (5 of 6 commits touched it). This is the file that implements `containsPseudoToolCall`, `buildContextRequestPrompt`, `buildFinalizationPrompt`, and the "needs_context → final" protocol that Codex's Claim 3 is actually about. Auditing "prompt/triage contract hardening" without listing this file in scope is auditing the wrong layer.

**GAP-2 (Medium):** `src/providers/tool-emulation.ts` was modified in commit `e6f1f58` (adds `stripJsonMarkdownFence`). Not in Codex's scope. The change is a correctness fix that affects how the consult pipeline interprets emulated tool calls. It has 30 new test lines but was lumped into the C1 pass without being listed as in-scope. This is the same file C7 later hardened further — C1's change was the initial fix in this area.

**GAP-3 (Structural — previously discovered, confirmed here):** `src/review/{aggregator,report,witness-finding,benchmark}.ts` — 4 files, ~1000 lines, **zero runtime callers**, tree-shaken out of `dist/` entirely. All 4 marked `[x]` complete in `docs/steps/07a5-milestone7-review-aggregation.md`. This is M7A.5's work: a full witness aggregation pipeline (Jaccard clustering, severity ranking, report generation) that should be the aggregation layer for the consult pipeline — but `src/cli/consult.ts` has its own triage logic that completely ignores this code. The C1 protocol/aggregation axis covers exactly this area. **Codex missed this on both the first blast-radius pass and the stricter C1 pass.**

### Dependency closure (consumer graph)

Key consumers found via import trace:
- `src/cli/consult.ts` → imports `runAcaInvoke` (from executor path) and `buildEvidencePack` (evidence-pack)
- `src/cli-main.ts` → sole production importer of `runConsult` (from consult.ts)
- `src/index.ts` → delegates to `cli-main.ts`; no direct consult imports
- `src/mcp/server.ts` → no direct consult import; indirectly coupled via child `aca invoke` subprocess

**Closure is tight.** No surprise consumers outside Codex's stated scope (aside from the two GAPs above which are files Codex listed but shouldn't have ignored, or missed entirely).

---

## Running Findings Log

| ID | Severity | Category | Description | Batch found |
|---|---|---|---|---|
| F-SYSTEMIC | High | Ops | Entire working tree uncommitted since 2026-04-07; 111 files modified, src/cli-main.ts untracked | A |
| F-SCOPE-1 | High | Blast radius | `src/consult/context-request.ts` absent from Codex C1 scope despite receiving most changes | B |
| F-SCOPE-2 | Medium | Blast radius | `src/providers/tool-emulation.ts` modified in C1 but not in scope list | B |
| F-ORPHAN | High | Dead code (axis 6) | `src/review/*` (4 files, ~1000 lines) fully orphaned — M7A.5 implementation, zero runtime callers, missed by both audit passes | B |
| F-CLAIM-2 | Low | Evidence gap | Wrapper "sync" claim has no git proof; functionally correct but unverifiable | A |
| F-DESCR-1 | Info | Clarity | Claim 1 described as "CLI compatibility" but was actually a data correctness fix (minimax→deepseek) | A |

---

*Batches C–H to follow. Next: Batch C (live wiring proof) + Batch D (test coverage).*
