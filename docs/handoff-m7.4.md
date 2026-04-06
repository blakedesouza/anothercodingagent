# M7.5 Handoff — Web Capabilities (Block 3)

**Date:** 2026-04-04
**Status:** M7.4 complete. Ready for M7.5.

## What's Done (M7.4)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `BrowserManager` (lazy lifecycle, crash recovery) | Complete | 23 |
| 10 browser tool specs + factory implementations | Complete | 26 |
| Network policy route interceptor (P0 fix) | Complete | 4 |
| Launch promise synchronization (P1 fix) | Complete | 1 |
| **Total** | **M7.4 complete** | **49 new, 1966 total** |

## What to Do Next (M7.5)

From `docs/steps/07c-milestone7-capabilities.md`:

- `web_search` tool: query, domain filter, recency, limit → ranked results. Provider-abstracted (start with SearXNG or Tavily)
- `fetch_url` tool: Tier 1 (HTTP + jsdom + readability → markdown). Tier 2 (Playwright fallback for SPAs)
- `lookup_docs` tool: library, version, query → doc passages
- Network policy enforcement: all web tools check M2.7/M7.10 policy before any request
- Output caps: download 2-5 MB, extracted 4-8K chars
- Security hardening: jsdom without runScripts, strict download size cap, request timeout, redirect limit, Tier 2 reuses M7.4 hardened BrowserContext

## Dependencies

- M7.4: `BrowserManager` for Tier 2 Playwright fallback (`src/browser/browser-manager.ts`)
- M7.10: `evaluateNetworkAccess` for pre-request domain check (`src/permissions/network-policy.ts`)
- M2.5: `ResolvedConfig` for network settings (`src/config/`)
- New packages needed: `jsdom`, `@mozilla/readability`, `turndown` or `node-html-markdown`

## File Locations

- Browser manager (Tier 2 reference): `src/browser/browser-manager.ts`
- Browser tools (pattern reference): `src/browser/browser-tools.ts`
- Network policy: `src/permissions/network-policy.ts`
- Suggested new: `src/tools/web-search.ts`, `src/tools/fetch-url.ts`, `src/tools/lookup-docs.ts`
