# Handoff: Apply Test Audit Fixes to Step Files

## What Happened

A test coverage audit was run across all 11 step files and 22 spec files. ~547 tests exist, ~87% are concrete. The remaining ~13% (~72 items) have issues: contradictions, vague assertions, untested sub-features, or spec-only criteria without step-level tests.

Three external AI models (MiniMax M2.7, Kimi K2.5, DeepSeek V3.2 Thinking) independently reviewed all 72 issues and reached consensus on resolutions. Their full responses are saved at:
- `/tmp/consult-minimax-response-1774834439922128761.md` (18KB)
- `/tmp/consult-kimi-response-1774834439922128761.md` (13KB)
- `/tmp/consult-deepseek-response-1774834960145245763.md` (10KB)

The compiled issue list is at `/tmp/test-audit-issues.md`.

## What Needs to Be Done

Apply ~38 changes across the step files in `docs/steps/`. Work in small batches (1-2 step files at a time).

### 1. Fix 6 Contradictions

| # | File | Fix |
|---|------|-----|
| C1 | `02-milestone2-tools-perms.md` | Add `confirm_always` escalation level for delete/move. `--no-confirm` cannot override it. Update the approval resolution algorithm description. |
| C2 | `01-milestone1-agent-loop.md` | Remove "interactive is only mode" assertion. Keep minimal one-shot detection test: print "not yet supported" + exit 0. |
| C3 | `07a-milestone7-error-health.md` | Clarify malformed response: "2 attempts, immediate retry, backoff: None". No spec change needed, just wording. |
| C4 | `07a-milestone7-error-health.md` | Add 3 tests: failure 1 → synthetic error + continue, failure 2 → same, success between resets counter. Existing failure-3 test stays. |
| C5 | `07c-milestone7-capabilities.md` | Add 9 parameterized localhost tests (3 tools × 3 addresses) + 1 test that shell commands with localhost are NOT exempted. |
| C6 | `07b-milestone7-delegation.md` | Clarify: depth 2 is valid (grandchild works), depth 3 spawn fails. Update test to assert depth=2 agent is active, depth=3 returns `limit_exceeded`. |

### 2. Add Concrete Assertions to 20 Vague Tests

| # | File | What to Add |
|---|------|-------------|
| V1 | `01-milestone1-agent-loop.md` | Assert MessageItem/ToolCallPart/AcaError shapes with specific required fields |
| V2 | `01-milestone1-agent-loop.md` | Assert 3 attempts with 250ms/500ms timing via fake timers |
| V3 | `01-milestone1-agent-loop.md` | Assert null-byte detection and extension-based binary detection |
| V4 | `01-milestone1-agent-loop.md` | Add whichever-first truncation test (byte-first and line-first scenarios) |
| V5 | `02-milestone2-tools-perms.md` | Define variable expansion detection: `$VAR`, `${VAR}`, `$(cmd)` patterns |
| V6 | `02-milestone2-tools-perms.md` | Add 5 individual shell network detection tests (curl, wget, ssh, git clone, npm install) |
| V7 | `02-milestone2-tools-perms.md` | Add tests for all 6 secret patterns: sk-, ghp_, glpat-, AKIA, Bearer, PEM |
| V8 | `03-milestone3-context-state.md` | Define digest format: `[turn:index] tool(args_hash) → status` |
| V9 | `03-milestone3-context-state.md` | Define durable state update shape for errors and approvals |
| V10 | `03-milestone3-context-state.md` | Clarify: decay = 8 turns since last reference (not since creation) |
| V11 | `04-milestone4-rendering.md` | Assert ANSI codes for all 6 tool categories (blue/yellow/magenta/cyan/green/red) |
| V12 | `04-milestone4-rendering.md` | Add Python/Rust/Go highlighting tests + unknown-extension fallback |
| V13 | `04-milestone4-rendering.md` | Assert braille frames sequence and 80ms interval |
| V14 | `04-milestone4-rendering.md` | Assert header/rule/link/table markdown rendering |
| V15 | `05-milestone5-provider-obs.md` | Defer embed() — all 3 witnesses agreed |
| V16 | `05-milestone5-provider-obs.md` | Assert batch semantics + 1s debounce timing |
| V17 | `05-milestone5-provider-obs.md` | Define output format for each stats subcommand |
| V18 | `06-milestone6-indexing.md` | Add .gitignore parsing tests (directory match, extension, negation) |
| V19 | `06-milestone6-indexing.md` | Add symbol extraction for TS, Python, Go, Rust, Java + fallback |
| V20 | `06-milestone6-indexing.md` | Assert all 6 result fields: path, startLine, endLine, score, snippet, symbols |

