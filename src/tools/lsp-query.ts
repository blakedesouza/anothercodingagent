/**
 * lsp_query tool (Block 2: Code Intelligence, M7.3).
 *
 * One tool, multiple operations. The LLM specifies which LSP operation it wants:
 * hover, definition, references, diagnostics, symbols, completions, rename.
 *
 * Approval class: read-only (no side effects, auto-approved).
 * Rename returns preview only (WorkspaceEdit) — does not apply edits.
 *
 * Health integration: crash → M7.13 health state update → M7.7c tool masking.
 * capabilityId is dynamically set per-language (e.g., 'lsp:typescript').
 */

import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import type { LspManager } from '../lsp/lsp-manager.js';
import {
    LspUnavailableError,
    LspWarmingUpError,
    LspCrashedError,
    type LspOperation,
} from '../lsp/lsp-client.js';

// --- Tool spec ---

export const lspQuerySpec: ToolSpec = {
    name: 'lsp_query',
    description:
        'Query a language server for code intelligence. Operations: hover (type info), ' +
        'definition (go to definition), references (find all references), diagnostics ' +
        '(file errors/warnings), symbols (document symbols), completions (code completion), ' +
        'rename (preview rename refactoring without applying).',
    inputSchema: {
        type: 'object',
        properties: {
            operation: {
                type: 'string',
                enum: ['hover', 'definition', 'references', 'diagnostics', 'symbols', 'completions', 'rename'],
                description: 'The LSP operation to perform.',
            },
            file: {
                type: 'string',
                minLength: 1,
                description: 'Relative path to the file within the workspace.',
            },
            line: {
                type: 'integer',
                minimum: 1,
                description: 'Line number (1-indexed). Required for hover, definition, references, completions, rename.',
            },
            character: {
                type: 'integer',
                minimum: 1,
                description: 'Column number (1-indexed). Required for hover, definition, references, completions, rename.',
            },
            newName: {
                type: 'string',
                minLength: 1,
                description: 'New name for rename operation. Required when operation is "rename".',
            },
        },
        required: ['operation', 'file'],
        additionalProperties: false,
    },
    approvalClass: 'read-only',
    idempotent: true,
    timeoutCategory: 'lsp',
    // capabilityId is set dynamically per-language when the tool is masked.
    // For masking, we use the generic 'lsp' prefix — individual servers register
    // their own capability IDs (e.g., 'lsp:typescript') in the health map.
};

// --- Helpers ---

function successOutput(data: unknown): ToolOutput {
    const json = JSON.stringify(data);
    return {
        status: 'success',
        data: json,
        truncated: false,
        bytesReturned: Buffer.byteLength(json, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    };
}

function errorOutput(code: string, message: string, retryable = false): ToolOutput {
    return {
        status: 'error',
        data: '',
        error: { code, message, retryable },
        truncated: false,
        bytesReturned: 0,
        bytesOmitted: 0,
        retryable,
        timedOut: false,
        mutationState: 'none',
    };
}

// --- Dependencies interface ---

export interface LspQueryDeps {
    lspManager: LspManager;
}

// --- Validation ---

const POSITION_REQUIRED_OPS: LspOperation[] = ['hover', 'definition', 'references', 'completions', 'rename'];

function validateArgs(args: Record<string, unknown>): string | null {
    const op = args.operation as LspOperation;
    const file = args.file as string;

    if (!file || typeof file !== 'string') {
        return 'Missing required parameter: file';
    }

    if (POSITION_REQUIRED_OPS.includes(op)) {
        if (typeof args.line !== 'number' || args.line < 1) {
            return `Parameter "line" is required for operation "${op}" (1-indexed integer)`;
        }
        if (typeof args.character !== 'number' || args.character < 1) {
            return `Parameter "character" is required for operation "${op}" (1-indexed integer)`;
        }
    }

    if (op === 'rename' && (!args.newName || typeof args.newName !== 'string')) {
        return 'Parameter "newName" is required for rename operation';
    }

    return null;
}

// --- Factory ---

/**
 * Create the lsp_query tool implementation with injected LspManager.
 */
export function createLspQueryImpl(deps: LspQueryDeps): ToolImplementation {
    return async (
        args: Record<string, unknown>,
        _context: ToolContext,
    ): Promise<ToolOutput> => {
        // Validate
        const validationError = validateArgs(args);
        if (validationError) {
            return errorOutput('tool.validation', validationError);
        }

        try {
            const result = await deps.lspManager.query({
                operation: args.operation as LspOperation,
                file: args.file as string,
                line: args.line as number | undefined,
                character: args.character as number | undefined,
                newName: args.newName as string | undefined,
            });

            return successOutput(result);
        } catch (err) {
            if (err instanceof LspUnavailableError) {
                return errorOutput(
                    'lsp_unavailable',
                    `${err.message}. Install hint: ${err.installHint}`,
                    false,
                );
            }

            if (err instanceof LspWarmingUpError) {
                return errorOutput('warming_up', err.message, true);
            }

            if (err instanceof LspCrashedError) {
                return errorOutput(
                    'lsp_crashed',
                    err.message,
                    false, // Session-terminal after second crash
                );
            }

            return errorOutput(
                'tool.execution',
                `LSP query failed: ${(err as Error).message}`,
                false,
            );
        }
    };
}
