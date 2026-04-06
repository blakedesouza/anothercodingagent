# ACA Implementation Steps

Concrete, testable execution steps for building Another Coding Agent. Every step references its source block in `fundamentals.md` and specifies what to test. Steps are ordered by dependency within each milestone — complete them sequentially unless noted otherwise.

**Test framework:** vitest
**Test location:** `test/` mirroring `src/` structure (e.g., `src/types/session.ts` → `test/types/session.test.ts`)

---


---

## Milestone 6: Project Intelligence

Goal: Semantic code search via embeddings, symbol extraction, project awareness.

### M6.2 — Embedding Model (Block 20)

- [x] `@huggingface/transformers` with WASM engine
- [x] Default model: `Xenova/all-MiniLM-L6-v2` (384-dimensional)
- [x] Model download to `~/.aca/models/`, cached
- [x] Embedding function: string → float32 array (384 dims)
- [x] Offline fallback: download fails → warning, continue without embeddings

**Tests:**
- Embed "hello world" → 384-dimensional float array
- Embed same text twice → identical vectors
- Embed different texts → different vectors
- Cosine similarity: similar texts → high score (> 0.7). Unrelated → low score (< 0.3)
- Model cache: second load is fast (no download)
- Offline: mock network failure → warning, `search_semantic` returns unavailable error

### M6.3 — Index Storage (Block 20)

- [x] Per-project SQLite: `~/.aca/indexes/<workspaceId>/index.db`
- [x] Tables: files (path, hash, size, language, last_indexed, last_modified), chunks (chunk_id, file_path, start_line, end_line, content_hash, embedding BLOB), symbols (symbol_id, file_path, name, kind, start_line, end_line, parent_symbol_id, signature), metadata (key, value)
- [x] CRUD operations for each table
- [x] Hash-based skip: file unchanged → skip re-indexing

**Tests:**
- Create index → database file exists with correct tables
- Insert file record → query back → matches
- Insert chunk with embedding → retrieve → embedding matches (float comparison)
- Hash-based skip: insert file with hash X → check hash X → returns true (skip)
- Delete file removal: deletes file row, all chunk rows, and all symbol rows for that path (full cascade cleanup)

### M6.4 — Indexer (Block 20)

- [x] Indexing guardrails:
  - Respect `.gitignore` patterns (reuse Project Awareness ignore rules from M3.0a)
  - Extension whitelist (matches Block 20): `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.rs`, `.go`, `.java`, `.c`, `.cpp`, `.h`, `.hpp`, `.cs`, `.rb`, `.php`, `.swift`, `.kt`, `.scala`, `.md`, `.json` (package manifests only), `.toml`, `.yaml`/`.yml` (config files only)
  - `maxFileSize`: skip files > 100 KB (102400 bytes) — large files are usually generated/minified (Block 20 default)
  - `maxFiles`: cap at 5,000 files per project (Block 20 default — prevents runaway indexing on monorepos)
  - `.git/` never indexed (hard block)
  - `node_modules/`, `dist/`, `build/`, `vendor/`, `.venv/`, `coverage/` excluded by default
  - Binary files: skip (detect by null-byte presence or known binary extensions)
  - Generated files: skip files with markers `// @generated` or `# auto-generated`
- [x] File chunking: semantic boundaries (function/class) → sub-chunks at 50 lines with 10-line overlap. Markdown files: chunk at heading boundaries
- [x] Symbol extraction: regex-based per language (TypeScript, Python, Rust, Go, Java, etc.)
- [x] Incremental updates: re-index only changed files (hash comparison)
- [x] Update triggers: session start, after write tools, after exec_command (mtime check)
- [x] Background indexing for large projects (> 500 files)
- [x] `/reindex` slash command for manual rebuild

**Tests:**
- .gitignore parsing tests:
  - Directory pattern (`build/`) → all files under `build/` skipped
  - Extension pattern (`*.log`) → all `.log` files skipped regardless of directory
  - Negation pattern (`!important.log`) → file included despite `*.log` exclusion
  - Nested .gitignore: root ignores `*.tmp`, subdirectory .gitignore ignores `local/` → both rules applied in subdirectory
