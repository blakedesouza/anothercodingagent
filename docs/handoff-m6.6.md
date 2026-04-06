# M6.6 Handoff — CLI Wiring + Integration Test

**Date:** 2026-04-03
**Status:** M6.5 complete. Ready for M6.6.

## What's Done (M6.5)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| searchSemanticSpec (ToolSpec) | Complete | 2 |
| createSearchSemanticImpl (factory w/ DI) | Complete | 14 |
| Async readSnippet with path traversal guard | Complete | 2 |
| AbortSignal cancellation in scoring loop | Complete | — |
| **Total** | **Complete** | **16** |

## What to Do Next (M6.6)

From `docs/steps/06-milestone6-indexing.md`:

- Wire embedding index initialization at session start (background, non-blocking)
- Register `search_semantic` tool in `index.ts`
- Wire `/reindex` slash command
- Real API test: ask agent to "find code related to X" → `search_semantic` executes, results used by LLM
- Incremental index: modify a file, verify index updates on next session

## Dependencies

- M6.5 complete — `searchSemanticSpec` and `createSearchSemanticImpl` ready for registration
- M6.4 complete — `Indexer` class with `buildIndex()` / `incrementalUpdate()` / `ready` / `indexing`
- M6.3 complete — `IndexStore` for per-project SQLite index
- M6.2 complete — `EmbeddingModel` for WASM embeddings
- M5.8 complete — `index.ts` CLI entry point with existing wiring patterns

## File Locations

- Register tool: `src/index.ts` (follow existing tool registration pattern)
- Tool source: `src/tools/search-semantic.ts` (searchSemanticSpec, createSearchSemanticImpl, SearchSemanticDeps)
- Indexer: `src/indexing/indexer.ts` (Indexer class)
- Index store: `src/indexing/index-store.ts` (IndexStore class)
- Embedding: `src/indexing/embedding.ts` (EmbeddingModel class)
- New test: `test/integration/indexing-wiring.test.ts`

## Key Implementation Notes

- `createSearchSemanticImpl` needs `{ indexer, store, embedding }` deps — construct these at startup
- Indexer needs `rootDir`, `store`, `embedding`, and optional config
- For background indexing (> 500 files): call `indexer.buildIndexBackground()` without awaiting
- The `search_semantic` tool checks `indexer.indexing` / `indexer.ready` internally — no external guard needed
- `/reindex` slash command should call `indexer.buildIndex()` and report results

## Post-Milestone Review

M6.6 is the **final substep** of Milestone 6 (`<!-- final-substep: M6.6 -->`). After approval, the post-milestone review gate fires automatically (medium risk: architecture + bug hunt, 4 witnesses each).
