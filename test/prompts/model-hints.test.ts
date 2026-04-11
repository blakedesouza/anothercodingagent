import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MODEL_HINTS, getModelHints } from '../../src/prompts/model-hints.js';
import {
    buildInvokeSystemMessages,
    buildAnalyticalSystemMessages,
    buildSynthesisSystemMessages,
} from '../../src/core/prompt-assembly.js';

// --- Helpers ---

/** Temporarily populate MODEL_HINTS; restores original state in afterEach. */
function populateHints(entries: Record<string, string[]>): void {
    for (const [key, hints] of Object.entries(entries)) {
        MODEL_HINTS[key] = hints;
    }
}

/** Extract system message content as a string for assertions. */
function contentOf(msg: { content: string | unknown[] }): string {
    return msg.content as string;
}

const TEST_PREFIX = 'test-model-family/';
const TEST_MODEL = 'test-model-family/model-v1';
const TEST_HINTS = ['Do not do X.', 'Always do Y instead.'];

// Minimal InvokePromptOptions for structural tests
const BASE_OPTIONS = {
    cwd: '/tmp/test',
    toolNames: ['read_file', 'exec_command'],
};

// --- Model hints unit tests ---

describe('getModelHints', () => {
    beforeEach(() => {
        // Wipe any entries added by previous tests
        for (const key of Object.keys(MODEL_HINTS)) {
            delete MODEL_HINTS[key];
        }
    });

    afterEach(() => {
        for (const key of Object.keys(MODEL_HINTS)) {
            delete MODEL_HINTS[key];
        }
    });

    it('returns empty array when registry is empty', () => {
        expect(getModelHints('qwen/qwen3-coder')).toEqual([]);
    });

    it('returns empty array for empty string model ID', () => {
        populateHints({ 'qwen/': TEST_HINTS });
        expect(getModelHints('')).toEqual([]);
    });

    it('returns hints for exact prefix match', () => {
        populateHints({ [TEST_PREFIX]: TEST_HINTS });
        expect(getModelHints(TEST_MODEL)).toEqual(TEST_HINTS);
    });

    it('returns empty array when no prefix matches', () => {
        populateHints({ 'other-family/': TEST_HINTS });
        expect(getModelHints(TEST_MODEL)).toEqual([]);
    });

    it('concatenates hints from multiple matching prefixes in definition order', () => {
        populateHints({
            'test-model-family/': ['hint A'],
            'test-model-family/model': ['hint B'],
        });
        const hints = getModelHints('test-model-family/model-v1');
        expect(hints).toEqual(['hint A', 'hint B']);
    });

    it('does not match a non-prefix substring', () => {
        populateHints({ 'model-v1': TEST_HINTS });
        // 'model-v1' is a suffix, not a prefix of 'test-model-family/model-v1'
        expect(getModelHints('test-model-family/model-v1')).toEqual([]);
    });

    it('returns empty array when registry has only non-matching entries', () => {
        populateHints({
            'kimi/': ['hint K'],
            'deepseek/': ['hint D'],
        });
        expect(getModelHints('qwen/qwen3-coder')).toEqual([]);
    });
});

// --- Structural prompt injection tests ---

describe('buildInvokeSystemMessages — model_hints injection', () => {
    beforeEach(() => {
        for (const key of Object.keys(MODEL_HINTS)) {
            delete MODEL_HINTS[key];
        }
    });

    afterEach(() => {
        for (const key of Object.keys(MODEL_HINTS)) {
            delete MODEL_HINTS[key];
        }
    });

    it('includes <model_hints> section when hints exist for the model', () => {
        populateHints({ [TEST_PREFIX]: TEST_HINTS });
        const [msg] = buildInvokeSystemMessages({ ...BASE_OPTIONS, model: TEST_MODEL });
        expect(contentOf(msg)).toContain('<model_hints>');
        for (const hint of TEST_HINTS) {
            expect(contentOf(msg)).toContain(hint);
        }
        expect(contentOf(msg)).toContain('</model_hints>');
    });

    it('does not include <model_hints> when model is not provided', () => {
        populateHints({ [TEST_PREFIX]: TEST_HINTS });
        const [msg] = buildInvokeSystemMessages({ ...BASE_OPTIONS });
        expect(contentOf(msg)).not.toContain('<model_hints>');
    });

    it('does not include <model_hints> when registry is empty', () => {
        const [msg] = buildInvokeSystemMessages({ ...BASE_OPTIONS, model: TEST_MODEL });
        expect(contentOf(msg)).not.toContain('<model_hints>');
    });

    it('<model_hints> appears before closing anchor', () => {
        populateHints({ [TEST_PREFIX]: TEST_HINTS });
        const [msg] = buildInvokeSystemMessages({ ...BASE_OPTIONS, model: TEST_MODEL });
        const hintsPos = contentOf(msg).indexOf('<model_hints>');
        const anchorPos = contentOf(msg).indexOf('Remember: a response without tool calls');
        expect(hintsPos).toBeGreaterThan(0);
        expect(anchorPos).toBeGreaterThan(hintsPos);
    });
});

describe('buildAnalyticalSystemMessages — model_hints injection', () => {
    beforeEach(() => {
        for (const key of Object.keys(MODEL_HINTS)) {
            delete MODEL_HINTS[key];
        }
    });

    afterEach(() => {
        for (const key of Object.keys(MODEL_HINTS)) {
            delete MODEL_HINTS[key];
        }
    });

    it('includes <model_hints> section when hints exist for the model', () => {
        populateHints({ [TEST_PREFIX]: TEST_HINTS });
        const [msg] = buildAnalyticalSystemMessages({ ...BASE_OPTIONS, model: TEST_MODEL });
        expect(contentOf(msg)).toContain('<model_hints>');
        for (const hint of TEST_HINTS) {
            expect(contentOf(msg)).toContain(hint);
        }
        expect(contentOf(msg)).toContain('</model_hints>');
    });

    it('does not include <model_hints> when model is not provided', () => {
        populateHints({ [TEST_PREFIX]: TEST_HINTS });
        const [msg] = buildAnalyticalSystemMessages({ ...BASE_OPTIONS });
        expect(contentOf(msg)).not.toContain('<model_hints>');
    });

    it('does not include <model_hints> when registry is empty', () => {
        const [msg] = buildAnalyticalSystemMessages({ ...BASE_OPTIONS, model: TEST_MODEL });
        expect(contentOf(msg)).not.toContain('<model_hints>');
    });
});

describe('buildSynthesisSystemMessages — model_hints injection', () => {
    beforeEach(() => {
        for (const key of Object.keys(MODEL_HINTS)) {
            delete MODEL_HINTS[key];
        }
    });

    afterEach(() => {
        for (const key of Object.keys(MODEL_HINTS)) {
            delete MODEL_HINTS[key];
        }
    });

    it('includes <model_hints> section when hints exist for the model', () => {
        populateHints({ [TEST_PREFIX]: TEST_HINTS });
        const [msg] = buildSynthesisSystemMessages({ ...BASE_OPTIONS, model: TEST_MODEL });
        expect(contentOf(msg)).toContain('<model_hints>');
        for (const hint of TEST_HINTS) {
            expect(contentOf(msg)).toContain(hint);
        }
        expect(contentOf(msg)).toContain('</model_hints>');
    });

    it('does not include <model_hints> when model is not provided', () => {
        populateHints({ [TEST_PREFIX]: TEST_HINTS });
        const [msg] = buildSynthesisSystemMessages({ ...BASE_OPTIONS });
        expect(contentOf(msg)).not.toContain('<model_hints>');
    });

    it('does not include <model_hints> when registry is empty', () => {
        const [msg] = buildSynthesisSystemMessages({ ...BASE_OPTIONS, model: TEST_MODEL });
        expect(contentOf(msg)).not.toContain('<model_hints>');
    });
});
