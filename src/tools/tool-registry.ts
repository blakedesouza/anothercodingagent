import type { ToolOutput } from '../types/conversation.js';

// --- Approval & timeout categories (Block 15, Block 8) ---

export type ApprovalClass = 'read-only' | 'workspace-write' | 'external-effect' | 'user-facing';

export type TimeoutCategory = 'file' | 'lsp' | 'web' | 'network' | 'shell' | 'delegation' | 'compute' | 'user';

/** Timeout durations in milliseconds, keyed by category. */
export const TIMEOUT_MS: Record<TimeoutCategory, number> = {
    file: 5_000,
    lsp: 10_000,
    web: 15_000,
    network: 30_000,
    shell: 60_000,
    delegation: 120_000,
    compute: 120_000,
    user: Infinity,
};

// --- Tool definition types ---

/**
 * Internal tool specification — richer than the LLM-facing ToolDefinition
 * in provider.ts. Carries approval class, idempotency, and timeout metadata.
 */
export interface ToolSpec {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    approvalClass: ApprovalClass;
    idempotent: boolean;
    timeoutCategory: TimeoutCategory;
    /** Capability ID this tool depends on (e.g., 'lsp:ts', 'browser'). When the capability is unavailable, the tool is masked from LLM definitions. */
    capabilityId?: string;
}

/** Context passed to tool implementations at execution time. */
export interface ToolContext {
    sessionId: string;
    workspaceRoot: string;
    signal: AbortSignal;
    /** Whether a TTY is available for user interaction. Default: true. */
    interactive?: boolean;
    /** When true, confirm_action auto-approves (--no-confirm flag). Default: false. */
    autoConfirm?: boolean;
    /** Whether this tool call is executing inside a sub-agent. Default: false. */
    isSubAgent?: boolean;
    /** Injected function for prompting the user. Required for ask_user/confirm_action in interactive mode. */
    promptUser?: (question: string, choices?: string[]) => Promise<string>;
    /** Additional trusted filesystem roots beyond workspace, session dir, and scoped tmp. From user config only. */
    extraTrustedRoots?: string[];
    /** True when this specific tool call already cleared a network-policy confirmation gate. */
    networkApproved?: boolean;
}

/** The function signature every tool implementation must satisfy. */
export type ToolImplementation = (
    args: Record<string, unknown>,
    context: ToolContext,
) => Promise<ToolOutput>;

/** A registered tool = spec + implementation. */
export interface RegisteredTool {
    spec: ToolSpec;
    impl: ToolImplementation;
}

// --- Registry ---

export class ToolRegistry {
    private readonly tools = new Map<string, RegisteredTool>();

    /** Register a tool. Throws if a tool with the same name is already registered. */
    register(spec: ToolSpec, impl: ToolImplementation): void {
        if (this.tools.has(spec.name)) {
            throw new Error(`Tool already registered: ${spec.name}`);
        }
        this.tools.set(spec.name, { spec, impl });
    }

    /** Look up a tool by name. Returns undefined if not found. */
    lookup(name: string): RegisteredTool | undefined {
        return this.tools.get(name);
    }

    /** List all registered tools. */
    list(): RegisteredTool[] {
        return Array.from(this.tools.values());
    }
}
