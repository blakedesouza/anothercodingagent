import { readFile, stat } from 'node:fs/promises';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { checkZone, resolveToolPath } from './workspace-sandbox.js';
import { estimateTextTokens, computeSafeInputBudget } from '../core/token-estimator.js';
import { getModelCapabilities } from '../providers/model-registry.js';

// --- Constants ---

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MiB — same as read_file

// --- Tool spec ---

export const estimateTokensSpec: ToolSpec = {
    name: 'estimate_tokens',
    description: 'Estimate the token count for text or file contents. Returns the estimated count and whether it fits in the model context window.',
    inputSchema: {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'Text to estimate tokens for' },
            file_paths: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
                description: 'File paths to read and estimate tokens for',
            },
            model: { type: 'string', description: 'Model ID for per-model bytesPerToken and context limit' },
        },
        additionalProperties: false,
    },
    approvalClass: 'read-only',
    idempotent: true,
    timeoutCategory: 'file',
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

export const estimateTokensImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const text = args.text as string | undefined;
    const filePaths = args.file_paths as string[] | undefined;
    const modelId = args.model as string | undefined;

    // Must provide at least one input
    if (text === undefined && (!filePaths || filePaths.length === 0)) {
        return errorOutput('tool.invalid_input', 'Must provide either "text" or "file_paths" (or both)');
    }

    // Resolve per-model bytesPerToken and context limit
    let bytesPerToken = 3.0;
    let contextLimit: number | undefined;
    if (modelId) {
        const caps = getModelCapabilities(modelId);
        if (caps) {
            bytesPerToken = caps.bytesPerToken;
            contextLimit = caps.maxContext;
        }
    }

    let totalTokens = 0;
    const fileResults: Array<{ path: string; tokens: number; error?: string }> = [];

    // Estimate text tokens
    if (text) {
        totalTokens += estimateTextTokens(text, bytesPerToken);
    }

    // Estimate file tokens
    if (filePaths) {
        for (const filePath of filePaths) {
            // Zone check
            const denied = await checkZone(filePath, context);
            if (denied) {
                fileResults.push({ path: filePath, tokens: 0, error: 'outside sandbox' });
                continue;
            }
            const targetPath = resolveToolPath(filePath, context);

            try {
                const fileStats = await stat(targetPath);
                if (!fileStats.isFile()) {
                    fileResults.push({ path: filePath, tokens: 0, error: 'not a regular file' });
                    continue;
                }
                if (fileStats.size > MAX_FILE_SIZE) {
                    fileResults.push({ path: filePath, tokens: 0, error: `exceeds ${MAX_FILE_SIZE} byte limit` });
                    continue;
                }

                const content = await readFile(targetPath, 'utf8');
                const tokens = estimateTextTokens(content, bytesPerToken);
                totalTokens += tokens;
                fileResults.push({ path: filePath, tokens });
            } catch (err: unknown) {
                const nodeErr = err as NodeJS.ErrnoException;
                fileResults.push({ path: filePath, tokens: 0, error: nodeErr.code ?? 'unknown error' });
            }
        }
    }

    // Compute fits-in-context
    let fitsInContext: boolean | null = null;
    let safeBudget: number | undefined;
    if (contextLimit !== undefined) {
        safeBudget = computeSafeInputBudget(contextLimit);
        fitsInContext = totalTokens <= safeBudget;
    }

    const result: Record<string, unknown> = {
        totalTokens,
        bytesPerToken,
        fitsInContext,
    };
    if (safeBudget !== undefined) {
        result.safeBudget = safeBudget;
    }
    if (fileResults.length > 0) {
        result.files = fileResults;
    }

    const data = JSON.stringify(result);
    return {
        status: 'success',
        data,
        truncated: false,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    };
};
