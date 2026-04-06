/**
 * Tests for M7A.5.2: Review Aggregator
 *
 * Covers: deduplication clustering, minority dissent preservation,
 * budget enforcement, evidence pointers, disagreement detection,
 * empty/no_findings handling, and text similarity utilities.
 */
import { describe, it, expect } from 'vitest';
import {
    aggregateReviews,
    tokenize,
    jaccardSimilarity,
    DEFAULT_AGGREGATOR_CONFIG,
} from '../../src/review/aggregator.js';
import type {
    WitnessReview,
    WitnessFinding,
} from '../../src/review/witness-finding.js';

// --- Test helpers ---

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

function makeReview(
    witnessId: string,
    model: string,
    findings: WitnessFinding[],
): WitnessReview {
    return {
        witnessId,
        model,
        rawOutput: JSON.stringify({ type: 'findings', findings }),
        parsed: { type: 'findings', findings },
        parsedAt: new Date().toISOString(),
    };
}

function makeNoFindingsReview(witnessId: string, model: string): WitnessReview {
    return {
        witnessId,
        model,
        rawOutput: JSON.stringify({ type: 'no_findings', residualRisk: 'Low risk' }),
        parsed: { type: 'no_findings', residualRisk: 'Low risk' },
        parsedAt: new Date().toISOString(),
    };
}

// --- Utility tests ---

describe('tokenize', () => {
    it('lowercases and splits on whitespace', () => {
        const tokens = tokenize('Missing Null Check');
        expect(tokens).toEqual(new Set(['missing', 'null', 'check']));
    });

    it('strips punctuation', () => {
        const tokens = tokenize('src/handler.ts: line 42, dereferences req.body!');
        expect(tokens.has('srchandlerts')).toBe(true);
        expect(tokens.has('dereferences')).toBe(true);
    });

    it('returns empty set for empty string', () => {
        expect(tokenize('')).toEqual(new Set());
    });
});

describe('jaccardSimilarity', () => {
    it('returns 1 for identical sets', () => {
        const s = new Set(['a', 'b', 'c']);
        expect(jaccardSimilarity(s, s)).toBe(1);
    });

    it('returns 0 for disjoint sets', () => {
        expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
    });

    it('returns 0 for two empty sets', () => {
        expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
    });

    it('computes correct overlap ratio', () => {
        const a = new Set(['a', 'b', 'c', 'd']);
        const b = new Set(['c', 'd', 'e', 'f']);
        // intersection = {c,d} = 2, union = {a,b,c,d,e,f} = 6
        expect(jaccardSimilarity(a, b)).toBeCloseTo(2 / 6);
    });
});

// --- Core aggregation tests (from step file) ---

describe('aggregateReviews — deduplication clustering', () => {
    it('4 witnesses report same bug with slightly different wording → one deduped cluster with all witness IDs', () => {
        const reviews: WitnessReview[] = [
            makeReview('w1', 'minimax', [
                makeFinding({
                    findingId: 'W1-F1',
                    claim: 'Missing null check on user input in handler',
                    file: 'src/handler.ts',
                    line: 42,
                }),
            ]),
            makeReview('w2', 'kimi', [
                makeFinding({
                    findingId: 'W2-F1',
                    claim: 'No null check for user input validation in handler',
                    file: 'src/handler.ts',
                    line: 43,
                }),
            ]),
            makeReview('w3', 'qwen', [
                makeFinding({
                    findingId: 'W3-F1',
                    claim: 'User input not checked for null before use in handler',
                    file: 'src/handler.ts',
                    line: 42,
                }),
            ]),
            makeReview('w4', 'gemma', [
                makeFinding({
                    findingId: 'W4-F1',
                    claim: 'Missing null guard on user input in handler function',
                    file: 'src/handler.ts',
                    line: 44,
                }),
            ]),
        ];

        const report = aggregateReviews(reviews);
        expect(report.clusters).toHaveLength(1);
        expect(report.clusters[0].witnesses).toHaveLength(4);
        expect(report.clusters[0].agreementCount).toBe(4);

        const witnessIds = report.clusters[0].witnesses.map(w => w.witnessId).sort();
        expect(witnessIds).toEqual(['w1', 'w2', 'w3', 'w4']);
    });
});

