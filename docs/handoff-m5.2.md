# M5.2 Handoff — Provider Features

**Date:** 2026-04-03
**Status:** M5.1 complete. Ready for M5.2.

## What's Done (M5.1)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| AnthropicDriver (capabilities, stream, validate) | Complete | 20 |
| OpenAiDriver (capabilities, stream, validate) | Complete | 16 |
| embed() placeholder on both drivers (throws not_implemented) | Complete | 2 |
| models.json registry (7 models, aliases) | Complete | — |
| model-registry.ts: resolveModel() alias resolution | Complete | 16 |
| ProviderRegistry: priority-based model→driver resolution | Complete | 10 |
| MockAnthropicServer test helper | Complete | — |
| schema.ts: driver? field on ProviderEntry | Complete | — |
| **Total project tests** | | **1149** |

## What to Do Next (M5.2)

**M5.2 — Provider Features (Block 17):**

- [ ] Extensions system: `ExtensionRequest` in ModelRequest, `required` flag
- [ ] Tool calling emulation for non-native providers (inject schemas in system prompt, parse JSON from response)
- [ ] Fallback chains: configured in user config, tried on provider-level errors only
- [ ] `model.fallback` event on fallback
- [ ] `toolReliability` field in capabilities

**Tests:**
- Extension with `required: true` on unsupported provider → error
- Extension with `required: false` on unsupported provider → warning logged, request proceeds
- Tool emulation: mock provider without native tools → tool definitions injected in system prompt
- Tool emulation: model returns JSON tool call in text → parsed correctly into ToolCallPart
- Fallback chain: primary returns 429 after retries → next model tried
- Fallback NOT triggered on content filter (llm.content_filtered)
- Fallback NOT triggered on auth error

## Dependencies

- `ExtensionRequest` is already defined in `src/types/provider.ts` — `extensions?: ExtensionRequest[]` field exists on `ModelRequest`
- `toolReliability` already exists on `ModelCapabilities` (used in M5.1)
- Fallback chain logic belongs in the **agent loop** (TurnEngine), not the driver — per spec Block 17: "A configured fallbackChain in the user config is consumed by the agent loop, not the provider adapter"
- The `model.fallback` event type needs to be added to the event system (`src/types/events.ts`)

## File Locations

- Step file: `docs/steps/05-milestone5-provider-obs.md`
- Spec: Block 17 in `docs/spec/17-multi-provider.md`
- Extensions already on ModelRequest: `src/types/provider.ts:36-40`
- TurnEngine (for fallback integration): `src/core/turn-engine.ts`
- Event types: `src/types/events.ts`
- New source: `src/providers/tool-emulation.ts` (suggested)

## Key Design Notes (from spec)

- **Fallback semantics**: only on `llm.rate_limited`, `llm.server_error`, `llm.timeout` after retry exhaustion. NOT on `llm.content_filtered`, `llm.auth_error`, `llm.context_too_long`
- **Tool emulation**: entirely inside the driver — agent loop always sees uniform `StreamEvent`. The driver injects tool schemas in system prompt and parses JSON tool calls from text
- **Extension `required: false`**: driver ignores unknown extensions with a warning event. Extension types are validated at request time — unknown types → `llm.unsupported_feature` error if `required: true`
