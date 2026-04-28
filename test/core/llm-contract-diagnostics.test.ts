import { describe, expect, it } from 'vitest';
import {
    classifyLlmContractFailure,
    hasStrongCompletionEvidence,
    summarizeCompletionEvidence,
} from '../../src/core/llm-contract-diagnostics.js';

describe('llm contract diagnostics', () => {
    it('treats passing tests plus source changes as strong completion evidence', () => {
        expect(hasStrongCompletionEvidence({
            changedFiles: ['src/runtime.js'],
            testsPassed: true,
            changedTests: false,
            requiredOutputsSatisfied: false,
            filesystemMutations: 1,
        })).toBe(true);
    });

    it('does not treat test-only edits as strong completion evidence', () => {
        expect(hasStrongCompletionEvidence({
            changedFiles: ['test/runtime.test.js'],
            testsPassed: true,
            changedTests: true,
            requiredOutputsSatisfied: false,
            filesystemMutations: 1,
        })).toBe(false);
    });

    it('treats satisfied required outputs as strong completion evidence', () => {
        expect(hasStrongCompletionEvidence({
            changedFiles: [],
            testsPassed: false,
            changedTests: false,
            requiredOutputsSatisfied: true,
            filesystemMutations: 0,
        })).toBe(true);
    });

    it('classifies post-mutation empty final with strong evidence as salvaged success', () => {
        expect(classifyLlmContractFailure({
            lowLevelCode: 'llm.malformed',
            lowLevelMessage: 'Model returned an empty response',
            requestContractPassed: true,
            historyContractPassed: true,
            parserRecoveredKnownShape: true,
            retryAttempts: 2,
            repairAttempts: 1,
            completionEvidence: {
                changedFiles: ['src/runtime.js'],
                testsPassed: true,
                changedTests: false,
                requiredOutputsSatisfied: false,
                filesystemMutations: 1,
            },
        })).toMatchObject({
            classification: 'salvaged_success',
            diagnosticBucket: 'post_mutation_empty_final',
            salvaged: true,
            salvageCandidate: true,
        });
    });

    it('classifies empty final after valid ACA contract as provider/model nonconformance', () => {
        expect(classifyLlmContractFailure({
            lowLevelCode: 'llm.malformed',
            lowLevelMessage: 'Model returned an empty response',
            requestContractPassed: true,
            historyContractPassed: true,
            parserRecoveredKnownShape: true,
            retryAttempts: 2,
            repairAttempts: 1,
            completionEvidence: {
                changedFiles: [],
                testsPassed: false,
                changedTests: false,
                requiredOutputsSatisfied: false,
                filesystemMutations: 0,
            },
        })).toMatchObject({
            classification: 'provider_model_nonconformance',
            diagnosticBucket: 'provider_empty_final',
            salvaged: false,
            salvageCandidate: false,
        });
    });

    it('classifies invalid final output with required-output evidence as salvaged success', () => {
        expect(classifyLlmContractFailure({
            lowLevelCode: 'turn.output_validation_failed',
            lowLevelMessage: 'final response leaked raw tool-call-shaped text instead of a plain-language completion',
            requestContractPassed: true,
            historyContractPassed: true,
            parserRecoveredKnownShape: true,
            retryAttempts: 1,
            repairAttempts: 0,
            completionEvidence: {
                changedFiles: [],
                testsPassed: false,
                changedTests: false,
                requiredOutputsSatisfied: true,
                filesystemMutations: 1,
            },
        })).toMatchObject({
            classification: 'salvaged_success',
            diagnosticBucket: 'post_required_output_empty_final',
            salvaged: true,
            salvageCandidate: true,
        });
    });

    it('classifies invalid request evidence as an ACA contract failure', () => {
        expect(classifyLlmContractFailure({
            lowLevelCode: 'llm.invalid_request',
            lowLevelMessage: 'tool result id mismatch',
            requestContractPassed: false,
            historyContractPassed: true,
            parserRecoveredKnownShape: true,
            retryAttempts: 0,
            repairAttempts: 0,
            completionEvidence: {
                changedFiles: [],
                testsPassed: false,
                changedTests: false,
                requiredOutputsSatisfied: false,
                filesystemMutations: 0,
            },
        })).toMatchObject({
            classification: 'aca_contract_failure',
            diagnosticBucket: 'native_request_shape_invalid',
            salvaged: false,
        });
    });

    it('summarizes completion evidence without inventing model prose', () => {
        expect(summarizeCompletionEvidence({
            changedFiles: ['src/runtime.js'],
            testsPassed: true,
            changedTests: false,
            requiredOutputsSatisfied: false,
            filesystemMutations: 2,
        })).toBe('Work evidence: 1 source file changed, validation passed, 2 filesystem mutation tool results.');
    });
});