describe('aggregateReviews — minority dissent preservation', () => {
    it('1 minority high-confidence finding + 3 witnesses miss it → minority finding still appears', () => {
        // 3 witnesses report one shared bug, 1 witness also finds a unique bug
        const sharedFinding = makeFinding({
            findingId: 'SHARED',
            claim: 'SQL injection in login query',
            file: 'src/auth.ts',
            line: 100,
            severity: 'critical',
        });

        const reviews: WitnessReview[] = [
            makeReview('w1', 'minimax', [
                makeFinding({ ...sharedFinding, findingId: 'W1-S' }),
            ]),
            makeReview('w2', 'kimi', [
                makeFinding({ ...sharedFinding, findingId: 'W2-S' }),
                // Unique finding only w2 reports
                makeFinding({
                    findingId: 'W2-UNIQUE',
                    claim: 'Race condition in session token refresh',
                    file: 'src/session.ts',
                    line: 55,
                    severity: 'high',
                    confidence: 'high',
                }),
            ]),
            makeReview('w3', 'qwen', [
                makeFinding({ ...sharedFinding, findingId: 'W3-S' }),
            ]),
            makeReview('w4', 'gemma', [
                makeFinding({ ...sharedFinding, findingId: 'W4-S' }),
            ]),
        ];

        const report = aggregateReviews(reviews);

        // The shared finding should be clustered
        const sharedCluster = report.clusters.find(c => c.agreementCount >= 3);
        expect(sharedCluster).toBeDefined();

        // The minority finding should still appear
        const minorityCluster = report.clusters.find(
            c => c.witnesses.length === 1 && c.witnesses[0].witnessId === 'w2',
        );
        expect(minorityCluster).toBeDefined();
        expect(minorityCluster!.canonicalClaim).toContain('Race condition');
        expect(minorityCluster!.confidence).toBe('high');
    });
});

describe('aggregateReviews — budget enforcement', () => {
    it('output stays under configurable budget while preserving all P0/P1 items', () => {
        // Create many findings to exceed a small budget
        const findings: WitnessFinding[] = [];
        for (let i = 0; i < 20; i++) {
            findings.push(
                makeFinding({
                    findingId: `F-${i}`,
                    claim: `Finding number ${i} about a different low-severity issue in the codebase`,
                    file: `src/file${i}.ts`,
                    line: i * 10,
                    severity: i < 2 ? 'critical' : 'low',
                    confidence: 'medium',
                }),
            );
        }

        const reviews: WitnessReview[] = [
            makeReview('w1', 'minimax', findings),
        ];

        // Very tight budget
        const report = aggregateReviews(reviews, { budgetChars: 2000 });

        expect(report.budgetUsed).toBeLessThanOrEqual(2000);
        expect(report.budgetLimit).toBe(2000);
        expect(report.budgetExceeded).toBe(false);

        // Critical findings must be preserved
        const criticalClusters = report.clusters.filter(c => c.severity === 'critical');
        expect(criticalClusters.length).toBe(2);

        // Some low-severity findings may have been trimmed
        expect(report.clusters.length).toBeLessThan(20);
    });

    it('budgetExceeded is true when critical/high findings alone exceed budget', () => {
        const findings: WitnessFinding[] = [];
        for (let i = 0; i < 10; i++) {
            findings.push(
                makeFinding({
                    findingId: `F-${i}`,
                    claim: `Critical security vulnerability number ${i} with very long detailed description`,
                    evidence: `Detailed evidence for finding ${i} that takes up significant space in the output report`,
                    file: `src/critical${i}.ts`,
                    line: i * 100,
                    severity: 'critical',
                    confidence: 'high',
                }),
            );
        }

        const reviews: WitnessReview[] = [makeReview('w1', 'minimax', findings)];
        // Impossibly tight budget — critical findings can't fit
        const report = aggregateReviews(reviews, { budgetChars: 100 });

        expect(report.budgetExceeded).toBe(true);
        // All critical findings still preserved despite exceeding budget
        expect(report.clusters.length).toBe(10);
    });
});

