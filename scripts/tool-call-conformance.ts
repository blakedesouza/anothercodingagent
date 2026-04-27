#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSecrets } from '../src/config/secrets.ts';
import { readWorkflowFailures } from '../src/tools/tool-call-conformance-report.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = `/tmp/aca-tool-call-conformance-${Date.now()}.json`;
const DEFAULT_MODELS = ['zai-org/glm-5.1', 'moonshotai/kimi-k2.6', 'deepseek/deepseek-v4-pro'];

interface Args {
    live: boolean;
    local: boolean;
    out: string;
    models: string[];
}

interface CommandResult {
    command: string[];
    exitCode: number;
    stdout: string;
    stderr: string;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        live: false,
        local: true,
        out: DEFAULT_OUT,
        models: [...DEFAULT_MODELS],
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--live') {
            args.live = true;
        } else if (arg === '--no-local') {
            args.local = false;
        } else if (arg === '--out') {
            args.out = resolve(argv[index + 1] ?? args.out);
            index += 1;
        } else if (arg === '--models') {
            args.models = String(argv[index + 1] ?? '')
                .split(',')
                .map(model => model.trim())
                .filter(Boolean);
            index += 1;
        } else if (arg === '--help') {
            process.stdout.write(`Usage: npm run probe:tool-calls -- [options]

Options:
  --live             Run optional live NanoGPT probe after local checks.
  --no-local         Skip local Vitest conformance checks.
  --models <list>    Comma-separated live model IDs.
  --out <path>       JSON report path. Default: ${DEFAULT_OUT}
`);
            process.exit(0);
        }
    }
    return args;
}

function runCommand(command: string[], env: NodeJS.ProcessEnv = process.env): Promise<CommandResult> {
    return new Promise(resolveCommand => {
        const child = spawn(command[0], command.slice(1), {
            cwd: ROOT,
            env,
            shell: process.platform === 'win32',
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', code => {
            resolveCommand({
                command,
                exitCode: code ?? 1,
                stdout,
                stderr,
            });
        });
    });
}

async function writeReport(path: string, report: Record<string, unknown>): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const report: Record<string, unknown> = {
        generatedAt: new Date().toISOString(),
        root: ROOT,
        local: null,
        live: null,
    };

    if (args.local) {
        const local = await runCommand(['npm', 'run', 'test:tool-calls']);
        report.local = local;
        process.stdout.write(local.stdout);
        process.stderr.write(local.stderr);
        if (local.exitCode !== 0) {
            await writeReport(args.out, report);
            process.stderr.write(`Local conformance failed. Report: ${args.out}\n`);
            process.exit(local.exitCode);
        }
    }

    if (args.live) {
        const { secrets, warnings } = await loadSecrets();
        for (const warning of warnings) {
            process.stderr.write(`[tool-call-conformance] ${warning}\n`);
        }

        if (!secrets.nanogpt) {
            report.live = {
                skipped: true,
                reason: 'missing NANOGPT_API_KEY',
            };
        } else {
            const nativeOut = args.out.replace(/\.json$/i, '.native-probe.json');
            const workflowOut = args.out.replace(/\.json$/i, '.workflow');
            const env = { ...process.env, NANOGPT_API_KEY: secrets.nanogpt };
            const nativeProbe = await runCommand([
                'node',
                '--import',
                'tsx',
                'scripts/native-tool-probe.ts',
                '--models',
                args.models.join(','),
                '--out',
                nativeOut,
            ], env);
            const workflowProbe = await runCommand([
                'node',
                '--import',
                'tsx',
                'scripts/live-workflow-bakeoff.ts',
                '--models',
                args.models.join(','),
                '--suite',
                'basic',
                '--out-dir',
                workflowOut,
                '--concurrency',
                '1',
            ], env);
            const workflowFailures = workflowProbe.exitCode === 0
                ? await readWorkflowFailures(workflowOut)
                : [];
            report.live = {
                skipped: false,
                models: args.models,
                nativeProbe,
                workflowProbe,
                workflowFailures,
                artifacts: {
                    nativeProbe: nativeOut,
                    workflow: workflowOut,
                },
            };
            process.stdout.write(nativeProbe.stdout);
            process.stderr.write(nativeProbe.stderr);
            process.stdout.write(workflowProbe.stdout);
            process.stderr.write(workflowProbe.stderr);
            if (nativeProbe.exitCode !== 0 || workflowProbe.exitCode !== 0 || workflowFailures.length > 0) {
                await writeReport(args.out, report);
                const workflowFailureSummary = workflowFailures.length > 0
                    ? ` ${workflowFailures.length} workflow case(s) failed.`
                    : '';
                if (workflowFailures.length > 0) {
                    process.stderr.write(`${JSON.stringify(workflowFailures, null, 2)}\n`);
                }
                process.stderr.write(`Live conformance failed.${workflowFailureSummary} Report: ${args.out}\n`);
                process.exit(nativeProbe.exitCode || workflowProbe.exitCode || 1);
            }
        }
    }

    await writeReport(args.out, report);
    process.stdout.write(`Tool-call conformance report written to ${args.out}\n`);
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
});
