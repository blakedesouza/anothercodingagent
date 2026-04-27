# Another Coding Agent (ACA)

**A local-first TypeScript CLI for tool-using coding agents.**

ACA is built around a composable boundary: the human (or a host agent) makes judgment calls, and ACA agents do bounded work in their own context windows. It runs as a direct CLI, a structured `aca invoke` delegate, an MCP server, a bounded multi-model consultant, or an RP lore researcher.

> **Status: public WIP / experimental.** ACA is usable for local development and self-build experiments. The CLI contract, model profiles, and research workflows are still moving. Public API compatibility is not guaranteed.

---

## Why ACA

Most coding agents are monolithic: one model, one context, one loop. ACA makes the work composable instead.

- **Invoke** — call ACA from another agent or script through a structured JSON contract.
- **Serve** — expose ACA as an MCP server for hosts that can delegate work (e.g. Claude Code).
- **Consult** — ask the default bounded witness pair (`minimax`, `gemma`) for review without handing them an unbounded tool loop.
- **Profile** — tune model behavior per job: coding, review, triage, RP lore research.

The design bet: safety should come from a real sandbox and a wall-clock deadline, not from tool blocklists. Peer agents get the full toolkit; the environment enforces the limits.

---

## What Works Today

All milestones M1–M11 are complete. The current default validation surface passes `npm run verify` on the supported Node 20 runtime.

### Core agent loop
- JSONL conversation log, session manager with resume
- Token estimation, tiered context compression, summarization
- Durable task state, file activity index, session manifest
- Checkpointing and undo via git shadow refs

### Tools
- **Filesystem:** read / write / edit / delete / move / stat / find
- **Shell:** `exec_command`, plus long-lived sessions (`open_session` / `session_io` / `close_session`)
- **Search:** `search_text`, `search_semantic` (WASM embedding index)
- **Web:** `fetch_url`, `web_search` (Tavily), `lookup_docs`
- **Browser:** 10 Playwright tools (navigate, click, type, snapshot, screenshot, evaluate, etc.)
- **LSP:** `lsp_query` with 7 operations across 7 language servers
- **MediaWiki / Fandom:** `fetch_mediawiki_page`, `fetch_mediawiki_category`
- **Delegation:** `spawn_agent`, `message_agent`, `await_agent`
- **User interaction:** `ask_user`, `confirm_action`, `estimate_tokens`

### Safety and permissions
- Workspace sandbox with zone enforcement
- 7-step approval flow with session grants and pre-authorization
- Network egress policy with SSRF-safe redirect checking
- Command risk analyzer (3 tiers, 9 facets)
- Secrets scrubbing pipeline (8+ patterns)
- Capability health tracking with a circuit breaker

### Providers and model catalog
- Drivers for NanoGPT, Anthropic, and OpenAI
- Tool-call emulation for models without native tool support
- Model registry with fallback chains

**Dynamic model catalog (M11).** ACA queries real model ceilings at runtime for NanoGPT-backed models instead of hardcoding stale numbers. Direct Anthropic and OpenAI provider paths currently rely on static capability data. An idle-timeout policy resets on every SSE event across all three drivers so slow-but-progressing models don't get killed by a hard deadline. Delegated agents receive a real project system prompt (working dir, stack detection, available tools), not a generic "helpful assistant" string.

**Peer agent profiles.** A delegated `coder` gets the full tool suite minus delegation; `witness` / `reviewer` get all non-mutating tools plus research tools. Safety comes from the sandbox and deadline, not from clipping the toolkit. Inspect the active lineup with `aca witnesses --json`.

### Consult pipeline (multi-model review)

`aca consult` runs bounded witness review against the default witness pair in parallel:

| Witness  | Model                         | Context | Max output |
|----------|-------------------------------|---------|------------|
| MiniMax  | `minimax/minimax-m2.7`        | 205K    | 128K       |
| Gemma    | `google/gemma-4-31b-it`       | 262K    | 128K       |

You can override the default pair with `--witnesses ...` if you want a different lineup.

Features that took real work to get right:

- **Context-request loop.** Witnesses can ask for specific files or snippets before answering, instead of being force-fed the whole repo.
- **Symbol lookup.** Identifiers in the question are auto-resolved to file locations so witnesses know where to look.
- **Identifier obfuscation.** camelCase / snake_case / hyphenated tokens in prompts are preprocessed to neutral A/B/C labels to prevent model contamination (Qwen in particular is primed by literal `<tool_call>` or `pseudo-tool-call` tokens and will emit them back).
- **Per-model hints.** Separate prompt tweaks for Qwen, Kimi, GLM-5, and others.
- **No-tools triage aggregation** via GLM-5 to produce a synthesized recommendation.

### MCP bridge
- `aca serve` exposes an `aca_run` tool to Claude Code and other MCP hosts
- Supports multi-agent orchestration: parallel ACA tasks with independent sessions

### Observability
- SQLite store with cost tracking, daily budgets, log retention
- `aca stats` for session analytics
- OpenTelemetry export (OTLP/HTTP)

### Project intelligence
- Embedding index (WASM, `Xenova/all-MiniLM-L6-v2`)
- Symbol extraction across 14 languages, semantic chunking
- `search_semantic` with cosine similarity ranking

### Terminal rendering
- Shiki syntax highlighting (19 grammars), diff display, markdown rendering
- Progress indicators, spinner, status line

---

## Requirements

