/**
 * Error taxonomy for ACA — 22 codes across 4 categories.
 * All errors use the shared AcaError shape: code, message, retryable, details, cause.
 *
 * Error codes use two-level dot-notation (category.type). Categories:
 *   tool.*        — tool execution failures
 *   llm.*         — LLM provider failures
 *   delegation.*  — sub-agent failures
 *   system.*      — runtime/infrastructure failures
 */

// --- Error code constants ---

export type ErrorCategory = 'tool' | 'llm' | 'delegation' | 'system';

export const TOOL_ERRORS = {
    NOT_FOUND: 'tool.not_found',
    VALIDATION: 'tool.validation',
    EXECUTION: 'tool.execution',
    TIMEOUT: 'tool.timeout',
    PERMISSION: 'tool.permission',
    SANDBOX: 'tool.sandbox',
} as const;

export const LLM_ERRORS = {
    RATE_LIMIT: 'llm.rate_limit',
    SERVER_ERROR: 'llm.server_error',
    TIMEOUT: 'llm.timeout',
    MALFORMED: 'llm.malformed',
    CONTEXT_LENGTH: 'llm.context_length',
    AUTH_ERROR: 'llm.auth_error',
    CONTENT_FILTERED: 'llm.content_filtered',
    CONFUSED: 'llm.confused',
} as const;

export const DELEGATION_ERRORS = {
    SPAWN_FAILED: 'delegation.spawn_failed',
    TIMEOUT: 'delegation.timeout',
    DEPTH_EXCEEDED: 'delegation.depth_exceeded',
    MESSAGE_FAILED: 'delegation.message_failed',
} as const;

export const SYSTEM_ERRORS = {
    IO_ERROR: 'system.io_error',
    CONFIG_ERROR: 'system.config_error',
    BUDGET_EXCEEDED: 'system.budget_exceeded',
    INTERNAL: 'system.internal',
} as const;

type ToolErrorCode = typeof TOOL_ERRORS[keyof typeof TOOL_ERRORS];
type LlmErrorCode = typeof LLM_ERRORS[keyof typeof LLM_ERRORS];
type DelegationErrorCode = typeof DELEGATION_ERRORS[keyof typeof DELEGATION_ERRORS];
type SystemErrorCode = typeof SYSTEM_ERRORS[keyof typeof SYSTEM_ERRORS];

export type ErrorCode = ToolErrorCode | LlmErrorCode | DelegationErrorCode | SystemErrorCode;

/** All 22 error codes as a flat array. */
export const ALL_ERROR_CODES: readonly ErrorCode[] = [
    ...Object.values(TOOL_ERRORS),
    ...Object.values(LLM_ERRORS),
    ...Object.values(DELEGATION_ERRORS),
    ...Object.values(SYSTEM_ERRORS),
] as const;

// --- AcaError shape ---

export interface AcaError {
    code: ErrorCode | string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
    cause?: AcaError;
}

/** Create an AcaError with the canonical shape. */
export function createAcaError(
    code: ErrorCode | string,
    message: string,
    opts?: { retryable?: boolean; details?: Record<string, unknown>; cause?: AcaError },
): AcaError {
    return {
        code,
        message,
        retryable: opts?.retryable ?? false,
        ...(opts?.details !== undefined ? { details: opts.details } : {}),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
    };
}

/** Serialize an AcaError to a plain JSON-safe object. Depth-limited to prevent stack overflow on circular cause chains. */
export function serializeAcaError(error: AcaError, depth = 0): Record<string, unknown> {
    if (depth > 10) {
        return { code: 'system.internal', message: '[cause chain too deep]', retryable: false };
    }
    const obj: Record<string, unknown> = {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
    };
    if (error.details !== undefined) obj.details = error.details;
    if (error.cause !== undefined) obj.cause = serializeAcaError(error.cause, depth + 1);
    return obj;
}

/** Check if a string is a valid ErrorCode. */
export function isValidErrorCode(code: string): code is ErrorCode {
    return (ALL_ERROR_CODES as readonly string[]).includes(code);
}

/** Extract the category from a dot-notation error code. */
export function getErrorCategory(code: string): ErrorCategory | undefined {
    const dot = code.indexOf('.');
    if (dot === -1) return undefined;
    const cat = code.slice(0, dot);
    if (cat === 'tool' || cat === 'llm' || cat === 'delegation' || cat === 'system') {
        return cat;
    }
    return undefined;
}

// --- Delegation error chain helper ---

/**
 * Wrap a child agent's error as a delegation error with nested cause.
 * Used for root-cause traversal across delegation depth levels.
 *
 * Example: grandchild llm.auth_error → child delegation.message_failed → root delegation.message_failed
 * Each level preserves the original error in `cause` so the root can pattern-match on the leaf cause.
 */
export function wrapDelegationError(childError: AcaError, message?: string): AcaError {
    return createAcaError(
        DELEGATION_ERRORS.MESSAGE_FAILED,
        message ?? `Delegation failed: ${childError.message}`,
        { retryable: childError.retryable, cause: childError },
    );
}

// --- Throwable Error subclass ---

/**
 * Throwable Error subclass that carries AcaError fields.
 * Used where typed errors need to cross function boundaries via throw/catch.
 */
export class TypedError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;
    readonly acaCause?: AcaError;

    constructor(error: AcaError, nativeCause?: unknown) {
        super(error.message, nativeCause !== undefined ? { cause: nativeCause } : undefined);
        this.name = 'TypedError';
        this.code = error.code;
        this.retryable = error.retryable;
        this.details = error.details;
        this.acaCause = error.cause;
    }

    toAcaError(): AcaError {
        return {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...(this.details !== undefined ? { details: this.details } : {}),
            ...(this.acaCause !== undefined ? { cause: this.acaCause } : {}),
        };
    }
}
