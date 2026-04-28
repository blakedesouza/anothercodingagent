import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appHtml = readFileSync('scripts/aca-debug-ui-app.html', 'utf-8');
const serverSource = readFileSync('scripts/aca-debug-ui-server.mjs', 'utf-8');

function extractAppScript(): string {
    const match = appHtml.match(/<script>([\s\S]*)<\/script>/);
    if (!match) throw new Error('debug UI inline script not found');
    return match[1];
}

function loadAppHelpers() {
    const script = extractAppScript();
    const localStorage = {
        getItem: () => null,
        setItem: () => undefined,
    };
    const document = {
        querySelector: () => null,
        querySelectorAll: () => [],
        documentElement: { dataset: {}, style: { setProperty: () => undefined } },
    };
    const window = {
        __ACA_DEBUG_UI_TEST__: true,
        matchMedia: () => ({ matches: false }),
    };
    return new Function(
        'window',
        'document',
        'localStorage',
        'location',
        `${script}
return {
  workspaceKeyForSession,
  newestUsefulWorkspaceKey,
  isZeroTurnSession,
  isStaleActiveSession,
  buildActivityRows,
  filterActivityRows,
  rowMatchesSearch,
  classificationLabel,
  diagnosticBadgeClass,
  renderContractPanel,
};`,
    )(window, document, localStorage, new URL('http://127.0.0.1:4777/?token=test'));
}

const NOW_MS = Date.parse('2026-04-27T20:00:00.000Z');

