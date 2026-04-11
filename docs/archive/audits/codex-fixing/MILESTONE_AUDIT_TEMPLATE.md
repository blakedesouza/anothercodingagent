# Milestone Re-Audit Template

Use this worksheet for each milestone during the second-pass audit.

## Header

- Milestone:
- Step file(s):
- Audit date:
- Auditor:

## 1. Claimed Capabilities

List the capabilities the milestone claims to introduce or complete.

- Capability:
- Capability:
- Capability:

## 2. Blast Radius Map

- Primary files:
- Upstream dependencies:
- Downstream dependents:
- Shared contracts touched:
- Persisted artifacts touched:

## 3. Live Runtime Topology

For each capability, prove the live caller path.

| Capability | Entrypoint(s) | Live caller proven? | Key runtime files | Notes |
|---|---|---|---|---|
|  |  | yes / no |  |  |

## 4. Persistence / Replay / Resume

| Surface | Written by | Read by | Resume / replay path | Verified? | Notes |
|---|---|---|---|---|---|
| manifest |  |  |  | yes / no |  |
| conversation log |  |  |  | yes / no |  |
| turn / step records |  |  |  | yes / no |  |
| summaries |  |  |  | yes / no |  |
| durable state |  |  |  | yes / no |  |
| checkpoints |  |  |  | yes / no |  |
| sqlite / analytics |  |  |  | yes / no |  |
| other |  |  |  | yes / no |  |

## 5. Mode Parity

| Capability | one-shot | repl | invoke | mcp | consult | delegation | Notes |
|---|---|---|---|---|---|---|---|
|  | yes / no / n/a | yes / no / n/a | yes / no / n/a | yes / no / n/a | yes / no / n/a | yes / no / n/a |  |

## 6. Negative / Degraded Paths Checked

- Failure mode:
  - Why it matters:
  - Evidence:
  - Result:

- Failure mode:
  - Why it matters:
  - Evidence:
  - Result:

## 7. Contract Parity Checks

- Producers searched:
- Consumers searched:
- Persistence paths searched:
- Replay / resume paths searched:
- Derived views searched:
- Prompts / examples searched:
- Docs / changelog searched:
- Tests / fixtures searched:

## 8. Dead-Code / Fake-Completion Checks

- Runtime methods with only test callsites:
- Fields never populated by runtime:
- Docs/tests overstating behavior:
- Placeholder / deferred markers in live paths:

## 9. Findings

List findings in severity order with file references.

1. Severity:
   - Summary:
   - Evidence:
   - Blast radius:

2. Severity:
   - Summary:
   - Evidence:
   - Blast radius:

## 10. Fixes Applied

- Files changed:
- Runtime callers updated:
- Persistence / replay updated:
- Parity surfaces updated:
- Tests added or updated:

## 11. Validation

- Commands run:
- Results:
- What was not validated:

## 12. Live Validation

- Scenario ID:
  - Goal:
  - Command shape:
  - Workspace / HOME isolation:
  - Expected result:
  - Actual result:
  - Evidence:
  - Status:

- Scenario ID:
  - Goal:
  - Command shape:
  - Workspace / HOME isolation:
  - Expected result:
  - Actual result:
  - Evidence:
  - Status:

## 13. Residual Risk

- Remaining open point:
- Why it remains:
- Whether it blocks milestone closure:

## 14. Closure Decision

- Status: `pending` / `in_progress` / `blocked` / `done`
- Reason:
- Next milestone or next blocker:
