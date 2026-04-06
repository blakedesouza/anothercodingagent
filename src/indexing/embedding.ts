/**
 * Embedding model wrapper (Block 20, M6.2).
 *
 * Runs Xenova/all-MiniLM-L6-v2 locally via @huggingface/transformers WASM.
 * Model files are cached at ~/.aca/models/. If download fails (offline),
 * the module degrades gracefully — embeddings become unavailable but the
 * agent continues without semantic search.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIMS = 384;
const DEFAULT_CACHE_DIR = join(homedir(), '.aca', 'models');

export interface EmbeddingModelOptions {
    modelId?: string;
    cacheDir?: string;
}

export class EmbeddingModel {
    private extractor: FeatureExtractor | null = null;
    private readonly modelId: string;
    private readonly cacheDir: string;
    private _available = false;
    private initPromise: Promise<boolean> | null = null;

    constructor(options?: EmbeddingModelOptions) {
        this.modelId = options?.modelId ?? DEFAULT_MODEL;
        this.cacheDir = options?.cacheDir ?? DEFAULT_CACHE_DIR;
    }

    /**
     * Initialize the model pipeline. Downloads model on first use.
     * Returns true if successful, false on failure (offline/network error).
     * Safe to call concurrently — shares a single init promise.
     */
    async initialize(): Promise<boolean> {
        if (this._available) return true;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this.doInitialize();
        try {
            return await this.initPromise;
        } finally {
            this.initPromise = null;
        }
    }

    private async doInitialize(): Promise<boolean> {
        try {
            mkdirSync(this.cacheDir, { recursive: true });

            // Dynamic import: avoids loading WASM at module level,
            // consistent with SyntaxHighlighter's lazy-load pattern.
            const { pipeline, env } = await import('@huggingface/transformers');

            if (env.cacheDir && env.cacheDir !== this.cacheDir) {
                console.warn(
                    `[EmbeddingModel] cacheDir already set to ${env.cacheDir}, ` +
                    `ignoring requested ${this.cacheDir}`,
                );
            } else {
                env.cacheDir = this.cacheDir;
            }

            this.extractor = await pipeline('feature-extraction', this.modelId, {
                dtype: 'fp32',
            }) as unknown as FeatureExtractor;
            this._available = true;
            return true;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[EmbeddingModel] Initialization failed: ${msg}`);
            this._available = false;
            return false;
        }
    }

    get available(): boolean {
        return this._available;
    }

    get dimensions(): number {
        return EMBEDDING_DIMS;
    }

    /**
     * Embed a single text string into a 384-dimensional float32 vector.
     * The vector is mean-pooled and L2-normalized.
     */
    async embed(text: string): Promise<Float32Array> {
        const extractor = this.extractor;
        if (!extractor) {
            throw new Error('Embedding model not initialized — call initialize() first');
        }
        if (text.length === 0) {
            return new Float32Array(EMBEDDING_DIMS);
        }
        // Capture local reference to protect against concurrent dispose()
        const output = await extractor(text, { pooling: 'mean', normalize: true });
        const nested: number[][] = output.tolist();
        return new Float32Array(nested[0]);
    }

    /**
     * Embed multiple texts in a single batch. Returns one vector per input.
     */
    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        const extractor = this.extractor;
        if (!extractor) {
            throw new Error('Embedding model not initialized — call initialize() first');
        }
        if (texts.length === 0) {
            return [];
        }
        // Capture local reference to protect against concurrent dispose()
        const output = await extractor(texts, { pooling: 'mean', normalize: true });
        const nested: number[][] = output.tolist();
        return nested.map((v) => new Float32Array(v));
    }

    /** Release model resources. */
    async dispose(): Promise<void> {
        if (this.extractor?.dispose) {
            await this.extractor.dispose();
        }
        this.extractor = null;
        this._available = false;
    }
}

/**
 * Cosine similarity between two vectors of equal length.
 * Returns a value in [-1, 1]. 1 = identical direction, 0 = orthogonal, -1 = opposite.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
        throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return dot / denom;
}

// --- Internal types ---

/** Minimal interface for the feature-extraction pipeline result. */
interface PipelineOutput {
    tolist(): number[][];
}

/** Minimal callable interface for the feature-extraction pipeline. */
interface FeatureExtractor {
    (input: string | string[], options: { pooling: string; normalize: boolean }): Promise<PipelineOutput>;
    dispose?: () => Promise<void>;
}
