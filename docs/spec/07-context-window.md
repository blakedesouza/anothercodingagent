<!-- Source: fundamentals.md lines 691-858 -->
### Block 7: Context Window Management

Every LLM API call is stateless and bounded by a context window. This block defines the mechanics of how conversation history is measured, compressed, and assembled into each request so the agent can sustain arbitrarily long sessions without exceeding the model's limits. It operationalizes the compression tiers defined in System Prompt Assembly, consumes Block 5's conversation data model, and integrates with Block 6's `AssembleContext` phase.

**Core principle: context management is lazy and turn-aligned.** Summaries are not precomputed speculatively. Compression fires only when a real API request is about to exceed budget, and only for the oldest contiguous prefix of completed turns. This keeps the common case (conversation fits) zero-cost and concentrates complexity in the compression path.

**Foundational decisions:**

- **Token counting is a two-stage hybrid: local estimate before the API call, provider-reported count after.** Local estimation is required because the agent must decide what to include *before* sending the request — the API cannot tell us the count of a request we have not yet sent. Provider-reported counts are ground truth for calibration and cost accounting.

  The local estimator operates on the fully serialized request content (not message text alone) using a byte-based heuristic: `ceil(utf8ByteLength / 3)` per text block, plus fixed structural overheads: `+12` per message envelope, `+24` per tool call/result item, `+40` per tool schema definition. This formula is deliberately pessimistic (overestimates) to avoid context-length rejections.

  A per-model calibration multiplier corrects the heuristic over time. After each API call, the agent records the provider-reported `input_tokens` and updates an exponential moving average (EMA) of the ratio `actual / estimated`. The multiplier starts at `1.0` and converges within 3-5 calls. If no provider token count is available (some providers omit it), the multiplier stays at `1.0` and the base heuristic carries the load.

  The safe input budget for each request is: `safeInputBudget = contextLimit - reservedOutputTokens - estimationGuard`, where `estimationGuard = max(512, ceil(contextLimit * 0.08))`. The 8% guard absorbs estimation error. `reservedOutputTokens` is the `max_tokens` parameter for the response (default: 4096). If the provider rejects a request for context length despite the guard, the agent escalates one compression tier and retries once with an additional 10% guard.

  The estimator is a pure function with no external dependencies — no `tiktoken`, no WASM tokenizers, no per-model tokenizer binaries. This keeps the agent lightweight and provider-agnostic. The calibration EMA is the mechanism for per-model accuracy. Calibration state is stored in the session `manifest.json` and does not need to survive across sessions (it re-converges quickly).

- **Summarization uses the same LLM provider as the active agent, with a structured prompt and strict budget.** The summarizer is not a separate service or a cheaper model — it makes a standard LLM API call through the same provider adapter the agent already uses. This is the simplest correct v1: no additional API keys, no model selection logic, no second provider to configure or fail.

  Summarization is invoked only during `AssembleContext` (Block 6 phase 3), only when the compression tier is `medium` or worse, and only for the oldest contiguous prefix of completed turns that are not already covered by an existing `SummaryItem`. The summarizer never touches the current turn or its tool-call/tool-result chain.

  The summarization prompt requests structured JSON output: `{ "summaryText": "...", "pinnedFacts": ["..."], "durableStatePatch": {...} }`. The prompt rules: include only confirmed facts, decisions made, files touched with what changed, errors encountered and how they were resolved, user preferences expressed, and unresolved problems. No speculation, no commentary, no narrative filler.

  Granularity is chunk-based: summarize up to 12 completed turns or 20K estimated tokens per summarization call, whichever is smaller. If the unsummarized prefix is larger, summarize in sequential chunks (oldest first) until context pressure drops below the target tier or the prefix is fully covered. Each chunk becomes one `SummaryItem`.

  Token budget for summarization: the summarization call itself (prompt + response) must cost less than 40% of the tokens it saves. If a chunk would violate this ratio (too few turns, too little savings), skip LLM summarization and use the deterministic fallback: retain the first and last items of the range verbatim, extract a digest of tool calls (tool name + status + key output lines), and discard assistant filler text. This fallback produces a `SummaryItem` without an LLM call.

  An optional `compressionModel` configuration field allows overriding the summarization model in future versions (e.g., using a cheaper model for compression). In v1 this field is accepted but ignored — the active model is always used.

