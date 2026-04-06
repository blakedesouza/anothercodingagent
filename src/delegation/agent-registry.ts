/**
 * AgentRegistry — static registry of agent profiles for the delegation system.
 *
 * Resolved once at session start from built-in profiles plus any additional
 * profiles in project config. Frozen for the session lifetime.
 *
 * Block 2: Pluggable Delegation
 */

import type { AgentProfile } from '../types/agent.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

// --- Built-in profile definitions ---

/** Delegation tools — excluded from all non-general profiles to prevent recursive spawning. */
const DELEGATION_TOOLS = new Set(['spawn_agent', 'message_agent', 'await_agent']);

/** User-facing tools — only meaningful in interactive parent context, not sub-agents. */
const USER_FACING_TOOLS = new Set(['ask_user', 'confirm_action']);

/**
 * Built-in researcher profile tools.
 * Deep research: searches, reads, synthesizes, browses. No file writes.
 */
const RESEARCHER_TOOLS: readonly string[] = [
    'read_file', 'find_paths', 'search_text', 'search_semantic',
    'stat_path', 'estimate_tokens', 'lsp_query',
    'fetch_url', 'web_search', 'lookup_docs',
    'exec_command',
] as const;

/**
 * Built-in reviewer profile tools.
 * Code review: non-mutating tools + exec_command for running tests/linters/grep during analysis.
 * Expanded 2026-04-06: added exec_command so reviewers can verify claims by running tests and
 * investigation commands. Still excludes write/edit/delete — reviewers observe, coders act.
 */
const REVIEWER_TOOLS: readonly string[] = [
    'read_file', 'find_paths', 'search_text', 'search_semantic',
    'stat_path', 'estimate_tokens', 'lsp_query',
    'fetch_url', 'web_search', 'lookup_docs',
    'exec_command',
] as const;

/**
 * Built-in witness profile tools.
 * Grounded code review: non-mutating tools + exec_command for running tests/linters/grep during
 * consultation. Expanded 2026-04-06 to match reviewer — witnesses need to run verification
 * commands (npm test, tsc, grep, wc, git blame) to ground their findings in evidence, not just
 * static reads. Still excludes write/edit/delete — review integrity requires witnesses observe
 * rather than mutate what they're reviewing.
 */
const WITNESS_TOOLS: readonly string[] = [
    'read_file', 'find_paths', 'search_text', 'search_semantic',
    'stat_path', 'estimate_tokens', 'lsp_query',
    'fetch_url', 'web_search', 'lookup_docs',
    'exec_command',
] as const;

/**
 * Built-in triage profile tools.
 * Aggregation / watchdog role: dedupes and ranks multiple witness findings, verifies individual
 * claims only when needed, and avoids re-reviewing from scratch. The default grant is narrower
 * than witness: no shell commands, LSP, semantic search, or token estimation.
 */
const TRIAGE_TOOLS: readonly string[] = [
    'read_file', 'find_paths', 'search_text', 'stat_path',
    'fetch_url', 'web_search', 'lookup_docs',
] as const;

/**
 * Approval classes that qualify a tool for the general profile.
 * General gets all read-only + workspace-write tools.
 */
const GENERAL_APPROVAL_CLASSES = new Set(['read-only', 'workspace-write']);

/**
 * Compute the general profile's tool list from registered tools.
 * Includes all tools with read-only or workspace-write approval class.
 */
function resolveGeneralTools(toolRegistry: ToolRegistry): string[] {
    return toolRegistry.list()
        .filter(t => GENERAL_APPROVAL_CLASSES.has(t.spec.approvalClass))
        .map(t => t.spec.name)
        .sort();
}

/**
 * Compute the coder profile's tool list: all registered tools except delegation and user-facing.
 * Safety comes from the sandbox (workspace boundaries) and deadline, not tool restrictions.
 */
function resolveCoderTools(toolRegistry: ToolRegistry): string[] {
    return toolRegistry.list()
        .filter(t => !DELEGATION_TOOLS.has(t.spec.name) && !USER_FACING_TOOLS.has(t.spec.name))
        .map(t => t.spec.name)
        .sort();
}

function buildBuiltInProfiles(toolRegistry: ToolRegistry): AgentProfile[] {
    return [
        {
            name: 'general',
            systemPrompt: 'You are a flexible sub-agent. Complete the assigned task using the tools available to you.',
            defaultTools: resolveGeneralTools(toolRegistry),
            canDelegate: true,
        },
        {
            name: 'researcher',
            systemPrompt: 'You are a research agent. Search, read, synthesize information, and run analysis commands. Focus on investigation, not modification.',
            defaultTools: RESEARCHER_TOOLS,
            canDelegate: false,
        },
        {
            name: 'coder',
            systemPrompt: 'You are a coding agent. Write code, run tests, and fix bugs to complete the assigned task.',
            defaultTools: resolveCoderTools(toolRegistry),
            canDelegate: true,
        },
        {
            name: 'reviewer',
            systemPrompt: 'You are a code review agent. Analyze code, find issues, and suggest fixes. Use tools to run verification commands (tests, linters, grep), inspect types via lsp_query, and research API/library claims against real docs. Do not modify files — report findings, do not implement fixes.',
            defaultTools: REVIEWER_TOOLS,
            canDelegate: false,
        },
        {
            name: 'witness',
            systemPrompt: 'You are a witness review agent. Use your tools to read and search the actual source code, run verification commands (tests, linters, grep), and cross-check API/library claims against real documentation. Provide a grounded code review with specific file paths, line numbers, and evidence from the codebase and from any commands you ran. Do not modify files — your role is to observe and report, not to implement fixes.',
            defaultTools: WITNESS_TOOLS,
            canDelegate: false,
        },
        {
            name: 'triage',
            systemPrompt: 'You are a triage aggregator for a multi-witness code review. Input: multiple witness reports on the same codebase. Output: a single deduplicated, severity-ranked JSON report. Prefer aggregating from the witness bundle directly; use tools only for high-severity, disputed, vague, or API/library claims that materially need verification. Your job is NOT to re-review the code from scratch — it is to dedupe, calibrate severity, and flag dissent. Do not modify files.',
            defaultTools: TRIAGE_TOOLS,
            canDelegate: false,
        },
    ];
}

