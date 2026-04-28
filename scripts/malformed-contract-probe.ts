#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSecrets } from '../src/config/secrets.ts';
import { readWorkflowFailures } from '../src/tools/tool-call-conformance-report.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = `/tmp/aca-malformed-contract-${Date.now()}`;
const DEFAULT_MODELS = 'zai-org/glm-5.1,moonshotai/kimi-k2.6,deepseek/deepseek-v4-pro';

interface Args {
    live: boolean;
    models: string;
    suite: string;
    outDir: string;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        live: false,
        models: DEFAULT_MODELS,
        suite: 'basic',
        outDir: DEFAULT_OUT,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--live') {
            args.live = true;
        } else if (arg === '--models') {
            args.models = argv[index + 1] ?? args.models;
            index += 1;
        } else if (arg === '--suite') {
            args.suite = argv[index + 1] ?? args.suite;
            index += 1;
        } else if (arg === '--out-dir') {
            args.outDir = resolve(argv[index + 1] ?? args.outDir);
            index += 1;
        } else if (arg === '--help') {
            process.stdout.write(`Usage: npm run probe:malformed -- [options]

Options:
  --live             Run live NanoGPT workflow probes
  --models <list>    Comma-separated model IDs
  --suite <name>     live-workflow-bakeoff suite name (default: basic)
  --out-dir <path>   Output directory (default: /tmp/aca-malformed-contract-<time>)
`);
            process.exit(0);
        }
    }
    return args;
}

function run(command: string, args: string[], cwd = ROOT): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise(resolvePromise => {
        const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', code => resolvePromise({ code: code ?? 1, stdout, stderr }));
        child.on('error', error => resolvePromise({ code: 1, stdout, stderr: stderr + error.message }));
    });
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    await fs.mkdir(args.outDir, { recursive: true });

    const local = await run('npm', ['run', 'test:tool-calls']);
    const report: Record<string, unknown> = {
        generatedAt: new Date().toISOString(),
        root: ROOT,
        local,
        live: { skipped: true },
    };

    if (args.live) {
        const { secrets, warnings } = await loadSecrets();
        for (const warning of warnings) {
            process.stderr.write(`[malformed-contract-probe] ${warning}\n`);
        }
        const apiKey = secrets.nanogpt?.trim();
        if (!apiKey) {
            report.live = { skipped: true, reason: 'Missing NanoGPT API key' };
        } else {
            const workflowDir = join(args.outDir, 'workflow');
            const workflow = await run('node', [
                '--import',
                'tsx',
                'scripts/live-workflow-bakeoff.ts',
                '--models',
                args.models,
                '--suite',
                args.suite,
                '--out-dir',
                workflowDir,
                '--concurrency',
                '1',
            ]);
            const failures = await readWorkflowFailures(workflowDir).catch(error => [{
                model: '(unknown)',
                taskId: '(readWorkflowFailures)',
                success: false,
                testsPassed: false,
                errorCodes: ['probe.malformed_report_read_failed'],
                classification: 'unknown_needs_artifact',
                diagnosticBucket: 'unknown_needs_artifact',
                salvageCandidate: false,
                salvaged: false,
                changedFiles: [],
                acceptedToolCalls: null,
                resultPreview: String(error),
            }]);
            report.live = {
                skipped: false,
                models: args.models.split(',').map(item => item.trim()).filter(Boolean),
                suite: args.suite,
                workflow,
                workflowDir,
                failures,
            };
        }
    }

    const reportPath = join(args.outDir, 'malformed-contract-report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    process.stdout.write(`Output written to ${reportPath}\n`);
    if (local.code !== 0) process.exit(local.code);
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
});
