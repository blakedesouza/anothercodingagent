import { describe, it, expect } from 'vitest';
import { askUserSpec, askUserImpl } from '../../src/tools/ask-user.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

// --- Setup ---

let registry: ToolRegistry;
let runner: ToolRunner;

function setup() {
    registry = new ToolRegistry();
    registry.register(askUserSpec, askUserImpl);
    runner = new ToolRunner(registry);
}

setup();

const baseContext = {
    sessionId: 'ses_test',
    workspaceRoot: '/tmp/test',
    interactive: true,
    promptUser: async (_question: string, _choices?: string[]) => 'test response',
};

// --- Tests ---

describe('ask_user tool', () => {
    describe('spec', () => {
        it('has correct metadata', () => {
            expect(askUserSpec.name).toBe('ask_user');
            expect(askUserSpec.approvalClass).toBe('user-facing');
            expect(askUserSpec.idempotent).toBe(false);
            expect(askUserSpec.timeoutCategory).toBe('user');
        });
    });

    describe('interactive mode', () => {
        it('prompts user and returns response', async () => {
            const userAnswer = 'I want option B';
            const context = {
                ...baseContext,
                promptUser: async (question: string) => {
                    expect(question).toBe('Which option?');
                    return userAnswer;
                },
            };

            const result = await runner.execute(
                'ask_user',
                { question: 'Which option?' },
                context,
            );

            expect(result.status).toBe('success');
            const data = JSON.parse(result.data);
            expect(data.response).toBe(userAnswer);
        });

        it('passes choices to promptUser when provided', async () => {
            let receivedChoices: string[] | undefined;
            const context = {
                ...baseContext,
                promptUser: async (_question: string, choices?: string[]) => {
                    receivedChoices = choices;
                    return 'A';
                },
            };

            await runner.execute(
                'ask_user',
                { question: 'Pick one', choices: ['A', 'B', 'C'] },
                context,
            );

            expect(receivedChoices).toEqual(['A', 'B', 'C']);
        });

        it('yields turn with awaiting_user outcome', async () => {
            const result = await runner.execute(
                'ask_user',
                { question: 'What next?' },
                baseContext,
            );

            expect(result.status).toBe('success');
            expect(result.yieldOutcome).toBe('awaiting_user');
        });
    });

    describe('non-interactive mode', () => {
        it('returns user_cancelled when no TTY available', async () => {
            const context = {
                ...baseContext,
                interactive: false,
            };

            const result = await runner.execute(
                'ask_user',
                { question: 'What next?' },
                context,
            );

            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('user_cancelled');
        });
    });

    describe('sub-agent context', () => {
        it('denies with not permitted by agent profile', async () => {
            const context = {
                ...baseContext,
                isSubAgent: true,
            };

            const result = await runner.execute(
                'ask_user',
                { question: 'What next?' },
                context,
            );

            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.not_permitted');
            expect(result.error!.message).toContain('not permitted by agent profile');
        });
    });

    describe('promptUser error handling', () => {
        it('returns user_cancelled when promptUser throws', async () => {
            const context = {
                ...baseContext,
                promptUser: async () => { throw new Error('readline closed'); },
            };

            const result = await runner.execute(
                'ask_user',
                { question: 'What next?' },
                context,
            );

            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('user_cancelled');
            expect(result.error!.message).toContain('readline closed');
        });
    });

    describe('input validation', () => {
        it('rejects missing question', async () => {
            const result = await runner.execute('ask_user', {}, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });

        it('rejects empty question', async () => {
            const result = await runner.execute(
                'ask_user',
                { question: '' },
                baseContext,
            );
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
