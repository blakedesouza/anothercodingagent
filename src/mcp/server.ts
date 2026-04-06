/**
 * MCP server that wraps `aca invoke`.
 *
 * Exposes a single `aca_run` tool so that Claude Code (or any MCP client)
 * can delegate coding tasks to ACA agents via the universal capability contract.
 *
 * Transport: stdio (stdin/stdout JSON-RPC).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn, type ChildProcess } from 'node:child_process';
import type { InvokeResponse } from '../cli/executor.js';
import { CONTRACT_VERSION, SCHEMA_VERSION } from '../cli/executor.js';
import { DEFAULT_API_TIMEOUT_MS } from '../config/schema.js';

/**
 * Default outer wall-clock deadline for aca_run MCP invocations.
 *
 * Pinned to the same value as the inner LLM SSE idle timeout — there's no
 * point letting the outer envelope be smaller than the inner timer can
 * legitimately wait, and no point letting it be larger because nothing else
 * inside `aca invoke` would be still running by then. Override per-call via
 * the `timeout_ms` argument on the `aca_run` tool.
 */
const DEFAULT_DEADLINE_MS = DEFAULT_API_TIMEOUT_MS;

/** Default bounded delegation budget. Callers can narrow/expand per aca_run call. */
const DEFAULT_MAX_STEPS = 20;
const DEFAULT_MAX_TOTAL_TOKENS = 200_000;

/** Maximum subprocess output size: 10 MB. Prevents OOM from runaway output. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Maximum concurrent aca_run invocations. Prevents resource exhaustion from unbounded subprocess spawning. */
export const MAX_CONCURRENT_AGENTS = 5;

/** Result from spawning an aca invoke subprocess. */
export interface AcaInvokeResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * Spawn `aca invoke` as a subprocess, piping the InvokeRequest via stdin.
 *
 * Injectable for testing — callers can override `spawnFn` to mock the subprocess.
 */
export async function runAcaInvoke(
    task: string,
    options: {
        allowedTools?: string[];
        deadlineMs?: number;
        maxSteps?: number;
        maxTotalTokens?: number;
    },
    spawnFn = defaultSpawn,
): Promise<AcaInvokeResult> {
    const deadline = options.deadlineMs ?? DEFAULT_DEADLINE_MS;

    const constraints: Record<string, unknown> = {
        max_steps: options.maxSteps ?? DEFAULT_MAX_STEPS,
        max_total_tokens: options.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS,
    };
    if (options.allowedTools !== undefined) {
        constraints.allowed_tools = options.allowedTools;
    }

    const request = {
        contract_version: CONTRACT_VERSION,
        schema_version: SCHEMA_VERSION,
        task,
        constraints,
        deadline,
    };

    const requestJson = JSON.stringify(request);

    return spawnFn(requestJson, deadline);
}

/** Track active child processes for graceful shutdown. */
const activeChildren = new Set<ChildProcess>();

/** Write diagnostic info to stderr (only when ACA_DEBUG is set). Best-effort — swallows EPIPE. */
function debug(msg: string): void {
    if (process.env.ACA_DEBUG) {
        try { process.stderr.write(`[aca-mcp] ${msg}\n`); } catch { /* best-effort */ }
    }
}

/**
 * Build the spawn arguments for `aca invoke`.
 * Exported for testing — the invoke subcommand must NOT receive parent-level
 * flags like --no-confirm (Commander v13 rejects unknown subcommand options).
 * The invoke handler already sets autoConfirm: true internally.
 */
export function buildSpawnArgs(acaBin: string): string[] {
    return [acaBin, 'invoke'];
}

/** Default spawn implementation — calls the aca binary. */
function defaultSpawn(requestJson: string, deadlineMs: number): Promise<AcaInvokeResult> {
    return new Promise((resolve, reject) => {
        // Use process.argv[1] to resolve the aca entry point — more robust
        // than __dirname since it works regardless of dist layout.
        const acaBin = process.argv[1];
        const cwd = process.cwd();

        const args = buildSpawnArgs(acaBin);
        debug(`spawn: binary=${acaBin} cwd=${cwd} deadline=${deadlineMs}ms`);
        debug(`spawn: node=${process.execPath} args=[${args.join(', ')}]`);

        const child = spawn(process.execPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
            cwd,
        });

        activeChildren.add(child);

        let settled = false;
        const settle = <T>(fn: (value: T) => void, value: T) => {
            if (settled) return;
            settled = true;
            activeChildren.delete(child);
            fn(value);
        };

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;

        child.stdout.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > MAX_OUTPUT_BYTES) {
                child.kill('SIGTERM');
                return;
            }
            stdoutChunks.push(chunk);
        });

        child.stderr.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes > MAX_OUTPUT_BYTES) {
                child.kill('SIGTERM');
                return;
            }
            stderrChunks.push(chunk);
        });

        // Swallow EPIPE on stdin if child exits before reading
        child.stdin.on('error', () => {});

        // Deadline enforcement — kill subprocess if it runs too long.
        // Add 5s grace beyond the InvokeRequest deadline for process startup/shutdown.
        let sigkillTimeout: ReturnType<typeof setTimeout> | undefined;

        const killTimeout = setTimeout(() => {
            child.kill('SIGTERM');
            // Give 2s for graceful shutdown, then SIGKILL
            sigkillTimeout = setTimeout(() => {
                if (!child.killed) child.kill('SIGKILL');
            }, 2000);
        }, deadlineMs + 5000);

        child.on('close', (code) => {
            clearTimeout(killTimeout);
            if (sigkillTimeout !== undefined) clearTimeout(sigkillTimeout);
            const stderr = Buffer.concat(stderrChunks).toString('utf-8');
            debug(`subprocess exited: code=${code ?? 1} stderr=${stderr.slice(0, 500) || '(empty)'}`);
            settle(resolve, {
                stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
                stderr,
                exitCode: code ?? 1,
            });
        });

        child.on('error', (err) => {
            clearTimeout(killTimeout);
            if (sigkillTimeout !== undefined) clearTimeout(sigkillTimeout);
            settle(reject, err);
        });

        // Write InvokeRequest to stdin and close
        child.stdin.write(requestJson);
        child.stdin.end();
    });
}