- **`SummaryItem` creation happens inside `AssembleContext` and integrates with Block 5's append-only log and in-memory projection.** When compression fires, the summarizer produces a `SummaryItem` that is appended to `conversation.jsonl` as a new record with a new sequence number. The original items it covers are never modified or deleted on disk — the log remains append-only.

  The in-memory projection maintains a `coverageMap: Map<itemSeq, summarySeq>` that tracks which original items are covered by which summary. The projection exposes a `visibleHistory()` method that returns items in sequence order, skipping any original item whose sequence number appears in the coverage map and including the `SummaryItem` in its place. If a newer summary covers a range that includes an older summary's range, the older summary is also skipped — only the newest applicable summary for any given sequence range is visible.

  Originals are always recoverable from disk. The `visibleHistory()` view is what `AssembleContext` uses to build the API request. Display/UI code can use the full item list with coverage annotations to show the user what was summarized.

  On session resume (rebuilding the projection from `conversation.jsonl`), the coverage map is reconstructed by scanning all `SummaryItem` records and their `coversSeq` ranges. This is O(n) in the number of items and runs once at session load.

- **Context assembly follows a budget-first, newest-first packing algorithm.** The algorithm runs every step (every LLM API call) during `AssembleContext`. It produces the final request payload and determines the compression tier. Steps:

  1. **Compute safe input budget** — `contextLimit - reservedOutputTokens - estimationGuard`, applying the per-model calibration multiplier

  2. **Build pinned sections** — these are never compressed and always included:
     - Core system rules (from the `system` parameter layer)
     - Tool signatures (all enabled tools, every turn — prompt caching makes repetition near-free)
     - Current user message (the message that triggered this turn)
     - Resolved instruction summary (repo/user instruction files)
     - Active errors (non-retryable errors the model needs to address)
     - Durable task state (compact rendering, ~80-150 tokens)
     - Current-turn tool-call/tool-result chain (all items from the current turn — these are required for protocol correctness, as the model must see its own tool calls and their results)

  3. **Estimate full uncompressed request** — sum pinned sections + per-turn context block + all visible history items (from `visibleHistory()`). Determine the compression tier from the ratio `estimatedTotal / contextLimit`:
     - `< 60%` → tier `full`
     - `60-80%` → tier `medium`
     - `80-90%` → tier `aggressive`
     - `> 90%` → tier `emergency`

  4. **Apply tier-specific compression** (detailed in the next decision) — modify per-turn context block, tool descriptions, instruction detail, and conversation history according to the tier. If tier is `medium` or worse, ensure a `SummaryItem` exists for the oldest compressible prefix.

  5. **Pack history newest-first by turn boundary** — starting from the most recent completed turn, add turns verbatim until the budget is exhausted. Then include any available `SummaryItem`s for the remaining older prefix. Stop when the budget is full. Within a turn, all items are included or none (no partial turns except the current turn, which is always fully included as a pinned section).

  6. **Verify fit** — re-estimate the assembled request. If it still exceeds `safeInputBudget`, escalate one tier and re-run steps 4-5. If already at `emergency` tier, include only pinned sections and emit a `context.assembled` event with `warning: "emergency_compression"`.

  7. **Emit `context.assembled` event** — record `estimatedTokens`, `safeInputBudget`, `tier`, `summaryCreated` (boolean), `coveredSeqRange` (if summary was created), `historyItemCount`, `droppedItemCount`.

- **Tier actions operationalize the compression thresholds defined in System Prompt Assembly.** Each tier applies cumulative actions (higher tiers include all lower-tier actions plus additional compression). The actions follow the defined compression order: older conversation first, then project detail, then tool description verbosity, then instruction detail.

  **Tier `full` (< 60%):**
  - All visible history included verbatim
  - Full per-turn context block (OS, shell, cwd, project snapshot, working set, capability health)
  - Full tool descriptions (descriptions + parameter details + examples)
  - Full resolved instruction summary

  **Tier `medium` (60-80%):**
  - *Conversation:* Summarize oldest completed-turn prefix. Keep current turn + last 4-6 completed turns verbatim. Everything older is represented by `SummaryItem`s
  - *Project detail:* Trim per-turn context block — reduce project snapshot to root directory, stack detection line, git branch/status line, and active file paths only (no directory tree)
  - Tool descriptions and instruction detail unchanged

  **Tier `aggressive` (80-90%):**
  - *Conversation:* Summarize everything older than the last 2-3 completed turns. If existing summaries are still too large, re-summarize them into a single shorter summary (summary-of-summaries)
  - *Project detail:* Per-turn context block becomes minimal — cwd, stack one-liner, git branch only. No directory listing, no file details
  - *Tool descriptions:* Switch to short-form tool descriptions — name + one-line purpose + parameter names only (no parameter descriptions, no examples). Tool signatures (the JSON Schema used for validation) remain unchanged and are always sent in full via the provider's tool mechanism
  - Instruction detail unchanged (this is the last thing compressed before emergency)

  **Tier `emergency` (> 90%):**
  - *Conversation:* Drop all historical summaries. Only the current-turn chain survives (pinned). If the current-turn chain alone exceeds budget, truncate older tool results within the current turn to their digest form (see large tool result handling below)
  - *Project detail:* Dropped entirely
  - *Tool descriptions:* Signatures only, no descriptions
  - *Instruction detail:* Core rules only (identity + safety rules). Resolved instruction summary dropped
  - Emit warning to user via stderr: "Context limit reached — operating with minimal history. Consider starting a new session or breaking the task into smaller pieces."

