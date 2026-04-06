/**
 * Config loading pipeline — 9 steps from defaults to frozen ResolvedConfig.
 *
 * 1. Load defaults (hardcoded)
 * 2. Load user config from ~/.aca/config.json
 * 3. Load project config from .aca/config.json (trust-boundary filtered)
 * 4. Parse ACA_ environment variables
 * 5. Parse CLI flags
 * 6. Merge in priority order: defaults <- user <- project <- env <- CLI
 * 7. Most-restrictive-wins for permission fields (applied during project merge)
 * 8. Validate merged result
 * 9. Freeze and return
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
    type ResolvedConfig,
    CONFIG_DEFAULTS,
    CURRENT_SCHEMA_VERSION,
    validateConfig,
} from './schema.js';
import { deepMerge, mergeProjectConfig } from './merge.js';
import { filterProjectConfig } from './trust-boundary.js';

// --- Public types ---

export interface ConfigLoadOptions {
    workspaceRoot: string;
    cliFlags?: Record<string, unknown>;
    env?: Record<string, string | undefined>;
    /** Override user config path for testing. */
    userConfigPath?: string;
    /** Override project config path for testing. */
    projectConfigPath?: string;
}

export interface ConfigLoadResult {
    config: Readonly<ResolvedConfig>;
    warnings: string[];
    sources: {
        user: boolean;
        project: boolean;
        env: string[];
        cli: string[];
    };
}

// --- Env var mapping ---

interface EnvVarMapping {
    path: string[];
    type: 'string' | 'number' | 'boolean' | 'string[]';
}

const ENV_VAR_MAP: Record<string, EnvVarMapping> = {
    ACA_MODEL_DEFAULT: { path: ['model', 'default'], type: 'string' },
    ACA_MODEL_TEMPERATURE: { path: ['model', 'temperature'], type: 'number' },
    ACA_MODEL_MAX_OUTPUT_TOKENS: { path: ['model', 'maxOutputTokens'], type: 'number' },
    ACA_DEFAULT_PROVIDER: { path: ['defaultProvider'], type: 'string' },
    ACA_API_TIMEOUT: { path: ['apiTimeout'], type: 'number' },
    ACA_NETWORK_MODE: { path: ['network', 'mode'], type: 'string' },
    ACA_NETWORK_ALLOW_DOMAINS: { path: ['network', 'allowDomains'], type: 'string[]' },
    ACA_NETWORK_DENY_DOMAINS: { path: ['network', 'denyDomains'], type: 'string[]' },
    ACA_NETWORK_ALLOW_HTTP: { path: ['network', 'allowHttp'], type: 'boolean' },
    ACA_PERMISSIONS_NON_INTERACTIVE: { path: ['permissions', 'nonInteractive'], type: 'boolean' },
    ACA_SCRUBBING_ENABLED: { path: ['scrubbing', 'enabled'], type: 'boolean' },
    ACA_LIMITS_MAX_STEPS_PER_TURN: { path: ['limits', 'maxStepsPerTurn'], type: 'number' },
    ACA_LIMITS_MAX_CONCURRENT_AGENTS: { path: ['limits', 'maxConcurrentAgents'], type: 'number' },
};

/**
 * Parse ACA_ environment variables into a partial config object.
 * Unset or empty env vars are ignored (treated as absent, not empty/false).
 */
export function parseEnvVars(
    env: Record<string, string | undefined>,
): { config: Record<string, unknown>; usedVars: string[] } {
    const config: Record<string, unknown> = {};
    const usedVars: string[] = [];

    for (const [envVar, mapping] of Object.entries(ENV_VAR_MAP)) {
        const raw = env[envVar];
        if (raw === undefined || raw === '') continue;

        const value = coerceEnvValue(raw, mapping.type);
        if (value === undefined) continue;

        setNested(config, mapping.path, value);
        usedVars.push(envVar);
    }

    return { config, usedVars };
}

