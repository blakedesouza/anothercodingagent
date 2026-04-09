import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolOutput } from '../../src/types/conversation.js';
import {
    ToolRegistry,
    type ToolSpec,
    type ToolImplementation,
} from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

// --- Helpers ---

function makeSpec(overrides: Partial<ToolSpec> = {}): ToolSpec {
    return {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
            },
            required: ['path'],
            additionalProperties: false,
        },
        approvalClass: 'read-only',
        idempotent: true,
        timeoutCategory: 'file',
        ...overrides,
    };
}

function makeOutput(overrides: Partial<ToolOutput> = {}): ToolOutput {
    return {
        status: 'success',
        data: 'hello',
        truncated: false,
        bytesReturned: 5,
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
        ...overrides,
    };
}

const baseContext = { sessionId: 'ses_test', workspaceRoot: '/tmp/test' };

// --- ToolRegistry ---

describe('ToolRegistry', () => {
    let registry: ToolRegistry;

    beforeEach(() => {
        registry = new ToolRegistry();
    });

    it('registers a tool and looks it up by name', () => {
        const spec = makeSpec();
        const impl: ToolImplementation = async () => makeOutput();
        registry.register(spec, impl);

        const found = registry.lookup('test_tool');
        expect(found).toBeDefined();
        expect(found!.spec.name).toBe('test_tool');
        expect(found!.impl).toBe(impl);
    });

    it('returns undefined for nonexistent tool', () => {
        expect(registry.lookup('no_such_tool')).toBeUndefined();
    });

    it('lists all registered tools', () => {
        const impl: ToolImplementation = async () => makeOutput();
        registry.register(makeSpec({ name: 'tool_a' }), impl);
        registry.register(makeSpec({ name: 'tool_b' }), impl);

        const all = registry.list();
        expect(all).toHaveLength(2);
        expect(all.map(t => t.spec.name).sort()).toEqual(['tool_a', 'tool_b']);
    });

    it('throws on duplicate registration', () => {
        const impl: ToolImplementation = async () => makeOutput();
        registry.register(makeSpec(), impl);
        expect(() => registry.register(makeSpec(), impl)).toThrow('Tool already registered');
    });
});

// --- ToolRunner ---

