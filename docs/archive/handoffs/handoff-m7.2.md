# M7.2 Handoff — Sub-Agent Approval Routing

**Date:** 2026-04-04
**Status:** M7.1c complete. Ready for M7.2.

## What's Done (M7.1c)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| `messageAgentSpec` + `createMessageAgentImpl` factory | Complete | 6 |
| `awaitAgentSpec` + `createAwaitAgentImpl` factory | Complete | 11 |
| `AgentPhase` 5-state lifecycle type | Complete | — |
| `ProgressSnapshot` / `AgentResult` / `ApprovalRequest` types | Complete | — |
| DelegationTracker: updatePhase, enqueueMessage, dequeueMessage | Complete | — |
| DelegationTracker: setPendingApproval, clearPendingApproval | Complete | — |
| DelegationTracker: getProgressSnapshot, markCompleted (idempotent) | Complete | — |
| Timer cleanup in await_agent blocking path | Complete | — |
| Phase transition guard (active-only) | Complete | — |
| Message queue cap (MAX=100) | Complete | — |
| **Total** | **M7.1c complete** | **17 new, 1870 total** |

## What to Do Next (M7.2)

From `docs/steps/07b-milestone7-delegation.md`:

- Child returns `approval_required` with toolCall details and lineage
- Parent can: satisfy from own authority, bubble up, or deny
- Root agent prompts user with full lineage chain
- Session grants propagate downward to requesting child's subtree
- Pre-authorized patterns at spawn time (via M7.1b pre-auth transport)

## Dependencies

- M7.1c: `ApprovalRequest` type with resolve callback (`src/types/agent.ts`)
- M7.1c: `DelegationTracker.setPendingApproval/clearPendingApproval` (`src/delegation/spawn-agent.ts`)
- M7.1c: `await_agent` returns `approval_required` when pendingApproval is set
- M7.1b: `TrackedAgent.preAuthorizedPatterns` for pre-auth matching
- M2.6: Approval flow (`src/permissions/approval-flow.ts`) — existing 7-step resolver
- M2.6: Session grants (`src/permissions/session-grants.ts`)
- Block 8 spec: approval routing mechanics in `docs/spec/08-permissions-sandbox.md`

## File Locations

- Approval flow: `src/permissions/approval-flow.ts`
- Session grants: `src/permissions/session-grants.ts`
- Delegation tracker: `src/delegation/spawn-agent.ts` (TrackedAgent, DelegationTracker)
- Agent types: `src/types/agent.ts` (ApprovalRequest)
- Suggested new: `src/delegation/approval-routing.ts` for the routing logic

## Key Design Notes

- `ApprovalRequest.resolve(answer)` delivers the approval answer back to the child's blocked code path
- The routing algorithm is recursive: child → parent → grandparent → root (if each lacks authority)
- Session grants from root should propagate to the requesting child's subtree only (not siblings)
- `[a] always` grants propagate to the entire agent tree
- Pre-authorized patterns (M7.1b) should be checked before bubbling
