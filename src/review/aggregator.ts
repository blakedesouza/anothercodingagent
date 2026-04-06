/**
 * M7A.5.2: Review Aggregator
 *
 * Deterministic aggregation of multi-witness review findings into a compact report.
 * Clusters duplicates by file/line + claim similarity, ranks by severity/confidence/agreement,
 * preserves dissent for minority findings above a confidence threshold,
 * and includes evidence pointers back to raw witness data.
 *
 * Never auto-resolves correctness — reports consensus/disagreement and lets Claude decide.
 */

import type {
    WitnessReview,
    WitnessFinding,
    FindingSeverity,
    FindingConfidence,
    FindingsResult,
} from './witness-finding.js';

// --- Configuration ---

export interface AggregatorConfig {
    /** Max characters for the rendered report (default: 8000) */
    budgetChars: number;
    /** Min confidence for a minority finding to be preserved as dissent (default: 'medium') */
    dissentConfidenceThreshold: FindingConfidence;
    /** Word-overlap threshold (0–1) for claim similarity (default: 0.5) */
    claimSimilarityThreshold: number;
    /** Max line distance to consider findings at the "same location" (default: 5) */
    lineProximity: number;
}

export const DEFAULT_AGGREGATOR_CONFIG: AggregatorConfig = {
    budgetChars: 8000,
    dissentConfidenceThreshold: 'medium',
    claimSimilarityThreshold: 0.5,
    lineProximity: 5,
};

// --- Output types ---

/** Pointer from an aggregated finding back to the originating witness */
export interface WitnessPointer {
    witnessId: string;
    findingId: string;
}

/** A cluster of similar findings from multiple witnesses */
export interface FindingCluster {
    clusterId: string;
    canonicalClaim: string;
    canonicalEvidence: string;
    severity: FindingSeverity;
    confidence: FindingConfidence;
    file?: string;
    line?: number;
    recommendedAction: string;
    witnesses: WitnessPointer[];
    agreementCount: number;
}

/** A disagreement where witnesses have conflicting views on the same location/topic */
export interface Disagreement {
    topic: string;
    positions: Array<{
        witnessId: string;
        findingId: string;
        claim: string;
        severity: FindingSeverity;
    }>;
}

/** The aggregated report Claude consumes */
export interface AggregatedReport {
    totalWitnesses: number;
    totalFindings: number;
    clusters: FindingCluster[];
    disagreements: Disagreement[];
    noFindingsWitnesses: string[];
    budgetUsed: number;
    budgetLimit: number;
    /** True when critical/high findings alone exceed the budget — report is over budget but P0/P1 items are preserved */
    budgetExceeded: boolean;
}

// --- Severity/confidence ordering (higher index = higher priority) ---

const SEVERITY_RANK: Record<FindingSeverity, number> = {
    info: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
};

const CONFIDENCE_RANK: Record<FindingConfidence, number> = {
    low: 0,
    medium: 1,
    high: 2,
};

// --- Text similarity ---

/**
 * Tokenize a claim into normalized words for comparison.
 * Lowercase, strip punctuation, split on whitespace.
 */
export function tokenize(text: string): Set<string> {
    const words = text
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 0);
    return new Set(words);
}

/**
 * Jaccard similarity between two token sets.
 * Returns 0 for empty sets (no similarity).
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const word of a) {
        if (b.has(word)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

// --- Clustering logic ---

interface TaggedFinding {
    witnessId: string;
    finding: WitnessFinding;
    tokens: Set<string>;
}

/**
 * Check if two findings should be in the same cluster based on
 * file/line proximity and claim text similarity.
 */
function shouldCluster(
    a: TaggedFinding,
    b: TaggedFinding,
    config: AggregatorConfig,
): boolean {
    const sim = jaccardSimilarity(a.tokens, b.tokens);

    // Both have file info — require same file + nearby lines + some text similarity
    if (a.finding.file && b.finding.file) {
        if (a.finding.file !== b.finding.file) return false;
        if (a.finding.line !== undefined && b.finding.line !== undefined) {
            // Both have lines: check proximity, use relaxed threshold for same-location findings
            if (Math.abs(a.finding.line - b.finding.line) > config.lineProximity) return false;
            return sim >= config.claimSimilarityThreshold * 0.6;
        }
        // One or both lack line info: use full threshold (can't confirm proximity)
        return sim >= config.claimSimilarityThreshold;
    }

    // No file info on at least one — rely purely on claim similarity with full threshold
    return sim >= config.claimSimilarityThreshold;
}

/**
 * Select the highest severity from a list of findings.
 */
function highestSeverity(findings: WitnessFinding[]): FindingSeverity {
    let max: FindingSeverity = 'info';
    for (const f of findings) {
        if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[max]) max = f.severity;
    }
    return max;
}

