# ACA Implementation Steps — Milestone 10: The Payoff (Witnesses + Delegation)

This is goal 1 and goal 2 realized. Witnesses get tools. Claude orchestrates, ACA agents do the work. The system builds itself.

**Test framework:** manual verification + /consult comparison
**Prerequisite:** M9 complete (Claude → ACA bridge works)

---

## Milestone 10: Witnesses with Tools + Real Delegation

### M10.1 — Witness Agents with Tool Access

- [x] Create `witness` agent profile in AgentRegistry: read_file, search_text, find_paths, lsp_query (read-only tools)
- [x] Modify `consult_ring.py` to support `--mode aca` flag: instead of raw NanoGPT API call, invoke `aca invoke --json` with witness model + tool access
- [x] Witness ACA agent gets: the review prompt as task, the workspace as context, read-only tools to explore the code
- [x] Witness output: same structured finding format (consult_ring.py handles parsing)
- [x] Fallback: if ACA invoke fails, fall back to raw NanoGPT call (current behavior)
- [x] Performance: ACA witness may take longer (tool calls) but produces more grounded reviews

**Tests:**
- `/consult --mode aca` invokes witnesses as ACA agents
- Witness uses read_file to examine actual source code (not just the inlined excerpt)
- Witness findings reference real file paths and line numbers from tool calls
- Fallback: ACA timeout → falls back to raw API call, still produces review
- Compare: same review prompt, ACA mode vs raw mode → ACA mode cites more specific evidence

### M10.1b — Harden ACA Invoke Pipeline (MCP Spawn Path)

**Context:** Direct `aca invoke` via stdin works (read task returned in ~10s). But `aca_run` via the MCP server (`aca serve`) fails 3/3 with `llm.timeout` — even for trivial read-only tasks. The bug is in the MCP spawn path, not the model.

- [x] **Diagnose:** Add diagnostic logging to `defaultSpawn` in `src/mcp/server.ts` — capture the spawned process's stderr, env vars passed, working directory, and the resolved binary path (`process.argv[1]`)
- [x] **Reproduce locally:** Run `aca serve` manually, send a raw MCP JSON-RPC `aca_run` call via stdin, and capture the subprocess stderr to identify where it hangs (config load? API key lookup? LLM stream?)
- [x] **Root cause candidates** (test each):
  - API key not propagating through `{ ...process.env }` in the serve→invoke spawn chain
  - `process.argv[1]` resolving incorrectly when launched as an MCP server (Claude Code may launch via a different entry point)
  - Working directory mismatch causing config/secrets file resolution to fail silently
  - NanoGPT 30s `apiTimeout` too short for the double-subprocess overhead (serve→invoke→stream)
- [x] **Fix:** Apply the minimal fix for the identified root cause
- [x] **Integration test:** Add a test in `test/mcp/` that spawns the MCP server, sends an `aca_run` tool call, and verifies a successful `InvokeResponse` (use a mock provider to avoid real LLM dependency)
- [x] **End-to-end verification:** Confirm `aca_run` via Claude Code's MCP integration returns a valid response for a simple read task

**Tests:**
- MCP spawn path test: server.ts `runAcaInvoke` → subprocess completes without timeout
- Environment propagation: spawned subprocess inherits API keys from parent
- Binary resolution: `process.argv[1]` resolves correctly in `aca serve` context
- Timeout: tasks complete within 60s (not hitting 30s apiTimeout prematurely)

**Escalation:** If root cause is architectural (double-subprocess latency, model instability), document findings and create M10.1c for a deeper fix before proceeding to M10.2.

### M10.1c — TurnEngine Error Recovery + Executor Model Selection

**Context:** `qwen/qwen3-coder` was never deliberately chosen — it was a fallback when the original Claude Sonnet default didn't work on NanoGPT. Diagnosis (2026-04-05) found two root causes blocking delegation:
1. TurnEngine kills the turn on the first non-retryable tool error (line 676-680), even when other tools in the batch succeed. Every major framework (Anthropic, OpenAI, LangChain) feeds errors back to the model instead.
2. All 16 tools are presented to the model even when `allowedTools` restricts execution, causing confusion. Research shows fewer tools = measurably better accuracy.
3. Qwen3-Coder has a known bug with >5 tools (switches to XML format).