/**
 * Deep-freeze a profile: freezes both the profile object and its defaultTools array.
 * Prevents runtime mutation of shared constant arrays (RESEARCHER_TOOLS, etc.).
 */
function deepFreezeProfile(profile: AgentProfile): Readonly<AgentProfile> {
    const frozen = {
        ...profile,
        defaultTools: Object.freeze([...profile.defaultTools]),
    };
    return Object.freeze(frozen);
}

/**
 * Validate a project-config profile has required fields.
 * Returns null if valid, or an error message if invalid.
 */
function validateProjectProfile(profile: AgentProfile): string | null {
    if (!profile.name || typeof profile.name !== 'string') {
        return 'profile missing or invalid name';
    }
    if (!profile.systemPrompt || typeof profile.systemPrompt !== 'string') {
        return `profile "${profile.name}": missing or invalid systemPrompt`;
    }
    if (!Array.isArray(profile.defaultTools) || profile.defaultTools.length === 0) {
        return `profile "${profile.name}": defaultTools must be a non-empty array`;
    }
    return null;
}

// --- Narrowing validation ---

export interface NarrowingResult {
    valid: boolean;
    /** Tools that were requested but are not in the profile's default set. */
    rejected: string[];
}

/**
 * Validate that override tools are a subset of the profile's defaults.
 * Returns which tools were rejected (not in the profile).
 */
function validateNarrowing(profile: AgentProfile, overrideTools: string[]): NarrowingResult {
    const allowed = new Set(profile.defaultTools);
    const rejected = overrideTools.filter(t => !allowed.has(t));
    return { valid: rejected.length === 0, rejected };
}

// --- AgentRegistry ---

export interface RegistryResolveResult {
    registry: AgentRegistry;
    warnings: string[];
}

export class AgentRegistry {
    private readonly profiles: ReadonlyMap<string, Readonly<AgentProfile>>;

    private constructor(profiles: Map<string, Readonly<AgentProfile>>) {
        this.profiles = profiles;
    }

    /**
     * Resolve the registry from built-in profiles, the tool registry, and
     * optional project-config profiles. The returned registry is immutable.
     *
     * Project-config profiles are added alongside built-ins. If a project
     * profile has the same name as a built-in, it is warned and skipped.
     * Invalid project profiles are warned and skipped.
     */
    static resolve(
        toolRegistry: ToolRegistry,
        projectProfiles?: AgentProfile[],
    ): RegistryResolveResult {
        const map = new Map<string, Readonly<AgentProfile>>();
        const warnings: string[] = [];

        // Register built-ins (deep-frozen to protect shared constant arrays)
        for (const profile of buildBuiltInProfiles(toolRegistry)) {
            map.set(profile.name, deepFreezeProfile(profile));
        }

        // Register project-config profiles (additive, cannot shadow built-ins)
        if (projectProfiles) {
            for (const profile of projectProfiles) {
                if (map.has(profile.name)) {
                    warnings.push(
                        `Project profile "${profile.name}" shadows a built-in profile and was skipped`,
                    );
                    continue;
                }
                const validationError = validateProjectProfile(profile);
                if (validationError) {
                    warnings.push(`Project profile skipped: ${validationError}`);
                    continue;
                }
                map.set(profile.name, deepFreezeProfile(profile));
            }
        }

        return { registry: new AgentRegistry(map), warnings };
    }

    /** Look up a profile by name. Returns undefined if not found. */
    getProfile(name: string): Readonly<AgentProfile> | undefined {
        return this.profiles.get(name);
    }

    /** List all registered profiles. */
    listProfiles(): readonly AgentProfile[] {
        return Array.from(this.profiles.values());
    }

    /** Get profile names (for spawn_agent enum and context manifest). */
    getProfileNames(): string[] {
        return Array.from(this.profiles.keys());
    }

    /**
     * Validate that a set of override tools only narrows what a profile grants.
     * Used by spawn_agent to enforce narrowing-only overrides.
     *
     * @returns valid=true if all overrideTools are in the profile's defaultTools,
     *          otherwise valid=false with the rejected tool names.
     */
    validateToolNarrowing(profileName: string, overrideTools: string[]): NarrowingResult {
        const profile = this.profiles.get(profileName);
        if (!profile) {
            return { valid: false, rejected: overrideTools };
        }
        return validateNarrowing(profile, overrideTools);
    }

    /**
     * Check whether a profile permits delegation (spawn_agent).
     */
    canDelegate(profileName: string): boolean {
        const profile = this.profiles.get(profileName);
        return profile?.canDelegate ?? false;
    }
}
