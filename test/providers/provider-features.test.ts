/**
 * Tests for provider-level features: extension checking across all drivers.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicDriver } from '../../src/providers/anthropic-driver.js';
import { OpenAiDriver } from '../../src/providers/openai-driver.js';
import { NanoGptDriver } from '../../src/providers/nanogpt-driver.js';
import type { ModelRequest, StreamEvent } from '../../src/types/provider.js';

// --- Helpers ---

async function collectStream(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const ev of stream) events.push(ev);
    return events;
}

function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
    return {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 100,
        temperature: 0.0,
        ...overrides,
    };
}

// --- AnthropicDriver extension tests ---

describe('AnthropicDriver — extension checking', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns llm.unsupported_feature for required unsupported extension', async () => {
        const driver = new AnthropicDriver({ apiKey: 'test-key' });
        const request = makeRequest({
            extensions: [{ type: 'openai-reasoning', required: true }],
        });

        const events = await collectStream(driver.stream(request));
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('error');
        if (events[0].type === 'error') {
            expect(events[0].error.code).toBe('llm.unsupported_feature');
            expect(events[0].error.message).toContain('openai-reasoning');
        }
    });

    it('logs warning and proceeds for optional unsupported extension', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // The driver will try to make a real HTTP request, but we only care that
        // no error is yielded immediately — if the stream tries to fetch, it will
        // fail with a connection error (not unsupported_feature).
        const driver = new AnthropicDriver({ apiKey: 'test-key', timeout: 50 });
        const request = makeRequest({
            extensions: [{ type: 'openai-reasoning', required: false }],
        });

        // Start the stream — extension warning should fire synchronously before the fetch.
        // We only need to see the warn was called before any network attempt.
        const stream = driver.stream(request);
        // Grab one event to trigger the method body; it may be an error (timeout/network)
        // but NOT llm.unsupported_feature.
        const first = await stream.next();
        // Drain the rest to avoid resource leaks
        if (!first.done) {
            for await (const _ of { [Symbol.asyncIterator]: () => stream }) { break; }
        }

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('openai-reasoning'),
        );
        // The error (if any) must NOT be unsupported_feature
        if (!first.done && first.value?.type === 'error') {
            expect((first.value as { type: 'error'; error: { code: string } }).error.code).not.toBe('llm.unsupported_feature');
        }
    });

    it('does not error for supported extensions', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // anthropic-prompt-caching is supported — no error, no warning before fetch
        const driver = new AnthropicDriver({ apiKey: 'test-key', timeout: 50 });
        const request = makeRequest({
            extensions: [{ type: 'anthropic-prompt-caching', required: true }],
        });

        const events: StreamEvent[] = [];
        try {
            for await (const ev of driver.stream(request)) {
                events.push(ev);
                if (ev.type === 'error' || ev.type === 'done') break;
            }
        } catch { /* network failure is expected */ }

        const unsupportedErrors = events.filter(
            e => e.type === 'error' &&
                (e as { type: 'error'; error: { code: string } }).error.code === 'llm.unsupported_feature',
        );
        expect(unsupportedErrors).toHaveLength(0);
        expect(warnSpy).not.toHaveBeenCalled();
    });
});

// --- OpenAiDriver extension tests ---

describe('OpenAiDriver — extension checking', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns llm.unsupported_feature for required unsupported extension', async () => {
        const driver = new OpenAiDriver({ apiKey: 'test-key' });
        const request = makeRequest({
            model: 'gpt-4o',
            extensions: [{ type: 'anthropic-prompt-caching', required: true }],
        });

        const events = await collectStream(driver.stream(request));
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('error');
        if (events[0].type === 'error') {
            expect(events[0].error.code).toBe('llm.unsupported_feature');
            expect(events[0].error.message).toContain('anthropic-prompt-caching');
        }
    });

    it('logs warning and proceeds for optional unsupported extension', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const driver = new OpenAiDriver({ apiKey: 'test-key', timeout: 50 });
        const request = makeRequest({
            model: 'gpt-4o',
            extensions: [{ type: 'claude-extended-thinking', required: false }],
        });

        const stream = driver.stream(request);
        const first = await stream.next();
        if (!first.done) {
            for await (const _ of { [Symbol.asyncIterator]: () => stream }) { break; }
        }

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('claude-extended-thinking'),
        );
        if (!first.done && first.value?.type === 'error') {
            expect((first.value as { type: 'error'; error: { code: string } }).error.code).not.toBe('llm.unsupported_feature');
        }
    });
});

// --- NanoGptDriver extension tests ---

describe('NanoGptDriver — extension checking', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns llm.unsupported_feature for any required extension (NanoGPT supports none)', async () => {
        const driver = new NanoGptDriver({ apiKey: 'test-key' });
        const request = makeRequest({
            model: 'claude-sonnet-4-20250514',
            extensions: [{ type: 'anthropic-prompt-caching', required: true }],
        });

        const events = await collectStream(driver.stream(request));
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('error');
        if (events[0].type === 'error') {
            expect(events[0].error.code).toBe('llm.unsupported_feature');
        }
    });

    it('logs warning and proceeds for optional extension', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const driver = new NanoGptDriver({ apiKey: 'test-key', timeout: 50 });
        const request = makeRequest({
            model: 'claude-sonnet-4-20250514',
            extensions: [{ type: 'anthropic-prompt-caching', required: false }],
        });

        const stream = driver.stream(request);
        const first = await stream.next();
        if (!first.done) {
            for await (const _ of { [Symbol.asyncIterator]: () => stream }) { break; }
        }

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('anthropic-prompt-caching'),
        );
        if (!first.done && first.value?.type === 'error') {
            expect((first.value as { type: 'error'; error: { code: string } }).error.code).not.toBe('llm.unsupported_feature');
        }
    });

    it('proceeds normally when no extensions are specified', async () => {
        const driver = new NanoGptDriver({ apiKey: 'test-key', timeout: 50 });
        const request = makeRequest({ model: 'claude-sonnet-4-20250514' });

        const events: StreamEvent[] = [];
        try {
            for await (const ev of driver.stream(request)) {
                events.push(ev);
                if (ev.type === 'error' || ev.type === 'done') break;
            }
        } catch { /* expected: network unavailable in test */ }

        const unsupportedErrors = events.filter(
            e => e.type === 'error' &&
                (e as { type: 'error'; error: { code: string } }).error.code === 'llm.unsupported_feature',
        );
        expect(unsupportedErrors).toHaveLength(0);
    });
});
