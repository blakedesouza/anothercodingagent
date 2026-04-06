# M2.8 Handoff — Secrets Scrubbing Pipeline

**Date:** 2026-03-30
**Status:** M2.7 complete. Ready for M2.8.

## What's Done (M2.7)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| NetworkPolicy type + 3 modes (off/approved-only/open) | Complete | 8 |
| Domain glob matching (allowDomains/denyDomains) | Complete | 5 |
| denyDomains precedence over allowDomains | Complete | 2 |
| Localhost exception (127.0.0.0/8, ::1, ::ffff:7fxx:xxxx) | Complete | 6 |
| HTTPS-only default + protocol whitelist (http/https only) | Complete | 5 |
| Shell command detection (curl, wget, ssh, git clone, npm install) | Complete | 9 |
| ToolRunner integration (deny enforcement) | Complete | 3 |
| Consultation fixes (protocol whitelist, localhost range, SSH ReDoS, TODO) | Complete | 5 |
| SSH tokenizer (ReDoS-safe, handles flags with args) | Complete | 3 |
| Localhost exception NOT applied to shell detection | Complete | 2 |
| Non-network commands return null | Complete | 2 |

**Total tests: 547 passing** (497 prior + 50 new).

**Consultation:** 4/4 witnesses, 4 fixes applied.

## What to Do Next (M2.8)

Implement the Secrets Scrubbing Pipeline — 4-point scrubbing with two detection strategies. Depends on M2.5 (config) for `scrubbing.enabled` and secrets loading.

### What to Build

- `SecretPattern` interface: name, pattern (RegExp), type (redaction label), contextRequired
- `SecretScrubber` class: maintains known secret values + pattern registry
- Strategy 1: exact-value redaction for known API keys/secrets
- Strategy 2 (baseline): API key prefixes (`sk-`, `pk_test_`, `AKIA`, `ghp_`, `ghs_`, `glpat-`), Bearer tokens, PEM private keys
- Redaction format: `<redacted:type:N>` with per-session counter
- 4 pipeline integration points: tool output, LLM context, persistence, terminal
- Composable `scrub(text: string) → string` function
- Known secrets loaded from resolved secrets at startup
- `scrubbing.enabled: false` → no-op passthrough

### Key Test Cases

- Known API key → redacted with stable ID
- Same key twice → same redaction ID
- Disabled → passthrough
- 4 pipeline points: inject secret → verify redacted at each
- Strategy 2: sk-*, Bearer, PEM, ghp_*, glpat-*, AKIA* detected
- False positive guard: `skeleton` not redacted by sk- pattern

## Dependencies

- `src/config/schema.ts` — `ResolvedConfig.scrubbing` (enabled, allowPatterns)
- `src/config/secrets.ts` — loaded secret values (if exists)

## File Locations

| File | Purpose |
|------|---------|
| `src/permissions/secret-scrubber.ts` | SecretPattern, SecretScrubber class, scrub pipeline |
| `test/permissions/secret-scrubber.test.ts` | All scrubbing test cases |
