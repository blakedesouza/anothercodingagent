# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Milestone 3: Context + State

Goal: Project awareness, system prompt assembly, token estimation, context compression, summarization, durable task state, session resume.

### M3.0a — Project Awareness (Block 12)

Moved here from M6 because context assembly (M3.2) needs the project snapshot.

- [x] Root detection: walk up from cwd, find `.git/` or language-specific root files (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`)
- [x] Language/toolchain detection: root markers + lockfiles → stack summary
- [x] Git state: branch, dirty/clean, staged changes
- [x] `ProjectSnapshot` type: root, stack, git, ignorePaths, indexStatus
- [x] Context injection: ~5-8 line compact text block for LLM
- [x] Ignore rules: `.gitignore` + hardcoded (`.git/`, `node_modules/`, `dist/`, `build/`, `coverage/`)

**Tests:**
- Directory with `.git/` → root detected correctly
- Directory with `package.json` but no `.git/` → root at package.json
- Stack detection: `pnpm-lock.yaml` present → "pnpm" in stack
- Git state: dirty repo → `dirty` in snapshot. Clean → `clean`
- Ignore rules: `node_modules/` always ignored by find/search defaults
- Context rendering: snapshot → compact text < 200 tokens

### M3.0b — System Prompt Assembly (Block 13)

Moved here from M7 because every LLM call depends on proper prompt structure. Replaces M1.7's minimal AssembleContext.

- [x] 4-layer structure:
  1. System parameter: identity, rules, tool-use policy (~500-800 tokens)
  2. Tool definitions: all enabled tools via provider mechanism
  3. Per-turn context block: OS, shell, cwd, project snapshot, working set, capability health
  4. Conversation history: recent verbatim + older summarized
- [x] Instruction precedence: core rules > repo/user instructions > user request > durable state > prior conversation
- [x] Capability health injection: degraded/unavailable states as context lines
- [x] All enabled tools every turn (prompt caching makes repetition cheap)

**Tests:**
- Assemble with no conversation → system + tools + context block present
- Assemble with 5 turns → all included (under budget)
- Instruction precedence: verify ordering in assembled prompt
- Capability health: LSP=degraded → health line present in context block
- Tool definitions: all registered tools present in assembled request
- Per-turn context: project snapshot, working set, durable task state → all present

### M3.1 — Token Estimation + `estimate_tokens` Tool (Block 7, Block 2)

- [x] Byte-based heuristic: `ceil(utf8ByteLength / 3)` per text block
- [x] Structural overheads: +12 per message, +24 per tool call/result, +40 per tool schema
- [x] Per-model `bytesPerToken` from model registry (default 3.0)
- [x] Per-model calibration EMA: ratio `actual / estimated`, starts at 1.0, updated after each LLM call. Converges within 3-5 calls. Stored in manifest.json (does not need cross-session persistence)
- [x] Safe input budget: `safeInputBudget = contextLimit - reservedOutputTokens - estimationGuard` where `estimationGuard = max(512, ceil(contextLimit * 0.08))`. Default `reservedOutputTokens` = 4096
- [x] `estimate_tokens` tool: input (text or file paths, model) → token count, fits-in-context flag. Approval class: read-only

**Tests:**
- Empty string → 0 tokens
- ASCII string "hello" (5 bytes) → ceil(5/3) = 2 tokens
- Unicode string with multi-byte chars → correct byte count / 3
- Message with 3 tool calls → base tokens + 3*24 overhead
- 10 tool schemas → base + 10*40 overhead
- EMA calibration convergence suite:
  - Initial state: multiplier = 1.0 (no calibration data)
  - Single update: actual=100, estimated=120 → multiplier moves toward 0.833 but not all the way (EMA smoothing)
  - Convergence: 5 consecutive calls with actual/estimated ratio = 0.833 → multiplier within 5% of 0.833
  - Ratio shift: after converging at 0.833, feed 5 calls with ratio 1.2 → multiplier re-converges within 5% of 1.2 (demonstrates re-convergence, not stuck at old value)
  - No provider token count: 5 calls with no `input_tokens` in response → multiplier stays at 1.0 (no update when ground truth unavailable)
  - Mixed availability: 3 calls with provider counts then 2 without → multiplier reflects only the 3 calls with data, does not regress toward 1.0
- Safe budget: 200K context, 4096 output → guard = max(512, ceil(200000*0.08)) = 16000 → budget = 200000 - 4096 - 16000 = 179904
- Safe budget: 32K context → guard = max(512, ceil(32000*0.08)) = 2560 → budget = 32000 - 4096 - 2560 = 25344
- Per-model bytesPerToken override (e.g., 4.0 for a model) → different token estimate
- `estimate_tokens` tool: text input → returns count and fits-in-context flag
- `estimate_tokens` tool: file paths → reads files, sums tokens

### M3.2 — Context Assembly Algorithm (Block 7)

- [x] 7-step algorithm:
  1. Compute safe input budget
  2. Build pinned sections. Two tiers of pinning:
     - **Always pinned (all tiers including emergency):** core system rules, tool signatures, current user message, active errors, current-turn tool-call/tool-result chain
     - **Pinned except emergency:** resolved instruction summary, durable task state (~80-150 tokens)
     - Pinned sections are never compressed — but in emergency tier, if the current-turn chain alone exceeds budget, older tool results *within the current turn* are downgraded to digest form (see single-item guard below)
  3. Estimate full uncompressed request
  4. Determine compression tier from ratio
  5. Apply tier actions
  6. Pack newest-first by turn boundary
  7. Verify fit → escalate if needed
- [x] Tier detection (exclusive lower bound, inclusive upper bound): < 60% = full, ≥ 60% and < 80% = medium, ≥ 80% and < 90% = aggressive, ≥ 90% = emergency
- [x] Turn-boundary packing: include whole turns or none (except current turn always included)
- [x] Single-item budget guard: any item > 25% of remaining budget → downgrade to truncated/digest

**Tests:**
- Small conversation (< 60% budget) → tier=full, all items included verbatim
- Conversation at 70% → tier=medium, oldest turns summarized/dropped
- Conversation at 85% → tier=aggressive
- Conversation at 95% → tier=emergency, only always-pinned sections (core rules, tool sigs, current message, errors, current-turn chain)
- Turn boundary: 3 turns, budget fits 2.5 → include 2 full turns, not partial third
- Pinned sections (instruction summary, durable task state) present in full/medium/aggressive but dropped in emergency
- Always-pinned sections (core rules, tool sigs, current message, errors, current-turn chain) present at ALL tiers including emergency
- Boundary test: exactly 60% → tier=medium (not full). Exactly 80% → aggressive. Exactly 90% → emergency
- Current turn always fully included; in emergency, oversized tool results within current turn downgraded to digest
- Single large tool result (>25% budget) → downgraded to digest. Per-tool digest format tests (50-150 tokens each, computed deterministically):
  - `read_file` digest: contains file path, line range, total lines, `[content omitted — use read_file to re-read]`
  - `exec_command` digest: contains command, exit code, stderr headline (first error line), bytes omitted count
  - `search_text` digest: contains query, match count, top 3 match paths
  - `find_paths` digest: contains pattern, match count, top 3 match paths
  - `lsp_query` digest: contains operation, target, result count, first result summary
  - Unknown/other tool digest: contains tool name, status, data size, `[result omitted]`
- Escalation: assembled result still too large → bump tier and retry

### M3.3 — Compression Tier Actions (Block 7)

- [x] Tier `full`: all verbatim, full context block, full tool descriptions, full instructions
- [x] Tier `medium`: summarize oldest prefix, trim project snapshot (root + stack + git only), keep recent 4-6 turns verbatim
- [x] Tier `aggressive`: summarize all but last 2-3 turns, minimal context block (cwd + stack + git), short-form tool descriptions (name + one-liner + param names only)
- [x] Tier `emergency`: drop all history except current turn chain, no project detail, signatures only, core rules only. Instruction summary and durable task state dropped (only always-pinned sections survive). If current-turn chain alone exceeds budget, older tool results within it downgraded to digest

**Tests:**
- Tier full → all components present, tool descriptions have full detail
- Tier medium → project snapshot reduced (verify specific fields removed)
- Tier aggressive → tool descriptions are short-form (no parameter descriptions, no examples)
- Tier emergency → stderr warning emitted, only always-pinned sections remain (no instruction summary, no durable task state, no project detail)
- Cumulative: aggressive includes medium's conversation compression + adds its own (medium keeps 4-6 turns verbatim, aggressive keeps only 2-3)

### M3.4 — Summarization (Block 7)

- [x] LLM-based summarization of oldest completed-turn prefix
- [x] Structured prompt: request JSON output with `summaryText`, `pinnedFacts`, `durableStatePatch`
- [x] Chunk-based: up to 12 turns or 20K tokens per chunk
- [x] 40% cost ceiling: if summarization would cost > 40% of tokens saved → use deterministic fallback
- [x] Deterministic fallback: first/last items of range, tool call digest, discard filler
- [x] `SummaryItem` creation: new sequence number, `coversSeq` range, appended to log
- [x] Coverage map: `Map<itemSeq, summarySeq>` for visibility tracking
- [x] `visibleHistory()`: returns items skipping covered originals, including summaries

**Tests:**
- Summarize 5 turns → SummaryItem created with correct coversSeq range
- visibleHistory() after summarization → original items hidden, summary visible in their place
- 40% cost check: 5 turns totaling 100 tokens → summarization must cost < 40 tokens
- Cost ceiling exceeded → deterministic fallback used (no LLM call)
- Deterministic fallback: preserves first item, last item, tool call digests
- Nested summaries: re-summarize existing summary → newer summary covers older summary's range
- visibleHistory() with nested summaries → only newest summary visible for covered range
- Coverage map rebuild from JSONL on session load

### M3.5 — Durable Task State (Block 7)

- [x] Structured object in `manifest.json`: goal, constraints, confirmedFacts, decisions, openLoops, blockers, filesOfInterest, revision, stale
- [x] Deterministic updates from runtime facts (files modified, errors, approvals) at turn end
- [x] Optional LLM patch call: receives current state + turn items → returns JSON patch
- [x] LLM patch failure → deterministic updates still apply, `stale: true`
- [x] LLM-visible rendering: compact (~80-150 tokens) in pinned sections

**Tests:**
- Initial state: all fields empty/null
- After turn with write_file → filesOfInterest updated
- After turn with tool error (e.g., exec_command exit code 1) → deterministic update adds openLoop `{ status: "open", text: "<tool> failed: <error summary>" }` and error file (if identifiable) added to filesOfInterest
- After turn with pending approval (user denied a tool call) → deterministic update adds openLoop `{ status: "blocked", text: "approval denied for <tool>(<args summary>)" }` and adds to blockers
- After turn with user message mentioning file paths → filesOfInterest updated (deterministic, no LLM needed)
- After turn with user message "use vitest" → constraints updated (via LLM patch)
- LLM patch call failure → stale=true, deterministic updates still present (files, errors, approvals all applied)
- Rendering: state with goal + 2 open loops + 3 facts → output is < 200 tokens
- Revision increments on each update

### M3.6 — FileActivityIndex (Block 7)

- [x] In-memory map: file path → activity score
- [x] Scoring weights: edit_file/write_file=+30, delete_path/move_path=+35, read_file=+10, search_text match=+5, user mention=+25
- [x] Decay: -5 per inactive turn (inactive = no tool call or user mention referencing the file). Counter `turnsSinceLastTouch` resets to 0 on any reference
- [x] Drop from working set after 8 consecutive inactive turns since last touch (not since creation)
- [x] Persist in manifest.json, rebuild from conversation log on resume
- [x] Per-turn context: top 5 files by score (path + role)

**Tests:**
- edit_file on `a.ts` → score = 30
- read_file on `a.ts` then edit_file → score = 40
- 8 consecutive turns of inactivity on `a.ts` (no tool call or user mention) → score drops by 40 (5×8), file removed from working set
- Decay reset: edit `a.ts` at turn 1, idle turns 2-5 (score drops by 20), read `a.ts` at turn 6 → turnsSinceLastTouch resets to 0, score boosted by +10, decay restarts from turn 6
- Open-loop exemption: file referenced by active open loop in durable state → not removed even after 8 idle turns
- Top 5: 7 files touched → only top 5 appear in context
- Rebuild from log: replay tool calls → same scores as live tracking

### M3.7 — Session Resume (Block 10)

- [x] `--resume` flag: find latest session for workspace, or specific `ses_<ULID>`
- [x] Rebuild in-memory projection from conversation.jsonl
- [x] Rebuild coverage map, FileActivityIndex, sequence counter
- [x] Reload durable task state from manifest.json (goal, constraints, confirmedFacts, decisions, openLoops, blockers, filesOfInterest, revision, stale)
- [x] Config re-resolved from current sources (CLI flags win)
- [x] Config drift detection: warn if security-relevant settings changed

**Tests:**
- Create session → exit → resume → in-memory state matches original
- Resume with different `--model` flag → resolved config uses new model, warning emitted
- Resume nonexistent session → exit code 4
- Resume latest for workspace: create 3 sessions → resume picks most recent
- Projection rebuild: 10 turns with summaries → visibleHistory matches pre-exit state

---

## Post-Milestone Review
<!-- risk: medium — state management, session persistence, no new execution primitives -->
<!-- final-substep: M3.7 — gate runs after this substep completes -->
<!-- Note: verify log integrity before session resume (context poisoning concern from consultation) -->
- [x] Architecture review (4 witnesses): spec drift, coupling, interface consistency
- [x] Bug hunt (4 witnesses): cross-module integration, adversarial state transitions
- [x] Bug hunt findings converted to regression tests
- [x] Review summary appended to changelog
