import { Ajv, type ValidateFunction } from 'ajv';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolContext, ToolSpec } from './tool-registry.js';
import { ToolRegistry, TIMEOUT_MS } from './tool-registry.js';
import { evaluateShellNetworkAccess, type NetworkPolicy } from '../permissions/network-policy.js';

const OUTPUT_CAP_BYTES = 64 * 1024; // 64 KiB

const ajv = new Ajv({ allErrors: true });

/** Timeout-specific error for clean instanceof detection (replaces magic string sentinel). */
class ToolTimeoutError extends Error {
    constructor(
        readonly toolName: string,
        readonly timeoutMs: number,
    ) {
        super(`Tool "${toolName}" exceeded ${timeoutMs}ms timeout`);
        this.name = 'ToolTimeoutError';
    }
}

/** Sleep for `ms` milliseconds (uses setTimeout so fake timers work). */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Check whether a ToolOutput-shaped value has the required `status` field. */
function isValidToolOutput(value: unknown): value is ToolOutput {
    return (
        typeof value === 'object' &&
        value !== null &&
        'status' in value &&
        (value as Record<string, unknown>).status !== undefined
    );
}

/** Enforce the 64 KiB cap on ToolOutput.data. */
function enforceOutputCap(output: ToolOutput): ToolOutput {
    const dataBytes = Buffer.byteLength(output.data, 'utf8');
    if (dataBytes <= OUTPUT_CAP_BYTES) {
        return output;
    }

    // Truncate to fit within cap. Slice by bytes, not characters.
    // Node.js toString('utf8') replaces incomplete trailing sequences with U+FFFD.
    const buf = Buffer.from(output.data, 'utf8');
    const truncatedData = buf.subarray(0, OUTPUT_CAP_BYTES).toString('utf8');
    const bytesOmitted = dataBytes - OUTPUT_CAP_BYTES;

    return {
        ...output,
        data: truncatedData,
        truncated: true,
        bytesReturned: OUTPUT_CAP_BYTES,
        bytesOmitted: (output.bytesOmitted || 0) + bytesOmitted,
    };
}

/** Build an error ToolOutput. */
function errorOutput(code: string, message: string, details?: Record<string, unknown>): ToolOutput {
    return {
        status: 'error',
        data: '',
        error: { code, message, retryable: false, details },
        truncated: false,
        bytesReturned: 0,
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    };
}

export class ToolRunner {
    private readonly validatorCache = new Map<string, ValidateFunction>();

    constructor(
        private readonly registry: ToolRegistry,
        private readonly networkPolicy?: NetworkPolicy,
    ) {}

    private getValidator(spec: ToolSpec): ValidateFunction {
        let validator = this.validatorCache.get(spec.name);
        if (!validator) {
            validator = ajv.compile(spec.inputSchema);
            this.validatorCache.set(spec.name, validator);
        }
        return validator;
    }

    async execute(
        toolName: string,
        args: Record<string, unknown>,
        context: Omit<ToolContext, 'signal'>,
    ): Promise<ToolOutput> {
        // 1. Look up tool
        const registered = this.registry.lookup(toolName);
        if (!registered) {
            return errorOutput('tool.not_found', `Unknown tool: ${toolName}`);
        }

        const { spec, impl } = registered;

        // 2. Validate args against inputSchema (cached validator)
        const validate = this.getValidator(spec);
        if (!validate(args)) {
            const details: Record<string, unknown> = {};
            if (validate.errors) {
                details.errors = validate.errors.map(e => ({
                    path: e.instancePath || '/',
                    message: e.message,
                    keyword: e.keyword,
                    params: e.params,
                }));
            }
            return errorOutput('tool.validation', 'Input validation failed', details);
        }

        // 3. Network policy check for shell tools
        const networkDenied = this.checkNetworkPolicy(toolName, args, context);
        if (networkDenied) return networkDenied;

        // 4. Set up timeout + retry logic
        const timeoutMs = TIMEOUT_MS[spec.timeoutCategory];
        const maxAttempts = spec.idempotent ? 3 : 1;
        let lastOutput: ToolOutput | undefined;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (attempt > 0) {
                // Exponential backoff with full jitter: random(0, base * 2^(attempt-1))
                const baseDelay = 250 * Math.pow(2, attempt - 1);
                const delayMs = Math.floor(Math.random() * baseDelay);
                await sleep(delayMs);
            }

            // Fresh AbortController per attempt (AbortController is one-shot)
            const controller = new AbortController();
            const toolContext: ToolContext = {
                ...context,
                signal: controller.signal,
            };

            lastOutput = await this.executeOnce(impl, args, toolContext, controller, timeoutMs, spec);

            // If success or non-retryable error, stop retrying
            if (lastOutput.status === 'success' || !lastOutput.retryable) {
                break;
            }
        }

