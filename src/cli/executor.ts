/**
 * Executor mode: `aca describe` (JSON descriptor on stdout) and `aca invoke` (structured task from stdin, JSON response on stdout).
 *
 * Implements the callee side of the universal capability contract (Block 1, Block 10).
 * All output is structured JSON on stdout. stderr is reserved for catastrophic failures only.
 */
// --- Contract versions ---

import type { ModelResponseFormat, RequestMessage } from '../types/provider.js';
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const CONTRACT_VERSION = '1.0.0';
export const SCHEMA_VERSION = '1.1.0';

// --- Capability Descriptor (aca describe) ---

export interface CapabilityDescriptor {
    contract_version: string;
    schema_version: string;
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
    constraints: DescriptorConstraints;
}

export interface DescriptorConstraints {
    max_steps_per_turn: number | null;
    supports_streaming: boolean;
    ephemeral_sessions: boolean;
    supported_tools: string[];
    supported_profiles: string[];
}

// --- Invoke Request (stdin envelope) ---

export interface InvokeRequest {
    contract_version: string;
    schema_version: string;
    task: string;
    input?: Record<string, unknown>;
    context?: InvokeContext;
    constraints?: InvokeConstraints;
    authority?: AuthorityGrant[];
    deadline?: number;
}

export interface InvokeContext extends Record<string, unknown> {
    cwd?: string;
    model?: string;
    profile?: string;
    temperature?: number;
    top_p?: number;
    topP?: number;
    thinking?: 'enabled' | 'disabled' | { type?: 'enabled' | 'disabled' };
    response_format?: ModelResponseFormat;
    responseFormat?: ModelResponseFormat;
    system_messages?: InvokeSystemMessage[];
    systemMessages?: InvokeSystemMessage[];
}

export type InvokeSystemMessage = Pick<RequestMessage, 'role' | 'content'> & { role: 'system'; content: string };

export interface InvokeConstraints {
    max_steps?: number;
    max_tool_calls?: number;
    max_tool_calls_by_name?: Record<string, number>;
    max_tool_result_bytes?: number;
    max_input_tokens?: number;
    max_repeated_read_calls?: number;
    max_total_tokens?: number;
    required_output_paths?: string[];
    fail_on_rejected_tool_calls?: boolean;
    allowed_tools?: string[];
    denied_tools?: string[];
}

export interface AuthorityGrant {
    tool: string;
    args_match?: Record<string, unknown>;
    decision: 'approve' | 'deny';
}

// --- Invoke Response (stdout envelope) ---

export interface InvokeResponse {
    contract_version: string;
    schema_version: string;
    status: 'success' | 'error';
    result?: string;
    usage?: InvokeUsage;
    safety?: InvokeSafety;
    errors?: InvokeError[];
}

export interface InvokeUsage {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
}

export interface InvokeSafety {
    outcome?: string;
    steps: number;
    estimated_input_tokens_max?: number;
    accepted_tool_calls: number;
    rejected_tool_calls: number;
    accepted_tool_calls_by_name: Record<string, number>;
    tool_result_bytes: number;
    guardrails: string[];
    /** True if token budget was exceeded but task still completed successfully. */
    budget_exceeded?: boolean;
}

export interface InvokeError {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
}

// --- Exit codes ---

export const EXIT_SUCCESS = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_PROTOCOL = 5;

// --- Version compatibility check ---

/**
 * Check that contract_version and schema_version major numbers match.
 * Returns null if compatible, or an InvokeResponse error if not.
 */
export function checkVersionCompatibility(
    requestContractVersion: string,
    requestSchemaVersion: string,
): InvokeResponse | null {
    const supportedContractMajor = parseMajor(CONTRACT_VERSION);
    const supportedSchemaMajor = parseMajor(SCHEMA_VERSION);
    const requestContractMajor = parseMajor(requestContractVersion);
    const requestSchemaMajor = parseMajor(requestSchemaVersion);

    if (requestContractMajor === null || requestContractMajor !== supportedContractMajor) {
        return {
            contract_version: CONTRACT_VERSION,
            schema_version: SCHEMA_VERSION,
            status: 'error',
            errors: [{
                code: 'unsupported_version',
                message: `Contract version mismatch: requested ${requestContractVersion}, supported ${CONTRACT_VERSION}`,
                retryable: false,
                details: {
                    capability_id: 'aca',
                    requested_contract_version: requestContractVersion,
                    supported_contract_version: CONTRACT_VERSION,
                    requested_schema_version: requestSchemaVersion,
                    supported_schema_version: SCHEMA_VERSION,
                },
            }],
        };
    }

    if (requestSchemaMajor === null || requestSchemaMajor !== supportedSchemaMajor) {
        return {
            contract_version: CONTRACT_VERSION,
            schema_version: SCHEMA_VERSION,
            status: 'error',
            errors: [{
                code: 'unsupported_version',
                message: `Schema version mismatch: requested ${requestSchemaVersion}, supported ${SCHEMA_VERSION}`,
                retryable: false,
                details: {
                    capability_id: 'aca',
                    requested_contract_version: requestContractVersion,
                    supported_contract_version: CONTRACT_VERSION,
                    requested_schema_version: requestSchemaVersion,
                    supported_schema_version: SCHEMA_VERSION,
                },
            }],
        };
    }

    return null;
}

