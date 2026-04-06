import type { ProviderDriver, ProviderConfig } from '../types/provider.js';
import { resolveModel } from './model-registry.js';

export interface ResolvedProvider {
    driver: ProviderDriver;
    config: ProviderConfig;
    /** The canonical model ID (after alias resolution). */
    resolvedModelId: string;
}

interface RegisteredProvider {
    driver: ProviderDriver;
    config: ProviderConfig;
}

/**
 * Holds registered provider drivers and resolves model names to drivers.
 *
 * Resolution order:
 *   1. Alias → canonical model ID (via model registry)
 *   2. Filter to drivers that can serve the canonical model ID (capabilities() does not throw)
 *   3. Sort by priority (lower number = higher priority)
 *   4. Return highest-priority driver
 */
export class ProviderRegistry {
    private readonly registered: RegisteredProvider[] = [];

    /** Register a driver with its config. Call once per provider at startup. */
    register(driver: ProviderDriver, config: ProviderConfig): void {
        this.registered.push({ driver, config });
    }

    /**
     * Resolve a model name (possibly an alias) to the highest-priority driver that supports it.
     * Returns undefined if no registered driver supports the model.
     */
    resolve(modelName: string): ResolvedProvider | undefined {
        // Step 1: alias → canonical model ID
        const resolvedModelId = resolveModel(modelName) ?? modelName;

        // Step 2: filter to capable drivers
        // Only swallow expected "unsupported/unknown model" errors — re-throw programming errors.
        const candidates = this.registered
            .filter(({ driver }) => {
                try {
                    driver.capabilities(resolvedModelId);
                    return true;
                } catch (err) {
                    if (err instanceof Error &&
                        (err.message.includes('unsupported model') ||
                         err.message.includes('Unknown model'))) {
                        return false;
                    }
                    throw err; // re-throw ReferenceError, TypeError, etc.
                }
            })
            // Step 3: sort by priority (lower number = higher priority).
            // Ties broken by name for determinism (V8 sort is stable, but explicit is better).
            .sort((a, b) =>
                a.config.priority - b.config.priority ||
                a.config.name.localeCompare(b.config.name),
            );

        const best = candidates[0];
        if (!best) return undefined;

        return { driver: best.driver, config: best.config, resolvedModelId };
    }

    /** Return the registered provider with the given name, or undefined. */
    getByName(name: string): RegisteredProvider | undefined {
        return this.registered.find(p => p.config.name === name);
    }
}
