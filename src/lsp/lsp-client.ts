/**
 * LSP Client Adapter — thin wrapper over vscode-jsonrpc for stdio transport.
 *
 * Handles:
 * - Spawning the server process over stdio
 * - Sending initialize/initialized handshake
 * - textDocument/didOpen tracking
 * - Mapping lsp_query operations to LSP request methods
 * - Enforcing per-request timeouts
 *
 * Does NOT use vscode-languageclient (VS Code extension-host assumptions).
 * Uses string-based method names with the raw MessageConnection to avoid
 * type incompatibilities between vscode-jsonrpc and vscode-languageserver-protocol.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    type MessageConnection,
} from 'vscode-jsonrpc';
import type { LspServerConfig } from './server-registry.js';
import { isPathWithin, resolvePathWithInputStyle } from '../core/path-comparison.js';

// --- Constants ---

const INIT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const RESTART_BACKOFF_MS = 1_000;

// --- Types ---

export type LspOperation =
    | 'hover'
    | 'definition'
    | 'references'
    | 'diagnostics'
    | 'symbols'
    | 'completions'
    | 'rename';

export interface LspQueryParams {
    operation: LspOperation;
    file: string;
    line?: number;
    character?: number;
    /** Required for rename operation. */
    newName?: string;
    /** Required for workspace-wide operations with no target file. */
    language?: string;
}

export type LspResult =
    | { kind: 'hover'; contents: string }
    | { kind: 'definition'; locations: SerializedLocation[] }
    | { kind: 'references'; locations: SerializedLocation[] }
    | { kind: 'diagnostics'; diagnostics: SerializedDiagnostic[] }
    | { kind: 'symbols'; symbols: SerializedSymbol[] }
    | { kind: 'completions'; items: SerializedCompletion[] }
    | { kind: 'rename'; edit: unknown };

export interface SerializedLocation {
    uri: string;
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
}

export interface SerializedDiagnostic {
    message: string;
    severity: string;
    range: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
}

export interface SerializedSymbol {
    name: string;
    kind: number;
    range: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
    children?: SerializedSymbol[];
}

export interface SerializedCompletion {
    label: string;
    kind?: number;
    detail?: string;
    insertText?: string;
}

// --- Error types ---

export class LspUnavailableError extends Error {
    readonly installHint: string;
    constructor(serverId: string, installHint: string) {
        super(`LSP server '${serverId}' is not available`);
        this.name = 'LspUnavailableError';
        this.installHint = installHint;
    }
}

export class LspWarmingUpError extends Error {
    constructor(serverId: string) {
        super(`LSP server '${serverId}' is still initializing`);
        this.name = 'LspWarmingUpError';
    }
}

export class LspCrashedError extends Error {
    readonly restartable: boolean;
    constructor(serverId: string, restartable: boolean) {
        super(`LSP server '${serverId}' crashed`);
        this.name = 'LspCrashedError';
        this.restartable = restartable;
    }
}

// --- Client class ---

export type ClientState = 'stopped' | 'starting' | 'ready' | 'crashed';

export class LspClient {
    readonly config: LspServerConfig;
    readonly workspaceRoot: string;

    private connection: MessageConnection | null = null;
    private serverProcess: ChildProcess | null = null;
    private _state: ClientState = 'stopped';
    private crashCount = 0;
    private initPromise: Promise<void> | null = null;
    private readonly openDocuments = new Set<string>();

    /** Injected for testing — override to control process spawning. */
    spawnFn: typeof spawn;

    constructor(config: LspServerConfig, workspaceRoot: string, spawnFn?: typeof spawn) {
        this.config = config;
        this.workspaceRoot = workspaceRoot;
        this.spawnFn = spawnFn ?? spawn;
    }

    get state(): ClientState {
        return this._state;
    }

    get crashes(): number {
        return this.crashCount;
    }

    /**
     * Start the LSP server. If already started/starting, returns the existing init promise.
     * Throws LspUnavailableError if the binary is not found.
     * Throws LspWarmingUpError if initialization exceeds INIT_TIMEOUT_MS.
     */
    async start(): Promise<void> {
        if (this._state === 'ready') return;
        if (this._state === 'starting' && this.initPromise) return this.initPromise;

        this._state = 'starting';
        this.initPromise = this.doStart();

        try {
            await this.initPromise;
        } catch (err) {
            this.initPromise = null;
            throw err;
        }
    }

