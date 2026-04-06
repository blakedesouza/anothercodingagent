/**
 * M7A.5.1: Structured Witness Finding Schema
 *
 * Machine-readable types for witness review findings.
 * Deterministic TypeScript validation — no model-based repair at this layer.
 */

import { createAcaError, type AcaError } from '../types/errors.js';

// --- Severity & Confidence enums ---

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type FindingSeverity = typeof FINDING_SEVERITIES[number];

export const FINDING_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type FindingConfidence = typeof FINDING_CONFIDENCES[number];

// --- Witness Finding shape ---

export interface WitnessFinding {
    findingId: string;
    severity: FindingSeverity;
    claim: string;
    evidence: string;
    file?: string;
    line?: number;
    confidence: FindingConfidence;
    recommendedAction: string;
}

// --- Parsed result discriminated union ---

export interface FindingsResult {
    type: 'findings';
    findings: WitnessFinding[];
}

export interface NoFindingsResult {
    type: 'no_findings';
    residualRisk: string;
}

export type ParsedWitnessOutput = FindingsResult | NoFindingsResult;

// --- Full witness review (parsed + raw preserved) ---

export interface WitnessReview {
    witnessId: string;
    model: string;
    rawOutput: string;
    parsed: ParsedWitnessOutput;
    parsedAt: string; // ISO-8601
}

// --- Validation ---

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isString(v: unknown): v is string {
    return typeof v === 'string';
}

function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.length > 0;
}

/**
 * Validate a single witness finding object.
 * Returns null on success, or an error message describing the first issue.
 */
function validateFinding(input: unknown, index: number): string | null {
    if (!isObject(input)) {
        return `findings[${index}]: expected object, got ${typeof input}`;
    }

    // findingId — required non-empty string
    if (!isNonEmptyString(input.findingId)) {
        return `findings[${index}].findingId: required non-empty string`;
    }

    // severity — required enum
    if (!isString(input.severity) || !(FINDING_SEVERITIES as readonly string[]).includes(input.severity)) {
        return `findings[${index}].severity: must be one of ${FINDING_SEVERITIES.join(', ')}; got ${JSON.stringify(input.severity)}`;
    }

    // claim — required non-empty string
    if (!isNonEmptyString(input.claim)) {
        return `findings[${index}].claim: required non-empty string`;
    }

    // evidence — required non-empty string
    if (!isNonEmptyString(input.evidence)) {
        return `findings[${index}].evidence: required non-empty string`;
    }

    // file — optional string
    if (input.file !== undefined && !isString(input.file)) {
        return `findings[${index}].file: must be a string if provided`;
    }

    // line — optional positive integer
    if (input.line !== undefined) {
        if (typeof input.line !== 'number' || !Number.isInteger(input.line) || input.line < 1) {
            return `findings[${index}].line: must be a positive integer if provided`;
        }
    }

    // confidence — required enum
    if (!isString(input.confidence) || !(FINDING_CONFIDENCES as readonly string[]).includes(input.confidence)) {
        return `findings[${index}].confidence: must be one of ${FINDING_CONFIDENCES.join(', ')}; got ${JSON.stringify(input.confidence)}`;
    }

    // recommendedAction — required non-empty string
    if (!isNonEmptyString(input.recommendedAction)) {
        return `findings[${index}].recommendedAction: required non-empty string`;
    }

    return null;
}

/**
 * Parse and validate raw witness output into a ParsedWitnessOutput.
 *
 * Expected input shapes:
 *   { "type": "findings", "findings": [...] }
 *   { "type": "no_findings", "residualRisk": "..." }
 *
 * Returns { ok: true, value } on success, { ok: false, error } on validation failure.
 */
export function parseWitnessOutput(
    raw: string,
): { ok: true; value: ParsedWitnessOutput } | { ok: false; error: AcaError } {
    // Step 1: JSON parse
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return {
            ok: false,
            error: createAcaError('tool.validation', `Witness output is not valid JSON: ${(e as Error).message}`),
        };
    }

    if (!isObject(parsed)) {
        return {
            ok: false,
            error: createAcaError('tool.validation', `Witness output must be a JSON object, got ${parsed === null ? 'null' : typeof parsed}`),
        };
    }

    // Step 2: Discriminate by type
    if (parsed.type === 'no_findings') {
        if (!isNonEmptyString(parsed.residualRisk)) {
            return {
                ok: false,
                error: createAcaError('tool.validation', 'no_findings output requires a non-empty residualRisk string'),
            };
        }
        return {
            ok: true,
            value: { type: 'no_findings', residualRisk: parsed.residualRisk },
        };
    }

    if (parsed.type === 'findings') {
        if (!Array.isArray(parsed.findings)) {
            return {
                ok: false,
                error: createAcaError('tool.validation', 'findings output requires a findings array'),
            };
        }

        if (parsed.findings.length === 0) {
            return {
                ok: false,
                error: createAcaError('tool.validation', 'findings array must not be empty; use type "no_findings" for clean reviews'),
            };
        }

        // Validate each finding
        const validated: WitnessFinding[] = [];
        const seenIds = new Set<string>();

        for (let i = 0; i < parsed.findings.length; i++) {
            const item = parsed.findings[i];
            const err = validateFinding(item, i);
            if (err !== null) {
                return { ok: false, error: createAcaError('tool.validation', err) };
            }

            const finding = item as Record<string, unknown>;
            const findingId = finding.findingId as string;

            // Enforce unique findingId (one finding per distinct issue)
            if (seenIds.has(findingId)) {
                return {
                    ok: false,
                    error: createAcaError('tool.validation', `Duplicate findingId: "${findingId}" at findings[${i}]`),
                };
            }
            seenIds.add(findingId);

            validated.push({
                findingId,
                severity: finding.severity as FindingSeverity,
                claim: finding.claim as string,
                evidence: finding.evidence as string,
                ...(finding.file !== undefined ? { file: finding.file as string } : {}),
                ...(finding.line !== undefined ? { line: finding.line as number } : {}),
                confidence: finding.confidence as FindingConfidence,
                recommendedAction: finding.recommendedAction as string,
            });
        }

        return { ok: true, value: { type: 'findings', findings: validated } };
    }

    // Unknown type
    return {
        ok: false,
        error: createAcaError(
            'tool.validation',
            `Witness output type must be "findings" or "no_findings"; got ${JSON.stringify(parsed.type)}`,
        ),
    };
}

/**
 * Build a complete WitnessReview from raw output.
 * Preserves the raw text regardless of parse success/failure.
 */
export function buildWitnessReview(
    witnessId: string,
    model: string,
    rawOutput: string,
): { ok: true; review: WitnessReview } | { ok: false; error: AcaError; rawOutput: string } {
    const result = parseWitnessOutput(rawOutput);
    if (!result.ok) {
        return { ok: false, error: result.error, rawOutput };
    }
    return {
        ok: true,
        review: {
            witnessId,
            model,
            rawOutput,
            parsed: result.value,
            parsedAt: new Date().toISOString(),
        },
    };
}
