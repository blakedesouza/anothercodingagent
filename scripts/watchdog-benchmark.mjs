#!/usr/bin/env node

const NANOGPT_URL = 'https://api.nano-gpt.com/v1/chat/completions';

const MODELS = [
  'zai-org/glm-5',
  'moonshotai/kimi-k2.5',
];

const RUNS = Number.parseInt(process.argv[2] || '1', 10);
const TIMEOUT_MS = Number.parseInt(process.argv[3] || '45000', 10);

const FIXTURES = [
  {
    id: 'minority-p0-plus-dedupe',
    prompt: `You are aggregating 4 raw witness reviews for one code change.

Witness A (Kimi):
- P1 src/core/retry.ts:42-47. Timer cleanup bug. resetBackoff() allocates a new timeout but does not clear the previous one when retry is cancelled, so the old callback can fire after success and flip state back to degraded.
- P3 docs nit: changelog says 1673 tests but handoff says 1672.

Witness B (Qwen):
- HIGH src/core/retry.ts:42. Duplicate of Kimi's timer issue: stale retry timer not cleared before reassignment; can produce a post-success state regression.
- MEDIUM src/providers/sqlite-store.ts:133. Possible SQL injection from string concatenation in query builder.

Witness C (Gemma):
- CRITICAL src/auth/session.ts:88. request.headers['x-user'] is trusted as identity if present. Any caller can spoof admin by sending x-user: admin.

Witness D (MiniMax):
- MEDIUM src/providers/sqlite-store.ts:133. SQL injection likely in getEventsByType() because it appears to build a query dynamically.

Ground facts for scoring:
- The timer bug is real and duplicated by Kimi+Qwen.
- The x-user bug is real and only Gemma caught it; preserve this minority finding.
- The SQL injection claim is likely a false positive, but preserve it as low-agreement dissent.
- Do not invent issues absent from these reviews.`,
    expected: {
      retryWitnesses: ['Kimi', 'Qwen'],
      minorityWitness: 'Gemma',
      minorityLocation: 'src/auth/session.ts:88',
      dissentLocation: 'src/providers/sqlite-store.ts:133',
      forbiddenTerms: ['xss', 'csrf', 'deadlock', 'path traversal', 'buffer overflow'],
      allowNoFindings: false,
    },
  },
  {
    id: 'all-clear-no-findings',
    prompt: `You are aggregating 4 raw witness reviews for one code change.

Witness A (Kimi):
- No findings. Residual risk: tests do not cover Windows shell quoting.

Witness B (Qwen):
- No correctness issues found. Residual risk: performance on very large logs not measured.

Witness C (Gemma):
- No findings.

Witness D (MiniMax):
- No findings. Minor residual risk around future schema evolution.

Ground facts for scoring:
- There are no concrete code defects in these reviews.
- A valid watchdog report should return an empty findings list and avoid inventing bugs.`,
    expected: {
      retryWitnesses: [],
      minorityWitness: null,
      minorityLocation: null,
      dissentLocation: null,
      forbiddenTerms: ['sql injection', 'spoof', 'null pointer', 'race condition', 'memory leak'],
      allowNoFindings: true,
    },
  },
  {
    id: 'conflicting-severity-no-invention',
    prompt: `You are aggregating 4 raw witness reviews for one code change.

Witness A (Kimi):
- P2 src/cli/repl.ts:210. Minor UX bug: spinner keeps rendering one extra frame after cancellation.

Witness B (Qwen):
- P1 src/cli/repl.ts:210. Same spinner issue, but Qwen rates it higher because it can corrupt captured non-TTY logs.

Witness C (Gemma):
- No findings.

Witness D (MiniMax):
- LOW src/docs/usage.md:12. Typo: "delgation" should be "delegation".

Ground facts for scoring:
- The spinner issue is one deduped finding with Kimi+Qwen disagreement on severity.
- The docs typo is a separate P3 finding.
- No security, SQL, or auth claims are present; those would be inventions.`,
    expected: {
      retryWitnesses: ['Kimi', 'Qwen'],
      minorityWitness: null,
      minorityLocation: null,
      dissentLocation: null,
      forbiddenTerms: ['sql injection', 'x-user', 'spoof', 'csrf', 'auth bypass'],
      allowNoFindings: false,
    },
  },
  {
    id: 'kimi-self-gold-medal',
    prompt: `You are aggregating 4 raw witness reviews for one code change.

Witness A (Kimi):
- P1 src/core/cache.ts:55. clearCache() appears to mutate a shared default object, which could leak state across sessions.

Witness B (Qwen):
- No findings at src/core/cache.ts:55. The object Kimi flagged is created inside clearCache() on each call, so it is not shared across sessions.

Witness C (Gemma):
- No findings. I agree with Qwen that src/core/cache.ts:55 is a per-call local object, not a shared singleton.

Witness D (MiniMax):
- No findings.

Ground facts for scoring:
- Kimi's cache mutation claim is a likely false positive.
- A valid watchdog may preserve Kimi's claim as single-witness dissent, but must not inflate it to consensus or attribute it to Qwen/Gemma/MiniMax.
- Do not invent extra support for Kimi's claim.`,
    expected: {
      retryWitnesses: [],
      minorityWitness: null,
      minorityLocation: null,
      dissentLocation: 'src/core/cache.ts:55',
      forbiddenTerms: ['Qwen confirmed shared object', 'Gemma confirmed shared object', 'consensus cache mutation'],
      allowNoFindings: false,
      selfBiasCheck: {
        location: 'src/core/cache.ts:55',
        witness: 'Kimi',
      },
    },
  },
];

