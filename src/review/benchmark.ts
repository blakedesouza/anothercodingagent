/**
 * M7A.5.3: Watchdog Model Benchmark Harness
 *
 * Offline benchmark for scoring candidate NanoGPT models as review watchdogs.
 * Scores on 5 dimensions: dedupe accuracy, dissent preservation, severity ranking,
 * faithfulness to witness claims, and output compactness.
 *
 * The harness accepts an injectable ModelRunner so tests can use deterministic mocks.
 */

import type { WitnessReview } from './witness-finding.js';
import {
    FINDING_SEVERITIES,
    FINDING_CONFIDENCES,
    type FindingSeverity,
    type FindingConfidence,
} from './witness-finding.js';

// --- Watchdog output schema ---

/** A single finding in the watchdog's aggregated report */
export interface WatchdogFinding {
    claim: string;
    severity: FindingSeverity;
    confidence: FindingConfidence;
    witnessRefs: Array<{ witnessId: string; findingId: string }>;
    /** Must be a substring of referenced witness raw output — evidence guardrail */
    evidenceQuote: string;
    recommendedAction: string;
}

/** The structured report a watchdog model produces */
export interface WatchdogReport {
    findings: WatchdogFinding[];
    disagreements: Array<{
        topic: string;
        positions: Array<{ witnessId: string; claim: string; severity: FindingSeverity }>;
    }>;
    summary: string;
}

// --- Benchmark fixture types ---

/** A group of finding IDs that should be merged into one cluster */
export interface ExpectedCluster {
    /** Finding IDs that should be grouped together */
    findingIds: string[];
    /** The expected severity of the merged cluster */
    expectedSeverity?: FindingSeverity;
}

/** Ground truth for scoring a watchdog's output */
export interface FixtureExpectations {
    /** Expected number of deduplicated clusters in output */
    expectedClusterCount: number;
    /** Finding IDs that must appear in output (dissent/minority preservation) */
    requiredFindingIds: string[];
    /** Groups of finding IDs that should be merged */
    expectedClusters: ExpectedCluster[];
    /** All valid claims from witness input — anything else is hallucinated */
    validClaimSubstrings: string[];
    /** Expected severity ordering of output clusters (most severe first) */
    expectedSeverityOrder?: FindingSeverity[];
}

/** A benchmark test case: input reviews + expected outcomes */
export interface BenchmarkFixture {
    id: string;
    description: string;
    reviews: WitnessReview[];
    expected: FixtureExpectations;
}

// --- Scoring types ---

/** Per-model scores on a single fixture */
export interface FixtureScore {
    fixtureId: string;
    dedupeAccuracy: number;
    dissentPreservation: number;
    severityRanking: number;
    faithfulness: number;
    compactness: number;
}

/** Aggregate scores for a model across all fixtures */
export interface BenchmarkScore {
    model: string;
    dedupeAccuracy: number;
    dissentPreservation: number;
    severityRanking: number;
    faithfulness: number;
    compactness: number;
    total: number;
    fixtureScores: FixtureScore[];
}

/** Full benchmark result including metadata */
export interface BenchmarkResult {
    scores: BenchmarkScore[];
    winner: string;
    fallback: string;
    promptVersion: string;
    fixtureIds: string[];
    timestamp: string;
}

// --- Model runner interface ---

/**
 * Injectable function that calls a model and returns the raw text response.
 * Real implementation calls NanoGPT; tests inject a deterministic mock.
 */
export type ModelRunner = (model: string, prompt: string) => Promise<string>;

// --- Deprecated model exclusion ---

/**
 * Models known to be sunset or deprecated. Excluded from default candidate set
 * even if benchmark scores are strong, since they may disappear without notice.
 */
export const DEPRECATED_MODELS: ReadonlySet<string> = new Set([
    // Placeholder — add deprecated IDs as they're discovered
]);

/** Default candidate models for watchdog benchmarking */
export const DEFAULT_CANDIDATES: readonly string[] = [
    'gpt-4o-mini',
    'deepseek-chat',
    'claude-haiku-3.5-20241022',
    'moonshot-v1-8k',
    'gpt-4o',
];

// --- Scoring weights ---

export const SCORING_WEIGHTS = {
    dedupeAccuracy: 0.25,
    dissentPreservation: 0.25,
    severityRanking: 0.15,
    faithfulness: 0.25,
    compactness: 0.10,
} as const;

// --- Watchdog prompt ---

const PROMPT_VERSION = '1.0.0';

