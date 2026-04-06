# M7.10 Handoff — Network Egress Integration

**Date:** 2026-04-03
**Status:** M7.7c complete. Ready for M7.10.

## What's Done (M7.7c)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| capabilityId on ToolSpec | Complete | 3 |
| getMaskedToolNames on CapabilityHealthMap | Complete | 3 |
| TurnEngine health-based tool masking | Complete | 1 |
| Masked tool detection with capped alternatives | Complete | 3 |
| wrapDelegationError helper | Complete | 3 |
| **Total** | **M7.7c complete** | **13 new, 1614 total** |

## What to Do Next (M7.10)

From `docs/steps/07a-milestone7-error-health.md`:

- Integrate network policy into Playwright/browser tool calls (domain check before navigation)
- Integrate network policy into `fetch_url` tier selection (HTTP vs Playwright fallback)
- Localhost exception refinement: auto-allowed for `fetch_url`/`web_search` but NOT for `exec_command` shell detection
- Shell command network detection: extend M2.7's basic detection with `ssh`, `scp`, `rsync`, `docker pull`, `pip install`, `cargo install`
- Network events: `network.checked` event with domain, mode, decision

## Dependencies

- M2.7 network policy foundation — `src/permissions/network-policy.ts` (NetworkPolicy, evaluatePolicy, domain glob matching)
- M2.3 command risk analyzer — `src/tools/command-risk-analyzer.ts` (analyzeCommand, shell detection patterns)
- Event system — `src/core/events.ts` (for network.checked event)
- Playwright/browser tools — not yet implemented, may need stubs or the tool definitions

## File Locations

- Network policy: `src/permissions/network-policy.ts`
- Command risk analyzer: `src/tools/command-risk-analyzer.ts`
- Event types: `src/types/events.ts` and `src/core/events.ts`
- Tests: `test/permissions/network-policy.test.ts` (extend), new integration tests
