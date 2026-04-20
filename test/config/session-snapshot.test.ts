import { describe, it, expect } from 'vitest';
import { CONFIG_DEFAULTS } from '../../src/config/schema.js';
import { detectConfigDrift } from '../../src/config/loader.js';
import {
    buildEffectiveResolvedConfig,
    buildSessionConfigSnapshot,
    hasConfigDriftBaseline,
} from '../../src/config/session-snapshot.js';

describe('session config snapshots', () => {
    it('captures drift-relevant config plus effective model/provider overrides', () => {
        const snapshot = buildSessionConfigSnapshot(CONFIG_DEFAULTS, {
            workspaceRoot: '/repo',
            model: 'openai/gpt-5.1',
            provider: 'openai',
            mode: 'interactive',
            verbose: true,
        });

        expect(hasConfigDriftBaseline(snapshot)).toBe(true);
        expect(snapshot.workspaceRoot).toBe('/repo');
        expect(snapshot.mode).toBe('interactive');
        expect(snapshot.verbose).toBe(true);
        expect((snapshot.model as { default: string | null }).default).toBe('openai/gpt-5.1');
        expect(snapshot.defaultProvider).toBe('openai');
        expect(snapshot.permissions).toEqual(CONFIG_DEFAULTS.permissions);
        expect(snapshot.network).toEqual(CONFIG_DEFAULTS.network);
        expect(snapshot.scrubbing).toEqual(CONFIG_DEFAULTS.scrubbing);
    });

    it('produces a drift baseline detectConfigDrift can compare against', () => {
        const snapshot = buildSessionConfigSnapshot(CONFIG_DEFAULTS, {
            workspaceRoot: '/repo',
            model: 'nanogpt/gemma-4',
            provider: 'nanogpt',
        });

        const current = buildEffectiveResolvedConfig(CONFIG_DEFAULTS, {
            model: 'nanogpt/gemma-4',
            provider: 'nanogpt',
        });
        current.permissions.nonInteractive = true;

        const drifts = detectConfigDrift(current, snapshot);
        expect(drifts.find((drift) => drift.field === 'permissions.nonInteractive')?.securityRelevant).toBe(true);
    });

    it('detects legacy snapshots that cannot support meaningful drift checks', () => {
        expect(hasConfigDriftBaseline({ workspaceRoot: '/repo', model: 'legacy' })).toBe(false);
    });
});