/**
 * Build the watchdog prompt for a given review bundle.
 * The prompt instructs the model to aggregate witness findings into a structured report.
 */
export function buildWatchdogPrompt(reviews: WitnessReview[]): string {
    const reviewsBlock = reviews.map((r, i) => {
        return `--- Witness ${i + 1}: ${r.witnessId} (model: ${r.model}) ---\n${r.rawOutput}`;
    }).join('\n\n');

    return `You are a code review aggregation watchdog. Your job is to read multiple witness reviews and produce a compact, structured report.

RULES:
1. Deduplicate: Group findings that describe the same issue (same file/line, similar claim) into one entry.
2. Preserve dissent: If one witness found something others missed, and the confidence is medium or higher, keep it.
3. Rank by severity: Output findings from most severe to least.
4. Quote evidence: Every finding MUST include an evidenceQuote that is an EXACT substring from the witness review that reported it. Do NOT paraphrase or invent evidence.
5. Reference witnesses: Every finding must list which witnesses reported it with their witnessId and findingId.
6. Stay faithful: Do NOT add findings, claims, or recommendations that are not present in the witness reviews. Your role is aggregation only.
7. Note disagreements: If witnesses conflict on severity or whether something is an issue, list it in disagreements.

OUTPUT FORMAT (JSON only, no markdown fences):
{
  "findings": [
    {
      "claim": "description of the issue",
      "severity": "critical|high|medium|low|info",
      "confidence": "high|medium|low",
      "witnessRefs": [{"witnessId": "...", "findingId": "..."}],
      "evidenceQuote": "exact substring from witness review",
      "recommendedAction": "what to do"
    }
  ],
  "disagreements": [
    {
      "topic": "what they disagree about",
      "positions": [{"witnessId": "...", "claim": "...", "severity": "..."}]
    }
  ],
  "summary": "one-line summary of the review state"
}

WITNESS REVIEWS:

${reviewsBlock}

Produce the JSON report now.`;
}

// --- Watchdog output parsing ---

/**
 * Parse the watchdog model's raw output into a WatchdogReport.
 * Returns null if the output is not valid JSON or doesn't match the schema.
 */
export function parseWatchdogOutput(raw: string): WatchdogReport | null {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
        const firstNewline = cleaned.indexOf('\n');
        if (firstNewline !== -1) {
            cleaned = cleaned.slice(firstNewline + 1);
        }
        if (cleaned.endsWith('```')) {
            cleaned = cleaned.slice(0, -3).trim();
        }
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        return null;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }

    const obj = parsed as Record<string, unknown>;

    // Validate findings array
    if (!Array.isArray(obj.findings)) return null;
    const findings: WatchdogFinding[] = [];
    for (const f of obj.findings) {
        if (f === null || typeof f !== 'object' || Array.isArray(f)) return null;
        const finding = f as Record<string, unknown>;

        if (typeof finding.claim !== 'string') return null;
        if (typeof finding.severity !== 'string' ||
            !(FINDING_SEVERITIES as readonly string[]).includes(finding.severity)) return null;
        if (typeof finding.confidence !== 'string' ||
            !(FINDING_CONFIDENCES as readonly string[]).includes(finding.confidence)) return null;
        if (!Array.isArray(finding.witnessRefs)) return null;
        if (typeof finding.evidenceQuote !== 'string') return null;
        if (typeof finding.recommendedAction !== 'string') return null;

        findings.push({
            claim: finding.claim,
            severity: finding.severity as FindingSeverity,
            confidence: finding.confidence as FindingConfidence,
            witnessRefs: (finding.witnessRefs as Array<Record<string, unknown>>).map(r => ({
                witnessId: String(r.witnessId ?? ''),
                findingId: String(r.findingId ?? ''),
            })),
            evidenceQuote: finding.evidenceQuote,
            recommendedAction: finding.recommendedAction,
        });
    }

    // Validate disagreements (optional, default to empty)
    const disagreements: WatchdogReport['disagreements'] = [];
    if (Array.isArray(obj.disagreements)) {
        for (const d of obj.disagreements) {
            if (d === null || typeof d !== 'object' || Array.isArray(d)) continue;
            const dis = d as Record<string, unknown>;
            if (typeof dis.topic !== 'string') continue;
            if (!Array.isArray(dis.positions)) continue;
            disagreements.push({
                topic: dis.topic,
                positions: (dis.positions as Array<Record<string, unknown>>).map(p => ({
                    witnessId: String(p.witnessId ?? ''),
                    claim: String(p.claim ?? ''),
                    severity: String(p.severity ?? 'info') as FindingSeverity,
                })),
            });
        }
    }

    return {
        findings,
        disagreements,
        summary: typeof obj.summary === 'string' ? obj.summary : '',
    };
}

