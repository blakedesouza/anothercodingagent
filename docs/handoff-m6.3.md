# M6.3 Handoff — Index Storage

**Date:** 2026-04-03
**Status:** M6.2 complete. Ready for M6.3.

## What's Done (M6.2)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| EmbeddingModel class (WASM pipeline) | Complete | 14 |
| cosineSimilarity utility | Complete | 8 |
| Offline fallback + error logging | Complete | 4 |
| Concurrency guard (initPromise) | Complete | 1 |
| Input validation (empty string/array) | Complete | 2 |
| **Total** | **Complete** | **28** |

## What to Do Next (M6.3)

From `docs/steps/06-milestone6-indexing.md`:

- Per-project SQLite: `~/.aca/indexes/<workspaceId>/index.db`
- Tables: files (path, hash, size, language, last_indexed, last_modified), chunks (chunk_id, file_path, start_line, end_line, content_hash, embedding BLOB), symbols (symbol_id, file_path, name, kind, start_line, end_line, parent_symbol_id, signature), metadata (key, value)
- CRUD operations for each table
- Hash-based skip: file unchanged → skip re-indexing

**Tests:**
- Create index → database file exists with correct tables
- Insert file record → query back → matches
- Insert chunk with embedding → retrieve → embedding matches (float comparison)
- Hash-based skip: insert file with hash X → check hash X → returns true (skip)
- Delete file removal: deletes file row, all chunk rows, and all symbol rows for that path (full cascade cleanup)

## Dependencies

- M6.2 complete — EmbeddingModel provides 384-dim Float32Array vectors stored as BLOBs in chunks table
- `better-sqlite3` already in dependencies (used by M5.3 SqliteStore)
- Workspace ID format: `wrk_<sha256>` from Block 5

## File Locations

- New source: `src/indexing/index-store.ts` (or similar)
- New tests: `test/indexing/index-store.test.ts`
- Existing pattern: `src/observability/sqlite-store.ts` for SQLite usage patterns
- Spec reference: Block 20 in `docs/spec/20-indexing-embeddings.md`
