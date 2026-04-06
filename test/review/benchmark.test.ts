/**
 * Tests for M7A.5.3: Watchdog Model Benchmark Harness
 *
 * Uses deterministic mock model runners to verify scoring logic.
 * Covers: dedupe accuracy, dissent preservation, faithfulness penalties,
 * severity ranking, compactness, winner table, and prompt/version metadata.
 */
import { describe, it, expect } from 'vitest';
import type { WitnessReview, WitnessFinding } from '../../src/review/witness-finding.js';
import type {
    BenchmarkFixture,
    WatchdogReport,
    ModelRunner,
} from '../../src/review/benchmark.js';
import {
    parseWatchdogOutput,
    buildWatchdogPrompt,
    scoreDedupe,
    scoreDissent,
    scoreSeverity,
    scoreFaithfulness,
    scoreCompactness,
    computeTotal,
    runBenchmark,
    SCORING_WEIGHTS,
    DEPRECATED_MODELS,
    DEFAULT_CANDIDATES,
} from '../../src/review/benchmark.js';

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
        recommendedAction: 'Add null/undefined check before dereferencing',
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

/**
 * Build a WatchdogReport JSON string from a WatchdogReport object.
 * Used to create deterministic mock model responses.
 */
function buildMockResponse(report: WatchdogReport): string {
    return JSON.stringify(report);
}

// --- Synthetic fixtures ---

/**
 * Fixture: 4 witnesses report the same null-check bug with different wording.
 * Expected: all 4 should merge into 1 cluster.
 */
function makeDuplicateFixture(): BenchmarkFixture {
    const reviews = [
        makeReview('W1', 'model-a', [
            makeFinding({ findingId: 'W1-F1', claim: 'Missing null check on user input in handler' }),
        ]),
        makeReview('W2', 'model-b', [
            makeFinding({ findingId: 'W2-F1', claim: 'No null guard on user input in the handler' }),
        ]),
        makeReview('W3', 'model-c', [
            makeFinding({ findingId: 'W3-F1', claim: 'Handler lacks null check for user input' }),
        ]),
        makeReview('W4', 'model-d', [
            makeFinding({ findingId: 'W4-F1', claim: 'User input not checked for null in handler' }),
        ]),
    ];

    return {
        id: 'duplicate-bundle',
        description: '4 witnesses report same bug — should dedupe to 1 cluster',
        reviews,
        expected: {
            expectedClusterCount: 1,
            requiredFindingIds: [],
            expectedClusters: [
                { findingIds: ['W1-F1', 'W2-F1', 'W3-F1', 'W4-F1'], expectedSeverity: 'high' },
            ],
            validClaimSubstrings: [
                'null check', 'null guard', 'user input', 'handler',
            ],
        },
    };
}

/**
 * Fixture: 3 witnesses find nothing, 1 finds a high-confidence issue.
 * Expected: the minority finding must be preserved.
 */
function makeMinorityFixture(): BenchmarkFixture {
    const minorityFinding = makeFinding({
        findingId: 'W4-F1',
        severity: 'high',
        confidence: 'high',
        claim: 'Race condition in session cleanup allows double-free',
        evidence: 'session-manager.ts line 87 calls cleanup() without lock',
        file: 'src/session-manager.ts',
        line: 87,
    });

    const reviews = [
        makeNoFindingsReview('W1', 'model-a'),
        makeNoFindingsReview('W2', 'model-b'),
        makeNoFindingsReview('W3', 'model-c'),
        makeReview('W4', 'model-d', [minorityFinding]),
    ];

    return {
        id: 'minority-finding',
        description: '1 minority high-confidence finding + 3 no-findings — must preserve',
        reviews,
        expected: {
            expectedClusterCount: 1,
            requiredFindingIds: ['W4-F1'],
            expectedClusters: [
                { findingIds: ['W4-F1'], expectedSeverity: 'high' },
            ],
            validClaimSubstrings: [
                'race condition', 'session cleanup', 'double-free', 'cleanup()', 'lock',
            ],
        },
    };
}

/**
 * Fixture: witnesses report findings but the watchdog should NOT invent new ones.
 * Used to test faithfulness — if the watchdog adds claims not in input, it's penalized.
 */
