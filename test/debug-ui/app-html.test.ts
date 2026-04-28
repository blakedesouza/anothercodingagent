import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appHtml = readFileSync('scripts/aca-debug-ui-app.html', 'utf-8');
const serverSource = readFileSync('scripts/aca-debug-ui-server.mjs', 'utf-8');

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
});
