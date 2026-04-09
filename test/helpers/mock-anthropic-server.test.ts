import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAnthropicServer } from './mock-anthropic-server.js';

describe('MockAnthropicServer', () => {
    let server: MockAnthropicServer;

    beforeEach(() => {
        server = new MockAnthropicServer();
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

    it('returns 400 for malformed JSON instead of crashing', async () => {
        await server.start();

        const res = await fetch(`${server.baseUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{bad json',
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.type).toBe('error');
        expect(body.error.type).toBe('invalid_request_error');
        expect(server.receivedRequests).toHaveLength(0);
    });
});
