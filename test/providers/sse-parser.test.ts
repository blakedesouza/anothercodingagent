import { describe, it, expect } from 'vitest';
import { parseSSE } from '../../src/providers/sse-parser.js';
import type { SSEEvent } from '../../src/providers/sse-parser.js';

/**
 * Create a mock Response with the given body text.
 */
function mockResponse(body: string): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(body));
            controller.close();
        },
    });
    return new Response(stream);
}

async function collectSSE(response: Response): Promise<SSEEvent[]> {
    const events: SSEEvent[] = [];
    for await (const event of parseSSE(response)) {
        events.push(event);
    }
    return events;
}

describe('parseSSE', () => {
    it('parses standard LF-delimited events', async () => {
        const body = 'data: hello\n\ndata: world\n\n';
        const events = await collectSSE(mockResponse(body));
        expect(events).toHaveLength(2);
        expect(events[0].data).toBe('hello');
        expect(events[1].data).toBe('world');
    });

    it('parses CRLF-delimited events (BUG-3 regression)', async () => {
        const body = 'data: hello\r\n\r\ndata: world\r\n\r\n';
        const events = await collectSSE(mockResponse(body));
        expect(events).toHaveLength(2);
        expect(events[0].data).toBe('hello');
        expect(events[1].data).toBe('world');
    });

    it('parses events with event: type field using CRLF', async () => {
        const body = 'event: message_start\r\ndata: {"type":"start"}\r\n\r\n';
        const events = await collectSSE(mockResponse(body));
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe('message_start');
        expect(events[0].data).toBe('{"type":"start"}');
    });

    it('handles mixed LF and CRLF in the same stream', async () => {
        const body = 'data: first\r\n\r\ndata: second\n\n';
        const events = await collectSSE(mockResponse(body));
        expect(events).toHaveLength(2);
        expect(events[0].data).toBe('first');
        expect(events[1].data).toBe('second');
    });
});