describe('ToolRunner', () => {
    let registry: ToolRegistry;
    let runner: ToolRunner;

    beforeEach(() => {
        registry = new ToolRegistry();
        runner = new ToolRunner(registry);
    });

    it('executes a tool with valid args and returns ToolOutput', async () => {
        const impl: ToolImplementation = async (args) => makeOutput({ data: `read ${args.path}` });
        registry.register(makeSpec(), impl);

        const result = await runner.execute('test_tool', { path: '/foo.txt' }, baseContext);
        expect(result.status).toBe('success');
        expect(result.data).toBe('read /foo.txt');
    });

    it('returns validation error for missing required field', async () => {
        const impl: ToolImplementation = async () => makeOutput();
        registry.register(makeSpec(), impl);

        const result = await runner.execute('test_tool', {}, baseContext);
        expect(result.status).toBe('error');
        expect(result.error!.code).toBe('tool.validation');
    });

    it('returns validation error with details for wrong type', async () => {
        const impl: ToolImplementation = async () => makeOutput();
        registry.register(makeSpec(), impl);

        const result = await runner.execute('test_tool', { path: 42 }, baseContext);
        expect(result.status).toBe('error');
        expect(result.error!.code).toBe('tool.validation');

        const details = result.error!.details as { errors: Array<{ path: string; keyword: string }> };
        expect(details.errors).toBeDefined();
        expect(details.errors.length).toBeGreaterThan(0);
        // Should mention the field path and the type constraint
        const pathError = details.errors.find(e => e.path === '/path');
        expect(pathError).toBeDefined();
        expect(pathError!.keyword).toBe('type');
    });

    it('does not execute tool when validation fails', async () => {
        const impl = vi.fn(async () => makeOutput());
        registry.register(makeSpec(), impl);

        await runner.execute('test_tool', {}, baseContext);
        expect(impl).not.toHaveBeenCalled();
    });

    it('returns not_found error for unknown tool', async () => {
        const result = await runner.execute('no_such_tool', {}, baseContext);
        expect(result.status).toBe('error');
        expect(result.error!.code).toBe('tool.not_found');
    });

    it('truncates output exceeding 64 KiB', async () => {
        const bigData = 'x'.repeat(80 * 1024); // 80 KiB
        const impl: ToolImplementation = async () => makeOutput({
            data: bigData,
            bytesReturned: Buffer.byteLength(bigData),
        });
        registry.register(makeSpec(), impl);

        const result = await runner.execute('test_tool', { path: '/foo' }, baseContext);
        expect(result.status).toBe('success');
        expect(result.truncated).toBe(true);
        expect(result.bytesReturned).toBe(64 * 1024);
        expect(result.bytesOmitted).toBe(80 * 1024 - 64 * 1024);
        expect(Buffer.byteLength(result.data, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    });

    it('returns timeout error when tool exceeds timeout', async () => {
        const impl: ToolImplementation = async (_args, ctx) => {
            // Simulate a long-running tool
            await new Promise((resolve, reject) => {
                const id = setTimeout(resolve, 60_000);
                ctx.signal.addEventListener('abort', () => {
                    clearTimeout(id);
                    reject(new Error('aborted'));
                });
            });
            return makeOutput();
        };
        registry.register(makeSpec({ timeoutCategory: 'file' }), impl); // 5s timeout

        vi.useFakeTimers();
        const promise = runner.execute('test_tool', { path: '/foo' }, baseContext);
        // Advance past the 5s timeout
        await vi.advanceTimersByTimeAsync(5_001);
        const result = await promise;
        vi.useRealTimers();

        expect(result.status).toBe('error');
        expect(result.error!.code).toBe('tool.timeout');
        expect(result.timedOut).toBe(true);
        expect(result.mutationState).toBe('none'); // read-only tool
    });

    it('sets mutationState to indeterminate on timeout for mutation tools', async () => {
        const impl: ToolImplementation = async (_args, ctx) => {
            await new Promise((resolve, reject) => {
                const id = setTimeout(resolve, 60_000);
                ctx.signal.addEventListener('abort', () => {
                    clearTimeout(id);
                    reject(new Error('aborted'));
                });
            });
            return makeOutput();
        };
        registry.register(makeSpec({
            approvalClass: 'workspace-write',
            idempotent: false,
            timeoutCategory: 'file',
        }), impl);

        vi.useFakeTimers();
        const promise = runner.execute('test_tool', { path: '/foo' }, baseContext);
        await vi.advanceTimersByTimeAsync(5_001);
        const result = await promise;
        vi.useRealTimers();

        expect(result.status).toBe('error');
        expect(result.timedOut).toBe(true);
        expect(result.mutationState).toBe('indeterminate');
    });

    it('returns contract_violation for malformed output (missing status)', async () => {
        const impl: ToolImplementation = async () => {
            // Return something that's not a valid ToolOutput
            return { data: 'hello' } as unknown as ToolOutput;
        };
        registry.register(makeSpec(), impl);

        const result = await runner.execute('test_tool', { path: '/foo' }, baseContext);
        expect(result.status).toBe('error');
        expect(result.error!.code).toBe('tool.contract_violation');
    });

    it('returns crash error when tool throws an exception', async () => {
        const impl: ToolImplementation = async () => {
            throw new Error('Disk on fire');
        };
        registry.register(makeSpec(), impl);

        const result = await runner.execute('test_tool', { path: '/foo' }, baseContext);
        expect(result.status).toBe('error');
        expect(result.error!.code).toBe('tool.crash');
        expect(result.error!.message).toContain('Disk on fire');
    });

    it('blocks approved-only shell network commands until network approval is present', async () => {
        const impl = vi.fn(async () => makeOutput());
        registry.register(
            makeSpec({
                name: 'exec_command',
                approvalClass: 'external-effect',
                idempotent: false,
                timeoutCategory: 'shell',
                inputSchema: {
                    type: 'object',
                    properties: {
                        command: { type: 'string' },
                    },
                    required: ['command'],
                    additionalProperties: false,
                },
            }),
            impl,
        );

        const networkRunner = new ToolRunner(registry, {
            mode: 'approved-only',
            allowDomains: [],
            denyDomains: [],
            allowHttp: false,
        });

        const blocked = await networkRunner.execute(
            'exec_command',
            { command: 'curl https://example.com' },
            baseContext,
        );
        expect(blocked.status).toBe('error');
        expect(blocked.error!.code).toBe('network.confirm_required');
        expect(impl).not.toHaveBeenCalled();

        const approved = await networkRunner.execute(
            'exec_command',
            { command: 'curl https://example.com' },
            { ...baseContext, networkApproved: true },
        );
        expect(approved.status).toBe('success');
        expect(impl).toHaveBeenCalledTimes(1);
    });

    // M10.1c: tool.crash on a mutating tool must report mutationState='indeterminate'
    // so the TurnEngine's safety check (the only remaining fatal tool-layer check)
    // terminates the turn instead of letting the model continue against a possibly
    // corrupted workspace.
    it('tool.crash on a mutating tool reports mutationState=indeterminate', async () => {
        const impl: ToolImplementation = async () => {
            throw new Error('Crash mid-write');
        };
        registry.register(makeSpec({
            name: 'mutating_crash',
            approvalClass: 'workspace-write',
        }), impl);

        const result = await runner.execute('mutating_crash', { path: '/foo' }, baseContext);
        expect(result.status).toBe('error');
        expect(result.error!.code).toBe('tool.crash');
        expect(result.mutationState).toBe('indeterminate');
    });

    it('tool.crash on a read-only tool reports mutationState=none', async () => {
        const impl: ToolImplementation = async () => {
            throw new Error('Read crash');
        };
        registry.register(makeSpec({
            name: 'readonly_crash',
            approvalClass: 'read-only',
        }), impl);

        const result = await runner.execute('readonly_crash', { path: '/foo' }, baseContext);
        expect(result.status).toBe('error');
        expect(result.error!.code).toBe('tool.crash');
        expect(result.mutationState).toBe('none');
    });

    describe('retry logic', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('retries idempotent tool 3 times with exponential backoff on transient error', async () => {
            const calls: number[] = [];
            const impl: ToolImplementation = async () => {
                calls.push(Date.now());
                return makeOutput({ status: 'error', retryable: true, error: {
                    code: 'tool.transient', message: 'Temporary failure', retryable: true,
                }});
            };
            registry.register(makeSpec({ idempotent: true }), impl);

            vi.useFakeTimers();
            const promise = runner.execute('test_tool', { path: '/foo' }, baseContext);

            // Attempt 1: immediate
            await vi.advanceTimersByTimeAsync(0);
            // Attempt 2: after 250ms backoff
            await vi.advanceTimersByTimeAsync(250);
            // Attempt 3: after 500ms backoff
            await vi.advanceTimersByTimeAsync(500);

            const result = await promise;
            expect(calls).toHaveLength(3);
            expect(result.status).toBe('error');
            expect(result.retryable).toBe(true);
        });

        it('returns success on second attempt when idempotent tool recovers', async () => {
            let callCount = 0;
            const impl: ToolImplementation = async () => {
                callCount++;
                if (callCount === 1) {
                    return makeOutput({ status: 'error', retryable: true, error: {
                        code: 'tool.transient', message: '503 Service Unavailable', retryable: true,
                    }});
                }
                return makeOutput({ data: 'recovered' });
            };
            registry.register(makeSpec({ idempotent: true }), impl);

            vi.useFakeTimers();
            const promise = runner.execute('test_tool', { path: '/foo' }, baseContext);

            // Attempt 1: immediate
            await vi.advanceTimersByTimeAsync(0);
            // Attempt 2: after 250ms backoff
            await vi.advanceTimersByTimeAsync(250);

            const result = await promise;
            expect(callCount).toBe(2);
            expect(result.status).toBe('success');
            expect(result.data).toBe('recovered');
        });

        it('does not retry non-idempotent tool on transient error', async () => {
            let callCount = 0;
            const impl: ToolImplementation = async () => {
                callCount++;
                return makeOutput({ status: 'error', retryable: true, error: {
                    code: 'tool.transient', message: 'Temporary failure', retryable: true,
                }});
            };
            registry.register(makeSpec({ idempotent: false }), impl);

            const result = await runner.execute('test_tool', { path: '/foo' }, baseContext);
            expect(callCount).toBe(1);
            expect(result.status).toBe('error');
        });
    });
});