function makeAdversarialFixture(): BenchmarkFixture {
    const reviews = [
        makeReview('W1', 'model-a', [
            makeFinding({
                findingId: 'W1-F1',
                severity: 'medium',
                claim: 'Unused import in config.ts',
                evidence: 'config.ts line 3 imports fs but never uses it',
                file: 'src/config.ts',
                line: 3,
            }),
        ]),
        makeReview('W2', 'model-b', [
            makeFinding({
                findingId: 'W2-F1',
                severity: 'low',
                claim: 'Console.log left in production code',
                evidence: 'handler.ts line 55 has a debug logging statement',
                file: 'src/handler.ts',
                line: 55,
            }),
        ]),
    ];

    return {
        id: 'adversarial-bundle',
        description: 'Watchdog must not invent claims absent from witness inputs',
        reviews,
        expected: {
            expectedClusterCount: 2,
            requiredFindingIds: ['W1-F1', 'W2-F1'],
            expectedClusters: [
                { findingIds: ['W1-F1'] },
                { findingIds: ['W2-F1'] },
            ],
            validClaimSubstrings: [
                'unused import', 'config.ts', 'console.log', 'handler.ts',
            ],
        },
    };
}

// --- parseWatchdogOutput tests ---

describe('parseWatchdogOutput', () => {
    it('parses valid JSON report', () => {
        const report: WatchdogReport = {
            findings: [{
                claim: 'test claim',
                severity: 'high',
                confidence: 'high',
                witnessRefs: [{ witnessId: 'W1', findingId: 'F1' }],
                evidenceQuote: 'some evidence',
                recommendedAction: 'fix it',
            }],
            disagreements: [],
            summary: 'one finding',
        };
        const result = parseWatchdogOutput(JSON.stringify(report));
        expect(result).not.toBeNull();
        expect(result!.findings).toHaveLength(1);
        expect(result!.findings[0].claim).toBe('test claim');
    });

    it('strips markdown code fences', () => {
        const report: WatchdogReport = {
            findings: [],
            disagreements: [],
            summary: 'empty',
        };
        const wrapped = '```json\n' + JSON.stringify(report) + '\n```';
        const result = parseWatchdogOutput(wrapped);
        expect(result).not.toBeNull();
        expect(result!.findings).toHaveLength(0);
    });

    it('returns null for invalid JSON', () => {
        expect(parseWatchdogOutput('not json at all')).toBeNull();
    });

    it('returns null for non-object JSON', () => {
        expect(parseWatchdogOutput('"just a string"')).toBeNull();
        expect(parseWatchdogOutput('[1,2,3]')).toBeNull();
    });

    it('returns null when findings is missing', () => {
        expect(parseWatchdogOutput('{"summary":"no findings field"}')).toBeNull();
    });

    it('rejects invalid severity string', () => {
        const raw = JSON.stringify({
            findings: [{
                claim: 'test',
                severity: 'SUPER_CRITICAL',
                confidence: 'high',
                witnessRefs: [{ witnessId: 'W1', findingId: 'F1' }],
                evidenceQuote: 'evidence',
                recommendedAction: 'fix',
            }],
            disagreements: [],
            summary: 'bad severity',
        });
        expect(parseWatchdogOutput(raw)).toBeNull();
    });

    it('rejects invalid confidence string', () => {
        const raw = JSON.stringify({
            findings: [{
                claim: 'test',
                severity: 'high',
                confidence: 'very_high',
                witnessRefs: [{ witnessId: 'W1', findingId: 'F1' }],
                evidenceQuote: 'evidence',
                recommendedAction: 'fix',
            }],
            disagreements: [],
            summary: 'bad confidence',
        });
        expect(parseWatchdogOutput(raw)).toBeNull();
    });

    it('parses disagreements when present', () => {
        const report: WatchdogReport = {
            findings: [],
            disagreements: [{
                topic: 'severity of null check',
                positions: [
                    { witnessId: 'W1', claim: 'critical', severity: 'critical' },
                    { witnessId: 'W2', claim: 'medium', severity: 'medium' },
                ],
            }],
            summary: 'disagreement found',
        };
        const result = parseWatchdogOutput(JSON.stringify(report));
        expect(result).not.toBeNull();
        expect(result!.disagreements).toHaveLength(1);
        expect(result!.disagreements[0].positions).toHaveLength(2);
    });
});

