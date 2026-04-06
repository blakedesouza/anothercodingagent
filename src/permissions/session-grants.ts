/**
 * Session Grant Store — runtime approval grants that persist within a session.
 *
 * When a user chooses [a] always in a confirmation prompt, a session grant is
 * created. Subsequent matching tool calls are auto-approved without prompting.
 *
 * Grants are fingerprinted by tool name + optional command pattern:
 * - exec_command/open_session: keyed by tool + exact command string
 * - session_io: keyed by tool + exact stdin content
 * - Other tools: keyed by tool name alone
 *
 * Grants may be scoped to a subtree of agents:
 * - agentSubtreeRoot set: only agents in that subtree (the root and its descendants) can use it
 * - agentSubtreeRoot undefined: tree-wide grant, applies to all agents
 */

export interface SessionGrant {
    toolName: string;
    /** For exec tools: the exact command/stdin that was approved. */
    commandPattern?: string;
    /**
     * If set, this grant only applies to the agent with this ID and its descendants.
     * If undefined, the grant is tree-wide (e.g., from [a] always).
     */
    agentSubtreeRoot?: string;
    createdAt: number;
}

/**
 * Callback to walk up the agent parent chain.
 * Returns the parent agent ID or null if the agent is the root.
 */
export type ParentLookup = (agentId: string) => string | null;

export class SessionGrantStore {
    private readonly grants: SessionGrant[] = [];

    /** Add a tree-wide session grant. Deduplicates against other tree-wide grants only. */
    addGrant(toolName: string, commandPattern?: string): void {
        // Only check existing tree-wide grants (agentSubtreeRoot undefined) for dedup.
        // A subtree-scoped grant for the same tool+command should not block
        // creation of a tree-wide grant.
        const exists = this.grants.some(g =>
            g.agentSubtreeRoot === undefined &&
            this.grantMatchesTool(g, toolName, commandPattern),
        );
        if (exists) return;
        this.grants.push({
            toolName,
            commandPattern,
            createdAt: Date.now(),
        });
    }

    /** Add a subtree-scoped grant. Only the given agent and its descendants can use it. */
    addSubtreeGrant(toolName: string, commandPattern: string | undefined, agentSubtreeRoot: string): void {
        // Check for exact duplicate (same tool+command+subtree)
        const exists = this.grants.some(g =>
            g.toolName === toolName &&
            g.commandPattern === commandPattern &&
            g.agentSubtreeRoot === agentSubtreeRoot,
        );
        if (exists) return;
        this.grants.push({
            toolName,
            commandPattern,
            agentSubtreeRoot,
            createdAt: Date.now(),
        });
    }

    /**
     * Check if a matching grant exists (ignoring subtree scope).
     * Used by the approval flow for root-level checks.
     */
    hasGrant(toolName: string, commandPattern?: string): boolean {
        return this.matchesGrant(toolName, commandPattern);
    }

    /**
     * Check if a matching grant exists for a specific agent, considering subtree scoping.
     * Tree-wide grants (no agentSubtreeRoot) always match.
     * Subtree-scoped grants match only if the agent is in the subtree.
     */
    hasGrantForAgent(
        toolName: string,
        commandPattern: string | undefined,
        agentId: string,
        parentLookup: ParentLookup,
    ): boolean {
        return this.grants.some(grant => {
            if (!this.grantMatchesTool(grant, toolName, commandPattern)) return false;
            // Tree-wide grant (no subtree restriction)
            if (grant.agentSubtreeRoot === undefined) return true;
            // Subtree-scoped: check if agentId is in the subtree
            return isInSubtree(agentId, grant.agentSubtreeRoot, parentLookup);
        });
    }

    /** List all active grants (for debugging/display). */
    list(): readonly SessionGrant[] {
        return this.grants;
    }

    /** Remove all grants. */
    clear(): void {
        this.grants.length = 0;
    }

    // --- Private helpers ---

    private matchesGrant(toolName: string, commandPattern?: string): boolean {
        return this.grants.some(grant => this.grantMatchesTool(grant, toolName, commandPattern));
    }

    private grantMatchesTool(grant: SessionGrant, toolName: string, commandPattern?: string): boolean {
        if (grant.toolName !== toolName) return false;
        if (grant.commandPattern !== undefined) {
            return grant.commandPattern === commandPattern;
        }
        return commandPattern === undefined;
    }
}

/**
 * Check if an agent is in the subtree rooted at `subtreeRoot`.
 * Walks up the parent chain from `agentId` looking for `subtreeRoot`.
 * Guards against cycles with a depth limit of 10.
 */
export function isInSubtree(
    agentId: string,
    subtreeRoot: string,
    parentLookup: ParentLookup,
): boolean {
    let current: string | null = agentId;
    let depth = 0;
    while (current !== null && depth < 10) {
        if (current === subtreeRoot) return true;
        current = parentLookup(current);
        depth++;
    }
    return false;
}
