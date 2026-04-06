/**
 * Config merge semantics.
 *
 * - Scalars: last-wins (higher priority replaces lower)
 * - Objects: deep-merge by key
 * - Arrays: replace (higher priority array replaces lower entirely)
 * - Permission fields: most-restrictive-wins (see mergeProjectConfig)
 */

type RawConfig = Record<string, unknown>;

function isPlainObject(value: unknown): value is RawConfig {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * General deep merge. Higher-priority `override` values replace `base`.
 * Objects are deep-merged; arrays and scalars are replaced (last-wins).
 */
export function deepMerge(base: RawConfig, override: RawConfig): RawConfig {
    const result: RawConfig = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (value === undefined) continue;
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (isPlainObject(value) && isPlainObject(result[key])) {
            result[key] = deepMerge(result[key] as RawConfig, value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Merge project config into base using most-restrictive-wins for permission fields.
 *
 * Regular fields use deepMerge (last-wins). Permission-sensitive fields use:
 * - blockedTools: set-union (more blocked = more restrictive)
 * - denyDomains: set-union (more denied = more restrictive)
 * - allowDomains: set-intersection (fewer allowed = more restrictive)
 * - maxStepsPerTurn: min(base, project) — can only reduce
 * - maxConcurrentAgents: min(base, project) — can only reduce
 */
export function mergeProjectConfig(base: RawConfig, project: RawConfig): RawConfig {
    // Start with a standard deep merge
    const result = deepMerge(base, project);

    // Apply most-restrictive-wins overrides for permission fields

    // blockedTools: union
    const baseBlockedTools = getArray(base, ['permissions', 'blockedTools']);
    const projBlockedTools = getArray(project, ['permissions', 'blockedTools']);
    if (projBlockedTools.length > 0) {
        setNested(result, ['permissions', 'blockedTools'],
            [...new Set([...baseBlockedTools, ...projBlockedTools])]);
    }

    // denyDomains: union
    const baseDenyDomains = getArray(base, ['network', 'denyDomains']);
    const projDenyDomains = getArray(project, ['network', 'denyDomains']);
    if (projDenyDomains.length > 0) {
        setNested(result, ['network', 'denyDomains'],
            [...new Set([...baseDenyDomains, ...projDenyDomains])]);
    }

    // allowDomains: intersection (only when project specifies any)
    const baseAllowDomains = getArray(base, ['network', 'allowDomains']);
    const projAllowDomains = getArray(project, ['network', 'allowDomains']);
    if (projAllowDomains.length > 0 && baseAllowDomains.length > 0) {
        const projSet = new Set(projAllowDomains);
        setNested(result, ['network', 'allowDomains'],
            baseAllowDomains.filter(d => projSet.has(d)));
    }

    // maxStepsPerTurn: min (can only reduce)
    const baseMaxSteps = getNumber(base, ['limits', 'maxStepsPerTurn']);
    const projMaxSteps = getNumber(project, ['limits', 'maxStepsPerTurn']);
    if (projMaxSteps !== undefined && baseMaxSteps !== undefined) {
        setNested(result, ['limits', 'maxStepsPerTurn'],
            Math.min(baseMaxSteps, projMaxSteps));
    }

    // maxConcurrentAgents: min (can only reduce)
    const baseMaxAgents = getNumber(base, ['limits', 'maxConcurrentAgents']);
    const projMaxAgents = getNumber(project, ['limits', 'maxConcurrentAgents']);
    if (projMaxAgents !== undefined && baseMaxAgents !== undefined) {
        setNested(result, ['limits', 'maxConcurrentAgents'],
            Math.min(baseMaxAgents, projMaxAgents));
    }

    return result;
}

// --- Helpers ---

function getArray(obj: RawConfig, path: string[]): string[] {
    let current: unknown = obj;
    for (const key of path) {
        if (!isPlainObject(current)) return [];
        current = (current as RawConfig)[key];
    }
    return Array.isArray(current) ? current.filter(v => typeof v === 'string') : [];
}

function getNumber(obj: RawConfig, path: string[]): number | undefined {
    let current: unknown = obj;
    for (const key of path) {
        if (!isPlainObject(current)) return undefined;
        current = (current as RawConfig)[key];
    }
    return typeof current === 'number' ? current : undefined;
}

function setNested(obj: RawConfig, path: string[], value: unknown): void {
    let current = obj;
    for (let i = 0; i < path.length - 1; i++) {
        if (!isPlainObject(current[path[i]])) {
            current[path[i]] = {};
        }
        current = current[path[i]] as RawConfig;
    }
    current[path[path.length - 1]] = value;
}
