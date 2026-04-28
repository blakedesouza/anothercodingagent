export type LlmContractClassification =
    | 'salvaged_success'
    | 'provider_model_nonconformance'
    | 'aca_contract_failure'
    | 'aca_parser_gap'
    | 'aca_final_validation_gap'
    | 'unknown_needs_artifact';

export type LlmDiagnosticBucket =
    | 'provider_empty_final'
    | 'provider_invalid_tool_args'
    | 'provider_ignored_tool_result'
    | 'provider_stream_malformed'
    | 'history_tool_result_mismatch'
    | 'native_request_shape_invalid'
    | 'emulated_request_shape_invalid'
    | 'reasoning_leaked_as_visible_output'
    | 'post_mutation_empty_final'
    | 'post_required_output_empty_final'
    | 'final_validation_gap'
    | 'unknown_needs_artifact';

export interface CompletionEvidence {
    changedFiles: string[];
    testsPassed: boolean;
    changedTests: boolean;
    requiredOutputsSatisfied: boolean;
    filesystemMutations: number;
}

export interface LlmContractDiagnosticInput {
    lowLevelCode: string;
    lowLevelMessage: string;
    requestContractPassed: boolean;
    historyContractPassed: boolean;
    parserRecoveredKnownShape: boolean;
    retryAttempts: number;
    repairAttempts: number;
    completionEvidence: CompletionEvidence;
    finalValidationGap?: boolean;
}

export interface LlmContractDiagnostic {
    classification: LlmContractClassification;
    diagnosticBucket: LlmDiagnosticBucket;
    lowLevelCode: string;
    lowLevelMessage: string;
    salvageCandidate: boolean;
    salvaged: boolean;
    reason: string;
    requestContractPassed: boolean;
    historyContractPassed: boolean;
    parserRecoveredKnownShape: boolean;
    retryAttempts: number;
    repairAttempts: number;
    completionEvidence: CompletionEvidence;
}

function sourceChanged(files: readonly string[]): boolean {
    return files.some(file =>
        !file.startsWith('test/')
        && !file.endsWith('.test.ts')
        && !file.endsWith('.test.js')
        && !file.endsWith('.spec.ts')
        && !file.endsWith('.spec.js')
    );
}

export function hasStrongCompletionEvidence(evidence: CompletionEvidence): boolean {
    if (evidence.requiredOutputsSatisfied) return true;
    return evidence.testsPassed
        && !evidence.changedTests
        && (sourceChanged(evidence.changedFiles) || evidence.filesystemMutations > 0);
}

function isEmptyFinal(input: LlmContractDiagnosticInput): boolean {
    const text = `${input.lowLevelCode} ${input.lowLevelMessage}`.toLowerCase();
    return text.includes('llm.malformed')
        || text.includes('turn.output_validation_failed')
        || text.includes('empty response')
        || text.includes('empty final');
}

function evidenceBucket(evidence: CompletionEvidence): LlmDiagnosticBucket {
    if (evidence.requiredOutputsSatisfied) return 'post_required_output_empty_final';
    if (evidence.changedFiles.length > 0 || evidence.filesystemMutations > 0) return 'post_mutation_empty_final';
    return 'provider_empty_final';
}

function buildDiagnostic(
    input: LlmContractDiagnosticInput,
    classification: LlmContractClassification,
    diagnosticBucket: LlmDiagnosticBucket,
    salvageCandidate: boolean,
    salvaged: boolean,
    reason: string,
): LlmContractDiagnostic {
    return {
        classification,
        diagnosticBucket,
        lowLevelCode: input.lowLevelCode,
        lowLevelMessage: input.lowLevelMessage,
        salvageCandidate,
        salvaged,
        reason,
        requestContractPassed: input.requestContractPassed,
        historyContractPassed: input.historyContractPassed,
        parserRecoveredKnownShape: input.parserRecoveredKnownShape,
        retryAttempts: input.retryAttempts,
        repairAttempts: input.repairAttempts,
        completionEvidence: input.completionEvidence,
    };
}

export function classifyLlmContractFailure(input: LlmContractDiagnosticInput): LlmContractDiagnostic {
    const strongEvidence = hasStrongCompletionEvidence(input.completionEvidence);
    const salvageCandidate = strongEvidence || input.completionEvidence.filesystemMutations > 0;

    if (!input.requestContractPassed) {
        return buildDiagnostic(
            input,
            'aca_contract_failure',
            'native_request_shape_invalid',
            false,
            false,
            'ACA request contract failed before provider/model blame was safe.',
        );
    }

    if (!input.historyContractPassed) {
        return buildDiagnostic(
            input,
            'aca_contract_failure',
            'history_tool_result_mismatch',
            false,
            false,
            'ACA history/tool-result contract failed before provider/model blame was safe.',
        );
    }

    if (!input.parserRecoveredKnownShape) {
        return buildDiagnostic(
            input,
            'aca_parser_gap',
            'provider_stream_malformed',
            salvageCandidate,
            false,
            'Provider output may contain recoverable content ACA did not normalize.',
        );
    }

    if (input.finalValidationGap) {
        return buildDiagnostic(
            input,
            'aca_final_validation_gap',
            'final_validation_gap',
            salvageCandidate,
            false,
            'Final validation accepted or rejected output without enough evidence.',
        );
    }

    if (isEmptyFinal(input) && strongEvidence) {
        return buildDiagnostic(
            input,
            'salvaged_success',
            evidenceBucket(input.completionEvidence),
            true,
            true,
            'ACA proved completion despite malformed or empty final output.',
        );
    }

    if (isEmptyFinal(input)) {
        return buildDiagnostic(
            input,
            'provider_model_nonconformance',
            'provider_empty_final',
            salvageCandidate,
            false,
            'ACA contract checks passed, but the provider/model returned empty or malformed final output.',
        );
    }

    return buildDiagnostic(
        input,
        'unknown_needs_artifact',
        'unknown_needs_artifact',
        salvageCandidate,
        false,
        'Evidence was insufficient to assign ACA or provider/model responsibility.',
    );
}

export function summarizeCompletionEvidence(evidence: CompletionEvidence): string {
    const sourceCount = evidence.changedFiles.filter(file =>
        !file.startsWith('test/')
        && !file.endsWith('.test.ts')
        && !file.endsWith('.test.js')
        && !file.endsWith('.spec.ts')
        && !file.endsWith('.spec.js')
    ).length;
    const parts = [
        `${sourceCount} source file${sourceCount === 1 ? '' : 's'} changed`,
        evidence.testsPassed ? 'validation passed' : 'validation not proven',
        `${evidence.filesystemMutations} filesystem mutation tool result${evidence.filesystemMutations === 1 ? '' : 's'}`,
    ];
    if (evidence.requiredOutputsSatisfied) {
        parts.splice(1, 0, 'required outputs satisfied');
    }
    return `Work evidence: ${parts.join(', ')}.`;
}
