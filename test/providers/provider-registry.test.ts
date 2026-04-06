import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from '../../src/providers/provider-registry.js';
import { NanoGptDriver } from '../../src/providers/nanogpt-driver.js';
import { AnthropicDriver } from '../../src/providers/anthropic-driver.js';
import { OpenAiDriver } from '../../src/providers/openai-driver.js';
import type { ProviderConfig } from '../../src/types/provider.js';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
        name: 'nanogpt',
        driver: 'nanogpt',
        baseUrl: 'https://api.nano-gpt.com/v1',
        timeout: 30000,
        priority: 10,
        ...overrides,
    };
}

describe('M5.1 — ProviderRegistry', () => {

    describe('resolve() — single provider', () => {
        it('returns the registered provider for a known model', () => {
            const registry = new ProviderRegistry();
            const driver = new NanoGptDriver({ apiKey: 'key' });
            const config = makeConfig({ name: 'nanogpt', priority: 1 });
            registry.register(driver, config);

            const result = registry.resolve('claude-sonnet-4-20250514');
            expect(result).toBeDefined();
            expect(result?.driver).toBe(driver);
            expect(result?.config.name).toBe('nanogpt');
            expect(result?.resolvedModelId).toBe('claude-sonnet-4-20250514');
        });

        it('resolves unknown model with default capabilities (NanoGPT is a meta-provider)', () => {
            const registry = new ProviderRegistry();
            const driver = new NanoGptDriver({ apiKey: 'key' });
            registry.register(driver, makeConfig({ priority: 1 }));

            const result = registry.resolve('totally-unknown-model-xyz');
            expect(result).toBeDefined();
            expect(result?.resolvedModelId).toBe('totally-unknown-model-xyz');
            expect(result?.driver).toBe(driver);
        });
    });

    describe('resolve() — alias resolution', () => {
        it('alias claude-sonnet resolves to full ID and selects correct driver', () => {
            const registry = new ProviderRegistry();
            // AnthropicDriver only serves claude-* models
            const driver = new AnthropicDriver({ apiKey: 'key' });
            registry.register(driver, makeConfig({ name: 'anthropic', driver: 'anthropic', priority: 1 }));

            const result = registry.resolve('claude-sonnet'); // alias
            expect(result).toBeDefined();
            expect(result?.resolvedModelId).toBe('claude-sonnet-4-20250514');
            expect(result?.driver).toBe(driver);
        });

        it('alias gpt4o resolves to gpt-4o and selects OpenAI driver', () => {
            const registry = new ProviderRegistry();
            const driver = new OpenAiDriver({ apiKey: 'key' });
            registry.register(driver, makeConfig({ name: 'openai', driver: 'openai', priority: 1 }));

            const result = registry.resolve('gpt4o');
            expect(result).toBeDefined();
            expect(result?.resolvedModelId).toBe('gpt-4o');
        });
    });

    describe('resolve() — provider priority', () => {
        it('model available from 2 providers → higher priority (lower number) selected', () => {
            const registry = new ProviderRegistry();

            // Both NanoGPT and OpenAI can serve gpt-4o
            const nanogptDriver = new NanoGptDriver({ apiKey: 'key' });
            const openaiDriver = new OpenAiDriver({ apiKey: 'key' });

            // NanoGPT has lower priority number = higher priority
            registry.register(nanogptDriver, makeConfig({ name: 'nanogpt', driver: 'nanogpt', priority: 1 }));
            registry.register(openaiDriver, makeConfig({ name: 'openai', driver: 'openai', priority: 2 }));

            const result = registry.resolve('gpt-4o');
            expect(result).toBeDefined();
            // Should select NanoGPT (priority 1 < 2)
            expect(result?.config.name).toBe('nanogpt');
        });

        it('higher priority number loses when lower is available', () => {
            const registry = new ProviderRegistry();

            const nanogptDriver = new NanoGptDriver({ apiKey: 'key' });
            const openaiDriver = new OpenAiDriver({ apiKey: 'key' });

            // OpenAI has higher priority (lower number)
            registry.register(openaiDriver, makeConfig({ name: 'openai', driver: 'openai', priority: 1 }));
            registry.register(nanogptDriver, makeConfig({ name: 'nanogpt', driver: 'nanogpt', priority: 5 }));

            const result = registry.resolve('gpt-4o');
            expect(result?.config.name).toBe('openai');
        });

        it('model only supported by one driver → that driver selected regardless of priority', () => {
            const registry = new ProviderRegistry();

            const anthropicDriver = new AnthropicDriver({ apiKey: 'key' });
            const openaiDriver = new OpenAiDriver({ apiKey: 'key' });

            // OpenAI has higher priority but can't serve claude models
            registry.register(openaiDriver, makeConfig({ name: 'openai', driver: 'openai', priority: 1 }));
            registry.register(anthropicDriver, makeConfig({ name: 'anthropic', driver: 'anthropic', priority: 2 }));

            const result = registry.resolve('claude-sonnet-4-20250514');
            expect(result).toBeDefined();
            expect(result?.config.name).toBe('anthropic');
        });
    });

    describe('resolve() — empty registry', () => {
        it('returns undefined when no providers are registered', () => {
            const registry = new ProviderRegistry();
            expect(registry.resolve('claude-sonnet-4-20250514')).toBeUndefined();
        });
    });

    describe('getByName()', () => {
        it('returns registered provider by name', () => {
            const registry = new ProviderRegistry();
            const driver = new NanoGptDriver({ apiKey: 'key' });
            const config = makeConfig({ name: 'my-nanogpt' });
            registry.register(driver, config);

            const found = registry.getByName('my-nanogpt');
            expect(found).toBeDefined();
            expect(found?.driver).toBe(driver);
        });

        it('returns undefined for unknown name', () => {
            const registry = new ProviderRegistry();
            expect(registry.getByName('nonexistent')).toBeUndefined();
        });
    });
});