- **The working set (active files) is tracked by a `FileActivityIndex` derived from tool call history.** The index is an in-memory map from file path to an activity score, persisted in `manifest.json` across turns. It is updated deterministically from tool call results — no LLM call needed.

  Activity sources and weights: `edit_file`/`write_file` = +30, `delete_path`/`move_path` = +35 (high because the model needs to know about structural changes), `read_file` = +10, `search_text` match in file = +5, user message path mention = +25, open-loop reference (from durable task state) = +20. Decay: subtract `5 * turnsSinceLastTouch` per turn. Files drop from the working set after 8 inactive turns unless referenced by an active open loop in durable task state.

  The per-turn context block includes the top 5 files by score, rendered as path + role only (e.g., `Active files: src/agent.ts (editing), src/types.ts (reading), test/agent.test.ts (editing)`). File *content* is never auto-injected — the model reads files via `read_file` when it needs them. The working set tells the model *which* files are relevant, not *what* they contain.

  The index is rebuilt from the conversation log on session resume by replaying tool-call items.

- **Durable task state is a structured object stored outside the conversation items, in the session `manifest.json`.** It is not a `ConversationItem` — it is session-level metadata that survives conversation summarization because it is never part of the conversation history that gets compressed.

  Shape:

  | Field | Type | Purpose |
  |---|---|---|
  | `goal` | `string \| null` | Current high-level task. Set from first user message, updated on explicit goal changes |
  | `constraints` | `string[]` | User-stated constraints ("don't modify package.json", "use vitest not jest") |
  | `confirmedFacts` | `string[]` | Facts confirmed by user or verified by tools (e.g., "project uses pnpm", "auth module is in src/auth/") |
  | `decisions` | `string[]` | Design decisions made during the session ("using factory pattern for providers") |
  | `openLoops` | `Array<{ id, text, status, files }>` | Unresolved issues, pending tasks, things to come back to. Status: `open`, `blocked`, `waiting_user`, `done` |
  | `blockers` | `string[]` | Active blockers preventing progress |
  | `filesOfInterest` | `string[]` | Files the agent should be aware of (feeds working set scoring) |
  | `revision` | `number` | Monotonic version counter |
  | `stale` | `boolean` | True if the LLM patch call failed and state may be outdated |

  **Update mechanics:** Durable task state is updated at turn end (after the turn yields), not every step. The update is a two-phase reducer:
  1. **Deterministic updates from runtime facts** — files modified this turn (from tool call items), tool errors encountered, approvals pending, explicit file mentions in user message. These updates are pure data extraction, no LLM needed
  2. **Optional LLM patch call** — a small LLM call that receives the current durable state plus the current turn's items (user message + assistant messages + tool summaries) and returns a JSON patch: which facts to add, which open loops to update, whether the goal changed. This call uses the same provider as the agent. Its prompt + response must fit in ~4K tokens. If the call fails or times out, the deterministic updates still apply and `stale` is set to `true`. The agent never blocks a turn on durable state refresh

  The LLM-visible rendering of durable task state is injected as part of the pinned sections in every request, targeting ~80-150 tokens. It includes: goal (1 line), active blockers (if any), open loops with `open` or `blocked` status (up to 5), and the 3 most recent confirmed facts. The full state is available in `manifest.json` for debugging.

  When summarization fires, the summarization prompt includes the current durable task state as context so the summarizer knows what facts are already captured and does not need to repeat them in the summary text. The `durableStatePatch` field in the summarizer's structured output allows the summarizer to propose state updates (e.g., marking an open loop as `done` if the summarized conversation resolved it).

