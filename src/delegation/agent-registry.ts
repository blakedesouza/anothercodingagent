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

/** Built-in delegation tools. Delegating profiles include these even if the runtime registers them later. */
export const DELEGATION_TOOL_NAMES = ['spawn_agent', 'message_agent', 'await_agent'] as const;

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
 * Built-in RP lore researcher/writer profile.
 * Researches anime/manga/VN canon and writes bounded Markdown lore docs in the
 * user's RP project style. It intentionally excludes shell execution, arbitrary
 * edits/deletes, and delegation; orchestration assigns exact output paths.
 */
const RP_RESEARCHER_TOOLS: readonly string[] = [
    'read_file', 'find_paths', 'search_text',
    'fetch_url', 'fetch_mediawiki_page', 'fetch_mediawiki_category', 'web_search',
    'make_directory', 'write_file',
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
    const resolved = new Set(
        toolRegistry.list()
        .filter(t => GENERAL_APPROVAL_CLASSES.has(t.spec.approvalClass))
        .map(t => t.spec.name)
    );
    for (const toolName of DELEGATION_TOOL_NAMES) {
        resolved.add(toolName);
    }
    return [...resolved].sort();
}

/**
 * Compute the coder profile's tool list: all registered tools except user-facing.
 * Coder is a delegating profile, so it retains the built-in delegation tools.
 * Safety comes from the sandbox (workspace boundaries) and deadline, not tool restrictions.
 */
function resolveCoderTools(toolRegistry: ToolRegistry): string[] {
    const resolved = new Set(
        toolRegistry.list()
            .filter(t => !USER_FACING_TOOLS.has(t.spec.name))
            .map(t => t.spec.name),
    );
    for (const toolName of DELEGATION_TOOL_NAMES) {
        resolved.add(toolName);
    }
    return [...resolved].sort();
}

