/**
 * Witness model configuration — single source of truth.
 *
 * Defines the named witness models and presets used by ACA consult.
 *
 * Max output values are sourced from NanoGPT model catalog observations and
 * live workflow probes recorded in project docs. Runtime guardrails still
 * decide how much of each ceiling a workflow should use.
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
    /** Short stable name used in result keys and artifact file names. */
    name: string;
    /** Display name for reports (e.g., "MiniMax") */
    displayName: string;
    /** NanoGPT model ID */
    model: string;
    /** Additional user-facing names accepted by `--witnesses`. */
    aliases?: readonly string[];
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
 * Canonical named witness model configurations.
 */
export const WITNESS_MODELS: readonly Readonly<WitnessModelConfig>[] = Object.freeze([
    Object.freeze({
        name: 'kimi26',
        displayName: 'Kimi K2.6',
        model: 'moonshotai/kimi-k2.6',
        aliases: ['kimi2.6', 'kimi-k2.6'],
        maxOutputTokens: 65_536,
        contextLength: 256_000,
        timeout: DEFAULT_WITNESS_TIMEOUT_S,
        temperature: 0.6,
        topP: 0.95,
    }),
    Object.freeze({
        name: 'glm51',
        displayName: 'GLM 5.1',
        model: 'zai-org/glm-5.1',
        aliases: ['glm', 'glm5.1', 'glm-5.1'],
        maxOutputTokens: 128_000,
        contextLength: 200_000,
        timeout: DEFAULT_WITNESS_TIMEOUT_S,
        temperature: 0.6,
    }),
    Object.freeze({
        name: 'deepseek',
        displayName: 'DeepSeek V4 Pro',
        model: 'deepseek/deepseek-v4-pro',
        aliases: ['deepseek-v4', 'deepseek-v4-pro'],
        maxOutputTokens: 65_536,
        contextLength: 163_000,
        timeout: DEFAULT_WITNESS_TIMEOUT_S,
        temperature: 0.6,
    }),
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

export const DEFAULT_CONSULT_WITNESS_NAMES = ['kimi26', 'glm51'] as const;
export const DISSENT_CONSULT_WITNESS_NAMES = ['deepseek'] as const;

export const CONSULT_WITNESS_PRESETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    default: DEFAULT_CONSULT_WITNESS_NAMES,
    strong: DEFAULT_CONSULT_WITNESS_NAMES,
    dissent: DISSENT_CONSULT_WITNESS_NAMES,
    full: [...DEFAULT_CONSULT_WITNESS_NAMES, ...DISSENT_CONSULT_WITNESS_NAMES],
    legacy: ['minimax', 'gemma'],
    current: DEFAULT_CONSULT_WITNESS_NAMES,
    all: WITNESS_MODELS.map(w => w.name),
});

function parseList(raw: string | undefined): string[] {
    return (raw ?? '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function dedupeWitnesses(witnesses: WitnessModelConfig[]): WitnessModelConfig[] {
    const seenModels = new Set<string>();
    const seenNames = new Set<string>();
    const deduped: WitnessModelConfig[] = [];
    for (const witness of witnesses) {
        const modelKey = witness.model.toLowerCase();
        if (seenModels.has(modelKey)) continue;
        seenModels.add(modelKey);

        let name = witness.name;
        let suffix = 2;
        while (seenNames.has(name)) {
            name = `${witness.name}-${suffix}`;
            suffix += 1;
        }
        seenNames.add(name);
        deduped.push(name === witness.name ? witness : Object.freeze({ ...witness, name }));
    }
    return deduped;
}

export function witnessNameFromModelId(model: string): string {
    const normalized = model
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (normalized.length === 0) return 'custom-model';
    return /^[a-z]/.test(normalized) ? normalized : `model-${normalized}`;
}

/** Look up a witness config by canonical name. */
export function getWitnessModel(name: string): WitnessModelConfig | undefined {
    const normalized = name.trim().toLowerCase();
    return WITNESS_MODELS.find(w =>
        w.name === normalized
        || w.aliases?.includes(normalized)
        || w.model.toLowerCase() === normalized,
    );
}

export function createCustomWitnessModel(model: string): WitnessModelConfig {
    const trimmed = model.trim();
    return Object.freeze({
        name: witnessNameFromModelId(trimmed),
        displayName: trimmed,
        model: trimmed,
        maxOutputTokens: 65_536,
        contextLength: 200_000,
        timeout: DEFAULT_WITNESS_TIMEOUT_S,
        temperature: 0.6,
    });
}

export function resolveWitnesses(raw: string | undefined): WitnessModelConfig[] {
    const tokens = parseList(raw);
    const requested = tokens.length === 0 ? ['default'] : tokens;
    const selected: WitnessModelConfig[] = [];

    for (const token of requested) {
        const normalized = token.toLowerCase();
        const preset = CONSULT_WITNESS_PRESETS[normalized];
        if (preset) {
            selected.push(...resolveWitnesses(preset.join(',')));
            continue;
        }

        const named = getWitnessModel(token);
        if (named) {
            selected.push(named);
            continue;
        }

        if (token.includes('/')) {
            selected.push(createCustomWitnessModel(token));
            continue;
        }

        throw new Error(`unknown witness: ${token}`);
    }

    return dedupeWitnesses(selected);
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
    const output: Record<string, unknown> = {};
    output.default = [...DEFAULT_CONSULT_WITNESS_NAMES];
    output.presets = CONSULT_WITNESS_PRESETS;
    output.witnesses = {};
    for (const w of WITNESS_MODELS) {
        const entry: Record<string, unknown> = {
            type: 'nanogpt',
            model: w.model,
            display_name: w.displayName,
            timeout: w.timeout,
            temperature: w.temperature,
            max_tokens: w.maxOutputTokens,
        };
        if (w.aliases?.length) entry.aliases = [...w.aliases];
        if (w.fallbackModel) entry.fallback_model = w.fallbackModel;
        if (w.topP !== undefined) entry.top_p = w.topP;
        (output.witnesses as Record<string, unknown>)[w.name] = entry;
        output[w.name] = entry;
    }
    return JSON.stringify(output, null, 2);
}

export function serializeWitnessSeed(raw?: string): string {
    return resolveWitnesses(raw)
        .map(witness => `${witness.name}=${witness.model}`)
        .join(',');
}
