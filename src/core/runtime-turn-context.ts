import type { ConversationItem } from '../types/conversation.js';
import type { SessionManifest } from './session-manager.js';
import type { DurableTaskSummary, WorkingSetEntry } from './prompt-assembly.js';
import type { CapabilityHealthMap } from './capability-health.js';
import type { ProjectSnapshot } from './project-awareness.js';
import { buildProjectSnapshot } from './project-awareness.js';
import {
    createInitialDurableTaskState,
    extractTurnFacts,
    updateDurableTaskState,
    type DurableTaskState,
} from './durable-task-state.js';
import { FileActivityIndex, getActiveOpenLoopFiles } from './file-activity-index.js';

export interface RuntimePromptContext {
    projectSnapshot?: ProjectSnapshot;
    workingSet?: WorkingSetEntry[];
    durableTaskState?: DurableTaskSummary;
    capabilities?: Array<{ name: string; status: 'degraded' | 'unavailable'; detail?: string }>;
}

export function buildRuntimePromptContext(
    workspaceRoot: string,
    manifest: Pick<SessionManifest, 'durableTaskState' | 'fileActivityIndex'>,
    healthMap?: CapabilityHealthMap,
): RuntimePromptContext {
    let projectSnapshot: ProjectSnapshot | undefined;
    try {
        projectSnapshot = buildProjectSnapshot(workspaceRoot);
    } catch {
        projectSnapshot = undefined;
    }

    const index = new FileActivityIndex(manifest.fileActivityIndex, workspaceRoot);
    const topFiles = index.getTopFiles();
    const workingSet = topFiles.length > 0
        ? topFiles.map((entry) => ({ path: entry.path, role: entry.role }))
        : undefined;

    const durableTaskState = summarizeDurableTaskState(manifest.durableTaskState);
    const capabilities = healthMap?.toPromptEntries();

    return {
        projectSnapshot,
        workingSet,
        durableTaskState,
        capabilities: capabilities && capabilities.length > 0 ? capabilities : undefined,
    };
}

export async function applyRuntimeTurnState(
    manifest: Pick<SessionManifest, 'durableTaskState' | 'fileActivityIndex'>,
    turnItems: ConversationItem[],
    workspaceRoot: string,
): Promise<void> {
    const durableState = manifest.durableTaskState ?? createInitialDurableTaskState();
    const updatedDurableState = await updateDurableTaskState(
        durableState,
        // updateDurableTaskState re-extracts facts internally only if given provider/model;
        // we pass no provider here so deterministic extraction is sufficient.
        // Extract once externally to keep file-activity and durable-state updates aligned.
        extractTurnFacts(turnItems, workspaceRoot),
        turnItems,
    );

    const fileActivityIndex = new FileActivityIndex(manifest.fileActivityIndex, workspaceRoot);
    fileActivityIndex.processTurn(turnItems, getActiveOpenLoopFiles(updatedDurableState));

    manifest.durableTaskState = updatedDurableState;
    manifest.fileActivityIndex = fileActivityIndex.serialize();
}

function summarizeDurableTaskState(state: DurableTaskState | null): DurableTaskSummary | undefined {
    if (!state) return undefined;

    const openLoops = state.openLoops
        .filter((loop) => loop.status !== 'done')
        .slice(-5)
        .map((loop) => loop.text);

    const summary: DurableTaskSummary = {};
    if (state.goal) summary.goal = state.goal;
    if (state.confirmedFacts.length > 0) {
        summary.confirmedFacts = state.confirmedFacts.slice(-3);
    }
    if (openLoops.length > 0) {
        summary.openLoops = openLoops;
    }
    if (state.blockers.length > 0) {
        summary.blockers = state.blockers.slice(-5);
    }

    return Object.keys(summary).length > 0 ? summary : undefined;
}