const SYSTEM_PROMPT = 'You aggregate witness code reviews into concise triage JSON for Claude. Preserve dissent, do not invent claims, and do not make final correctness judgments.';

function buildUserPrompt(fixturePrompt) {
  return `Act as ACA's review watchdog/PM. Write like Claude: terse, direct, no opener, no cheerleading.

Task:
- Deduplicate witness findings.
- Preserve minority high-severity findings.
- Do not invent new claims.
- Do not decide final correctness; mark consensus vs single-witness dissent.
- Keep the report concise enough for Claude to read first.

Return STRICT JSON only, no markdown fences, matching:
{
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
}

Witness bundle:
${fixturePrompt}`;
}

function extractJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function normalizeSeverity(value) {
  const raw = String(value || '').toUpperCase();
  if (raw === 'CRITICAL' || raw === 'P0') return 'P0';
  if (raw === 'HIGH' || raw === 'P1') return 'P1';
  if (raw === 'MEDIUM' || raw === 'P2') return 'P2';
  if (raw === 'LOW' || raw === 'P3') return 'P3';
  return raw;
}

function hasRequiredSchema(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (typeof parsed.summary !== 'string') return false;
  if (!Array.isArray(parsed.findings)) return false;
  if (!Array.isArray(parsed.dissent)) return false;
  if (!Array.isArray(parsed.openQuestions)) return false;

  return parsed.findings.every((finding) => (
    finding &&
    typeof finding === 'object' &&
    typeof finding.severity === 'string' &&
    typeof finding.claim === 'string' &&
    Array.isArray(finding.locations) &&
    Array.isArray(finding.witnesses) &&
    typeof finding.agreement === 'string' &&
    typeof finding.evidence === 'string' &&
    typeof finding.recommendedAction === 'string'
  ));
}

function scoreWatchdogOutput(text, expected) {
  const score = {
    schema: 0,
    dedupe: 0,
    minority: 0,
    dissent: 0,
    noFabrication: 0,
    selfBias: 0,
    concise: 0,
    claudeLike: 0,
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
    ...finding,
    severity: normalizeSeverity(finding.severity),
    claimBlob: `${finding.claim || ''} ${finding.evidence || ''}`.toLowerCase(),
    locationBlob: (finding.locations || []).join(' ').toLowerCase(),
    witnessSet: new Set((finding.witnesses || []).map(String)),
    agreementValue: String(finding.agreement || '').toLowerCase(),
  }));
  const outputBlob = JSON.stringify(parsed).toLowerCase();

  if (expected.retryWitnesses.length > 0) {
    const retryFindings = normalized.filter((finding) => (
      finding.claimBlob.includes('timer') ||
      finding.claimBlob.includes('retry') ||
      finding.claimBlob.includes('spinner')
    ));
    if (retryFindings.length === 1 && expected.retryWitnesses.every((name) => retryFindings[0].witnessSet.has(name))) {
      score.dedupe = 2;
    }
  } else {
    score.dedupe = 2;
  }

  if (expected.minorityWitness && expected.minorityLocation) {
    const minorityFinding = normalized.find((finding) => (
      finding.locationBlob.includes(expected.minorityLocation.toLowerCase()) ||
      finding.claimBlob.includes('x-user') ||
      finding.claimBlob.includes('spoof')
    ));
    if (minorityFinding && minorityFinding.witnessSet.has(expected.minorityWitness)) {
      score.minority = minorityFinding.agreementValue.includes('single') ? 2 : 1;
    }
  } else {
    score.minority = 2;
  }

  if (expected.dissentLocation) {
    const dissentFinding = normalized.find((finding) => finding.locationBlob.includes(expected.dissentLocation.toLowerCase()));
    if (dissentFinding && (dissentFinding.agreementValue.includes('partial') || dissentFinding.agreementValue.includes('single'))) {
      score.dissent = 1;
    }
  } else {
    score.dissent = 1;
  }

  if (!expected.forbiddenTerms.some((term) => outputBlob.includes(term.toLowerCase()))) {
    score.noFabrication = 2;
  }

  if (expected.selfBiasCheck) {
    const selfFinding = normalized.find((finding) => finding.locationBlob.includes(expected.selfBiasCheck.location.toLowerCase()));
    if (
      selfFinding &&
      selfFinding.witnessSet.has(expected.selfBiasCheck.witness) &&
      selfFinding.witnessSet.size === 1 &&
      selfFinding.agreementValue.includes('single')
    ) {
      score.selfBias = 2;
    }
  } else {
    score.selfBias = 2;
  }

  if (text.length <= 2500) score.concise = 1;

  const summary = String(parsed.summary || '');
  if (summary && summary.length <= 220 && !/^(sure|here|of course)\b/i.test(summary)) {
    score.claudeLike = 1;
  }

  if (expected.allowNoFindings) {
    if (findings.length === 0 && /no findings|no concrete|zero concrete defects|all clear|no defects|no correctness issues|no issues/i.test(summary)) {
      score.noFindings = 2;
    }
  } else {
    score.noFindings = 2;
  }

  score.total = score.schema + score.dedupe + score.minority + score.dissent +
    score.noFabrication + score.selfBias + score.concise + score.claudeLike + score.noFindings;
  return score;
}