function coerceEnvValue(raw: string, type: EnvVarMapping['type']): unknown {
    switch (type) {
        case 'string':
            return raw;
        case 'number': {
            const n = Number(raw);
            return Number.isFinite(n) ? n : undefined;
        }
        case 'boolean':
            if (raw === 'true' || raw === '1') return true;
            if (raw === 'false' || raw === '0') return false;
            return undefined;
        case 'string[]':
            return raw.split(',').map(s => s.trim()).filter(Boolean);
    }
}

// --- Config loading pipeline ---

/**
 * Load and merge config from all 5 sources, validate, freeze, and return.
 */
export async function loadConfig(options: ConfigLoadOptions): Promise<ConfigLoadResult> {
    const {
        workspaceRoot,
        cliFlags = {},
        env = process.env,
    } = options;
    const warnings: string[] = [];
    const sources = { user: false, project: false, env: [] as string[], cli: [] as string[] };

    // Step 1: Start with defaults
    let merged: Record<string, unknown> = structuredClone(CONFIG_DEFAULTS) as unknown as Record<string, unknown>;

    // Step 2: Load user config
    const userConfigPath = options.userConfigPath ?? join(homedir(), '.aca', 'config.json');
    const userConfig = await loadJsonFile(userConfigPath);
    if (userConfig.error) {
        if (userConfig.error !== 'ENOENT') {
            warnings.push(`User config: ${userConfig.error}. Using defaults.`);
        }
    } else if (userConfig.data !== null) {
        const schemaCheck = checkSchemaVersion(userConfig.data);
        if (schemaCheck) warnings.push(schemaCheck);

        const validation = validateConfig(userConfig.data);
        if (!validation.valid) {
            warnings.push(`User config is malformed: ${validation.errors.join('; ')}. Using defaults.`);
        } else {
            merged = deepMerge(merged, userConfig.data as Record<string, unknown>);
            sources.user = true;
        }
    }

    // Step 3: Load project config (trust-boundary filtered)
    const projectConfigPath = options.projectConfigPath ?? join(workspaceRoot, '.aca', 'config.json');
    const projectConfig = await loadJsonFile(projectConfigPath);
    if (projectConfig.error) {
        if (projectConfig.error !== 'ENOENT') {
            warnings.push(`Project config: ${projectConfig.error}. Ignoring.`);
        }
    } else if (projectConfig.data !== null) {
        const schemaCheck = checkSchemaVersion(projectConfig.data);
        if (schemaCheck) warnings.push(schemaCheck);

        const validation = validateConfig(projectConfig.data);
        if (!validation.valid) {
            warnings.push(`Project config is malformed: ${validation.errors.join('; ')}. Ignoring entirely.`);
        } else {
            // Determine if workspace is trusted
            const trustedWorkspaces = (merged as Record<string, unknown>).trustedWorkspaces as Record<string, string> | undefined;
            const isTrusted = trustedWorkspaces?.[workspaceRoot] === 'trusted';

            // Filter through trust boundary
            const filtered = filterProjectConfig(
                projectConfig.data as Record<string, unknown>,
                isTrusted,
            );

            // Step 7: Merge with most-restrictive-wins for permission fields
            merged = mergeProjectConfig(merged, filtered);
            sources.project = true;
        }
    }

    // Step 4: Parse environment variables
    const envResult = parseEnvVars(env);
    if (envResult.usedVars.length > 0) {
        merged = deepMerge(merged, envResult.config);
        sources.env = envResult.usedVars;
    }

    // Step 5: Merge CLI flags
    const cliKeys = Object.keys(cliFlags);
    if (cliKeys.length > 0) {
        merged = deepMerge(merged, cliFlags);
        sources.cli = cliKeys;
    }

    // Step 8: Validate final merged result (fail closed)
    const finalValidation = validateConfig(merged);
    if (!finalValidation.valid) {
        // Starting from valid defaults, the only way this fails is if env vars
        // or CLI flags introduce invalid values. Fail closed rather than run
        // with an invalid config that could cause undefined behavior.
        throw new Error(
            `Configuration validation failed: ${finalValidation.errors.join('; ')}. `
            + 'Fix the invalid values in environment variables or CLI flags.',
        );
    }

    // Step 9: Freeze and return
    const config = deepFreeze(merged) as unknown as Readonly<ResolvedConfig>;

    return { config, warnings, sources };
}

