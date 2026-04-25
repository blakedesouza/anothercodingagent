# Changelog

ACA is still experimental. This file keeps release-facing notes concise; detailed
session history lives in [changelog-history.md](../archive/history/changelog-history.md).

## Unreleased

- Hardened cross-platform path containment and command-risk checks for Windows-style paths, quoted `rm -rf` root targets, preauth cwd matching, context requests, and active-file tracking.
- Fixed NanoGPT tool-emulation JSON repair so valid doubled backslashes in model-emitted regex strings no longer get corrupted into malformed tool payloads during parsing.
- Added structured `aca invoke` and MCP server workflows for bounded agent delegation.
- Added `aca consult` for bounded multi-model witness review with context-request follow-up.
- Added runtime safety layers for sandbox zones, network policy, secret scrubbing, tool budgets, required outputs, and model-output validation.
- Added provider support and compatibility hardening for NanoGPT, OpenAI-compatible, and Anthropic-style streaming/tool-call behavior.
- Added indexing, semantic search, observability, session persistence, and checkpointing support.
- Added experimental `rp-researcher` workflow support for Markdown lore compendium generation.

## Notes

- Public API compatibility is not guaranteed yet.
- Full validation status is tracked in [Known issues](../planning/known-issues.md).
- Historical milestone notes and session handoffs are kept under `docs/archive/` for traceability.
