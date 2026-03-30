import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

/**
 * Configurable mock NanoGPT HTTP server for provider tests.
 * Supports SSE streaming responses, tool calls, errors, and delays.
 *
 * Usage:
 *   const server = new MockNanoGPTServer();
 *   server.addResponse({ text: 'Hello!' });
 *   await server.start();
 *   // ... make requests to server.baseUrl ...
 *   await server.stop();
 */

export interface MockTextResponse {
    type: 'text';
    text: string;
    delayMs?: number;
    chunkSize?: number;
}

export interface MockToolCallResponse {
    type: 'tool_call';
    toolCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }>;
    delayMs?: number;
}

export interface MockErrorResponse {
    type: 'error';
    statusCode: number;
    errorBody: { error: { message: string; type: string; code: string } };
}

export interface MockStreamingConfig {
    chunkDelayMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    finishReason?: string;
}

export type MockResponse = MockTextResponse | MockToolCallResponse | MockErrorResponse;

export class MockNanoGPTServer {
    private server: Server | null = null;
    private responseQueue: Array<{ response: MockResponse; config: MockStreamingConfig }> = [];
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

    addResponse(response: MockResponse, config: MockStreamingConfig = {}): void {
        this.responseQueue.push({ response, config });
    }

    addTextResponse(text: string, config: MockStreamingConfig = {}): void {
        this.addResponse({ type: 'text', text }, config);
    }

    addToolCallResponse(
        toolCalls: MockToolCallResponse['toolCalls'],
        config: MockStreamingConfig = {},
    ): void {
        this.addResponse({ type: 'tool_call', toolCalls }, config);
    }

    addErrorResponse(statusCode: number, message: string, code: string): void {
        this.addResponse({
            type: 'error',
            statusCode,
            errorBody: { error: { message, type: 'api_error', code } },
        });
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
            const body = JSON.parse(Buffer.concat(chunks).toString());
            this.requests.push({
                body,
                headers: req.headers as Record<string, string | string[] | undefined>,
            });

            const queued = this.responseQueue.shift();
            if (!queued) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'No mock response queued', type: 'server_error', code: 'no_response' } }));
                return;
            }

            const { response, config } = queued;

            if (response.type === 'error') {
                res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response.errorBody));
                return;
            }

            if (body.stream === false) {
                this.sendNonStreamingResponse(res, response, config);
            } else {
                this.sendStreamingResponse(res, response, config);
            }
        });
    }

    private sendNonStreamingResponse(
        res: ServerResponse,
        response: MockTextResponse | MockToolCallResponse,
        config: MockStreamingConfig,
    ): void {
        res.writeHead(200, { 'Content-Type': 'application/json' });

        const choices = response.type === 'text'
            ? [{ index: 0, message: { role: 'assistant', content: response.text }, finish_reason: config.finishReason ?? 'stop' }]
            : [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: response.toolCalls.map((tc, i) => ({
                        id: tc.id,
                        type: 'function',
                        index: i,
                        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                    })),
                },
                finish_reason: config.finishReason ?? 'tool_calls',
            }];

        res.end(JSON.stringify({
            id: 'mock-completion-id',
            object: 'chat.completion',
            model: 'mock-model',
            choices,
            usage: {
                prompt_tokens: config.inputTokens ?? 10,
                completion_tokens: config.outputTokens ?? 5,
                total_tokens: (config.inputTokens ?? 10) + (config.outputTokens ?? 5),
            },
        }));
    }

    private async sendStreamingResponse(
        res: ServerResponse,
        response: MockTextResponse | MockToolCallResponse,
        config: MockStreamingConfig,
    ): Promise<void> {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        const chunkDelay = config.chunkDelayMs ?? response.delayMs ?? 0;

        if (response.type === 'text') {
            const text = response.text;
            const chunkSize = response.chunkSize ?? 10;

            for (let i = 0; i < text.length; i += chunkSize) {
                const chunk = text.slice(i, i + chunkSize);
                const data = {
                    id: 'mock-chunk',
                    object: 'chat.completion.chunk',
                    model: 'mock-model',
                    choices: [{
                        index: 0,
                        delta: { content: chunk },
                        finish_reason: null,
                    }],
                };
                res.write(`data: ${JSON.stringify(data)}\n\n`);
                if (chunkDelay > 0) await delay(chunkDelay);
            }
        } else {
            for (let i = 0; i < response.toolCalls.length; i++) {
                const tc = response.toolCalls[i];
                // Send tool call name
                const nameData = {
                    id: 'mock-chunk',
                    object: 'chat.completion.chunk',
                    model: 'mock-model',
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                id: tc.id,
                                type: 'function',
                                index: i,
                                function: { name: tc.name, arguments: '' },
                            }],
                        },
                        finish_reason: null,
                    }],
                };
                res.write(`data: ${JSON.stringify(nameData)}\n\n`);
                if (chunkDelay > 0) await delay(chunkDelay);

                // Send tool call arguments
                const argsStr = JSON.stringify(tc.arguments);
                const argData = {
                    id: 'mock-chunk',
                    object: 'chat.completion.chunk',
                    model: 'mock-model',
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: i,
                                function: { arguments: argsStr },
                            }],
                        },
                        finish_reason: null,
                    }],
                };
                res.write(`data: ${JSON.stringify(argData)}\n\n`);
                if (chunkDelay > 0) await delay(chunkDelay);
            }
        }

        // Send finish chunk
        const finishReason = response.type === 'text'
            ? (config.finishReason ?? 'stop')
            : (config.finishReason ?? 'tool_calls');

        const finishData = {
            id: 'mock-chunk',
            object: 'chat.completion.chunk',
            model: 'mock-model',
            choices: [{
                index: 0,
                delta: {},
                finish_reason: finishReason,
            }],
            usage: {
                prompt_tokens: config.inputTokens ?? 10,
                completion_tokens: config.outputTokens ?? 5,
                total_tokens: (config.inputTokens ?? 10) + (config.outputTokens ?? 5),
            },
        };
        res.write(`data: ${JSON.stringify(finishData)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