    /**
     * Execute an LSP query on a file. Ensures the document is opened first.
     * Caller must call start() before query().
     */
    async query(params: LspQueryParams): Promise<LspResult> {
        if (this._state !== 'ready' || !this.connection) {
            throw new Error(`LSP client not ready (state: ${this._state})`);
        }

        // Defense-in-depth: ensure file stays within workspace
        const resolvedFile = resolvePathWithInputStyle(this.workspaceRoot, params.file);
        if (!isPathWithin(this.workspaceRoot, resolvedFile)) {
            throw new Error(`Path traversal denied: ${params.file}`);
        }

        const fileUri = pathToFileURL(resolvedFile).toString();

        // Ensure document is open
        await this.ensureDocumentOpen(fileUri, params.file);

        const textDocument = { uri: fileUri };
        const position = {
            line: (params.line ?? 1) - 1, // Convert 1-indexed to 0-indexed
            character: (params.character ?? 1) - 1,
        };

        switch (params.operation) {
            case 'hover':
                return this.doHover(textDocument, position);
            case 'definition':
                return this.doDefinition(textDocument, position);
            case 'references':
                return this.doReferences(textDocument, position);
            case 'diagnostics':
                return this.doDiagnostics();
            case 'symbols':
                return this.doSymbols(textDocument);
            case 'completions':
                return this.doCompletions(textDocument, position);
            case 'rename':
                return this.doRename(textDocument, position, params.newName ?? 'newName');
        }
    }

    /** Stop the server and clean up resources. */
    async dispose(): Promise<void> {
        this._state = 'stopped';
        this.openDocuments.clear();
        if (this.connection) {
            try {
                this.connection.end();
            } catch { /* ignore */ }
            this.connection = null;
        }
        if (this.serverProcess && !this.serverProcess.killed) {
            this.serverProcess.kill('SIGTERM');
            this.serverProcess = null;
        }
    }

    /**
     * Handle a server crash. Increments crash count.
     * Returns true if a restart is allowed (first crash only).
     */
    handleCrash(): boolean {
        this.crashCount++;
        this._state = 'crashed';
        this.initPromise = null;
        if (this.connection) {
            try { this.connection.end(); } catch { /* ignore */ }
            this.connection = null;
        }
        if (this.serverProcess && !this.serverProcess.killed) {
            this.serverProcess.kill('SIGTERM');
        }
        this.serverProcess = null;
        this.openDocuments.clear();
        return this.crashCount < 2;
    }

    // --- Private implementation ---

    private async doStart(): Promise<void> {
        // Spawn the server process
        let proc: ChildProcess;
        try {
            proc = this.spawnFn(this.config.command, [...this.config.args], {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: this.workspaceRoot,
            });
        } catch {
            this._state = 'stopped';
            throw new LspUnavailableError(this.config.serverId, this.config.installHint);
        }

        // Check if spawn failed immediately (e.g., command not found)
        const spawnError = await new Promise<Error | null>((resolve) => {
            const onError = (err: Error) => {
                proc.removeListener('error', onError);
                resolve(err);
            };
            proc.once('error', onError);
            // Give a brief window for spawn errors (ENOENT fires quickly,
            // but 500ms covers slow PATH lookups on network mounts)
            setTimeout(() => {
                proc.removeListener('error', onError);
                resolve(null);
            }, 500);
        });

        if (spawnError) {
            this._state = 'stopped';
            throw new LspUnavailableError(this.config.serverId, this.config.installHint);
        }

        if (!proc.stdout || !proc.stdin) {
            this._state = 'stopped';
            proc.kill('SIGTERM');
            throw new LspUnavailableError(this.config.serverId, this.config.installHint);
        }

        this.serverProcess = proc;

        // Consume stderr to prevent backpressure (we don't use LSP stderr output)
        if (proc.stderr) {
            proc.stderr.resume();
        }

        // Set up crash handler — idempotent, state-aware
        proc.on('exit', () => {
            if (this._state === 'ready') {
                this._state = 'crashed';
            }
            // Don't touch state during 'starting' — let the init timeout handler
            // or the initialize response handler manage the transition.
            // Don't touch 'stopped' — dispose() already handled cleanup.
        });

        // Create JSON-RPC connection over stdio
        const reader = new StreamMessageReader(proc.stdout);
        const writer = new StreamMessageWriter(proc.stdin);
        this.connection = createMessageConnection(reader, writer);
        this.connection.listen();

        // Send initialize request with timeout
        const initParams = {
            processId: process.pid,
            capabilities: {
                textDocument: {
                    hover: { contentFormat: ['plaintext', 'markdown'] },
                    definition: { linkSupport: false },
                    references: {},
                    documentSymbol: {
                        hierarchicalDocumentSymbolSupport: true,
                    },
                    completion: {
                        completionItem: { snippetSupport: false },
                    },
                    rename: { prepareSupport: false },
                },
            },
            rootUri: pathToFileURL(this.workspaceRoot).toString(),
            workspaceFolders: [
                { uri: pathToFileURL(this.workspaceRoot).toString(), name: 'workspace' },
            ],
        };

        try {
            await withTimeout(
                this.connection.sendRequest('initialize', initParams),
                INIT_TIMEOUT_MS,
            );
        } catch (err) {
            if (err instanceof TimeoutError) {
                // Keep process alive so next query hits a warm server (spec requirement).
                // Do NOT call dispose() — the server is still initializing.
                this._state = 'starting';
                this.initPromise = null;
                throw new LspWarmingUpError(this.config.serverId);
            }
            await this.dispose();
            throw err;
        }

        // Send initialized notification
        await this.connection.sendNotification('initialized', {});
        this._state = 'ready';
        this.initPromise = null;
    }

