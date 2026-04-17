/**
 * Configuration schema, types, defaults, and validation.
 *
 * Defines the ResolvedConfig type, hardcoded defaults, JSON Schema for
 * validation, and an ajv-based validator that returns friendly errors.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Ajv = require('ajv') as { new(opts?: { allErrors?: boolean }): AjvInstance };

interface AjvInstance {
    compile(schema: object): ValidateFn;
}
interface ValidateFn {
    (data: unknown): boolean;
    errors?: Array<{ instancePath?: string; message?: string }> | null;
}

// --- Config sub-types ---

export interface ProviderEntry {
    name: string;
    /** Driver identifier: 'nanogpt' | 'anthropic' | 'openai'. Defaults to name when omitted. */
    driver?: string;
    baseUrl: string | null;
    timeout: number;
    priority: number;
}

export interface PreauthRule {
    id: string;
    tool: string;
    match: {
        commandRegex?: string;
        cwdPattern?: string;
    };
    decision: 'allow' | 'deny';
    scope: 'session' | 'permanent';
}

// --- ResolvedConfig ---

export interface ResolvedConfig {
    schemaVersion: number;
    providers: ProviderEntry[];
    defaultProvider: string;
    apiTimeout: number;
    model: {
        default: string | null;
        compressionModel: string | null;
        temperature: number;
        maxOutputTokens: number;
    };
    permissions: {
        nonInteractive: boolean;
        preauth: PreauthRule[];
        classOverrides: Record<string, string>;
        toolOverrides: Record<string, string>;
        blockedTools: string[];
    };
    sandbox: {
        extraTrustedRoots: string[];
    };
    network: {
        mode: 'off' | 'approved-only' | 'open';
        allowDomains: string[];
        denyDomains: string[];
        allowHttp: boolean;
    };
    scrubbing: {
        enabled: boolean;
        allowPatterns: string[];
    };
    project: {
        ignorePaths: string[];
        docAliases: Record<string, string>;
        conventions: string;
    };
    limits: {
        maxStepsPerTurn: number;
        maxConsecutiveAutonomousToolSteps: number;
        maxConcurrentAgents: number;
        maxDelegationDepth: number;
        maxTotalAgents: number;
    };
    budget: {
        session: number | null;
        daily: number | null;
        warning: number;
    };
    retention: {
        days: number;
        maxSizeGb: number;
    };
    telemetry: {
        enabled: boolean;
        endpoint: string;
        interval: number; // seconds (default 300)
    };
    trustedWorkspaces: Record<string, 'trusted' | 'untrusted'>;
    /** Default project root for `aca rp-research`. Overridden by --project-root or ACA_RP_PROJECT_ROOT. */
    rpProjectRoot: string | null;
    /** Default model for `aca rp-research`. Overridden by --model. */
    rpModel: string | null;
}

// --- Defaults ---

export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Default LLM-call timeout in milliseconds.
 *
 * Acts as the SSE idle timer in the NanoGPT/Anthropic/OpenAI drivers (resets
 * on each event, not a hard wall-clock). Set to 20 minutes to honour the
 * project philosophy that "the only failure is failure itself, not a
 * self-imposed timeout limit" — slow models on freshly-warming subscription
 * pools (e.g. gemma-4-31b-it on NanoGPT in early April 2026) routinely need
 * 2-5+ min for first-byte arrival. A real connection failure (TCP RST, HTTP
 * error) still surfaces immediately; only the synthetic "no bytes for X
 * seconds" abort is pushed out.
 */
export const DEFAULT_API_TIMEOUT_MS = 20 * 60 * 1000;

export const CONFIG_DEFAULTS: ResolvedConfig = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    providers: [
        { name: 'nanogpt', baseUrl: null, timeout: DEFAULT_API_TIMEOUT_MS, priority: 1 },
    ],
    defaultProvider: 'nanogpt',
    apiTimeout: DEFAULT_API_TIMEOUT_MS,
    model: {
        default: null,
        compressionModel: null,
        temperature: 0.1,
        maxOutputTokens: 16384,
    },
    permissions: {
        nonInteractive: false,
        preauth: [],
        classOverrides: {},
        toolOverrides: {},
        blockedTools: [],
    },
    sandbox: {
        extraTrustedRoots: [],
    },
    network: {
        mode: 'approved-only',
        allowDomains: [],
        denyDomains: [],
        allowHttp: false,
    },
    scrubbing: {
        enabled: true,
        allowPatterns: [],
    },
    project: {
        ignorePaths: [],
        docAliases: {},
        conventions: '',
    },
    limits: {
        maxStepsPerTurn: 25,
        maxConsecutiveAutonomousToolSteps: 10,
        maxConcurrentAgents: 4,
        maxDelegationDepth: 2,
        maxTotalAgents: 20,
    },
    budget: {
        session: null,
        daily: null,
        warning: 0.80,
    },
    retention: {
        days: 30,
        maxSizeGb: 5,
    },
    telemetry: {
        enabled: false,
        endpoint: '',
        interval: 300,
    },
    trustedWorkspaces: {},
    rpProjectRoot: null,
    rpModel: null,
};

