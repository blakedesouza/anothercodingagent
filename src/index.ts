#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDescribe } from './cli/executor.js';
import { TOOL_NAMES } from './cli/tool-names.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HELP_TEXT = `Usage: aca [options] [prompt]

Another Coding Agent — an AI-powered coding assistant

Options:
  --model <model>         Model to use
  --verbose               Enable debug output on stderr
  --no-confirm            Auto-approve confirmation prompts
  -r, --resume [session]  Resume session (latest for workspace, or specific ID)
  -V, --version           output the version number
  -h, --help              display help for command

Commands:
  serve                   Start ACA as an MCP server on stdio transport
  describe                Output capability descriptor as JSON
  witnesses               Output witness model configurations as JSON
  consult                 Run ACA-native bounded witness consultation
  rp-research             Research a series for RP and generate an RP knowledge pack
  invoke                  Execute structured task from stdin as JSON
  stats                   Show session analytics and usage statistics
  init                    Initialize ~/.aca/ directory structure with config and secrets
  configure               Interactive configuration wizard
  trust [path]            Mark a workspace as trusted
  untrust [path]          Remove workspace trust
`;

function getVersion(): string {
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
}

function isVersionRequest(args: readonly string[]): boolean {
    return args.length === 1 && (args[0] === '--version' || args[0] === '-V');
}

function isTopLevelHelpRequest(args: readonly string[]): boolean {
    return args.length === 1 && (args[0] === '--help' || args[0] === '-h' || args[0] === 'help');
}

function isFastDescribeRequest(args: readonly string[]): boolean {
    return args[0] === 'describe' && args.slice(1).every((arg) => arg === '--json');
}

function isSingleUnknownTopLevelFlag(args: readonly string[]): boolean {
    if (args.length !== 1) return false;
    const [arg] = args;
    if (!arg.startsWith('-')) return false;
    return !new Set([
        '--version',
        '-V',
        '--help',
        '-h',
        '--verbose',
        '--no-confirm',
        '--confirm',
        '-r',
        '--resume',
        '--model',
    ]).has(arg);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (isVersionRequest(args)) {
        process.stdout.write(getVersion() + '\n');
        return;
    }

    if (isTopLevelHelpRequest(args)) {
        process.stdout.write(HELP_TEXT);
        return;
    }

    if (isFastDescribeRequest(args)) {
        process.stdout.write(runDescribe([...TOOL_NAMES]) + '\n');
        return;
    }

    if (isSingleUnknownTopLevelFlag(args)) {
        process.stderr.write(`error: unknown option '${args[0]}'\n`);
        process.exitCode = 1;
        return;
    }

    const { runCli } = await import('./cli-main.js');
    await runCli(process.argv);
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Fatal error: ${message}\n`);
    process.exitCode = 1;
});
