<!-- Source: fundamentals.md lines 2235-2375 -->
### Block 20: Rich Project Indexing & Embeddings

Semantic code understanding beyond basic file-tree detection. This block adds an embedding-based code index, AST-level symbol extraction, and semantic search to the agent's toolkit. It extends the existing Project Awareness outline (basic root detection, shallow stack detection) with deep project understanding that persists across sessions and informs context assembly.

**Core principle: index once, query fast, update incrementally.** The initial index build may take seconds to minutes depending on project size, but subsequent queries are sub-100ms and incremental updates process only changed files. The index is a local optimization — the agent functions without it (all existing tools work independently), but with it, the agent can find relevant code semantically rather than relying solely on text search and the model's own exploration.

**Foundational decisions:**

- **Embedding model runs locally via Transformers.js (WASM), no native dependencies.** The agent uses `@xenova/transformers` (now `@huggingface/transformers`) to run a small embedding model entirely in WASM. This avoids native compilation dependencies, works offline, and keeps embeddings private (no API calls for indexing).

  **Default model:** `Xenova/all-MiniLM-L6-v2` — 384-dimensional embeddings, ~23MB model file, ~80ms per embedding on a modern CPU. This is a general-purpose sentence-transformer that works well for code search (queries like "function that handles authentication" find relevant code).

  **Model download:** The WASM model files are downloaded on first use to `~/.aca/models/` and cached. The download (~23MB) happens once per model version. If the download fails (offline, network restricted), the agent warns and continues without embedding support — all other indexing (symbol extraction, file metadata) still works.

  **Why not API-based embeddings:** API calls for indexing would be slow (network latency per file), costly (thousands of embeddings for a medium project), and require network access. Local WASM embeddings are ~80ms per chunk, free, and work offline. API-based embeddings are available as an opt-in alternative for users who prefer higher-quality embeddings or need to index very large codebases faster (batch API calls).

  **Alternative embedding source (opt-in):** Users can configure `indexing.embeddingProvider` in user config to use an API-based embedding model via the provider system (Block 17). When configured, the indexer uses the provider's embedding API instead of local WASM. This is useful for large codebases where local embedding is too slow, or for users who want code-specific embedding models (e.g., `text-embedding-3-small`).

- **Index storage is per-project in SQLite, keyed by workspace ID.** Each project gets its own index database. The index is a local cache — it can be deleted and rebuilt without data loss.

  **Storage location:** `~/.aca/indexes/<workspaceId>/index.db` where `workspaceId` is the `wrk_<sha256>` from Block 5.

  **Database tables:**

  | Table | Purpose | Key columns |
  |---|---|---|
  | `files` | File metadata index | `path`, `hash` (content SHA-256), `size`, `language`, `last_indexed`, `last_modified` |
  | `chunks` | Indexed text chunks | `chunk_id`, `file_path`, `start_line`, `end_line`, `content_hash`, `embedding` (BLOB, 384 floats) |
  | `symbols` | AST-extracted symbols | `symbol_id`, `file_path`, `name`, `kind` (function, class, interface, etc.), `start_line`, `end_line`, `parent_symbol_id`, `signature` |
  | `metadata` | Index metadata | `key`, `value` (schema version, model name, last full build, file count) |

  **Index size:** For a typical 10K LOC project (~200 source files), the index is approximately 5-15 MB (dominated by embedding vectors: 384 floats × 4 bytes × ~2000 chunks ≈ 3 MB). For a 100K LOC project, approximately 30-80 MB.

