import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

/**
 * Mock Anthropic HTTP server for provider tests.
 * Sends responses in the Anthropic Messages API SSE format.
 *
 * Usage:
 *   const server = new MockAnthropicServer();
 *   await server.start();
 *   server.addTextResponse('Hello!', { inputTokens: 10, outputTokens: 5 });
 *   // ... make requests to server.baseUrl ...
 *   await server.stop();
 */

export interface MockAnthropicStreamingConfig {
    inputTokens?: number;
    outputTokens?: number;
    stopReason?: string;
    /** Delay in ms between each SSE event (for idle timeout testing) */
    chunkDelayMs?: number;
}

export interface MockAnthropicErrorResponse {
    type: 'error';
    statusCode: number;
    message: string;
    errorType?: string;
}

export interface MockAnthropicHangResponse {
    type: 'hang';
}

export interface MockAnthropicRawStreamResponse {
    type: 'raw_stream';
    rawBody: string;
    /** Send rawBody then keep connection open (no res.end()) to simulate mid-stream silence */
    hangAfterSend?: boolean;
}

export interface MockAnthropicTextResponse {
    type: 'text';
    text: string;
}

export interface MockAnthropicToolCallResponse {
    type: 'tool_call';
    toolCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }>;
}

export type MockAnthropicResponse =
    | MockAnthropicTextResponse
    | MockAnthropicToolCallResponse
    | MockAnthropicErrorResponse
    | MockAnthropicHangResponse
    | MockAnthropicRawStreamResponse;

export class MockAnthropicServer {
    private server: Server | null = null;
    private responseQueue: Array<{ response: MockAnthropicResponse; config: MockAnthropicStreamingConfig }> = [];
    private requests: Array<{ body: unknown; headers: Record<string, string | string[] | undefined> }> = [];
    private _port = 0;

    get port(): number {
        return this._port;
    }

    get baseUrl(): string {
        return `http://127.0.0.1:${this._port}`;
    }

    get receivedRequests(): Array<{ body: unknown; headers: Record<string, string | string[] | undefined> }> {
        return [...this.requests];
    }

    addResponse(response: MockAnthropicResponse, config: MockAnthropicStreamingConfig = {}): void {
        this.responseQueue.push({ response, config });
    }

    addTextResponse(text: string, config: MockAnthropicStreamingConfig = {}): void {
        this.addResponse({ type: 'text', text }, config);
    }

    addToolCallResponse(
        toolCalls: MockAnthropicToolCallResponse['toolCalls'],
        config: MockAnthropicStreamingConfig = {},
    ): void {
        this.addResponse({ type: 'tool_call', toolCalls }, config);
    }

    addErrorResponse(statusCode: number, message: string, errorType = 'api_error'): void {
        this.addResponse({ type: 'error', statusCode, message, errorType });
    }

    reset(): void {
        this.responseQueue = [];
        this.requests = [];
    }

    async start(): Promise<void> {
        return new Promise((resolve) => {
            this.server = createServer((req, res) => this.handleRequest(req, res));
            this.server.listen(0, '127.0.0.1', () => {
                const addr = this.server!.address();
                if (addr && typeof addr === 'object') {
                    this._port = addr.port;
                }
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.server) {
                resolve();
                return;
            }
            this.server.close((err) => {
                this.server = null;
                if (err) reject(err);
                else resolve();
            });
        });
    }

    private handleRequest(req: IncomingMessage, res: ServerResponse): void {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            let body: unknown;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString());
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    type: 'error',
                    error: {
                        type: 'invalid_request_error',
                        message: 'Invalid JSON request body',
                    },
                }));
                return;
            }
            this.requests.push({
                body,
                headers: req.headers as Record<string, string | string[] | undefined>,
            });

            const queued = this.responseQueue.shift();
            if (!queued) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    type: 'error',
                    error: { type: 'server_error', message: 'No mock response queued' },
                }));
                return;
            }

            const { response, config } = queued;

            if (response.type === 'hang') {
                return; // Don't respond — let client time out
            }

            if (response.type === 'error') {
                res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    type: 'error',
                    error: {
                        type: response.errorType ?? 'api_error',
                        message: response.message,
                    },
                }));
                return;
            }

            if (response.type === 'raw_stream') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                });
                if (response.hangAfterSend) {
                    res.write(response.rawBody);
                    // Don't call res.end() — simulate mid-stream silence
                } else {
                    res.end(response.rawBody);
                }
                return;
            }

            // After hang/error/raw_stream guards, only text and tool_call remain
            this.sendStreamingResponse(
                res,
                response as MockAnthropicTextResponse | MockAnthropicToolCallResponse,
                config,
            );
        });
    }

    private async sendStreamingResponse(
        res: ServerResponse,
        response: MockAnthropicTextResponse | MockAnthropicToolCallResponse,
        config: MockAnthropicStreamingConfig,
    ): Promise<void> {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        const inputTokens = config.inputTokens ?? 10;
        const outputTokens = config.outputTokens ?? 5;
        const chunkDelay = config.chunkDelayMs ?? 0;

        // message_start — includes input token count
        this.writeAnthropicEvent(res, 'message_start', {
            type: 'message_start',
            message: {
                id: 'msg_mock',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'mock-model',
                stop_reason: null,
                usage: { input_tokens: inputTokens, output_tokens: 0 },
            },
        });
        if (chunkDelay > 0) await delay(chunkDelay);

        if (response.type === 'text') {
            // Text content block
            this.writeAnthropicEvent(res, 'content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
            });
            if (chunkDelay > 0) await delay(chunkDelay);

            // Send text in one chunk
            if (response.text.length > 0) {
                this.writeAnthropicEvent(res, 'content_block_delta', {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: response.text },
                });
                if (chunkDelay > 0) await delay(chunkDelay);
            }

            this.writeAnthropicEvent(res, 'content_block_stop', {
                type: 'content_block_stop',
                index: 0,
            });
            if (chunkDelay > 0) await delay(chunkDelay);

            const stopReason = config.stopReason ?? 'end_turn';
            this.writeAnthropicEvent(res, 'message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: outputTokens },
            });
            if (chunkDelay > 0) await delay(chunkDelay);
        } else {
            // Tool call blocks
            for (let i = 0; i < response.toolCalls.length; i++) {
                const tc = response.toolCalls[i];

                this.writeAnthropicEvent(res, 'content_block_start', {
                    type: 'content_block_start',
                    index: i,
                    content_block: {
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.name,
                        input: {},
                    },
                });
                if (chunkDelay > 0) await delay(chunkDelay);

                this.writeAnthropicEvent(res, 'content_block_delta', {
                    type: 'content_block_delta',
                    index: i,
                    delta: {
                        type: 'input_json_delta',
                        partial_json: JSON.stringify(tc.arguments),
                    },
                });
                if (chunkDelay > 0) await delay(chunkDelay);

                this.writeAnthropicEvent(res, 'content_block_stop', {
                    type: 'content_block_stop',
                    index: i,
                });
                if (chunkDelay > 0) await delay(chunkDelay);
            }

            const stopReason = config.stopReason ?? 'tool_use';
            this.writeAnthropicEvent(res, 'message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: outputTokens },
            });
            if (chunkDelay > 0) await delay(chunkDelay);
        }

        this.writeAnthropicEvent(res, 'message_stop', { type: 'message_stop' });
        res.end();
    }

    private writeAnthropicEvent(res: ServerResponse, eventType: string, data: unknown): void {
        res.write(`event: ${eventType}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
