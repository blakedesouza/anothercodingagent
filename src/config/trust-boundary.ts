/**
 * Trust boundary filtering for project config.
 *
 * Project config (.aca/config.json in workspace root) is untrusted input.
 * Only project-safe fields are allowed through; user-only fields are
 * silently dropped. Trusted workspaces get an expanded field set.
 */

// Fields that project config CAN set (project-safe)
// Organized by top-level group for clarity.
//
// User-only fields (silently dropped from project config):
//   providers, defaultProvider, apiTimeout, trustedWorkspaces,
//   permissions.nonInteractive, permissions.preauth,
//   permissions.classOverrides, permissions.toolOverrides,
//   sandbox.extraTrustedRoots (allowed only for trusted workspaces),
//   network.mode, network.allowDomains, network.allowHttp,
//   scrubbing.allowPatterns,
//   model.compressionModel, model.maxOutputTokens

type RawConfig = Record<string, unknown>;
type RawObject = Record<string, unknown>;

function pick(source: RawObject, keys: string[]): RawObject {
    const result: RawObject = {};
    for (const key of keys) {
        if (key in source) {
            result[key] = source[key];
        }
    }
    return result;
}

function asObject(value: unknown): RawObject | null {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return value as RawObject;
    }
    return null;
}

/**
 * Filter a project config object through the trust boundary.
 * Returns a new object containing only project-safe fields.
 * Fields not in the whitelist are silently dropped.
 *
 * @param config - Raw parsed project config
 * @param isTrusted - Whether this workspace is in the trustedWorkspaces map
 */
export function filterProjectConfig(
    config: RawConfig,
    isTrusted = false,
): RawConfig {
    const result: RawConfig = {};

    // schemaVersion is always allowed
    if ('schemaVersion' in config) {
        result.schemaVersion = config.schemaVersion;
    }

    // model: only default, temperature
    const model = asObject(config.model);
    if (model) {
        const allowed = ['default', 'temperature'];
        if (isTrusted) allowed.push('provider');
        const filtered = pick(model, allowed);
        if (Object.keys(filtered).length > 0) result.model = filtered;
    }

    // project: all sub-fields are project-safe
    const project = asObject(config.project);
    if (project) {
        const allowed = ['ignorePaths', 'docAliases', 'conventions'];
        if (isTrusted) allowed.push('systemPromptOverlay');
        result.project = pick(project, allowed);
    }

    // sandbox: trusted workspaces may add extraTrustedRoots
    const sandbox = asObject(config.sandbox);
    if (sandbox && isTrusted) {
        const filtered = pick(sandbox, ['extraTrustedRoots']);
        if (Object.keys(filtered).length > 0) result.sandbox = filtered;
    }

    // network: only denyDomains
    const network = asObject(config.network);
    if (network) {
        const filtered = pick(network, ['denyDomains']);
        if (Object.keys(filtered).length > 0) result.network = filtered;
    }

    // permissions: only blockedTools
    const permissions = asObject(config.permissions);
    if (permissions) {
        const filtered = pick(permissions, ['blockedTools']);
        if (Object.keys(filtered).length > 0) result.permissions = filtered;
    }

    // limits: only maxStepsPerTurn, maxConcurrentAgents (can only reduce)
    const limits = asObject(config.limits);
    if (limits) {
        const filtered = pick(limits, ['maxStepsPerTurn', 'maxConcurrentAgents']);
        if (Object.keys(filtered).length > 0) result.limits = filtered;
    }

    // scrubbing: entirely user-only. Project config cannot disable scrubbing
    // (that would be a security-expanding action, not a restrictive one).
    // scrubbing.enabled and scrubbing.allowPatterns are both user-only.

    // rpProjectRoot: allowed from project config (gitignored, personal path preference)
    if ('rpProjectRoot' in config) {
        result.rpProjectRoot = config.rpProjectRoot;
    }

    // Silently dropped (user-only): providers, defaultProvider, apiTimeout,
    // trustedWorkspaces, sandbox.extraTrustedRoots, network.mode,
    // network.allowDomains, network.allowHttp, scrubbing.allowPatterns,
    // permissions.nonInteractive, permissions.preauth,
    // permissions.classOverrides, permissions.toolOverrides,
    // retention (entire group — project config cannot override retention policy),
    // telemetry (entire group — project config cannot enable telemetry)

    return result;
}
