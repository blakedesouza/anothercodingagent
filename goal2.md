# ACA — Goal 2: The Payoff

**After M7b, ACA starts paying for itself.**

## Where We Are

M1-M6 built the body and memory: agent loop, 16 tools, permissions, sandbox, context management, rendering, multi-provider, observability, CLI wiring, and semantic code search. M7A added the reliability/security layer needed before delegation: typed errors, retry policy, confusion limits, capability health, degraded-tool masking, network egress enforcement, and stronger secrets scrubbing. That's 1673 passing tests of infrastructure.

All of it has been built by Opus holding every file in context, writing every line, running every test. The witnesses (MiniMax, Kimi, Qwen, Gemma) review code, but their full raw reviews still flow back into Opus context. M7A.5 is the proposed compression layer: a watchdog aggregates structured findings so Claude reads the short triage report first and drills into raw reviews only when needed.

## What M7b Changes

M7b is delegation. After it lands:

- **Claude stops doing the work.** Claude designs, orchestrates, reviews. ACA agents (qwen3-coder, deepseek, etc. via NanoGPT) read files, write code, run tests — with their own tools, their own context windows.
- **Witnesses get hands.** Instead of reviewing Opus's summary of the code, witnesses `read_file` and `search_text` themselves. They form opinions from the actual source. They catch what summaries miss.
- **The cost flips.** Right now every substep costs a full Opus session. After M7b, the heavy lifting (thousands of tool calls, file reads, code generation) shifts to NanoGPT's $8/mo flat rate. Opus just orchestrates.
- **Work parallelizes.** Multiple agents on different tasks simultaneously. No more one-substep-at-a-time bottleneck.

## The Remaining Path

```
NOW ──► M7A.5 (review aggregator/watchdog) ── 4 substeps
    ──► M7b (DELEGATION)               ── 4 substeps  ◄── everything changes here
    ──► M7c (LSP, browser, web, undo)  ── 9 substeps
```

17 substeps remain if M7A.5 is inserted before M7B. After M7B lands, every subsequent substep can be built using the system itself — agents writing code, witnesses reviewing with tools, watchdog triaging review output, Claude orchestrating. M7C isn't just the last mile, it's the first real test of ACA building ACA.

## Why It's Worth the Investment

A week and a half of Opus sessions built the infrastructure. M7b turns that into a force multiplier. Every substep after delegation costs less Opus context, runs faster (parallel agents), and gets better reviews (tool-equipped witnesses reading real code). The sooner we get there, the cheaper everything after becomes.
