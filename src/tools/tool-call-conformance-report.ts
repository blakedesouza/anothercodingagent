import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
    classifyLlmContractFailure,
    type LlmContractClassification,
    type LlmDiagnosticBucket,
} from '../core/llm-contract-diagnostics.js';

export type WorkflowFailureClassification = LlmContractClassification;

export interface WorkflowFailure {
    model: string;
    taskId: string;
    success: boolean;
    testsPassed: boolean;
    errorCodes: string[];
    classification: WorkflowFailureClassification;
    diagnosticBucket: LlmDiagnosticBucket;
    salvageCandidate: boolean;
    salvaged: boolean;
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
    changedTests: boolean;
    errorCodes: readonly string[];
    changedFiles: readonly string[];
    acceptedToolCalls: number | null;
    resultPreview: string;
}): {
    classification: WorkflowFailureClassification;
    diagnosticBucket: LlmDiagnosticBucket;
    salvageCandidate: boolean;
    salvaged: boolean;
} {
    const lowLevelCode = input.errorCodes[0] ?? (
        input.success ? 'turn.output_validation_failed' : 'unknown_workflow_failure'
    );
    const diagnostic = classifyLlmContractFailure({
        lowLevelCode,
        lowLevelMessage: input.resultPreview,
        requestContractPassed: true,
        historyContractPassed: true,
        parserRecoveredKnownShape: true,
        retryAttempts: 0,
        repairAttempts: 0,
        completionEvidence: {
            changedFiles: [...input.changedFiles],
            testsPassed: input.testsPassed,
            changedTests: input.changedTests,
            requiredOutputsSatisfied: false,
            filesystemMutations: input.changedFiles.length > 0
                ? Math.max(input.changedFiles.length, input.acceptedToolCalls ?? 0)
                : 0,
        },
        finalValidationGap: input.success && CONTRADICTORY_FINAL_AFTER_MUTATION.test(input.resultPreview),
    });
    return {
        classification: diagnostic.classification,
        diagnosticBucket: diagnostic.diagnosticBucket,
        salvageCandidate: diagnostic.salvageCandidate,
        salvaged: diagnostic.salvaged,
    };
}

export function extractWorkflowFailures(results: unknown): WorkflowFailure[] {
    if (!Array.isArray(results)) {
        return [{
            model: '(unknown)',
            taskId: '(results.json)',
            success: false,
            testsPassed: false,
            errorCodes: ['tool_call_conformance.malformed_results'],
            classification: 'unknown_needs_artifact',
            diagnosticBucket: 'unknown_needs_artifact',
            salvageCandidate: false,
            salvaged: false,
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
            const changedTests = booleanValue(entry.changedTests);
            const codes = errorCodes(entry.errorCodes);
            const changedFiles = stringArrayValue(entry.changedFiles);
            const acceptedToolCalls = numberValue(entry.acceptedToolCalls);
            const preview = resultPreview(entry.result);
            const classification = classifyWorkflowFailure({
                success,
                testsPassed,
                changedTests,
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
                diagnosticBucket: classification.diagnosticBucket,
                salvageCandidate: classification.salvageCandidate,
                salvaged: classification.salvaged,
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
