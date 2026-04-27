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
        }]);
    });

    it('treats malformed results JSON as a conformance failure', () => {
        expect(extractWorkflowFailures({ nope: true })).toEqual([{
            model: '(unknown)',
            taskId: '(results.json)',
            success: false,
            testsPassed: false,
            errorCodes: ['tool_call_conformance.malformed_results'],
        }]);
    });
});