- Guardrails: `node_modules/` dir present → skipped entirely, not indexed
- Guardrails: file > 100 KB → skipped with log message
- Guardrails: project with 6,000 files → only 5,000 indexed, warning emitted
- Guardrails: `.git/` → never indexed regardless of config
- Guardrails: unknown extension `.xyz` → skipped (whitelist-only)
- Guardrails: `coverage/` directory → skipped entirely
- Guardrails: binary file (contains null bytes) → skipped
- Guardrails: file with `// @generated` marker → skipped
- Chunking: markdown file → chunks split at heading boundaries (not fixed 50-line)
- Symbol extraction per language (parameterized):
  - TypeScript: `function foo()` + `class Bar` → symbols with kind=function, kind=class
  - Python: `def foo():` + `class Bar:` → symbols with kind=function, kind=class
  - Go: `func Foo()` + `type Bar struct` → symbols with kind=function, kind=struct
  - Rust: `fn foo()` + `struct Bar` + `impl Bar` → symbols with kind=function, kind=struct, kind=impl
  - Java: `public void foo()` + `class Bar` → symbols with kind=method, kind=class
  - Unknown language (no regex patterns): fallback to no symbols extracted, chunks still created (content-only)
- TypeScript file with 2 functions → 2 chunks, 2 function symbols
- Python file with class + 3 methods → chunks at class/method boundaries, symbols extracted
- Large function (80 lines) → split into overlapping sub-chunks
- File with no semantic boundaries → 50-line fixed chunks
- Incremental: modify 1 of 10 files → only 1 re-indexed (verify via hash check)
- Background indexing: mock 600-file project → indexing starts in background, search_semantic returns "indexing_in_progress" until ready
- Symbol hierarchy: method linked to parent class

### M6.5 — `search_semantic` Tool (Block 20)

- [x] Input: query (string), limit (default 10), file_filter (glob), min_score (0-1, default 0.3)
- [x] Embed query → cosine similarity vs all chunks → rank → filter → return
- [x] Result shape: path, startLine, endLine, score, snippet (first 5 lines), symbols
- [x] Approval class: read-only

**Tests:**
- Result shape: each result contains all 6 fields — `path` (string, relative), `startLine` (number), `endLine` (number), `score` (number 0-1), `snippet` (string, first 5 lines of chunk), `symbols` (array of symbol names in chunk). Missing any field → test fails
- Query "authentication handler" in project with auth module → auth files ranked highest
- file_filter `*.ts` → only TypeScript chunks returned
- min_score 0.8 → fewer results, all high similarity
- limit 3 → exactly 3 results
- Index not ready → `indexing_in_progress` retryable error
- Empty index → empty results
- **Performance targets:**
  - Indexing: 10,000 LOC project (mock files) completes in < 30s (wall clock, including embedding)
  - Query latency: single search_semantic query against 10,000-chunk index returns in < 100ms (embed + cosine similarity + rank)
  - Incremental re-index: 1 changed file in 10,000-file project completes in < 2s

### M6.6 — CLI Wiring + Integration Test

Wire M6 indexing features into the CLI entry point and verify they work end-to-end.

- [x] Wire embedding index initialization at session start (background, non-blocking)
- [x] Register `search_semantic` tool in `index.ts`
- [x] Wire `/reindex` slash command
- [x] Real API test: ask agent to "find code related to X" → `search_semantic` executes, results used by LLM
- [x] Incremental index: modify a file, verify index updates on next session

**Tests:**
- `search_semantic` tool registered and callable via agent prompt
- Index builds on first session for a small test project
- `/reindex` command triggers re-index

---

## Post-Milestone Review
<!-- risk: medium — new subsystem with indexing lifecycle, WASM embeddings -->
<!-- final-substep: M6.6 — gate runs after this substep completes -->
- [x] Architecture review (4 witnesses): spec drift, coupling, interface consistency
- [x] Bug hunt (4 witnesses): cross-module integration, resource exhaustion in indexing
- [x] Bug hunt findings converted to regression tests
- [x] Review summary appended to changelog
