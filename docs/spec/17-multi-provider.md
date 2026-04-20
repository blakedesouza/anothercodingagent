<!-- Source: fundamentals.md lines 1794-1950 -->
### Block 17: Multi-Provider Support

> Current implementation note (2026-04): the live runtime currently wires
> `nanogpt`, `openai`, and `anthropic` providers. `NanoGptCatalog` is the active
> runtime catalog path; `OpenRouterCatalog` exists in the codebase as a helper/tested
> catalog implementation but is not currently selected by the main CLI startup path.
> This block still describes the broader provider architecture and planned extension
> surface around that implementation.

Full provider abstraction enabling seamless switching between LLM providers, model fallback chains, and provider-specific feature negotiation. This block extends the thin `provider` config field (Block 9) into a complete multi-provider architecture, consumed by Block 6's `CallLLM` phase, Block 7's token estimation, and Block 11's LLM error recovery.

**Core principle: model-first, provider-agnostic invocation.** Users and the agent reason about models ("use claude-sonnet"), not providers. The system resolves model names to providers, negotiates capabilities, and normalizes responses behind a uniform streaming interface. Provider-specific complexity never escapes the adapter boundary.

**Foundational decisions:**

- **Every provider implements a `ProviderDriver` with three methods.** This is the total surface area. No provider-specific objects, types, or behaviors are visible outside the driver boundary.

  ```typescript
  interface ProviderDriver {
    capabilities(model: string): ModelCapabilities;
    stream(request: ModelRequest): AsyncIterable<StreamEvent>;
    embed?(texts: string[], model: string): Promise<EmbeddingResult>;
    validate(config: ProviderConfig): Result<void, ConfigError>;
  }
  ```

  `capabilities()` returns static metadata for planning — context limits, feature support, cost. Called once per model at session start and cached. `stream()` is the single invocation method for chat/completion — the agent always streams. Non-streaming providers have their driver yield a single complete event. `embed()` is optional — only providers that support embedding models implement it. It accepts an array of texts and returns an array of float vectors. Block 20 uses this when `indexing.embeddingProvider` is configured. `validate()` catches misconfiguration at startup (Phase 3 of Block 10's startup pipeline), not mid-session.

  **`ModelCapabilities` shape:**

  | Field | Type | Purpose |
  |---|---|---|
  | `maxContext` | number | Context window in tokens |
  | `maxOutput` | number | Max response tokens |
  | `supportsTools` | `'native' \| 'emulated' \| 'none'` | Native tool calling, prompt-injected emulation, or unsupported |
  | `supportsVision` | boolean | Image input support |
  | `supportsStreaming` | boolean | Real-time token streaming |
  | `supportsPrefill` | boolean | Assistant message prefix (Anthropic-style) |
  | `supportsEmbedding` | boolean | Whether the provider offers an embedding API via the `embed()` method |
  | `embeddingModels` | `string[]` | Available embedding model IDs (empty if `supportsEmbedding` is false) |
  | `toolReliability` | `'native' \| 'good' \| 'fair' \| 'poor'` | How reliably the model follows tool schemas. `native` = provider-level enforcement; `good`/`fair`/`poor` = emulated with decreasing accuracy |
  | `costPerMillion` | `{ input: number; output: number; cachedInput?: number }` | USD per million tokens for cost tracking (Block 19) |
  | `specialFeatures` | `Feature[]` | Provider-specific extensions (see below) |

  **`StreamEvent` is a tagged union** normalized by the driver:
  - `{ type: 'text_delta'; text: string }` — incremental text token
  - `{ type: 'tool_call_delta'; index: number; name?: string; arguments?: string }` — incremental tool call
  - `{ type: 'done'; finishReason: string; usage: TokenUsage }` — stream complete with token accounting
  - `{ type: 'error'; error: AcaError }` — provider error (already normalized to Block 11 taxonomy)

  The agent loop (Block 6 phase 5 `CallLLM`) consumes `StreamEvent` without knowing which provider produced it. The `NormalizeResponse` phase (6) receives a complete response reconstructed from the stream events.

- **Model resolution uses a hierarchical registry: exact match, then alias, then default.** The user specifies a model name (e.g., `claude-sonnet`, `gpt-4o`, `deepseek-chat`). Resolution follows a priority chain:

  1. **Exact match** — the model name matches a known model ID in a registered provider's catalog (e.g., `claude-sonnet-4-20250514` resolves to the Anthropic or NanoGPT driver)
  2. **Alias match** — the model name matches a user-defined or built-in alias (e.g., `claude-sonnet` → `claude-sonnet-4-20250514`). Aliases are defined in the model registry
  3. **Default** — if no model is specified, use `model.default` from the resolved config (Block 9)

  No capability-based routing in v1 (e.g., "give me the cheapest model with tool support"). The user picks a model; the system resolves it to a provider. Capability profiles and cost-optimized routing are deferred.

  **Model registry:** A built-in JSON file (`src/providers/models.json`) ships with the agent, containing model IDs, aliases, default capabilities, and cost data for known models. Users can override or extend with entries in their user config (`~/.aca/config.json` under a `models` key). The registry is loaded once at session start and frozen.

- **NanoGPT is one `ProviderDriver` that exposes multiple underlying models.** NanoGPT is a meta-provider — one API key, one base URL, routing to Claude, Kimi, DeepSeek, GPT, and others. In the provider architecture, it is a single driver, not one driver per underlying model.

  The NanoGPT driver's `capabilities()` returns the underlying model's capabilities (context limit, tool support, etc.), not NanoGPT's gateway capabilities. The driver maintains an internal mapping from model ID prefix to underlying provider characteristics (e.g., `claude-*` → Anthropic-style capabilities, `kimi-*` → Moonshot capabilities).

  Users who need to bypass NanoGPT for a specific provider (e.g., direct Anthropic API for prompt caching) can configure an additional provider driver with a higher priority for specific models. NanoGPT remains the default provider for models without a specific override.

- **Provider-specific features use an opt-in extensions system.** Features that affect request behavior (prompt caching, extended thinking, reasoning effort) are requested explicitly via `extensions` in the `ModelRequest`, not auto-detected or silently enabled.

  ```typescript
  interface ModelRequest {
    model: string;
    messages: Message[];
    tools?: Tool[];
    maxTokens: number;
    temperature: number;
    extensions?: ExtensionRequest[];
  }
  ```

  Known extension types:

  | Extension | Provider | Purpose |
  |---|---|---|
  | `anthropic-prompt-caching` | Anthropic | Cache breakpoints for system prompt and tool definitions |
  | `openai-reasoning` | OpenAI | Reasoning effort level for o-series models |
  | `claude-extended-thinking` | Anthropic | Extended thinking budget for complex reasoning |
  | `deepseek-reasoning` | DeepSeek | Include reasoning chain in response |

  Each extension request includes a `required` flag: `{ type: 'anthropic-prompt-caching', required: false, cacheBreakpoints: [0, -2] }`. If `required: true` and the driver does not support the extension, the request fails with `llm.unsupported_feature` error. If `required: false` (default), the driver ignores unknown extensions with a warning logged to the event stream. Extension types are a discriminated union validated against a schema — unknown types are caught at validation time, not silently passed through. The agent loop (Block 6) decides which extensions to request based on `capabilities().specialFeatures`.

- **Model fallback chains are explicit and model-driven, not automatic.** When the primary model is unavailable (rate limited after retries, server errors after retries, auth failure), the agent does not automatically switch to a fallback model. Instead:

  1. The provider adapter returns the error per Block 11's LLM error taxonomy
  2. The agent loop yields with the error
  3. In interactive mode, the user can switch models manually or configure a fallback chain
  4. A configured `fallbackChain` in the user config is consumed by the agent loop, not the provider adapter — the loop decides when to try the next model

  **Rationale:** Automatic fallback risks silent quality degradation (e.g., Claude → GPT-3.5 mid-task). Different models have different tokenizations, context limits, and tool-calling behaviors — switching mid-conversation can corrupt the context. Explicit fallback keeps the user aware of model changes. The `fallbackChain` is a user-level policy, not a provider-level behavior.

  **Fallback semantics when configured:** The agent loop tries the next model in the chain only on provider-level errors (`llm.rate_limited`, `llm.server_error`, `llm.timeout` after retry exhaustion). It does NOT fall back on content errors (`llm.content_filtered`), auth errors (`llm.auth_error`), or context-length errors (`llm.context_too_long`). On each fallback, the agent emits a `model.fallback` event and notifies the user via stderr: "Switching to [fallback model] due to [reason]."

- **Tool calling emulation provides transparent polyfill for providers without native support.** When `capabilities().supportsTools` is `'emulated'`, the driver injects tool definitions into the system prompt as a structured schema block and parses the model's response for tool call patterns (JSON blocks with tool name and arguments).

  The emulation is entirely inside the driver — the agent loop always sees uniform `StreamEvent` with `tool_call_delta` events. The `toolReliability` field in capabilities tells the agent loop how much to trust tool calls from this model, informing the confusion limit (Block 11): models with `'fair'` or `'poor'` reliability may warrant a higher confusion tolerance or simpler tool surfaces.

  **Rationale:** The agent loop (Block 6) must not know or care whether tools are native or emulated. The driver absorbs this complexity. Emulated tool calling works well enough for structured models (DeepSeek, Kimi) but poorly for weaker models — `toolReliability` makes this quality signal explicit.

- **Per-model token counting configuration feeds Block 7's estimator.** Each model's entry in the registry includes a `bytesPerToken` ratio (default: 3.0, overridable per model) that replaces Block 7's hardcoded `ceil(utf8ByteLength / 3)`. The per-model calibration EMA (Block 7) adjusts this ratio at runtime. This is a refinement of Block 7's existing design, not a change — Block 7 already defined the EMA mechanism; Block 17 provides the initial per-model seed values.

**Configuration (Block 9 extension):**

The `provider` config field (Block 9) is extended to support multiple providers:

```json
{
  "providers": [
    {
      "name": "nanogpt",
      "driver": "nanogpt",
      "baseUrl": "https://api.nano-gpt.com/v1",
      "timeout": 30000,
      "priority": 1
    },
    {
      "name": "anthropic-direct",
      "driver": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "timeout": 30000,
      "priority": 2
    }
  ],
  "models": {
    "aliases": {
      "claude-sonnet": "claude-sonnet-4-20250514",
      "fast": "deepseek-chat"
    },
    "fallbackChain": ["claude-sonnet-4-20250514", "gpt-4o", "deepseek-chat"]
  }
}
```

API keys remain in environment variables or `secrets.json` per Block 9's existing rules. The `priority` field determines which provider is tried first when multiple providers can serve the same model. Provider config is user-only — project config cannot set provider endpoints or API keys (Block 9 trust boundary unchanged).

**Built-in drivers shipped with v1:** `nanogpt`, `anthropic`, `openai`. Additional drivers can be added as the ecosystem evolves. Each driver is a module implementing the `ProviderDriver` interface — no plugin loading mechanism in v1.

**Integration with other blocks:**

- **Block 6 (Agent Loop):** `CallLLM` phase resolves the model, gets the driver, calls `driver.stream()`. The loop owns fallback chain logic. `NormalizeResponse` phase receives uniform `StreamEvent` regardless of provider
- **Block 7 (Context Window):** Uses `capabilities().maxContext` for budget calculation. Per-model `bytesPerToken` from registry seeds the estimator. EMA calibration unchanged
- **Block 9 (Configuration):** The nested `provider` config object is replaced by top-level `defaultProvider` (string, selects active provider from `providers` array), `apiTimeout` (global fallback timeout), `providers` array, and `models` object. Backward compatible: if legacy `provider` (object) is present, it is migrated to `defaultProvider` + `apiTimeout`
- **Block 11 (Error Handling):** LLM error codes unchanged. The `provider` field in error details identifies which provider produced the error. Fallback chain decisions happen after error recovery — retry within provider first, then fall back
- **Observability:** `llm.request` and `llm.response` events include `provider`, `model.requested`, `model.resolved`, and `extensions.used` fields

**Deferred:**
- Multi-provider load balancing (distributing requests across accounts/keys)
- Cost-optimized routing (selecting cheapest model that meets capability requirements)
- Model performance tracking (EMA of latency, success rate per model for ranking)
- Local model hosting (vLLM, llama.cpp, Ollama integration)
- Provider-specific prompt format optimization (chat vs. instruct templates)
- Fine-tuned model support
- Multi-modal input beyond text+vision (audio, video)
