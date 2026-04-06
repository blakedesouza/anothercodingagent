<!-- Source: fundamentals.md lines 514-593 -->
## Remaining Foundational Blocks (must define before coding)

### Block 5: Conversation State Model

The canonical data model for everything the agent tracks. All other blocks depend on this shape. Block 6 (Agent Loop) consumes these data structures directly — the two blocks are designed together.

**Core principle: the conversation log is what the LLM reasons over. The event stream (Block: Observability) is what humans debug with.** The conversation state model captures semantic content — messages, tool calls, tool results, summaries. Timing, cost, retries, and health transitions live in the event stream. The two are linked by shared IDs but serve different audiences.

**Foundational decisions:**

- **Six core types form the data model.** The nesting is: `Session` contains `Turn`s, each `Turn` contains `Step`s (one per LLM API call), each `Step` produces `ConversationItem`s. Items are the atomic unit the LLM sees. The types:

  1. **`Session`** — top-level container. Holds identity, lineage (for sub-agents), configuration snapshot, and mutable status. One session per agent instance (root or sub-agent)
  2. **`Turn`** — one user message plus all agent work until yield. Contains metadata (status, outcome, timing) and references a contiguous range of items by sequence number. Turns do not deeply nest items on disk — they reference item ranges
  3. **`Step`** — one LLM API call within a turn. A turn with 5 tool-call rounds has 5 steps. Steps track which items were sent as input and which items the LLM produced as output. Steps also record the model, provider, finish reason, and context stats (token count, compression tier). Steps are the unit the Agent Loop (Block 6) iterates over
  4. **`ConversationItem`** — the atomic unit of conversation history. Three variants:
     - `MessageItem` (role: system/user/assistant) — text content and/or tool-call parts
     - `ToolResultItem` (role: tool) — linked to a tool-call part by `toolCallId`, carries the Tool Runtime Contract output envelope
     - `SummaryItem` — replaces a range of older items when context compression fires (Block 7). Carries the summarized text plus optional pinned facts that must survive compression
  5. **`ToolCallPart`** — lives inside an assistant `MessageItem`. Contains tool name, arguments, and the provider's tool-call ID. This is what the LLM requested. The corresponding `ToolResultItem` is a separate item linked by `toolCallId`
  6. **`DelegationRecord`** — delegation invocations and results flow through the normal tool-call/tool-result pattern (spawn_agent is a tool). The `DelegationRecord` adds sub-agent lineage: child session ID, child agent ID, final status, and the parent event ID for cross-session causality. It is embedded in the `ToolResultItem` for delegation tools, not a separate item kind

- **Identity scheme: ULID-based opaque IDs with type prefixes.** All IDs are `<prefix>_<ulid>` strings. ULIDs are time-sortable and globally unique within a session. Prefixes:

  | Type | Prefix | Example |
  |---|---|---|
  | Session | `ses_` | `ses_01JQ7K...` |
  | Turn | `trn_` | `trn_01JQ7K...` |
  | Step | `stp_` | `stp_01JQ7K...` |
  | Item | `itm_` | `itm_01JQ7K...` |
  | Tool Call | `call_` | `call_01JQ7K...` |

  Session identity is never derived from path. A separate `workspaceId = wrk_<sha256(normalizedRootPath)>` links sessions to projects without encoding paths in session IDs. User-provided labels are metadata only — `ses_<ulid>` is always the primary key. Sub-agent sessions get a new `ses_<ulid>` with `parentSessionId` and `rootSessionId` for lineage traversal

- **Conversation items carry a monotonic sequence number.** Every `ConversationItem` gets a `seq: number` that increments per session. Turns reference item ranges by `[itemSeqStart, itemSeqEnd]`. This enables efficient slicing for context assembly: "give me items 1-50 for the full history" or "give me items 45-50 for recent turns only." Summary items record the `coversSeq: { start, end }` range they replace. Sequence numbers are never reused — summary items get new sequence numbers

