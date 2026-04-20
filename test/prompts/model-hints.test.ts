import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ModelHintEntry } from '../../src/prompts/model-hints.js';
import { MODEL_HINTS, getModelHints } from '../../src/prompts/model-hints.js';
import {
    buildInvokeSystemMessages,
    buildAnalyticalSystemMessages,
    buildSynthesisSystemMessages,
} from '../../src/core/prompt-assembly.js';

// --- Helpers ---

/** Temporarily populate MODEL_HINTS; restores original state in afterEach. */
function populateHints(entries: Record<string, string[] | ModelHintEntry[]>): void {
    for (const [key, hints] of Object.entries(entries)) {
        MODEL_HINTS[key] = hints.map(hint =>
            typeof hint === 'string'
                ? { text: hint }
                : hint,
        );
    }
}

/** Extract system message content as a string for assertions. */
function contentOf(msg: { content: string | unknown[] }): string {
    return msg.content as string;
}

const TEST_PREFIX = 'test-model-family/';
const TEST_MODEL = 'test-model-family/model-v1';
const TEST_HINTS = [
    { text: 'Do not do X.' },
    { text: 'Always do Y instead.' },
];
const TEST_HINT_TEXTS = TEST_HINTS.map(hint => hint.text);

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
        expect(getModelHints(TEST_MODEL)).toEqual(TEST_HINT_TEXTS);
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
            'minimax/': ['hint M'],
        });
        expect(getModelHints('qwen/qwen3-coder')).toEqual([]);
    });

    it('filters surface-scoped hints by prompt surface', () => {
        populateHints({
            'zai-org/glm': [
                { text: 'analytical-only', surfaces: ['invoke_analytical'] },
                { text: 'tool-only', surfaces: ['tool_emulation'] },
                { text: 'everywhere' },
            ],
        });

        expect(getModelHints('zai-org/glm-5', 'invoke_analytical')).toEqual([
            'analytical-only',
            'everywhere',
        ]);
        expect(getModelHints('zai-org/glm-5', 'tool_emulation')).toEqual([
            'tool-only',
            'everywhere',
        ]);
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
        for (const hint of TEST_HINT_TEXTS) {
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

    it('does not inject consult-only hints into invoke prompts', () => {
        populateHints({
            'qwen/qwen3': [
                { text: 'invoke hint', surfaces: ['invoke_agentic'] },
                { text: 'consult hint', surfaces: ['consult_context_request'] },
            ],
        });
        const [msg] = buildInvokeSystemMessages({ ...BASE_OPTIONS, model: 'qwen/qwen3-coder-next' });
        expect(contentOf(msg)).toContain('invoke hint');
        expect(contentOf(msg)).not.toContain('consult hint');
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
        for (const hint of TEST_HINT_TEXTS) {
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

    it('does not inject tool-emulation-only hints into analytical prompts', () => {
        populateHints({
            'zai-org/glm': [
                { text: 'ground with tools first', surfaces: ['invoke_analytical'] },
                { text: 'entire response must be only JSON', surfaces: ['tool_emulation'] },
            ],
        });
        const [msg] = buildAnalyticalSystemMessages({ ...BASE_OPTIONS, model: 'zai-org/glm-5' });
        expect(contentOf(msg)).toContain('ground with tools first');
        expect(contentOf(msg)).not.toContain('entire response must be only JSON');
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
        for (const hint of TEST_HINT_TEXTS) {
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

    it('does not inject consult finalization hints into synthesis prompts', () => {
        populateHints({
            'qwen/qwen3': [
                { text: 'synthesis hint', surfaces: ['invoke_synthesis'] },
                { text: 'finalize in markdown only', surfaces: ['consult_finalization'] },
            ],
        });
        const [msg] = buildSynthesisSystemMessages({ ...BASE_OPTIONS, model: 'qwen/qwen3-coder-next' });
        expect(contentOf(msg)).toContain('synthesis hint');
        expect(contentOf(msg)).not.toContain('finalize in markdown only');
    });
});
