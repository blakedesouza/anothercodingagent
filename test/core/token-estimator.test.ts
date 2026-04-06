import { describe, it, expect } from 'vitest';
import {
    estimateTextTokens,
    estimateRequestTokens,
    createCalibrationState,
    updateCalibration,
    computeSafeInputBudget,
    MESSAGE_OVERHEAD,
    TOOL_CALL_OVERHEAD,
    TOOL_SCHEMA_OVERHEAD,
} from '../../src/core/token-estimator.js';
import type { ModelRequest, ToolDefinition } from '../../src/types/provider.js';

// --- estimateTextTokens ---

describe('estimateTextTokens', () => {
    it('empty string → 0 tokens', () => {
        expect(estimateTextTokens('')).toBe(0);
    });

    it('ASCII string "hello" (5 bytes) → ceil(5/3) = 2 tokens', () => {
        expect(estimateTextTokens('hello')).toBe(2); // ceil(5/3) = 2
    });

    it('ASCII string "hello world" (11 bytes) → ceil(11/3) = 4', () => {
        expect(estimateTextTokens('hello world')).toBe(4); // ceil(11/3) = 4
    });

    it('Unicode string with multi-byte chars → correct byte count / 3', () => {
        // "Hello 世界" — "Hello " is 6 bytes, "世界" is 6 bytes (3 each) = 12 bytes total
        const text = 'Hello 世界';
        const byteLen = Buffer.byteLength(text, 'utf8');
        expect(byteLen).toBe(12);
        expect(estimateTextTokens(text)).toBe(Math.ceil(12 / 3)); // 4
    });

    it('emoji string → correct multi-byte handling', () => {
        // "😀" is 4 bytes in UTF-8
        const text = '😀';
        const byteLen = Buffer.byteLength(text, 'utf8');
        expect(byteLen).toBe(4);
        expect(estimateTextTokens(text)).toBe(Math.ceil(4 / 3)); // 2
    });

    it('per-model bytesPerToken override (4.0) → different estimate', () => {
        // "hello" = 5 bytes, with bytesPerToken=4.0 → ceil(5/4) = 2
        expect(estimateTextTokens('hello', 4.0)).toBe(2);
        // "hello world" = 11 bytes, with bytesPerToken=4.0 → ceil(11/4) = 3
        expect(estimateTextTokens('hello world', 4.0)).toBe(3);
    });

    it('per-model bytesPerToken override (2.5) → higher estimate', () => {
        // "hello" = 5 bytes, with bytesPerToken=2.5 → ceil(5/2.5) = 2
        expect(estimateTextTokens('hello', 2.5)).toBe(2);
        // "hello world" = 11 bytes, with bytesPerToken=2.5 → ceil(11/2.5) = 5
        expect(estimateTextTokens('hello world', 2.5)).toBe(5);
    });

    it('bytesPerToken = 0 → throws RangeError', () => {
        expect(() => estimateTextTokens('test', 0)).toThrow(RangeError);
    });

    it('bytesPerToken negative → throws RangeError', () => {
        expect(() => estimateTextTokens('test', -1)).toThrow(RangeError);
    });

    it('bytesPerToken = NaN → throws RangeError', () => {
        expect(() => estimateTextTokens('test', NaN)).toThrow(RangeError);
    });

    it('bytesPerToken = Infinity → throws RangeError', () => {
        expect(() => estimateTextTokens('test', Infinity)).toThrow(RangeError);
    });
});

// --- estimateRequestTokens ---

