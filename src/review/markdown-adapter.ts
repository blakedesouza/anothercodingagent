/**
 * M7A.5 Wiring: Markdown-to-Structured Adapter
 *
 * Extracts structured WitnessFinding objects from the freeform Markdown that
 * `aca consult` witnesses produce. This bridges the format gap between:
 *   - consult witnesses: freeform Markdown at triage_input_path
 *   - M7A.5 pipeline: expects ParsedWitnessOutput (strict discriminated union)
 *
 * Extraction is conservative: under-extract rather than hallucinate.
 * A finding with 3 fields correctly populated is better than 8 fields guessed.
 *
 * If no structured findings can be extracted, returns no_findings instead of
 * fabricating data.
 */

import type { WitnessReview } from './witness-finding.js';
import { FINDING_SEVERITIES, type FindingSeverity } from './witness-finding.js';

// --- Severity keyword detection ---

const SEVERITY_PATTERN = new RegExp(
    `\\b(${FINDING_SEVERITIES.join('|')})\\b`,
    'i',
);

function detectSeverity(text: string): FindingSeverity | null {
    const match = SEVERITY_PATTERN.exec(text);
    if (!match) return null;
    const raw = match[1].toLowerCase();
    if ((FINDING_SEVERITIES as readonly string[]).includes(raw)) {
        return raw as FindingSeverity;
    }
    return null;
}

// --- File:line extraction ---

// Matches: **File:** `/path/to/file.ts` or just /path/to/file.ts
const FILE_PATTERN = /\*\*file:?\*\*\s*[`']?([^\s`'")\]]+)[`']?/i;
// Matches: **Lines:** 10-20 or **Line:** 5 or `:5`
const LINE_PATTERN = /(?:\*\*lines?:?\*\*\s*|:)(\d+)/i;

function extractFileInfo(text: string): { file?: string; line?: number } {
    const fileMatch = FILE_PATTERN.exec(text);
    const lineMatch = LINE_PATTERN.exec(text);
    const result: { file?: string; line?: number } = {};
    if (fileMatch) result.file = fileMatch[1];
    if (lineMatch) {
        const n = parseInt(lineMatch[1], 10);
        if (!isNaN(n) && n >= 1) result.line = n;
    }
    return result;
}

// --- Claim extraction ---

// Extract first bold phrase (**...**) or heading text
const BOLD_PATTERN = /\*\*([^*\n]{3,120})\*\*/;

function extractClaim(headingText: string, sectionBody: string): string {
    // Prefer the heading text if it's meaningful (not just "Findings" etc.)
    const heading = headingText.trim();
    const skipHeadings = /^(findings?|summary|overview|results?|notes?|analysis|assessment|report)$/i;
    if (heading && !skipHeadings.test(heading) && heading.length >= 5) {
        return heading;
    }
    // Fall back to first bold phrase in section body
    const bold = BOLD_PATTERN.exec(sectionBody);
    if (bold) return bold[1].trim();
    // Fall back to first non-empty line
    const firstLine = sectionBody.split('\n').map(l => l.replace(/^[-*•>]\s*/, '').trim()).find(l => l.length >= 5);
    return firstLine ?? heading;
}

// --- Evidence extraction ---

function extractEvidence(sectionBody: string): string {
    // Take first 400 chars of section body, trimmed
    return sectionBody.trim().slice(0, 400).trim();
}

// --- RecommendedAction extraction ---

const ACTION_PATTERN = /\*\*(?:recommended\s+action|action|fix|resolution):?\*\*\s*(.+)/i;

function extractAction(sectionBody: string): string {
    const match = ACTION_PATTERN.exec(sectionBody);
    if (match) return match[1].trim().slice(0, 200);
    return 'Review and address this finding.';
}

// --- Section splitting ---

// Split markdown by H2/H3 headings
const HEADING_PATTERN = /^#{2,3}\s+(.+)$/gm;

interface MarkdownSection {
    heading: string;
    body: string;
}

