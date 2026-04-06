#!/usr/bin/env node

const NANOGPT_URL = process.env.NANOGPT_URL ||
  'https://nano-gpt.com/api/subscription/v1/chat/completions';

const MODELS = (process.argv[2] || 'deepseek/deepseek-v3.2,moonshotai/kimi-k2.5')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const RUNS = Number.parseInt(process.argv[3] || '1', 10);
const TIMEOUT_MS = Number.parseInt(process.argv[4] || '120000', 10);

const OUTPUT_SCHEMA = `{
  "summary": "one terse sentence",
  "findings": [
    {
      "severity": "P0|P1|P2|P3",
      "claim": "short direct claim",
      "locations": ["path:line"],
      "witnesses": ["Kimi|Qwen|Gemma|MiniMax"],
      "agreement": "consensus|partial|single",
      "evidence": "short witness-backed evidence",
      "recommendedAction": "short action"
    }
  ],
  "dissent": ["short note for low-agreement or contested claims"],
  "openQuestions": ["short question if needed"]
}`;

const SYSTEM_PROMPT =
  'You aggregate witness code reviews into concise triage JSON for Claude. ' +
  'Preserve dissent, do not invent claims, and do not make final correctness judgments.';

const FIXTURES = [
  {
    id: 'minority-p0-plus-dedupe',
    markdownBundle: `Witness Kimi:
- P1 src/core/retry.ts:42-47. Timer cleanup bug. resetBackoff() allocates a new timeout but does not clear the previous one when retry is cancelled, so the old callback can fire after success and flip state back to degraded.
- P3 docs nit: changelog says 1673 tests but handoff says 1672.

Witness Qwen:
- HIGH src/core/retry.ts:42. Duplicate of Kimi's timer issue: stale retry timer not cleared before reassignment; can produce a post-success state regression.
- MEDIUM src/providers/sqlite-store.ts:133. Possible SQL injection from string concatenation in query builder.

Witness Gemma:
- CRITICAL src/auth/session.ts:88. request.headers['x-user'] is trusted as identity if present. Any caller can spoof admin by sending x-user: admin.

Witness MiniMax:
- MEDIUM src/providers/sqlite-store.ts:133. SQL injection likely in getEventsByType() because it appears to build a query dynamically.`,
    jsonBundle: {
      witnesses: [
        {
          name: 'Kimi',
          status: 'ok',
          findings: [
            {
              severity: 'P1',
              claim: 'resetBackoff() does not clear stale retry timeout before cancellation/success.',
              locations: ['src/core/retry.ts:42-47'],
              evidence: 'Old callback can fire after success and flip state back to degraded.',
              recommendedAction: 'Clear the previous timeout before assigning a new retry timer.',
            },
            {
              severity: 'P3',
              claim: 'Docs test-count mismatch between changelog and handoff.',
              locations: ['docs/changelog.md'],
              evidence: 'Changelog says 1673 tests but handoff says 1672.',
              recommendedAction: 'Align the stated test count.',
            },
          ],
        },
        {
          name: 'Qwen',
          status: 'ok',
          findings: [
            {
              severity: 'HIGH',
              claim: 'Stale retry timer is not cleared before reassignment.',
              locations: ['src/core/retry.ts:42'],
              evidence: 'Can trigger a post-success state regression.',
              recommendedAction: 'Cancel any existing timer before storing a replacement timer.',
            },
            {
              severity: 'MEDIUM',
              claim: 'Possible SQL injection in query builder.',
              locations: ['src/providers/sqlite-store.ts:133'],
              evidence: 'Query appears to use string concatenation.',
              recommendedAction: 'Verify parameterization and sanitize dynamic fragments.',
            },
          ],
        },
        {
          name: 'Gemma',
          status: 'ok',
          findings: [
            {
              severity: 'CRITICAL',
              claim: 'x-user request header is trusted as identity.',
              locations: ['src/auth/session.ts:88'],
              evidence: 'Any caller can spoof admin by sending x-user: admin.',
              recommendedAction: 'Do not trust caller-controlled headers for authenticated identity.',
            },
          ],
        },
        {
          name: 'MiniMax',
          status: 'ok',
          findings: [
            {
              severity: 'MEDIUM',
              claim: 'SQL injection likely in getEventsByType().',
              locations: ['src/providers/sqlite-store.ts:133'],
              evidence: 'Function appears to build a SQL query dynamically.',
              recommendedAction: 'Inspect query construction and replace concatenation with bound parameters.',
            },
          ],
        },
      ],
    },
    expected: {
      duplicateNeedle: 'retry',
      duplicateWitnesses: ['Kimi', 'Qwen'],
      minorityLocation: 'src/auth/session.ts:88',
      minorityWitness: 'Gemma',
      dissentLocation: 'src/providers/sqlite-store.ts:133',
      forbiddenTerms: ['csrf', 'path traversal', 'buffer overflow', 'deadlock'],
      allowNoFindings: false,
    },
  },
  {
    id: 'all-clear-no-findings',
    markdownBundle: `Witness Kimi:
- No findings. Residual risk: tests do not cover Windows shell quoting.

Witness Qwen:
- No correctness issues found. Residual risk: performance on very large logs not measured.

Witness Gemma:
- No findings.

Witness MiniMax:
- No findings. Minor residual risk around future schema evolution.`,
    jsonBundle: {
      witnesses: [
        {
          name: 'Kimi',
          status: 'ok',
          findings: [],
          residualRisk: 'Tests do not cover Windows shell quoting.',
        },
        {
          name: 'Qwen',
          status: 'ok',
          findings: [],
          residualRisk: 'Performance on very large logs not measured.',
        },
        {
          name: 'Gemma',
          status: 'ok',
          findings: [],
        },
        {
          name: 'MiniMax',
          status: 'ok',
          findings: [],
          residualRisk: 'Future schema evolution could regress compatibility.',
        },
      ],
    },
    expected: {
      duplicateNeedle: null,
      duplicateWitnesses: [],
      minorityLocation: null,
      minorityWitness: null,
      dissentLocation: null,
      forbiddenTerms: ['sql injection', 'spoof', 'null pointer', 'race condition', 'memory leak'],
      allowNoFindings: true,
    },
  },
  {
    id: 'conflicting-severity-no-invention',
    markdownBundle: `Witness Kimi:
- P2 src/cli/repl.ts:210. Minor UX bug: spinner keeps rendering one extra frame after cancellation.

Witness Qwen:
- P1 src/cli/repl.ts:210. Same spinner issue, but Qwen rates it higher because it can corrupt captured non-TTY logs.

Witness Gemma:
- No findings.

Witness MiniMax:
- LOW src/docs/usage.md:12. Typo: "delgation" should be "delegation".`,
    jsonBundle: {
      witnesses: [
        {
          name: 'Kimi',
          status: 'ok',
          findings: [
            {
              severity: 'P2',
              claim: 'Spinner renders one extra frame after cancellation.',
              locations: ['src/cli/repl.ts:210'],
              evidence: 'Minor UX issue in the REPL spinner path.',
              recommendedAction: 'Stop spinner rendering immediately on cancel.',
            },
          ],
        },
        {
          name: 'Qwen',
          status: 'ok',
          findings: [
            {
              severity: 'P1',
              claim: 'Spinner renders one extra frame after cancellation.',
              locations: ['src/cli/repl.ts:210'],
              evidence: 'Can corrupt captured non-TTY logs.',
              recommendedAction: 'Stop rendering before writing post-cancel terminal output.',
            },
          ],
        },
        {
          name: 'Gemma',
          status: 'ok',
          findings: [],
        },
        {
          name: 'MiniMax',
          status: 'ok',
          findings: [
            {
              severity: 'LOW',
              claim: 'Typo "delgation" should be "delegation".',
              locations: ['src/docs/usage.md:12'],
              evidence: 'Documentation spelling error.',
              recommendedAction: 'Fix the typo.',
            },
          ],
        },
      ],
    },
    expected: {
      duplicateNeedle: 'spinner',
      duplicateWitnesses: ['Kimi', 'Qwen'],
      minorityLocation: null,
      minorityWitness: null,
      dissentLocation: null,
      forbiddenTerms: ['sql injection', 'x-user', 'spoof', 'csrf', 'auth bypass'],
      allowNoFindings: false,
    },
  },
  {
    id: 'buried-minority-after-noise',
    markdownBundle: `Witness Kimi:
High-level note: I skimmed the patch and most things look structurally fine.
One small concern:
- P2 src/ui/theme.ts:19. The color fallback changed from #fff to #fafafa, which may slightly alter contrast.

Witness Qwen:
No findings.

Witness Gemma:
I have a long preamble before the actual defect because the review output is messy.

\`\`\`
meta: ignore this fence, it is just formatting noise
\`\`\`

Actual issue:
- CRITICAL src/auth/token.ts:77. verifyToken() accepts alg=none for legacy payloads. An attacker can forge an unsigned admin token.

Witness MiniMax:
No findings.`,
    jsonBundle: {
      witnesses: [
        {
          name: 'Kimi',
          status: 'ok',
          findings: [
            {
              severity: 'P2',
              claim: 'Color fallback changed from #fff to #fafafa.',
              locations: ['src/ui/theme.ts:19'],
              evidence: 'May slightly alter contrast.',
              recommendedAction: 'Confirm the visual contrast change is intentional.',
            },
          ],
        },
        {
          name: 'Qwen',
          status: 'ok',
          findings: [],
        },
        {
          name: 'Gemma',
          status: 'ok',
          findings: [
            {
              severity: 'CRITICAL',
              claim: 'verifyToken() accepts alg=none for legacy payloads.',
              locations: ['src/auth/token.ts:77'],
              evidence: 'An attacker can forge an unsigned admin token.',
              recommendedAction: 'Reject unsigned tokens and remove alg=none compatibility.',
            },
          ],
        },
        {
          name: 'MiniMax',
          status: 'ok',
          findings: [],
        },
      ],
    },
    expected: {
      duplicateNeedle: null,
      duplicateWitnesses: [],
      minorityLocation: 'src/auth/token.ts:77',
      minorityWitness: 'Gemma',
      dissentLocation: null,
      forbiddenTerms: ['sql injection', 'path traversal', 'csrf', 'deadlock'],
      allowNoFindings: false,
    },
  },
];

