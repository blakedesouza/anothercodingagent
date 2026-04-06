# M7 Post-Milestone Review Handoff

**Date:** 2026-04-04
**Status:** M7.15 complete. M7 post-milestone review PENDING (high risk).

## What's Done (M7.15)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| CapabilityHealthMap wiring | Complete | — (integration) |
| LspManager + lsp_query tool | Complete | 1 |
| BrowserManager + 10 browser tools | Complete | 1 |
| Web tools (web_search, fetch_url, lookup_docs) | Complete | 1 |
| AgentRegistry + DelegationTracker | Complete | 1 |
| Delegation tools (spawn/message/await) | Complete | 2 |
| Repl healthMap + metricsAccumulator | Complete | — |
| Async cleanup with fault isolation | Complete | — |
| Tavily env var in secrets | Complete | — |
| **Total** | **M7.15 complete** | **8 new, 2137 total** |

## What to Do Next: M7 Post-Milestone Review

Risk level: **HIGH** — covers sub-agent delegation, transitive permission amplification, browser automation, LSP trust, and `--no-sandbox` fallback.

### Reviews Required (from step file)

1. **Architecture review** (4 witnesses): spec drift, coupling, interface consistency across all M7 substeps (07a, 07b, 07c)
2. **Security review** (4 witnesses): delegation permission escalation, browser sandbox escape vectors, web fetch malware surface, LSP trust, `--no-sandbox` fallback implications
3. **Bug hunt** (4 witnesses): cross-module integration, adversarial delegation chains
4. Arch findings fed into security prompt; security findings fed into bug hunt prompt
5. Critical findings fixed and verified before release
6. Bug hunt findings converted to regression tests
7. Review summary appended to changelog

### Key Source Files for Review

**Error Recovery (07a):**
- `src/core/capability-health.ts` — CapabilityHealthMap
- `src/core/retry-policy.ts` — LLM retry runner
- `src/core/turn-engine.ts` — confusion limits, tool masking

**Delegation (07b):**
- `src/delegation/agent-registry.ts` — 4 built-in profiles
- `src/delegation/spawn-agent.ts` — DelegationTracker, spawn_agent
- `src/delegation/message-agent.ts` — message_agent
- `src/delegation/await-agent.ts` — await_agent
- `src/delegation/approval-routing.ts` — sub-agent approval routing
- `src/types/agent.ts` — AgentIdentity, AgentProfile

**Capabilities (07c):**
- `src/lsp/lsp-manager.ts` — LSP lifecycle, crash recovery
- `src/browser/browser-manager.ts` — Playwright lifecycle, sandbox
- `src/browser/browser-tools.ts` — 10 browser tools
- `src/tools/web-search.ts` — Tavily search
- `src/tools/fetch-url.ts` — HTTP + Playwright fallback
- `src/tools/lookup-docs.ts` — search + fetch composite
- `src/checkpointing/checkpoint-manager.ts` — git shadow refs
- `src/cli/setup.ts` — init/configure/trust/untrust
- `src/cli/executor.ts` — invoke mode
- `src/index.ts` — CLI wiring (final)

### Review Protocol

See `docs/review-protocol.md` for prompt templates. Each review uses `/consult` with all 4 witnesses. Critical/High findings must be fixed before proceeding.
