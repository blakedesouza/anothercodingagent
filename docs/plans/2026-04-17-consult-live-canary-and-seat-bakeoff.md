# Consult Live Canary And Seat Bakeoff

Date: 2026-04-17
Scope: repeatable live certification for the current consult defaults, plus a bounded witness-protocol bakeoff for possible second-seat replacements.

## Goal

Close three remaining holes:

- remove active DeepSeek-era drift from current utility surfaces
- add one repeatable live consult canary runner
- test whether there is a cleaner or stronger second-seat candidate than Gemma without falling back to Qwen-style advisory instability

## New Durable Runners

### 1. Default consult canary

File:

- `scripts/consult-live-canary.mjs`

Purpose:

- runs the current `aca consult` product path end-to-end
- uses the real witness pair, real triage setting, real evidence-pack path, and real result JSON
- runs one consult at a time so the internal witness parallelism stays within the NanoGPT live-call ceiling

Usage:

```bash
node scripts/consult-live-canary.mjs --witnesses minimax,gemma --triage auto
```

### 2. Candidate witness bakeoff

File:

- `scripts/consult-seat-bakeoff.ts`

Purpose:

- drives arbitrary model IDs through the exported witness prompt builders and context-request protocol
- uses real `aca invoke` subprocesses, not raw ad hoc chat prompts
- scores raw witness compliance on advisory, grounded repo-fact, and packed-review tasks

Usage:

```bash
node --import tsx scripts/consult-seat-bakeoff.ts \
  --models google/gemma-4-31b-it,zai-org/glm-5,mistralai/mistral-large-3-675b-instruct-2512,mistralai/devstral-2-123b-instruct-2512
```

Important limitation:

- this bakeoff measures raw witness-protocol compliance
- it does not include ACA triage rescue or the full pairwise consult orchestration
- so it is stricter than the default live canary and should be read as a promotion filter, not as a full replacement for a product-path canary

## Default Canary Result

Command:

```bash
node scripts/consult-live-canary.mjs \
  --no-build \
  --witnesses minimax,gemma \
  --triage auto \
  --out-dir /tmp/aca-consult-canary-current
```

Summary artifact:

- `/tmp/aca-consult-canary-current/summary.json`

Result:

- `5/5` clean
- `0` degraded
- `0` triage escalations

Tasks:

- exact advisory
- substantive advisory
- repo fact
- symbol-grounded review
- packed review

Conclusion:

- the current default pair `minimax + gemma` is clean on the real consult product path
- the repeatable certification gap is now closed for the current default setup

## Candidate Bakeoff Result

Command:

```bash
node --import tsx scripts/consult-seat-bakeoff.ts \
  --out-dir /tmp/aca-consult-seat-bakeoff-current \
  --concurrency 2
```

Summary artifact:

- `/tmp/aca-consult-seat-bakeoff-current/summary.json`

Candidate ranking from this bakeoff:

1. `mistralai/mistral-large-3-675b-instruct-2512` — `4/4` clean
2. `google/gemma-4-31b-it` — `3/4` clean
3. `zai-org/glm-5` — `3/4` clean
4. `mistralai/devstral-2-123b-instruct-2512` — `2/4` clean

Important read on the top candidate:

- `mistral-large-3` was the only candidate that stayed clean across exact advisory, substantive advisory, repo fact, and packed review in the raw witness-protocol bakeoff
- this makes it the strongest unpromoted candidate to test as a real second seat next

Important read on Gemma:

- Gemma still won the full product-path canary as the clean current default
- in the stricter raw witness bakeoff, Gemma and GLM-5 both stumbled on repo-fact grounding without ACA rescue
- that does not negate the clean `minimax + gemma` product result, but it does show Gemma is not a perfect raw-protocol witness

Important read on Devstral:

- Devstral underperformed here and is not the next seat I would spend time on

## Recommendation

Current default:

- keep `minimax + gemma`

Next candidate worth promotion work:

- `mistralai/mistral-large-3-675b-instruct-2512`

Recommended next validation before any promotion:

1. add a temporary witness seat for `mistral-large-3`
2. run the same full consult canary matrix on `minimax + mistral-large-3`
3. compare not just cleanliness, but whether the second witness is more useful than Gemma without introducing Qwen-style advisory leakage

## Residual Hole After This Slice

The main remaining hole is no longer harness drift. It is witness-quality calibration:

- MiniMax is still the primary sharp reviewer
- Gemma is still the cleanest steady partner on the full product path
- `mistral-large-3` is now the best next candidate if a stronger second seat is still wanted
