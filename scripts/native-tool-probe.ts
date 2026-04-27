#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { loadSecrets } from '../src/config/secrets.ts';

const DEFAULT_BASE_URL = 'https://nano-gpt.com/api/subscription/v1';
const DEFAULT_OUT = `/tmp/aca-native-tool-probe-${Date.now()}.json`;
const DEFAULT_MODELS = [
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
];

type ToolChoice = 'auto' | 'required' | 'none';

interface Args {
    models: string[];
    out: string;
    baseUrl: string;
}

interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | null;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
}

interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

interface ProbeScenario {
    id: string;
    stream: boolean;
    toolChoice: ToolChoice;
    parallelToolCalls: boolean;
    messages: ChatMessage[];
}

interface ProbeRequest {
    model: string;
    messages: ChatMessage[];
    tools?: unknown[];
    tool_choice: ToolChoice;
    parallel_tool_calls?: boolean;
    stream: boolean;
    stream_options?: { include_usage: boolean };
    temperature: number;
    max_tokens: number;
}

interface ProbeObservation {
    model: string;
    scenario: string;
    stream: boolean;
    toolChoice: ToolChoice;
    httpStatus: number | null;
    finishReason: string | null;
    classification: string;
    content: string;
    toolCalls: ToolCall[];
    rawShape: {
        requestMessages: Array<Record<string, unknown>>;
        responseKeys: string[];
        choiceKeys: string[];
        messageKeys: string[];
        firstDeltaKeys: string[];
    };
    error?: string;
}

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'add',
            description: 'Add two numbers.',
            parameters: {
                type: 'object',
                properties: {
                    a: { type: 'number' },
                    b: { type: 'number' },
                },
                required: ['a', 'b'],
                additionalProperties: false,
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lookup_fact',
            description: 'Look up a named fact from a tiny local table.',
            parameters: {
                type: 'object',
                properties: {
                    key: { type: 'string' },
                },
                required: ['key'],
                additionalProperties: false,
            },
        },
    },
];

function parseArgs(argv: string[]): Args {
    const args: Args = {
        models: [...DEFAULT_MODELS],
        out: DEFAULT_OUT,
        baseUrl: process.env.NANOGPT_BASE_URL ?? DEFAULT_BASE_URL,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--models') {
            args.models = String(argv[index + 1] ?? '')
                .split(',')
                .map(value => value.trim())
                .filter(Boolean);
            index += 1;
        } else if (arg === '--out') {
            args.out = resolve(argv[index + 1] ?? args.out);
            index += 1;
        } else if (arg === '--base-url') {
            args.baseUrl = String(argv[index + 1] ?? args.baseUrl).replace(/\/$/, '');
            index += 1;
        } else if (arg === '--help') {
            process.stdout.write(`Usage: node --import tsx scripts/native-tool-probe.ts [options]

Options:
  --models <list>       Comma-separated NanoGPT model IDs
  --out <path>          JSON output path (default: ${DEFAULT_OUT})
  --base-url <url>      Chat completions base URL (default: ${DEFAULT_BASE_URL})
`);
            process.exit(0);
        }
    }
    return args;
}

function scenarios(): ProbeScenario[] {
    return [
        {
            id: 'nonstream-auto-single',
            stream: false,
            toolChoice: 'auto',
            parallelToolCalls: true,
            messages: [
                { role: 'system', content: 'Use tools when they are needed. Do not answer arithmetic directly.' },
                { role: 'user', content: 'Call the add tool for 19 + 23.' },
            ],
        },
        {
            id: 'stream-auto-single',
            stream: true,
            toolChoice: 'auto',
            parallelToolCalls: true,
            messages: [
                { role: 'system', content: 'Use tools when they are needed. Do not answer arithmetic directly.' },
                { role: 'user', content: 'Call the add tool for 19 + 23.' },
            ],
        },
        {
            id: 'nonstream-required-single',
            stream: false,
            toolChoice: 'required',
            parallelToolCalls: true,
            messages: [
                { role: 'system', content: 'Use the provided tool channel.' },
                { role: 'user', content: 'Call exactly one tool. Use add for 2 + 5.' },
            ],
        },
        {
            id: 'nonstream-parallel',
            stream: false,
            toolChoice: 'auto',
            parallelToolCalls: true,
            messages: [
                { role: 'system', content: 'When two independent facts are requested, call both tools in the same assistant message.' },
                { role: 'user', content: 'Call lookup_fact for alpha and beta. Do not answer in text.' },
            ],
        },
    ];
}

