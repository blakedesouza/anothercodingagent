# Debug UI Activity Scope Design

## Goal

Make the ACA debug UI feel like an ACA work console, not a raw dump of every local session and consult artifact. The default experience should show current, relevant work first while keeping full historical data available when deliberately requested.

## User Problem

The current sidebar exposes too many raw sessions and consults. Many rows are old, from unrelated workspaces, zero-turn runs, stale active records, or historical diagnostics that are not useful for the current ACA debugging task. Raw IDs dominate the UI, so the user has to mentally filter noise before they can inspect real CLI or consult behavior.

## Chosen Direction

Use the recommended hybrid direction:

- Primary default: a workspace-focused inbox.
- Secondary addition: a unified "Relevant Activity" view that can mix sessions and consults when they belong to the same debugging story.

This keeps the current detailed session/consult inspectors, but changes the navigation model so the first screen is curated.

## Non-Goals

- Do not delete sessions, consult artifacts, or observability rows.
- Do not migrate the database.
- Do not hide errors permanently.
- Do not build a new app framework.
- Do not make consult/session detail rendering a large refactor in this pass.

## Information Architecture

### Default View: Relevant Activity

The sidebar default becomes `Relevant Activity`, a curated list built from both sessions and consults.

Rows are included when any of these are true:

- latest session
- latest consult
- active session with recent activity
- running consult
- session or consult with errors/degraded status in the last 24 hours
- session in the current workspace group with at least one turn in the last 7 days
- user-pinned row

Rows are excluded from the default when all of these are true:

- no errors
- no current activity
- zero turns or no useful artifacts
- stale active status with no recent event activity
- not in the current workspace group
- older than the relevance window

Excluded rows remain visible in archive/raw views.

### Workspace Grouping

The UI should group sessions by normalized workspace identity. A workspace group should prefer:

1. `session.workspaceRoot` from manifest/config snapshot.
2. `session.workspaceId` if no root exists.
3. `unknown workspace` if neither exists.

The default group is chosen from the newest useful session. Users can switch groups through a compact scope control:

- Current workspace
- Other workspaces
- All workspaces

If the newest useful session has a broad root such as a user home directory, the UI should still make the scope visible instead of pretending it knows a narrower project.

### Archive

Archive is a deliberate mode, not the default.

Archive shows:

- all sessions
- all consults
- zero-turn runs
- stale active records
- old healthy runs
- old unrelated workspaces

Archive keeps existing filters such as all, active, ended, errors, complete, degraded, and pending.

## Sidebar Row Design

Relevant rows should lead with human meaning before raw IDs.

Session row primary label:

```text
CLI session - assistant_final
```

Consult row primary label:

```text
Consult run - complete
```

Issue row primary label:

```text
llm.malformed - historical
```

Raw IDs remain visible as secondary mono text:

```text
ses_01KQ8... - <home> - 7:24 PM
```

Each row should show:

- kind: session, consult, or issue
- status: healthy, active, degraded, error, archived
- timestamp: latest activity
- workspace/scope
- concise reason it is visible, such as `latest`, `current workspace`, `recent error`, or `running`

## Filters And Controls

Top-level sidebar mode:

- Relevant
- Sessions
- Consults
- Archive

Relevant mode chips:

- Current
- Needs attention
- Recent useful
- Pinned

Archive mode chips:

- All
- Sessions
- Consults
- Errors
- Zero-turn
- Stale active

The search box applies inside the selected mode. Search should match raw IDs, workspace, status, model, error code, and consult witness names.

## Data Model

Add a small derived row shape in the client or server:

```ts
type DebugActivityRow = {
  id: string;
  kind: 'session' | 'consult' | 'issue';
  title: string;
  subtitle: string;
  status: 'healthy' | 'active' | 'degraded' | 'error' | 'archived';
  workspaceKey: string;
  startedAt: string | null;
  lastActivityAt: string | null;
  visibleReason: string;
  sourceId: string;
};
```

The row can be derived from existing `/api/sessions`, `/api/consults`, and `/api/overview` responses. No persisted schema change is needed.

## Relevance Rules

Use deterministic helpers so tests can pin behavior:

```js
function isZeroTurnSession(session) {
  return Number(session.turnCount || 0) === 0;
}

function isStaleActiveSession(session, nowMs) {
  if (session.status !== 'active') return false;
  const last = Date.parse(session.lastActivityAt || session.startedAt || '');
  return Number.isFinite(last) && nowMs - last > 30 * 60 * 1000;
}

function isRelevantSession(session, context) {
  if (session.sessionId === context.latestSessionId) return true;
  if (session.hasErrors && context.ageMs(session.lastActivityAt) <= 24 * 60 * 60 * 1000) return true;
  if (session.status === 'active' && !isStaleActiveSession(session, context.nowMs)) return true;
  if (session.workspaceKey === context.currentWorkspaceKey && Number(session.turnCount || 0) > 0 && context.ageMs(session.lastActivityAt) <= 7 * 24 * 60 * 60 * 1000) return true;
  return context.pinnedIds.has(session.sessionId);
}
```

Consult relevance should mirror this:

- latest consult
- running consult
- degraded consult
- completed consult updated in the current relevance window
- pinned consult

## Detail Pane Behavior

Selecting a relevant row opens the existing detail pane:

- session rows use current session detail rendering
- consult rows use current consult detail rendering
- issue rows open the source session and scroll/focus the error section if possible

When the user switches from Relevant to raw Sessions or Consults, the current selection should remain if that row is still visible. Otherwise, select the first visible row.

## Error Handling

If relevance derivation fails, fall back to raw sessions and show a small banner:

```text
Relevant activity unavailable. Showing raw sessions.
```

If there are no relevant rows:

```text
No relevant ACA activity in the current scope.
```

The archive link should still be visible from the empty state.

## Testing

Add focused static and helper tests:

- zero-turn sessions are excluded from Relevant by default
- stale active sessions are excluded from Relevant by default
- latest session is always included
- recent errors are included even when historical
- current workspace sessions with turns are included
- unrelated old healthy sessions move to Archive
- consults can appear in Relevant Activity
- raw IDs are secondary text, not primary title
- Archive still exposes all rows

Keep full verification as:

```bash
npx vitest run test/debug-ui/app-html.test.ts test/debug-ui/manager.test.ts --reporter=dot
npm run typecheck
npm run verify
```

## Open Implementation Choice

The implementation plan should decide whether relevance derivation lives entirely in `scripts/aca-debug-ui-app.html` or partly in `scripts/aca-debug-ui-server.mjs`.

Recommendation: start client-side because the current app already receives all required session and consult summaries. Add server fields only if a row needs data that is expensive or awkward to derive in the browser.

## Self-Review

- No placeholders.
- Scope is one coherent UI navigation improvement.
- No persisted data changes.
- Existing raw inspection paths remain available.
- Design covers both sessions and consults without forcing a full detail-pane rewrite.
