import type { RequestMessage, ProviderDriver } from '../types/provider.js';
import type { ConversationItem } from '../types/conversation.js';
import type { RegisteredTool } from '../tools/tool-registry.js';
import type { CapabilityHealthMap } from '../core/capability-health.js';
import { summarizeHistoryBeforeTurn } from '../core/pre-turn-summarization.js';
import {
    applyRuntimeTurnState,
    buildRuntimePromptContext,
} from '../core/runtime-turn-context.js';
import { buildContextBlock } from '../core/prompt-assembly.js';
import type { SessionManager, SessionProjection } from '../core/session-manager.js';
import type { TurnEngineConfig } from '../core/turn-engine.js';

type InvokeTurnConfigBase = Omit<
    TurnEngineConfig,
    'projectSnapshot' | 'workingSet' | 'durableTaskState' | 'capabilities' | 'systemMessages'
>;

export interface PrepareInvokeTurnConfigOptions {
    conversationItems: ConversationItem[];
    task: string;
    projection: SessionProjection;
    provider: ProviderDriver;
    model: string;
    tools: RegisteredTool[];
    workspaceRoot: string;
    shell?: string;
    healthMap?: CapabilityHealthMap;
    baseConfig: InvokeTurnConfigBase;
    baseSystemMessages?: RequestMessage[];
    includeRuntimeContextMessage?: boolean;
}

export async function prepareInvokeTurnConfig(
    options: PrepareInvokeTurnConfigOptions,
): Promise<TurnEngineConfig> {
    const {
        conversationItems,
        task,
        projection,
        provider,
        model,
        tools,
        workspaceRoot,
        shell,
        healthMap,
        baseConfig,
        baseSystemMessages,
        includeRuntimeContextMessage = false,
    } = options;

    await summarizeHistoryBeforeTurn({
        historyItems: conversationItems,
        pendingUserInput: task,
        workspaceRoot,
        shell,
        manifest: projection.manifest,
        writer: projection.writer,
        sequenceGenerator: projection.sequenceGenerator,
        provider,
        model,
        tools,
        healthMap,
    });

    const promptContext = buildRuntimePromptContext(
        workspaceRoot,
        projection.manifest,
        healthMap,
    );

    return {
        ...baseConfig,
        projectSnapshot: promptContext.projectSnapshot,
        workingSet: promptContext.workingSet,
        durableTaskState: promptContext.durableTaskState,
        capabilities: promptContext.capabilities,
        systemMessages: includeRuntimeContextMessage
            ? appendRuntimeContextMessage(baseSystemMessages ?? [], {
                cwd: workspaceRoot,
                shell,
                projectSnapshot: promptContext.projectSnapshot,
                workingSet: promptContext.workingSet,
                capabilities: promptContext.capabilities,
                durableTaskState: promptContext.durableTaskState,
            })
            : baseSystemMessages,
    };
}

export async function finalizeInvokeTurnState(
    sessionManager: Pick<SessionManager, 'saveManifest'>,
    projection: SessionProjection,
    workspaceRoot: string,
    turnItems: ConversationItem[],
): Promise<void> {
    await applyRuntimeTurnState(projection.manifest, turnItems, workspaceRoot);
    projection.manifest.turnCount = (projection.manifest.turnCount ?? 0) + 1;
    projection.manifest.lastActivityTimestamp = new Date().toISOString();
    sessionManager.saveManifest(projection);
}

function appendRuntimeContextMessage(
    systemMessages: RequestMessage[],
    options: {
        cwd: string;
        shell?: string;
        projectSnapshot?: TurnEngineConfig['projectSnapshot'];
        workingSet?: TurnEngineConfig['workingSet'];
        capabilities?: TurnEngineConfig['capabilities'];
        durableTaskState?: TurnEngineConfig['durableTaskState'];
    },
): RequestMessage[] {
    const contextBlock = buildContextBlock({
        cwd: options.cwd,
        shell: options.shell,
        projectSnapshot: options.projectSnapshot,
        workingSet: options.workingSet,
        capabilities: options.capabilities,
        durableTaskState: options.durableTaskState,
    });
    if (!contextBlock.trim()) {
        return systemMessages;
    }
    return [
        ...systemMessages,
        {
            role: 'system',
            content: contextBlock,
        },
    ];
}