describe('aggregateReviews — evidence pointers', () => {
    it('raw evidence links/pointers are present for every aggregated finding', () => {
        const reviews: WitnessReview[] = [
            makeReview('w1', 'minimax', [
                makeFinding({ findingId: 'W1-F1', claim: 'Missing error handling in parser' }),
            ]),
            makeReview('w2', 'kimi', [
                makeFinding({ findingId: 'W2-F1', claim: 'Parser lacks error handling for malformed input' }),
            ]),
        ];

        const report = aggregateReviews(reviews);

        for (const cluster of report.clusters) {
            // Every cluster must have at least one witness pointer
            expect(cluster.witnesses.length).toBeGreaterThan(0);

            for (const wp of cluster.witnesses) {
                // Each pointer must have both witnessId and findingId
                expect(wp.witnessId).toBeTruthy();
                expect(wp.findingId).toBeTruthy();
            }
        }
    });
});

describe('aggregateReviews — disagreements section', () => {
    it('includes a disagreements section when witnesses conflict on severity', () => {
        // Two witnesses report the same bug but disagree on severity by >1 rank
        const reviews: WitnessReview[] = [
            makeReview('w1', 'minimax', [
                makeFinding({
                    findingId: 'W1-F1',
                    claim: 'Unvalidated redirect in auth callback',
                    file: 'src/auth.ts',
                    line: 30,
                    severity: 'critical',
                    confidence: 'high',
                }),
            ]),
            makeReview('w2', 'kimi', [
                makeFinding({
                    findingId: 'W2-F1',
                    claim: 'Auth callback has unvalidated redirect URL',
                    file: 'src/auth.ts',
                    line: 31,
                    severity: 'low',
                    confidence: 'medium',
                }),
            ]),
        ];

        const report = aggregateReviews(reviews);

        expect(report.disagreements.length).toBeGreaterThan(0);
        const d = report.disagreements[0];
        expect(d.topic).toContain('src/auth.ts');
        expect(d.positions).toHaveLength(2);

        const severities = d.positions.map(p => p.severity);
        expect(severities).toContain('critical');
        expect(severities).toContain('low');
    });

    it('no disagreements when witnesses agree on severity within 1 rank', () => {
        const reviews: WitnessReview[] = [
            makeReview('w1', 'minimax', [
                makeFinding({
                    findingId: 'W1-F1',
                    severity: 'high',
                    file: 'src/auth.ts',
                    line: 30,
                }),
            ]),
            makeReview('w2', 'kimi', [
                makeFinding({
                    findingId: 'W2-F1',
                    claim: 'Missing null check on user input validation',
                    severity: 'medium',
                    file: 'src/auth.ts',
                    line: 30,
                }),
            ]),
        ];

        const report = aggregateReviews(reviews);
        expect(report.disagreements).toHaveLength(0);
    });
});

