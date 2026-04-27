import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export type WorkflowFailureClassification =
    | 'server_error_before_mutation'
    | 'server_error_after_mutation'
    | 'post_mutation_malformed_salvage_candidate'
    | 'malformed_after_tool_results'
    | 'contradictory_final_after_mutation'
    | 'unknown_workflow_failure';

export interface WorkflowFailure {
    model: string;
    taskId: string;
    success: boolean;
    testsPassed: boolean;
    errorCodes: string[];
    classification: WorkflowFailureClassification;
    salvageCandidate: boolean;
    changedFiles: string[];
    acceptedToolCalls: number | null;
    resultPreview: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function booleanValue(value: unknown): boolean {
    return value === true;
}

function numberValue(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArrayValue(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
}

function resultPreview(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function errorCodes(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
}

const CONTRADICTORY_FINAL_AFTER_MUTATION =
    /\b(?:tool returned an error|could not complete|couldn't complete|unable to complete)\b/i;

function classifyWorkflowFailure(input: {
    success: boolean;
    testsPassed: boolean;
    errorCodes: readonly string[];
    changedFiles: readonly string[];
    acceptedToolCalls: number | null;
    resultPreview: string;
}): { classification: WorkflowFailureClassification; salvageCandidate: boolean } {
    const hasServerError = input.errorCodes.includes('llm.server_error');
    const hasMalformed = input.errorCodes.includes('llm.malformed')
        || input.errorCodes.includes('llm.malformed_response');
    const changedFiles = input.changedFiles.length > 0;
    const acceptedToolCalls = input.acceptedToolCalls ?? 0;

    if (hasServerError && changedFiles) {
        return { classification: 'server_error_after_mutation', salvageCandidate: true };
    }
    if (hasServerError) {
        return { classification: 'server_error_before_mutation', salvageCandidate: false };
    }
    if (hasMalformed && changedFiles && input.testsPassed) {
        return { classification: 'post_mutation_malformed_salvage_candidate', salvageCandidate: true };
    }
    if (hasMalformed && acceptedToolCalls > 0) {
        return { classification: 'malformed_after_tool_results', salvageCandidate: false };
    }
    if (
        input.success
        && changedFiles
        && CONTRADICTORY_FINAL_AFTER_MUTATION.test(input.resultPreview)
    ) {
        return { classification: 'contradictory_final_after_mutation', salvageCandidate: true };
    }
    return { classification: 'unknown_workflow_failure', salvageCandidate: false };
}

export function extractWorkflowFailures(results: unknown): WorkflowFailure[] {
    if (!Array.isArray(results)) {
        return [{
            model: '(unknown)',
            taskId: '(results.json)',
            success: false,
            testsPassed: false,
            errorCodes: ['tool_call_conformance.malformed_results'],
            classification: 'unknown_workflow_failure',
            salvageCandidate: false,
            changedFiles: [],
            acceptedToolCalls: null,
            resultPreview: '',
        }];
    }

    return results
        .filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.overallPass !== true)
        .map(entry => {
            const success = booleanValue(entry.success);
            const testsPassed = booleanValue(entry.testsPassed);
            const codes = errorCodes(entry.errorCodes);
            const changedFiles = stringArrayValue(entry.changedFiles);
            const acceptedToolCalls = numberValue(entry.acceptedToolCalls);
            const preview = resultPreview(entry.result);
            const classification = classifyWorkflowFailure({
                success,
                testsPassed,
                errorCodes: codes,
                changedFiles,
                acceptedToolCalls,
                resultPreview: preview,
            });
            return {
                model: stringValue(entry.model, '(unknown)'),
                taskId: stringValue(entry.taskId, '(unknown)'),
                success,
                testsPassed,
                errorCodes: codes,
                classification: classification.classification,
                salvageCandidate: classification.salvageCandidate,
                changedFiles,
                acceptedToolCalls,
                resultPreview: preview,
            };
        });
}

export async function readWorkflowFailures(outDir: string): Promise<WorkflowFailure[]> {
    const raw = await fs.readFile(join(outDir, 'results.json'), 'utf8');
    return extractWorkflowFailures(JSON.parse(raw) as unknown);
}
