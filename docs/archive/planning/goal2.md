# ACA — Goal 2: The Payoff

**After M7b, ACA starts paying for itself.**

## Where We Are

M1-M6 built the body and memory: agent loop, 16 tools, permissions, sandbox, context management, rendering, multi-provider, observability, CLI wiring, and semantic code search. M7A added the reliability/security layer needed before delegation: typed errors, retry policy, confusion limits, capability health, degraded-tool masking, network egress enforcement, and stronger secrets scrubbing. That's 1673 passing tests of infrastructure.

All of it has been built by Opus holding every file in context, writing every line, running every test. The witnesses (MiniMax, Kimi, Qwen, Gemma) review code, but their full raw reviews still flow back into Opus context. M7A.5 is the proposed compression layer: a watchdog aggregates structured findings so Claude reads the short triage report first and drills into raw reviews only when needed.

## What M7b Changes

M7b is delegation. After it lands:

- **Claude stops doing the work.** Claude designs, orchestrates, reviews. ACA agents (qwen3-coder, deepseek, etc. via NanoGPT) read files, write code, run tests — with their own tools, their own context windows.
- **Witnesses get hands.** Instead of reviewing Opus's summary of the code, witnesses `read_file` and `search_text` themselves. They form opinions from the actual source. They catch what summaries miss.
- **The cost model improves.** Right now every substep can consume a full primary-agent session. After M7b, the heavy lifting shifts to bounded ACA agents through NanoGPT while the primary agent orchestrates.
- **Work parallelizes.** Multiple agents on different tasks simultaneously. No more one-substep-at-a-time bottleneck.

## Product Boundary

The payoff only counts if ACA owns the safety and workflow primitives itself. Claude/Codex skills can remain useful launchers, but they must not be the canonical place where witness safety, context-request reads, triage behavior, or delegation caps live. Those belong in tracked ACA modules and CLI/MCP surfaces so ACA stands alone outside a user's local skill setup.

## The Remaining Path

```
NOW ──► M7A.5 (review aggregator/watchdog) ── 4 substeps
    ──► M7b (DELEGATION)               ── 4 substeps  ◄── everything changes here
    ──► M7c (LSP, browser, web, undo)  ── 9 substeps
```

17 substeps remain if M7A.5 is inserted before M7B. After M7B lands, every subsequent substep can be built using the system itself — agents writing code, witnesses reviewing with tools, watchdog triaging review output, Claude orchestrating. M7C isn't just the last mile, it's the first real test of ACA building ACA.

## Why It's Worth the Investment

A week and a half of Opus sessions built the infrastructure. M7b turns that into a force multiplier. Every substep after delegation costs less Opus context, runs faster (parallel agents), and gets better reviews (tool-equipped witnesses reading real code). The sooner we get there, the cheaper everything after becomes.
