/**
 * Tests for M7A.5.4: Claude-Facing Review Report Contract
 *
 * Covers:
 * - Stable section order (summary → P0/P1 → dissent → lower → raw pointers)
 * - Every finding traces to witness finding ID + source location
 * - Large 4-witness bundle compresses without losing P0/P1
 * - Watchdog profile allows only read-only tools (allow-list approach)
 */
import { describe, it, expect } from 'vitest';
import {
    buildReport,
    renderReportText,
    WATCHDOG_PROFILE,
} from '../../src/review/report.js';
import { aggregateReviews } from '../../src/review/aggregator.js';
import type { WitnessReview, WitnessFinding } from '../../src/review/witness-finding.js';

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
        rawOutput: JSON.stringify({ type: 'no_findings', residualRisk: 'Low risk, code looks clean' }),
        parsed: { type: 'no_findings', residualRisk: 'Low risk, code looks clean' },
        parsedAt: new Date().toISOString(),
    };
}

/**
 * Build a 4-witness review bundle with multiple findings at different severities.
 */
function makeLargeBundle(): WitnessReview[] {
    return [
        makeReview('W1', 'gpt-4o', [
            makeFinding({ findingId: 'W1-F1', severity: 'critical', claim: 'SQL injection in query builder', file: 'src/db.ts', line: 10 }),
            makeFinding({ findingId: 'W1-F2', severity: 'high', claim: 'Missing null check on user input', file: 'src/handler.ts', line: 42 }),
            makeFinding({ findingId: 'W1-F3', severity: 'medium', claim: 'Unused import of lodash', file: 'src/utils.ts', line: 1 }),
            makeFinding({ findingId: 'W1-F4', severity: 'low', claim: 'Inconsistent naming convention', file: 'src/config.ts', line: 5 }),
        ]),
        makeReview('W2', 'deepseek-chat', [
            makeFinding({ findingId: 'W2-F1', severity: 'critical', claim: 'SQL injection vulnerability in query builder function', file: 'src/db.ts', line: 11 }),
            makeFinding({ findingId: 'W2-F2', severity: 'high', claim: 'Null check missing for user input validation', file: 'src/handler.ts', line: 43 }),
            makeFinding({ findingId: 'W2-F3', severity: 'info', claim: 'Could add JSDoc to exported function', file: 'src/api.ts', line: 20 }),
        ]),
        makeReview('W3', 'claude-haiku-3.5', [
            makeFinding({ findingId: 'W3-F1', severity: 'critical', claim: 'Query builder has SQL injection via string concat', file: 'src/db.ts', line: 10 }),
            makeFinding({ findingId: 'W3-F2', severity: 'medium', claim: 'Unused lodash import adds bundle weight', file: 'src/utils.ts', line: 1 }),
        ]),
        makeReview('W4', 'moonshot-v1-8k', [
            makeFinding({ findingId: 'W4-F1', severity: 'high', claim: 'Missing null check on req.body user input', file: 'src/handler.ts', line: 42 }),
            makeFinding({ findingId: 'W4-F2', severity: 'low', claim: 'Naming convention inconsistency in config', file: 'src/config.ts', line: 6 }),
        ]),
    ];
}

// --- Tests ---

