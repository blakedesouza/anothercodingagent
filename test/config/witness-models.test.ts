import { describe, it, expect } from 'vitest';
import {
    WITNESS_MODELS,
    DEFAULT_WITNESS_TIMEOUT_S,
    getWitnessModel,
    getAllWitnessModelIds,
    resolveWitnesses,
    serializeWitnessConfigs,
    serializeWitnessSeed,
} from '../../src/config/witness-models.js';
describe('M11.5 — Witness Model Configuration', () => {
    describe('WITNESS_MODELS', () => {
        it('defines the strong default witnesses plus legacy witnesses', () => {
            expect(WITNESS_MODELS).toHaveLength(7);
        });

        it('includes strong and legacy names in stable order', () => {
            const names = WITNESS_MODELS.map(w => w.name);
            expect(names).toEqual(['kimi26', 'glm51', 'deepseek', 'minimax', 'kimi', 'qwen', 'gemma']);
        });

        it('uses actual API ceilings for maxOutputTokens', () => {
            // Values from NanoGPT /subscription/v1/models?detailed=true (2026-04-05)
            const expected: Record<string, number> = {
                kimi26: 65_536,
                glm51: 128_000,
                deepseek: 65_536,
                minimax: 131_072,
                kimi: 65_536,
                qwen: 65_536,
                gemma: 131_072,
            };
            for (const w of WITNESS_MODELS) {
                expect(w.maxOutputTokens, `${w.name} maxOutputTokens`).toBe(expected[w.name]);
            }
        });

        it('has correct context lengths from API', () => {
            const expected: Record<string, number> = {
                kimi26: 256_000,
                glm51: 200_000,
                deepseek: 163_000,
                minimax: 204_800,
                kimi: 256_000,
                qwen: 258_048,
                gemma: 262_144,
            };
            for (const w of WITNESS_MODELS) {
                expect(w.contextLength, `${w.name} contextLength`).toBe(expected[w.name]);
            }
        });

        it('all models have NanoGPT model IDs (provider/model format)', () => {
            for (const w of WITNESS_MODELS) {
                expect(w.model, `${w.name} model ID`).toMatch(/^[a-z-]+\/[a-z0-9._-]+$/i);
            }
        });

        it('kimi has topP set (API requirement)', () => {
            const kimi = WITNESS_MODELS.find(w => w.name === 'kimi');
            expect(kimi?.topP).toBe(0.95);
        });

        it('fallback models are defined for minimax, qwen, gemma', () => {
            const minimax = getWitnessModel('minimax');
            const qwen = getWitnessModel('qwen');
            const gemma = getWitnessModel('gemma');
            const kimi = getWitnessModel('kimi');
            const deepseek = getWitnessModel('deepseek');

            expect(minimax?.fallbackModel).toBe('minimax/minimax-m2.5');
            expect(qwen?.fallbackModel).toBe('qwen/qwen3.5-397b-a17b-thinking');
            expect(gemma?.fallbackModel).toBe('meta-llama/llama-4-maverick');
            expect(kimi?.fallbackModel).toBeUndefined();
            expect(deepseek?.fallbackModel).toBeUndefined();
        });

        it('is frozen (immutable)', () => {
            expect(Object.isFrozen(WITNESS_MODELS)).toBe(true);
        });

        it('individual elements are also frozen (deep immutability)', () => {
            for (const w of WITNESS_MODELS) {
                expect(Object.isFrozen(w), `${w.name} should be frozen`).toBe(true);
            }
        });
    });

    describe('getWitnessModel()', () => {
        it('returns config for known witness name', () => {
            const minimax = getWitnessModel('minimax');
            expect(minimax).toBeDefined();
            expect(minimax!.model).toBe('minimax/minimax-m2.7');
            expect(minimax!.displayName).toBe('MiniMax');
        });

        it('returns config for aliases and exact model IDs', () => {
            expect(getWitnessModel('glm')?.model).toBe('zai-org/glm-5.1');
            expect(getWitnessModel('deepseek-v4')?.model).toBe('deepseek/deepseek-v4-pro');
            expect(getWitnessModel('moonshotai/kimi-k2.6')?.name).toBe('kimi26');
        });

        it('returns undefined for unknown name', () => {
            expect(getWitnessModel('nonexistent')).toBeUndefined();
        });
    });

    describe('resolveWitnesses()', () => {
        it('defaults to Kimi K2.6 and GLM 5.1', () => {
            expect(resolveWitnesses(undefined).map(w => w.model)).toEqual([
                'moonshotai/kimi-k2.6',
                'zai-org/glm-5.1',
            ]);
        });

        it('expands dissent and legacy presets and accepts raw model IDs', () => {
            const withDissent = resolveWitnesses('default,dissent');
            expect(withDissent.map(w => w.name)).toEqual(['kimi26', 'glm51', 'deepseek']);

            const witnesses = resolveWitnesses('legacy,provider/custom-model');
            expect(witnesses.map(w => w.name)).toEqual(['minimax', 'gemma', 'provider-custom-model']);
            expect(witnesses.map(w => w.model)).toContain('provider/custom-model');
        });
    });

    describe('getAllWitnessModelIds()', () => {
        it('returns primary + fallback model IDs', () => {
            const ids = getAllWitnessModelIds();
            // 7 primary + 3 fallback.
            expect(ids).toHaveLength(10);
            expect(ids).toContain('minimax/minimax-m2.7');
            expect(ids).toContain('minimax/minimax-m2.5');
            expect(ids).toContain('moonshotai/kimi-k2.6');
            expect(ids).toContain('zai-org/glm-5.1');
            expect(ids).toContain('deepseek/deepseek-v4-pro');
            expect(ids).toContain('moonshotai/kimi-k2.5');
            expect(ids).toContain('qwen/qwen3.5-397b-a17b');
            expect(ids).toContain('qwen/qwen3.5-397b-a17b-thinking');
            expect(ids).toContain('google/gemma-4-31b-it');
            expect(ids).toContain('meta-llama/llama-4-maverick');
        });
    });

    describe('serializeWitnessConfigs()', () => {
        it('outputs valid JSON matching consult_ring.py WITNESSES format', () => {
            const json = serializeWitnessConfigs();
            const parsed = JSON.parse(json);

            expect(parsed.default).toEqual(['kimi26', 'glm51']);
            expect(parsed.presets.dissent).toEqual(['deepseek']);
            expect(parsed.presets.full).toEqual(['kimi26', 'glm51', 'deepseek']);
            expect(parsed.presets.legacy).toEqual(['minimax', 'gemma']);
            expect(Object.keys(parsed.witnesses)).toEqual(['kimi26', 'glm51', 'deepseek', 'minimax', 'kimi', 'qwen', 'gemma']);

            // Verify minimax entry structure
            expect(parsed.witnesses.minimax).toEqual({
                type: 'nanogpt',
                model: 'minimax/minimax-m2.7',
                display_name: 'MiniMax',
                fallback_model: 'minimax/minimax-m2.5',
                timeout: DEFAULT_WITNESS_TIMEOUT_S,
                temperature: 0.6,
                max_tokens: 131_072,
            });

            // Verify kimi has top_p but no fallback_model
            expect(parsed.witnesses.kimi.top_p).toBe(0.95);
            expect(parsed.witnesses.kimi.fallback_model).toBeUndefined();
            expect(parsed.witnesses.kimi.max_tokens).toBe(65_536);
        });

        it('max_tokens values match WITNESS_MODELS maxOutputTokens', () => {
            const parsed = JSON.parse(serializeWitnessConfigs());
            for (const w of WITNESS_MODELS) {
                expect(parsed.witnesses[w.name].max_tokens, `${w.name}`).toBe(w.maxOutputTokens);
            }
        });
    });

    describe('serializeWitnessSeed()', () => {
        it('serializes default witnesses for debug UI pending cards', () => {
            expect(serializeWitnessSeed()).toBe(
                'kimi26=moonshotai/kimi-k2.6,glm51=zai-org/glm-5.1',
            );
        });
    });
});