function parseMajor(version: string): number | null {
    const dot = version.indexOf('.');
    const majorStr = dot === -1 ? version : version.slice(0, dot);
    const major = Number(majorStr);
    return Number.isFinite(major) ? major : null;
}

// --- Build capability descriptor ---

export function buildDescriptor(toolNames: string[]): CapabilityDescriptor {
    return {
        contract_version: CONTRACT_VERSION,
        schema_version: SCHEMA_VERSION,
        name: 'aca',
        description: 'Another Coding Agent — an AI-powered coding assistant that can read, write, and execute code with tool access',
        input_schema: {
            type: 'object',
            properties: {
                task: { type: 'string', description: 'The task to execute' },
                input: { type: 'object', description: 'Additional structured input' },
                context: {
                    type: 'object',
                    description: 'Contextual information for the task',
                    properties: {
                        model: { type: 'string', description: 'Model override for this invocation' },
                        cwd: {
                            type: 'string',
                            description: 'Workspace root override for this invocation. Relative paths resolve from the current shell working directory; absolute paths are used as-is.',
                        },
                        profile: {
                            type: 'string',
                            description: 'Built-in agent profile to apply. Use rp-researcher for RP lore/anime/manga/VN research and Markdown compendium writing.',
                        },
                        temperature: { type: 'number', minimum: 0, maximum: 2, description: 'Model sampling temperature override' },
                        top_p: { type: 'number', minimum: 0, maximum: 1, description: 'Model nucleus sampling override' },
                        thinking: {
                            oneOf: [
                                { type: 'string', enum: ['enabled', 'disabled'] },
                                {
                                    type: 'object',
                                    properties: { type: { type: 'string', enum: ['enabled', 'disabled'] } },
                                    required: ['type'],
                                },
                            ],
                            description: 'Provider thinking mode override when supported',
                        },
                        response_format: {
                            type: 'object',
                            description: 'OpenAI-compatible structured-output response_format override for providers that support it',
                        },
                        system_messages: {
                            type: 'array',
                            description: 'Optional explicit system messages to use instead of ACA invoke defaults. Intended for internal bounded workflows such as no-tools consult passes.',
                            items: {
                                type: 'object',
                                properties: {
                                    role: { type: 'string', enum: ['system'] },
                                    content: { type: 'string' },
                                },
                                required: ['role', 'content'],
                            },
                        },
                    },
                },
                constraints: {
                    type: 'object',
                    properties: {
                        max_steps: { type: 'number' },
                        max_tool_calls: { type: 'number' },
                        max_tool_calls_by_name: {
                            type: 'object',
                            additionalProperties: { type: 'number' },
                        },
                        max_tool_result_bytes: { type: 'number' },
                        max_input_tokens: { type: 'number' },
                        max_repeated_read_calls: { type: 'number' },
                        max_total_tokens: { type: 'number' },
                        required_output_paths: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Output files that must exist and be non-empty when invoke completes',
                        },
                        fail_on_rejected_tool_calls: {
                            type: 'boolean',
                            description: 'Treat any rejected tool call as an invoke error instead of a successful-but-degraded turn',
                        },
                        allowed_tools: { type: 'array', items: { type: 'string' } },
                        denied_tools: { type: 'array', items: { type: 'string' } },
                    },
                },
                authority: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            tool: { type: 'string' },
                            args_match: { type: 'object' },
                            decision: { type: 'string', enum: ['approve', 'deny'] },
                        },
                        required: ['tool', 'decision'],
                    },
                },
                deadline: { type: 'number', description: 'Timeout in milliseconds' },
            },
            required: ['task'],
        },
        output_schema: {
            type: 'object',
            properties: {
                contract_version: { type: 'string' },
                schema_version: { type: 'string' },
                status: { type: 'string', enum: ['success', 'error'] },
                result: { type: 'string' },
                usage: {
                    type: 'object',
                    properties: {
                        input_tokens: { type: 'number' },
                        output_tokens: { type: 'number' },
                        cost_usd: { type: 'number' },
                    },
                },
                safety: {
                    type: 'object',
                    properties: {
                        outcome: { type: 'string' },
                        steps: { type: 'number' },
                        estimated_input_tokens_max: { type: 'number' },
                        accepted_tool_calls: { type: 'number' },
                        rejected_tool_calls: { type: 'number' },
                        accepted_tool_calls_by_name: {
                            type: 'object',
                            additionalProperties: { type: 'number' },
                        },
                        tool_result_bytes: { type: 'number' },
                        guardrails: { type: 'array', items: { type: 'string' } },
                    },
                },
                errors: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            code: { type: 'string' },
                            message: { type: 'string' },
                            retryable: { type: 'boolean' },
                        },
                    },
                },
            },
            required: ['contract_version', 'schema_version', 'status'],
        },
        constraints: {
            max_steps_per_turn: null, // no default step limit; invoke callers may set constraints.max_steps
            supports_streaming: false,
            ephemeral_sessions: true,
            supported_tools: toolNames,
            supported_profiles: [
                'general',
                'researcher',
                'rp-researcher',
                'coder',
                'reviewer',
                'witness',
                'triage',
            ],
        },
    };
}