// --- Scoring functions ---

const SEVERITY_RANK: Record<string, number> = {
    info: 0, low: 1, medium: 2, high: 3, critical: 4,
};

/**
 * Score dedupe accuracy: how well the watchdog merged duplicate findings.
 * Compares actual cluster count to expected, and checks that expected groups
 * are properly merged (all referenced by the same output finding).
 */
export function scoreDedupe(
    report: WatchdogReport,
    expected: FixtureExpectations,
): number {
    if (expected.expectedClusterCount === 0) {
        return report.findings.length === 0 ? 1.0 : 0.0;
    }

    // Count accuracy: how close is the actual count to expected?
    const countDiff = Math.abs(report.findings.length - expected.expectedClusterCount);
    const countScore = Math.max(0, 1.0 - countDiff / expected.expectedClusterCount);

    // Merge accuracy: for each expected cluster, check if its finding IDs
    // all appear in the witnessRefs of a single output finding
    let mergeHits = 0;
    for (const cluster of expected.expectedClusters) {
        if (cluster.findingIds.length < 2) {
            mergeHits++; // Single-finding clusters are trivially correct
            continue;
        }

        // Check if any output finding references all IDs from this cluster
        const merged = report.findings.some(f => {
            const refIds = new Set(f.witnessRefs.map(r => r.findingId));
            return cluster.findingIds.every(id => refIds.has(id));
        });
        if (merged) mergeHits++;
    }

    const mergeScore = expected.expectedClusters.length > 0
        ? mergeHits / expected.expectedClusters.length
        : 1.0;

    return (countScore + mergeScore) / 2;
}

/**
 * Score dissent preservation: are required minority findings present?
 */
export function scoreDissent(
    report: WatchdogReport,
    expected: FixtureExpectations,
): number {
    if (expected.requiredFindingIds.length === 0) return 1.0;

    // Check if each required finding ID appears in some output finding's witnessRefs
    const allRefIds = new Set<string>();
    for (const f of report.findings) {
        for (const ref of f.witnessRefs) {
            allRefIds.add(ref.findingId);
        }
    }

    let hits = 0;
    for (const reqId of expected.requiredFindingIds) {
        if (allRefIds.has(reqId)) hits++;
    }

    return hits / expected.requiredFindingIds.length;
}

/**
 * Score severity ranking: are findings ordered from most to least severe?
 */
export function scoreSeverity(
    report: WatchdogReport,
    _expected: FixtureExpectations,
): number {
    if (report.findings.length <= 1) return 1.0;

    // Check monotonic decreasing severity in output
    let inversions = 0;
    let comparisons = 0;
    for (let i = 0; i < report.findings.length - 1; i++) {
        const curr = SEVERITY_RANK[report.findings[i].severity] ?? 0;
        const next = SEVERITY_RANK[report.findings[i + 1].severity] ?? 0;
        comparisons++;
        if (curr < next) inversions++;
    }

    if (comparisons === 0) return 1.0;
    return 1.0 - inversions / comparisons;
}

/**
 * Score faithfulness: penalize claims not traceable to witness input.
 * The evidenceQuote must be a substring of some witness's rawOutput.
 */
export function scoreFaithfulness(
    report: WatchdogReport,
    reviews: WitnessReview[],
): number {
    if (report.findings.length === 0) return 1.0;

    const reviewsByWitness = new Map(reviews.map(r => [r.witnessId, r]));

    let faithful = 0;
    for (const finding of report.findings) {
        // WitnessRefs must reference actual witnesses
        const hasValidRefs = finding.witnessRefs.length > 0 &&
            finding.witnessRefs.every(ref => reviewsByWitness.has(ref.witnessId));

        // Evidence guardrail: evidenceQuote must appear in a *referenced* witness's raw output
        // (not just any witness — prevents cross-witness evidence misattribution)
        const hasEvidence = finding.evidenceQuote.length > 0 &&
            finding.witnessRefs.some(ref => {
                const review = reviewsByWitness.get(ref.witnessId);
                return review !== undefined && review.rawOutput.includes(finding.evidenceQuote);
            });

        if (hasEvidence && hasValidRefs) faithful++;
    }

    return faithful / report.findings.length;
}

/**
 * Score compactness: ratio of output size to input size.
 * Lower is better, capped at 1.0.
 */