    private async ensureDocumentOpen(uri: string, relPath: string): Promise<void> {
        if (this.openDocuments.has(uri)) return;
        if (!this.connection) return;

        let content: string;
        try {
            content = await readFile(resolve(this.workspaceRoot, relPath), 'utf-8');
        } catch {
            content = '';
        }

        // Determine languageId from file extension
        const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
        const languageId = EXT_TO_LANGUAGE_ID[ext] ?? ext;

        await this.connection.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri,
                languageId,
                version: 1,
                text: content,
            },
        });
        this.openDocuments.add(uri);
    }

    private async doHover(
        textDocument: { uri: string },
        position: { line: number; character: number },
    ): Promise<LspResult> {
        const result = await withTimeout(
            this.connection!.sendRequest('textDocument/hover', { textDocument, position }),
            REQUEST_TIMEOUT_MS,
        ) as HoverResponse | null;

        if (!result) {
            return { kind: 'hover', contents: '' };
        }

        return { kind: 'hover', contents: extractHoverContents(result) };
    }

    private async doDefinition(
        textDocument: { uri: string },
        position: { line: number; character: number },
    ): Promise<LspResult> {
        const result = await withTimeout(
            this.connection!.sendRequest('textDocument/definition', { textDocument, position }),
            REQUEST_TIMEOUT_MS,
        );

        return { kind: 'definition', locations: serializeLocations(result) };
    }

    private async doReferences(
        textDocument: { uri: string },
        position: { line: number; character: number },
    ): Promise<LspResult> {
        const result = await withTimeout(
            this.connection!.sendRequest('textDocument/references', {
                textDocument,
                position,
                context: { includeDeclaration: true },
            }),
            REQUEST_TIMEOUT_MS,
        );

        return { kind: 'references', locations: serializeLocations(result) };
    }

    private async doDiagnostics(): Promise<LspResult> {
        // Diagnostics are push-based in LSP (textDocument/publishDiagnostics).
        // For v1, return empty. Proper implementation would collect from notifications.
        return { kind: 'diagnostics', diagnostics: [] };
    }

    private async doSymbols(textDocument: { uri: string }): Promise<LspResult> {
        const result = await withTimeout(
            this.connection!.sendRequest('textDocument/documentSymbol', { textDocument }),
            REQUEST_TIMEOUT_MS,
        ) as SymbolResponse[] | null;

        if (!result || !Array.isArray(result)) {
            return { kind: 'symbols', symbols: [] };
        }

        return { kind: 'symbols', symbols: serializeSymbols(result) };
    }

    private async doCompletions(
        textDocument: { uri: string },
        position: { line: number; character: number },
    ): Promise<LspResult> {
        const result = await withTimeout(
            this.connection!.sendRequest('textDocument/completion', { textDocument, position }),
            REQUEST_TIMEOUT_MS,
        ) as CompletionResponse | null;

        if (!result) {
            return { kind: 'completions', items: [] };
        }

        const items: CompletionResponseItem[] = Array.isArray(result)
            ? result
            : (result as { items: CompletionResponseItem[] }).items;

        return {
            kind: 'completions',
            items: items.map(i => ({
                label: i.label,
                kind: i.kind,
                detail: i.detail,
                insertText: i.insertText,
            })),
        };
    }

    private async doRename(
        textDocument: { uri: string },
        position: { line: number; character: number },
        newName: string,
    ): Promise<LspResult> {
        const result = await withTimeout(
            this.connection!.sendRequest('textDocument/rename', { textDocument, position, newName }),
            REQUEST_TIMEOUT_MS,
        );

        // Return preview only — do not apply
        return { kind: 'rename', edit: result ?? { changes: {} } };
    }
}

