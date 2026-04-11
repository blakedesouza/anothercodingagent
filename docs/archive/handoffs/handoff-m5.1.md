# M5.1 Handoff — Full Provider Abstraction

**Date:** 2026-04-03
**Status:** M4 complete (post-milestone review approved). Ready for M5.1.

## What's Done (M4)

| Deliverable | Status | Tests |
|---|---|---|
| OutputChannel (stdout/stderr split, modes) | ✓ | 29 |
| TerminalCapabilities detection | ✓ | 24 |
| StatusLine, Spinner, ProgressBar | ✓ | 29 |
| MarkdownRenderer (inline + fenced blocks) | ✓ | 45 |
| SyntaxHighlighter (shiki, lazy init) | ✓ | included in renderer |
| DiffRenderer | ✓ | included in renderer |
| ANSI_REGEX: colon-CSI + 2-char Fe sequences | ✓ (post-review fix) | 5 regression |
| sanitizeLabel C0 control stripping | ✓ (post-review fix) | 4 regression |

**Total suite: 1087 tests passing**

## What to Do Next (M5.1 — Full Provider Abstraction, Block 17)

- Anthropic driver: capabilities, stream (SSE content blocks), validate
- OpenAI driver: capabilities, stream (SSE token deltas), validate
- Optional `embed(texts, model)` on `ProviderDriver` — deferred (throws `not_implemented`)
- `supportsEmbedding` and `embeddingModels` in `ModelCapabilities`
- Model registry (`models.json`): IDs, aliases, capabilities, cost data — replaces M1.4 hardcoded registry
- Model resolution: exact match → alias → default
- `providers` array config (backward-compat with singular `provider`)
- Provider priority for multi-provider model availability

## Tests Required

- Mock Anthropic API → correct StreamEvent normalization (content blocks → text_delta/tool_call_delta)
- Mock OpenAI API → correct StreamEvent normalization
- Both providers: final `done` event preserves `finishReason` and `usage`
- Model resolution: alias resolves to full ID → correct driver selected
- Unknown model → error
- Priority: model available from 2 providers → higher priority selected

## Dependencies

- `src/providers/` directory (new)
- M1.4 model registry (`src/core/model-registry.ts`) — M5.1 replaces hardcoded data with `models.json`
- Block 17 spec: `docs/spec/` (provider abstraction)

## File Locations

- New source: `src/providers/anthropic-driver.ts`, `src/providers/openai-driver.ts`, `src/providers/model-registry.ts`
- New data: `src/providers/models.json`
- Tests: `test/providers/`
