# M6.5 Handoff — `search_semantic` Tool

**Date:** 2026-04-03
**Status:** M6.4 complete. Ready for M6.5.

## What's Done (M6.4)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| symbol-extractor.ts (14 languages, parent hierarchy) | Complete | 14 |
| chunker.ts (symbol/markdown/fixed-size strategies) | Complete | 9 |
| indexer.ts (guardrails, gitignore, incremental, concurrency) | Complete | 33 |
| **Total** | **Complete** | **56** |

## What to Do Next (M6.5)

From `docs/steps/06-milestone6-indexing.md`:

- Input: query (string), limit (default 10), file_filter (glob), min_score (0-1, default 0.3)
- Embed query → cosine similarity vs all chunks → rank → filter → return
- Result shape: path, startLine, endLine, score, snippet (first 5 lines), symbols
- Approval class: read-only

## Dependencies

- M6.4 complete — Indexer provides chunking, symbol extraction, and IndexStore population
- M6.2 complete — EmbeddingModel provides `embed()` for query embedding and `cosineSimilarity` utility
- M6.3 complete — IndexStore provides `getAllChunks()` for loading embeddings into memory
- Tool registration pattern from M1.5 (ToolSpec, ToolRegistry)

## File Locations

- New source: `src/tools/search-semantic.ts`
- New test: `test/tools/search-semantic.test.ts`
- Existing: `src/indexing/indexer.ts` (Indexer class — `ready` flag, `indexing` flag)
- Existing: `src/indexing/index-store.ts` (IndexStore — `getAllChunks`, `getSymbolsByFile`)
- Existing: `src/indexing/embedding.ts` (EmbeddingModel — `embed`, `cosineSimilarity`)
- Existing: `src/tools/tool-registry.ts` (ToolRegistry, ToolSpec)
- Spec reference: Block 20 in `docs/spec/20-indexing-embeddings.md`