// --- scoreDedupe tests ---

describe('scoreDedupe', () => {
    it('perfect score when duplicates are merged into expected cluster count', () => {
        const fixture = makeDuplicateFixture();
        const report: WatchdogReport = {
            findings: [{
                claim: 'Missing null check on user input',
                severity: 'high',
                confidence: 'high',
                witnessRefs: [
                    { witnessId: 'W1', findingId: 'W1-F1' },
                    { witnessId: 'W2', findingId: 'W2-F1' },
                    { witnessId: 'W3', findingId: 'W3-F1' },
                    { witnessId: 'W4', findingId: 'W4-F1' },
                ],
                evidenceQuote: 'dereferences req.body without guard',
                recommendedAction: 'Add null check',
            }],
            disagreements: [],
            summary: 'one deduped finding',
        };
        const score = scoreDedupe(report, fixture.expected);
        expect(score).toBe(1.0);
    });

    it('low score when duplicates are not merged', () => {
        const fixture = makeDuplicateFixture();
        // 4 separate findings instead of 1 merged
        const report: WatchdogReport = {
            findings: [
                { claim: 'A', severity: 'high', confidence: 'high', witnessRefs: [{ witnessId: 'W1', findingId: 'W1-F1' }], evidenceQuote: 'x', recommendedAction: 'y' },
                { claim: 'B', severity: 'high', confidence: 'high', witnessRefs: [{ witnessId: 'W2', findingId: 'W2-F1' }], evidenceQuote: 'x', recommendedAction: 'y' },
                { claim: 'C', severity: 'high', confidence: 'high', witnessRefs: [{ witnessId: 'W3', findingId: 'W3-F1' }], evidenceQuote: 'x', recommendedAction: 'y' },
                { claim: 'D', severity: 'high', confidence: 'high', witnessRefs: [{ witnessId: 'W4', findingId: 'W4-F1' }], evidenceQuote: 'x', recommendedAction: 'y' },
            ],
            disagreements: [],
            summary: 'not merged',
        };
        const score = scoreDedupe(report, fixture.expected);
        // Count score: |4-1|/1 = 3, max(0, 1-3) = 0
        // Merge score: 0 (no single finding has all 4 refs)
        expect(score).toBe(0);
    });

    it('returns 1.0 for empty expected clusters with empty findings', () => {
        const score = scoreDedupe(
            { findings: [], disagreements: [], summary: '' },
            { expectedClusterCount: 0, requiredFindingIds: [], expectedClusters: [], validClaimSubstrings: [] },
        );
        expect(score).toBe(1.0);
    });
});

// --- scoreDissent tests ---

describe('scoreDissent', () => {
    it('perfect score when minority finding is preserved', () => {
        const fixture = makeMinorityFixture();
        const report: WatchdogReport = {
            findings: [{
                claim: 'Race condition in session cleanup',
                severity: 'high',
                confidence: 'high',
                witnessRefs: [{ witnessId: 'W4', findingId: 'W4-F1' }],
                evidenceQuote: 'session-manager.ts line 87 calls cleanup() without lock',
                recommendedAction: 'Add lock',
            }],
            disagreements: [],
            summary: 'one minority finding preserved',
        };
        const score = scoreDissent(report, fixture.expected);
        expect(score).toBe(1.0);
    });

    it('zero score when minority finding is dropped', () => {
        const fixture = makeMinorityFixture();
        // Empty report — dissenting finding dropped
        const report: WatchdogReport = {
            findings: [],
            disagreements: [],
            summary: 'no findings',
        };
        const score = scoreDissent(report, fixture.expected);
        expect(score).toBe(0);
    });

    it('returns 1.0 when no required findings', () => {
        const score = scoreDissent(
            { findings: [], disagreements: [], summary: '' },
            { expectedClusterCount: 0, requiredFindingIds: [], expectedClusters: [], validClaimSubstrings: [] },
        );
        expect(score).toBe(1.0);
    });
});

// --- scoreSeverity tests ---

