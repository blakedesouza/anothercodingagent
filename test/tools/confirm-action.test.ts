import { describe, it, expect } from 'vitest';
import { confirmActionSpec, confirmActionImpl } from '../../src/tools/confirm-action.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

// --- Setup ---

let registry: ToolRegistry;
let runner: ToolRunner;

function setup() {
    registry = new ToolRegistry();
    registry.register(confirmActionSpec, confirmActionImpl);
    runner = new ToolRunner(registry);
}

setup();

const baseContext = {
    sessionId: 'ses_test',
    workspaceRoot: '/tmp/test',
    interactive: true,
    promptUser: async (_question: string) => 'yes',
};

// --- Tests ---

describe('confirm_action tool', () => {
    describe('spec', () => {
        it('has correct metadata', () => {
            expect(confirmActionSpec.name).toBe('confirm_action');
            expect(confirmActionSpec.approvalClass).toBe('user-facing');
            expect(confirmActionSpec.idempotent).toBe(false);
            expect(confirmActionSpec.timeoutCategory).toBe('user');
        });
    });

    describe('interactive mode with TTY', () => {
        it('prompts for approval and returns true when user approves', async () => {
            const context = {
                ...baseContext,
                promptUser: async (prompt: string) => {
                    expect(prompt).toContain('Confirm action:');
                    expect(prompt).toContain('delete all logs');
                    return 'yes';
                },
            };

            const result = await runner.execute(
                'confirm_action',
                { action: 'delete all logs' },
                context,
            );

            expect(result.status).toBe('success');
            const data = JSON.parse(result.data);
            expect(data.approved).toBe(true);
        });

        it('returns false when user rejects', async () => {
            const context = {
                ...baseContext,
                promptUser: async () => 'no',
            };

            const result = await runner.execute(
                'confirm_action',
                { action: 'drop database' },
                context,
            );

            expect(result.status).toBe('success');
            const data = JSON.parse(result.data);
            expect(data.approved).toBe(false);
        });

        it('includes affected_paths and risk_summary in prompt', async () => {
            let capturedPrompt = '';
            const context = {
                ...baseContext,
                promptUser: async (prompt: string) => {
                    capturedPrompt = prompt;
                    return 'y';
                },
            };

            await runner.execute(
                'confirm_action',
                {
                    action: 'overwrite config',
                    affected_paths: ['/etc/app.conf', '/var/log/app.log'],
                    risk_summary: 'Will replace production configuration',
                },
                context,
            );

            expect(capturedPrompt).toContain('/etc/app.conf');
            expect(capturedPrompt).toContain('/var/log/app.log');
            expect(capturedPrompt).toContain('Will replace production configuration');
        });

        it('yields turn with approval_required outcome', async () => {
            const result = await runner.execute(
                'confirm_action',
                { action: 'test action' },
                baseContext,
            );

            expect(result.status).toBe('success');
            expect(result.yieldOutcome).toBe('approval_required');
        });

        it('accepts "y" as approval', async () => {
            const context = {
                ...baseContext,
                promptUser: async () => 'y',
            };

            const result = await runner.execute(
                'confirm_action',
                { action: 'test' },
                context,
            );

            const data = JSON.parse(result.data);
            expect(data.approved).toBe(true);
        });
    });

    describe('auto-confirm mode (--no-confirm)', () => {
        it('auto-approves without prompting when autoConfirm is true', async () => {
            let prompted = false;
            const context = {
                ...baseContext,
                autoConfirm: true,
                promptUser: async () => {
                    prompted = true;
                    return 'no';
                },
            };

            const result = await runner.execute(
                'confirm_action',
                { action: 'dangerous action' },
                context,
            );

            expect(result.status).toBe('success');
            const data = JSON.parse(result.data);
            expect(data.approved).toBe(true);
            expect(prompted).toBe(false);
            expect(result.yieldOutcome).toBeUndefined();
        });
    });

    describe('non-interactive mode', () => {
        it('returns user_cancelled when no TTY and no autoConfirm', async () => {
            const context = {
                ...baseContext,
                interactive: false,
                autoConfirm: false,
            };

            const result = await runner.execute(
                'confirm_action',
                { action: 'some action' },
                context,
            );

            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('user_cancelled');
        });

        it('auto-approves without TTY when --no-confirm is set', async () => {
            const context = {
                sessionId: 'ses_test',
                workspaceRoot: '/tmp/test',
                interactive: false,
                autoConfirm: true,
            };

            const result = await runner.execute(
                'confirm_action',
                { action: 'some action' },
                context,
            );

            expect(result.status).toBe('success');
            const data = JSON.parse(result.data);
            expect(data.approved).toBe(true);
            expect(result.yieldOutcome).toBeUndefined();
        });
    });

    describe('sub-agent context', () => {
        it('denies with not permitted by agent profile', async () => {
            const context = {
                ...baseContext,
                isSubAgent: true,
            };

            const result = await runner.execute(
                'confirm_action',
                { action: 'test' },
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
                promptUser: async () => { throw new Error('terminal disconnected'); },
            };

            const result = await runner.execute(
                'confirm_action',
                { action: 'test action' },
                context,
            );

            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('user_cancelled');
            expect(result.error!.message).toContain('terminal disconnected');
        });
    });

    describe('input validation', () => {
        it('rejects missing action', async () => {
            const result = await runner.execute('confirm_action', {}, baseContext);
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });

        it('rejects empty action', async () => {
            const result = await runner.execute(
                'confirm_action',
                { action: '' },
                baseContext,
            );
            expect(result.status).toBe('error');
            expect(result.error!.code).toBe('tool.validation');
        });
    });
});
