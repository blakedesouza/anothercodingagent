/**
 * Tests for M7A.5.1: Structured Witness Finding Schema
 *
 * Covers: valid finding parse/round-trip, invalid payload rejection,
 * no_findings acceptance, raw witness text retention.
 */
import { describe, it, expect } from 'vitest';
import {
    parseWitnessOutput,
    buildWitnessReview,
    FINDING_SEVERITIES,
    FINDING_CONFIDENCES,
} from '../../src/review/witness-finding.js';
import type {
    WitnessFinding,
    FindingSeverity,
    FindingConfidence,
    FindingsResult,
    NoFindingsResult,
} from '../../src/review/witness-finding.js';

// --- Test fixtures ---

function makeFinding(overrides?: Partial<WitnessFinding>): WitnessFinding {
    return {
        findingId: 'F-001',
        severity: 'high',
        claim: 'Missing null check on user input',
        evidence: 'src/handler.ts line 42 dereferences req.body without guard',
        file: 'src/handler.ts',
        line: 42,
        confidence: 'high',
        recommendedAction: 'Add null/undefined check before dereferencing req.body',
        ...overrides,
    };
}

function makeFindings(findings: WitnessFinding[] = [makeFinding()]): string {
    return JSON.stringify({ type: 'findings', findings });
}

function makeNoFindings(residualRisk = 'Low risk — standard patterns used throughout'): string {
    return JSON.stringify({ type: 'no_findings', residualRisk });
}

// --- Valid finding JSON parses and round-trips without losing fields ---

describe('parseWitnessOutput — valid findings', () => {
    it('parses a single finding with all fields', () => {
        const finding = makeFinding();
        const result = parseWitnessOutput(makeFindings([finding]));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.type).toBe('findings');
        const fr = result.value as FindingsResult;
        expect(fr.findings).toHaveLength(1);
        expect(fr.findings[0]).toEqual(finding);
    });

    it('parses multiple findings with unique IDs', () => {
        const findings = [
            makeFinding({ findingId: 'F-001' }),
            makeFinding({ findingId: 'F-002', severity: 'medium', confidence: 'low' }),
            makeFinding({ findingId: 'F-003', severity: 'info', file: undefined, line: undefined }),
        ];
        const result = parseWitnessOutput(makeFindings(findings));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const fr = result.value as FindingsResult;
        expect(fr.findings).toHaveLength(3);
        expect(fr.findings[0].findingId).toBe('F-001');
        expect(fr.findings[1].findingId).toBe('F-002');
        expect(fr.findings[2].findingId).toBe('F-003');
    });

    it('preserves optional file and line when present', () => {
        const finding = makeFinding({ file: 'src/utils.ts', line: 99 });
        const result = parseWitnessOutput(makeFindings([finding]));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const fr = result.value as FindingsResult;
        expect(fr.findings[0].file).toBe('src/utils.ts');
        expect(fr.findings[0].line).toBe(99);
    });

    it('omits file and line when not present in input', () => {
        const finding = makeFinding({ file: undefined, line: undefined });
        const result = parseWitnessOutput(makeFindings([finding]));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const fr = result.value as FindingsResult;
        expect('file' in fr.findings[0]).toBe(false);
        expect('line' in fr.findings[0]).toBe(false);
    });

    it('round-trips: parsed findings match JSON.parse of input', () => {
        const finding = makeFinding();
        const raw = makeFindings([finding]);
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const fr = result.value as FindingsResult;
        // Re-serialize and compare
        const reserialized = JSON.stringify({ type: 'findings', findings: fr.findings });
        expect(JSON.parse(reserialized)).toEqual(JSON.parse(raw));
    });

    it('accepts all severity levels', () => {
        for (const severity of FINDING_SEVERITIES) {
            const result = parseWitnessOutput(makeFindings([makeFinding({ severity })]));
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect((result.value as FindingsResult).findings[0].severity).toBe(severity);
            }
        }
    });

    it('accepts all confidence levels', () => {
        for (const confidence of FINDING_CONFIDENCES) {
            const result = parseWitnessOutput(makeFindings([makeFinding({ confidence })]));
            expect(result.ok).toBe(true);
            if (result.ok) {
                expect((result.value as FindingsResult).findings[0].confidence).toBe(confidence);
            }
        }
    });
});

// --- Invalid severity/confidence/file-line payload rejected with typed validation error ---

