import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';

// --- Tool spec ---

export const askUserSpec: ToolSpec = {
    name: 'ask_user',
    description:
        'Ask the user a freeform question or present a list of choices and wait for their response. ' +
        'Set format=\'choice\' and provide a choices array to restrict the user to one of the listed options; omit choices or use format=\'freeform\' for an open-ended answer. ' +
        'The current agent turn is suspended until the user replies.',
    inputSchema: {
        type: 'object',
        properties: {
            question: { type: 'string', minLength: 1 },
            choices: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
                minItems: 1,
            },
            format: { type: 'string', enum: ['freeform', 'choice'] },
        },
        required: ['question'],
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

// --- Implementation ---

export const askUserImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    // Sub-agent check: ask_user is excluded from sub-agent tool profiles
    if (context.isSubAgent) {
        return errorOutput('tool.not_permitted', 'ask_user is not permitted by agent profile');
    }

    // TTY check: one-shot without TTY → user_cancelled
    if (context.interactive === false) {
        return errorOutput('user_cancelled', 'ask_user requires interactive mode (TTY)');
    }

    // Must have a promptUser function to interact with the user
    if (!context.promptUser) {
        return errorOutput('tool.internal', 'No user prompt function available');
    }

    const question = args.question as string;
    const choices = args.choices as string[] | undefined;

    let response: string;
    try {
        response = await context.promptUser(question, choices);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'User prompt failed';
        return errorOutput('user_cancelled', message);
    }

    const data = JSON.stringify({ response });
    return {
        status: 'success',
        data,
        truncated: false,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
        yieldOutcome: 'awaiting_user',
    };
};
