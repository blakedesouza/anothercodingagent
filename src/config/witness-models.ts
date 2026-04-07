/**
 * Witness model configuration — single source of truth.
 *
 * Defines the witness models used by /consult and ACA-mode witness agents.
 * consult_ring.py reads these via `aca witnesses --json` to stay in sync.
 *
 * Max output values sourced from NanoGPT /api/v1/models?detailed=true (2026-04-05).
 */

import { DEFAULT_API_TIMEOUT_MS } from './schema.js';

/**
 * Per-witness wall-clock timeout in seconds. Pinned to the same 20-minute
 * budget as `DEFAULT_API_TIMEOUT_MS` so the outer witness wall-clock and the
 * inner SSE idle timer never disagree about how long a slow model is allowed
 * to take. Expressed in seconds because consult_ring.py reads it via the
 * `aca witnesses --json` command and Python tooling expects seconds.
 */
export const DEFAULT_WITNESS_TIMEOUT_S = DEFAULT_API_TIMEOUT_MS / 1000;

export interface WitnessModelConfig {
    /** Short canonical name used by consult_ring.py (e.g., "minimax") */
    name: string;
    /** Display name for reports (e.g., "MiniMax") */
    displayName: string;
    /** NanoGPT model ID */
    model: string;
    /** Fallback model if primary fails */
    fallbackModel?: string;
    /** Actual max output tokens from the API */
    maxOutputTokens: number;
    /** Context window size from the API */
    contextLength: number;
    /** Request timeout in seconds */
    timeout: number;
    /** Temperature for witness calls */
    temperature: number;
    /** Optional top_p (Kimi requires fixed top_p) */
    topP?: number;
}

/**
 * Canonical witness model configurations.
 *
 * These values are model ceilings reported by NanoGPT. Runtime guardrails still
 * decide how much of each ceiling a workflow should use.
 */
export const WITNESS_MODELS: readonly Readonly<WitnessModelConfig>[] = Object.freeze([
    Object.freeze({
        name: 'minimax',
        displayName: 'MiniMax',
        model: 'minimax/minimax-m2.7',
        fallbackModel: 'minimax/minimax-m2.5',
        maxOutputTokens: 131_072,
        contextLength: 204_800,
        timeout: DEFAULT_WITNESS_TIMEOUT_S,
        temperature: 0.6,
    }),
    Object.freeze({
        name: 'kimi',
        displayName: 'Kimi',
        model: 'moonshotai/kimi-k2.5',
        maxOutputTokens: 65_536,
        contextLength: 256_000,
        timeout: DEFAULT_WITNESS_TIMEOUT_S,
        temperature: 0.6,
        topP: 0.95,
    }),
    Object.freeze({
        name: 'qwen',
        displayName: 'Qwen',
        model: 'qwen/qwen3.5-397b-a17b',
        fallbackModel: 'qwen/qwen3.5-397b-a17b-thinking',
        maxOutputTokens: 65_536,
        contextLength: 258_048,
        timeout: DEFAULT_WITNESS_TIMEOUT_S,
        temperature: 0.7,
    }),
    Object.freeze({
        name: 'gemma',
        displayName: 'Gemma',
        model: 'google/gemma-4-31b-it',
        fallbackModel: 'meta-llama/llama-4-maverick',
        maxOutputTokens: 131_072,
        contextLength: 262_144,
        timeout: DEFAULT_WITNESS_TIMEOUT_S,
        temperature: 0.7,
    }),
]);

/** Look up a witness config by canonical name. */
export function getWitnessModel(name: string): WitnessModelConfig | undefined {
    return WITNESS_MODELS.find(w => w.name === name);
}

/** Get all witness model IDs (primary + fallback). */
export function getAllWitnessModelIds(): string[] {
    const ids: string[] = [];
    for (const w of WITNESS_MODELS) {
        ids.push(w.model);
        if (w.fallbackModel) ids.push(w.fallbackModel);
    }
    return ids;
}

/**
 * Serialize witness configs for `aca witnesses --json` output.
 * Format matches what consult_ring.py expects.
 */
export function serializeWitnessConfigs(): string {
    const output: Record<string, Record<string, unknown>> = {};
    for (const w of WITNESS_MODELS) {
        const entry: Record<string, unknown> = {
            type: 'nanogpt',
            model: w.model,
            timeout: w.timeout,
            temperature: w.temperature,
            max_tokens: w.maxOutputTokens,
        };
        if (w.fallbackModel) entry.fallback_model = w.fallbackModel;
        if (w.topP !== undefined) entry.top_p = w.topP;
        output[w.name] = entry;
    }
    return JSON.stringify(output, null, 2);
}
