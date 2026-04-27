import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface WorkflowFailure {
    model: string;
    taskId: string;
    success: boolean;
    testsPassed: boolean;
    errorCodes: string[];
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

function errorCodes(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
}

export function extractWorkflowFailures(results: unknown): WorkflowFailure[] {
    if (!Array.isArray(results)) {
        return [{
            model: '(unknown)',
            taskId: '(results.json)',
            success: false,
            testsPassed: false,
            errorCodes: ['tool_call_conformance.malformed_results'],
        }];
    }

    return results
        .filter((entry): entry is Record<string, unknown> => isRecord(entry) && entry.overallPass !== true)
        .map(entry => ({
            model: stringValue(entry.model, '(unknown)'),
            taskId: stringValue(entry.taskId, '(unknown)'),
            success: booleanValue(entry.success),
            testsPassed: booleanValue(entry.testsPassed),
            errorCodes: errorCodes(entry.errorCodes),
        }));
}

export async function readWorkflowFailures(outDir: string): Promise<WorkflowFailure[]> {
    const raw = await fs.readFile(join(outDir, 'results.json'), 'utf8');
    return extractWorkflowFailures(JSON.parse(raw) as unknown);
}