describe('parseWitnessOutput — invalid payloads', () => {
    it('rejects non-JSON input', () => {
        const result = parseWitnessOutput('not json at all');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('not valid JSON');
    });

    it('rejects non-object JSON (array)', () => {
        const result = parseWitnessOutput('[]');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('must be a JSON object');
    });

    it('rejects non-object JSON (string)', () => {
        const result = parseWitnessOutput('"hello"');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('got string');
    });

    it('rejects JSON null with accurate error message', () => {
        const result = parseWitnessOutput('null');
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('got null');
        // Must NOT say "got object" — typeof null === 'object' is misleading
        expect(result.error.message).not.toContain('got object');
    });

    it('rejects unknown type', () => {
        const result = parseWitnessOutput(JSON.stringify({ type: 'review' }));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('"findings" or "no_findings"');
    });

    it('rejects missing type', () => {
        const result = parseWitnessOutput(JSON.stringify({ findings: [] }));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
    });

    it('rejects invalid severity', () => {
        const raw = makeFindings([makeFinding({ severity: 'urgent' as FindingSeverity })]);
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('severity');
        expect(result.error.message).toContain('urgent');
    });

    it('rejects invalid confidence', () => {
        const raw = makeFindings([makeFinding({ confidence: 'certain' as FindingConfidence })]);
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('confidence');
        expect(result.error.message).toContain('certain');
    });

    it('rejects negative line number', () => {
        const raw = makeFindings([makeFinding({ line: -5 })]);
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('line');
        expect(result.error.message).toContain('positive integer');
    });

    it('rejects zero line number', () => {
        const raw = makeFindings([makeFinding({ line: 0 })]);
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
    });

    it('rejects fractional line number', () => {
        const raw = makeFindings([makeFinding({ line: 3.5 })]);
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('positive integer');
    });

    it('rejects non-string file', () => {
        const input = { type: 'findings', findings: [{ ...makeFinding(), file: 123 }] };
        const result = parseWitnessOutput(JSON.stringify(input));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('file');
    });

    it('rejects empty findingId', () => {
        const raw = makeFindings([makeFinding({ findingId: '' })]);
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('findingId');
    });

    it('rejects empty claim', () => {
        const raw = makeFindings([makeFinding({ claim: '' })]);
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('claim');
    });

    it('rejects empty evidence', () => {
        const raw = makeFindings([makeFinding({ evidence: '' })]);
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('evidence');
    });

    it('rejects empty recommendedAction', () => {
        const raw = makeFindings([makeFinding({ recommendedAction: '' })]);
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('recommendedAction');
    });

    it('rejects duplicate findingIds', () => {
        const raw = makeFindings([
            makeFinding({ findingId: 'F-001' }),
            makeFinding({ findingId: 'F-001', claim: 'Different claim' }),
        ]);
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('Duplicate findingId');
        expect(result.error.message).toContain('F-001');
    });

    it('rejects empty findings array (use no_findings instead)', () => {
        const raw = JSON.stringify({ type: 'findings', findings: [] });
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('must not be empty');
        expect(result.error.message).toContain('no_findings');
    });

    it('rejects non-array findings field', () => {
        const raw = JSON.stringify({ type: 'findings', findings: 'oops' });
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('findings array');
    });

    it('rejects finding that is not an object', () => {
        const raw = JSON.stringify({ type: 'findings', findings: ['not an object'] });
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('expected object');
    });
});

// --- no_findings response accepted and rendered distinctly from "watchdog failed" ---

describe('parseWitnessOutput — no_findings', () => {
    it('accepts valid no_findings with residual risk', () => {
        const result = parseWitnessOutput(makeNoFindings());
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.type).toBe('no_findings');
        const nf = result.value as NoFindingsResult;
        expect(nf.residualRisk).toBe('Low risk — standard patterns used throughout');
    });

    it('rejects no_findings without residualRisk', () => {
        const raw = JSON.stringify({ type: 'no_findings' });
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('residualRisk');
    });

    it('rejects no_findings with empty residualRisk', () => {
        const raw = JSON.stringify({ type: 'no_findings', residualRisk: '' });
        const result = parseWitnessOutput(raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('tool.validation');
        expect(result.error.message).toContain('residualRisk');
    });

    it('no_findings result is structurally distinct from findings result', () => {
        const nfResult = parseWitnessOutput(makeNoFindings());
        const fResult = parseWitnessOutput(makeFindings());
        expect(nfResult.ok).toBe(true);
        expect(fResult.ok).toBe(true);
        if (!nfResult.ok || !fResult.ok) return;
        expect(nfResult.value.type).toBe('no_findings');
        expect(fResult.value.type).toBe('findings');
        // Discriminated union allows narrowing
        expect('residualRisk' in nfResult.value).toBe(true);
        expect('findings' in fResult.value).toBe(true);
    });
});

// --- Raw witness text is retained even when structured parsing succeeds ---

describe('buildWitnessReview — raw output preservation', () => {
    it('preserves raw output on successful parse', () => {
        const raw = makeFindings([makeFinding()]);
        const result = buildWitnessReview('witness-1', 'minimax-m2.7', raw);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.review.rawOutput).toBe(raw);
        expect(result.review.parsed.type).toBe('findings');
    });

    it('preserves raw output on no_findings parse', () => {
        const raw = makeNoFindings('Minimal risk');
        const result = buildWitnessReview('witness-2', 'kimi-k2.5', raw);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.review.rawOutput).toBe(raw);
        expect(result.review.parsed.type).toBe('no_findings');
    });

    it('returns raw output alongside error on validation failure', () => {
        const raw = 'totally broken json {{{}';
        const result = buildWitnessReview('witness-3', 'qwen-3.5', raw);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.rawOutput).toBe(raw);
        expect(result.error.code).toBe('tool.validation');
    });

    it('populates witnessId, model, and parsedAt timestamp', () => {
        const before = new Date().toISOString();
        const raw = makeFindings([makeFinding()]);
        const result = buildWitnessReview('w-alpha', 'gemma-4-31b', raw);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.review.witnessId).toBe('w-alpha');
        expect(result.review.model).toBe('gemma-4-31b');
        // parsedAt should be a valid ISO-8601 timestamp
        const ts = new Date(result.review.parsedAt);
        expect(ts.getTime()).not.toBeNaN();
        expect(result.review.parsedAt >= before).toBe(true);
    });

    it('raw output is the exact input string, not re-serialized', () => {
        // Use a string with whitespace formatting that JSON.stringify would change
        const raw = '{\n  "type": "no_findings",\n  "residualRisk": "All good"\n}';
        const result = buildWitnessReview('w-1', 'model-x', raw);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.review.rawOutput).toBe(raw);
        // Verify it's not re-serialized (would lose formatting)
        expect(result.review.rawOutput).toContain('\n  ');
    });
});