/**
 * Select the highest confidence from a list of findings.
 */
function highestConfidence(findings: WitnessFinding[]): FindingConfidence {
    let max: FindingConfidence = 'low';
    for (const f of findings) {
        if (CONFIDENCE_RANK[f.confidence] > CONFIDENCE_RANK[max]) max = f.confidence;
    }
    return max;
}

/**
 * Pick the canonical (representative) finding from a cluster.
 * Prefers highest severity, then highest confidence, then longest evidence.
 */
function pickCanonical(findings: TaggedFinding[]): TaggedFinding {
    return findings.reduce((best, curr) => {
        const sevCmp = SEVERITY_RANK[curr.finding.severity] - SEVERITY_RANK[best.finding.severity];
        if (sevCmp !== 0) return sevCmp > 0 ? curr : best;
        const confCmp = CONFIDENCE_RANK[curr.finding.confidence] - CONFIDENCE_RANK[best.finding.confidence];
        if (confCmp !== 0) return confCmp > 0 ? curr : best;
        return curr.finding.evidence.length > best.finding.evidence.length ? curr : best;
    });
}

/**
 * Cluster tagged findings using single-linkage: each new finding joins the first
 * matching cluster, or starts a new one.
 */
function clusterFindings(
    tagged: TaggedFinding[],
    config: AggregatorConfig,
): TaggedFinding[][] {
    const clusters: TaggedFinding[][] = [];

    for (const item of tagged) {
        let merged = false;
        for (const cluster of clusters) {
            // True single-linkage: match against any member, not just the seed
            if (cluster.some(member => shouldCluster(member, item, config))) {
                cluster.push(item);
                merged = true;
                break;
            }
        }
        if (!merged) {
            clusters.push([item]);
        }
    }

    return clusters;
}

// --- Disagreement detection ---

/**
 * Detect disagreements: clusters where different witnesses assigned
 * materially different severities (>1 rank apart) to the same issue.
 */
function detectDisagreements(
    clusters: FindingCluster[],
    tagged: TaggedFinding[],
): Disagreement[] {
    const disagreements: Disagreement[] = [];

    for (const cluster of clusters) {
        if (cluster.witnesses.length < 2) continue;

        // Gather the severity ratings from each witness in this cluster
        const positions: Disagreement['positions'] = [];
        for (const wp of cluster.witnesses) {
            const tf = tagged.find(t => t.witnessId === wp.witnessId && t.finding.findingId === wp.findingId);
            if (tf) {
                positions.push({
                    witnessId: wp.witnessId,
                    findingId: wp.findingId,
                    claim: tf.finding.claim,
                    severity: tf.finding.severity,
                });
            }
        }

        // Check if severities diverge by more than 1 rank
        const severities = positions.map(p => SEVERITY_RANK[p.severity]);
        const minSev = Math.min(...severities);
        const maxSev = Math.max(...severities);
        if (maxSev - minSev > 1) {
            const topic = cluster.file
                ? `${cluster.file}${cluster.line !== undefined ? `:${cluster.line}` : ''}`
                : cluster.canonicalClaim.slice(0, 80);
            disagreements.push({ topic, positions });
        }
    }

    return disagreements;
}

// --- Budget enforcement ---

/**
 * Render the aggregated report as a string for budget measurement.
 * This is a rough estimate — the actual rendering is in M7A.5.4.
 */
function estimateReportSize(report: AggregatedReport): number {
    return JSON.stringify(report).length;
}

/**
 * Truncate lower-severity clusters to fit within budget, preserving all P0/P1 (critical/high).
 */