describe('aggregateReviews — empty/no_findings input', () => {
    it('empty input → concise no findings report', () => {
        const report = aggregateReviews([]);
        expect(report.totalWitnesses).toBe(0);
        expect(report.totalFindings).toBe(0);
        expect(report.clusters).toHaveLength(0);
        expect(report.disagreements).toHaveLength(0);
        expect(report.noFindingsWitnesses).toHaveLength(0);
        expect(report.budgetExceeded).toBe(false);
    });

    it('all no_findings → concise report with witness IDs listed', () => {
        const reviews: WitnessReview[] = [
            makeNoFindingsReview('w1', 'minimax'),
            makeNoFindingsReview('w2', 'kimi'),
            makeNoFindingsReview('w3', 'qwen'),
            makeNoFindingsReview('w4', 'gemma'),
        ];

        const report = aggregateReviews(reviews);
        expect(report.totalWitnesses).toBe(4);
        expect(report.totalFindings).toBe(0);
        expect(report.clusters).toHaveLength(0);
        expect(report.disagreements).toHaveLength(0);
        expect(report.noFindingsWitnesses).toEqual(['w1', 'w2', 'w3', 'w4']);
    });

    it('mix of no_findings and findings → only findings aggregated', () => {
        const reviews: WitnessReview[] = [
            makeNoFindingsReview('w1', 'minimax'),
            makeReview('w2', 'kimi', [
                makeFinding({ findingId: 'W2-F1', claim: 'Bug found in parser' }),
            ]),
            makeNoFindingsReview('w3', 'qwen'),
        ];

        const report = aggregateReviews(reviews);
        expect(report.totalWitnesses).toBe(3);
        expect(report.totalFindings).toBe(1);
        expect(report.clusters).toHaveLength(1);
        expect(report.noFindingsWitnesses).toEqual(['w1', 'w3']);
    });
});

// --- Dissent confidence threshold tests ---

describe('aggregateReviews — dissent confidence threshold', () => {
    it('minority findings above dissentConfidenceThreshold are prioritized during budget trimming', () => {
        // Create a scenario where budget is tight and we have both a high-confidence
        // minority finding and a low-confidence minority finding
        const reviews: WitnessReview[] = [
            makeReview('w1', 'minimax', [
                makeFinding({
                    findingId: 'W1-F1',
                    claim: 'High confidence unique finding from witness one about security',
                    file: 'src/security.ts',
                    line: 10,
                    severity: 'medium',
                    confidence: 'high',
                }),
            ]),
            makeReview('w2', 'kimi', [
                makeFinding({
                    findingId: 'W2-F1',
                    claim: 'Low confidence unique finding from witness two about performance',
                    file: 'src/perf.ts',
                    line: 50,
                    severity: 'medium',
                    confidence: 'low',
                }),
            ]),
        ];

        // Tight budget that can only fit one medium finding + metadata
        const report = aggregateReviews(reviews, {
            budgetChars: 800,
            dissentConfidenceThreshold: 'medium',
        });

        // Both are minority findings. If only one fits, the high-confidence one should be kept
        if (report.clusters.length === 1) {
            expect(report.clusters[0].confidence).toBe('high');
        }
        // If both fit, that's fine too
        expect(report.budgetExceeded).toBe(false);
    });
});

// --- True single-linkage clustering tests ---

describe('aggregateReviews — true single-linkage', () => {
    it('transitive clustering: A matches B, B matches C → all in one cluster', () => {
        // A at line 1, B at line 5, C at line 9
        // A matches B (distance 4 <= 5), B matches C (distance 4 <= 5),
        // but A doesn't match C (distance 8 > 5)
        // True single-linkage should put all 3 in one cluster
        const reviews: WitnessReview[] = [
            makeReview('w1', 'minimax', [
                makeFinding({
                    findingId: 'W1-F1',
                    claim: 'Missing null check on user input in handler',
                    file: 'src/handler.ts',
                    line: 1,
                }),
            ]),
            makeReview('w2', 'kimi', [
                makeFinding({
                    findingId: 'W2-F1',
                    claim: 'Null check missing on user input in handler function',
                    file: 'src/handler.ts',
                    line: 5,
                }),
            ]),
            makeReview('w3', 'qwen', [
                makeFinding({
                    findingId: 'W3-F1',
                    claim: 'Handler function lacks null check on user input',
                    file: 'src/handler.ts',
                    line: 9,
                }),
            ]),
        ];

        const report = aggregateReviews(reviews);
        // All 3 should be in one cluster due to transitive similarity
        expect(report.clusters).toHaveLength(1);
        expect(report.clusters[0].witnesses).toHaveLength(3);
    });
});

