/**
 * M7A.5.4: Claude-Facing Review Report Contract
 *
 * Defines the condensed report format Claude consumes after witness review aggregation.
 * Stable section order: summary → P0/P1 findings → dissent → lower-severity → raw-review pointers.
 * Every finding traces back to witness finding IDs and source file:line.
 * Watchdog role is narrow: aggregation only, no code editing or approval decisions.
 */

import type { AggregatedReport, FindingCluster, WitnessPointer } from './aggregator.js';
import type { WitnessReview } from './witness-finding.js';
import type { FindingSeverity } from './witness-finding.js';

// --- Evidence retrieval ---

/** Traces an aggregated finding back to its origin witness review and source location */
export interface EvidencePointer {
    /** The cluster this pointer belongs to */
    clusterId: string;
    /** Witness who reported this finding */
    witnessId: string;
    /** Original finding ID in the witness output */
    findingId: string;
    /** Source file path (if reported) */
    file?: string;
    /** Source line number (if reported) */
    line?: number;
    /** The witness's original claim text */
    claim: string;
    /** The witness's original evidence text */
    evidence: string;
}

// --- Report sections ---

export interface SeverityCount {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
}

export interface ReportSummary {
    totalWitnesses: number;
    totalFindings: number;
    clusterCount: number;
    severityCounts: SeverityCount;
    noFindingsWitnesses: string[];
    budgetExceeded: boolean;
}

export interface ReportFinding {
    clusterId: string;
    severity: FindingSeverity;
    claim: string;
    evidence: string;
    file?: string;
    line?: number;
    recommendedAction: string;
    agreementCount: number;
    witnessPointers: WitnessPointer[];
}

export interface ReportDisagreement {
    topic: string;
    positions: Array<{
        witnessId: string;
        claim: string;
        severity: FindingSeverity;
    }>;
}

export interface RawReviewPointer {
    witnessId: string;
    model: string;
    findingCount: number;
    /** Byte length of raw output — lets Claude decide if drilling in is worth it */
    rawOutputLength: number;
}

/** An unresolved question surfaced during review that needs human judgment */
export interface OpenQuestion {
    question: string;
    context: string;
    relatedClusterIds: string[];
}

// --- Full report contract ---

export interface ReviewReport {
    /** ISO-8601 timestamp of report generation */
    generatedAt: string;
    summary: ReportSummary;
    /** Critical and high findings — always included, never trimmed */
    p0p1Findings: ReportFinding[];
    /** Disagreements where witnesses conflict on severity or existence */
    dissent: ReportDisagreement[];
    /** Unresolved questions that need human judgment */
    openQuestions: OpenQuestion[];
    /** Medium, low, info findings — may be trimmed by budget */
    lowerFindings: ReportFinding[];
    /** Pointers to full raw witness reviews for drill-down */
    rawReviewPointers: RawReviewPointer[];
    /** Full evidence trail for every finding — available for contested finding drill-down */
    evidenceIndex: EvidencePointer[];
    /** Warnings about data integrity issues (e.g., orphaned witness pointers) */
    warnings: string[];
}

// --- Watchdog agent profile ---

/**
 * Watchdog agent profile contract.
 * The watchdog performs aggregation only — its allowed tools are an explicit allow-list.
 * Safety enforcement comes from the sandbox (workspace boundaries) and deadline,
 * not deny-lists. The allowed_tools field is passed to spawn_agent as a narrowing override.
 */
export const WATCHDOG_PROFILE = {
    role: 'review_watchdog',
    description: 'Aggregates witness review findings into a compact Claude-facing report',
    allowedTools: [
        'read_file',
        'search_text',
        'find_paths',
        'estimate_tokens',
        'search_semantic',
    ] as const,
} as const;

// --- Severity classification ---

const P0P1_SEVERITIES: ReadonlySet<FindingSeverity> = new Set(['critical', 'high']);

// --- Report building ---

function clusterToReportFinding(cluster: FindingCluster): ReportFinding {
    const finding: ReportFinding = {
        clusterId: cluster.clusterId,
        severity: cluster.severity,
        claim: cluster.canonicalClaim,
        evidence: cluster.canonicalEvidence,
        recommendedAction: cluster.recommendedAction,
        agreementCount: cluster.agreementCount,
        witnessPointers: cluster.witnesses,
    };
    if (cluster.file !== undefined) finding.file = cluster.file;
    if (cluster.line !== undefined) finding.line = cluster.line;
    return finding;
}