describe('estimateRequestTokens', () => {
    it('single message → text tokens + message overhead', () => {
        const request: ModelRequest = {
            model: 'test',
            messages: [{ role: 'user', content: 'hello' }],
            maxTokens: 4096,
            temperature: 0.7,
        };
        const textTokens = estimateTextTokens('hello');
        expect(estimateRequestTokens(request)).toBe(textTokens + MESSAGE_OVERHEAD);
    });

    it('message with 3 tool calls → base tokens + 3×24 overhead', () => {
        const request: ModelRequest = {
            model: 'test',
            messages: [{
                role: 'assistant',
                content: [
                    { type: 'tool_call', toolCallId: 'tc1', toolName: 'read_file', arguments: { path: 'a.ts' } },
                    { type: 'tool_call', toolCallId: 'tc2', toolName: 'read_file', arguments: { path: 'b.ts' } },
                    { type: 'tool_call', toolCallId: 'tc3', toolName: 'read_file', arguments: { path: 'c.ts' } },
                ],
            }],
            maxTokens: 4096,
            temperature: 0.7,
        };
        const result = estimateRequestTokens(request);
        // MESSAGE_OVERHEAD + 3 * TOOL_CALL_OVERHEAD + args text tokens
        expect(result).toBeGreaterThanOrEqual(MESSAGE_OVERHEAD + 3 * TOOL_CALL_OVERHEAD);
    });

    it('10 tool schemas → base + 10×40 overhead', () => {
        const tools: ToolDefinition[] = Array.from({ length: 10 }, (_, i) => ({
            name: `tool_${i}`,
            description: `Tool ${i}`,
            parameters: { type: 'object', properties: {} },
        }));
        const request: ModelRequest = {
            model: 'test',
            messages: [{ role: 'user', content: 'hi' }],
            tools,
            maxTokens: 4096,
            temperature: 0.7,
        };
        const result = estimateRequestTokens(request);
        // At minimum: message overhead + text tokens + 10 * schema overhead
        expect(result).toBeGreaterThanOrEqual(MESSAGE_OVERHEAD + 10 * TOOL_SCHEMA_OVERHEAD);
    });

    it('tool_call text is not double-counted with arguments', () => {
        // A tool_call part should only count TOOL_CALL_OVERHEAD + arguments, not part.text
        const request: ModelRequest = {
            model: 'test',
            messages: [{
                role: 'assistant',
                content: [
                    { type: 'tool_call', toolCallId: 'tc1', toolName: 'fn', text: 'some thinking text', arguments: { x: 1 } },
                ],
            }],
            maxTokens: 4096,
            temperature: 0.7,
        };
        const result = estimateRequestTokens(request);
        // Should be: MESSAGE_OVERHEAD + TOOL_CALL_OVERHEAD + args tokens
        // Should NOT include estimateTextTokens('some thinking text')
        const argsTokens = estimateTextTokens(JSON.stringify({ x: 1 }));
        expect(result).toBe(MESSAGE_OVERHEAD + TOOL_CALL_OVERHEAD + argsTokens);
    });

    it('tool_result text is counted correctly', () => {
        const request: ModelRequest = {
            model: 'test',
            messages: [{
                role: 'tool',
                content: [
                    { type: 'tool_result', toolCallId: 'tc1', text: 'result content' },
                ],
            }],
            maxTokens: 4096,
            temperature: 0.7,
        };
        const result = estimateRequestTokens(request);
        const textTokens = estimateTextTokens('result content');
        expect(result).toBe(MESSAGE_OVERHEAD + TOOL_CALL_OVERHEAD + textTokens);
    });

    it('text part counts text correctly', () => {
        const request: ModelRequest = {
            model: 'test',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'hello world' },
                ],
            }],
            maxTokens: 4096,
            temperature: 0.7,
        };
        const result = estimateRequestTokens(request);
        const textTokens = estimateTextTokens('hello world');
        expect(result).toBe(MESSAGE_OVERHEAD + textTokens);
    });

    it('applies calibration multiplier', () => {
        const request: ModelRequest = {
            model: 'test',
            messages: [{ role: 'user', content: 'hello world this is a test message' }],
            maxTokens: 4096,
            temperature: 0.7,
        };
        const base = estimateRequestTokens(request, 3.0, 1.0);
        const calibrated = estimateRequestTokens(request, 3.0, 0.8);
        expect(calibrated).toBeLessThan(base);
        expect(calibrated).toBe(Math.ceil(base * 0.8));
    });
});

// --- EMA Calibration ---