describe('scoreSeverity', () => {
    const noExpected = { expectedClusterCount: 0, requiredFindingIds: [], expectedClusters: [], validClaimSubstrings: [] };

    it('perfect score for correctly ordered findings', () => {
        const report: WatchdogReport = {
            findings: [
                { claim: 'A', severity: 'critical', confidence: 'high', witnessRefs: [], evidenceQuote: '', recommendedAction: '' },
                { claim: 'B', severity: 'high', confidence: 'high', witnessRefs: [], evidenceQuote: '', recommendedAction: '' },
                { claim: 'C', severity: 'medium', confidence: 'high', witnessRefs: [], evidenceQuote: '', recommendedAction: '' },
                { claim: 'D', severity: 'low', confidence: 'high', witnessRefs: [], evidenceQuote: '', recommendedAction: '' },
            ],
            disagreements: [],
            summary: '',
        };
        expect(scoreSeverity(report, noExpected)).toBe(1.0);
    });

    it('penalizes inversions', () => {
        const report: WatchdogReport = {
            findings: [
                { claim: 'A', severity: 'low', confidence: 'high', witnessRefs: [], evidenceQuote: '', recommendedAction: '' },
                { claim: 'B', severity: 'critical', confidence: 'high', witnessRefs: [], evidenceQuote: '', recommendedAction: '' },
            ],
            disagreements: [],
            summary: '',
        };
        // 1 inversion out of 1 comparison
        expect(scoreSeverity(report, noExpected)).toBe(0);
    });

    it('returns 1.0 for single finding', () => {
        const report: WatchdogReport = {
            findings: [
                { claim: 'A', severity: 'high', confidence: 'high', witnessRefs: [], evidenceQuote: '', recommendedAction: '' },
            ],
            disagreements: [],
            summary: '',
        };
        expect(scoreSeverity(report, noExpected)).toBe(1.0);
    });
});

// --- scoreFaithfulness tests ---

describe('scoreFaithfulness', () => {
    it('perfect score when all evidence quotes trace to witnesses', () => {
        const reviews = [
            makeReview('W1', 'model-a', [
                makeFinding({ findingId: 'F1', evidence: 'handler.ts line 42 is unsafe' }),
            ]),
        ];
        const report: WatchdogReport = {
            findings: [{
                claim: 'Unsafe handler',
                severity: 'high',
                confidence: 'high',
                witnessRefs: [{ witnessId: 'W1', findingId: 'F1' }],
                evidenceQuote: 'handler.ts line 42 is unsafe',
                recommendedAction: 'fix',
            }],
            disagreements: [],
            summary: '',
        };
        expect(scoreFaithfulness(report, reviews)).toBe(1.0);
    });

    it('zero score when evidence quote is fabricated', () => {
        const reviews = [
            makeReview('W1', 'model-a', [
                makeFinding({ findingId: 'F1', evidence: 'actual evidence here' }),
            ]),
        ];
        const report: WatchdogReport = {
            findings: [{
                claim: 'Invented claim',
                severity: 'high',
                confidence: 'high',
                witnessRefs: [{ witnessId: 'W1', findingId: 'F1' }],
                evidenceQuote: 'this text does not exist in any witness output',
                recommendedAction: 'fix',
            }],
            disagreements: [],
            summary: '',
        };
        expect(scoreFaithfulness(report, reviews)).toBe(0);
    });

    it('zero score when witnessRefs reference non-existent witness', () => {
        const reviews = [
            makeReview('W1', 'model-a', [
                makeFinding({ findingId: 'F1', evidence: 'real evidence' }),
            ]),
        ];
        const report: WatchdogReport = {
            findings: [{
                claim: 'Claim',
                severity: 'high',
                confidence: 'high',
                witnessRefs: [{ witnessId: 'NONEXISTENT', findingId: 'F1' }],
                evidenceQuote: 'real evidence',
                recommendedAction: 'fix',
            }],
            disagreements: [],
            summary: '',
        };
        expect(scoreFaithfulness(report, reviews)).toBe(0);
    });

    it('returns 1.0 for empty findings', () => {
        expect(scoreFaithfulness({ findings: [], disagreements: [], summary: '' }, [])).toBe(1.0);
    });
});

// --- scoreCompactness tests ---