- Node.js 20+
- npm
- A NanoGPT API key (or Anthropic / OpenAI keys if you want those drivers)

## Install and Build

```bash
npm install
npm run build
```

Run tests:

```bash
npm test
```

Typecheck:

```bash
npm run typecheck
```

Run the standard local verification gate:

```bash
npm run verify
```

## Configuration

ACA reads API keys from environment variables or `~/.aca/secrets.json`. See [.env.example](.env.example) for supported variable names. **Do not commit real `.env` files.**

```bash
export NANOGPT_API_KEY=...
```

Initialize local config:

```bash
node --import tsx src/index.ts init
```

Or after building:

```bash
node dist/index.js init
```

For day-to-day local development, you do not need to rebuild after every source edit. Run ACA directly from `src/` instead:

```bash
npm run aca:src -- consult --question "Review this patch for regressions."
```

Use the built `dist/index.js` or linked `aca` binary when you specifically want to validate the shipped artifact.

If linked as a package, `aca` is on your PATH directly.

---

## Commands

```
aca [prompt]                  Direct CLI (interactive or one-shot)
aca serve                     Start ACA as an MCP server on stdio
aca describe                  Output capability descriptor as JSON
aca methods                   Output ACA workflow/method catalog
aca debug-ui                  Start the local ACA debug UI
aca witnesses                 Output witness model configurations as JSON
aca consult                   Run bounded witness consultation
aca rp-research               Research a series and generate an RP knowledge pack
aca invoke                    Execute a structured task from stdin (JSON)
aca stats                     Show session analytics
aca init                      Create ~/.aca/ config and secrets scaffolding
aca configure                 Interactive configuration wizard
aca trust [path]              Mark a workspace as trusted
aca untrust [path]            Remove workspace trust
```

Global flags: `--model`, `--verbose`, `--no-confirm`, `-r/--resume [session]`.

`aca methods --json` is the machine-readable way to route natural-language ACA requests. It now includes language guidance for phrases like `ACA consult`, `ACA invoke`, `fix ACA`, and the fact that bare `ACA` is ambiguous without more context.

### Examples

Describe the structured delegation contract:

```bash
aca describe
```

Run a structured task from stdin:

```bash
cat request.json | aca invoke
```

Bounded witness consultation:

```bash
aca consult --question "Review this patch for regressions." \
            --project-dir "$PWD"
```

Start the MCP server:

```bash
aca serve
```

---

## Profiles

`aca invoke` supports built-in profiles through `context.profile`:

- **`coder`** — implementation work with write-capable tools
- **`reviewer`** / **`witness`** — read-only review
- **`triage`** — aggregation and prioritization
- **`rp-researcher`** — anime / manga / VN / RP lore research and writing

### RP researcher (experimental)

`rp-researcher` is tuned for RP compendiums. Default character-file depth ceilings are middle-ground, not mini-wikis:

- Main characters: 16–20 KB
- Side characters: 8–12 KB
- Minor / supporting: 4–8 KB

These are ceilings, not floors — sparse characters should not be padded. Relationship sections stay compact (1–2 sentences per important dynamic). Original-language text is avoided unless needed to disambiguate an ability or skill name.

Example invoke request:

```json
{
  "contract_version": "1.0.0",
  "schema_version": "1.1.0",
  "task": "Research Arata Kasuga deeply and write only series/world/characters/arata-kasuga.md.",
  "context": {
    "profile": "rp-researcher",
    "model": "zai-org/glm-5",
    "cwd": "/path/to/project"
  },
  "constraints": {
    "allowed_tools": [
      "fetch_mediawiki_page",
      "fetch_mediawiki_category",
      "fetch_url",
      "make_directory",
      "write_file"
    ],
    "max_tool_calls": 100,
    "required_output_paths": ["series/world/characters/arata-kasuga.md"]
  }
}
```

---

## Current Limits

- Public API compatibility is not guaranteed
- Model behavior varies by NanoGPT route and model alias — we test across kimi / deepseek / qwen / gemma because any one of them alone is not a proof
- Broad web / research workflows can still be token-heavy
- Full repo lint currently has known pre-existing test-only `no-explicit-any` failures — see [Known issues](docs/planning/known-issues.md)

---

## Documentation

- [Docs index](docs/README.md) — start here after the README
- [Roadmap](docs/planning/roadmap.md) — current state and next work
- [Known issues](docs/planning/known-issues.md) — current caveats
- [Changelog](docs/releases/changelog.md) — release-facing summary
- [Spec](docs/spec/README.md) — architecture and protocol reference
- [Security](SECURITY.md) — safety and reporting notes

Historical handoffs and detailed development notes are kept under `docs/archive/` for traceability; they are not the primary user guide.

## Repository Map

- `src/` — CLI, agent loop, tools, providers, MCP bridge, consult workflow, safety layers
- `test/` — Vitest coverage for runtime, providers, permissions, tools, consult, integration wiring
- `docs/spec/` — architecture and protocol reference
- `docs/steps/` — milestone implementation plan and history
- `docs/archive/` — historical handoffs, reviews, audit workstreams

---

## Safety Notes

ACA is an experimental coding agent with tools that can read and modify files, run commands, and reach the network when granted. For untrusted workspaces, keep the default conservative constraints and only widen tool or network access deliberately.

The local Claude / Codex skills used during ACA's own development are convenience adapters. Core safety and workflow behavior should live in ACA itself, not in the host harness.

## License

Apache-2.0. See [LICENSE](LICENSE).
