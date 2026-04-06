<!-- Source: fundamentals.md lines 2376-2389 -->
## Deferred to Implementation

| Decision | Why later |
|---|---|
| Sophisticated context compression | Start with truncation, improve later |
| HTTP/IPC transport bindings | CLI-first is sufficient |
| Plugin marketplace / third-party discovery | Delegation contract is sufficient foundation |
| Streaming implementation details | Delivery UX, not architecture |

## Tech Stack

- TypeScript on Node.js
- Runs in Linux terminal (WSL2)
- Provider-agnostic LLM API (NanoGPT primary — access to Kimi, DeepSeek, Claude, and others through one API key)
