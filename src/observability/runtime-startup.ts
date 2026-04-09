import { join } from 'node:path';
import type { SessionId } from '../types/ids.js';
import type { WarnFn, SqliteStore } from './sqlite-store.js';
import type { RetentionConfig, RetentionResult } from './log-retention.js';
import { runRetention } from './log-retention.js';
import { backfillSession } from './backfill.js';

export interface StartupObservabilityMaintenanceOptions {
    sessionsDir: string;
    store: SqliteStore | null;
    retention: RetentionConfig;
    sessionId: SessionId;
    sessionDir: string;
    resumed: boolean;
    warn?: WarnFn;
}

export interface StartupObservabilityMaintenanceResult {
    retention: RetentionResult;
    backfilled: number;
}

export async function runStartupObservabilityMaintenance(
    options: StartupObservabilityMaintenanceOptions,
): Promise<StartupObservabilityMaintenanceResult> {
    const {
        sessionsDir,
        store,
        retention,
        sessionId,
        sessionDir,
        resumed,
        warn = () => {},
    } = options;

    const retentionResult = await runRetention(
        sessionsDir,
        store,
        retention,
        warn,
        { protectedSessionIds: [sessionId] },
    );

    let backfilled = 0;
    if (resumed && store?.isOpen()) {
        backfilled = backfillSession(
            store,
            sessionId,
            join(sessionDir, 'events.jsonl'),
            warn,
        );
    }

    return {
        retention: retentionResult,
        backfilled,
    };
}