// --- Run describe (fast path) ---

/**
 * Output the capability descriptor as JSON on stdout and exit.
 * This is a fast path — no config, session, or provider loading.
 */
export function runDescribe(toolNames: string[]): string {
    return JSON.stringify(buildDescriptor(toolNames));
}

// --- Read stdin as string ---

/** Maximum stdin payload size: 10 MB. Prevents memory exhaustion from oversized input. */
const MAX_STDIN_BYTES = 10 * 1024 * 1024;

export function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        process.stdin.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_STDIN_BYTES) {
                process.stdin.destroy();
                reject(new Error(`stdin exceeds ${MAX_STDIN_BYTES} byte limit`));
                return;
            }
            chunks.push(chunk);
        });
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        process.stdin.on('error', reject);
    });
}

// --- Parse and validate invoke request ---

export function parseInvokeRequest(raw: string): { request: InvokeRequest } | { error: InvokeResponse; exitCode: number } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {
            error: {
                contract_version: CONTRACT_VERSION,
                schema_version: SCHEMA_VERSION,
                status: 'error',
                errors: [{
                    code: 'protocol.malformed_request',
                    message: 'Invalid JSON on stdin',
                    retryable: false,
                }],
            },
            exitCode: EXIT_PROTOCOL,
        };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
            error: {
                contract_version: CONTRACT_VERSION,
                schema_version: SCHEMA_VERSION,
                status: 'error',
                errors: [{
                    code: 'protocol.malformed_request',
                    message: 'Request must be a JSON object',
                    retryable: false,
                }],
            },
            exitCode: EXIT_PROTOCOL,
        };
    }

    const obj = parsed as Record<string, unknown>;

    // Require contract_version and schema_version
    if (typeof obj.contract_version !== 'string' || typeof obj.schema_version !== 'string') {
        return {
            error: {
                contract_version: CONTRACT_VERSION,
                schema_version: SCHEMA_VERSION,
                status: 'error',
                errors: [{
                    code: 'protocol.malformed_request',
                    message: 'Request must include contract_version and schema_version as strings',
                    retryable: false,
                }],
            },
            exitCode: EXIT_PROTOCOL,
        };
    }

    // Version compatibility check
    const versionError = checkVersionCompatibility(obj.contract_version, obj.schema_version);
    if (versionError) {
        return { error: versionError, exitCode: EXIT_PROTOCOL };
    }

    // Require task
    if (typeof obj.task !== 'string' || obj.task.trim() === '') {
        return {
            error: {
                contract_version: CONTRACT_VERSION,
                schema_version: SCHEMA_VERSION,
                status: 'error',
                errors: [{
                    code: 'protocol.malformed_request',
                    message: 'Request must include a non-empty "task" string',
                    retryable: false,
                }],
            },
            exitCode: EXIT_PROTOCOL,
        };
    }

    return {
        request: {
            contract_version: obj.contract_version,
            schema_version: obj.schema_version,
            task: obj.task,
            input: typeof obj.input === 'object' && obj.input !== null && !Array.isArray(obj.input) ? obj.input as Record<string, unknown> : undefined,
            context: typeof obj.context === 'object' && obj.context !== null && !Array.isArray(obj.context) ? obj.context as Record<string, unknown> : undefined,
            constraints: parseConstraints(obj.constraints),
            authority: parseAuthority(obj.authority),
            deadline: typeof obj.deadline === 'number' && Number.isFinite(obj.deadline) ? obj.deadline : undefined,
        },
    };
}

