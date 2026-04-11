# M6.4 Handoff — Indexer

**Date:** 2026-04-03
**Status:** M6.3 complete. Ready for M6.4.

## What's Done (M6.3)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| IndexStore class (SQLite, WAL, FK CASCADE) | Complete | 6 |
| File CRUD (upsert with ON CONFLICT DO UPDATE) | Complete | 5 |
| Chunk CRUD with embedding BLOB round-trip | Complete | 4 |
| Symbol CRUD with parent hierarchy | Complete | 2 |
| Metadata CRUD (INSERT OR REPLACE) | Complete | 4 |
| Hash-based skip (hasMatchingHash) | Complete | 3 |
| reindexFile atomic transaction | Complete | 1 |
| getStats (file/chunk/symbol counts) | Complete | 2 |
| embeddingToBuffer/bufferToEmbedding helpers | Complete | 2 |
| Graceful degradation (unopened DB) | Complete | 1 |
| **Total** | **Complete** | **31** |

## What to Do Next (M6.4)

From `docs/steps/06-milestone6-indexing.md`:

- Indexing guardrails: .gitignore, extension whitelist, maxFileSize (100KB), maxFiles (5000), .git/ hard block, default excludes (node_modules, dist, build, vendor, .venv, coverage), binary detection, generated file markers
- File chunking: semantic boundaries (function/class) → sub-chunks at 50 lines with 10-line overlap. Markdown: chunk at heading boundaries
- Symbol extraction: regex-based per language (TypeScript, Python, Rust, Go, Java, etc.)
- Incremental updates: re-index only changed files (hash comparison via IndexStore.hasMatchingHash)
- Update triggers: session start, after write tools, after exec_command
- Background indexing for large projects (> 500 files)
- `/reindex` slash command for manual rebuild

## Dependencies

- M6.3 complete — IndexStore provides all CRUD operations needed
- M6.2 complete — EmbeddingModel provides embed() for chunk embeddings
- M3.0a — Project Awareness provides ignore rules (buildIgnorePaths)
- IndexStore.reindexFile() for atomic file re-indexing
- IndexStore.hasMatchingHash() for hash-based skip

## File Locations

- New source: `src/indexing/indexer.ts` (main indexer), `src/indexing/chunker.ts` (file chunking), `src/indexing/symbol-extractor.ts` (regex symbol extraction)
- New tests: `test/indexing/indexer.test.ts`, `test/indexing/chunker.test.ts`, `test/indexing/symbol-extractor.test.ts`
- Existing: `src/indexing/index-store.ts` (IndexStore), `src/indexing/embedding.ts` (EmbeddingModel)
- Existing: `src/core/project-awareness.ts` (buildIgnorePaths)
- Spec reference: Block 20 in `docs/spec/20-indexing-embeddings.md`