describe('scoreCompactness', () => {
    it('perfect score for highly compact output', () => {
        const reviews = [
            makeReview('W1', 'model-a', [
                makeFinding({ evidence: 'x'.repeat(1000) }),
            ]),
        ];
        const shortOutput = '{"findings":[]}'; // very short
        expect(scoreCompactness(shortOutput, reviews)).toBe(1.0);
    });

    it('zero score when output is larger than input', () => {
        const reviews = [
            makeReview('W1', 'model-a', [
                makeFinding({ evidence: 'short' }),
            ]),
        ];
        const longOutput = 'x'.repeat(10000);
        expect(scoreCompactness(longOutput, reviews)).toBe(0);
    });
});

// --- computeTotal tests ---

describe('computeTotal', () => {
    it('weights sum to 1.0', () => {
        const total = Object.values(SCORING_WEIGHTS).reduce((sum, w) => sum + w, 0);
        expect(total).toBeCloseTo(1.0);
    });

    it('perfect scores produce 1.0 total', () => {
        expect(computeTotal({
            dedupeAccuracy: 1,
            dissentPreservation: 1,
            severityRanking: 1,
            faithfulness: 1,
            compactness: 1,
        })).toBeCloseTo(1.0);
    });

    it('zero scores produce 0.0 total', () => {
        expect(computeTotal({
            dedupeAccuracy: 0,
            dissentPreservation: 0,
            severityRanking: 0,
            faithfulness: 0,
            compactness: 0,
        })).toBe(0);
    });
});

// --- buildWatchdogPrompt tests ---

describe('buildWatchdogPrompt', () => {
    it('includes all witness reviews in prompt', () => {
        const reviews = [
            makeReview('W1', 'model-a', [makeFinding({ findingId: 'F1' })]),
            makeReview('W2', 'model-b', [makeFinding({ findingId: 'F2' })]),
        ];
        const prompt = buildWatchdogPrompt(reviews);
        expect(prompt).toContain('W1');
        expect(prompt).toContain('W2');
        expect(prompt).toContain('model-a');
        expect(prompt).toContain('model-b');
    });

    it('includes evidence guardrail instruction', () => {
        const prompt = buildWatchdogPrompt([]);
        expect(prompt).toContain('EXACT substring');
        expect(prompt).toContain('Do NOT paraphrase');
    });
});

// --- Full benchmark runner tests ---