        return lastOutput!;
    }

    /** Check shell commands against network policy. Returns error output on deny, null otherwise. */
    private checkNetworkPolicy(
        toolName: string,
        args: Record<string, unknown>,
        context: Omit<ToolContext, 'signal'>,
    ): ToolOutput | null {
        if (!this.networkPolicy) return null;

        let command: string | undefined;
        if (toolName === 'exec_command' || toolName === 'open_session') {
            command = typeof args.command === 'string' ? args.command : undefined;
        } else if (toolName === 'session_io') {
            command = typeof args.stdin === 'string' ? args.stdin : undefined;
        }

        if (!command || command.length === 0) return null;

        const result = evaluateShellNetworkAccess(command, this.networkPolicy);
        if (result && result.decision === 'deny') {
            return errorOutput('network.denied', result.reason, { facet: result.facet });
        }
        if (result && result.decision === 'confirm' && !context.networkApproved) {
            return errorOutput('network.confirm_required', result.reason, { facet: result.facet });
        }

        return null;
    }

    private async executeOnce(
        impl: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>,
        args: Record<string, unknown>,
        context: ToolContext,
        controller: AbortController,
        timeoutMs: number,
        spec: ToolSpec,
    ): Promise<ToolOutput> {
        // Race tool execution against timeout
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        try {
            const result = await (timeoutMs === Infinity
                ? impl(args, context)
                : Promise.race([
                      impl(args, context),
                      new Promise<ToolOutput>((_, reject) => {
                          timeoutId = setTimeout(() => {
                              controller.abort();
                              reject(new ToolTimeoutError(spec.name, timeoutMs));
                          }, timeoutMs);
                      }),
                  ]));

            // 5. Validate output envelope
            if (!isValidToolOutput(result)) {
                return errorOutput(
                    'tool.contract_violation',
                    'Tool returned malformed output: missing required "status" field',
                );
            }

            // 6. Enforce 64 KiB output cap
            return enforceOutputCap(result);
        } catch (err: unknown) {
            // Timeout
            if (err instanceof ToolTimeoutError) {
                const isMutation = spec.approvalClass !== 'read-only';
                return {
                    status: 'error',
                    data: '',
                    error: {
                        code: 'tool.timeout',
                        message: `Tool "${spec.name}" exceeded ${timeoutMs}ms timeout`,
                        retryable: false,
                    },
                    truncated: false,
                    bytesReturned: 0,
                    bytesOmitted: 0,
                    retryable: false,
                    timedOut: true,
                    mutationState: isMutation ? 'indeterminate' : 'none',
                };
            }

            // Tool threw an exception. If this is a mutating tool (workspace-write
            // or external-effect), the workspace may now be in an unknown state —
            // the tool may have performed partial writes before crashing. Mirror
            // the tool.timeout handling and report mutationState='indeterminate'
            // so the TurnEngine's safety check terminates the turn instead of
            // letting the model continue against a possibly-corrupted workspace.
            const message = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? err.stack : undefined;
            const isMutation = spec.approvalClass !== 'read-only';
            return {
                status: 'error',
                data: '',
                error: {
                    code: 'tool.crash',
                    message: `Tool threw an exception: ${message}`,
                    retryable: false,
                    details: { stack },
                },
                truncated: false,
                bytesReturned: 0,
                bytesOmitted: 0,
                retryable: false,
                timedOut: false,
                mutationState: isMutation ? 'indeterminate' : 'none',
            };
        } finally {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
        }
    }
}
