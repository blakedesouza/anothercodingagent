import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockNanoGPTServer } from './mock-nanogpt-server.js';

describe('MockNanoGPTServer', () => {
    let server: MockNanoGPTServer;

    beforeEach(async () => {
        server = new MockNanoGPTServer();
    });

    afterEach(async () => {
        await server.stop();
    });

    it('starts and stops cleanly', async () => {
        await server.start();
        expect(server.port).toBeGreaterThan(0);
        expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        await server.stop();
    });

    it('returns text response via SSE streaming', async () => {
        server.addTextResponse('Hello, world!');
        await server.start();

        const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'mock-model',
                messages: [{ role: 'user', content: 'Hi' }],
                stream: true,
            }),
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream');

        const text = await res.text();
        // Reassemble content from SSE chunks
        const contentParts = text
            .split('\n')
            .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
            .map((line) => {
                const parsed = JSON.parse(line.slice(6));
                return parsed.choices?.[0]?.delta?.content ?? '';
            });
        expect(contentParts.join('')).toBe('Hello, world!');
        expect(text).toContain('data: [DONE]');
    });

    it('returns non-streaming response when stream=false', async () => {
        server.addTextResponse('Non-streamed');
        await server.start();

        const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'mock-model',
                messages: [{ role: 'user', content: 'Hi' }],
                stream: false,
            }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.choices[0].message.content).toBe('Non-streamed');
        expect(body.choices[0].finish_reason).toBe('stop');
    });

    it('returns tool call response via SSE streaming', async () => {
        server.addToolCallResponse([
            { id: 'call_123', name: 'read_file', arguments: { path: '/tmp/test.txt' } },
        ]);
        await server.start();

        const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'mock-model',
                messages: [{ role: 'user', content: 'Read a file' }],
                stream: true,
            }),
        });

        const text = await res.text();
        expect(text).toContain('read_file');
        expect(text).toContain('call_123');
        expect(text).toContain('tool_calls');
    });

    it('returns error response', async () => {
        server.addErrorResponse(429, 'Rate limited', 'rate_limit_exceeded');
        await server.start();

        const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'mock-model',
                messages: [{ role: 'user', content: 'Hi' }],
            }),
        });

        expect(res.status).toBe(429);
        const body = await res.json();
        expect(body.error.code).toBe('rate_limit_exceeded');
    });

    it('queues multiple responses in order', async () => {
        server.addTextResponse('First');
        server.addTextResponse('Second');
        await server.start();

        const url = `${server.baseUrl}/v1/chat/completions`;
        const opts = {
            method: 'POST' as const,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: 'Hi' }], stream: false }),
        };

        const res1 = await fetch(url, opts);
        const body1 = await res1.json();
        expect(body1.choices[0].message.content).toBe('First');

        const res2 = await fetch(url, opts);
        const body2 = await res2.json();
        expect(body2.choices[0].message.content).toBe('Second');
    });

    it('records received requests', async () => {
        server.addTextResponse('OK');
        await server.start();

        await fetch(`${server.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer test-key',
            },
            body: JSON.stringify({
                model: 'test-model',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: false,
            }),
        });

        expect(server.receivedRequests).toHaveLength(1);
        const req = server.receivedRequests[0];
        expect((req.body as Record<string, unknown>).model).toBe('test-model');
        expect(req.headers['authorization']).toBe('Bearer test-key');
    });

    it('returns 500 when no responses queued', async () => {
        await server.start();

        const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'mock-model', messages: [] }),
        });

        expect(res.status).toBe(500);
    });

    it('returns 400 for malformed JSON instead of crashing', async () => {
        await server.start();

        const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{bad json',
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.code).toBe('invalid_json');
        expect(server.receivedRequests).toHaveLength(0);
    });

    it('reset clears responses and requests', async () => {
        server.addTextResponse('Will be cleared');
        await server.start();

        server.reset();
        expect(server.receivedRequests).toHaveLength(0);

        const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'mock-model', messages: [] }),
        });

        expect(res.status).toBe(500); // No queued responses
    });
});