- **Indexing scope: source files chunked by semantic boundaries, not fixed character counts.** The indexer processes files matching a configurable set of extensions, respecting `.gitignore` and the existing ignore rules from Project Awareness.

  **Default indexable extensions:** `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.rs`, `.go`, `.java`, `.c`, `.cpp`, `.h`, `.hpp`, `.cs`, `.rb`, `.php`, `.swift`, `.kt`, `.scala`, `.md`, `.json` (package manifests only), `.toml`, `.yaml`/`.yml` (config files only).

  **Skipped always:** `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`, `vendor/`, binary files, generated files (detected by common markers like `// @generated`, `# auto-generated`).

  **Chunking strategy:** Files are split into chunks at semantic boundaries, sized to fit the embedding model's input limit. `all-MiniLM-L6-v2` truncates at 256 word pieces (~50-60 lines of code). Chunks must stay within this limit for accurate embeddings. The chunker prioritizes:
  1. **Function/class/method boundaries** — each top-level function, class, or method becomes one chunk. If a function exceeds 50 lines, it is split into overlapping sub-chunks (10-line overlap) at the nearest statement boundary
  2. **Paragraph boundaries in docs** — markdown files split at heading boundaries
  3. **Fixed-size fallback** — if no semantic boundaries are detected, split at 50 lines with 10-line overlap

  The 50-line default chunk limit is derived from the embedding model's token limit and can be adjusted when a different model is configured. Each chunk stores its file path, line range, content hash, and embedding vector. Chunks are the unit of semantic search — queries return chunks, not whole files.

- **Symbol extraction uses regex-based heuristics, not full AST parsing.** Full AST parsing (tree-sitter) would require WASM grammars per language (~2-5MB each) and complex parser integration. For v1, the symbol extractor uses language-specific regex patterns to extract top-level declarations.

  **Extracted symbol kinds:** `function`, `class`, `interface`, `type`, `enum`, `const`, `method`, `property`, `module`/`namespace`, `export`.

  **Per-language patterns (examples):**
  - TypeScript/JavaScript: `(export\s+)?(async\s+)?function\s+(\w+)`, `(export\s+)?class\s+(\w+)`, `(export\s+)?(const|let)\s+(\w+)\s*=`, `interface\s+(\w+)`, `type\s+(\w+)\s*=`
  - Python: `def\s+(\w+)`, `class\s+(\w+)`, `(\w+)\s*=\s*`
  - Rust: `(pub\s+)?fn\s+(\w+)`, `(pub\s+)?struct\s+(\w+)`, `(pub\s+)?enum\s+(\w+)`, `impl\s+(\w+)`
  - Go: `func\s+(\w+)`, `func\s+\((\w+)\s+\*?(\w+)\)\s+(\w+)`, `type\s+(\w+)\s+struct`

  **Symbol hierarchy:** Methods are linked to their parent class/struct via `parent_symbol_id`. This enables queries like "methods of class Foo" without full AST traversal.

  **Limitations:** Regex-based extraction misses some declarations (complex destructuring, decorated functions, dynamic definitions). This is acceptable for v1 — the symbol index is an optimization for search, not a correctness requirement. The LSP integration (existing `lsp_query` tool) provides accurate symbol information when available.

- **Semantic search is exposed as a new tool: `search_semantic`.** This tool queries the embedding index to find code semantically related to a natural-language query.

  | Tool | What it does | Input | Output |
  |---|---|---|---|
  | `search_semantic` | Find code chunks semantically similar to a query | `query` (string), `limit` (default 10), `file_filter` (optional glob), `min_score` (optional, 0-1) | Ranked results: `{ path, startLine, endLine, score, snippet, symbols }` |

  **Approval class:** `read-only` (no side effects, auto-approved).

  **Search algorithm:** The query string is embedded using the same model as the index. Cosine similarity is computed against all chunk embeddings. Results are ranked by score and filtered by `min_score` (default 0.3). The search runs entirely in-memory — chunk embeddings are loaded from SQLite into a float array at session start (for typical projects, this is < 10MB of memory).

  **Integration with `search_text`:** `search_semantic` complements, not replaces, `search_text`. `search_text` is exact (regex/literal), `search_semantic` is fuzzy (natural language). The model chooses which to use. There is no automatic hybrid search in v1 — the model explicitly calls one or the other.

  **Result shape:** Each result includes the chunk's file path, line range, similarity score (0-1), a snippet of the matching text (first 5 lines), and any symbols defined within the chunk (from the symbol table). This gives the model enough context to decide whether to `read_file` the full section.

