import type { ModelRequest } from '../types/provider.js';

// --- Constants (Block 7) ---

/** Default bytes-per-token ratio for the byte-based heuristic. */
const DEFAULT_BYTES_PER_TOKEN = 3.0;

/** Fixed overhead per message envelope in a request. */
export const MESSAGE_OVERHEAD = 12;

/** Fixed overhead per tool call or tool result item. */
export const TOOL_CALL_OVERHEAD = 24;

/** Fixed overhead per tool schema definition. */
export const TOOL_SCHEMA_OVERHEAD = 40;

/** Default reserved output tokens (max_tokens for response). */
const DEFAULT_RESERVED_OUTPUT = 4096;

/** EMA smoothing factor — controls how fast calibration converges. */
const EMA_ALPHA = 0.3;

// --- Token estimation (pure functions) ---

/**
 * Estimate token count for a text string using byte-based heuristic.
 * Returns ceil(utf8ByteLength / bytesPerToken).
 */
export function estimateTextTokens(text: string, bytesPerToken: number = DEFAULT_BYTES_PER_TOKEN): number {
    if (text.length === 0) return 0;
    if (!Number.isFinite(bytesPerToken) || bytesPerToken <= 0) {
        throw new RangeError(`bytesPerToken must be a positive finite number, got ${bytesPerToken}`);
    }
    const byteLength = Buffer.byteLength(text, 'utf8');
    return Math.ceil(byteLength / bytesPerToken);
}

/**
 * Estimate tokens for a full ModelRequest including structural overheads.
 * Applies calibration multiplier if provided.
 */
export function estimateRequestTokens(
    request: ModelRequest,
    bytesPerToken: number = DEFAULT_BYTES_PER_TOKEN,
    calibrationMultiplier: number = 1.0,
): number {
    let total = 0;

    // Message content + per-message overhead
    for (const msg of request.messages) {
        total += MESSAGE_OVERHEAD;
        if (typeof msg.content === 'string') {
            total += estimateTextTokens(msg.content, bytesPerToken);
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                switch (part.type) {
                    case 'text':
                        if (part.text) {
                            total += estimateTextTokens(part.text, bytesPerToken);
                        }
                        break;
                    case 'tool_call':
                        total += TOOL_CALL_OVERHEAD;
                        if (part.arguments) {
                            total += estimateTextTokens(JSON.stringify(part.arguments), bytesPerToken);
                        }
                        break;
                    case 'tool_result':
                        total += TOOL_CALL_OVERHEAD;
                        if (part.text) {
                            total += estimateTextTokens(part.text, bytesPerToken);
                        }
                        break;
                }
            }
        }
    }

    // Tool schema overheads
    if (request.tools) {
        for (const tool of request.tools) {
            total += TOOL_SCHEMA_OVERHEAD;
            total += estimateTextTokens(tool.description, bytesPerToken);
            total += estimateTextTokens(JSON.stringify(tool.parameters), bytesPerToken);
        }
    }

    return Math.ceil(total * calibrationMultiplier);
}

// --- EMA Calibration ---

export interface CalibrationState {
    /** Current calibration multiplier. Starts at 1.0. */
    multiplier: number;
    /** Number of data points fed into the EMA. */
    sampleCount: number;
}

/** Create initial calibration state (no calibration data). */
export function createCalibrationState(): CalibrationState {
    return { multiplier: 1.0, sampleCount: 0 };
}

/**
 * Update calibration EMA with a new actual/estimated pair.
 * If actual or estimated is 0 or negative, the update is skipped.
 * Returns a new CalibrationState (immutable).
 */
export function updateCalibration(
    state: CalibrationState,
    actual: number,
    estimated: number,
): CalibrationState {
    if (!Number.isFinite(actual) || !Number.isFinite(estimated) || actual <= 0 || estimated <= 0) return state;

    const ratio = actual / estimated;
    const newMultiplier = state.sampleCount === 0
        ? ratio // First sample: seed directly
        : state.multiplier * (1 - EMA_ALPHA) + ratio * EMA_ALPHA;

    return {
        multiplier: newMultiplier,
        sampleCount: state.sampleCount + 1,
    };
}

// --- Safe input budget ---

/**
 * Compute the safe input budget for a request.
 *
 * safeInputBudget = contextLimit - reservedOutputTokens - estimationGuard
 * where estimationGuard = max(512, ceil(contextLimit * 0.08))
 */
export function computeSafeInputBudget(
    contextLimit: number,
    reservedOutputTokens: number = DEFAULT_RESERVED_OUTPUT,
): number {
    const estimationGuard = Math.max(512, Math.ceil(contextLimit * 0.08));
    return contextLimit - reservedOutputTokens - estimationGuard;
}
