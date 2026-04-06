/**
 * LSP Manager — routes queries to correct language server, manages lifecycle.
 *
 * Responsibilities:
 * - File-extension routing: .ts → typescript server, .py → pyright, etc.
 * - Lazy start: server only starts on first query for that language
 * - Session-scoped lifetime: servers live until dispose() is called
 * - Crash restart: one restart allowed per server, second crash → session-terminal
 * - Health integration: reports to CapabilityHealthMap (M7.13)
 *
 * Keyed by (workspaceRoot, serverId) — multiple servers may run simultaneously
 * for projects using multiple languages.
 */

import { extname } from 'node:path';
import type { spawn as SpawnFn } from 'node:child_process';
import {
    LspClient,
    LspUnavailableError,
    LspWarmingUpError,
    LspCrashedError,
    RESTART_BACKOFF_MS,
    type LspQueryParams,
    type LspResult,
    type LspOperation,
} from './lsp-client.js';
import {
    getServerForExtension,
    lspCapabilityId,
    type LspServerConfig,
} from './server-registry.js';
import type { CapabilityHealthMap } from '../core/capability-health.js';

// --- Types ---

export interface LspManagerDeps {
    workspaceRoot: string;
    healthMap?: CapabilityHealthMap;
    /** Override spawn for testing. */
    spawnFn?: typeof SpawnFn;
}

// --- Manager class ---

export class LspManager {
    private readonly clients = new Map<string, LspClient>();
    private readonly workspaceRoot: string;
    private readonly healthMap?: CapabilityHealthMap;
    private readonly spawnFn?: typeof SpawnFn;

    constructor(deps: LspManagerDeps) {
        this.workspaceRoot = deps.workspaceRoot;
        this.healthMap = deps.healthMap;
        this.spawnFn = deps.spawnFn;
    }

    /**
     * Execute an LSP query. Routes to the correct server based on file extension.
     *
     * On first query for a language, the server is lazily started.
     * On crash, one restart is attempted with 1s backoff.
     * On second crash, the server is marked unavailable for the session.
     */
    async query(params: LspQueryParams): Promise<LspResult> {
        // Determine which server handles this file
        const ext = extname(params.file).slice(1).toLowerCase();
        const config = getServerForExtension(ext);

        if (!config) {
            throw new LspUnavailableError(
                ext,
                `No LSP server registered for .${ext} files`,
            );
        }

        const capId = lspCapabilityId(config.serverId);
        const client = await this.getOrCreateClient(config);

        try {
            // Ensure started
            if (client.state !== 'ready') {
                await client.start();
            }

            const result = await client.query(params);

            // Report success to health map
            this.healthMap?.reportSuccess(capId);

            return result;
        } catch (err) {
            if (err instanceof LspUnavailableError) {
                this.healthMap?.reportNonRetryableFailure(capId, err.message);
                throw err;
            }

            if (err instanceof LspWarmingUpError) {
                // Don't mark as failure — server is still starting
                throw err;
            }

            // Server crashed or connection error — attempt restart
            const canRestart = client.handleCrash();

            if (canRestart) {
                this.healthMap?.reportRetryableFailure(capId, 'crash — restarting');

                // Wait for backoff, then restart and retry
                await sleep(RESTART_BACKOFF_MS);

                try {
                    await client.start();
                    const result = await client.query(params);
                    this.healthMap?.reportSuccess(capId);
                    return result;
                } catch (retryErr) {
                    // Second failure during restart — permanently unavailable for this session
                    client.handleCrash();
                    this.healthMap?.reportNonRetryableFailure(capId, 'crash on restart — unavailable');
                    throw new LspCrashedError(config.serverId, false);
                }
            } else {
                // Already crashed once before — mark unavailable
                this.healthMap?.reportRetryableFailure(capId, 'second crash — unavailable');
                throw new LspCrashedError(config.serverId, false);
            }
        }
    }

    /** Get a list of currently active server IDs. */
    getActiveServers(): string[] {
        return Array.from(this.clients.entries())
            .filter(([_, client]) => client.state === 'ready')
            .map(([id]) => id);
    }

    /** Dispose all servers. Called on session end. */
    async dispose(): Promise<void> {
        const disposePromises = Array.from(this.clients.values()).map(c => c.dispose());
        await Promise.all(disposePromises);
        this.clients.clear();
    }

    // --- Private ---

    private async getOrCreateClient(config: LspServerConfig): Promise<LspClient> {
        const key = config.serverId;
        let client = this.clients.get(key);
        if (!client) {
            client = new LspClient(config, this.workspaceRoot, this.spawnFn);
            this.clients.set(key, client);

            // Register capability for health tracking
            this.healthMap?.register(lspCapabilityId(config.serverId), 'local');
        }
        return client;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