describe('CalibrationState EMA', () => {
    it('initial state: multiplier = 1.0, sampleCount = 0', () => {
        const state = createCalibrationState();
        expect(state.multiplier).toBe(1.0);
        expect(state.sampleCount).toBe(0);
    });

    it('single update: actual=100, estimated=120 → multiplier moves toward 0.833', () => {
        let state = createCalibrationState();
        state = updateCalibration(state, 100, 120);
        // First sample seeds directly: ratio = 100/120 ≈ 0.833
        expect(state.multiplier).toBeCloseTo(100 / 120, 3);
        expect(state.sampleCount).toBe(1);
    });

    it('convergence: 5 consecutive calls with ratio 0.833 → within 5% of 0.833', () => {
        let state = createCalibrationState();
        const targetRatio = 0.833;
        for (let i = 0; i < 5; i++) {
            // actual/estimated = targetRatio → actual = targetRatio * estimated
            state = updateCalibration(state, targetRatio * 100, 100);
        }
        expect(state.multiplier).toBeCloseTo(targetRatio, 1);
        expect(Math.abs(state.multiplier - targetRatio) / targetRatio).toBeLessThan(0.05);
    });

    it('ratio shift: converge at 0.833, then shift to 1.2 → re-converges near 1.2', () => {
        let state = createCalibrationState();
        // Converge at 0.833
        for (let i = 0; i < 5; i++) {
            state = updateCalibration(state, 83.3, 100);
        }
        expect(state.multiplier).toBeCloseTo(0.833, 1);

        // Shift to 1.2 — needs 7 calls to converge from a different value
        for (let i = 0; i < 7; i++) {
            state = updateCalibration(state, 120, 100);
        }
        // After 7 calls at ratio 1.2, should be within 5% of 1.2
        expect(Math.abs(state.multiplier - 1.2) / 1.2).toBeLessThan(0.05);
    });

    it('no provider token count: 5 calls with 0 actual → multiplier stays at 1.0', () => {
        let state = createCalibrationState();
        for (let i = 0; i < 5; i++) {
            state = updateCalibration(state, 0, 100);
        }
        expect(state.multiplier).toBe(1.0);
        expect(state.sampleCount).toBe(0);
    });

    it('mixed availability: 3 calls with data then 2 without → reflects only 3 calls', () => {
        let state = createCalibrationState();
        // 3 calls with ratio 0.8
        for (let i = 0; i < 3; i++) {
            state = updateCalibration(state, 80, 100);
        }
        const afterThree = state.multiplier;
        expect(state.sampleCount).toBe(3);

        // 2 calls with no data (actual=0)
        state = updateCalibration(state, 0, 100);
        state = updateCalibration(state, 0, 100);
        expect(state.multiplier).toBe(afterThree); // unchanged
        expect(state.sampleCount).toBe(3); // unchanged
    });

    it('negative values are ignored', () => {
        let state = createCalibrationState();
        state = updateCalibration(state, -10, 100);
        expect(state.multiplier).toBe(1.0);
        state = updateCalibration(state, 100, -10);
        expect(state.multiplier).toBe(1.0);
    });

    it('NaN values are ignored', () => {
        let state = createCalibrationState();
        state = updateCalibration(state, NaN, 100);
        expect(state.multiplier).toBe(1.0);
        expect(state.sampleCount).toBe(0);
    });

    it('Infinity values are ignored', () => {
        let state = createCalibrationState();
        state = updateCalibration(state, Infinity, 100);
        expect(state.multiplier).toBe(1.0);
        expect(state.sampleCount).toBe(0);
    });
});

// --- Safe input budget ---

describe('computeSafeInputBudget', () => {
    it('200K context, 4096 output → guard = 16000 → budget = 179904', () => {
        const budget = computeSafeInputBudget(200_000, 4096);
        // guard = max(512, ceil(200000 * 0.08)) = max(512, 16000) = 16000
        // budget = 200000 - 4096 - 16000 = 179904
        expect(budget).toBe(179904);
    });

    it('32K context → guard = 2560 → budget = 25344', () => {
        const budget = computeSafeInputBudget(32_000, 4096);
        // guard = max(512, ceil(32000 * 0.08)) = max(512, 2560) = 2560
        // budget = 32000 - 4096 - 2560 = 25344
        expect(budget).toBe(25344);
    });

    it('small context (4K) → guard = 512 (minimum)', () => {
        const budget = computeSafeInputBudget(4000, 4096);
        // guard = max(512, ceil(4000 * 0.08)) = max(512, 320) = 512
        // budget = 4000 - 4096 - 512 = -608 (negative, model can't fit output)
        expect(budget).toBe(-608);
    });

    it('default reserved output is 4096', () => {
        const withDefault = computeSafeInputBudget(200_000);
        const withExplicit = computeSafeInputBudget(200_000, 4096);
        expect(withDefault).toBe(withExplicit);
    });

    it('custom reserved output tokens', () => {
        const budget = computeSafeInputBudget(200_000, 8192);
        // guard = 16000, budget = 200000 - 8192 - 16000 = 175808
        expect(budget).toBe(175808);
    });
});