function buildSeverityCounts(clusters: FindingCluster[]): SeverityCount {
    const counts: SeverityCount = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const c of clusters) {
        counts[c.severity]++;
    }
    return counts;
}

/**
 * Build the evidence index: one EvidencePointer per witness per cluster,
 * tracing back from the aggregated finding to the original witness finding.
 */
interface EvidenceIndexResult {
    pointers: EvidencePointer[];
    warnings: string[];
}

function buildEvidenceIndex(
    clusters: FindingCluster[],
    reviews: WitnessReview[],
): EvidenceIndexResult {
    const reviewMap = new Map(reviews.map(r => [r.witnessId, r]));
    const pointers: EvidencePointer[] = [];
    const warnings: string[] = [];

    for (const cluster of clusters) {
        for (const wp of cluster.witnesses) {
            const review = reviewMap.get(wp.witnessId);
            if (!review) {
                warnings.push(`Cluster ${cluster.clusterId}: witness ${wp.witnessId} not found in reviews`);
                continue;
            }
            if (review.parsed.type !== 'findings') {
                warnings.push(`Cluster ${cluster.clusterId}: witness ${wp.witnessId} has no_findings but is referenced`);
                continue;
            }

            const finding = review.parsed.findings.find(f => f.findingId === wp.findingId);
            if (!finding) {
                warnings.push(`Cluster ${cluster.clusterId}: finding ${wp.findingId} not found in witness ${wp.witnessId}`);
                continue;
            }

            pointers.push({
                clusterId: cluster.clusterId,
                witnessId: wp.witnessId,
                findingId: wp.findingId,
                ...(finding.file !== undefined ? { file: finding.file } : {}),
                ...(finding.line !== undefined ? { line: finding.line } : {}),
                claim: finding.claim,
                evidence: finding.evidence,
            });
        }
    }

    return { pointers, warnings };
}

/**
 * Derive open questions from disagreements and single-witness findings.
 * Open questions are unresolved items that need human judgment:
 * - Disagreements (witnesses conflict on severity/existence)
 * - Single-witness findings with low confidence
 */
function buildOpenQuestions(
    aggregated: AggregatedReport,
): OpenQuestion[] {
    const questions: OpenQuestion[] = [];

    // Each disagreement is an open question
    for (const d of aggregated.disagreements) {
        const relatedClusters = aggregated.clusters
            .filter(c => {
                if (!c.file) return false;
                const loc = c.line !== undefined ? `${c.file}:${c.line}` : c.file;
                return d.topic.includes(c.file) || d.topic === loc;
            })
            .map(c => c.clusterId);

        questions.push({
            question: `Witnesses disagree on: ${d.topic}`,
            context: d.positions.map(p => `${p.witnessId}: [${p.severity}] ${p.claim}`).join('; '),
            relatedClusterIds: relatedClusters,
        });
    }

    return questions;
}

function buildRawReviewPointers(reviews: WitnessReview[]): RawReviewPointer[] {
    return reviews.map(r => ({
        witnessId: r.witnessId,
        model: r.model,
        findingCount: r.parsed.type === 'findings' ? r.parsed.findings.length : 0,
        rawOutputLength: r.rawOutput.length,
    }));
}

/**
 * Build a Claude-facing ReviewReport from an AggregatedReport and the original witness reviews.
 *
 * The report is structured for one-shot reading: Claude gets summary + P0/P1 findings
 * + dissent + lower findings + raw pointers without needing all raw witness reviews.
 *
 * @param aggregated - The output of aggregateReviews()
 * @param reviews - The original WitnessReview[] (for evidence index + raw pointers)
 * @returns A ReviewReport ready for Claude consumption
 */
export function buildReport(
    aggregated: AggregatedReport,
    reviews: WitnessReview[],
): ReviewReport {
    // All clusters from the aggregated report (already budget-enforced)
    const allClusters = aggregated.clusters;

    // Split into P0/P1 vs lower severity
    const p0p1Clusters = allClusters.filter(c => P0P1_SEVERITIES.has(c.severity));
    const lowerClusters = allClusters.filter(c => !P0P1_SEVERITIES.has(c.severity));
    const evidenceResult = buildEvidenceIndex(allClusters, reviews);

    return {
        generatedAt: new Date().toISOString(),
        summary: {
            totalWitnesses: aggregated.totalWitnesses,
            totalFindings: aggregated.totalFindings,
            clusterCount: allClusters.length,
            severityCounts: buildSeverityCounts(allClusters),
            noFindingsWitnesses: aggregated.noFindingsWitnesses,
            budgetExceeded: aggregated.budgetExceeded,
        },
        p0p1Findings: p0p1Clusters.map(clusterToReportFinding),
        dissent: aggregated.disagreements.map(d => ({
            topic: d.topic,
            positions: d.positions.map(p => ({
                witnessId: p.witnessId,
                claim: p.claim,
                severity: p.severity,
            })),
        })),
        openQuestions: buildOpenQuestions(aggregated),
        lowerFindings: lowerClusters.map(clusterToReportFinding),
        rawReviewPointers: buildRawReviewPointers(reviews),
        evidenceIndex: evidenceResult.pointers,
        warnings: evidenceResult.warnings,
    };
}

