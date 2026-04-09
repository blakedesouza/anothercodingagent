import type { ConversationItem } from '../types/conversation.js';
import type { Indexer } from './indexer.js';

const queuedRefreshes = new WeakSet<Indexer>();

export type IndexRefreshStatus = 'none' | 'updated' | 'scheduled';

export function turnNeedsIndexRefresh(items: readonly ConversationItem[]): boolean {
    return items.some((item) =>
        item.kind === 'tool_result' &&
        (item.output.mutationState === 'filesystem' || item.output.mutationState === 'indeterminate'),
    );
}

export async function refreshIndexAfterTurn(
    indexer: Indexer | undefined,
    items: readonly ConversationItem[],
): Promise<IndexRefreshStatus> {
    if (!indexer || !turnNeedsIndexRefresh(items)) {
        return 'none';
    }

    if (indexer.indexing) {
        if (!queuedRefreshes.has(indexer)) {
            queuedRefreshes.add(indexer);
            void indexer.buildIndexBackground()
                .catch(() => undefined)
                .then(async () => {
                    try {
                        await indexer.incrementalUpdate();
                    } finally {
                        queuedRefreshes.delete(indexer);
                    }
                });
        }
        return 'scheduled';
    }

    await indexer.incrementalUpdate();
    return 'updated';
}