function buildRequest(model: string, scenario: ProbeScenario): ProbeRequest {
    return {
        model,
        messages: scenario.messages,
        tools: TOOLS,
        tool_choice: scenario.toolChoice,
        parallel_tool_calls: scenario.parallelToolCalls,
        stream: scenario.stream,
        ...(scenario.stream ? { stream_options: { include_usage: true } } : {}),
        temperature: 0.1,
        max_tokens: 512,
    };
}

function toolResult(name: string, rawArgs: string): string {
    let args: Record<string, unknown> = {};
    try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
        return JSON.stringify({ status: 'error', error: 'invalid arguments JSON' });
    }
    if (name === 'add') {
        return JSON.stringify({ status: 'success', value: Number(args.a) + Number(args.b) });
    }
    if (name === 'lookup_fact') {
        const table: Record<string, string> = {
            alpha: 'first',
            beta: 'second',
        };
        return JSON.stringify({ status: 'success', value: table[String(args.key)] ?? null });
    }
    return JSON.stringify({ status: 'error', error: `unknown tool ${name}` });
}

function classify(content: string, toolCalls: ToolCall[], error?: string): string {
    const trimmed = content.trim();
    if (error) return 'error';
    if (toolCalls.length > 0 && trimmed.length > 0) return 'mixed_text_and_native_tool_calls';
    if (toolCalls.length > 0) return 'native_tool_calls';
    if (/^\[\s*tool_use\s*:|\{\s*"tool_calls"\s*:|<\s*(?:tool_call|function_calls?|invoke)\b/i.test(trimmed)) {
        return 'pseudo_tool_text';
    }
    if (!trimmed) return 'blank_text';
    return 'text_only';
}

function summarizeRequestMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages.map(message => ({
        role: message.role,
        contentType: message.content === null ? 'null' : typeof message.content,
        hasToolCalls: Array.isArray(message.tool_calls),
        toolCallCount: message.tool_calls?.length ?? 0,
        hasToolCallId: typeof message.tool_call_id === 'string',
    }));
}

async function requestChat(baseUrl: string, apiKey: string, body: ProbeRequest): Promise<{
    status: number;
    json: Record<string, unknown> | null;
    content: string;
    toolCalls: ToolCall[];
    finishReason: string | null;
    firstDeltaKeys: string[];
    error?: string;
}> {
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        return {
            status: response.status,
            json: null,
            content: '',
            toolCalls: [],
            finishReason: null,
            firstDeltaKeys: [],
            error: await response.text(),
        };
    }

    if (body.stream) {
        const text = await response.text();
        return parseStreamingResponse(response.status, text);
    }

    const json = await response.json() as Record<string, unknown>;
    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0] ?? {};
    const message = choice.message as Record<string, unknown> | undefined;
    return {
        status: response.status,
        json,
        content: typeof message?.content === 'string' ? message.content : '',
        toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls as ToolCall[] : [],
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        firstDeltaKeys: [],
    };
}

function parseStreamingResponse(status: number, body: string): {
    status: number;
    json: Record<string, unknown> | null;
    content: string;
    toolCalls: ToolCall[];
    finishReason: string | null;
    firstDeltaKeys: string[];
    error?: string;
} {
    let content = '';
    let finishReason: string | null = null;
    const firstDeltaKeys: string[] = [];
    const toolSlots: Array<{ id?: string; name?: string; arguments: string }> = [];

    for (const block of body.split(/\n\n+/)) {
        const line = block.split('\n').find(item => item.startsWith('data: '));
        if (!line) continue;
        const data = line.slice('data: '.length).trim();
        if (!data || data === '[DONE]') continue;
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
            continue;
        }
        const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
        const choice = choices?.[0];
        if (!choice) continue;
        if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
        const delta = choice.delta as Record<string, unknown> | undefined;
        if (!delta) continue;
        if (firstDeltaKeys.length === 0) firstDeltaKeys.push(...Object.keys(delta).sort());
        if (typeof delta.content === 'string') content += delta.content;
        const rawToolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if (!rawToolCalls) continue;
        for (const raw of rawToolCalls) {
            const index = typeof raw.index === 'number' ? raw.index : 0;
            toolSlots[index] ??= { arguments: '' };
            if (typeof raw.id === 'string') toolSlots[index].id = raw.id;
            const fn = raw.function as Record<string, unknown> | undefined;
            if (typeof fn?.name === 'string') toolSlots[index].name = fn.name;
            if (typeof fn?.arguments === 'string') toolSlots[index].arguments += fn.arguments;
        }
    }

    return {
        status,
        json: null,
        content,
        toolCalls: toolSlots
            .filter(slot => slot.id && slot.name)
            .map(slot => ({
                id: slot.id!,
                type: 'function' as const,
                function: {
                    name: slot.name!,
                    arguments: slot.arguments || '{}',
                },
            })),
        finishReason,
        firstDeltaKeys,
    };
}

