import { describe, it, expect } from 'vitest';
import {
    resolveModel,
    getModelCapabilities,
    getKnownModelIds,
} from '../../src/providers/model-registry.js';

describe('M5.1 — Model Registry (JSON-based)', () => {

    describe('getModelCapabilities()', () => {
        it('returns correct capabilities for claude-sonnet-4-20250514', () => {
            const caps = getModelCapabilities('claude-sonnet-4-20250514');
            expect(caps).toBeDefined();
            expect(caps?.maxContext).toBe(200_000);
            expect(caps?.maxOutput).toBe(16_384);
            expect(caps?.supportsTools).toBe('native');
            expect(caps?.supportsVision).toBe(true);
            expect(caps?.toolReliability).toBe('native');
            expect(caps?.costPerMillion.input).toBe(3.0);
            expect(caps?.costPerMillion.output).toBe(15.0);
            expect(caps?.bytesPerToken).toBe(3.5);
            expect(caps?.specialFeatures).toContain('anthropic-prompt-caching');
        });

        it('returns correct capabilities for gpt-4o', () => {
            const caps = getModelCapabilities('gpt-4o');
            expect(caps).toBeDefined();
            expect(caps?.maxContext).toBe(128_000);
            expect(caps?.supportsPrefill).toBe(false);
            expect(caps?.bytesPerToken).toBe(3.0);
        });

        it('returns correct capabilities for deepseek-chat', () => {
            const caps = getModelCapabilities('deepseek-chat');
            expect(caps).toBeDefined();
            expect(caps?.toolReliability).toBe('good');
            expect(caps?.supportsVision).toBe(false);
        });

        it('returns correct capabilities for deepseek v3.2', () => {
            const caps = getModelCapabilities('deepseek/deepseek-v3.2');
            expect(caps).toBeDefined();
            expect(caps?.maxContext).toBe(163_000);
            expect(caps?.maxOutput).toBe(65_536);
            expect(caps?.supportsTools).toBe('native');
        });

        it('returns undefined for unknown model ID', () => {
            expect(getModelCapabilities('unknown-model-xyz')).toBeUndefined();
        });

        it('aliases do NOT work as direct model IDs', () => {
            // aliases are only resolved via resolveModel()
            expect(getModelCapabilities('claude-sonnet')).toBeUndefined();
        });
    });

    describe('resolveModel()', () => {
        it('exact model ID resolves to itself', () => {
            expect(resolveModel('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250514');
        });

        it('alias claude-sonnet resolves to canonical ID', () => {
            expect(resolveModel('claude-sonnet')).toBe('claude-sonnet-4-20250514');
        });

        it('alias claude-opus resolves to canonical ID', () => {
            expect(resolveModel('claude-opus')).toBe('claude-opus-4-20250514');
        });

        it('alias claude-haiku resolves to canonical ID', () => {
            expect(resolveModel('claude-haiku')).toBe('claude-haiku-3.5-20241022');
        });

        it('alias gpt4o resolves to canonical ID', () => {
            expect(resolveModel('gpt4o')).toBe('gpt-4o');
        });

        it('returns undefined for unknown model name', () => {
            expect(resolveModel('does-not-exist')).toBeUndefined();
        });

        it('returns undefined for partial match (not a substring search)', () => {
            expect(resolveModel('claude')).toBeUndefined();
        });
    });

    describe('getKnownModelIds()', () => {
        it('returns an array of canonical model IDs', () => {
            const ids = getKnownModelIds();
            expect(ids).toContain('claude-sonnet-4-20250514');
            expect(ids).toContain('claude-opus-4-20250514');
            expect(ids).toContain('claude-haiku-3.5-20241022');
            expect(ids).toContain('gpt-4o');
            expect(ids).toContain('gpt-4o-mini');
            expect(ids).toContain('deepseek-chat');
            expect(ids).toContain('deepseek/deepseek-v3.2');
            expect(ids).toContain('deepseek-reasoner');
        });

        it('does not include aliases', () => {
            const ids = getKnownModelIds();
            expect(ids).not.toContain('claude-sonnet');
            expect(ids).not.toContain('claude-opus');
            expect(ids).not.toContain('gpt4o');
        });

        it('includes all 7 models from models.json', () => {
            const ids = getKnownModelIds();
            expect(ids.length).toBeGreaterThanOrEqual(7);
        });
    });

    describe('alias + capabilities round-trip', () => {
        it('resolve alias then get capabilities returns correct data', () => {
            const canonicalId = resolveModel('claude-sonnet');
            expect(canonicalId).toBeDefined();
            const caps = getModelCapabilities(canonicalId!);
            expect(caps).toBeDefined();
            expect(caps?.maxContext).toBe(200_000);
        });
    });
});