export function scoreCompactness(
    reportJson: string,
    reviews: WitnessReview[],
): number {
    const inputSize = reviews.reduce((sum, r) => sum + r.rawOutput.length, 0);
    if (inputSize === 0) return 1.0;

    const ratio = reportJson.length / inputSize;
    // Perfect score at 20% compression or better, zero at 100%+ of input size
    if (ratio <= 0.2) return 1.0;
    if (ratio >= 1.0) return 0.0;
    return 1.0 - (ratio - 0.2) / 0.8;
}

/**
 * Score a single watchdog output against a fixture's expectations.
 */
export function scoreFixture(
    reportJson: string,
    report: WatchdogReport,
    fixture: BenchmarkFixture,
): FixtureScore {
    return {
        fixtureId: fixture.id,
        dedupeAccuracy: scoreDedupe(report, fixture.expected),
        dissentPreservation: scoreDissent(report, fixture.expected),
        severityRanking: scoreSeverity(report, fixture.expected),
        faithfulness: scoreFaithfulness(report, fixture.reviews),
        compactness: scoreCompactness(reportJson, fixture.reviews),
    };
}

/**
 * Compute a weighted total from individual dimension scores.
 */
export function computeTotal(scores: Omit<FixtureScore, 'fixtureId'>): number {
    return (
        scores.dedupeAccuracy * SCORING_WEIGHTS.dedupeAccuracy +
        scores.dissentPreservation * SCORING_WEIGHTS.dissentPreservation +
        scores.severityRanking * SCORING_WEIGHTS.severityRanking +
        scores.faithfulness * SCORING_WEIGHTS.faithfulness +
        scores.compactness * SCORING_WEIGHTS.compactness
    );
}

// --- Main benchmark runner ---

export interface BenchmarkOptions {
    /** Models to benchmark (defaults to DEFAULT_CANDIDATES minus deprecated) */
    candidates?: string[];
    /** Fixtures to run */
    fixtures: BenchmarkFixture[];
    /** Injectable model runner */
    runner: ModelRunner;
}

/**
 * Run the full benchmark across all candidates and fixtures.
 * Returns scored results with a winner and fallback model.
 */
export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
    const candidates = (options.candidates ?? [...DEFAULT_CANDIDATES])
        .filter(m => !DEPRECATED_MODELS.has(m));

    if (candidates.length === 0) {
        throw new Error('No valid candidate models after excluding deprecated models');
    }

    const allScores: BenchmarkScore[] = [];

    for (const model of candidates) {
        const fixtureScores: FixtureScore[] = [];

        for (const fixture of options.fixtures) {
            const prompt = buildWatchdogPrompt(fixture.reviews);
            let rawOutput: string;
            try {
                rawOutput = await options.runner(model, prompt);
            } catch {
                // Model failed — score zero on all dimensions
                fixtureScores.push({
                    fixtureId: fixture.id,
                    dedupeAccuracy: 0,
                    dissentPreservation: 0,
                    severityRanking: 0,
                    faithfulness: 0,
                    compactness: 0,
                });
                continue;
            }

            const report = parseWatchdogOutput(rawOutput);
            if (!report) {
                // Unparseable output — score zero
                fixtureScores.push({
                    fixtureId: fixture.id,
                    dedupeAccuracy: 0,
                    dissentPreservation: 0,
                    severityRanking: 0,
                    faithfulness: 0,
                    compactness: 0,
                });
                continue;
            }

            fixtureScores.push(scoreFixture(rawOutput, report, fixture));
        }

        // Average scores across fixtures
        const avgScore = {
            dedupeAccuracy: avg(fixtureScores.map(s => s.dedupeAccuracy)),
            dissentPreservation: avg(fixtureScores.map(s => s.dissentPreservation)),
            severityRanking: avg(fixtureScores.map(s => s.severityRanking)),
            faithfulness: avg(fixtureScores.map(s => s.faithfulness)),
            compactness: avg(fixtureScores.map(s => s.compactness)),
        };

        allScores.push({
            model,
            ...avgScore,
            total: computeTotal(avgScore),
            fixtureScores,
        });
    }

    // Sort by total score descending
    allScores.sort((a, b) => b.total - a.total);

    return {
        scores: allScores,
        winner: allScores[0]?.model ?? '',
        fallback: allScores[1]?.model ?? '',
        promptVersion: PROMPT_VERSION,
        fixtureIds: options.fixtures.map(f => f.id),
        timestamp: new Date().toISOString(),
    };
}

function avg(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}
