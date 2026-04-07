# ACA — Goal

**Claude is the brain. ACA is the body.**

Read this file first on every cold start. This is the north star — every milestone, every substep, every design decision should point at this.

## What ACA Is

ACA (Another Coding Agent) exists to give Claude hands. Claude reasons, plans, and decides. ACA executes — reading files, writing code, running commands, searching codebases — by calling LLMs through NanoGPT and giving them tools.

## The Architecture

```
  Claude (Opus/Sonnet — the brain)
     │
     ├── ACA Agent 1 (qwen3-coder via NanoGPT) — writes code
     │     └── tools: read_file, write_file, edit_file, exec_command, ...
     │
     ├── ACA Agent 2 (deepseek-v3.2 via NanoGPT) — runs tests
     │     └── tools: exec_command, read_file, search_text, ...
     │
     ├── ACA Witness 1 (gemma via NanoGPT) — reviews code WITH tool access
     │     └── tools: read_file, search_text, find_paths
     │
     └── ACA Witness 2 (kimi-k2.5 via NanoGPT) — reviews code WITH tool access
           └── tools: read_file, search_text, find_paths
```

- **Claude orchestrates**: designs architecture, reviews results, makes judgment calls, decides what to build next
- **ACA agents do the work**: each agent gets its own NanoGPT LLM call, its own tool access, its own context window. Claude doesn't hold any of that.
- **Witnesses get tools too**: instead of Claude summarizing code for review, witnesses run as ACA agents that can read the code themselves and form opinions from the actual source — not from Claude's summary of the source
- **Provider aggregation matters**: NanoGPT gives access to many models through one provider surface, which makes multi-agent experimentation practical. Keep cost assumptions out of safety decisions; use guardrails even when calls feel cheap.

## Product Boundary

ACA must be functional and safe by itself. Claude/Codex skills are convenience adapters only, not the implementation boundary.

Durable safety features belong in ACA-native code: delegation caps, witness/triage profiles, deterministic evidence packing, context-request snippet fulfillment, no-tools finalization, result artifacts, and safety telemetry. Local skills may call those ACA surfaces, but a GitHub user should not need someone else's `.claude` or `.codex` skill folders to get the safe behavior.

## Why This Matters

- **Save Claude's context**: offload file reading, code generation, test running to ACA agents. Claude stays focused on reasoning.
- **Better reviews**: witnesses that read code directly catch things that summaries miss
- **Parallel work**: multiple ACA agents working simultaneously on different tasks
- **Cost efficiency**: offload heavy context and tool work to bounded model calls while preserving Claude/Codex for judgment and orchestration

## The End State

You say to Claude: "implement M5.5." Claude reads the spec, breaks it into tasks, spawns ACA agents to write the code and tests, then reviews what they wrote — with other ACA agents as witnesses that independently verify by reading the actual files. Claude never needs to hold the full source in context. It orchestrates.

## Where We Are (update this as milestones complete)

- **M1-M7 DONE**: All infrastructure built — agent loop, 30+ tools, permissions, sandbox, context/state, rendering, multi-provider, observability, delegation, browser, LSP, web tools, checkpointing, CLI modes, review aggregation. 2138 tests. All post-milestone reviews complete.
- **M8 NEXT**: **Ship It** — build, package, first real run with NanoGPT. The code works in tests; now make it run for real.
- **M9 AFTER THAT**: **The Bridge** — MCP server so Claude Code can invoke ACA agents as tools.
- **M10 THE PAYOFF**: **Witnesses get tools + real delegation** — the end state described above.

The critical path is now: **M8 get it running → M9 wire it to Claude → M10 Claude orchestrates, ACA executes.**

## Key Files

- `plan.md` — current state, next substep, full roadmap
- `fundamentals.md` — 20-block spec (source of truth for all design)
- `docs/steps/` — substep checklists per milestone
- `docs/changelog.md` — what was built and why
- `src/index.ts` — CLI entry point (where everything is wired together)