// --- Ranking tests ---

describe('aggregateReviews — ranking', () => {
    it('clusters sorted by severity desc → confidence desc → agreement desc', () => {
        const reviews: WitnessReview[] = [
            makeReview('w1', 'minimax', [
                makeFinding({
                    findingId: 'W1-LOW',
                    claim: 'Minor style issue in formatting',
                    file: 'src/style.ts',
                    line: 10,
                    severity: 'low',
                    confidence: 'high',
                }),
                makeFinding({
                    findingId: 'W1-CRIT',
                    claim: 'Critical buffer overflow in parser',
                    file: 'src/parser.ts',
                    line: 50,
                    severity: 'critical',
                    confidence: 'medium',
                }),
                makeFinding({
                    findingId: 'W1-HIGH',
                    claim: 'SQL injection in database query layer',
                    file: 'src/db.ts',
                    line: 30,
                    severity: 'high',
                    confidence: 'high',
                }),
            ]),
        ];

        const report = aggregateReviews(reviews);
        expect(report.clusters.length).toBe(3);
        expect(report.clusters[0].severity).toBe('critical');
        expect(report.clusters[1].severity).toBe('high');
        expect(report.clusters[2].severity).toBe('low');
    });
});

// --- Edge cases ---

describe('aggregateReviews — edge cases', () => {
    it('single witness single finding → one cluster', () => {
        const reviews: WitnessReview[] = [
            makeReview('w1', 'minimax', [
                makeFinding({ findingId: 'W1-F1' }),
            ]),
        ];

        const report = aggregateReviews(reviews);
        expect(report.totalWitnesses).toBe(1);
        expect(report.totalFindings).toBe(1);
        expect(report.clusters).toHaveLength(1);
        expect(report.clusters[0].witnesses).toHaveLength(1);
        expect(report.clusters[0].agreementCount).toBe(1);
    });

    it('findings with no file info cluster by claim similarity only', () => {
        const reviews: WitnessReview[] = [
            makeReview('w1', 'minimax', [
                makeFinding({
                    findingId: 'W1-F1',
                    claim: 'Performance issue with large input arrays',
                    file: undefined,
                    line: undefined,
                }),
            ]),
            makeReview('w2', 'kimi', [
                makeFinding({
                    findingId: 'W2-F1',
                    claim: 'Large input arrays cause performance degradation',
                    file: undefined,
                    line: undefined,
                }),
            ]),
        ];

        const report = aggregateReviews(reviews);
        // Should cluster by claim similarity
        expect(report.clusters).toHaveLength(1);
        expect(report.clusters[0].witnesses).toHaveLength(2);
    });

    it('same witness cannot inflate agreement count', () => {
        // A single witness with multiple findings at the same location
        const reviews: WitnessReview[] = [
            makeReview('w1', 'minimax', [
                makeFinding({
                    findingId: 'W1-F1',
                    claim: 'Missing null check in handler',
                    file: 'src/handler.ts',
                    line: 42,
                }),
                makeFinding({
                    findingId: 'W1-F2',
                    claim: 'Null check missing for handler input',
                    file: 'src/handler.ts',
                    line: 43,
                }),
            ]),
        ];

        const report = aggregateReviews(reviews);
        // Both findings from same witness cluster together
        expect(report.clusters).toHaveLength(1);
        // agreementCount is unique witness count, not finding count
        expect(report.clusters[0].agreementCount).toBe(1);
    });

    it('default config is applied when no config provided', () => {
        const reviews: WitnessReview[] = [
            makeReview('w1', 'minimax', [makeFinding({ findingId: 'F1' })]),
        ];
        const report = aggregateReviews(reviews);
        expect(report.budgetLimit).toBe(DEFAULT_AGGREGATOR_CONFIG.budgetChars);
    });
});