function enforceBudget(
    clusters: FindingCluster[],
    disagreements: Disagreement[],
    totalWitnesses: number,
    totalFindings: number,
    noFindingsWitnesses: string[],
    config: AggregatorConfig,
): AggregatedReport {
    const base = {
        totalWitnesses,
        totalFindings,
        disagreements,
        noFindingsWitnesses,
        budgetLimit: config.budgetChars,
    };

    // Start with all clusters, check budget
    let report: AggregatedReport = {
        ...base,
        clusters,
        budgetUsed: 0,
        budgetExceeded: false,
    };
    report.budgetUsed = estimateReportSize(report);

    if (report.budgetUsed <= config.budgetChars) {
        return report;
    }

    // Must trim — never drop critical or high findings
    const preserved = clusters.filter(
        c => SEVERITY_RANK[c.severity] >= SEVERITY_RANK['high'],
    );

    // Protect minority findings (agreementCount=1) above dissentConfidenceThreshold
    const confidenceThreshold = CONFIDENCE_RANK[config.dissentConfidenceThreshold];
    const trimmable = clusters
        .filter(c => SEVERITY_RANK[c.severity] < SEVERITY_RANK['high'])
        .sort((a, b) => {
            // Dissent-protected findings sort first (harder to trim)
            const aDissent = a.agreementCount === 1 && CONFIDENCE_RANK[a.confidence] >= confidenceThreshold ? 1 : 0;
            const bDissent = b.agreementCount === 1 && CONFIDENCE_RANK[b.confidence] >= confidenceThreshold ? 1 : 0;
            if (aDissent !== bDissent) return bDissent - aDissent;
            // Then severity desc, then agreement desc
            const sevCmp = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
            if (sevCmp !== 0) return sevCmp;
            return b.agreementCount - a.agreementCount;
        });

    // Add trimmable clusters one at a time until budget is reached
    for (const cluster of trimmable) {
        const candidate = [...preserved, cluster];
        const candidateReport: AggregatedReport = {
            ...base,
            clusters: candidate,
            budgetUsed: 0,
            budgetExceeded: false,
        };
        candidateReport.budgetUsed = estimateReportSize(candidateReport);
        if (candidateReport.budgetUsed <= config.budgetChars) {
            preserved.push(cluster);
        }
    }

    report = {
        ...base,
        clusters: preserved,
        budgetUsed: 0,
        budgetExceeded: false,
    };
    report.budgetUsed = estimateReportSize(report);
    // Signal when even the preserved set exceeds budget (critical/high findings too large)
    report.budgetExceeded = report.budgetUsed > config.budgetChars;
    return report;
}

// --- Main aggregation entry point ---

/**
 * Aggregate findings from multiple witness reviews into a compact report.
 *
 * @param reviews - Parsed witness reviews (from buildWitnessReview)
 * @param config - Aggregation configuration (uses defaults if omitted)
 * @returns Aggregated report with clustered findings, disagreements, and evidence pointers
 */
export function aggregateReviews(
    reviews: WitnessReview[],
    config: Partial<AggregatorConfig> = {},
): AggregatedReport {
    const cfg: AggregatorConfig = { ...DEFAULT_AGGREGATOR_CONFIG, ...config };

    // Separate findings from no_findings witnesses
    const noFindingsWitnesses: string[] = [];
    const tagged: TaggedFinding[] = [];

    for (const review of reviews) {
        if (review.parsed.type === 'no_findings') {
            noFindingsWitnesses.push(review.witnessId);
            continue;
        }
        const fr = review.parsed as FindingsResult;
        for (const finding of fr.findings) {
            tagged.push({
                witnessId: review.witnessId,
                finding,
                tokens: tokenize(finding.claim),
            });
        }
    }

    // Handle empty input or all no_findings
    if (tagged.length === 0) {
        return {
            totalWitnesses: reviews.length,
            totalFindings: 0,
            clusters: [],
            disagreements: [],
            noFindingsWitnesses,
            budgetUsed: 0,
            budgetLimit: cfg.budgetChars,
            budgetExceeded: false,
        };
    }

    // Cluster findings
    const rawClusters = clusterFindings(tagged, cfg);

    // Build FindingCluster objects
    let clusterIdx = 0;
    const clusters: FindingCluster[] = rawClusters.map(members => {
        const canonical = pickCanonical(members);
        const cluster: FindingCluster = {
            clusterId: `C-${++clusterIdx}`,
            canonicalClaim: canonical.finding.claim,
            canonicalEvidence: canonical.finding.evidence,
            severity: highestSeverity(members.map(m => m.finding)),
            confidence: highestConfidence(members.map(m => m.finding)),
            ...(canonical.finding.file !== undefined ? { file: canonical.finding.file } : {}),
            ...(canonical.finding.line !== undefined ? { line: canonical.finding.line } : {}),
            recommendedAction: canonical.finding.recommendedAction,
            witnesses: members.map(m => ({
                witnessId: m.witnessId,
                findingId: m.finding.findingId,
            })),
            agreementCount: new Set(members.map(m => m.witnessId)).size,
        };
        return cluster;
    });

    // Sort clusters: severity desc → confidence desc → agreement desc
    clusters.sort((a, b) => {
        const sevCmp = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
        if (sevCmp !== 0) return sevCmp;
        const confCmp = CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
        if (confCmp !== 0) return confCmp;
        return b.agreementCount - a.agreementCount;
    });

    // Detect disagreements
    const disagreements = detectDisagreements(clusters, tagged);

    // Enforce budget
    const report = enforceBudget(
        clusters,
        disagreements,
        reviews.length,
        tagged.length,
        noFindingsWitnesses,
        cfg,
    );

    return report;
}
