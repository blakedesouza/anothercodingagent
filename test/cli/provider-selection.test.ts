import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    RP_REPAIR_MAX_TOOL_CALLS,
    buildRpRepairTurnConfig,
    resolveInvokeEffectiveModel,
    shouldRetryRpAbort,
} from '../../src/cli-main.js';
import type { ProviderDriver } from '../../src/types/provider.js';

const ROOT = join(import.meta.dirname, '..', '..');
const DIST_INDEX = join(ROOT, 'dist', 'index.js');
const TEST_HOME = mkdtempSync(join(tmpdir(), 'aca-provider-home-'));

beforeAll(() => {
    if (!existsSync(DIST_INDEX)) {
        execFileSync('npm', ['run', 'build'], {
            cwd: ROOT,
            encoding: 'utf-8',
            timeout: 60_000,
        });
    }
});

afterAll(() => {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function writeUserConfig(config: unknown): void {
    const acaDir = join(TEST_HOME, '.aca');
    mkdirSync(acaDir, { recursive: true });
    writeFileSync(join(acaDir, 'config.json'), JSON.stringify(config, null, 2));
}

function runAca(
    args: string[],
    options?: { env?: Record<string, string>; input?: string; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
    const env = {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        HOME: TEST_HOME,
        NANOGPT_API_KEY: '',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        ...(options?.env ?? {}),
    };
    try {
        const stdout = execFileSync('node', [DIST_INDEX, ...args], {
            cwd: ROOT,
            encoding: 'utf-8',
            timeout: options?.timeout ?? 30_000,
            env,
            input: options?.input,
        });
        return { stdout, stderr: '', exitCode: 0 };
    } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return {
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? '',
            exitCode: e.status ?? 1,
        };
    }
}

const stubProvider = {
    capabilities(model: string) {
        if (model === 'gpt-4o') {
            return {
                maxContext: 128_000,
                maxOutput: 16_384,
                supportsTools: 'native',
                supportsVision: false,
                supportsStreaming: true,
                supportsPrefill: false,
                supportsEmbedding: false,
                embeddingModels: [],
                toolReliability: 'native',
                costPerMillion: { input: 2.5, output: 10 },
                specialFeatures: [],
                bytesPerToken: 3,
            };
        }
        throw new Error(`Unknown model: ${model}`);
    },
    async *stream() {
        throw new Error('not implemented');
    },
    validate() {
        return { ok: true as const, value: undefined };
    },
} satisfies ProviderDriver;

describe('Milestone 11 provider selection', () => {
    it('rp-researcher falls back from an unavailable configured default to an available specialist model', () => {
        const selected = resolveInvokeEffectiveModel(
            '',
            'zai-org/glm-5.1',
            'rp-researcher',
            {
                kind: 'nanogpt',
                provider: stubProvider,
                catalog: {
                    fetch: async () => {},
                    getModel(id: string) {
                        return id === 'zai-org/glm-5'
                            ? {
                                id,
                                contextLength: 200_000,
                                maxOutputTokens: 128_000,
                                capabilities: {
                                    vision: false,
                                    toolCalling: true,
                                    reasoning: true,
                                    structuredOutput: true,
                                },
                                pricing: { input: 0.3, output: 2.55 },
                            }
                            : null;
                    },
                    get isLoaded() {
                        return true;
                    },
                },
            },
        );

        expect(selected).toBe('zai-org/glm-5');
    });

    it('rp-researcher keeps an available configured default instead of overriding it', () => {
        const selected = resolveInvokeEffectiveModel(
            '',
            'moonshotai/kimi-k2.5',
            'rp-researcher',
            {
                kind: 'nanogpt',
                provider: stubProvider,
                catalog: {
                    fetch: async () => {},
                    getModel(id: string) {
                        return id === 'moonshotai/kimi-k2.5'
                            ? {
                                id,
                                contextLength: 262_144,
                                maxOutputTokens: 16_384,
                                capabilities: {
                                    vision: false,
                                    toolCalling: true,
                                    reasoning: true,
                                    structuredOutput: false,
                                },
                                pricing: { input: 0.6, output: 2.5 },
                            }
                            : null;
                    },
                    get isLoaded() {
                        return true;
                    },
                },
            },
        );

        expect(selected).toBe('moonshotai/kimi-k2.5');
    });

    it('keeps an explicit caller-selected model even for rp-researcher', () => {
        const selected = resolveInvokeEffectiveModel(
            'zai-org/glm-5.1',
            'qwen/qwen3-coder-next',
            'rp-researcher',
            {
                kind: 'nanogpt',
                provider: stubProvider,
                catalog: {
                    fetch: async () => {},
                    getModel() {
                        return null;
                    },
                    get isLoaded() {
                        return true;
                    },
                },
            },
        );

        expect(selected).toBe('zai-org/glm-5.1');
    });

    it('rp-researcher retries aborted malformed responses', () => {
        expect(shouldRetryRpAbort('rp-researcher', {
            turn: { outcome: 'aborted' },
            lastError: { code: 'llm.malformed' },
        })).toBe(true);
    });

    it('does not retry non-rp aborted malformed responses', () => {
        expect(shouldRetryRpAbort('coder', {
            turn: { outcome: 'aborted' },
            lastError: { code: 'llm.malformed' },
        })).toBe(false);
    });

    it('caps rp repair turns at a wider bounded budget than the old fallback', () => {
        expect(buildRpRepairTurnConfig({
            max_steps: 10,
            max_tool_calls: 100,
        })).toEqual({
            maxSteps: 10,
            maxToolCalls: RP_REPAIR_MAX_TOOL_CALLS,
        });
    });

    it('preserves lower caller caps on rp repair turns', () => {
        expect(buildRpRepairTurnConfig({
            max_steps: 4,
            max_tool_calls: 7,
        })).toEqual({
            maxSteps: 4,
            maxToolCalls: 7,
        });
    });

    it('one-shot startup respects defaultProvider=openai when API key is missing', () => {
        writeUserConfig({
            schemaVersion: 1,
            defaultProvider: 'openai',
            providers: [
                {
                    name: 'openai',
                    driver: 'openai',
                    baseUrl: 'https://api.openai.com/v1',
                    timeout: 1_200_000,
                    priority: 1,
                },
            ],
            model: {
                default: 'gpt-4o',
                compressionModel: null,
                temperature: 0.1,
                maxOutputTokens: 16_384,
            },
        });

        const result = runAca(['hello']);
        expect(result.exitCode).toBe(4);
        expect(result.stderr).toContain('No OpenAI API key found.');
        expect(result.stderr).not.toContain('No NanoGPT API key found.');
    });

    it('invoke startup respects defaultProvider=openai when API key is missing', () => {
        writeUserConfig({
            schemaVersion: 1,
            defaultProvider: 'openai',
            providers: [
                {
                    name: 'openai',
                    driver: 'openai',
                    baseUrl: 'https://api.openai.com/v1',
                    timeout: 1_200_000,
                    priority: 1,
                },
            ],
            model: {
                default: 'gpt-4o',
                compressionModel: null,
                temperature: 0.1,
                maxOutputTokens: 16_384,
            },
        });

        const result = runAca(['invoke'], {
            input: JSON.stringify({
                contract_version: '1.0.0',
                schema_version: '1.0.0',
                task: 'hello',
            }),
        });
        expect(result.exitCode).toBe(1);

        const response = JSON.parse(result.stdout.trim()) as {
            status: string;
            errors?: Array<{ code: string; message: string }>;
        };
        expect(response.status).toBe('error');
        expect(response.errors?.[0]?.code).toBe('system.config_error');
        expect(response.errors?.[0]?.message).toContain('No OpenAI API key found.');
    });
});
