// --- Stream events (Block 17 tagged union) ---

export interface TextDeltaEvent {
    type: 'text_delta';
    text: string;
}

export interface ToolCallDeltaEvent {
    type: 'tool_call_delta';
    index: number;
    /**
     * Provider-supplied tool-call id, when available. OpenAI-compatible
     * providers send this on the first chunk of each tool call; subsequent
     * chunks for the same call typically omit it. Used by the turn-engine
     * accumulator to detect parallel tool calls that share an `index` but
     * have distinct ids — a non-conformant pattern observed on some NanoGPT
     * gemma backends, which emit several parallel calls all at index 0.
     */
    id?: string;
    name?: string;
    arguments?: string;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
}

export interface DoneEvent {
    type: 'done';
    finishReason: string;
    usage: TokenUsage;
}

export interface StreamErrorEvent {
    type: 'error';
    error: { code: string; message: string };
}

export type StreamEvent = TextDeltaEvent | ToolCallDeltaEvent | DoneEvent | StreamErrorEvent;

// --- Model request ---

export interface ExtensionRequest {
    type: string;
    required: boolean;
    [key: string]: unknown;
}

export interface ModelRequest {
    model: string;
    messages: RequestMessage[];
    tools?: ToolDefinition[];
    maxTokens: number;
    temperature: number;
    topP?: number;
    thinking?: { type: 'enabled' | 'disabled' };
    extensions?: ExtensionRequest[];
}

export interface RequestMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | RequestContentPart[];
    toolCallId?: string;
}

export interface RequestContentPart {
    type: 'text' | 'tool_call' | 'tool_result';
    text?: string;
    toolCallId?: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

// --- Model capabilities ---

export type ToolSupport = 'native' | 'emulated' | 'none';
export type ToolReliability = 'native' | 'good' | 'fair' | 'poor';

export interface ModelCapabilities {
    maxContext: number;
    maxOutput: number;
    supportsTools: ToolSupport;
    supportsVision: boolean;
    supportsStreaming: boolean;
    supportsPrefill: boolean;
    supportsEmbedding: boolean;
    embeddingModels: string[];
    toolReliability: ToolReliability;
    costPerMillion: { input: number; output: number; cachedInput?: number };
    specialFeatures: string[];
    bytesPerToken: number;
}

// --- Result type ---

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface ConfigError {
    code: string;
    message: string;
}

// --- Provider driver interface ---

export interface ProviderConfig {
    name: string;
    driver: string;
    baseUrl: string;
    timeout: number;
    priority: number;
}

export interface EmbeddingResult {
    embeddings: number[][];
    model: string;
    usage: { totalTokens: number };
}

export interface ProviderDriver {
    capabilities(model: string): ModelCapabilities;
    stream(request: ModelRequest): AsyncIterable<StreamEvent>;
    embed?(texts: string[], model: string): Promise<EmbeddingResult>;
    validate(config: ProviderConfig): Result<void, ConfigError>;
}
