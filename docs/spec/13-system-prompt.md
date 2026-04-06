<!-- Source: fundamentals.md lines 1696-1724 -->
### System Prompt Assembly

Every LLM API call is stateless — the agent must reconstruct the full context each turn. System prompt assembly is the process of building each API request from layered components: static instructions, tool schemas, dynamic project state, user-defined rules, and conversation history. Getting the structure, priority ordering, and compression strategy right determines whether the agent behaves consistently as conversations grow and context fills up.

**Foundational decisions:**
- **Layered request structure.** Each API call has four distinct layers:
  1. **`system` parameter** — static agent charter: identity, operating rules, tool-use policy, editing rules, response format, mode overlay. ~500-800 tokens. Does not change within a session unless mode changes
  2. **Tool definitions** — tool schemas (JSON Schema format) provided to the model via whatever mechanism the provider supports (e.g., `tools` parameter for Anthropic/OpenAI, or inlined for providers without native tool calling). All enabled tools every turn. Dynamic capabilities from delegation contract register as additional tool entries
  3. **Per-turn context block** — synthetic message at top of history: runtime facts (OS, shell, cwd), project snapshot, resolved instruction summary, active working set. Target 300-800 tokens. Refreshed each turn but only recomputed when underlying state changes
  4. **Conversation history** — recent turns verbatim, older turns summarized or truncated as context fills
- **Instruction precedence** — core system rules > repo/user instruction files > current user request > durable task state > prior conversation. Stated explicitly in the system prompt
- **All enabled tools every turn** — gated by mode and environment, not per-turn relevance guessing. Prompt caching makes repeated schemas near-free
- **Project context is compact by default** — workspace root, languages, framework, git branch, dirty summary, top-level dirs, active files. Full trees/diffs fetched via tools on demand
- **Pinned sections (never compressed)** — core system rules, tool signatures, current user message, resolved instruction summary, active errors
- **Context pressure thresholds:**
  - **< 60%** — full fidelity
  - **60-80%** — summarize older turns, trim project snapshot
  - **80-90%** — aggressive: last 2-3 raw turns, shorten tool descriptions
  - **> 90%** — emergency: pinned sections + current message only, signal user
- **Compression order (first to drop → last):** older conversation → project detail → tool description verbosity → instruction detail → never: core rules, tool signatures, current message, errors
- **Durable task state is separate from chat history** — structured object (goal, confirmed facts, open loops, blockers) persists across turns and survives conversation summarization

**Deferred:**
- Exact system prompt wording (iterate through testing)
- Token budget threshold tuning
- Summarization prompt engineering
- Tool description compression heuristics
- Working set ranking (which files count as "active")