// --- LSP response shapes (minimal, for typing raw JSON-RPC results) ---

interface HoverResponse {
    contents: string | { kind: string; value: string } | Array<string | { language: string; value: string }>;
}

interface LocationResponse {
    uri: string;
    range: RangeResponse;
}

interface LocationLinkResponse {
    targetUri: string;
    targetRange: RangeResponse;
}

interface RangeResponse {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

interface SymbolResponse {
    name: string;
    kind: number;
    range?: RangeResponse;
    location?: { uri: string; range: RangeResponse };
    children?: SymbolResponse[];
}

type CompletionResponse =
    | CompletionResponseItem[]
    | { items: CompletionResponseItem[] };

interface CompletionResponseItem {
    label: string;
    kind?: number;
    detail?: string;
    insertText?: string;
}

// --- Extension-to-languageId mapping ---

const EXT_TO_LANGUAGE_ID: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    py: 'python',
    pyi: 'python',
    rs: 'rust',
    go: 'go',
    c: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    cxx: 'cpp',
    h: 'c',
    hh: 'cpp',
    hpp: 'cpp',
    hxx: 'cpp',
    lua: 'lua',
    zig: 'zig',
};

// --- Helpers ---

function extractHoverContents(hover: HoverResponse): string {
    const c = hover.contents;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
        return c.map(item => (typeof item === 'string' ? item : item.value)).join('\n');
    }
    if (typeof c === 'object' && 'value' in c) return c.value;
    return '';
}

function serializeLocations(result: unknown): SerializedLocation[] {
    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    return items.map((item: LocationResponse | LocationLinkResponse) => {
        if ('targetUri' in item) {
            const link = item as LocationLinkResponse;
            return {
                uri: link.targetUri,
                startLine: link.targetRange.start.line + 1,
                startCharacter: link.targetRange.start.character + 1,
                endLine: link.targetRange.end.line + 1,
                endCharacter: link.targetRange.end.character + 1,
            };
        }
        const loc = item as LocationResponse;
        return {
            uri: loc.uri,
            startLine: loc.range.start.line + 1,
            startCharacter: loc.range.start.character + 1,
            endLine: loc.range.end.line + 1,
            endCharacter: loc.range.end.character + 1,
        };
    });
}

function serializeSymbols(result: SymbolResponse[]): SerializedSymbol[] {
    return result.map(sym => {
        // DocumentSymbol (hierarchical) has range directly
        if (sym.range) {
            return {
                name: sym.name,
                kind: sym.kind,
                range: {
                    startLine: sym.range.start.line + 1,
                    startCharacter: sym.range.start.character + 1,
                    endLine: sym.range.end.line + 1,
                    endCharacter: sym.range.end.character + 1,
                },
                children: sym.children ? serializeSymbols(sym.children) : undefined,
            };
        }
        // SymbolInformation (flat) has location.range
        if (sym.location) {
            return {
                name: sym.name,
                kind: sym.kind,
                range: {
                    startLine: sym.location.range.start.line + 1,
                    startCharacter: sym.location.range.start.character + 1,
                    endLine: sym.location.range.end.line + 1,
                    endCharacter: sym.location.range.end.character + 1,
                },
            };
        }
        // Fallback — shouldn't happen
        return {
            name: sym.name,
            kind: sym.kind,
            range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
        };
    });
}

class TimeoutError extends Error {
    constructor(ms: number) {
        super(`Operation timed out after ${ms}ms`);
        this.name = 'TimeoutError';
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
        promise
            .then(result => {
                clearTimeout(timer);
                resolve(result);
            })
            .catch(err => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

export { TimeoutError, INIT_TIMEOUT_MS, REQUEST_TIMEOUT_MS, RESTART_BACKOFF_MS };
