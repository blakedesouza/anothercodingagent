/**
 * Generic SSE (Server-Sent Events) stream parser.
 * Reads a fetch Response body and yields parsed SSE data payloads.
 * Reusable across provider drivers.
 */

export interface SSEEvent {
    data: string;
    event?: string;
}

/**
 * Parse an SSE stream from a fetch Response.
 * Yields one SSEEvent per complete SSE event block.
 * Handles partial chunks split across network packets.
 */
export async function* parseSSE(response: Response): AsyncGenerator<SSEEvent> {
    const body = response.body;
    if (!body) {
        throw new Error('Response body is null');
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Normalize CRLF to LF for SSE spec compliance
            buffer = buffer.replace(/\r\n/g, '\n');

            // SSE events are separated by double newlines
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                const eventBlock = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);

                const parsed = parseEventBlock(eventBlock);
                if (parsed) {
                    yield parsed;
                }
            }
        }

        // Flush any remaining partial event in the buffer
        if (buffer.trim()) {
            const parsed = parseEventBlock(buffer);
            if (parsed) {
                yield parsed;
            }
        }
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // Lock already released or reader detached — safe to ignore
        }
    }
}

function parseEventBlock(block: string): SSEEvent | null {
    let data = '';
    let event: string | undefined;

    for (const line of block.split('\n')) {
        if (line.startsWith('data: ')) {
            // Multiple data lines are joined with newlines per SSE spec
            data += (data ? '\n' : '') + line.slice(6);
        } else if (line.startsWith('event: ')) {
            event = line.slice(7);
        }
        // id:, retry:, and comments (lines starting with :) are ignored
    }

    if (!data) return null;
    return { data, event };
}
