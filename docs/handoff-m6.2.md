# M6.2 Handoff — Embedding Model

**Date:** 2026-04-03
**Status:** M5 complete (including post-milestone review). Ready for M6.2.

## What's Done (M5 + Review)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| Provider abstraction (Anthropic, OpenAI, NanoGPT) | Complete | 71 |
| Provider features (extensions, emulation, fallback) | Complete | 35 |
| SQLite observability store | Complete | 20 |
| Cost tracking + budget | Complete | 15 |
| `aca stats` command | Complete | 9 |
| Log retention | Complete | 9 |
| Remote telemetry | Complete | 20 |
| CLI wiring (all M1-M5) | Complete | 8 |
| M5 post-milestone review | Complete | 5 regression |
| **Total** | **Complete** | **1270** |

## What to Do Next (M6.2)

From `docs/steps/06-milestone6-indexing.md`:

- `@huggingface/transformers` with WASM engine
- Default model: `Xenova/all-MiniLM-L6-v2` (384-dimensional)
- Model download to `~/.aca/models/`, cached
- Embedding function: string → float32 array (384 dims)
- Offline fallback: download fails → warning, continue without embeddings

**Tests:**
- Embed "hello world" → 384-dimensional float array
- Embed same text twice → identical vectors
- Embed different texts → different vectors
- Cosine similarity: similar texts → high score (> 0.7), unrelated → low score (< 0.3)
- Model cache: second load is fast (no download)

## Dependencies

- M5 complete — provider infrastructure supports embed() placeholder (deferred to M6)
- Model registry has `supportsEmbedding` and `embeddingModels` fields ready

## File Locations

- New source: `src/indexing/embedding.ts` (or similar)
- New tests: `test/indexing/embedding.test.ts`
- Model cache: `~/.aca/models/`
- Spec reference: Block 20 in `fundamentals.md` → `docs/spec/` chunks

## Notes from M5 Review

- AnthropicDriver `this.apiKey!` non-null assertion should be fixed before wiring Anthropic in M6+
- ProviderRegistry exception-based detection should be refactored to Result/null return before M6 wiring adds multiple drivers
