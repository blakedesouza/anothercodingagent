import { describe, it, expect, vi } from 'vitest';
import {
    ensureSemanticIndexReadyForTool,
    ensureSemanticIndexReadyForTurnRefresh,
} from '../../src/indexing/runtime-semantic.js';

describe('ensureSemanticIndexReadyForTool', () => {
    it('builds the index synchronously for small workspaces', async () => {
        const buildIndex = vi.fn(async () => ({
            filesIndexed: 1,
            filesSkipped: 0,
            chunksCreated: 1,
            symbolsExtracted: 0,
            embeddingFailures: 0,
            warnings: [],
        }));
        const buildIndexBackground = vi.fn(async () => ({
            filesIndexed: 0,
            filesSkipped: 0,
            chunksCreated: 0,
            symbolsExtracted: 0,
            embeddingFailures: 0,
            warnings: [],
        }));
        const indexer = {
            ready: false,
            indexing: false,
            estimateFileCount: vi.fn(() => 10),
            buildIndex,
            buildIndexBackground,
        };

        const status = await ensureSemanticIndexReadyForTool(indexer as never, 500);

        expect(status).toBe('built');
        expect(buildIndex).toHaveBeenCalledTimes(1);
        expect(buildIndexBackground).not.toHaveBeenCalled();
    });

    it('schedules background indexing for large workspaces', async () => {
        const buildIndex = vi.fn(async () => ({
            filesIndexed: 0,
            filesSkipped: 0,
            chunksCreated: 0,
            symbolsExtracted: 0,
            embeddingFailures: 0,
            warnings: [],
        }));
        const buildIndexBackground = vi.fn(async () => ({
            filesIndexed: 600,
            filesSkipped: 0,
            chunksCreated: 1200,
            symbolsExtracted: 0,
            embeddingFailures: 0,
            warnings: [],
        }));
        const indexer = {
            ready: false,
            indexing: false,
            estimateFileCount: vi.fn(() => 600),
            buildIndex,
            buildIndexBackground,
        };

        const status = await ensureSemanticIndexReadyForTool(indexer as never, 500);

        expect(status).toBe('scheduled');
        expect(buildIndex).not.toHaveBeenCalled();
        expect(buildIndexBackground).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the index is already ready', async () => {
        const buildIndex = vi.fn();
        const buildIndexBackground = vi.fn();
        const indexer = {
            ready: true,
            indexing: false,
            estimateFileCount: vi.fn(() => 10),
            buildIndex,
            buildIndexBackground,
        };

        const status = await ensureSemanticIndexReadyForTool(indexer as never, 500);

        expect(status).toBe('none');
        expect(buildIndex).not.toHaveBeenCalled();
        expect(buildIndexBackground).not.toHaveBeenCalled();
    });

    it('initializes semantic indexing runtime before refreshing a mutation turn', async () => {
        const buildIndex = vi.fn(async () => ({
            filesIndexed: 2,
            filesSkipped: 0,
            chunksCreated: 2,
            symbolsExtracted: 0,
            embeddingFailures: 0,
            warnings: [],
        }));
        const buildIndexBackground = vi.fn(async () => ({
            filesIndexed: 0,
            filesSkipped: 0,
            chunksCreated: 0,
            symbolsExtracted: 0,
            embeddingFailures: 0,
            warnings: [],
        }));
        let indexer:
            | {
                ready: boolean;
                indexing: boolean;
                estimateFileCount: () => number;
                buildIndex: typeof buildIndex;
                buildIndexBackground: typeof buildIndexBackground;
            }
            | undefined;
        const initializeRuntime = vi.fn(async () => {
            indexer = {
                ready: false,
                indexing: false,
                estimateFileCount: () => 2,
                buildIndex,
                buildIndexBackground,
            };
        });

        const status = await ensureSemanticIndexReadyForTurnRefresh({
            items: [
                {
                    kind: 'tool_result',
                    id: 'item_tool_write',
                    seq: 2,
                    toolCallId: 'call_write_1',
                    toolName: 'write_file',
                    output: {
                        status: 'success',
                        data: 'Wrote src/sentinel.ts',
                        truncated: false,
                        bytesReturned: 0,
                        bytesOmitted: 0,
                        retryable: false,
                        timedOut: false,
                        mutationState: 'filesystem',
                    },
                    timestamp: new Date().toISOString(),
                },
            ],
            getIndexer: () => indexer as never,
            initializeRuntime,
            backgroundThreshold: 500,
        });

        expect(status).toBe('built');
        expect(initializeRuntime).toHaveBeenCalledTimes(1);
        expect(buildIndex).toHaveBeenCalledTimes(1);
        expect(buildIndexBackground).not.toHaveBeenCalled();
    });
});