function splitIntoSections(markdown: string): MarkdownSection[] {
    const sections: MarkdownSection[] = [];
    const matches = [...markdown.matchAll(HEADING_PATTERN)];

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const heading = match[1].trim();
        const start = (match.index ?? 0) + match[0].length;
        const end = i + 1 < matches.length ? (matches[i + 1].index ?? markdown.length) : markdown.length;
        const body = markdown.slice(start, end).trim();
        sections.push({ heading, body });
    }

    // If no headings, treat entire markdown as one section
    if (sections.length === 0 && markdown.trim().length > 0) {
        sections.push({ heading: '', body: markdown.trim() });
    }

    return sections;
}

// --- Filter out meta-sections ---

// Sections that are structural, not findings
const META_SECTION_PATTERN = /^(summary|overview|context|background|introduction|conclusion|recommendations?|next steps?|triage|status|protocol|conformance|assessment|open questions?|false positives?|dissent|no[\s-]?findings?)$/i;

function isMetaSection(heading: string): boolean {
    return META_SECTION_PATTERN.test(heading.trim());
}

// --- Main export ---

/**
 * Extract structured findings from a witness's freeform Markdown output.
 * Returns a WitnessReview ready for the M7A.5 aggregation pipeline.
 *
 * If no structured findings can be extracted, the review reports no_findings
 * with a residualRisk note explaining why.
 */
export function extractFindingsFromMarkdown(
    witnessId: string,
    model: string,
    markdown: string,
): WitnessReview {
    const sections = splitIntoSections(markdown);
    const findings: Array<{
        findingId: string;
        severity: FindingSeverity;
        claim: string;
        evidence: string;
        file?: string;
        line?: number;
        confidence: 'medium';
        recommendedAction: string;
    }> = [];

    // Determine strategy: section-based when real headings exist, bullet-based otherwise.
    const hasRealHeadings = sections.some(s => s.heading !== '');

    if (hasRealHeadings) {
        // Look for severity signals in each heading section
        for (const section of sections) {
            if (isMetaSection(section.heading)) continue;

            const fullText = `${section.heading}\n${section.body}`;
            const severity = detectSeverity(fullText);
            if (!severity) continue;

            const claim = extractClaim(section.heading, section.body);
            if (!claim || claim.length < 5) continue;

            const evidence = extractEvidence(section.body);
            if (!evidence) continue;

            const { file, line } = extractFileInfo(fullText);
            const recommendedAction = extractAction(section.body);
            const findingId = `${witnessId}-F${findings.length + 1}`;

            findings.push({
                findingId,
                severity,
                claim,
                evidence,
                ...(file !== undefined ? { file } : {}),
                ...(line !== undefined ? { line } : {}),
                confidence: 'medium',
                recommendedAction,
            });
        }
    }

    // Scan bullet-list items when there are no real headings (flat markdown format)
    if (!hasRealHeadings) {
        const bulletItems = markdown.match(/^[-*•]\s+.+$/gm) ?? [];
        for (const item of bulletItems) {
            const severity = detectSeverity(item);
            if (!severity) continue;

            const claim = item.replace(/^[-*•]\s+/, '').replace(/\*\*/g, '').trim();
            if (claim.length < 5) continue;

            const { file, line } = extractFileInfo(item);
            const findingId = `${witnessId}-F${findings.length + 1}`;

            findings.push({
                findingId,
                severity,
                claim: claim.slice(0, 200),
                evidence: claim.slice(0, 400),
                ...(file !== undefined ? { file } : {}),
                ...(line !== undefined ? { line } : {}),
                confidence: 'medium',
                recommendedAction: 'Review and address this finding.',
            });
        }
    }

    if (findings.length === 0) {
        return {
            witnessId,
            model,
            rawOutput: markdown,
            parsed: {
                type: 'no_findings',
                residualRisk: 'Witness markdown output did not contain extractable structured findings (no severity keywords matched under non-meta headings or bullet items).',
            },
            parsedAt: new Date().toISOString(),
        };
    }

    return {
        witnessId,
        model,
        rawOutput: markdown,
        parsed: {
            type: 'findings',
            findings,
        },
        parsedAt: new Date().toISOString(),
    };
}