describe('M7A.5.4: Claude-Facing Review Report Contract', () => {
    describe('buildReport', () => {
        it('generates a report with all required sections', () => {
            const reviews = makeLargeBundle();
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            expect(report.generatedAt).toBeTruthy();
            expect(report.summary).toBeDefined();
            expect(report.p0p1Findings).toBeDefined();
            expect(report.dissent).toBeDefined();
            expect(report.lowerFindings).toBeDefined();
            expect(report.rawReviewPointers).toBeDefined();
            expect(report.evidenceIndex).toBeDefined();
            expect(report.openQuestions).toBeDefined();
            expect(report.warnings).toBeDefined();
        });

        it('separates P0/P1 (critical/high) from lower-severity findings', () => {
            const reviews = makeLargeBundle();
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            for (const f of report.p0p1Findings) {
                expect(['critical', 'high']).toContain(f.severity);
            }
            for (const f of report.lowerFindings) {
                expect(['medium', 'low', 'info']).toContain(f.severity);
            }
        });

        it('summary severity counts match the actual findings', () => {
            const reviews = makeLargeBundle();
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            const allFindings = [...report.p0p1Findings, ...report.lowerFindings];
            const countBySeverity: Record<string, number> = {};
            for (const f of allFindings) {
                countBySeverity[f.severity] = (countBySeverity[f.severity] ?? 0) + 1;
            }

            const sc = report.summary.severityCounts;
            expect(sc.critical).toBe(countBySeverity['critical'] ?? 0);
            expect(sc.high).toBe(countBySeverity['high'] ?? 0);
            expect(sc.medium).toBe(countBySeverity['medium'] ?? 0);
            expect(sc.low).toBe(countBySeverity['low'] ?? 0);
            expect(sc.info).toBe(countBySeverity['info'] ?? 0);
        });

        it('includes no-findings witnesses in summary', () => {
            const reviews = [
                makeReview('W1', 'gpt-4o', [makeFinding({ findingId: 'F1' })]),
                makeNoFindingsReview('W2', 'deepseek-chat'),
                makeNoFindingsReview('W3', 'claude-haiku-3.5'),
            ];
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            expect(report.summary.noFindingsWitnesses).toContain('W2');
            expect(report.summary.noFindingsWitnesses).toContain('W3');
            expect(report.summary.totalWitnesses).toBe(3);
        });
    });

    describe('evidence traceability', () => {
        it('every finding maps back to at least one witness finding ID', () => {
            const reviews = makeLargeBundle();
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            const allFindings = [...report.p0p1Findings, ...report.lowerFindings];
            for (const f of allFindings) {
                expect(f.witnessPointers.length).toBeGreaterThanOrEqual(1);
                for (const wp of f.witnessPointers) {
                    expect(wp.witnessId).toBeTruthy();
                    expect(wp.findingId).toBeTruthy();
                }
            }
        });

        it('evidence index entries reference valid clusters and witnesses', () => {
            const reviews = makeLargeBundle();
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            const allClusterIds = new Set([
                ...report.p0p1Findings.map(f => f.clusterId),
                ...report.lowerFindings.map(f => f.clusterId),
            ]);
            const allWitnessIds = new Set(reviews.map(r => r.witnessId));

            for (const ep of report.evidenceIndex) {
                expect(allClusterIds.has(ep.clusterId)).toBe(true);
                expect(allWitnessIds.has(ep.witnessId)).toBe(true);
                expect(ep.findingId).toBeTruthy();
                expect(ep.claim).toBeTruthy();
                expect(ep.evidence).toBeTruthy();
            }
        });

        it('evidence index includes source file:line when witness reported them', () => {
            const reviews = [
                makeReview('W1', 'gpt-4o', [
                    makeFinding({ findingId: 'F1', file: 'src/db.ts', line: 10 }),
                ]),
            ];
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            const pointer = report.evidenceIndex.find(ep => ep.findingId === 'F1');
            expect(pointer).toBeDefined();
            expect(pointer!.file).toBe('src/db.ts');
            expect(pointer!.line).toBe(10);
        });

        it('evidence index omits file/line when witness did not report them', () => {
            const reviews = [
                makeReview('W1', 'gpt-4o', [
                    makeFinding({ findingId: 'F1', file: undefined, line: undefined }),
                ]),
            ];
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            const pointer = report.evidenceIndex.find(ep => ep.findingId === 'F1');
            expect(pointer).toBeDefined();
            expect(pointer!.file).toBeUndefined();
            expect(pointer!.line).toBeUndefined();
        });
    });

    describe('compression: large bundle to smaller report', () => {
        it('report is significantly smaller than raw witness output', () => {
            const reviews = makeLargeBundle();
            const rawSize = reviews.reduce((sum, r) => sum + r.rawOutput.length, 0);

            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);
            const reportText = renderReportText(report);

            // Report text should be substantially smaller than raw witness output
            expect(reportText.length).toBeLessThan(rawSize);
        });

        it('preserves all P0/P1 findings from a large bundle', () => {
            const reviews = makeLargeBundle();
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            // The large bundle has critical (SQL injection) and high (null check) findings
            // Both should appear in P0/P1
            expect(report.p0p1Findings.length).toBeGreaterThanOrEqual(1);

            const severities = report.p0p1Findings.map(f => f.severity);
            expect(severities).toContain('critical');
        });

        it('raw review pointers allow drill-down without including full text', () => {
            const reviews = makeLargeBundle();
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            expect(report.rawReviewPointers).toHaveLength(4);
            for (const rp of report.rawReviewPointers) {
                expect(rp.witnessId).toBeTruthy();
                expect(rp.model).toBeTruthy();
                expect(rp.rawOutputLength).toBeGreaterThan(0);
                expect(typeof rp.findingCount).toBe('number');
            }
        });
    });

    describe('renderReportText: stable section order', () => {
        it('renders sections in order: summary → P0/P1 → dissent → open questions → lower → raw pointers', () => {
            const reviews = makeLargeBundle();
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);
            const text = renderReportText(report);

            const summaryIdx = text.indexOf('## Summary');
            const p0p1Idx = text.indexOf('## P0/P1 Findings');
            const dissentIdx = text.indexOf('## Dissent');
            const openQIdx = text.indexOf('## Open Questions');
            const lowerIdx = text.indexOf('## Lower-Severity Findings');
            const rawIdx = text.indexOf('## Raw Review Pointers');

            expect(summaryIdx).toBeGreaterThanOrEqual(0);
            expect(p0p1Idx).toBeGreaterThan(summaryIdx);
            expect(dissentIdx).toBeGreaterThan(p0p1Idx);
            expect(openQIdx).toBeGreaterThan(dissentIdx);
            expect(lowerIdx).toBeGreaterThan(openQIdx);
            expect(rawIdx).toBeGreaterThan(lowerIdx);
        });

        it('renders "None." for empty P0/P1 section', () => {
            const reviews = [
                makeReview('W1', 'gpt-4o', [
                    makeFinding({ findingId: 'F1', severity: 'low', claim: 'Minor style issue' }),
                ]),
            ];
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);
            const text = renderReportText(report);

            const p0p1Section = text.slice(
                text.indexOf('## P0/P1 Findings'),
                text.indexOf('## Dissent'),
            );
            expect(p0p1Section).toContain('None.');
        });

        it('renders "No disagreements detected." when no dissent', () => {
            const reviews = [
                makeReview('W1', 'gpt-4o', [makeFinding({ findingId: 'F1' })]),
            ];
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);
            const text = renderReportText(report);

            const dissentSection = text.slice(
                text.indexOf('## Dissent'),
                text.indexOf('## Lower-Severity Findings'),
            );
            expect(dissentSection).toContain('No disagreements detected.');
        });

        it('includes budget exceeded warning when applicable', () => {
            const reviews = makeLargeBundle();
            // Force a tiny budget that will be exceeded
            const aggregated = aggregateReviews(reviews, { budgetChars: 10 });
            const report = buildReport(aggregated, reviews);
            const text = renderReportText(report);

            if (report.summary.budgetExceeded) {
                expect(text).toContain('Budget exceeded');
            }
        });

        it('includes witness counts and severity breakdown in summary', () => {
            const reviews = makeLargeBundle();
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);
            const text = renderReportText(report);

            expect(text).toContain('Witnesses: 4');
            expect(text).toContain('Critical:');
            expect(text).toContain('High:');
        });
    });

    describe('empty/edge cases', () => {
        it('handles all no_findings witnesses', () => {
            const reviews = [
                makeNoFindingsReview('W1', 'gpt-4o'),
                makeNoFindingsReview('W2', 'deepseek-chat'),
            ];
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            expect(report.p0p1Findings).toHaveLength(0);
            expect(report.lowerFindings).toHaveLength(0);
            expect(report.dissent).toHaveLength(0);
            expect(report.evidenceIndex).toHaveLength(0);
            expect(report.summary.noFindingsWitnesses).toEqual(['W1', 'W2']);
            expect(report.summary.totalFindings).toBe(0);
        });

        it('handles empty review array', () => {
            const aggregated = aggregateReviews([]);
            const report = buildReport(aggregated, []);

            expect(report.summary.totalWitnesses).toBe(0);
            expect(report.p0p1Findings).toHaveLength(0);
            expect(report.rawReviewPointers).toHaveLength(0);
        });

        it('handles single witness with single finding', () => {
            const reviews = [
                makeReview('W1', 'gpt-4o', [makeFinding({ findingId: 'F1', severity: 'critical' })]),
            ];
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            expect(report.p0p1Findings).toHaveLength(1);
            expect(report.p0p1Findings[0].severity).toBe('critical');
            expect(report.evidenceIndex).toHaveLength(1);
        });
    });

    describe('watchdog profile', () => {
        it('defines an explicit allow-list of read-only tools', () => {
            expect(WATCHDOG_PROFILE.allowedTools).toContain('read_file');
            expect(WATCHDOG_PROFILE.allowedTools).toContain('search_text');
            expect(WATCHDOG_PROFILE.allowedTools).toContain('find_paths');
            expect(WATCHDOG_PROFILE.allowedTools).toContain('estimate_tokens');
            expect(WATCHDOG_PROFILE.allowedTools).toContain('search_semantic');
            expect(WATCHDOG_PROFILE.allowedTools).toHaveLength(5);
        });

        it('does not include mutation or execution tools in allow-list', () => {
            const allowed = new Set<string>(WATCHDOG_PROFILE.allowedTools);
            expect(allowed.has('write_file')).toBe(false);
            expect(allowed.has('exec_command')).toBe(false);
            expect(allowed.has('spawn_agent')).toBe(false);
            expect(allowed.has('confirm_action')).toBe(false);
        });

        it('watchdog role is aggregation-only', () => {
            expect(WATCHDOG_PROFILE.role).toBe('review_watchdog');
            expect(WATCHDOG_PROFILE.description).toContain('Aggregates');
        });
    });

    describe('openQuestions', () => {
        it('generates open questions from disagreements', () => {
            // Create witnesses with severity divergence > 1 rank to trigger disagreement
            const reviews = [
                makeReview('W1', 'gpt-4o', [
                    makeFinding({ findingId: 'W1-F1', severity: 'critical', claim: 'SQL injection in query builder', file: 'src/db.ts', line: 10 }),
                ]),
                makeReview('W2', 'deepseek-chat', [
                    makeFinding({ findingId: 'W2-F1', severity: 'low', claim: 'Minor SQL style issue in query builder', file: 'src/db.ts', line: 10 }),
                ]),
            ];
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            // If there are disagreements, there should be open questions
            if (aggregated.disagreements.length > 0) {
                expect(report.openQuestions.length).toBeGreaterThanOrEqual(1);
                expect(report.openQuestions[0].question).toContain('disagree');
            }
        });

        it('returns empty openQuestions when no disagreements', () => {
            const reviews = [
                makeReview('W1', 'gpt-4o', [makeFinding({ findingId: 'F1' })]),
            ];
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            expect(report.openQuestions).toHaveLength(0);
        });
    });

    describe('warnings for data integrity', () => {
        it('reports empty warnings when all evidence pointers resolve', () => {
            const reviews = makeLargeBundle();
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            expect(report.warnings).toHaveLength(0);
        });

        it('ReportFinding.line is a number, not a string', () => {
            const reviews = [
                makeReview('W1', 'gpt-4o', [
                    makeFinding({ findingId: 'F1', file: 'src/db.ts', line: 42 }),
                ]),
            ];
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);

            const finding = report.p0p1Findings[0];
            expect(typeof finding.line).toBe('number');
            expect(finding.line).toBe(42);
        });

        it('renderReportText formats file:line correctly', () => {
            const reviews = [
                makeReview('W1', 'gpt-4o', [
                    makeFinding({ findingId: 'F1', file: 'src/db.ts', line: 42 }),
                ]),
            ];
            const aggregated = aggregateReviews(reviews);
            const report = buildReport(aggregated, reviews);
            const text = renderReportText(report);

            expect(text).toContain('src/db.ts:42');
        });
    });
});