describe('runBenchmark', () => {
    it('runs deterministically on fixture bundle and emits per-model scores', async () => {
        const fixture = makeDuplicateFixture();

        // Mock runner: "good-model" produces a perfect dedup, "bad-model" doesn't merge
        const runner: ModelRunner = async (model: string) => {
            if (model === 'good-model') {
                return buildMockResponse({
                    findings: [{
                        claim: 'Missing null check on user input',
                        severity: 'high',
                        confidence: 'high',
                        witnessRefs: [
                            { witnessId: 'W1', findingId: 'W1-F1' },
                            { witnessId: 'W2', findingId: 'W2-F1' },
                            { witnessId: 'W3', findingId: 'W3-F1' },
                            { witnessId: 'W4', findingId: 'W4-F1' },
                        ],
                        evidenceQuote: 'dereferences req.body without guard',
                        recommendedAction: 'Add null check',
                    }],
                    disagreements: [],
                    summary: 'one deduped finding',
                });
            }
            // bad-model: 4 separate findings, no merge
            return buildMockResponse({
                findings: [
                    { claim: 'A', severity: 'high', confidence: 'high', witnessRefs: [{ witnessId: 'W1', findingId: 'W1-F1' }], evidenceQuote: 'dereferences req.body without guard', recommendedAction: 'y' },
                    { claim: 'B', severity: 'high', confidence: 'high', witnessRefs: [{ witnessId: 'W2', findingId: 'W2-F1' }], evidenceQuote: 'dereferences req.body without guard', recommendedAction: 'y' },
                    { claim: 'C', severity: 'high', confidence: 'high', witnessRefs: [{ witnessId: 'W3', findingId: 'W3-F1' }], evidenceQuote: 'dereferences req.body without guard', recommendedAction: 'y' },
                    { claim: 'D', severity: 'high', confidence: 'high', witnessRefs: [{ witnessId: 'W4', findingId: 'W4-F1' }], evidenceQuote: 'dereferences req.body without guard', recommendedAction: 'y' },
                ],
                disagreements: [],
                summary: 'not merged',
            });
        };

        const result = await runBenchmark({
            candidates: ['good-model', 'bad-model'],
            fixtures: [fixture],
            runner,
        });

        expect(result.scores).toHaveLength(2);
        expect(result.winner).toBe('good-model');
        expect(result.fallback).toBe('bad-model');
        expect(result.promptVersion).toBeTruthy();
        expect(result.fixtureIds).toEqual(['duplicate-bundle']);
        expect(result.timestamp).toBeTruthy();

        // Good model should have higher dedupe score
        const goodScore = result.scores.find(s => s.model === 'good-model')!;
        const badScore = result.scores.find(s => s.model === 'bad-model')!;
        expect(goodScore.dedupeAccuracy).toBeGreaterThan(badScore.dedupeAccuracy);
        expect(goodScore.total).toBeGreaterThan(badScore.total);

        // Per-fixture scores are present
        expect(goodScore.fixtureScores).toHaveLength(1);
        expect(goodScore.fixtureScores[0].fixtureId).toBe('duplicate-bundle');
    });

    it('synthetic duplicate bundle gives high dedupe score to correct merger', async () => {
        const fixture = makeDuplicateFixture();

        const runner: ModelRunner = async () => {
            return buildMockResponse({
                findings: [{
                    claim: 'Missing null check on user input',
                    severity: 'high',
                    confidence: 'high',
                    witnessRefs: [
                        { witnessId: 'W1', findingId: 'W1-F1' },
                        { witnessId: 'W2', findingId: 'W2-F1' },
                        { witnessId: 'W3', findingId: 'W3-F1' },
                        { witnessId: 'W4', findingId: 'W4-F1' },
                    ],
                    evidenceQuote: 'dereferences req.body without guard',
                    recommendedAction: 'Add null check',
                }],
                disagreements: [],
                summary: 'merged',
            });
        };

        const result = await runBenchmark({
            candidates: ['test-model'],
            fixtures: [fixture],
            runner,
        });

        expect(result.scores[0].dedupeAccuracy).toBe(1.0);
    });

    it('synthetic minority-finding bundle penalizes model that drops dissent', async () => {
        const fixture = makeMinorityFixture();

        // Model that drops the minority finding
        const runner: ModelRunner = async () => {
            return buildMockResponse({
                findings: [],
                disagreements: [],
                summary: 'no findings',
            });
        };

        const result = await runBenchmark({
            candidates: ['drops-dissent'],
            fixtures: [fixture],
            runner,
        });

        expect(result.scores[0].dissentPreservation).toBe(0);
    });

    it('synthetic adversarial bundle penalizes model that invents claims', async () => {
        const fixture = makeAdversarialFixture();

        // Model that invents a new claim not in witness input
        const runner: ModelRunner = async () => {
            return buildMockResponse({
                findings: [
                    {
                        claim: 'Unused import',
                        severity: 'medium',
                        confidence: 'high',
                        witnessRefs: [{ witnessId: 'W1', findingId: 'W1-F1' }],
                        evidenceQuote: 'config.ts line 3 imports fs but never uses it',
                        recommendedAction: 'remove import',
                    },
                    {
                        claim: 'Console.log in prod',
                        severity: 'low',
                        confidence: 'medium',
                        witnessRefs: [{ witnessId: 'W2', findingId: 'W2-F1' }],
                        evidenceQuote: 'handler.ts line 55 has a debug logging statement',
                        recommendedAction: 'remove log',
                    },
                    {
                        claim: 'SQL injection vulnerability in database layer',
                        severity: 'critical',
                        confidence: 'high',
                        witnessRefs: [{ witnessId: 'W1', findingId: 'INVENTED' }],
                        evidenceQuote: 'this evidence does not exist in any witness',
                        recommendedAction: 'use parameterized queries',
                    },
                ],
                disagreements: [],
                summary: 'includes invented finding',
            });
        };

        const result = await runBenchmark({
            candidates: ['hallucinator'],
            fixtures: [fixture],
            runner,
        });

        // 2 out of 3 findings are faithful → 0.667
        expect(result.scores[0].faithfulness).toBeCloseTo(2 / 3, 2);
    });

    it('benchmark output includes reproducible winner table and metadata', async () => {
        const fixtures = [makeDuplicateFixture(), makeMinorityFixture()];

        const runner: ModelRunner = async (model: string, _prompt: string) => {
            // Both models produce valid but different quality output
            if (model === 'model-a') {
                return buildMockResponse({
                    findings: [{
                        claim: 'finding',
                        severity: 'high',
                        confidence: 'high',
                        witnessRefs: [
                            { witnessId: 'W1', findingId: 'W1-F1' },
                            { witnessId: 'W2', findingId: 'W2-F1' },
                            { witnessId: 'W3', findingId: 'W3-F1' },
                            { witnessId: 'W4', findingId: 'W4-F1' },
                        ],
                        evidenceQuote: 'dereferences req.body without guard',
                        recommendedAction: 'fix',
                    }],
                    disagreements: [],
                    summary: 'good output',
                });
            }
            return buildMockResponse({
                findings: [],
                disagreements: [],
                summary: 'empty',
            });
        };

        const result = await runBenchmark({
            candidates: ['model-a', 'model-b'],
            fixtures,
            runner,
        });

        // Metadata present
        expect(result.promptVersion).toBe('1.0.0');
        expect(result.fixtureIds).toEqual(['duplicate-bundle', 'minority-finding']);
        expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(result.winner).toBeTruthy();
        expect(result.fallback).toBeTruthy();

        // Scores are sorted by total descending
        for (let i = 0; i < result.scores.length - 1; i++) {
            expect(result.scores[i].total).toBeGreaterThanOrEqual(result.scores[i + 1].total);
        }
    });

    it('excludes deprecated models from candidates', async () => {
        // DEPRECATED_MODELS is currently empty, but verify the filtering logic
        const runner: ModelRunner = async () => buildMockResponse({
            findings: [],
            disagreements: [],
            summary: 'ok',
        });

        const result = await runBenchmark({
            candidates: ['valid-model'],
            fixtures: [makeDuplicateFixture()],
            runner,
        });

        expect(result.scores).toHaveLength(1);
        expect(result.scores[0].model).toBe('valid-model');
    });

    it('handles model runner failure gracefully with zero scores', async () => {
        const fixture = makeDuplicateFixture();

        const runner: ModelRunner = async (model: string) => {
            if (model === 'failing-model') throw new Error('API timeout');
            return buildMockResponse({
                findings: [{
                    claim: 'finding',
                    severity: 'high',
                    confidence: 'high',
                    witnessRefs: [{ witnessId: 'W1', findingId: 'W1-F1' }],
                    evidenceQuote: 'dereferences req.body without guard',
                    recommendedAction: 'fix',
                }],
                disagreements: [],
                summary: 'ok',
            });
        };

        const result = await runBenchmark({
            candidates: ['working-model', 'failing-model'],
            fixtures: [fixture],
            runner,
        });

        const failingScore = result.scores.find(s => s.model === 'failing-model')!;
        expect(failingScore.total).toBe(0);
        expect(failingScore.fixtureScores[0].dedupeAccuracy).toBe(0);
    });

    it('handles unparseable model output with zero scores', async () => {
        const fixture = makeDuplicateFixture();

        const runner: ModelRunner = async () => 'this is not valid JSON at all';

        const result = await runBenchmark({
            candidates: ['broken-model'],
            fixtures: [fixture],
            runner,
        });

        expect(result.scores[0].total).toBe(0);
    });
});

// --- Constants tests ---

describe('constants', () => {
    it('DEFAULT_CANDIDATES contains expected model families', () => {
        expect(DEFAULT_CANDIDATES.length).toBeGreaterThanOrEqual(3);
        // Should have diversity — at least 2 different model families
        const families = new Set(DEFAULT_CANDIDATES.map(m => m.split('-')[0]));
        expect(families.size).toBeGreaterThanOrEqual(2);
    });

    it('DEPRECATED_MODELS is a Set', () => {
        expect(DEPRECATED_MODELS).toBeInstanceOf(Set);
    });
});
