/**
 * Ambient declaration for vscode-jsonrpc.
 *
 * The package lacks `exports` / `types` fields required by moduleResolution: "NodeNext".
 * This file re-declares the subset of types we use.
 */
declare module 'vscode-jsonrpc' {
    import type { Readable, Writable } from 'node:stream';

    export class StreamMessageReader {
        constructor(readable: Readable, encoding?: string);
    }

    export class StreamMessageWriter {
        constructor(writable: Writable, encoding?: string);
    }

    export interface MessageConnection {
        listen(): void;
        sendRequest(method: string, ...params: unknown[]): Promise<unknown>;
        sendNotification(method: string, ...params: unknown[]): Promise<void>;
        end(): void;
        dispose(): void;
    }

    export function createMessageConnection(
        reader: StreamMessageReader,
        writer: StreamMessageWriter,
    ): MessageConnection;
}