/**
 * Render a ReviewReport as a human/Claude-readable text block.
 *
 * Stable section order:
 * 1. Summary
 * 2. P0/P1 Findings (critical/high)
 * 3. Dissent (disagreements)
 * 4. Lower-Severity Findings
 * 5. Raw Review Pointers
 */
export function renderReportText(report: ReviewReport): string {
    const lines: string[] = [];

    // --- Section 1: Summary ---
    lines.push('# Review Report');
    lines.push('');
    lines.push('## Summary');
    const s = report.summary;
    lines.push(`- Witnesses: ${s.totalWitnesses}`);
    lines.push(`- Total findings: ${s.totalFindings} (${s.clusterCount} clusters)`);
    const sc = s.severityCounts;
    lines.push(`- Critical: ${sc.critical} | High: ${sc.high} | Medium: ${sc.medium} | Low: ${sc.low} | Info: ${sc.info}`);
    if (s.noFindingsWitnesses.length > 0) {
        lines.push(`- No-findings witnesses: ${s.noFindingsWitnesses.join(', ')}`);
    }
    if (s.budgetExceeded) {
        lines.push('- **WARNING: Budget exceeded — some lower-severity findings may be omitted**');
    }

    // --- Section 2: P0/P1 Findings ---
    lines.push('');
    lines.push('## P0/P1 Findings (Critical + High)');
    if (report.p0p1Findings.length === 0) {
        lines.push('None.');
    } else {
        for (const f of report.p0p1Findings) {
            lines.push('');
            renderFinding(lines, f);
        }
    }

    // --- Section 3: Dissent ---
    lines.push('');
    lines.push('## Dissent');
    if (report.dissent.length === 0) {
        lines.push('No disagreements detected.');
    } else {
        for (const d of report.dissent) {
            lines.push('');
            lines.push(`### ${d.topic}`);
            for (const p of d.positions) {
                lines.push(`- ${p.witnessId}: [${p.severity}] ${p.claim}`);
            }
        }
    }

    // --- Section 4: Open Questions ---
    lines.push('');
    lines.push('## Open Questions');
    if (report.openQuestions.length === 0) {
        lines.push('None.');
    } else {
        for (const q of report.openQuestions) {
            lines.push('');
            lines.push(`- **${q.question}**`);
            lines.push(`  Context: ${q.context}`);
            if (q.relatedClusterIds.length > 0) {
                lines.push(`  Related: ${q.relatedClusterIds.join(', ')}`);
            }
        }
    }

    // --- Section 5: Lower-Severity Findings ---
    lines.push('');
    lines.push('## Lower-Severity Findings');
    if (report.lowerFindings.length === 0) {
        lines.push('None.');
    } else {
        for (const f of report.lowerFindings) {
            lines.push('');
            renderFinding(lines, f);
        }
    }

    // --- Section 6: Raw Review Pointers ---
    lines.push('');
    lines.push('## Raw Review Pointers');
    for (const rp of report.rawReviewPointers) {
        lines.push(`- ${rp.witnessId} (${rp.model}): ${rp.findingCount} findings, ${rp.rawOutputLength} bytes`);
    }

    return lines.join('\n');
}

function renderFinding(lines: string[], f: ReportFinding): void {
    const location = f.file ? (f.line !== undefined ? `${f.file}:${f.line}` : f.file) : 'no location';
    lines.push(`### [${f.severity.toUpperCase()}] ${f.clusterId} — ${location}`);
    lines.push(`**Claim:** ${f.claim}`);
    lines.push(`**Evidence:** ${f.evidence}`);
    lines.push(`**Action:** ${f.recommendedAction}`);
    lines.push(`**Agreement:** ${f.agreementCount} witness(es) — ${f.witnessPointers.map(wp => `${wp.witnessId}/${wp.findingId}`).join(', ')}`);
}
