import type { ConversationItem } from '../types/conversation.js';
import type { Indexer } from './indexer.js';
import { turnNeedsIndexRefresh } from './runtime-refresh.js';

export type SemanticIndexWarmupStatus = 'none' | 'built' | 'scheduled';

export async function ensureSemanticIndexReadyForTool(
    indexer: Indexer | undefined,
    backgroundThreshold: number,
): Promise<SemanticIndexWarmupStatus> {
    if (!indexer || indexer.ready || indexer.indexing) {
        return 'none';
    }

    if (indexer.estimateFileCount() > backgroundThreshold) {
        void indexer.buildIndexBackground().catch(() => undefined);
        return 'scheduled';
    }

    await indexer.buildIndex();
    return 'built';
}

export async function ensureSemanticIndexReadyForTurnRefresh(options: {
    items: readonly ConversationItem[];
    getIndexer: () => Indexer | undefined;
    initializeRuntime: () => Promise<unknown>;
    backgroundThreshold: number;
}): Promise<SemanticIndexWarmupStatus> {
    if (!turnNeedsIndexRefresh(options.items)) {
        return 'none';
    }

    if (!options.getIndexer()) {
        await options.initializeRuntime();
    }

    return ensureSemanticIndexReadyForTool(
        options.getIndexer(),
        options.backgroundThreshold,
    );
}
