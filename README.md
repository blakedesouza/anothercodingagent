# Another Coding Agent

**ACA is a local-first TypeScript CLI for tool-using coding agents.**

ACA is built around a simple boundary: the human or host agent makes judgment calls, while ACA agents do bounded work in their own context windows. It supports direct CLI use, structured `aca invoke` calls for delegation, MCP serving, and bounded multi-model consultation.

> **Status: public WIP / experimental.**
> ACA is usable for local development and self-build experiments. The CLI contract, model profiles, and research workflows are still moving as the project matures.

## Why It Exists

ACA is an experiment in making agent work composable instead of monolithic:

- **Invoke:** call ACA from another agent or script through a structured JSON contract.
- **Serve:** expose ACA as an MCP server for hosts that can delegate work.
- **Consult:** ask multiple bounded witness models for review without handing them an unbounded tool loop.
- **Profile:** tune model behavior for different jobs, including coding, review, triage, and RP lore research.

## What Works Today

- Local CLI build and test workflow on Node 20.
- Structured `aca invoke` requests for bounded delegation.
- MCP server entry point through `aca serve`.
- Tool runtime for file, shell, search, web, browser, LSP, MediaWiki/Fandom, and delegation tools.
- Guardrails for allowed/denied tools, per-tool budgets, input/token estimates, tool-result bytes, repeated reads, required outputs, sandbox checks, and network policy.
- `aca consult` for bounded witness review with no-tools triage and context-request follow-up.
- `rp-researcher` profile for experimental Markdown lore compendium generation.

## Current Limits

- Public API compatibility is not guaranteed.
- Model behavior varies by NanoGPT route and model alias.
- Broad web/research workflows can still be token-heavy.
- Detailed milestone history is kept under `docs/archive/` and is not the primary user guide.
- Full repo lint currently has known pre-existing test-only `no-explicit-any` failures; see [Known issues](docs/planning/known-issues.md).

## Requirements

- Node.js 20+
- npm
- A NanoGPT API key

## Quick Start

Install dependencies and build:

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
npx tsc --noEmit
```

## Configuration

ACA reads API keys from environment variables or `~/.aca/secrets.json`.
See [.env.example](.env.example) for the supported environment variable names. Do not commit real `.env` files.

For the NanoGPT driver:

```bash
export NANOGPT_API_KEY=...
```

Initialize local config:

```bash
node --import tsx src/index.ts init
```

After building, the CLI entry point is:

```bash
node dist/index.js --help
```

If installed/linked as a package, use:

```bash
aca --help
```

## Common Commands

Describe the structured delegation contract:

```bash
aca describe
```

Run a structured task from stdin:

```bash
cat request.json | aca invoke
```

Run bounded witness consultation:

```bash
aca consult --question "Review this patch for regressions." --witnesses all --project-dir "$PWD"
```

Start the MCP server:

```bash
aca serve
```

## Profiles

`aca invoke` supports built-in profiles through `context.profile`.

- `coder`: implementation work with write-capable tools.
- `reviewer` / `witness`: read-focused review.
- `triage`: aggregation and prioritization.
- `rp-researcher`: anime, manga, VN, and RP lore research/write workflows.

`rp-researcher` is tuned for RP compendiums: discover the cast/topic plan first,
then run one deep research/write task per character or world file. Default
character-file ceilings are middle-ground depth rather than mini-wikis: up to
16-20 KB for main characters, 8-12 KB for side characters, and 4-8 KB
for minor/supporting characters. These are ceilings, not floors; sparse
characters should not be padded. Relationship
sections should stay compact: important dynamics only, usually 1-2 sentences
each. Original-language text is avoided unless needed to disambiguate an
ability, skill, or magic name.

Example:

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
    "allowed_tools": ["fetch_mediawiki_page", "fetch_mediawiki_category", "fetch_url", "make_directory", "write_file"],
    "max_tool_calls": 100,
    "required_output_paths": ["series/world/characters/arata-kasuga.md"]
  }
}
```

## Documentation

- [Docs index](docs/README.md): the best starting point after this README.
- [Roadmap](docs/planning/roadmap.md): current state, limits, and next work.
- [Security](SECURITY.md): safety and reporting notes.
- [Known issues](docs/planning/known-issues.md): current caveats.
- [Changelog](docs/releases/changelog.md): concise release-facing summary.

Start with the README and roadmap. Architecture notes live under `docs/spec/`;
historical handoffs and detailed development notes are archived separately for traceability.

## Repository Map

- `src/`: CLI, agent loop, tools, providers, MCP bridge, consult workflow, and safety layers.
- `test/`: Vitest coverage for runtime behavior, providers, permissions, tools, consult, and integration wiring.
- `docs/spec/`: architecture and protocol reference.
- `docs/steps/`: milestone implementation plan/history.
- `docs/archive/`: historical handoffs, reviews, planning notes, and audit workstreams.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Safety Notes

ACA is an experimental coding agent with tools that can read and modify files and run commands when granted. Keep the default conservative constraints for untrusted workspaces and only widen tool or network access deliberately.

The local Claude/Codex skills used during development are convenience adapters. Core safety and workflow behavior should live in ACA itself.