// --- JSON Schema ---

export const configJsonSchema = {
    type: 'object',
    properties: {
        schemaVersion: { type: 'number', minimum: 1 },
        providers: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    driver: { type: 'string' },
                    baseUrl: { type: ['string', 'null'] },
                    timeout: { type: 'number', minimum: 0 },
                    priority: { type: 'number', minimum: 1 },
                },
                required: ['name'],
            },
        },
        defaultProvider: { type: 'string' },
        apiTimeout: { type: 'number', minimum: 0 },
        model: {
            type: 'object',
            properties: {
                default: { type: ['string', 'null'] },
                compressionModel: { type: ['string', 'null'] },
                temperature: { type: 'number', minimum: 0, maximum: 2 },
                maxOutputTokens: { type: 'number', minimum: 1 },
            },
        },
        permissions: {
            type: 'object',
            properties: {
                nonInteractive: { type: 'boolean' },
                preauth: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            tool: { type: 'string' },
                            match: {
                                type: 'object',
                                properties: {
                                    commandRegex: { type: 'string' },
                                    cwdPattern: { type: 'string' },
                                },
                            },
                            decision: { type: 'string', enum: ['allow', 'deny'] },
                            scope: { type: 'string', enum: ['session', 'permanent'] },
                        },
                        required: ['id', 'tool', 'match', 'decision', 'scope'],
                    },
                },
                classOverrides: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                },
                toolOverrides: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                },
                blockedTools: { type: 'array', items: { type: 'string' } },
            },
        },
        sandbox: {
            type: 'object',
            properties: {
                extraTrustedRoots: { type: 'array', items: { type: 'string' } },
            },
        },
        network: {
            type: 'object',
            properties: {
                mode: { type: 'string', enum: ['off', 'approved-only', 'open'] },
                allowDomains: { type: 'array', items: { type: 'string' } },
                denyDomains: { type: 'array', items: { type: 'string' } },
                allowHttp: { type: 'boolean' },
            },
        },
        scrubbing: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' },
                allowPatterns: { type: 'array', items: { type: 'string' } },
            },
        },
        project: {
            type: 'object',
            properties: {
                ignorePaths: { type: 'array', items: { type: 'string' } },
                docAliases: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                },
                conventions: { type: 'string' },
            },
        },
        limits: {
            type: 'object',
            properties: {
                maxStepsPerTurn: { type: 'number', minimum: 1 },
                maxConsecutiveAutonomousToolSteps: { type: 'number', minimum: 1 },
                maxConcurrentAgents: { type: 'number', minimum: 1 },
                maxDelegationDepth: { type: 'number', minimum: 0 },
                maxTotalAgents: { type: 'number', minimum: 1 },
            },
        },
        budget: {
            type: 'object',
            properties: {
                session: { type: ['number', 'null'], minimum: 0 },
                daily: { type: ['number', 'null'], minimum: 0 },
                warning: { type: 'number', minimum: 0, maximum: 1 },
            },
        },
        retention: {
            type: 'object',
            properties: {
                days: { type: 'number', minimum: 1 },
                maxSizeGb: { type: 'number', minimum: 0 },
            },
        },
        telemetry: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' },
                endpoint: { type: 'string' },
                interval: { type: 'number', minimum: 10 },
            },
        },
        trustedWorkspaces: {
            type: 'object',
            additionalProperties: { type: 'string', enum: ['trusted', 'untrusted'] },
        },
        rpProjectRoot: { type: ['string', 'null'] },
        rpModel: { type: ['string', 'null'] },
    },
};

// --- Validation ---

const ajv = new Ajv({ allErrors: true });
const compiledValidator = ajv.compile(configJsonSchema);

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

/** Validate a config object against the JSON Schema. Returns friendly error messages. */
export function validateConfig(data: unknown): ValidationResult {
    const valid = compiledValidator(data);
    if (valid) {
        return { valid: true, errors: [] };
    }

    const errors = (compiledValidator.errors ?? []).map((err: { instancePath?: string; message?: string }) => {
        const path = err.instancePath || '/';
        const msg = err.message ?? 'unknown error';
        return `${path}: ${msg}`;
    });

    return { valid: false, errors };
}
