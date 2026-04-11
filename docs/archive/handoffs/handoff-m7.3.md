# M7.4 Handoff — Browser Automation (Playwright)

**Date:** 2026-04-04
**Status:** M7.3 complete. Ready for M7.4.

## What's Done (M7.3)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `lspQuerySpec` + `createLspQueryImpl` factory | Complete | 10 |
| `LspClient` adapter (vscode-jsonrpc stdio) | Complete | — |
| `LspManager` (lazy lifecycle, ext routing) | Complete | 5 |
| `server-registry` (7 languages) | Complete | 8 |
| Health integration (CapabilityHealthMap) | Complete | 3 |
| Path traversal guard | Complete | 1 |
| **Total** | **M7.3 complete** | **27 new, 1917 total** |

## What to Do Next (M7.4)

From `docs/steps/07c-milestone7-capabilities.md`:

- Browser tools: navigate, click, type, press, snapshot, screenshot, evaluate, extract, wait, close
- Lazy initialization: first browser tool → launch Chromium headless
- Session-scoped BrowserContext: persists cookies/state across calls
- Single active page (v1)
- Crash recovery: restart once with 2s backoff → unavailable on second crash
- Process registry integration: PID, idle TTL (1h), hard max (4h)
- Checkpointing: workspace file writes checkpointed normally; browser state excluded
- Network policy integration: domain checked before navigation (M7.10)
- Security hardening: acceptDownloads: false, permissions: [], sandbox-first launch

## Dependencies

- M7.10: `evaluateBrowserNavigation` for pre-nav domain check (`src/permissions/network-policy.ts`)
- M7.13: `CapabilityHealthMap` for crash tracking (`src/core/capability-health.ts`)
- M2.2: `ProcessRegistry` for PID management (`src/tools/process-registry.ts`)
- Playwright: `@playwright/test` or `playwright-core` npm dependency

## File Locations

- LSP reference pattern: `src/lsp/` (similar lazy lifecycle, crash restart)
- Process registry: `src/tools/process-registry.ts`
- Network policy: `src/permissions/network-policy.ts`
- Suggested new: `src/browser/browser-manager.ts`, `src/tools/browser-tools.ts`
