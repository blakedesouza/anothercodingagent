# M7.8 Handoff — Secrets Scrubbing — Pattern Detection

**Date:** 2026-04-03
**Status:** M7.10 complete. Ready for M7.8.

## What's Done (M7.10)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| 5 new shell detection patterns (scp, rsync, docker pull, pip, cargo) | Complete | 6 parameterized + 11 individual |
| extractHostFromRemoteSpec helper with = skip | Complete | 2 |
| evaluateBrowserNavigation function | Complete | 4 |
| network.checked event type + NetworkCheckedPayload | Complete | 4 |
| Pattern reorder (scp/rsync before ssh) | Complete | 1 |
| Localhost exception asymmetry tests | Complete | 4 |
| fetch_url integration tests | Complete | 3 |
| **Total** | **M7.10 complete** | **34 new** |

## What to Do Next (M7.8)

From `docs/steps/07a-milestone7-error-health.md`:

- Strategy 2: pattern detection — API key prefixes (`sk-`, `pk_test_`, `AKIA`, `ghp_`, `ghs_`, `glpat-`), Bearer tokens, PEM keys, `.env` assignments, connection strings, JWTs
- False positive recovery: `scrubbing.allowPatterns` in user config
- NOT scrubbed: SHA-256 hashes, UUIDs, base64 non-secrets, hex strings without labels
- Integration with M2.8's 4-point pipeline (same scrub function, extended patterns)

## Dependencies

- M2.8 secrets scrubbing foundation — `src/permissions/secret-scrubber.ts` (SecretScrubber, 8 baseline patterns, 4 integration points)
- M2.5 configuration — `src/core/config.ts` (ResolvedConfig for `scrubbing.allowPatterns`)

## File Locations

- Secret scrubber: `src/permissions/secret-scrubber.ts`
- Config types: `src/types/config.ts`
- Existing tests: `test/permissions/secret-scrubber.test.ts`