function buildPrompt(format, fixture) {
  const bundle = format === 'json'
    ? JSON.stringify(fixture.jsonBundle, null, 2)
    : fixture.markdownBundle;

  return `Act as ACA's review watchdog/PM. Write like Claude: terse, direct, no opener, no cheerleading.

Task:
- Deduplicate witness findings.
- Preserve minority high-severity findings.
- Do not invent new claims.
- Do not decide final correctness; mark consensus vs single-witness dissent.
- Keep the report concise enough for Claude to read first.

Witness input format: ${format === 'json' ? 'per-witness JSON' : 'freeform Markdown'}

Return STRICT JSON only, no markdown fences, matching:
${OUTPUT_SCHEMA}

Witness bundle:
${bundle}`;
}

function extractJson(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{')) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

function normalizeSeverity(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === 'CRITICAL' || raw === 'P0') return 'P0';
  if (raw === 'HIGH' || raw === 'P1') return 'P1';
  if (raw === 'MEDIUM' || raw === 'P2') return 'P2';
  if (raw === 'LOW' || raw === 'P3') return 'P3';
  return raw;
}

function hasRequiredSchema(parsed) {
  return Boolean(
    parsed &&
    typeof parsed === 'object' &&
    typeof parsed.summary === 'string' &&
    Array.isArray(parsed.findings) &&
    Array.isArray(parsed.dissent) &&
    Array.isArray(parsed.openQuestions) &&
    parsed.findings.every((finding) => (
      finding &&
      typeof finding === 'object' &&
      typeof finding.severity === 'string' &&
      typeof finding.claim === 'string' &&
      Array.isArray(finding.locations) &&
      Array.isArray(finding.witnesses) &&
      typeof finding.agreement === 'string' &&
      typeof finding.evidence === 'string' &&
      typeof finding.recommendedAction === 'string'
    ))
  );
}

function scoreOutput(text, expected) {
  const score = {
    schema: 0,
    dedupe: 0,
    minority: 0,
    dissent: 0,
    noFabrication: 0,
    noFindings: 0,
    total: 0,
    parseError: '',
    chars: text.length,
  };

  let parsed;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (error) {
    score.parseError = error instanceof Error ? error.message : String(error);
    return score;
  }

  if (hasRequiredSchema(parsed)) score.schema = 2;

  const findings = parsed.findings || [];
  const normalized = findings.map((finding) => ({
    severity: normalizeSeverity(finding.severity),
    claimBlob: `${finding.claim || ''} ${finding.evidence || ''}`.toLowerCase(),
    locationBlob: (finding.locations || []).join(' ').toLowerCase(),
    witnessSet: new Set((finding.witnesses || []).map((witness) => String(witness || '').trim())),
    agreementValue: String(finding.agreement || '').toLowerCase(),
  }));
  const outputBlob = JSON.stringify(parsed).toLowerCase();

  if (expected.duplicateNeedle) {
    const duplicates = normalized.filter((finding) => (
      finding.claimBlob.includes(expected.duplicateNeedle) ||
      finding.locationBlob.includes(expected.duplicateNeedle)
    ));
    if (
      duplicates.length === 1 &&
      expected.duplicateWitnesses.every((name) => duplicates[0].witnessSet.has(name))
    ) {
      score.dedupe = 2;
    }
  } else {
    score.dedupe = 2;
  }

  if (expected.minorityLocation && expected.minorityWitness) {
    const minority = normalized.find((finding) => (
      finding.locationBlob.includes(expected.minorityLocation.toLowerCase())
    ));
    if (minority && minority.witnessSet.has(expected.minorityWitness)) {
      score.minority = minority.agreementValue.includes('single') ? 2 : 1;
    }
  } else {
    score.minority = 2;
  }

  if (expected.dissentLocation) {
    const dissent = normalized.find((finding) => (
      finding.locationBlob.includes(expected.dissentLocation.toLowerCase())
    ));
    if (
      dissent &&
      (dissent.agreementValue.includes('partial') || dissent.agreementValue.includes('single'))
    ) {
      score.dissent = 1;
    }
  } else {
    score.dissent = 1;
  }

  if (!expected.forbiddenTerms.some((term) => outputBlob.includes(term.toLowerCase()))) {
    score.noFabrication = 2;
  }

  if (expected.allowNoFindings) {
    if (
      findings.length === 0 &&
      /no findings|no concrete|zero concrete defects|all clear|no defects|no correctness issues|no issues/i
        .test(String(parsed.summary || ''))
    ) {
      score.noFindings = 2;
    }
  } else {
    score.noFindings = 2;
  }

  score.total = (
    score.schema +
    score.dedupe +
    score.minority +
    score.dissent +
    score.noFabrication +
    score.noFindings
  );

  return score;
}

async function callModel(model, format, fixture) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(NANOGPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.NANOGPT_API_KEY || ''}`,
      },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        max_tokens: 900,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildPrompt(format, fixture) },
        ],
      }),
      signal: controller.signal,
    });

    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        text: body.slice(0, 1000),
        latencyMs: Date.now() - startedAt,
        error: `http ${response.status}`,
      };
    }

    let parsedBody;
    try {
      parsedBody = JSON.parse(body);
    } catch (error) {
      return {
        ok: false,
        text: body.slice(0, 1000),
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      ok: true,
      text: String(parsedBody.choices?.[0]?.message?.content || ''),
      latencyMs: Date.now() - startedAt,
      usage: parsedBody.usage || null,
    };
  } catch (error) {
    return {
      ok: false,
      text: '',
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function run() {
  const stats = new Map();

  for (const model of MODELS) {
    for (const format of ['markdown', 'json']) {
      stats.set(`${model}::${format}`, {
        totalScore: 0,
        maxScore: 0,
        successes: 0,
        calls: 0,
        parseFailures: 0,
        totalLatencyMs: 0,
      });
    }
  }

  for (let runIndex = 1; runIndex <= RUNS; runIndex += 1) {
    console.log(`\n=== Run ${runIndex}/${RUNS} ===`);

    for (const fixture of FIXTURES) {
      console.log(`\n--- Fixture: ${fixture.id} ---`);

      for (const model of MODELS) {
        for (const format of ['markdown', 'json']) {
          const key = `${model}::${format}`;
          const result = await callModel(model, format, fixture);
          const bucket = stats.get(key);
          bucket.calls += 1;
          bucket.totalLatencyMs += result.latencyMs;

          if (!result.ok) {
            console.log(`${model} [${format}] -> API FAIL (${result.error}) ${result.latencyMs}ms`);
            continue;
          }

          const score = scoreOutput(result.text, fixture.expected);
          bucket.totalScore += score.total;
          bucket.maxScore += 11;
          bucket.successes += 1;
          if (score.parseError) bucket.parseFailures += 1;

          const usage = result.usage
            ? ` in=${result.usage.prompt_tokens ?? '?'} out=${result.usage.completion_tokens ?? '?'}`
            : '';
          const parseSuffix = score.parseError ? ` parseError=${score.parseError}` : '';
          console.log(
            `${model} [${format}] -> ${score.total}/11 ${result.latencyMs}ms chars=${score.chars}${usage}${parseSuffix}`
          );
        }
      }
    }
  }

  console.log('\n=== Summary ===');
  for (const [key, bucket] of stats.entries()) {
    const avgScore = bucket.successes
      ? (bucket.totalScore / bucket.successes).toFixed(2)
      : '0.00';
    const avgLatency = bucket.calls
      ? Math.round(bucket.totalLatencyMs / bucket.calls)
      : 0;
    const successRate = bucket.calls
      ? ((bucket.successes / bucket.calls) * 100).toFixed(1)
      : '0.0';

    console.log(
      `${key} avgScore=${avgScore}/11 success=${successRate}% ` +
      `parseFailures=${bucket.parseFailures} avgLatencyMs=${avgLatency}`
    );
  }
}

if (!process.env.NANOGPT_API_KEY) {
  console.error('NANOGPT_API_KEY is not set');
  process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