- **Large tool results receive tier-dependent compression with three rendering modes.** A single tool result can approach 64 KiB (the Tool Runtime Contract cap), which is roughly 10-15K tokens — a significant fraction of a 32K-token model's context. These results need special treatment beyond the standard conversation summarization path.

  Tool results are rendered in three modes during context assembly:

  | Mode | When used | Content |
  |---|---|---|
  | `full` | Current turn, tier `full`/`medium` | The complete model-visible payload from the `ToolResultItem` (already truncated to 32 KiB per Block 6 phase 11) |
  | `truncated` | Recent turns, tier `medium`/`aggressive` | The existing truncated payload as stored in the item |
  | `digest` | Older turns, tier `aggressive`/`emergency`, or when a single result dominates the budget | A compact, deterministic summary computed without an LLM call |

  Digest computation is tool-specific:
  - `read_file` → file path, line range, total lines, `[content omitted — use read_file to re-read]`
  - `exec_command` → command, exit code, stderr headline (first error line), bytes omitted count
  - `search_text`/`find_paths` → query/pattern, match count, top 3 match paths
  - `lsp_query` → operation, target, result count, first result summary
  - All other tools → tool name, status, data size, `[result omitted]`

  Digests are computed deterministically from the `ToolResultItem` fields — no LLM call, no disk read. They are typically 50-150 tokens regardless of original result size. The digest is not persisted as a separate item — it is a rendering choice made during `AssembleContext`.

  During context assembly, the packing algorithm (step 5) checks whether any single item in a verbatim turn exceeds 25% of the remaining budget. If so, that item is downgraded to `truncated` or `digest` mode even though the turn would otherwise be included verbatim. This prevents a single large tool result from crowding out multiple turns of useful history.

- **The context management system is provider-agnostic across model context sizes from 32K to 200K tokens.** The `contextLimit` for each model is stored in the provider configuration and read at session start. All thresholds are percentages of this limit, not absolute token counts, so the same logic works for a 32K model (where 60% is ~19K tokens) and a 200K model (where 60% is ~120K tokens).

  The main behavioral difference across context sizes: small-context models (32K-64K) will hit compression tiers more frequently, potentially every few turns in a tool-heavy session. Large-context models (128K-200K) may run entire sessions without compression. The compression machinery must be efficient enough to run every step without noticeable latency when no compression is needed (the common case for large-context models) and correct enough to maintain coherent conversation when compression fires frequently (the common case for small-context models).

  The summarization LLM call is the only potentially slow operation. On a 32K model where compression fires frequently, each summarization call adds one LLM round-trip (~1-5 seconds) to the step. This is acceptable because: summarization only fires when new turns push past the threshold (not on every step within a turn), the chunk size is bounded (12 turns or 20K tokens max), and the fallback is available if the call fails or would be too expensive.

**Integration with other blocks:**

- **Block 5 (Conversation State Model):** `SummaryItem` is appended to `conversation.jsonl`. The `coversSeq` range links summaries to original items. The `FileActivityIndex` and `DurableTaskState` are persisted in `manifest.json`. On session resume, the in-memory projection (coverage map, visible history, working set scores) is rebuilt from the log
- **Block 6 (Agent Loop):** Context management runs entirely within `AssembleContext` (phase 3). No other phase is modified. The `context.assembled` event carries all compression metadata. If summarization fires, the LLM call happens synchronously within phase 3 before the main LLM call in phase 5 (`CallLLM`)
- **System Prompt Assembly:** Block 7 implements the compression tiers and compression order defined there. The tier thresholds (60/80/90%) and the "never compress" list (core rules, tool signatures, current message, errors) are authoritative from System Prompt Assembly — Block 7 adds the instruction summary and durable task state to the pinned set and defines the mechanical actions at each tier
- **Observability:** The `context.assembled` event records `estimatedTokens`, `safeInputBudget`, `tier`, `summaryCreated`, `coveredSeqRange`, `calibrationMultiplier`, `historyItemCount`, `droppedItemCount`. Post-call, the provider-reported `input_tokens` from the `llm.response` event feeds back into the calibration EMA
- **Tool Runtime Contract:** The 64 KiB output cap and the 32 KiB model-visible truncation (Block 6 phase 11) are upstream constraints. Block 7's digest rendering provides additional compression for older tool results during context assembly

**Deferred:**
- Per-model tokenizer integration (tiktoken, sentencepiece) for higher-accuracy estimation
- Background/async summarization (summarize during user think time)
- Summary quality evaluation (detecting when a summary lost critical information)
- Adaptive compression thresholds (tuning percentages based on observed session patterns)
- Cross-session summary persistence (starting a new session with a summary of the previous one)
- Token budget visualization for the user (showing how context is allocated)
- Compression model selection (using a cheaper model for summarization calls)
- Summary-of-summaries optimization (dedicated prompt for re-summarizing existing summaries)
