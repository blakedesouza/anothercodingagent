# ACA Implementation Steps — Milestone 11: Dynamic Model Utilization

Every model ACA delegates to was being massively under-utilized. Qwen3-Coder has 65K max output — we gave it 4K. MiniMax M2.7 has 131K — we gave it 8K. The coder agent couldn't even finish writing a single file before being cut off.

This milestone makes ACA query actual model limits at runtime and use them. No model is artificially constrained below its ceiling. The flat-rate NanoGPT subscription means there is zero cost to maximizing utilization.

**Prerequisite:** M10.1b complete (MCP spawn path works)
**Blocks:** M10.2 (delegation can't succeed without real limits and proper context)

---

## Why This Matters

From the NanoGPT API (`GET /api/v1/models?detailed=true`), the actual ceilings:

| Model | Role | Context | Max Output | We Were Giving |
|-------|------|---------|------------|----------------|
| qwen/qwen3-coder | Coder agent | 262,000 | 65,536 | 4,096 |
| minimax/minimax-m2.7 | Witness | 204,800 | 131,072 | 8,192 |
| moonshotai/kimi-k2.5 | Witness | 256,000 | 65,536 | 32,000 |
| qwen/qwen3.5-397b-a17b | Witness | 258,048 | 65,536 | 32,000 |
| google/gemma-4-31b-it | Witness | 262,144 | 131,072 | 32,000 |

The coder agent was operating at **6%** of its output capacity. That's why delegation failed — the model started working, ran out of output tokens, and got cut off mid-thought.

## Design Principles

1. **Maximize utilization.** NanoGPT is $8/mo flat rate, zero marginal cost. Every model gets its actual ceiling — context, output, steps. No artificial caps.
2. **Peer treatment.** These are 30B-1T parameter models performing at frontier level. Full toolkit, full limits. Safety comes from sandbox boundaries and time limits, not tool blocklists or token caps.
3. **Provider-agnostic.** The catalog interface works for NanoGPT today, OpenRouter tomorrow, Anthropic/OpenAI via static fallback. Ready for GitHub release.
4. **Runtime discovery.** Query the API for real limits instead of hardcoding. If a model gets upgraded, ACA picks it up automatically.

---

## Milestone 11: Dynamic Model Capabilities

### M11.1 — Provider-Agnostic Model Catalog

Build a catalog interface that fetches model capabilities at runtime. NanoGPT and OpenRouter get live implementations. Anthropic/OpenAI get static fallbacks.

- [x] Define `ModelCatalogEntry` type: `{ id, contextLength, maxOutputTokens, capabilities: { vision, toolCalling, reasoning, structuredOutput }, pricing? }`
- [x] Define `ModelCatalog` interface: `{ fetch(): Promise<void>, getModel(id): ModelCatalogEntry | null, isLoaded: boolean }`
- [x] Implement `NanoGptCatalog`: calls `GET <baseUrl>/api/v1/models?detailed=true` with auth header. Maps response fields: `context_length` → `contextLength`, `max_output_tokens` → `maxOutputTokens`, `capabilities.tool_calling` → `toolCalling`
- [x] Implement `OpenRouterCatalog`: calls `GET https://openrouter.ai/api/v1/models`. Maps response fields: `context_length` → `contextLength`, `max_completion_tokens` → `maxOutputTokens` (falls back to `top_provider.max_completion_tokens`)
- [x] Implement `StaticCatalog`: wraps existing `models.json` data for Anthropic/OpenAI or offline fallback
- [x] Session-scoped cache: fetch once per session, reuse. Lazy init — first `getModel()` call triggers fetch
- [x] Graceful fallback: if live fetch fails (network error, timeout, malformed response), log warning and fall back to `StaticCatalog`
- [x] Timeout: catalog fetch gets its own short timeout (10s) — acceptable startup cost, don't block indefinitely
- [x] Unit tests: mock HTTP responses for both NanoGPT and OpenRouter formats, verify parsing, verify fallback on failure, verify cache (no double-fetch)

**Files:** `src/providers/model-catalog.ts`
**Tests:** `test/providers/model-catalog.test.ts`

### M11.2 — Driver Integration

Wire the live catalog into the NanoGPT driver so `capabilities()` returns real limits.

- [x] `NanoGptDriver` constructor accepts optional `ModelCatalog` dependency (DI)
- [x] `capabilities()` method: if catalog available, look up the current model's entry and return its `maxContext`, `maxOutput`, `supportsTools`, etc. If not in catalog, fall back to static registry as today
- [x] `maxOutputTokens` for requests: use the catalog's `maxOutputTokens` instead of the config default — the model gets its actual ceiling
- [x] `model-registry.ts` remains as the offline/fallback source — not deleted, just no longer primary for NanoGPT models
- [x] Anthropic/OpenAI drivers unchanged (they use `StaticCatalog` if wired, or their own registries)
- [x] Unit tests: driver returns API limits when catalog available, falls back to registry when catalog unavailable

**Files:** `src/providers/nanogpt-driver.ts`, `src/providers/model-registry.ts`
**Tests:** `test/providers/nanogpt-driver.test.ts` (extend existing)

### M11.3 — Remove Artificial Ceilings

Remove hardcoded limits that were protecting against cost runaway (irrelevant with flat-rate pricing).

- [x] **Invoke step limit:** currently 30 → remove for invoke mode (set to `Infinity`). The MCP deadline is the safety net, not a step counter. Interactive mode keeps its limit (25) since that's about UX, not cost
- [x] **MCP deadline default:** 5 minutes → 15 minutes in `src/mcp/server.ts`. A coding agent doing read→write→test→iterate needs room
- [x] **Default maxOutputTokens:** 4,096 → 16,384 in `CONFIG_DEFAULTS`. This is the offline fallback when catalog is unavailable
- [x] **Default apiTimeout (idle):** 30s → 120s. Per-stream idle timeout, not hard deadline
- [x] Unit tests: invoke mode runs >30 steps without `max_steps` outcome, deadline enforcement still works at 15 min, config defaults are correct

**Note:** Some of these changes were partially applied during M10.2 debugging (idle timeout in 3 drivers, apiTimeout, maxOutputTokens, step limit set to 50). This substep formalizes them to their correct final values and adds tests.

**Files:** `src/core/turn-engine.ts`, `src/mcp/server.ts`, `src/config/schema.ts`
**Tests:** extend existing test files

### M11.4 — Idle Timeout Formalization

The idle timeout fix (reset timer on each SSE event) was implemented during M10.2 debugging. Formalize it with proper tests.

- [x] Verify all 3 drivers (NanoGPT, Anthropic, OpenAI) have the idle-reset pattern: `resetIdleTimer()` called on each SSE event and after connection established
- [x] Test: stream that produces tokens every 30s for 5 minutes total survives (not killed by idle timeout)
- [x] Test: stream that goes silent for >timeout seconds is killed with `llm.timeout`
- [x] Test: initial connection timeout still works (no data at all within timeout window)
- [x] Document the pattern: comment in each driver explaining idle vs. hard timeout

**Files:** `src/providers/nanogpt-driver.ts`, `src/providers/anthropic-driver.ts`, `src/providers/openai-driver.ts`
**Tests:** extend existing driver test files

### M11.5 — Witness Limit Uplift

Update witness configurations to use actual model ceilings. Pull witness config into ACA so it's not scattered across a separate Python script.

- [x] Update `consult_ring.py` WITNESSES dict: set `max_tokens` to each model's actual `max_output_tokens` from the API (minimax: 131072, kimi: 65536, qwen: 65536, gemma: 131072). Add comment noting source: NanoGPT `/api/v1/models?detailed=true` queried 2026-04-05
- [x] **Pull witness config into ACA:** Create `src/config/witness-models.ts` (or similar) that defines the witness model list and their configs. `consult_ring.py` can read this via `aca describe --json` or a new `aca witnesses --json` command, so there's a single source of truth inside ACA
- [x] Verify ACA-mode witnesses (via `aca invoke`) inherit the catalog limits from M11.2
- [x] Test: ACA-mode witness invocation uses catalog limits, not old hardcoded values

**Files:** `src/config/witness-models.ts` (new), `~/.claude/skills/consult/consult_ring.py`
**Tests:** unit tests for witness-models.ts; manual verification for consult_ring.py integration

### M11.6 — Invoke Prompt Assembly

The invoke handler currently gives delegated agents a single system message: `"You are a helpful coding assistant."` No project context, no workspace info, no tool guidance. A rich prompt assembly system exists (`src/core/prompt-assembly.ts`, 328 lines, 4-layer structure) but is never used in invoke mode. This is a major gap — the coder agent was dropped into the codebase blind.

- [x] Wire `assemblePrompt()` (or a lightweight variant) into the invoke handler's TurnEngine config
- [x] Invoke system prompt should include:
  - Identity and role (coding agent with tool access)
  - Working directory / workspace root
  - Available tools and how to use them
  - Project type detection (language, framework) from `detectStack()`
  - Key file locations (package.json, tsconfig, etc.)
- [x] Keep it concise — invoke mode doesn't need the full interactive prompt. No conversation history, no durable task state. Just enough context for the agent to orient itself
- [x] Respect the model's context budget — prompt should be <2K tokens so the agent has maximum room for the task and tool outputs
- [x] Test: invoke handler sends a system prompt containing workspace root and tool list
- [x] Test: delegated agent with real context completes a file-reading task faster (fewer wasted steps) than with the bare prompt

**Files:** `src/index.ts` (invoke handler), `src/core/prompt-assembly.ts`
**Tests:** `test/cli/executor.test.ts` (extend), `test/integration/invoke-prompt.test.ts` (new)

### M11.7 — Peer Agent Profiles

These models are capable peers, not students. Give them the full toolkit. The sandbox and deadline handle safety — not artificial tool restrictions.

- [x] **Coder profile:** expand from 7 tools to full tool set minus delegation (no spawn_agent, message_agent, await_agent). Add: delete_path, move_path, make_directory, stat_path, search_semantic, fetch_url, web_search, lookup_docs, open_session, session_io, close_session, estimate_tokens, browser tools
- [x] **Witness profile:** expand from 4 read-only tools to all non-mutating tools. Add: search_semantic, fetch_url, web_search, lookup_docs, estimate_tokens, stat_path. They should be able to research, not just grep
- [x] **Reviewer profile:** same expansion as witness (read-only + research)
- [x] **Researcher profile:** expand to include search_semantic, lsp_query, all web tools
- [x] Remove the `WATCHDOG_DENIED_TOOLS` approach for coder/witness — the sandbox enforces boundaries, not a tool blocklist
- [x] Update agent-registry.ts with new default tool sets
- [x] Unit tests: verify expanded profiles, verify delegation tools still excluded from non-general profiles

**Principle:** AI isn't inherently malicious. Treat delegated agents as peers with the same capabilities, constrained only by the sandbox (workspace boundaries) and the deadline (time limit). No other artificial restrictions.

**Files:** `src/delegation/agent-registry.ts`, `src/review/report.ts`
**Tests:** `test/delegation/agent-registry.test.ts`

### M11.8 — CLI Wiring + Integration Test

Wire the catalog into ACA's startup and verify everything works end-to-end.

- [x] `index.ts` startup: create appropriate `ModelCatalog` instance based on configured provider (NanoGPT → `NanoGptCatalog`, OpenRouter → `OpenRouterCatalog`, else → `StaticCatalog`). Pass to driver
- [x] Log discovered model limits at verbose level on startup (model name, context, max output)
- [x] Integration test: mock NanoGPT API returning model details → verify driver reports correct limits → verify invoke handler uses them
- [x] Smoke test: real `aca invoke` with a task that requires >4K output tokens completes successfully
- [x] Verify: the `StaticCatalog` fallback works when API is unreachable (airplane mode test)
- [x] Verify: invoke prompt assembly includes workspace context (from M11.6)
- [x] Verify: peer agent profiles grant full tool access (from M11.7)

**Files:** `src/index.ts`
**Tests:** `test/integration/model-catalog.test.ts`

---

## Partially-Done Work (from M10.2 debugging session)

These changes were made during the M10.2 debugging session and exist in the working tree. They are directionally correct but some need adjustment to match the final plan:

| File | Change | Final Target | Action |
|------|--------|-------------|--------|
| `src/providers/nanogpt-driver.ts` | Idle timeout (reset on SSE) | Keep as-is | M11.4 adds tests |
| `src/providers/anthropic-driver.ts` | Same idle timeout | Keep as-is | M11.4 adds tests |
| `src/providers/openai-driver.ts` | Same idle timeout | Keep as-is | M11.4 adds tests |
| `src/config/schema.ts` | apiTimeout 30→120s, maxOutputTokens 4096→16384 | Keep as-is | M11.3 verifies |
| `src/core/turn-engine.ts` | Step limit 30→50 | Should be Infinity | M11.3 corrects |
| `src/providers/models.json` | Added qwen3-coder entry | Superseded by catalog | M11.1 replaces |

**Decision:** Commit idle timeout fix as prep work (clean, tested, unambiguous). All other changes will be finalized through the /build workflow in their respective substeps.

---

## Post-Milestone Review (M11)
<!-- risk: medium — changes to model limits affect all LLM interactions, prompt assembly affects delegation quality -->
<!-- final-substep: M11.8 -->
- [x] Architecture review (4 witnesses): catalog interface design, provider abstraction, fallback strategy, prompt assembly integration
- [x] Bug hunt (4 witnesses): edge cases in limit application, timeout interactions, catalog staleness, prompt size vs context budget
- [x] Critical findings fixed and verified
- [x] Review summary appended to changelog
