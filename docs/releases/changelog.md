# Changelog

ACA is still experimental. This file keeps release-facing notes concise; detailed
session history lives in [changelog-history.md](../archive/history/changelog-history.md).

## Unreleased

- Hardened cross-platform path containment and command-risk checks for Windows-style paths, quoted `rm -rf` root targets, preauth cwd matching, context requests, and active-file tracking.
- Fixed NanoGPT tool-emulation JSON repair so valid doubled backslashes in model-emitted regex strings no longer get corrupted into malformed tool payloads during parsing.
- Switched NanoGPT tool routing to prefer native OpenAI-compatible tool calls when the selected model advertises native support, while retaining ACA prompt emulation for non-native tool models and parsing pseudo-call fallback text during native runs.
- Added a native tool-call probe script and developer notes for NanoGPT/DeepSeek V4 request-response shape checks.
- Added a live workflow `stress` bakeoff suite covering harder resume, native-tool transcript, and disk-persistence fixtures.
- Validated native NanoGPT tool calls across direct invoke, recursive delegation, and the `rp-researcher` profile for the current best model routes.
- Hardened DeepSeek V4 invoke handling with DSML pseudo-call parsing, native/emulated `edit_file` argument normalization, diagnosis-only coding completion guards, mutation-focused repair turns, and ESM optional-dependency guidance for V4 Pro and Flash.
- Added DeepSeek V4 Pro prompt hints to reduce literal tool-protocol narration and premature final answers in ACA tool-emulation workflows.
- Hardened invoke final-output validation against embedded pseudo tool-call text and unresolved tool-use intent finals.
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
