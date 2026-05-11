import { loadSecrets } from '../config/secrets.js';
import {
    NanoGptCatalog,
    StaticCatalog,
    type ModelCatalogEntry,
} from '../providers/model-catalog.js';

export interface ModelsCommandOptions {
    json?: boolean;
    search?: string;
    tools?: boolean;
    reasoning?: boolean;
    vision?: boolean;
    structuredOutput?: boolean;
    limit?: number;
    offline?: boolean;
    baseUrl?: string;
}

export interface ModelsCommandDeps {
    fetchFn?: typeof globalThis.fetch;
    env?: Record<string, string | undefined>;
    secretsPath?: string;
    apiKeysPath?: string;
}

interface SerializedModel {
    id: string;
    context_length: number;
    max_output_tokens: number;
    capabilities: {
        vision: boolean;
        tool_calling: boolean;
        reasoning: boolean;
        structured_output: boolean;
    };
    pricing?: {
        input: number;
        output: number;
    };
}

interface ModelsCatalogOutput {
    provider: 'nanogpt';
    endpoint: string;
    status: 'ok' | 'fallback';
    source: 'live' | 'fallback' | 'static' | 'unloaded';
    model_count: number;
    total_model_count: number;
    filters: Record<string, unknown>;
    warnings: string[];
    last_error: string | null;
    models: SerializedModel[];
}

const DEFAULT_NANOGPT_BASE_URL = 'https://nano-gpt.com/api';

export async function runModelsJson(
    options: ModelsCommandOptions = {},
    deps: ModelsCommandDeps = {},
): Promise<string> {
    const output = await buildModelsCatalogOutput(options, deps);
    return JSON.stringify(output, null, 2);
}

export async function runModelsText(
    options: ModelsCommandOptions = {},
    deps: ModelsCommandDeps = {},
): Promise<string> {
    const output = await buildModelsCatalogOutput(options, deps);
    const lines = [
        'NanoGPT Models',
        `source: ${output.source} | status: ${output.status} | models: ${output.model_count}/${output.total_model_count}`,
        `endpoint: ${output.endpoint}`,
    ];
    if (output.last_error) lines.push(`fallback reason: ${output.last_error}`);
    if (output.warnings.length) {
        lines.push(`warnings: ${output.warnings.join('; ')}`);
    }
    lines.push('');
    lines.push(`${pad('Model', 42)} ${pad('Context', 9)} ${pad('Output', 9)} Capabilities`);
    lines.push(`${'-'.repeat(42)} ${'-'.repeat(9)} ${'-'.repeat(9)} ${'-'.repeat(28)}`);
    for (const model of output.models) {
        lines.push([
            pad(model.id, 42),
            pad(formatNumber(model.context_length), 9),
            pad(formatNumber(model.max_output_tokens), 9),
            formatCapabilities(model),
        ].join(' '));
    }
    if (output.models.length === 0) {
        lines.push('(no models matched)');
    }
    return lines.join('\n');
}

export async function buildModelsCatalogOutput(
    options: ModelsCommandOptions = {},
    deps: ModelsCommandDeps = {},
): Promise<ModelsCatalogOutput> {
    const warnings: string[] = [];
    const baseUrl = options.baseUrl ?? DEFAULT_NANOGPT_BASE_URL;
    const endpoint = `${baseUrl}/subscription/v1/models?detailed=true`;
    const staticCatalog = new StaticCatalog();
    const secrets = options.offline
        ? { secrets: {}, warnings: [] }
        : await loadSecrets(deps.env, deps.secretsPath, deps.apiKeysPath);
    const catalog = options.offline
        ? staticCatalog
        : new NanoGptCatalog({
            apiKey: secrets.secrets.nanogpt,
            baseUrl,
            fallback: staticCatalog,
            fetchFn: deps.fetchFn,
        });

    if (!options.offline) {
        warnings.push(...secrets.warnings);
        if (!secrets.secrets.nanogpt) warnings.push('NANOGPT_API_KEY not found; live discovery may fall back.');
    }

    await catalog.fetch();
    const allModels = catalog.listModels().map(serializeModel);
    const models = applyModelFilters(allModels, options);
    const limited = Number.isInteger(options.limit) && options.limit !== undefined && options.limit > 0
        ? models.slice(0, options.limit)
        : models;

    return {
        provider: 'nanogpt',
        endpoint,
        status: catalog.source === 'live' || catalog.source === 'static' ? 'ok' : 'fallback',
        source: catalog.source,
        model_count: limited.length,
        total_model_count: allModels.length,
        filters: {
            search: options.search ?? null,
            tools: Boolean(options.tools),
            reasoning: Boolean(options.reasoning),
            vision: Boolean(options.vision),
            structured_output: Boolean(options.structuredOutput),
            limit: options.limit ?? null,
        },
        warnings,
        last_error: catalog.lastError,
        models: limited,
    };
}

function serializeModel(entry: ModelCatalogEntry): SerializedModel {
    return {
        id: entry.id,
        context_length: entry.contextLength,
        max_output_tokens: entry.maxOutputTokens,
        capabilities: {
            vision: entry.capabilities.vision,
            tool_calling: entry.capabilities.toolCalling,
            reasoning: entry.capabilities.reasoning,
            structured_output: entry.capabilities.structuredOutput,
        },
        ...(entry.pricing ? { pricing: entry.pricing } : {}),
    };
}

function applyModelFilters(models: SerializedModel[], options: ModelsCommandOptions): SerializedModel[] {
    const search = options.search?.trim().toLowerCase();
    return models.filter((model) => {
        if (search && !model.id.toLowerCase().includes(search)) return false;
        if (options.tools && !model.capabilities.tool_calling) return false;
        if (options.reasoning && !model.capabilities.reasoning) return false;
        if (options.vision && !model.capabilities.vision) return false;
        if (options.structuredOutput && !model.capabilities.structured_output) return false;
        return true;
    });
}

function formatCapabilities(model: SerializedModel): string {
    const caps: string[] = [];
    if (model.capabilities.tool_calling) caps.push('tools');
    if (model.capabilities.reasoning) caps.push('reasoning');
    if (model.capabilities.vision) caps.push('vision');
    if (model.capabilities.structured_output) caps.push('structured');
    return caps.length ? caps.join(',') : '-';
}

function formatNumber(value: number): string {
    return value.toLocaleString('en-US');
}

function pad(value: string, width: number): string {
    if (value.length >= width) return value;
    return value + ' '.repeat(width - value.length);
}
