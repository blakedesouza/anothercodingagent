import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { EmbeddingModel, cosineSimilarity } from '../../src/indexing/embedding.js';

// --- Mock @huggingface/transformers ---

const mockPipeline = vi.fn();
const mockEnv = { cacheDir: '' };

vi.mock('@huggingface/transformers', () => ({
    pipeline: (...args: unknown[]) => mockPipeline(...args),
    env: mockEnv,
}));

// --- Helpers ---

function tmpDir(): string {
    const dir = join(tmpdir(), `aca-embed-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Build a deterministic 384-dim vector from text.
 * Same text always produces the same normalized vector.
 */
function deterministicVector(text: string): number[] {
    const vec = new Array(384).fill(0);
    for (let i = 0; i < text.length && i < 384; i++) {
        vec[i] = text.charCodeAt(i) / 256;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
        for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }
    return vec;
}

/**
 * Build a mock extractor returning deterministic vectors.
 */
function createMockExtractor() {
    const fn = async (input: string | string[], _options: Record<string, unknown>) => {
        const texts = Array.isArray(input) ? input : [input];
        const embeddings = texts.map((t) => deterministicVector(t));
        return { tolist: () => embeddings };
    };
    return Object.assign(fn, { dispose: vi.fn() });
}

/**
 * Build a mock extractor where specific topics produce clustered vectors,
 * allowing cosine-similarity assertions.
 */
function createSemanticMockExtractor() {
    const fn = async (input: string | string[], _options: Record<string, unknown>) => {
        const texts = Array.isArray(input) ? input : [input];
        const embeddings = texts.map((t) => {
            const vec = new Array(384).fill(0);

            // Cluster cat-related texts in one region
            if (/\b(cat|kitten|feline|whiskers)\b/i.test(t)) {
                vec[0] = 0.85;
                vec[1] = 0.45;
                vec[2] = 0.25;
            }

            // Cluster physics texts in a different region
            if (/\b(quantum|physics|electron|particle)\b/i.test(t)) {
                vec[100] = 0.85;
                vec[101] = 0.45;
                vec[102] = 0.25;
            }

            // Add per-text uniqueness so identical-topic vectors aren't perfectly equal
            for (let i = 200; i < Math.min(200 + t.length, 384); i++) {
                vec[i] = t.charCodeAt(i - 200) / 5120;
            }

            const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
            if (norm > 0) {
                for (let i = 0; i < vec.length; i++) vec[i] /= norm;
            }
            return vec;
        });
        return { tolist: () => embeddings };
    };
    return Object.assign(fn, { dispose: vi.fn() });
}

// --- Tests ---

describe('EmbeddingModel', () => {
    let cacheDir: string;

    beforeEach(() => {
        cacheDir = tmpDir();
        mockPipeline.mockReset();
        mockEnv.cacheDir = '';
    });

    it('initializes with default model and sets cache dir', async () => {
        mockPipeline.mockResolvedValue(createMockExtractor());

        const model = new EmbeddingModel({ cacheDir });
        const ok = await model.initialize();

        expect(ok).toBe(true);
        expect(model.available).toBe(true);
        expect(model.dimensions).toBe(384);
        expect(mockPipeline).toHaveBeenCalledWith(
            'feature-extraction',
            'Xenova/all-MiniLM-L6-v2',
            { dtype: 'fp32' },
        );
        expect(mockEnv.cacheDir).toBe(cacheDir);
    });

    it('embed "hello world" → 384-dimensional float array', async () => {
        mockPipeline.mockResolvedValue(createMockExtractor());

        const model = new EmbeddingModel({ cacheDir });
        await model.initialize();

        const vec = await model.embed('hello world');
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(384);
        // All values must be finite numbers
        for (let i = 0; i < vec.length; i++) {
            expect(Number.isFinite(vec[i])).toBe(true);
        }
    });

    it('embed same text twice → identical vectors', async () => {
        mockPipeline.mockResolvedValue(createMockExtractor());

        const model = new EmbeddingModel({ cacheDir });
        await model.initialize();

        const v1 = await model.embed('hello world');
        const v2 = await model.embed('hello world');

        expect(v1.length).toBe(v2.length);
        for (let i = 0; i < v1.length; i++) {
            expect(v1[i]).toBe(v2[i]);
        }
    });

    it('embed different texts → different vectors', async () => {
        mockPipeline.mockResolvedValue(createMockExtractor());

        const model = new EmbeddingModel({ cacheDir });
        await model.initialize();

        const v1 = await model.embed('hello world');
        const v2 = await model.embed('quantum physics');

        let allEqual = true;
        for (let i = 0; i < v1.length; i++) {
            if (v1[i] !== v2[i]) { allEqual = false; break; }
        }
        expect(allEqual).toBe(false);
    });

    it('cosine similarity: similar texts → high score (> 0.7), unrelated → low (< 0.3)', async () => {
        mockPipeline.mockResolvedValue(createSemanticMockExtractor());

        const model = new EmbeddingModel({ cacheDir });
        await model.initialize();

        const catVec = await model.embed('the cat sat on the mat');
        const kittenVec = await model.embed('a kitten rested on the rug');
        const physicsVec = await model.embed('quantum physics experiment');

        const similar = cosineSimilarity(catVec, kittenVec);
        const unrelated = cosineSimilarity(catVec, physicsVec);

        expect(similar).toBeGreaterThan(0.7);
        expect(unrelated).toBeLessThan(0.3);
    });

    it('model cache: second load reuses cache directory', async () => {
        mockPipeline.mockResolvedValue(createMockExtractor());

        const model1 = new EmbeddingModel({ cacheDir });
        await model1.initialize();
        expect(mockEnv.cacheDir).toBe(cacheDir);

        // Second instance with same cacheDir
        const model2 = new EmbeddingModel({ cacheDir });
        await model2.initialize();
        expect(model2.available).toBe(true);
        expect(mockEnv.cacheDir).toBe(cacheDir);
        // Pipeline was called twice, both times with same cache dir
        expect(mockPipeline).toHaveBeenCalledTimes(2);
    });

    it('offline: download fails → available is false, initialize returns false', async () => {
        mockPipeline.mockRejectedValue(new Error('Network error: model download failed'));

        const model = new EmbeddingModel({ cacheDir });
        const ok = await model.initialize();

        expect(ok).toBe(false);
        expect(model.available).toBe(false);
    });

    it('offline: embed throws after failed initialize', async () => {
        mockPipeline.mockRejectedValue(new Error('Network error'));

        const model = new EmbeddingModel({ cacheDir });
        await model.initialize();

        await expect(model.embed('test')).rejects.toThrow('not initialized');
    });

    it('embed throws when never initialized', async () => {
        const model = new EmbeddingModel({ cacheDir });
        await expect(model.embed('test')).rejects.toThrow('not initialized');
    });

    it('embedBatch returns one vector per input', async () => {
        mockPipeline.mockResolvedValue(createMockExtractor());

        const model = new EmbeddingModel({ cacheDir });
        await model.initialize();

        const results = await model.embedBatch(['hello', 'world', 'test']);
        expect(results).toHaveLength(3);
        for (const vec of results) {
            expect(vec).toBeInstanceOf(Float32Array);
            expect(vec.length).toBe(384);
        }
    });

    it('embedBatch throws when not initialized', async () => {
        const model = new EmbeddingModel({ cacheDir });
        await expect(model.embedBatch(['test'])).rejects.toThrow('not initialized');
    });

    it('dispose releases resources and marks unavailable', async () => {
        const extractor = createMockExtractor();
        mockPipeline.mockResolvedValue(extractor);

        const model = new EmbeddingModel({ cacheDir });
        await model.initialize();
        expect(model.available).toBe(true);

        await model.dispose();
        expect(model.available).toBe(false);
        expect(extractor.dispose).toHaveBeenCalled();
    });

    it('dispose is safe to call when not initialized', async () => {
        const model = new EmbeddingModel({ cacheDir });
        await expect(model.dispose()).resolves.toBeUndefined();
        expect(model.available).toBe(false);
    });

    it('embed empty string → zero vector', async () => {
        mockPipeline.mockResolvedValue(createMockExtractor());

        const model = new EmbeddingModel({ cacheDir });
        await model.initialize();

        const vec = await model.embed('');
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(384);
        // All zeros
        for (let i = 0; i < vec.length; i++) {
            expect(vec[i]).toBe(0);
        }
    });

    it('embedBatch empty array → empty result', async () => {
        const extractor = createMockExtractor();
        mockPipeline.mockResolvedValue(extractor);

        const model = new EmbeddingModel({ cacheDir });
        await model.initialize();

        const results = await model.embedBatch([]);
        expect(results).toEqual([]);
    });

    it('concurrent initialize() shares single promise', async () => {
        mockPipeline.mockResolvedValue(createMockExtractor());

        const model = new EmbeddingModel({ cacheDir });
        const [r1, r2, r3] = await Promise.all([
            model.initialize(),
            model.initialize(),
            model.initialize(),
        ]);

        expect(r1).toBe(true);
        expect(r2).toBe(true);
        expect(r3).toBe(true);
        // Pipeline should only be created once despite 3 concurrent calls
        expect(mockPipeline).toHaveBeenCalledTimes(1);
    });

    it('initialize() returns false on failure without writing directly to console', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockPipeline.mockRejectedValue(new Error('fetch failed'));

        const model = new EmbeddingModel({ cacheDir });
        const ok = await model.initialize();

        expect(ok).toBe(false);
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('env.cacheDir conflict is resolved quietly in favor of the requested cache dir', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockEnv.cacheDir = '/some/other/path';
        mockPipeline.mockResolvedValue(createMockExtractor());

        const model = new EmbeddingModel({ cacheDir });
        await model.initialize();

        expect(warnSpy).not.toHaveBeenCalled();
        expect(mockEnv.cacheDir).toBe(cacheDir);
        warnSpy.mockRestore();
    });

    it('re-initialize after failure succeeds', async () => {
        // First call fails
        mockPipeline.mockRejectedValueOnce(new Error('offline'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const model = new EmbeddingModel({ cacheDir });
        const first = await model.initialize();
        expect(first).toBe(false);

        // Second call succeeds (network restored)
        mockPipeline.mockResolvedValue(createMockExtractor());
        const second = await model.initialize();
        expect(second).toBe(true);
        expect(model.available).toBe(true);
        warnSpy.mockRestore();
    });

    it('accepts custom model ID', async () => {
        mockPipeline.mockResolvedValue(createMockExtractor());

        const model = new EmbeddingModel({ modelId: 'custom/model', cacheDir });
        await model.initialize();

        expect(mockPipeline).toHaveBeenCalledWith(
            'feature-extraction',
            'custom/model',
            { dtype: 'fp32' },
        );
    });
});

describe('cosineSimilarity', () => {
    it('identical vectors → 1.0', () => {
        const v = new Float32Array([0.6, 0.8, 0]);
        expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });

    it('orthogonal vectors → 0.0', () => {
        const a = new Float32Array([1, 0, 0]);
        const b = new Float32Array([0, 1, 0]);
        expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
    });

    it('opposite vectors → -1.0', () => {
        const a = new Float32Array([1, 0, 0]);
        const b = new Float32Array([-1, 0, 0]);
        expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
    });

    it('length mismatch throws', () => {
        const a = new Float32Array([1, 0]);
        const b = new Float32Array([1, 0, 0]);
        expect(() => cosineSimilarity(a, b)).toThrow('length mismatch');
    });

    it('zero vector → 0', () => {
        const a = new Float32Array([0, 0, 0]);
        const b = new Float32Array([1, 0, 0]);
        expect(cosineSimilarity(a, b)).toBe(0);
    });

    it('both zero vectors → 0', () => {
        const a = new Float32Array([0, 0, 0]);
        expect(cosineSimilarity(a, a)).toBe(0);
    });

    it('similar direction → high score', () => {
        const a = new Float32Array([1, 0.1, 0]);
        const b = new Float32Array([1, 0.2, 0]);
        expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
    });

    it('384-dimensional vectors', () => {
        const a = new Float32Array(384);
        const b = new Float32Array(384);
        a[0] = 1;
        b[0] = 1;
        expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
    });
});
