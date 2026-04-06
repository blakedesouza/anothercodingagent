import type { ModelCapabilities, ToolSupport, ToolReliability } from '../types/provider.js';
import modelsDataRaw from './models.json' with { type: 'json' };

/**
 * Raw model entry as stored in models.json.
 * Extends ModelCapabilities with id and aliases fields.
 * String union types (supportsTools, toolReliability) are stored as strings in JSON.
 */
interface RawModelEntry {
    id: string;
    aliases: string[];
    maxContext: number;
    maxOutput: number;
    supportsTools: string;
    supportsVision: boolean;
    supportsStreaming: boolean;
    supportsPrefill: boolean;
    supportsEmbedding: boolean;
    embeddingModels: string[];
    toolReliability: string;
    costPerMillion: { input: number; output: number; cachedInput?: number };
    specialFeatures: string[];
    bytesPerToken: number;
}

interface ModelsJson {
    models: RawModelEntry[];
}

if (!modelsDataRaw || !Array.isArray((modelsDataRaw as Record<string, unknown>).models)) {
    throw new Error('FATAL: models.json is malformed or missing "models" array');
}
const modelsData = modelsDataRaw as unknown as ModelsJson;

// Build lookup maps at module load time
const byId = new Map<string, ModelCapabilities>();
const aliasToId = new Map<string, string>();

for (const entry of modelsData.models) {
    const caps: ModelCapabilities = {
        maxContext: entry.maxContext,
        maxOutput: entry.maxOutput,
        supportsTools: entry.supportsTools as ToolSupport,
        supportsVision: entry.supportsVision,
        supportsStreaming: entry.supportsStreaming,
        supportsPrefill: entry.supportsPrefill,
        supportsEmbedding: entry.supportsEmbedding,
        embeddingModels: entry.embeddingModels,
        toolReliability: entry.toolReliability as ToolReliability,
        costPerMillion: entry.costPerMillion,
        specialFeatures: entry.specialFeatures,
        bytesPerToken: entry.bytesPerToken,
    };
    byId.set(entry.id, caps);
    for (const alias of entry.aliases) {
        aliasToId.set(alias, entry.id);
    }
}

/**
 * Resolve a model name (alias or full ID) to a canonical model ID.
 * Returns undefined if neither the ID nor any alias matches.
 */
export function resolveModel(name: string): string | undefined {
    if (byId.has(name)) return name;
    return aliasToId.get(name);
}

/**
 * Get model capabilities by canonical model ID.
 * Returns undefined for unknown models (callers may throw if desired).
 */
export function getModelCapabilities(modelId: string): ModelCapabilities | undefined {
    return byId.get(modelId);
}

/**
 * Default capabilities for models not in the registry.
 * Assumes a reasonable modern model with native tool support.
 * Cost is null (unknown) so budget enforcement is skipped.
 */
export const UNKNOWN_MODEL_DEFAULTS: ModelCapabilities = {
    maxContext: 32_000,
    maxOutput: 8192,
    supportsTools: 'native',
    supportsVision: false,
    supportsStreaming: true,
    supportsPrefill: false,
    supportsEmbedding: false,
    embeddingModels: [],
    toolReliability: 'good',
    costPerMillion: { input: 0, output: 0 },
    specialFeatures: [],
    bytesPerToken: 3,
};

/**
 * Get model capabilities, falling back to sensible defaults for unknown models.
 * Use this when crashing on unknown models is not acceptable (e.g., CLI entry point).
 */
export function getModelCapabilitiesOrDefaults(modelId: string): ModelCapabilities {
    return byId.get(modelId) ?? UNKNOWN_MODEL_DEFAULTS;
}

/**
 * Return all known canonical model IDs (not aliases).
 */
export function getKnownModelIds(): string[] {
    return Array.from(byId.keys());
}