**Part A — TurnEngine Fixes:**
- [x] Change `tool.permission`, `tool.validation`, `tool.sandbox`, `tool.not_permitted` errors to be non-fatal: feed error results back to the model so it can learn and course-correct, instead of setting `outcome = 'tool_error'`
- [x] Only terminate on errors where `mutationState` is `indeterminate` (genuine system failures) — this check already exists at line 682
- [x] When `allowedTools` is set on TurnEngineConfig, filter the `tools` array in the API request to only include allowed tools — don't present tools the model can't use
- [x] Add tests: mixed batch (some tools succeed, some fail validation) → turn continues; indeterminate mutation → turn still terminates

**Part B — Executor Model Evaluation:**
- [x] Test each candidate model with the same coding task via `aca invoke` (direct, not MCP): "Read src/cli/commands.ts and list all slash command names"
- [x] Candidates (subscription-only): `deepseek/deepseek-v3.2`, `moonshotai/kimi-k2.5`, `qwen/qwen3.5-397b-a17b`, `xiaomi/mimo-v2-flash`, `qwen/qwen3-coder-next`, `deepseek-ai/DeepSeek-V3.1`
- [x] For each: record whether it (a) calls only relevant tools, (b) passes correct arguments, (c) produces a correct answer, (d) completes without error
- [x] Pick the winner based on tool-use intelligence, not just raw coding benchmarks
- [x] Update `CONFIG_DEFAULTS.model.default` and Commander fallback to the winning model
- [x] Update `models.json` with the winning model's entry if not already present
- [x] Update NanoGptCatalog to use `/subscription/v1/models` endpoint (was using `/v1/models` which includes paid models)

**Tests:**
- TurnEngine: mixed tool results (success + non-retryable error) → turn continues, model sees errors
- TurnEngine: indeterminate mutation → turn still terminates (safety preserved)
- Tool filtering: `allowedTools` set → API request only contains allowed tool definitions
- Model evaluation results documented in changelog

### M10.2 — First Real Delegated Coding Task

- [x] Claude designs a small feature (e.g., add a `/version` slash command to the REPL)
- [x] Claude delegates implementation to ACA coder agent via `aca_run`
- [x] ACA coder agent: reads existing code, writes the implementation, runs tests
- [x] Claude reviews the result (either directly or via ACA witness agents)
- [x] Iterate: if review finds issues, Claude sends feedback to a new ACA agent to fix
- [x] Final: feature works, tests pass, code is clean

**Tests (manual end-to-end):**
- ACA coder agent produces working code that passes lint and tests
- ACA witness agent reviews the code and provides structured findings
- Claude makes the final accept/reject decision
- Total Opus context used is less than if Claude had written the code itself

### M10.3 — Self-Building: ACA Builds ACA

- [ ] Attempt a full `/build` substep using ACA delegation:
  - Claude reads the substep requirements
  - Claude delegates code writing to ACA coder agent
  - Claude delegates testing to ACA test-runner agent
  - Claude delegates review to ACA witness agents (with tool access)
  - Claude applies fixes based on review findings
  - Claude runs the gate (human confirmation)
- [ ] Measure: context usage, time, quality compared to the old Claude-does-everything approach
- [ ] Document: what worked, what didn't, what needs tuning in agent profiles/prompts
- [ ] Update goal.md and goal2.md with actual results

**Tests (qualitative):**
- A real substep completes end-to-end with delegation
- Code quality is comparable to Claude-written code (reviews catch issues)
- Opus context usage is measurably lower
- Wall-clock time is comparable or faster (parallel agents)

---

## Post-Milestone Review (M10)
<!-- risk: high — first real delegation, witness tool access, self-building -->
<!-- final-substep: M10.3 -->
- [ ] Architecture review (4 witnesses — using ACA mode if M10.1 works): delegation workflow, witness quality
- [ ] Security review (4 witnesses): witness tool access scope, delegation trust chain
- [ ] Bug hunt (4 witnesses): adversarial witness behavior, coder agent failure modes
- [ ] Critical findings fixed and verified
- [ ] Review summary appended to changelog
