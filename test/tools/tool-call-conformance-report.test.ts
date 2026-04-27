import { describe, expect, it } from 'vitest';
import { extractWorkflowFailures } from '../../src/tools/tool-call-conformance-report.js';

describe('extractWorkflowFailures', () => {
    it('returns failed live workflow cases from results JSON', () => {
        const failures = extractWorkflowFailures([
            {
                model: 'zai-org/glm-5.1',
                taskId: 'resume-workspace-fix',
                overallPass: true,
                success: true,
                testsPassed: true,
                errorCodes: [],
            },
            {
                model: 'moonshotai/kimi-k2.6',
                taskId: 'optional-capability-fix',
                overallPass: false,
                success: false,
                testsPassed: true,
                errorCodes: ['llm.malformed'],
            },
        ]);

        expect(failures).toEqual([{
            model: 'moonshotai/kimi-k2.6',
            taskId: 'optional-capability-fix',
            success: false,
            testsPassed: true,
            errorCodes: ['llm.malformed'],
            classification: 'unknown_workflow_failure',
            salvageCandidate: false,
            changedFiles: [],
            acceptedToolCalls: null,
            resultPreview: '',
        }]);
    });

    it('treats malformed results JSON as a conformance failure', () => {
        expect(extractWorkflowFailures({ nope: true })).toEqual([{
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
        }]);
    });

    it('classifies server errors before any mutation', () => {
        expect(extractWorkflowFailures([{
            model: 'deepseek/deepseek-v4-pro',
            taskId: 'resume-workspace-fix',
            overallPass: false,
            success: false,
            testsPassed: false,
            errorCodes: ['llm.server_error'],
            changedFiles: [],
            acceptedToolCalls: 4,
            result: '',
        }])).toEqual([expect.objectContaining({
            classification: 'server_error_before_mutation',
            salvageCandidate: false,
            changedFiles: [],
            acceptedToolCalls: 4,
            resultPreview: '',
        })]);
    });

    it('classifies server errors after mutation', () => {
        expect(extractWorkflowFailures([{
            model: 'deepseek/deepseek-v4-pro',
            taskId: 'resume-workspace-fix',
            overallPass: false,
            success: false,
            testsPassed: false,
            errorCodes: ['llm.server_error'],
            changedFiles: ['src/runtime.js'],
            acceptedToolCalls: 7,
            result: '',
        }])[0]).toMatchObject({
            classification: 'server_error_after_mutation',
            salvageCandidate: true,
            changedFiles: ['src/runtime.js'],
            acceptedToolCalls: 7,
        });
    });

    it('classifies post-mutation malformed failures as salvage candidates', () => {
        expect(extractWorkflowFailures([{
            model: 'moonshotai/kimi-k2.6',
            taskId: 'optional-capability-fix',
            overallPass: false,
            success: false,
            testsPassed: true,
            errorCodes: ['llm.malformed'],
            changedFiles: ['src/runtime.js'],
            acceptedToolCalls: 9,
            result: '',
        }])[0]).toMatchObject({
            classification: 'post_mutation_malformed_salvage_candidate',
            salvageCandidate: true,
        });
    });

    it('classifies malformed failures after tool calls without file changes', () => {
        expect(extractWorkflowFailures([{
            model: 'zai-org/glm-5.1',
            taskId: 'invoke-runtime-hard',
            overallPass: false,
            success: false,
            testsPassed: false,
            errorCodes: ['llm.malformed'],
            changedFiles: [],
            acceptedToolCalls: 3,
            result: '',
        }])[0]).toMatchObject({
            classification: 'malformed_after_tool_results',
            salvageCandidate: false,
        });
    });

    it('classifies contradictory successful finals after mutation', () => {
        expect(extractWorkflowFailures([{
            model: 'moonshotai/kimi-k2.6',
            taskId: 'resume-handle-fix',
            overallPass: false,
            success: true,
            testsPassed: true,
            errorCodes: [],
            changedFiles: ['src/session-io.js'],
            acceptedToolCalls: 8,
            result: 'The tool returned an error, so I could not complete the request.',
        }])[0]).toMatchObject({
            classification: 'contradictory_final_after_mutation',
            salvageCandidate: true,
        });
    });

    it('classifies unknown failed workflow cases', () => {
        expect(extractWorkflowFailures([{
            model: 'unknown/model',
            taskId: 'odd-case',
            overallPass: false,
            success: false,
            testsPassed: false,
            errorCodes: ['turn.rejected_tool_calls'],
            changedFiles: [],
            acceptedToolCalls: null,
            result: 'Nope',
        }])[0]).toMatchObject({
            classification: 'unknown_workflow_failure',
            salvageCandidate: false,
        });
    });
});
