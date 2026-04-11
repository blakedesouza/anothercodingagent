import { describe, it, expect } from 'vitest';
import { extractFindingsFromMarkdown } from '../../src/review/markdown-adapter.js';

describe('extractFindingsFromMarkdown', () => {
    describe('no_findings cases', () => {
        it('returns no_findings for empty markdown', () => {
            const result = extractFindingsFromMarkdown('kimi', 'moonshotai/kimi-k2.5', '');
            expect(result.parsed.type).toBe('no_findings');
            expect(result.witnessId).toBe('kimi');
            expect(result.model).toBe('moonshotai/kimi-k2.5');
        });

        it('returns no_findings when no severity keywords present', () => {
            const md = `## Summary\n\nThe file looks good.\n\n## Conclusion\n\nNo issues found.`;
            const result = extractFindingsFromMarkdown('deepseek', 'deepseek/deepseek-v3.2', md);
            expect(result.parsed.type).toBe('no_findings');
        });

        it('returns no_findings for meta-only sections', () => {
            const md = `## Summary\n\nThis is a high-level overview.\n\n## Open Questions\n\nSome open questions here at high priority.`;
            const result = extractFindingsFromMarkdown('qwen', 'qwen/qwen3-coder', md);
            expect(result.parsed.type).toBe('no_findings');
        });

        it('preserves rawOutput regardless of parse result', () => {
            const md = 'No issues found.';
            const result = extractFindingsFromMarkdown('kimi', 'moonshotai/kimi-k2.5', md);
            expect(result.rawOutput).toBe(md);
        });
    });

    describe('findings extraction from heading sections', () => {
        it('extracts a finding with severity keyword in heading', () => {
            const md = `## High Severity: Missing Input Validation

The function \`parseInput\` at src/parser.ts does not validate the length of the input string.
**File:** \`src/parser.ts\`
**Lines:** 42

This could lead to a buffer overflow.`;
            const result = extractFindingsFromMarkdown('kimi', 'moonshotai/kimi-k2.5', md);
            expect(result.parsed.type).toBe('findings');
            if (result.parsed.type !== 'findings') return;
            expect(result.parsed.findings).toHaveLength(1);
            const f = result.parsed.findings[0];
            expect(f.severity).toBe('high');
            expect(f.findingId).toBe('kimi-F1');
            expect(f.confidence).toBe('medium');
            expect(f.file).toBe('src/parser.ts');
            expect(f.line).toBe(42);
            expect(f.claim).toContain('Missing Input Validation');
        });

        it('extracts severity keyword from section body if not in heading', () => {
            const md = `## Authentication Issue

**Critical:** The session token is stored in plaintext in localStorage.
**File:** \`src/auth/session.ts\``;
            const result = extractFindingsFromMarkdown('deepseek', 'deepseek/deepseek-v3.2', md);
            expect(result.parsed.type).toBe('findings');
            if (result.parsed.type !== 'findings') return;
            expect(result.parsed.findings[0].severity).toBe('critical');
        });

        it('extracts multiple findings from multiple sections', () => {
            const md = `## High: SQL Injection Risk

The query at src/db.ts:88 uses string concatenation.
**File:** \`src/db.ts\`
**Lines:** 88

## Medium: Missing Error Handling

The fetch call at src/api.ts:12 does not handle network errors.
**File:** \`src/api.ts\`
**Lines:** 12`;
            const result = extractFindingsFromMarkdown('kimi', 'moonshotai/kimi-k2.5', md);
            expect(result.parsed.type).toBe('findings');
            if (result.parsed.type !== 'findings') return;
            expect(result.parsed.findings).toHaveLength(2);
            expect(result.parsed.findings[0].findingId).toBe('kimi-F1');
            expect(result.parsed.findings[1].findingId).toBe('kimi-F2');
            expect(result.parsed.findings[0].severity).toBe('high');
            expect(result.parsed.findings[1].severity).toBe('medium');
        });

        it('skips meta sections even with severity keywords', () => {
            const md = `## Summary

This is a high-level assessment of critical issues.

## Real Finding: High Severity

Actual issue found at src/index.ts.`;
            const result = extractFindingsFromMarkdown('kimi', 'moonshotai/kimi-k2.5', md);
            expect(result.parsed.type).toBe('findings');
            if (result.parsed.type !== 'findings') return;
            // Should only extract from "Real Finding" section, not Summary
            expect(result.parsed.findings).toHaveLength(1);
        });

        it('extracts recommendedAction from bold pattern', () => {
            const md = `## High: Race Condition

A race condition exists in the timer loop.
**Recommended action:** Add a mutex lock around the timer access.`;
            const result = extractFindingsFromMarkdown('kimi', 'moonshotai/kimi-k2.5', md);
            expect(result.parsed.type).toBe('findings');
            if (result.parsed.type !== 'findings') return;
            expect(result.parsed.findings[0].recommendedAction).toContain('mutex lock');
        });
    });

    describe('findings extraction from bullet items (fallback)', () => {
        it('extracts findings from severity-keyword bullet items when no sections match', () => {
            const md = `**Concrete Findings:**

- **Critical:** The root endpoint returns 500 on malformed input.
- **High:** Missing rate limiting on /api/auth.
- This item has no severity keyword and should be skipped.`;
            const result = extractFindingsFromMarkdown('kimi', 'moonshotai/kimi-k2.5', md);
            expect(result.parsed.type).toBe('findings');
            if (result.parsed.type !== 'findings') return;
            expect(result.parsed.findings).toHaveLength(2);
            expect(result.parsed.findings[0].severity).toBe('critical');
            expect(result.parsed.findings[1].severity).toBe('high');
        });

        it('does not fall back to bullet items if sections already matched', () => {
            const md = `## High Severity: Auth Issue

Token stored in plaintext.

- **Critical:** Also a critical bullet.`;
            const result = extractFindingsFromMarkdown('kimi', 'moonshotai/kimi-k2.5', md);
            // Sections matched first, bullet fallback not triggered
            expect(result.parsed.type).toBe('findings');
            if (result.parsed.type !== 'findings') return;
            expect(result.parsed.findings).toHaveLength(1);
            expect(result.parsed.findings[0].severity).toBe('high');
        });
    });

    describe('real-world witness output shapes', () => {
        it('handles ACA consult witness response format', () => {
            const md = `**Concrete Findings:**

- **File:** \`/workspace/anothercodingagent/docs/rp/authoring-contract.md\`
- **Lines 1-10:** The first Markdown heading in the file is \`# RP Knowledge Pack Authoring Contract\`, found on line 1.

No bug was found in the task execution.`;
            // This real example has no severity keywords — should be no_findings
            const result = extractFindingsFromMarkdown('deepseek', 'deepseek/deepseek-v3.2', md);
            expect(result.parsed.type).toBe('no_findings');
        });

        it('handles triage-style output gracefully', () => {
            const md = `# ACA Consult Triage Report

## Consensus Findings

- The witness report indicates a protocol conformance assessment was initiated.

## Dissent

No dissenting evidence.

## Open Questions

1. Incomplete witness evidence.`;
            // All headings are meta-sections — should be no_findings
            const result = extractFindingsFromMarkdown('triage', 'zai-org/glm-5', md);
            expect(result.parsed.type).toBe('no_findings');
        });

        it('handles witness output with explicit severity classifications', () => {
            const md = `## Review Results

### High: Unvalidated File Path

The read_file tool at src/tools/read-file.ts:55 accepts user-provided paths without normalization.
**File:** \`src/tools/read-file.ts\`
**Lines:** 55
**Recommended action:** Apply path.resolve() and validate against the workspace root before reading.

### Info: Minor Style Issue

Variable naming inconsistency in src/utils.ts.
**File:** \`src/utils.ts\``;
            const result = extractFindingsFromMarkdown('kimi', 'moonshotai/kimi-k2.5', md);
            expect(result.parsed.type).toBe('findings');
            if (result.parsed.type !== 'findings') return;
            expect(result.parsed.findings).toHaveLength(2);
            expect(result.parsed.findings[0].severity).toBe('high');
            expect(result.parsed.findings[1].severity).toBe('info');
            expect(result.parsed.findings[0].file).toBe('src/tools/read-file.ts');
        });
    });

    describe('metadata', () => {
        it('sets parsedAt to a valid ISO-8601 timestamp', () => {
            const md = `## High: Test Issue\n\nSome high severity issue.`;
            const result = extractFindingsFromMarkdown('kimi', 'moonshotai/kimi-k2.5', md);
            expect(() => new Date(result.parsedAt)).not.toThrow();
            expect(new Date(result.parsedAt).getFullYear()).toBeGreaterThanOrEqual(2026);
        });

        it('generates unique findingIds per witness', () => {
            const md = `## High: Issue A\n\nHigh severity.\n\n## Medium: Issue B\n\nMedium severity.`;
            const result = extractFindingsFromMarkdown('deepseek', 'deepseek/deepseek-v3.2', md);
            if (result.parsed.type !== 'findings') return;
            const ids = result.parsed.findings.map(f => f.findingId);
            expect(new Set(ids).size).toBe(ids.length);
            expect(ids[0]).toMatch(/^deepseek-F\d+$/);
        });
    });
});
