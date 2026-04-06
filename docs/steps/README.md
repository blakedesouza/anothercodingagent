# ACA Implementation Steps — File Index

Split from `steps.md` for agent readability. Each file is one milestone or sub-milestone.

M7 split into 4 parts (reordered so error/health/security foundations and review aggregation come before delegation/tools that depend on them).

| File | Lines | Est. Tokens | Contents |
|------|-------|-------------|----------|
| [00-phase0-setup.md](00-phase0-setup.md) | 81 | ~1,500 | Scaffolding, test infrastructure |
| [01-milestone1-agent-loop.md](01-milestone1-agent-loop.md) | 296 | ~6,400 | Types, JSONL, provider, tools, loop, REPL, events |
| [02-milestone2-tools-perms.md](02-milestone2-tools-perms.md) | 232 | ~5,200 | File/shell tools, risk, sandbox, config, approval, network, scrubbing |
| [03-milestone3-context-state.md](03-milestone3-context-state.md) | 187 | ~3,600 | Project awareness, prompts, tokens, compression, summarization, resume |
| [04-milestone4-rendering.md](04-milestone4-rendering.md) | 128 | ~2,200 | Output contract, terminal, syntax, diffs, progress, markdown |
| [05-milestone5-provider-obs.md](05-milestone5-provider-obs.md) | 117 | ~2,000 | Multi-provider, features, SQLite, cost/budget, stats, retention |
| [06-milestone6-indexing.md](06-milestone6-indexing.md) | 93 | ~1,700 | Embeddings, index storage, indexer, semantic search |
| [07a-milestone7-error-health.md](07a-milestone7-error-health.md) | 131 | ~2,500 | Error taxonomy, confusion, health, tool masking, network ext, scrubbing ext |
| [07a5-milestone7-review-aggregation.md](07a5-milestone7-review-aggregation.md) | 72 | ~1,400 | Structured witness findings, review watchdog, benchmark harness, condensed report contract |
| [07b-milestone7-delegation.md](07b-milestone7-delegation.md) | 81 | ~1,600 | Agent registry, spawn, messaging, approval routing |
| [07c-milestone7-capabilities.md](07c-milestone7-capabilities.md) | 179 | ~3,400 | LSP, browser, web, checkpointing, CLI modes, telemetry |
| [08-cross-cutting.md](08-cross-cutting.md) | 28 | ~400 | CI, TypeScript strict, build |