function buildBuiltInProfiles(toolRegistry: ToolRegistry): AgentProfile[] {
    return [
        {
            name: 'general',
            systemPrompt: 'You are a flexible sub-agent. Complete the assigned task using the tools available to you.',
            defaultTools: resolveGeneralTools(toolRegistry),
            canDelegate: true,
            promptTier: 'agentic',
        },
        {
            name: 'researcher',
            systemPrompt: 'You are a research agent. Search, read, synthesize information, and run analysis commands. Focus on investigation, not modification.',
            defaultTools: RESEARCHER_TOOLS,
            canDelegate: false,
            promptTier: 'analytical',
        },
        {
            name: 'rp-researcher',
            systemPrompt: [
                'You are an RP lore research writer for the caller-selected project directory.',
                'When web_search is configured and available, use it for broad discovery first; if web_search is unavailable or unconfigured in this run, do not keep retrying it and pivot immediately to direct source fetches.',
                'For Fandom or MediaWiki-backed sources, prefer fetch_mediawiki_page and fetch_mediawiki_category against api.php over fetch_url. Use fetch_url only when you specifically need a non-MediaWiki page or rendered HTML that the MediaWiki API will not provide.',
                'When calling fetch_mediawiki_category, pass numeric limits such as limit: 25 or limit: 50, not quoted strings, and only probe category names you have evidence for.',
                'Inspect existing RP docs with read_file/find_paths/search_text and match the project style from fruits-of-grisaia, fate-stay-night, jjk, and shapeshifter-academy.',
                'Write grounded, in-depth Markdown lore docs, not shallow roster summaries or exhaustive wiki dumps.',
                'For RP-facing compendiums, use world/character/<character>.md or world/characters/<character>.md for character files and world/ for setting/rules/group files unless the task explicitly assigns a different layout. Use research/ for source briefs, character research notes, raw notes, or audit material, not final RP-facing files.',
                'Use make_directory/write_file only for exact output paths assigned by the orchestrator.',
                'Use a dynamic sequential workflow for broad compendiums: discovery pass for categories/candidate pages and exact output paths, then one deep research/write invocation per character or world file.',
                'Discovery passes should enumerate candidate characters, groups, locations, episodes, and setting topics first; do not write final docs during discovery.',
                'For discovery passes, stop once you have enough source-grounded evidence to name the important files, candidate pages, and exact output paths. Do not spend the whole run chasing every linked character or terminology page in the franchise.',
                'On RP discovery or write tasks, your FIRST assistant message must include actual tool calls. A text-only first message is an invalid completion.',
                'For discovery or source-brief tasks, do not end with "I\'ll research", "let me start", or any other plan-only/intention-only text. Use the research/style tools first, then return a source-grounded Markdown brief with concrete source notes, candidate files, and exact output paths.',
                'Do not output sentences like "I\'ll start by reading the local reference files..." unless that same assistant message also contains the corresponding tool calls.',
                'If the assigned file still does not exist, do not output interim status text like "need to try subcategories" or "let me also fetch...". Make the next tool calls in that same assistant message or write the file.',
                'If a tool comes back unavailable, unconfigured, or validation-failed, switch to the next viable source/tool path instead of burning steps on near-identical retries.',
                'If the task says not to write files yet, still complete the research pass with tools and return the sourced Markdown brief directly; do not stop at a promise to research later.',
                'For character work, research one assigned character deeply and write exactly that character Markdown file in the same invocation; do not produce a compact whole-series source brief first.',
                'Use middle-ground depth ceilings for character files: up to 16-20 KB for main characters, 8-12 KB for side characters, and 4-8 KB for minor/supporting characters unless the task overrides the ceiling. These are ceilings, not floors: do not pad sparse characters when canon material does not support that length.',
                'Keep Relationships compact: include only important dynamics, usually 3-6 entries for side characters or up to 8 for main characters, and write 1-2 sentences per relationship. Put complex group dynamics in world/trinity-seven.md, world/groups.md, or an equivalent world file instead of expanding every character file.',
                'For world work, research one assigned world topic deeply and write exactly that assigned world Markdown file in the same invocation.',
                'Do not collapse character groups into one file when members are individually important; the orchestrator should give each important character a dedicated agent and output path.',
                'When the cast or file plan is unknown, discover the cast/topic list first from series-level sources, then propose or use exact Markdown output paths; do not collapse character groups into one file when members are individually important.',
                'Do not spend the whole tool budget on unbounded exploration across the franchise; stay on the assigned character or world topic and write the file once that target is covered.',
                'For explicitly trusted long-context research models, larger bounded budgets are acceptable, but the task must still have an exact assigned output path and required-output validation.',
                'Do not create per-character instructions.md files unless explicitly assigned.',
                'Do not include Japanese script or unnecessary Japanese terminology by default; use English or already-common romanized names. Only include original-language text when it is part of an ability/skill/magic name that cannot be disambiguated cleanly in English, or when the task explicitly asks for original-language text.',
                'Do not invent mandatory sections like "RP Use", "RP Notes", "Knowledge and Secrets", "Spoiler Notes", or "Current Status". Use simple headings only when they fit the specific character or topic.',
                'Put broad setting and narrator constraints in world/world-rules.md, not repeated in every character file.',
                'Avoid over-exposing hidden traits in a way that would make the narrator repeat them every scene.',
                'Write Markdown only.',
            ].join(' '),
            defaultTools: RP_RESEARCHER_TOOLS,
            canDelegate: false,
            promptTier: 'agentic',
        },
        {
            name: 'coder',
            systemPrompt: 'You are a coding agent. Write code, run tests, and fix bugs to complete the assigned task.',
            defaultTools: resolveCoderTools(toolRegistry),
            canDelegate: true,
            promptTier: 'agentic',
        },
        {
            name: 'reviewer',
            systemPrompt: 'You are a code review agent. Analyze code, find issues, and suggest fixes. Use tools to run verification commands (tests, linters, grep), inspect types via lsp_query, and research API/library claims against real docs. Do not modify files — report findings, do not implement fixes.',
            defaultTools: REVIEWER_TOOLS,
            canDelegate: false,
            promptTier: 'analytical',
        },
        {
            name: 'witness',
            systemPrompt: 'You are a witness review agent. Use your tools to read and search the actual source code, run verification commands (tests, linters, grep), and cross-check API/library claims against real documentation. Provide a grounded code review with specific file paths, line numbers, and evidence from the codebase and from any commands you ran. Do not modify files — your role is to observe and report, not to implement fixes.',
            defaultTools: WITNESS_TOOLS,
            canDelegate: false,
            promptTier: 'analytical',
        },
        {
            name: 'triage',
            systemPrompt: 'You are a triage aggregator for a multi-witness code review. Input: multiple witness reports on the same codebase. Output: a single deduplicated, severity-ranked JSON report. Prefer aggregating from the witness bundle directly; use tools only for high-severity, disputed, vague, or API/library claims that materially need verification. Your job is NOT to re-review the code from scratch — it is to dedupe, calibrate severity, and flag dissent. Do not modify files.',
            defaultTools: TRIAGE_TOOLS,
            canDelegate: false,
            promptTier: 'analytical',
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
