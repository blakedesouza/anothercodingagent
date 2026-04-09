import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';

// --- Tool spec ---

export const confirmActionSpec: ToolSpec = {
    name: 'confirm_action',
    description: 'Request explicit approval for a risky or destructive action. Yields the turn with approval_required outcome.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', minLength: 1 },
            affected_paths: {
                type: 'array',
                items: { type: 'string' },
            },
            risk_summary: { type: 'string', minLength: 1 },
        },
        required: ['action'],
        additionalProperties: false,
    },
    approvalClass: 'user-facing',
    idempotent: false,
    timeoutCategory: 'user',
};

// --- Helpers ---

function errorOutput(code: string, message: string): ToolOutput {
    return {
        status: 'error',
        data: '',
        error: { code, message, retryable: false },
        truncated: false,
        bytesReturned: 0,
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    };
}

function successOutput(
    dataObj: Record<string, unknown>,
    yieldOutcome?: ToolOutput['yieldOutcome'],
): ToolOutput {
    const data = JSON.stringify(dataObj);
    return {
        status: 'success',
        data,
        truncated: false,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
        ...(yieldOutcome ? { yieldOutcome } : {}),
    };
}

// --- Implementation ---

export const confirmActionImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    // Sub-agent check: confirm_action is excluded from sub-agent tool profiles
    if (context.isSubAgent) {
        return errorOutput('tool.not_permitted', 'confirm_action is not permitted by agent profile');
    }

    // Auto-confirm mode (--no-confirm flag)
    if (context.autoConfirm) {
        return successOutput({ approved: true });
    }

    // TTY check: one-shot without TTY → user_cancelled
    if (context.interactive === false) {
        return errorOutput('user_cancelled', 'confirm_action requires interactive mode (TTY) or --no-confirm');
    }

    // Must have a promptUser function to interact with the user
    if (!context.promptUser) {
        return errorOutput('tool.internal', 'No user prompt function available');
    }

    const action = args.action as string;
    const affectedPaths = args.affected_paths as string[] | undefined;
    const riskSummary = args.risk_summary as string | undefined;

    // Build the confirmation prompt
    let prompt = `Confirm action: ${action}`;
    if (affectedPaths && affectedPaths.length > 0) {
        prompt += `\nAffected paths: ${affectedPaths.join(', ')}`;
    }
    if (riskSummary) {
        prompt += `\nRisk: ${riskSummary}`;
    }
    prompt += '\nApprove? (yes/no)';

    let response: string;
    try {
        response = await context.promptUser(prompt);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'User prompt failed';
        return errorOutput('user_cancelled', message);
    }

    const approved = ['yes', 'y'].includes(response.toLowerCase().trim());

    return successOutput({ approved }, 'approval_required');
};