function observation(
    model: string,
    scenario: ProbeScenario,
    request: ProbeRequest,
    result: Awaited<ReturnType<typeof requestChat>>,
): ProbeObservation {
    const choices = result.json?.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0] ?? {};
    const message = choice.message as Record<string, unknown> | undefined;
    return {
        model,
        scenario: scenario.id,
        stream: scenario.stream,
        toolChoice: scenario.toolChoice,
        httpStatus: result.status,
        finishReason: result.finishReason,
        classification: classify(result.content, result.toolCalls, result.error),
        content: result.content,
        toolCalls: result.toolCalls,
        rawShape: {
            requestMessages: summarizeRequestMessages(request.messages),
            responseKeys: result.json ? Object.keys(result.json).sort() : [],
            choiceKeys: Object.keys(choice).sort(),
            messageKeys: message ? Object.keys(message).sort() : [],
            firstDeltaKeys: result.firstDeltaKeys,
        },
        ...(result.error ? { error: result.error.slice(0, 2000) } : {}),
    };
}

async function probeContinuation(baseUrl: string, apiKey: string, model: string, first: ProbeObservation): Promise<ProbeObservation | null> {
    if (first.toolCalls.length === 0) return null;
    const messages: ChatMessage[] = [
        { role: 'system', content: 'Use tool results to finish. If more tool information is needed, call another tool.' },
        { role: 'user', content: 'Call add for 19 + 23, then give the final number.' },
        { role: 'assistant', content: null, tool_calls: first.toolCalls },
        ...first.toolCalls.map(call => ({
            role: 'tool' as const,
            tool_call_id: call.id,
            content: toolResult(call.function.name, call.function.arguments),
        })),
    ];
    const scenario: ProbeScenario = {
        id: 'nonstream-continuation-after-tool-result',
        stream: false,
        toolChoice: 'auto',
        parallelToolCalls: true,
        messages,
    };
    const request = buildRequest(model, scenario);
    const result = await requestChat(baseUrl, apiKey, request);
    return observation(model, scenario, request, result);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const { secrets, warnings } = await loadSecrets();
    const apiKey = secrets.nanogpt;
    if (!apiKey) {
        throw new Error('Missing NANOGPT_API_KEY');
    }
    for (const warning of warnings) {
        process.stderr.write(`[native-tool-probe] ${warning}\n`);
    }

    const observations: ProbeObservation[] = [];
    for (const model of args.models) {
        for (const scenario of scenarios()) {
            const request = buildRequest(model, scenario);
            const result = await requestChat(args.baseUrl, apiKey, request);
            const entry = observation(model, scenario, request, result);
            observations.push(entry);
            process.stdout.write(`${entry.classification.padEnd(32)} ${model} :: ${scenario.id} tools=${entry.toolCalls.length} finish=${entry.finishReason ?? 'null'}\n`);
            if (scenario.id === 'nonstream-auto-single') {
                const continuation = await probeContinuation(args.baseUrl, apiKey, model, entry);
                if (continuation) {
                    observations.push(continuation);
                    process.stdout.write(`${continuation.classification.padEnd(32)} ${model} :: ${continuation.scenario} tools=${continuation.toolCalls.length} finish=${continuation.finishReason ?? 'null'}\n`);
                }
            }
        }
    }

    const report = {
        generatedAt: new Date().toISOString(),
        baseUrl: args.baseUrl,
        models: args.models,
        observations,
    };
    await fs.writeFile(args.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
    process.stdout.write(`Output written to ${args.out}\n`);
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
});
