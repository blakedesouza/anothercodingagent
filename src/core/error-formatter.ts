/**
 * Mode-dependent error formatting.
 *
 * Interactive: compact single-line on stderr with error code in brackets.
 * One-shot: prefixed with "aca:" for machine parsing.
 * Executor: structured JSON on stdout with turnOutcome and sessionId.
 */

import type { AcaError } from '../types/errors.js';
import { getErrorCategory } from '../types/errors.js';

/**
 * Interactive mode: compact stderr line.
 * Example: "! read_file failed: file not found — /src/missing.ts [tool.not_found]"
 */
export function formatErrorInteractive(error: AcaError): string {
    const category = getErrorCategory(error.code);
    if (category === 'tool') {
        const toolName = (error.details?.toolName as string) ?? '';
        const prefix = toolName ? `${toolName} failed: ` : '';
        return `! ${prefix}${error.message} [${error.code}]`;
    }
    if (category === 'llm') {
        return `! LLM error: ${error.message} [${error.code}]`;
    }
    if (category === 'delegation') {
        return `! Delegation error: ${error.message} [${error.code}]`;
    }
    // system
    return `! ${error.message} [${error.code}]`;
}

/**
 * One-shot mode: prefixed for machine parsing.
 * Example: "aca: error: tool.timeout — exec_command timed out after 60s"
 */
export function formatErrorOneShot(error: AcaError): string {
    return `aca: error: ${error.code} — ${error.message}`;
}

/**
 * Executor mode: structured JSON.
 */
export function formatErrorExecutor(
    error: AcaError,
    turnOutcome: string,
    sessionId: string,
): string {
    return JSON.stringify({
        status: 'error',
        error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(error.details !== undefined ? { details: error.details } : {}),
        },
        turnOutcome,
        sessionId,
    });
}