### 3. Add 9 Missing Test Groups (3 Deferred)

| # | File | Action |
|---|------|--------|
| U1 | `01-milestone1-agent-loop.md` | ADD: /quit, /status, --model, --verbose, Ctrl+D, double-SIGINT tests |
| U2 | `07b-milestone7-delegation.md` | ADD: agt_<ulid> format, parentAgentId, rootAgentId, depth, spawnIndex, label |
| U3 | `07b-milestone7-delegation.md` | ADD: message_agent with invalid ID → error, closed child → error |
| U4 | `07b-milestone7-delegation.md` | ADD: ask_user question text reaches parent, parent answer routes back |
| U5 | `07b-milestone7-delegation.md` | DEFER: authority shape undefined in spec |
| U6 | `07b-milestone7-delegation.md` | DEFER: grant matching semantics undefined in spec |
| U7 | `07c-milestone7-capabilities.md` | ADD: press, snapshot, evaluate, extract, wait browser tools |
| U8 | `07c-milestone7-capabilities.md` | DEFER: LSP completions/diagnostics/symbols to M7c |
| U9 | `07c-milestone7-capabilities.md` | DEFER: divergence detection algorithm to M7c |
| U10 | `07a-milestone7-error-health.md` | ADD: individual error code construction tests |
| U11 | `07a-milestone7-error-health.md` | DEFER: cooldown/breaker params undefined in spec |
| U12 | `07c-milestone7-capabilities.md` | ADD: ssh, scp, rsync, docker, pip, cargo detection |

### 4. Add 6 Spec-Only Test Suites

| # | What | Milestone File |
|---|------|---------------|
| S1 | 22 error codes with retry policies | `07a-milestone7-error-health.md` |
| S2 | Health state transitions (5s base cooldown, exponential to 60s) | `07a-milestone7-error-health.md` |
| S3 | EMA token calibration convergence | `03-milestone3-context-state.md` |
| S4 | Config trust boundary (5 precedence levels) | `02-milestone2-tools-perms.md` |
| S5 | Performance targets (index <30s/10K LOC, query <100ms) | `06-milestone6-indexing.md` |
| S6 | Confusion limits (3/turn, 10/session) | `07a-milestone7-error-health.md` |

## Consultation Consensus

All 3 witnesses agreed on C2-C6, V1-V20, and S1-S6. The only divergence was C1 naming (all agreed on the mechanism — a new level `--no-confirm` can't bypass — just different names). Use `confirm_always`.

## Also Done This Session

- **Consult script updated** (`~/.claude/skills/consult/consult_ring.py`): Codex/OpenAI removed, replaced with MiniMax M2.7. DeepSeek upgraded to thinking variant. All witnesses now NanoGPT ($8 sub). Max tokens bumped to 32K. Dead `call_codex` code removed.
- **Memory updated**: `feedback_consult_default_all.md` reflects new witness ring.

## Rules

- Read the step file before editing
- Small batches (1-2 files per session)
- Don't change spec files (`docs/spec/`) — only step files (`docs/steps/`)
- Update `docs/changelog.md` after completing each batch
- Check `plan.md` for current state before starting