// --- Config drift detection ---

export interface ConfigDrift {
    field: string;
    previous: unknown;
    current: unknown;
    securityRelevant: boolean;
}

const SECURITY_RELEVANT_PATHS = [
    'permissions.nonInteractive',
    'permissions.blockedTools',
    'sandbox.extraTrustedRoots',
    'network.mode',
    'network.allowDomains',
    'network.denyDomains',
    'network.allowHttp',
    'scrubbing.enabled',
];

/**
 * Compare current resolved config against a session snapshot.
 * Returns a list of changed fields, flagging security-relevant ones.
 */
export function detectConfigDrift(
    current: ResolvedConfig,
    snapshot: Record<string, unknown>,
): ConfigDrift[] {
    const drifts: ConfigDrift[] = [];

    for (const path of SECURITY_RELEVANT_PATHS) {
        const currentVal = getNested(current as unknown as Record<string, unknown>, path.split('.'));
        const snapshotVal = getNested(snapshot, path.split('.'));

        if (!deepEqual(currentVal, snapshotVal)) {
            drifts.push({
                field: path,
                previous: snapshotVal,
                current: currentVal,
                securityRelevant: true,
            });
        }
    }

    // Check non-security fields for informational drift
    const infoFields = ['model.default', 'defaultProvider', 'model.temperature'];
    for (const path of infoFields) {
        const currentVal = getNested(current as unknown as Record<string, unknown>, path.split('.'));
        const snapshotVal = getNested(snapshot, path.split('.'));

        if (!deepEqual(currentVal, snapshotVal)) {
            drifts.push({
                field: path,
                previous: snapshotVal,
                current: currentVal,
                securityRelevant: false,
            });
        }
    }

    return drifts;
}

// --- Internal helpers ---

async function loadJsonFile(filePath: string): Promise<{ data: unknown | null; error: string | null }> {
    try {
        const content = await readFile(filePath, 'utf-8');
        try {
            return { data: JSON.parse(content), error: null };
        } catch {
            return { data: null, error: 'invalid JSON' };
        }
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return { data: null, error: 'ENOENT' };
        }
        return { data: null, error: (err as Error).message };
    }
}

function checkSchemaVersion(data: unknown): string | null {
    if (typeof data !== 'object' || data === null) return null;
    const version = (data as Record<string, unknown>).schemaVersion;
    if (typeof version === 'number' && version > CURRENT_SCHEMA_VERSION) {
        return `Config schemaVersion ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}. Unknown fields will be ignored.`;
    }
    return null;
}

function setNested(obj: Record<string, unknown>, path: string[], value: unknown): void {
    let current = obj;
    for (let i = 0; i < path.length - 1; i++) {
        if (typeof current[path[i]] !== 'object' || current[path[i]] === null) {
            current[path[i]] = {};
        }
        current = current[path[i]] as Record<string, unknown>;
    }
    current[path[path.length - 1]] = value;
}

function getNested(obj: Record<string, unknown>, path: string[]): unknown {
    let current: unknown = obj;
    for (const key of path) {
        if (typeof current !== 'object' || current === null) return undefined;
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((val, i) => deepEqual(val, b[i]));
    }
    if (typeof a === 'object' && typeof b === 'object') {
        const aKeys = Object.keys(a as Record<string, unknown>);
        const bKeys = Object.keys(b as Record<string, unknown>);
        if (aKeys.length !== bKeys.length) return false;
        return aKeys.every(key =>
            deepEqual(
                (a as Record<string, unknown>)[key],
                (b as Record<string, unknown>)[key],
            ),
        );
    }
    return false;
}

/** Recursively freeze an object and all nested objects/arrays. */
export function deepFreeze<T extends object>(obj: T): Readonly<T> {
    Object.freeze(obj);
    for (const value of Object.values(obj)) {
        if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
            deepFreeze(value as object);
        }
    }
    return obj;
}
