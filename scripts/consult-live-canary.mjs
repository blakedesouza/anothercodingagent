#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_INDEX = join(ROOT, 'dist', 'index.js');

function parseArgs(argv) {
  const options = {
    witnesses: 'minimax,gemma',
    triage: 'auto',
    outDir: `/tmp/aca-consult-canary-${Date.now()}`,
    projectDir: ROOT,
    repeats: 1,
    build: true,
    concurrency: 1,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--witnesses') options.witnesses = argv[++index] || options.witnesses;
    else if (arg === '--triage') options.triage = argv[++index] || options.triage;
    else if (arg === '--out-dir') options.outDir = argv[++index] || options.outDir;
    else if (arg === '--project-dir') options.projectDir = resolve(argv[++index] || options.projectDir);
    else if (arg === '--repeats') options.repeats = Math.max(1, Number.parseInt(argv[++index] || '1', 10) || 1);
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--concurrency') options.concurrency = Math.max(1, Math.min(1, Number.parseInt(argv[++index] || '1', 10) || 1));
    else if (arg === '--help') {
      process.stdout.write(`Usage: node scripts/consult-live-canary.mjs [options]

Options:
  --witnesses <list>    Witness pair to test (default: minimax,gemma)
  --triage <mode>       Triage mode: auto|always|never (default: auto)
  --out-dir <path>      Output directory (default: /tmp/aca-consult-canary-<ts>)
  --project-dir <path>  Project directory for consult runs
  --repeats <n>         Repetitions per scenario (default: 1)
  --no-build            Skip npm run build before the matrix
  --concurrency <n>     Reserved for future use; currently clamped to 1
`);
      process.exit(0);
    }
  }

  return options;
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    timeout: 20 * 60 * 1000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function buildScenarios() {
  return [
    {
      id: 'exact',
      question: 'Answer with exactly: 4',
    },
    {
      id: 'advisory',
      question: 'How should a manager build a workload driver template for capacity planning?',
    },
    {
      id: 'repo_fact',
      question: 'What is the package name declared in this repository? Do not guess.',
    },
    {
      id: 'symbol_review',
      question: 'Review the function selectWitnesses in src/cli/consult.ts for grounded correctness risks only.',
    },
    {
      id: 'packed_review',
      question: 'Review the packed files for grounded correctness risks only. Do not guess.',
      packPaths: ['src/cli/consult.ts', 'src/consult/context-request.ts'],
    },
  ];
}

function buildConsultArgs(options, scenario, outPath) {
  const args = [
    DIST_INDEX,
    'consult',
    '--project-dir', options.projectDir,
    '--witnesses', options.witnesses,
    '--triage', options.triage,
    '--question', scenario.question,
    '--out', outPath,
  ];
  for (const packPath of scenario.packPaths || []) {
    args.push('--pack-path', packPath);
  }
  return args;
}

function summarizeResult(id, rep, outPath, execution) {
  const base = {
    id,
    repetition: rep,
    exitCode: execution.status,
    resultPath: outPath,
    commandOk: execution.status === 0,
  };
  try {
    const result = JSON.parse(readFileSync(outPath, 'utf8'));
    const witnessStatuses = Object.fromEntries(
      Object.entries(result.witnesses || {}).map(([name, witness]) => [name, {
        status: witness.status,
        model: witness.model,
        error: witness.error,
      }]),
    );
    return {
      ...base,
      degraded: Boolean(result.degraded),
      successCount: result.success_count,
      totalWitnesses: result.total_witnesses,
      triage: result.triage?.status ?? null,
      clean: execution.status === 0 && !result.degraded,
      witnessStatuses,
    };
  } catch (error) {
    return {
      ...base,
      degraded: true,
      clean: false,
      parseError: error instanceof Error ? error.message : String(error),
      stderr: execution.stderr.trim(),
    };
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.outDir, { recursive: true });

  if (options.build) {
    process.stderr.write('Building dist before live canary...\n');
    const build = runCommand('npm', ['run', 'build'], ROOT);
    if (build.status !== 0) {
      process.stderr.write(build.stdout);
      process.stderr.write(build.stderr);
      process.exit(build.status);
    }
  }

  const scenarios = buildScenarios();
  const runs = [];
  for (const scenario of scenarios) {
    for (let rep = 1; rep <= options.repeats; rep += 1) {
      const outPath = join(options.outDir, `${scenario.id}-r${rep}.json`);
      process.stderr.write(`Running ${scenario.id} r${rep} with ${options.witnesses}...\n`);
      const execution = runCommand('node', buildConsultArgs(options, scenario, outPath), ROOT);
      runs.push(summarizeResult(scenario.id, rep, outPath, execution));
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    witnesses: options.witnesses,
    triage: options.triage,
    repeats: options.repeats,
    outDir: resolve(options.outDir),
    cleanRuns: runs.filter((run) => run.clean).length,
    degradedRuns: runs.filter((run) => run.degraded).length,
    totalRuns: runs.length,
    runs,
  };

  const summaryPath = join(options.outDir, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  process.stdout.write(`${summaryPath}\n`);
}

main();
