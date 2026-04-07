import { describe, it, expect } from 'vitest';
import {
    WITNESS_MODELS,
    DEFAULT_WITNESS_TIMEOUT_S,
    getWitnessModel,
    getAllWitnessModelIds,
    serializeWitnessConfigs,
} from '../../src/config/witness-models.js';
describe('M11.5 — Witness Model Configuration', () => {
    describe('WITNESS_MODELS', () => {
        it('defines exactly 4 witness models', () => {
            expect(WITNESS_MODELS).toHaveLength(4);
        });

        it('includes deepseek, kimi, qwen, gemma', () => {
            const names = WITNESS_MODELS.map(w => w.name);
            expect(names).toEqual(['deepseek', 'kimi', 'qwen', 'gemma']);
        });

        it('uses actual API ceilings for maxOutputTokens', () => {
            // Values from NanoGPT /api/v1/models?detailed=true (2026-04-05)
            const expected: Record<string, number> = {
                deepseek: 65_536,
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
                deepseek: 163_000,
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

        it('fallback models are defined for deepseek, qwen, gemma', () => {
            const deepseek = getWitnessModel('deepseek');
            const qwen = getWitnessModel('qwen');
            const gemma = getWitnessModel('gemma');
            const kimi = getWitnessModel('kimi');

            expect(deepseek?.fallbackModel).toBe('deepseek-chat');
            expect(qwen?.fallbackModel).toBe('qwen/qwen3.5-397b-a17b-thinking');
            expect(gemma?.fallbackModel).toBe('meta-llama/llama-4-maverick');
            expect(kimi?.fallbackModel).toBeUndefined();
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
            const deepseek = getWitnessModel('deepseek');
            expect(deepseek).toBeDefined();
            expect(deepseek!.model).toBe('deepseek/deepseek-v3.2');
            expect(deepseek!.displayName).toBe('DeepSeek');
        });

        it('returns undefined for unknown name', () => {
            expect(getWitnessModel('nonexistent')).toBeUndefined();
        });
    });

    describe('getAllWitnessModelIds()', () => {
        it('returns primary + fallback model IDs', () => {
            const ids = getAllWitnessModelIds();
            // 4 primary + 3 fallback (kimi has no fallback)
            expect(ids).toHaveLength(7);
            expect(ids).toContain('deepseek/deepseek-v3.2');
            expect(ids).toContain('deepseek-chat');
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

            expect(Object.keys(parsed)).toEqual(['deepseek', 'kimi', 'qwen', 'gemma']);

            // Verify deepseek entry structure
            expect(parsed.deepseek).toEqual({
                type: 'nanogpt',
                model: 'deepseek/deepseek-v3.2',
                fallback_model: 'deepseek-chat',
                timeout: DEFAULT_WITNESS_TIMEOUT_S,
                temperature: 0.6,
                max_tokens: 65_536,
            });

            // Verify kimi has top_p but no fallback_model
            expect(parsed.kimi.top_p).toBe(0.95);
            expect(parsed.kimi.fallback_model).toBeUndefined();
            expect(parsed.kimi.max_tokens).toBe(65_536);
        });

        it('max_tokens values match WITNESS_MODELS maxOutputTokens', () => {
            const parsed = JSON.parse(serializeWitnessConfigs());
            for (const w of WITNESS_MODELS) {
                expect(parsed[w.name].max_tokens, `${w.name}`).toBe(w.maxOutputTokens);
            }
        });
    });
});