export function resolveInvokeWorkspaceRoot(
    launchCwd: string,
    context: InvokeContext | undefined,
): { workspaceRoot: string } | { error: InvokeResponse; exitCode: number } {
    const rawCwd = typeof context?.cwd === 'string' ? context.cwd.trim() : '';
    if (!rawCwd) {
        return { workspaceRoot: launchCwd };
    }

    const workspaceRoot = isAbsolute(rawCwd) ? resolve(rawCwd) : resolve(launchCwd, rawCwd);
    try {
        const stat = statSync(workspaceRoot);
        if (!stat.isDirectory()) {
            return {
                error: buildErrorResponse(
                    'protocol.invalid_context_cwd',
                    `context.cwd must point to an existing directory: ${workspaceRoot}`,
                    false,
                ),
                exitCode: EXIT_PROTOCOL,
            };
        }
    } catch {
        return {
            error: buildErrorResponse(
                'protocol.invalid_context_cwd',
                `context.cwd must point to an existing directory: ${workspaceRoot}`,
                false,
            ),
            exitCode: EXIT_PROTOCOL,
        };
    }

    return { workspaceRoot };
}

function parseConstraints(raw: unknown): InvokeConstraints | undefined {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const obj = raw as Record<string, unknown>;
    return {
        max_steps: typeof obj.max_steps === 'number' ? obj.max_steps : undefined,
        max_tool_calls: typeof obj.max_tool_calls === 'number' ? obj.max_tool_calls : undefined,
        max_tool_calls_by_name: parseNumberMap(obj.max_tool_calls_by_name),
        max_tool_result_bytes: typeof obj.max_tool_result_bytes === 'number' ? obj.max_tool_result_bytes : undefined,
        max_input_tokens: typeof obj.max_input_tokens === 'number' ? obj.max_input_tokens : undefined,
        max_repeated_read_calls: typeof obj.max_repeated_read_calls === 'number' ? obj.max_repeated_read_calls : undefined,
        max_total_tokens: typeof obj.max_total_tokens === 'number' ? obj.max_total_tokens : undefined,
        required_output_paths: Array.isArray(obj.required_output_paths)
            ? obj.required_output_paths.filter((path): path is string => typeof path === 'string' && path.trim() !== '')
            : undefined,
        fail_on_rejected_tool_calls: typeof obj.fail_on_rejected_tool_calls === 'boolean' ? obj.fail_on_rejected_tool_calls : undefined,
        allowed_tools: Array.isArray(obj.allowed_tools) ? obj.allowed_tools.filter((t): t is string => typeof t === 'string') : undefined,
        denied_tools: Array.isArray(obj.denied_tools) ? obj.denied_tools.filter((t): t is string => typeof t === 'string') : undefined,
    };
}

function parseNumberMap(raw: unknown): Record<string, number> | undefined {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            result[key] = value;
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function parseAuthority(raw: unknown): AuthorityGrant[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    return raw
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .filter(item => typeof item.tool === 'string' && (item.decision === 'approve' || item.decision === 'deny'))
        .map(item => ({
            tool: item.tool as string,
            args_match: typeof item.args_match === 'object' && item.args_match !== null
                ? item.args_match as Record<string, unknown>
                : undefined,
            decision: item.decision as 'approve' | 'deny',
        }));
}

// --- Build error response ---

export function buildErrorResponse(
    code: string,
    message: string,
    retryable = false,
    safety?: InvokeSafety,
    usage?: InvokeUsage,
): InvokeResponse {
    return {
        contract_version: CONTRACT_VERSION,
        schema_version: SCHEMA_VERSION,
        status: 'error',
        errors: [{ code, message, retryable }],
        ...(usage ? { usage } : {}),
        ...(safety ? { safety } : {}),
    };
}

// --- Build success response ---

export function buildSuccessResponse(
    result: string,
    usage: InvokeUsage,
    safety?: InvokeSafety,
): InvokeResponse {
    return {
        contract_version: CONTRACT_VERSION,
        schema_version: SCHEMA_VERSION,
        status: 'success',
        result,
        usage,
        ...(safety ? { safety } : {}),
    };
}