- **Append-only canonical log, mutable in-memory projection.** The conversation log file is append-only — items and turn/step records are written once and never modified. This matches the checkpointing decision ("undo rewinds files, not history") and gives crash durability (partial writes lose at most the last item). The turn engine (Block 6) maintains a mutable in-memory projection for fast access: current turn state, pending tool calls, active step, running item count. The projection is rebuilt from the log on session resume. Mutable session-level state (status, current turn number, last activity timestamp) lives in a separate `manifest.json` that is overwritten on each turn boundary

- **Assistant messages use a parts model.** An assistant `MessageItem` contains an array of parts: `TextPart` and `ToolCallPart`. This mirrors provider API response formats (Anthropic content blocks, OpenAI tool_calls) and avoids lossy flattening. A single assistant message can contain interleaved text and tool-call requests. The provider adapter normalizes into this shape regardless of upstream format

- **Tool results carry the standard envelope.** A `ToolResultItem` includes the full `ToolOutput` envelope from the Tool Runtime Contract: `{ status, data, error, truncated, bytesReturned, retryable, timedOut, mutationState }`. For large tool outputs (approaching the 64 KiB cap), the item stores a truncated model-visible version in `data` and a `blobRef` pointing to the full payload on disk. The `blobRef` shape: `{ sha256, path, bytes, mimeType }`. This keeps the conversation log small while preserving full data for debugging

- **Serialization: JSONL per session.** One JSON object per line in `conversation.jsonl`. Each line is a typed record: session manifest snapshot, turn record, step record, or conversation item. The record type is identified by a `recordType` discriminator field. JSONL is chosen over SQLite because: it matches the event stream format, supports append-only writes naturally, is crash-friendly (partial last line is detectable and discardable), is grepable for debugging, and avoids schema migration complexity. If querying becomes a need, build a SQLite indexer on top of JSONL rather than making SQLite the canonical format

- **Storage layout: directory per session under `~/.aca/sessions/`.**

  ```
  ~/.aca/sessions/<ses_ULID>/
    manifest.json          # Session identity, config, mutable status (overwritten per turn)
    conversation.jsonl     # Append-only conversation log (items, turns, steps)
    events.jsonl           # Append-only event stream (observability)
    blobs/                 # Large tool outputs by SHA-256 hash (created on demand)
      <sha256>.bin
  ```

  Sessions are always stored globally under `~/.aca/sessions/`. The `workspaceId` in the manifest links sessions to projects. Project-local `.aca/` directories are for project configuration, not session storage. This avoids polluting project directories and simplifies `.gitignore` management. Sub-agent sessions are stored as sibling directories (not nested) — lineage is tracked via `parentSessionId`, not filesystem hierarchy

- **Session resumability from conversation log.** The `manifest.json` plus `conversation.jsonl` contain enough data to reconstruct the full in-memory state and resume an interrupted session. The event stream is not required for resumption — it is supplementary for debugging and cost accounting. Exact timing replay (reproducing the precise sequence with latencies) requires the event stream. Conversation replay (what was said, what tools were called, what results came back) requires only the conversation log

- **Turn outcome captures why the agent yielded.** Each `TurnRecord` has an `outcome` field that records the reason the turn ended. This is consumed by the Agent Loop (Block 6) for display and by future analytics:

  | Outcome | Meaning |
  |---|---|
  | `assistant_final` | Assistant produced a text response with no pending tool calls |
  | `awaiting_user` | Assistant explicitly asked the user a question |
  | `approval_required` | A tool or action needed user confirmation |
  | `max_steps` | Step limit per turn was reached |
  | `max_consecutive_tools` | Consecutive autonomous tool steps limit reached |
  | `tool_error` | Non-retryable tool error forced a yield |
  | `cancelled` | User interrupted (SIGINT) |
  | `aborted` | Session-level abort |
  | `budget_exceeded` | Cost budget for session or daily limit was reached (Block 19) |

**Deferred:**
- Conversation branching / forking on undo
- Cross-session conversation continuity (resuming a session in a new terminal)
- Named/tagged session bookmarks
- Session search and querying beyond grep
- Rich attachment support (images, binary files as conversation items)
- Conversation export formats (markdown, HTML)
