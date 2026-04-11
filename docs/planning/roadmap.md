# Roadmap

ACA is currently an experimental local-first coding agent. The near-term goal is a public WIP GitHub release that is honest about stability while still useful for other builders.

Public positioning: ACA should look intentional and useful for builders who understand it is experimental.

## Current State

- Node 20 / TypeScript ESM CLI.
- NanoGPT-backed model driver with streaming and tool calls.
- Session persistence, JSONL logs, observability, and cost/token accounting hooks.
- Tool runtime for file, shell, search, web, browser, LSP, MediaWiki/Fandom, and delegation tools.
- Permission and safety layers: sandbox checks, network policy, secret scrubbing, allowed/denied tools, per-tool caps, tool-result byte caps, repeated-read caps, input/token guardrails, and required-output validation.
- Structured `aca invoke` contract for delegation.
- MCP server surface through `aca serve`.
- ACA-native `aca consult` for bounded witness consultation.
- Built-in profiles for coding, review, witness, triage, and RP lore research.

## Public WIP Release Criteria

- Root README explains status, install, configuration, commands, and safety model.
- Changelog starts with concise release-facing entries before raw historical notes.
- Milestone docs are clearly marked as implementation history, not the user guide.
- Local-only artifacts stay ignored: `.aca/`, `.claude/`, `.codex`, `.mcp.json`, scratch bug reports, and generated RP project folders.
- Full validation is run or documented before publishing.
- Known limitations are documented rather than implied away.

## Next Product Work

- Convert the RP research workflow from manual invoke batches into an ACA-native command or orchestrator.
- Add explicit high-trust research profiles without changing conservative public defaults.
- Improve write-phase finalization so completed required outputs are not marked failed because of harmless post-write tool attempts.
- Surface safety telemetry more clearly in `aca consult` and `aca invoke` outputs.
- Add compatibility smoke tests for subscription models used as writers, witnesses, and triage.
- Tighten public docs around network policy, model selection, and MCP setup.

## Known Limitations

- Public API stability is not guaranteed yet.
- Model behavior varies substantially across NanoGPT routes and aliases.
- Some tests may depend on real provider behavior unless explicitly isolated.
- Broad research workflows can be token-heavy even when tool calls are bounded.
- The internal milestone archive is large and development-focused.