/**
 * Parse the stdout of an aca invoke subprocess as an InvokeResponse.
 * Returns the parsed response, or an error response if parsing fails.
 */
export function parseInvokeOutput(stdout: string, stderr: string, exitCode: number): InvokeResponse {
    const trimmed = stdout.trim();
    if (!trimmed) {
        return {
            contract_version: CONTRACT_VERSION,
            schema_version: SCHEMA_VERSION,
            status: 'error',
            errors: [{
                code: 'mcp.empty_response',
                message: stderr.trim() || `aca invoke exited with code ${exitCode} and no output`,
                retryable: false,
            }],
        };
    }

    try {
        const parsed = JSON.parse(trimmed) as InvokeResponse;
        if (typeof parsed !== 'object' || parsed === null || !parsed.status) {
            return {
                contract_version: CONTRACT_VERSION,
                schema_version: SCHEMA_VERSION,
                status: 'error',
                errors: [{
                    code: 'mcp.malformed_response',
                    message: 'aca invoke returned invalid response structure',
                    retryable: false,
                }],
            };
        }
        return parsed;
    } catch {
        return {
            contract_version: CONTRACT_VERSION,
            schema_version: SCHEMA_VERSION,
            status: 'error',
            errors: [{
                code: 'mcp.parse_error',
                message: `Failed to parse aca invoke output as JSON: ${trimmed.slice(0, 200)}`,
                retryable: false,
            }],
        };
    }
}

/**
 * Create and configure the MCP server with the `aca_run` tool registered.
 *
 * @param spawnFn - Injectable spawn function for testing.
 */
export function createMcpServer(
    spawnFn?: (requestJson: string, deadlineMs: number) => Promise<AcaInvokeResult>,
): McpServer {
    const server = new McpServer({
        name: 'aca',
        version: '1.0.0',
    });

    // Per-server concurrency counter (works with both real and mock spawn functions)
    let activeInvocations = 0;

    server.registerTool(
        'aca_run',
        {
            description: 'Delegate a coding task to an ACA agent. The agent has access to file, shell, search, and browser tools. Model is determined by ACA configuration.',
            inputSchema: {
                task: z.string().describe('The coding task for ACA to execute'),
                allowed_tools: z.array(z.string()).optional()
                    .describe('Restrict which tools the ACA agent can use (e.g. ["read_file", "search_text"])'),
                max_steps: z.number().int().positive().optional()
                    .describe(`Maximum ACA agent loop steps (default: ${DEFAULT_MAX_STEPS})`),
                max_total_tokens: z.number().int().positive().optional()
                    .describe(`Maximum cumulative input+output tokens (default: ${DEFAULT_MAX_TOTAL_TOKENS})`),
                timeout_ms: z.number().optional()
                    .describe('Timeout in milliseconds (default: 900000 = 15 minutes)'),
            },
        },
        async ({ task, allowed_tools, max_steps, max_total_tokens, timeout_ms }) => {
            // Concurrency guard: reject if at capacity
            if (activeInvocations >= MAX_CONCURRENT_AGENTS) {
                return {
                    content: [{ type: 'text' as const, text: `mcp.concurrency_limit: ${activeInvocations} agents already running (max ${MAX_CONCURRENT_AGENTS}). Wait for one to complete before starting another.` }],
                    isError: true,
                };
            }

            activeInvocations++;
            const deadlineMs = timeout_ms ?? DEFAULT_DEADLINE_MS;

            try {
                const result = await runAcaInvoke(
                    task,
                    {
                        allowedTools: allowed_tools,
                        deadlineMs,
                        maxSteps: max_steps,
                        maxTotalTokens: max_total_tokens,
                    },
                    spawnFn,
                );

                const response = parseInvokeOutput(result.stdout, result.stderr, result.exitCode);

                if (response.status === 'error') {
                    const errorMsg = response.errors?.map(e =>
                        `${e.code}: ${e.message}${e.retryable ? ' (retryable)' : ''}`
                    ).join('; ') ?? 'Unknown error';
                    return {
                        content: [{ type: 'text' as const, text: errorMsg }],
                        isError: true,
                    };
                }

                // Build result text with usage info
                let text = response.result ?? '';
                if (response.usage) {
                    text += `\n\n[Usage: ${response.usage.input_tokens} input tokens, ${response.usage.output_tokens} output tokens]`;
                }

                return {
                    content: [{ type: 'text' as const, text }],
                };
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: 'text' as const, text: `Failed to invoke ACA: ${msg}` }],
                    isError: true,
                };
            } finally {
                activeInvocations--;
            }
        },
    );

    return server;
}

/**
 * Start the MCP server on stdio transport.
 * This is the entry point for `aca serve`.
 */
export async function startServer(
    spawnFn?: (requestJson: string, deadlineMs: number) => Promise<AcaInvokeResult>,
): Promise<void> {
    const server = createMcpServer(spawnFn);
    const transport = new StdioServerTransport();

    // Graceful shutdown: kill active child processes on signal
    const handleShutdown = () => {
        for (const child of activeChildren) {
            try { child.kill('SIGTERM'); } catch { /* best-effort */ }
        }
        server.close().catch(() => {}).finally(() => process.exit(0));
    };
    process.on('SIGTERM', handleShutdown);
    process.on('SIGINT', handleShutdown);

    await server.connect(transport);
}
