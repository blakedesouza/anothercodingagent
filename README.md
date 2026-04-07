# Another Coding Agent

Another Coding Agent (ACA) is a local-first TypeScript CLI for running tool-using coding agents through NanoGPT-compatible chat models.

ACA is built around a simple boundary: the human or host agent makes judgment calls, while ACA agents do bounded work in their own context windows. It supports direct CLI use, structured `aca invoke` calls for delegation, MCP serving, and bounded multi-model consultation.

> **Status: public WIP / experimental.**
> ACA is usable for local development and self-build experiments. The CLI contract, model profiles, and research workflows are still moving as the project matures.

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
- Some historical docs are development archives, not polished user guides.
- Full repo lint currently has known pre-existing test-only `no-explicit-any` failures; see [Known issues](docs/known-issues.md).

## What It Does

- Runs model turns with tool calls, streaming, session persistence, and JSONL conversation logs.
- Provides local tools for file I/O, shell execution, search, LSP queries, browser/web access, MediaWiki/Fandom fetching, and delegation.
- Enforces safety guardrails: allowed/denied tools, per-tool and total tool-call caps, token/input estimates, tool-result byte caps, repeated-read limits, network policy, sandbox checks, and required-output validation.
- Exposes `aca invoke` as a structured JSON contract for other agents or wrappers.
- Exposes `aca serve` as an MCP server.
- Provides `aca consult` for bounded witness review with no-tools triage and context-request style follow-up.
- Includes an `rp-researcher` profile for Markdown lore compendium generation using bounded web/MediaWiki research and exact output paths.

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
npx tsx src/index.ts init
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

Example:

```json
{
  "contract_version": "1.0.0",
  "schema_version": "1.1.0",
  "task": "Research a compact RP lore brief and write only the assigned Markdown file.",
  "context": {
    "profile": "rp-researcher",
    "model": "zai-org/glm-5",
    "cwd": "/path/to/project"
  },
  "constraints": {
    "allowed_tools": ["fetch_mediawiki_page", "fetch_mediawiki_category", "write_file"],
    "max_tool_calls": 100,
    "required_output_paths": ["series/research/source-brief.md"]
  }
}
```

## Documentation

- [Docs index](docs/README.md)
- [Roadmap](docs/roadmap.md)
- [Changelog](docs/changelog.md)
- [Publication checklist](docs/publication-checklist.md)
- [Security](SECURITY.md)
- [Implementation milestones](docs/steps/README.md)
- [Spec index](docs/spec/README.md)
- [Known issues](docs/known-issues.md)

The `docs/handoff-*.md` and `docs/codex-per-file-results/` files are development history. They are kept for traceability, not as first-stop user documentation.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Safety Notes

ACA is an experimental coding agent with tools that can read and modify files and run commands when granted. Keep the default conservative constraints for untrusted workspaces and only widen tool or network access deliberately.

The local Claude/Codex skills used during development are convenience adapters. Core safety and workflow behavior should live in ACA itself.