async function callModel(model, fixturePrompt) {
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
          { role: 'user', content: buildUserPrompt(fixturePrompt) },
        ],
      }),
      signal: controller.signal,
    });

    const body = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        text: body.slice(0, 1000),
        latencyMs: Date.now() - startedAt,
      };
    }

    let parsedBody;
    try {
      parsedBody = JSON.parse(body);
    } catch (error) {
      return {
        ok: false,
        status: response.status,
        text: `non-json HTTP body: ${body.slice(0, 1000)}`,
        latencyMs: Date.now() - startedAt,
      };
    }

    return {
      ok: true,
      status: response.status,
      text: parsedBody?.choices?.[0]?.message?.content || '',
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'ERR',
      text: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

if (!process.env.NANOGPT_API_KEY) {
  console.error('NANOGPT_API_KEY is not set');
  process.exit(1);
}

if (!Number.isFinite(RUNS) || RUNS < 1) {
  console.error('Usage: node scripts/watchdog-benchmark.mjs [runs>=1] [timeoutMs]');
  process.exit(1);
}

const totals = new Map(MODELS.map((model) => [
  model,
  {
    calls: 0,
    ok: 0,
    score: 0,
    latencyMs: 0,
    jsonFailures: 0,
    outputs: [],
  },
]));

for (let run = 1; run <= RUNS; run += 1) {
  console.log(`\n## Run ${run}/${RUNS}`);
  for (const fixture of FIXTURES) {
    console.log(`\n### Fixture: ${fixture.id}`);
    for (const model of MODELS) {
      const stats = totals.get(model);
      stats.calls += 1;

      const result = await callModel(model, fixture.prompt);
      stats.latencyMs += result.latencyMs;

      if (!result.ok) {
        console.log(`${model}: HTTP/status ${result.status}, ${result.latencyMs}ms`);
        console.log(result.text.slice(0, 500));
        continue;
      }

      stats.ok += 1;
      const score = scoreWatchdogOutput(result.text, fixture.expected);
      stats.score += score.total;
      if (score.schema === 0) stats.jsonFailures += 1;
      stats.outputs.push({
        fixture: fixture.id,
        run,
        score,
        preview: result.text.slice(0, 1200),
      });

      console.log(`${model}: score ${score.total}/15, ${result.latencyMs}ms, chars=${score.chars}`);
      if (score.parseError) console.log(`  parseError: ${score.parseError}`);
      console.log(`  schema=${score.schema} dedupe=${score.dedupe} minority=${score.minority} dissent=${score.dissent} noFabrication=${score.noFabrication} selfBias=${score.selfBias} concise=${score.concise} claudeLike=${score.claudeLike} noFindings=${score.noFindings}`);
    }
  }
}

console.log('\n## Summary');
for (const model of MODELS) {
  const stats = totals.get(model);
  const avgScore = stats.score / stats.calls;
  const avgLatency = stats.latencyMs / stats.calls;
  const validRate = stats.ok / stats.calls;
  console.log(`${model}: avgScore=${avgScore.toFixed(2)}/15, successRate=${(validRate * 100).toFixed(1)}%, jsonFailures=${stats.jsonFailures}, avgLatencyMs=${avgLatency.toFixed(0)}`);
}
