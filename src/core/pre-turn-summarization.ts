import type { ProviderDriver } from '../types/provider.js';
import type { ConversationItem, MessageItem, SummaryItem } from '../types/conversation.js';
import type { ItemId } from '../types/ids.js';
import type { RegisteredTool } from '../tools/tool-registry.js';
import type { SequenceGenerator } from '../types/sequence.js';
import type { ConversationWriter } from './conversation-writer.js';
import type { SessionManifest } from './session-manager.js';
import type { CapabilityHealthMap } from './capability-health.js';
import {
    applyDurableStatePatchUpdate,
    createInitialDurableTaskState,
} from './durable-task-state.js';
import { groupIntoTurns, getVerbatimTurnLimit } from './context-assembly.js';
import { preparePrompt } from './prompt-assembly.js';
import { buildRuntimePromptContext } from './runtime-turn-context.js';
import {
    buildCoverageMap,
    chunkForSummarization,
    summarizeChunk,
    visibleHistory,
} from './summarizer.js';

const DEFAULT_MAX_SUMMARIES_PER_TURN = 2;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface SummarizeHistoryBeforeTurnOptions {
    historyItems: ConversationItem[];
    pendingUserInput: string;
    workspaceRoot: string;
    shell?: string;
    manifest: Pick<SessionManifest, 'durableTaskState' | 'fileActivityIndex'>;
    writer: ConversationWriter;
    sequenceGenerator: SequenceGenerator;
    provider: ProviderDriver;
    model: string;
    tools: RegisteredTool[];
    healthMap?: CapabilityHealthMap;
    userInstructions?: string;
    maxSummariesPerTurn?: number;
}

export async function summarizeHistoryBeforeTurn(
    options: SummarizeHistoryBeforeTurnOptions,
): Promise<SummaryItem[]> {
    const {
        historyItems,
        pendingUserInput,
        workspaceRoot,
        shell,
        manifest,
        writer,
        sequenceGenerator,
        provider,
        model,
        tools,
        healthMap,
        userInstructions,
        maxSummariesPerTurn = DEFAULT_MAX_SUMMARIES_PER_TURN,
    } = options;

    if (historyItems.length === 0 || pendingUserInput.trim() === '') {
        return [];
    }

    const caps = provider.capabilities(model);
    const created: SummaryItem[] = [];
    const maxOutputTokens = Math.min(DEFAULT_MAX_OUTPUT_TOKENS, caps.maxOutput);

    for (let i = 0; i < maxSummariesPerTurn; i++) {
        const promptContext = buildRuntimePromptContext(workspaceRoot, manifest, healthMap);
        const syntheticUser = makeSyntheticUserMessage(sequenceGenerator.peek(), pendingUserInput);
        const prepared = preparePrompt({
            model,
            maxTokens: maxOutputTokens,
            temperature: 0.7,
            tools,
            items: [...historyItems, syntheticUser],
            cwd: workspaceRoot,
            shell,
            projectSnapshot: promptContext.projectSnapshot,
            workingSet: promptContext.workingSet,
            durableTaskState: promptContext.durableTaskState,
            capabilities: promptContext.capabilities,
            userInstructions,
            contextLimit: caps.maxContext,
            reservedOutputTokens: maxOutputTokens,
            bytesPerToken: caps.bytesPerToken,
        });

        if (prepared.contextStats.droppedItemCount === 0) {
            break;
        }

        const visibleItems = visibleHistory(historyItems, buildCoverageMap(historyItems));
        const visibleTurns = groupIntoTurns(visibleItems);
        if (visibleTurns.length === 0) {
            break;
        }

        const keepTurns = getVerbatimTurnLimit(prepared.contextStats.compressionTier);
        let prefixTurnCount = Number.isFinite(keepTurns)
            ? Math.max(0, visibleTurns.length - keepTurns)
            : 0;
        if (prefixTurnCount === 0) {
            prefixTurnCount = 1;
        }

        const prefixTurns = visibleTurns.slice(0, prefixTurnCount);
        const chunks = chunkForSummarization(prefixTurns, caps.bytesPerToken);
        const chunkItems = chunks[0];
        if (!chunkItems || chunkItems.length === 0) {
            break;
        }

        const { summary, durableStatePatch } = await summarizeChunk({
            chunkItems,
            allItems: historyItems,
            provider,
            model,
            nextSeq: sequenceGenerator.next(),
            bytesPerToken: caps.bytesPerToken,
            durableState: manifest.durableTaskState,
        });

        if (durableStatePatch) {
            const currentState = manifest.durableTaskState ?? createInitialDurableTaskState();
            manifest.durableTaskState = applyDurableStatePatchUpdate(currentState, durableStatePatch);
        }
        writer.writeItem(summary);
        historyItems.push(summary);
        created.push(summary);
    }

    return created;
}

function makeSyntheticUserMessage(seq: number, text: string): MessageItem {
    return {
        kind: 'message',
        id: 'item_synthetic_pending' as ItemId,
        seq,
        role: 'user',
        parts: [{ type: 'text', text }],
        timestamp: new Date(0).toISOString(),
    };
}