- **Incremental updates keep the index fresh as files change during a session.** The index must reflect the current state of the workspace, not the state at session start.

  **Update triggers:**
  1. **Session start:** Compare `files.hash` against current file hashes. Re-index changed files. This catches changes made between sessions (manual edits, git operations)
  2. **After write tools:** When `write_file` or `edit_file` modifies a file, the indexer re-indexes that file's chunks and symbols. This is synchronous but fast (single file ≈ 100-200ms including embedding)
  3. **After `exec_command`:** If the command modifies tracked files (detected by comparing file mtimes before/after), re-index affected files

  **No file watching in v1.** File system watchers (chokidar, fs.watch) add complexity and resource usage. The trigger-based approach covers all changes made through the agent's tools. Changes made outside the agent (e.g., in an editor) are picked up at the next session start or can be manually triggered via a `/reindex` slash command.

  **Hash-based skip:** Files whose content hash matches the indexed hash are skipped during incremental updates. Only changed files are re-embedded.

- **Performance targets and resource limits.**

  | Metric | Target | Limit |
  |---|---|---|
  | Initial index (10K LOC, ~200 files) | < 30s | Hard timeout: 120s |
  | Initial index (100K LOC, ~2000 files) | < 5 min | Hard timeout: 10 min |
  | Incremental update (single file) | < 200ms | — |
  | Semantic query | < 100ms | — |
  | Memory (embeddings loaded) | < 50MB for 10K LOC | Hard cap: 200MB |
  | Disk (index database) | < 15MB for 10K LOC | — |

  **Initial index is deferred to background when possible.** On first session in a project (no existing index), the indexer runs during the startup pipeline (Block 10 Phase 6). If the project is small (< 500 files), indexing completes before the first turn. If large (> 500 files), the indexer starts in the background and the agent proceeds without embedding support — `search_semantic` returns `{ status: "error", code: "indexing_in_progress", retryable: true }` until the index is ready. A stderr progress indicator shows indexing progress.

**Configuration (Block 9 extension):**
```json
{
  "indexing": {
    "enabled": true,
    "embeddingModel": "Xenova/all-MiniLM-L6-v2",
    "embeddingProvider": null,
    "extensions": [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go"],
    "maxFileSize": 102400,
    "maxFiles": 5000
  }
}
```

`enabled`: master switch (default `true`). `embeddingProvider`: if set, use API-based embeddings via Block 17 instead of local WASM. `maxFileSize`: skip files larger than this (default 100KB — large files are usually generated). `maxFiles`: limit total indexed files (default 5000 — prevents runaway indexing on monorepos). All fields are project-safe in config (project config can narrow these, e.g., reduce `maxFiles`).

**Integration with other blocks:**

- **Project Awareness (existing):** Block 20 extends the shallow detection with deep indexing. The `ProjectSnapshot` gains an `indexStatus` field: `{ status: 'ready' | 'building' | 'unavailable', fileCount, chunkCount, symbolCount, lastBuildTime }`
- **Block 7 (Context Window):** The `FileActivityIndex` (Block 7) can be seeded from the project index's symbol table — files with more defined symbols in the user's area of interest score higher. This is a refinement, not a change to Block 7's algorithm
- **Block 6 (Agent Loop):** The `search_semantic` tool is registered like any other tool. No special phase integration needed
- **Block 10 (CLI Interface):** New slash command `/reindex` triggers a full rebuild of the project index. New `aca stats` sub-display shows index status
- **Block 8 (Permissions):** The index database is read-only from the tool's perspective (the model cannot write to it via tools). The indexer writes to it internally. Index files are in `~/.aca/indexes/`, outside the workspace — no sandbox implications

**Dependencies:**

| Package | Size | Purpose |
|---|---|---|
| `@huggingface/transformers` | ~2MB (+ ~23MB WASM model, downloaded on first use) | Local embedding computation |
| `better-sqlite3` | ~2MB + native | Index storage (shared with Block 19) |

**Deferred:**
- Full AST parsing via tree-sitter WASM (accurate symbol extraction, type relationships)
- Cross-reference resolution (find all callers/usages of a symbol)
- Code change impact analysis (which tests cover which functions)
- Import/dependency graph construction
- Architecture pattern detection
- Multi-repository indexing
- Embedding model fine-tuning for code-specific queries
- Hybrid search (combining text and semantic results with rank fusion)
- Code similarity detection (duplicate/near-duplicate code)
- Git-blame-aware indexing (who wrote what, when)
