import type { ResolvedConfig } from './schema.js';

export interface SessionSnapshotOptions {
    workspaceRoot: string;
    model: string | null;
    provider: string;
    mode?: string;
    sessionTag?: string;
    verbose?: boolean;
}

export type SessionConfigSnapshot = ResolvedConfig & Record<string, unknown> & {
    workspaceRoot: string;
    mode?: string;
    sessionTag?: string;
    verbose?: boolean;
};

const DRIFT_BASELINE_KEYS = [
    'model',
    'defaultProvider',
    'permissions',
    'sandbox',
    'network',
    'scrubbing',
] as const;

export function buildEffectiveResolvedConfig(
    config: ResolvedConfig,
    options: Pick<SessionSnapshotOptions, 'model' | 'provider'>,
): ResolvedConfig {
    const next = structuredClone(config);
    next.model.default = options.model;
    next.defaultProvider = options.provider;
    return next;
}

export function buildSessionConfigSnapshot(
    config: ResolvedConfig,
    options: SessionSnapshotOptions,
): SessionConfigSnapshot {
    const effective = buildEffectiveResolvedConfig(config, options);
    return {
        ...effective,
        workspaceRoot: options.workspaceRoot,
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        ...(options.sessionTag !== undefined ? { sessionTag: options.sessionTag } : {}),
        ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
    };
}

export function hasConfigDriftBaseline(snapshot: Record<string, unknown>): boolean {
    return DRIFT_BASELINE_KEYS.some((key) => {
        if (!(key in snapshot)) return false;
        const value = snapshot[key];
        if (key === 'defaultProvider') {
            return typeof value === 'string' && value.length > 0;
        }
        return typeof value === 'object' && value !== null;
    });
}
