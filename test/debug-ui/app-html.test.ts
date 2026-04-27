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
});