describe('ACA debug UI static contracts', () => {
    it('keeps session detail beside the list on tablet-width dashboards', () => {
        expect(appHtml).toContain('.workbench {');
        expect(appHtml).toContain('grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);');
        expect(appHtml).not.toContain('@media (max-width: 1100px) {\n    .kpi-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n    .workbench { grid-template-columns: 1fr; }');
        expect(appHtml).not.toMatch(/letter-spacing:\s*-/);
    });

    it('uses explicit dashboard loading and API error states', () => {
        expect(appHtml).toContain('isLoading: true');
        expect(appHtml).toContain('loadError: null');
        expect(appHtml).toContain('function renderLoadingState()');
        expect(appHtml).toContain('function renderErrorState(error)');
    });

    it('defaults consult history to all runs so completed failures are visible', () => {
        expect(appHtml).toContain("consultFilter: 'all'");
    });

    it('renders session errors with nearby event context', () => {
        expect(appHtml).toContain('function renderSessionErrors(errors, events, session)');
        expect(appHtml).toContain('function relatedDiagnosticEvents(events, error)');
        expect(appHtml).toContain('Diagnostic context');
    });

    it('offers a local token recovery form on auth failure', () => {
        expect(serverSource).toContain('id="tokenForm"');
        expect(serverSource).toContain('name="token"');
        expect(serverSource).toContain('Open dashboard');
    });

    it('normalizes session model display instead of exposing raw config objects', () => {
        expect(serverSource).toContain('function modelDisplayName(modelConfig)');
        expect(serverSource).toContain('modelDisplayName(manifest?.configSnapshot?.model)');
        expect(serverSource).toContain('modelConfig: manifest?.configSnapshot?.model || null');
        expect(appHtml).toContain('function formatModelName(value)');
        expect(appHtml).not.toContain("summaryRow('Model', sessionInfo.model || 'unknown')");
    });

    it('auto-refresh follows the newest session until the user pins a session', () => {
        expect(appHtml).toContain('autoFollowLatestSession: true');
        expect(appHtml).toContain('userPinnedSessionId: null');
        expect(appHtml).toContain('function syncSelectedSession()');
        expect(appHtml).toContain('state.autoFollowLatestSession = false');
        expect(appHtml).toContain('state.userPinnedSessionId = row.dataset.id');
    });

    it('labels selected historical errors separately from current latest health', () => {
        expect(serverSource).toContain('latestErrorAt');
        expect(serverSource).toContain('latestOutcome');
        expect(appHtml).toContain('function renderSessionFreshnessBanner(session)');
        expect(appHtml).toContain('Historical error');
        expect(appHtml).toContain('Latest session is healthy');
        expect(appHtml).toContain("last 24h · historical");
    });

    it('separates session age from last turn duration in quick stats', () => {
        expect(appHtml).toContain("quickStat('Session Age'");
        expect(appHtml).toContain("quickStat('Last Turn'");
        expect(appHtml).not.toContain("quickStat('Duration', durationBetween(session.startedAt, session.endedAt))");
    });

    it('derives relevant session rows without zero-turn or stale-active noise', () => {
        const helpers = loadAppHelpers();
        const sessions = [
            {
                sessionId: 'ses_latest',
                status: 'ended',
                turnCount: 0,
                startedAt: '2026-04-27T19:58:00.000Z',
                lastActivityAt: '2026-04-27T19:59:00.000Z',
                workspaceRoot: '/home/blake/projects/anothercodingagent',
                latestOutcome: 'assistant_final',
                hasErrors: false,
            },
            {
                sessionId: 'ses_current_useful',
                status: 'ended',
                turnCount: 2,
                startedAt: '2026-04-27T18:00:00.000Z',
                lastActivityAt: '2026-04-27T18:15:00.000Z',
                workspaceRoot: '/home/blake/projects/anothercodingagent',
                latestOutcome: 'assistant_final',
                hasErrors: false,
            },
            {
                sessionId: 'ses_zero_turn',
                status: 'ended',
                turnCount: 0,
                startedAt: '2026-04-27T17:00:00.000Z',
                lastActivityAt: '2026-04-27T17:00:00.000Z',
                workspaceRoot: '/home/blake/projects/anothercodingagent',
                hasErrors: false,
            },
            {
                sessionId: 'ses_stale_active',
                status: 'active',
                turnCount: 0,
                startedAt: '2026-04-27T16:00:00.000Z',
                lastActivityAt: '2026-04-27T16:10:00.000Z',
                workspaceRoot: '/home/blake/projects/other',
                hasErrors: false,
            },
        ];

        const rows = helpers.buildActivityRows({
            sessions,
            consults: [],
            nowMs: NOW_MS,
            scope: 'current',
            filter: 'current',
            pinnedIds: new Set(),
        });

        expect(rows.map((row: { sourceId: string }) => row.sourceId)).toEqual(['ses_latest', 'ses_current_useful']);
        expect(rows[0]).toMatchObject({
            kind: 'session',
            title: 'CLI session - assistant_final',
            visibleReason: 'latest',
            workspaceKey: '/home/blake/projects/anothercodingagent',
        });
    });

    it('does not label the latest healthy stale-active session as archived in Relevant', () => {
        const helpers = loadAppHelpers();
        const rows = helpers.buildActivityRows({
            sessions: [
                {
                    sessionId: 'ses_latest',
                    status: 'active',
                    turnCount: 1,
                    startedAt: '2026-04-27T16:00:00.000Z',
                    lastActivityAt: '2026-04-27T16:10:00.000Z',
                    workspaceRoot: '/home/blake/projects/anothercodingagent',
                    latestOutcome: 'assistant_final',
                    hasErrors: false,
                },
            ],
            consults: [],
            nowMs: NOW_MS,
            scope: 'current',
            filter: 'current',
            pinnedIds: new Set(),
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ sourceId: 'ses_latest', visibleReason: 'latest', status: 'healthy' });
    });

    it('keeps recent historical errors and relevant consults in activity rows', () => {
        const helpers = loadAppHelpers();
        const rows = helpers.buildActivityRows({
            sessions: [
                {
                    sessionId: 'ses_error',
                    status: 'ended',
                    turnCount: 1,
                    startedAt: '2026-04-27T12:00:00.000Z',
                    lastActivityAt: '2026-04-27T12:05:00.000Z',
                    latestErrorAt: '2026-04-27T12:05:00.000Z',
                    latestErrorCode: 'llm.malformed',
                    workspaceRoot: '/home/blake/projects/anothercodingagent',
                    hasErrors: true,
                },
            ],
            consults: [
                {
                    suffix: '1777345046-1',
                    status: 'degraded',
                    startedAt: '2026-04-27T13:00:00.000Z',
                    updatedAt: '2026-04-27T13:05:00.000Z',
                    totalWitnesses: 3,
                    successCount: 2,
                },
            ],
            nowMs: NOW_MS,
            scope: 'all',
            filter: 'attention',
            pinnedIds: new Set(),
        });

        expect(rows.map((row: { title: string }) => row.title)).toEqual([
            'Consult run - degraded',
            'Malformed - unclassified - historical',
        ]);
        expect(rows.every((row: { status: string }) => row.status === 'degraded' || row.status === 'error')).toBe(true);
    });

    it('keeps completed consult bulk out of the default Relevant filter', () => {
        const helpers = loadAppHelpers();
        const rows = helpers.buildActivityRows({
            sessions: [],
            consults: [
                {
                    suffix: '1777345046-2',
                    status: 'complete',
                    startedAt: '2026-04-27T13:10:00.000Z',
                    updatedAt: '2026-04-27T13:15:00.000Z',
                    totalWitnesses: 3,
                    successCount: 3,
                },
                {
                    suffix: '1777345046-1',
                    status: 'complete',
                    startedAt: '2026-04-27T13:00:00.000Z',
                    updatedAt: '2026-04-27T13:05:00.000Z',
                    totalWitnesses: 3,
                    successCount: 3,
                },
            ],
            nowMs: NOW_MS,
            scope: 'current',
            filter: 'current',
            pinnedIds: new Set(),
        });

        expect(rows.map((row: { sourceId: string }) => row.sourceId)).toEqual(['1777345046-2']);
        expect(rows[0]).toMatchObject({ title: 'Consult run - complete', visibleReason: 'latest' });

        const recentRows = helpers.buildActivityRows({
            sessions: [],
            consults: [
                {
                    suffix: '1777345046-2',
                    status: 'complete',
                    startedAt: '2026-04-27T13:10:00.000Z',
                    updatedAt: '2026-04-27T13:15:00.000Z',
                    totalWitnesses: 3,
                    successCount: 3,
                },
                {
                    suffix: '1777345046-1',
                    status: 'complete',
                    startedAt: '2026-04-27T13:00:00.000Z',
                    updatedAt: '2026-04-27T13:05:00.000Z',
                    totalWitnesses: 3,
                    successCount: 3,
                },
            ],
            nowMs: NOW_MS,
            scope: 'current',
            filter: 'recent',
            pinnedIds: new Set(),
        });

        expect(recentRows.map((row: { sourceId: string }) => row.sourceId)).toEqual(['1777345046-2', '1777345046-1']);
    });

    it('keeps non-latest degraded consults behind the Needs attention filter', () => {
        const helpers = loadAppHelpers();
        const consults = [
            {
                suffix: '1777345046-3',
                status: 'complete',
                startedAt: '2026-04-27T13:20:00.000Z',
                updatedAt: '2026-04-27T13:25:00.000Z',
                totalWitnesses: 3,
                successCount: 3,
            },
            {
                suffix: '1777345046-2',
                status: 'degraded',
                startedAt: '2026-04-27T13:10:00.000Z',
                updatedAt: '2026-04-27T13:15:00.000Z',
                totalWitnesses: 3,
                successCount: 2,
            },
            {
                suffix: '1777345046-1',
                status: 'degraded',
                startedAt: '2026-04-27T13:00:00.000Z',
                updatedAt: '2026-04-27T13:05:00.000Z',
                totalWitnesses: 3,
                successCount: 2,
            },
        ];
        const currentRows = helpers.buildActivityRows({
            sessions: [],
            consults,
            nowMs: NOW_MS,
            scope: 'current',
            filter: 'current',
            pinnedIds: new Set(),
        });

        expect(currentRows.map((row: { sourceId: string }) => row.sourceId)).toEqual(['1777345046-3']);

        const attentionRows = helpers.buildActivityRows({
            sessions: [],
            consults,
            nowMs: NOW_MS,
            scope: 'current',
            filter: 'attention',
            pinnedIds: new Set(),
        });

        expect(attentionRows.map((row: { sourceId: string }) => row.sourceId)).toEqual(['1777345046-2', '1777345046-1']);
    });

    it('archive mode exposes zero-turn, stale-active, and old unrelated rows', () => {
        const helpers = loadAppHelpers();
        const rows = helpers.buildActivityRows({
            sessions: [
                {
                    sessionId: 'ses_zero_turn',
                    status: 'ended',
                    turnCount: 0,
                    startedAt: '2026-04-20T12:00:00.000Z',
                    lastActivityAt: '2026-04-20T12:00:00.000Z',
                    workspaceRoot: '/tmp/unrelated',
                    hasErrors: false,
                },
                {
                    sessionId: 'ses_stale_active',
                    status: 'active',
                    turnCount: 0,
                    startedAt: '2026-04-27T10:00:00.000Z',
                    lastActivityAt: '2026-04-27T10:10:00.000Z',
                    workspaceRoot: '/tmp/unrelated',
                    hasErrors: false,
                },
            ],
            consults: [],
            nowMs: NOW_MS,
            scope: 'all',
            filter: 'archive:all',
            pinnedIds: new Set(),
        });

        expect(rows.map((row: { visibleReason: string }) => row.visibleReason)).toEqual(['stale active', 'zero-turn']);
        expect(rows.every((row: { status: string }) => row.status === 'archived')).toBe(true);
    });

    it('search matches IDs, workspace, status, model, errors, and witness names', () => {
        const helpers = loadAppHelpers();
        const row = {
            id: 'consult:1777345046-1',
            sourceId: '1777345046-1',
            title: 'Consult run - degraded',
            subtitle: '1777345046-1 - /home/blake/projects/anothercodingagent - 1:05 PM',
            status: 'degraded',
            workspaceKey: '/home/blake/projects/anothercodingagent',
            model: 'zai-org/glm-5.1',
            errorCode: 'llm.malformed',
            witnessNames: ['claude', 'gpt'],
        };

        expect(helpers.rowMatchesSearch(row, 'glm-5.1')).toBe(true);
        expect(helpers.rowMatchesSearch(row, 'llm.malformed')).toBe(true);
        expect(helpers.rowMatchesSearch(row, 'claude')).toBe(true);
        expect(helpers.rowMatchesSearch(row, 'not-present')).toBe(false);
    });

    it('labels universal malformed classifications without exposing raw llm.malformed alone', () => {
        const helpers = loadAppHelpers();
        expect(helpers.classificationLabel({
            classification: 'provider_model_nonconformance',
            diagnosticBucket: 'provider_empty_final',
            errorCode: 'llm.malformed',
        })).toBe('Provider/model nonconformance');
        expect(helpers.classificationLabel({
            classification: 'salvaged_success',
            diagnosticBucket: 'post_mutation_empty_final',
            errorCode: 'llm.malformed',
        })).toBe('Salvaged success');
    });

    it('renders contract panel rows from diagnostics', () => {
        const helpers = loadAppHelpers();
        const html = helpers.renderContractPanel({
            classification: 'provider_model_nonconformance',
            diagnosticBucket: 'provider_empty_final',
            salvageCandidate: true,
            salvaged: false,
            completionEvidence: {
                changedFiles: ['src/runtime.js'],
                testsPassed: false,
                changedTests: false,
                requiredOutputsSatisfied: false,
                filesystemMutations: 1,
            },
        });
        expect(html).toContain('Provider/model nonconformance');
        expect(html).toContain('provider_empty_final');
        expect(html).toContain('src/runtime.js');
        expect(helpers.diagnosticBadgeClass({ classification: 'salvaged_success' })).toBe('ok');
    });

    it('adds Relevant, Sessions, Consults, and Archive navigation with scope controls', () => {
        expect(appHtml).toContain('data-view="relevant"');
        expect(appHtml).toContain('Relevant');
        expect(appHtml).toContain('data-view="sessions"');
        expect(appHtml).toContain('data-view="consult"');
        expect(appHtml).toContain('data-view="archive"');
        expect(appHtml).toContain('id="scopeChips"');
        expect(appHtml).toContain("activityFilter: 'current'");
        expect(appHtml).toContain("archiveFilter: 'all'");
        expect(appHtml).toContain("scopeFilter: 'current'");
    });

    it('renders meaningful activity row titles before raw IDs', () => {
        expect(appHtml).toContain('function renderActivityRow(row)');
        expect(appHtml).toContain('class="sr-title"');
        expect(appHtml).toContain('class="sr-sub"');
        expect(appHtml).toContain('CLI session -');
        expect(appHtml).toContain('Consult run -');
        expect(appHtml).toContain(' - historical');
    });

    it('keeps raw session and consult sidebars available outside Relevant Activity', () => {
        expect(appHtml).toContain('function renderSessionSidebar()');
        expect(appHtml).toContain('function renderConsultSidebar()');
        expect(appHtml).toContain('function renderActivitySidebar(archiveMode)');
        expect(appHtml).toContain('Archive has no rows for the selected filters.');
        expect(appHtml).toContain('No relevant ACA activity in the current scope.');
    });
});
