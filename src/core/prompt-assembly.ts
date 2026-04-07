import { arch, platform, release } from 'node:os';
import type {
    ConversationItem,
    TextPart,
    ToolCallPart,
    AssistantPart,
} from '../types/conversation.js';
import type {
    ModelRequest,
    RequestMessage,
    RequestContentPart,
    ToolDefinition,
} from '../types/provider.js';
import type { RegisteredTool } from '../tools/tool-registry.js';
import type { ProjectSnapshot } from './project-awareness.js';
import { renderProjectContext } from './project-awareness.js';

// --- Capability health ---

export type CapabilityStatus = 'available' | 'degraded' | 'unavailable';

export interface CapabilityHealth {
    name: string;
    status: CapabilityStatus;
    detail?: string;
}

// --- Working set entry ---

export interface WorkingSetEntry {
    path: string;
    role: string;
}

// --- Durable task state (compact subset for prompt injection) ---

export interface DurableTaskSummary {
    goal?: string;
    confirmedFacts?: string[];
    openLoops?: string[];
    blockers?: string[];
}

// --- Assembly options ---

export interface PromptAssemblyOptions {
    /** Model ID for the request */
    model: string;
    /** Max tokens for model output */
    maxTokens?: number;
    /** Temperature */
    temperature?: number;

    /** All registered tools (will be converted to ToolDefinitions) */
    tools: RegisteredTool[];

    /** Conversation items (full history) */
    items: ConversationItem[];

    /** Project snapshot from project-awareness */
    projectSnapshot?: ProjectSnapshot;

    /** Current working directory */
    cwd: string;

    /** Shell name (e.g., 'bash', 'zsh') */
    shell?: string;

    /** Working set: active files the agent is tracking */
    workingSet?: WorkingSetEntry[];

    /** Capability health statuses */
    capabilities?: CapabilityHealth[];

    /** Durable task state summary for pinned section */
    durableTaskState?: DurableTaskSummary;

    /** Optional repo/user instruction text (resolved, in precedence order) */
    userInstructions?: string;

    /** Active errors from current turn (pinned section — never compressed) */
    activeErrors?: string[];
}

// --- System prompt template ---

const SYSTEM_IDENTITY = `You are ACA (Another Coding Agent), an AI-powered coding assistant that helps users with software engineering tasks.

Rules:
- Read files before modifying them. Understand existing code before suggesting changes.
- Use tools to accomplish tasks. Prefer precise tool calls over asking the user to do things manually.
- Be concise and direct. Lead with the answer or action, not the reasoning.
- When uncertain, use available tools to investigate rather than guessing.

Tool-use policy:
- Call tools when they can help accomplish the task. Do not describe what you would do — do it.
- If multiple tool calls are independent, request them in parallel.
- Respect approval requirements. Do not retry denied tool calls without user guidance.

Instruction precedence (highest to lowest):
1. Core system rules (above)
2. Repository/user instruction files
3. Current user request
4. Durable task state
5. Prior conversation context`;

// --- Builder functions ---

/**
 * Build the per-turn context block as a synthetic system message.
 * Contains runtime facts, project state, working set, capability health,
 * and durable task state. Target: 300-800 tokens.
 */
export function buildContextBlock(options: {
    cwd: string;
    shell?: string;
    projectSnapshot?: ProjectSnapshot;
    workingSet?: WorkingSetEntry[];
    capabilities?: CapabilityHealth[];
    durableTaskState?: DurableTaskSummary;
    userInstructions?: string;
    activeErrors?: string[];
}): string {
    const lines: string[] = [];

    // Runtime facts
    lines.push('--- Environment ---');
    lines.push(`OS: ${platform()} ${release()} (${arch()})`);
    lines.push(`Shell: ${options.shell ?? 'unknown'}`);
    lines.push(`CWD: ${options.cwd}`);

    // Active errors (pinned — never compressed)
    if (options.activeErrors && options.activeErrors.length > 0) {
        lines.push('');
        lines.push('--- Active Errors ---');
        for (const err of options.activeErrors) {
            lines.push(`- ${err}`);
        }
    }

    // Project snapshot
    if (options.projectSnapshot) {
        lines.push('');
        lines.push('--- Project ---');
        lines.push(renderProjectContext(options.projectSnapshot));
    }

    // User/repo instructions
    if (options.userInstructions) {
        lines.push('');
        lines.push('--- Instructions ---');
        lines.push(options.userInstructions);
    }

    // Working set
    if (options.workingSet && options.workingSet.length > 0) {
        lines.push('');
        lines.push('--- Working Set ---');
        for (const entry of options.workingSet) {
            lines.push(`${entry.path} (${entry.role})`);
        }
    }

    // Durable task state
    if (options.durableTaskState) {
        const dts = options.durableTaskState;
        const parts: string[] = [];
        if (dts.goal) parts.push(`Goal: ${dts.goal}`);
        if (dts.confirmedFacts && dts.confirmedFacts.length > 0) {
            parts.push(`Facts: ${dts.confirmedFacts.join('; ')}`);
        }
        if (dts.openLoops && dts.openLoops.length > 0) {
            parts.push(`Open loops: ${dts.openLoops.join('; ')}`);
        }
        if (dts.blockers && dts.blockers.length > 0) {
            parts.push(`Blockers: ${dts.blockers.join('; ')}`);
        }
        if (parts.length > 0) {
            lines.push('');
            lines.push('--- Task State ---');
            lines.push(...parts);
        }
    }

    // Capability health (only non-available)
    if (options.capabilities) {
        const degraded = options.capabilities.filter(c => c.status !== 'available');
        if (degraded.length > 0) {
            lines.push('');
            lines.push('--- Capability Health ---');
            for (const cap of degraded) {
                const detail = cap.detail ? ` — ${cap.detail}` : '';
                lines.push(`${cap.name}: ${cap.status}${detail}`);
            }
        }
    }

    return lines.join('\n');
}

/**
 * Convert registered tools to provider ToolDefinitions.
 */
export function buildToolDefinitions(tools: RegisteredTool[]): ToolDefinition[] {
    return tools.map(tool => ({
        name: tool.spec.name,
        description: tool.spec.description,
        parameters: tool.spec.inputSchema,
    }));
}

/**
 * Convert conversation items to RequestMessages for the LLM.
 */
export function buildConversationMessages(
    items: ConversationItem[],
    scrub?: (text: string) => string,
): RequestMessage[] {
    const messages: RequestMessage[] = [];

    for (const item of items) {
        if (item.kind === 'message') {
            if (item.role === 'system') continue; // system handled separately
            if (item.role === 'user') {
                const rawText = (item.parts as TextPart[])
                    .filter((p): p is TextPart => p.type === 'text')
                    .map(p => p.text)
                    .join('\n');
                const text = scrub ? scrub(rawText) : rawText;
                messages.push({ role: 'user', content: text });
            } else if (item.role === 'assistant') {
                const parts = item.parts as AssistantPart[];
                const textParts = parts.filter((p): p is TextPart => p.type === 'text');
                const toolParts = parts.filter((p): p is ToolCallPart => p.type === 'tool_call');

                if (toolParts.length > 0) {
                    const contentParts: RequestContentPart[] = [];
                    for (const tp of textParts) {
                        contentParts.push({ type: 'text', text: tp.text });
                    }
                    for (const tc of toolParts) {
                        contentParts.push({
                            type: 'tool_call',
                            toolCallId: tc.toolCallId,
                            toolName: tc.toolName,
                            arguments: tc.arguments,
                        });
                    }
                    messages.push({ role: 'assistant', content: contentParts });
                } else {
                    const text = textParts.map(p => p.text).join('\n');
                    messages.push({ role: 'assistant', content: text });
                }
            }
        } else if (item.kind === 'tool_result') {
            const toolData = scrub ? scrub(item.output.data) : item.output.data;
            messages.push({
                role: 'tool',
                content: JSON.stringify({
                    status: item.output.status,
                    data: toolData,
                    error: item.output.error,
                }),
                toolCallId: item.toolCallId,
            });
        } else if (item.kind === 'summary') {
            messages.push({
                role: 'system',
                content: `[Summary of earlier conversation]\n${item.text}`,
            });
        }
    }

    return messages;
}

/**
 * Assemble a complete ModelRequest with the 4-layer prompt structure.
 *
 * Layer 1: System parameter (identity, rules, tool-use policy)
 * Layer 2: Tool definitions (all enabled tools)
 * Layer 3: Per-turn context block (OS, shell, cwd, project, working set, capability health)
 * Layer 4: Conversation history (recent verbatim + older summarized)
 */
export function assemblePrompt(options: PromptAssemblyOptions): ModelRequest {
    // Layer 1: System parameter
    const systemMessage: RequestMessage = {
        role: 'system',
        content: SYSTEM_IDENTITY,
    };

    // Layer 3: Per-turn context block (inserted as second system message)
    const contextBlock = buildContextBlock({
        cwd: options.cwd,
        shell: options.shell,
        projectSnapshot: options.projectSnapshot,
        workingSet: options.workingSet,
        capabilities: options.capabilities,
        durableTaskState: options.durableTaskState,
        userInstructions: options.userInstructions,
        activeErrors: options.activeErrors,
    });
    const contextMessage: RequestMessage = {
        role: 'system',
        content: contextBlock,
    };

    // Layer 4: Conversation history
    const conversationMessages = buildConversationMessages(options.items);

    // Assemble messages: system → context → conversation
    const messages: RequestMessage[] = [
        systemMessage,
        contextMessage,
        ...conversationMessages,
    ];

    // Layer 2: Tool definitions
    const toolDefs = buildToolDefinitions(options.tools);

    return {
        model: options.model,
        messages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        maxTokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
    };
}

// --- Invoke mode prompt (lightweight) ---

export interface InvokePromptOptions {
    /** Working directory */
    cwd: string;
    /** Tool names available to the agent */
    toolNames: string[];
    /** Optional built-in agent profile name applied by invoke. */
    profileName?: string;
    /** Optional built-in agent profile instructions applied by invoke. */
    profilePrompt?: string;
    /** Project snapshot (if available) */
    projectSnapshot?: ProjectSnapshot;
}

/**
 * Build system messages for invoke/delegation mode.
 *
 * Structured prompt for autonomous non-interactive agent loops. Addresses the
 * "empty response with end_turn" stall pattern documented by Anthropic
 * (platform.claude.com/docs/en/api/handling-stop-reasons) and the premature
 * termination pattern documented by OpenAI (cookbook.openai.com/examples/gpt-5/
 * gpt-5_prompting_guide). Sections in order: identity → mode → persistence →
 * tool_preambles → parallel → default_to_action → unavailable_tools → safety →
 * environment → tool_reference → example → closing anchor.
 *
 * Provenance: each section is a direct adaptation of patterns from
 * `docs/research/system-prompt-giants/`. See README.md there for the research
 * synthesis, per-source chapters, and rationale for each block.
 *
 * Target length: ~3-5K tokens. No conversation history, no durable task state,
 * no working set — those belong to the assemblePrompt path, not here.
 */
/** Strip control characters (newlines, tabs, etc.) from paths to prevent prompt injection. */
function sanitizePath(path: string): string {
    return path.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}

function joinToolNames(names: string[]): string {
    return names.length > 0 ? names.join(', ') : 'none';
}

export function buildInvokeSystemMessages(options: InvokePromptOptions): RequestMessage[] {
    const lines: string[] = [];
    const toolSet = new Set(options.toolNames);
    const contextTools = [
        'read_file',
        'find_paths',
        'search_text',
        'stat_path',
        'fetch_url',
        'web_search',
        'lookup_docs',
        'search_semantic',
        'lsp_query',
    ].filter(name => toolSet.has(name));
    const changeTools = [
        'edit_file',
        'write_file',
        'make_directory',
        'move_path',
        'delete_path',
    ].filter(name => toolSet.has(name));
    const verificationTools = [
        'exec_command',
        'open_session',
        'session_io',
        'close_session',
    ].filter(name => toolSet.has(name));
    const unavailableTools = [
        {
            name: 'ask_user',
            description: 'there is no human to respond. Make the decision yourself using the context you have.',
        },
        {
            name: 'confirm_action',
            description: 'there is no human to confirm. If the task description authorizes the action, proceed without confirmation.',
        },
    ].filter(tool => toolSet.has(tool.name));

    // === Identity ===
    // Source: Cline's identity section is 3 lines of grounding per variant.
    // Providing concrete capability priors helps smaller models (Kimi, Qwen)
    // anchor their self-model and reduces "what am I supposed to do" confusion.
    lines.push('You are ACA (Another Coding Agent), an autonomous AI agent running in a sandboxed workspace.');
    if (options.profilePrompt) {
        lines.push(`Active profile: ${options.profileName ?? 'custom'}. Follow this profile over generic coding-agent defaults when they conflict.`);
        lines.push('');
        lines.push('<active_profile>');
        lines.push(options.profilePrompt);
        lines.push('</active_profile>');
    } else {
        lines.push('Default role: coding agent.');
        lines.push('You are skilled at reading and modifying codebases across many languages (TypeScript, Python, Rust, Go, Java, C/C++, and others), using tools to gather context and execute changes, and verifying your work via tests, linters, and type checkers.');
    }
    lines.push('You work methodically: gather the context you need, make the smallest correct set of changes, verify them, and produce a concise final summary.');
    lines.push('');

    // === Operating mode ===
    // Source: closes the gap Cline leaves open. Cline assumes a responsive
    // human; its "wait for user confirmation" framing does not fit autonomous
    // delegation. This block tells the model unambiguously that text without
    // a tool call will end the conversation.
    lines.push('<mode>');
    lines.push('You are running in NON-INTERACTIVE delegation mode. There is no human watching this conversation and no follow-up turn unless you call a tool.');
    lines.push('A response containing only text (no tool calls) ENDS THE CONVERSATION IMMEDIATELY. Treat this as an irreversible decision.');
    lines.push('You cannot ask the user questions. Make decisions yourself based on the task and available context. Document your assumptions in your final summary.');
    lines.push('</mode>');
    lines.push('');

    // === Persistence (OpenAI GPT-5 <persistence> block + GPT-5.1 action bias) ===
    // Source: cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide
    // Directly addresses the "premature termination in minimal-reasoning
    // rollouts" failure mode that OpenAI documents and that ACA observed in
    // M10.2 with both Qwen3-Coder-Next and Kimi-K2.5.
    lines.push('<persistence>');
    lines.push('- You are an agent — keep going until the user\'s task is completely resolved before producing a final summary.');
    lines.push('- Only end your turn with a final text summary when you are sure the problem is solved AND verified (tests/linters run, output checked).');
    lines.push('- Never stop when you encounter uncertainty — research or deduce the most reasonable approach using your tools and continue.');
    lines.push('- Do not ask for confirmation. Decide what the most reasonable assumption is, proceed with it, and document it in your final summary.');
    lines.push('- Be biased for action. If the task is somewhat ambiguous, infer the most useful interpretation and execute it rather than waiting.');
    lines.push('</persistence>');
    lines.push('');

    // === Tool preambles (OpenAI GPT-5 <tool_preambles>, adapted) ===
    // Source: cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide
    // This block is the structural anti-stall mechanism: it accepts that
    // models will narrate their plans and channels that narration into a
    // shape that continues THROUGH tool calls rather than stopping before
    // them. The explicit anti-pattern example is the exact stall text
    // observed in the M10.2 Kimi session.
    lines.push('<tool_preambles>');
    lines.push('For any multi-step task, structure your behavior as:');
    lines.push('1. Restate the goal in 1-2 sentences.');
    if (contextTools.length > 0) {
        lines.push(`2. Gather context using only available context tools: ${joinToolNames(contextTools)}. Call independent reads/searches in PARALLEL when possible.`);
    } else {
        lines.push('2. If no context tools are available, use only the provided prompt/context and state that limitation in your final summary.');
    }
    if (toolSet.has('fetch_url')) {
        lines.push('For web URLs, use fetch_url. read_file is only for local filesystem paths, not HTTP(S) URLs.');
    } else if (toolSet.has('web_search')) {
        lines.push('For web research, use web_search. If exact URL retrieval is required and no URL-fetch tool is listed, state that limitation instead of inventing another tool.');
    }
    if (changeTools.length > 0) {
        lines.push(`3. Immediately after context is gathered, use only available change tools when the task requires edits: ${joinToolNames(changeTools)}. Do NOT describe your plan in prose — execute it via tool calls.`);
    } else {
        lines.push('3. If no change tools are available, do not attempt edits. Complete the read-only task and state the limitation in your final summary.');
    }
    if (verificationTools.length > 0) {
        lines.push(`4. After changes or investigation, verify with available verification tools when relevant: ${joinToolNames(verificationTools)}.`);
    } else {
        lines.push('4. If no verification tools are available, verify by inspecting available evidence and state the limitation in your final summary.');
    }
    if (toolSet.has('exec_command')) {
        lines.push('When using exec_command, omit timeout unless a specific limit is required. If overriding it, provide milliseconds, not seconds.');
    }
    lines.push('5. ONLY after all tool calls are complete and verification has passed, produce your final text summary. That text summary is what ends the turn.');
    lines.push('');
    lines.push('ANTI-PATTERN — this exact text will end the conversation and cause task failure:');
    lines.push('  "Now I have all the context I need. Let me make the modifications: 1. ... 2. ... 3. ..."  [no tool calls]');
    lines.push('If you catch yourself about to write planning prose instead of calling a tool, STOP and call the tool. Your plan lives in tool calls, not in text.');
    lines.push('</tool_preambles>');
    lines.push('');

    // === Parallel tool calls (Anthropic <use_parallel_tool_calls>) ===
    // Source: platform.claude.com/docs/en/docs/agents-and-tools/tool-use/parallel-tool-use
    lines.push('<use_parallel_tool_calls>');
    lines.push('Whenever you perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially. When reading N files, make N read_file calls in the same message. Prefer parallel over sequential whenever the calls do not depend on each other. Never use placeholders or guess missing parameters — if a value depends on a previous tool\'s output, call the tools sequentially.');
    lines.push('</use_parallel_tool_calls>');
    lines.push('');

    // === Default to action (Anthropic <default_to_action>) ===
    // Source: platform.claude.com/docs/en/docs/build-with-claude/prompt-engineering/system-prompts
    lines.push('<default_to_action>');
    lines.push('Implement changes rather than only suggesting them. If intent is unclear, infer the most useful likely action and proceed, using tools to discover any missing details instead of guessing.');
    lines.push('</default_to_action>');
    lines.push('');

    if (unavailableTools.length > 0) {
        // ACA-specific. ask_user and confirm_action exist in the registry but
        // cannot succeed in invoke mode (no human to prompt). Only mention them
        // if they are actually in the visible tool set; otherwise the prompt
        // should not advertise tools the model cannot call.
        lines.push('<unavailable_tools>');
        lines.push('These visible tools will FAIL in this mode. Do NOT attempt them:');
        for (const tool of unavailableTools) {
            lines.push(`- ${tool.name}: ${tool.description}`);
        }
        lines.push('</unavailable_tools>');
        lines.push('');
    }

    // === Safety ===
    // ACA-specific. Prevents the "qwen tried to delete the project root" class
    // of failure. Sandbox catches destructive ops, but prompt-level prevention
    // avoids wasted tool calls and model confusion.
    lines.push('<safety>');
    lines.push('- Only MODIFY files the task explicitly requires you to change. You may freely READ other files for context.');
    lines.push('- Do NOT delete files or directories unless the task explicitly asks for deletion.');
    if (toolSet.has('edit_file')) {
        lines.push('- Do NOT call edit_file with an empty edits array or with a path that is a directory. edit_file operates on individual files with at least one edit.');
    }
    lines.push('- If a file path you need does not exist, do NOT attempt to create parent directories blindly — read the parent directory first to verify the structure.');
    lines.push('</safety>');
    lines.push('');

    // === Tool result discipline ===
    // Source: Anthropic computer-use prompt — "Claude sometimes assumes
    // outcomes of its actions without explicitly checking their results."
    // This is a real failure mode for any tool-using agent, not Claude-specific.
    lines.push('<tool_results>');
    lines.push('- ALWAYS read the actual result of each tool call. Never assume a tool succeeded — check the output.');
    lines.push('- A tool result shaped like `{"status":"success","data":...}` means the tool ran. Check the `data` field to confirm the actual outcome matches what you expected.');
    lines.push('- A tool result shaped like `{"status":"error","error":{"code":"...","message":"..."}}` means the tool FAILED. Read the error code and message, then adjust your approach: fix the inputs, try an alternative tool, or read more context before retrying. DO NOT give up or end your turn on a tool error — tool errors are information for you to act on, not turn-ending signals.');
    lines.push('- If the same tool fails the same way three times in a row, the approach is wrong. Stop retrying, gather more context with a different tool, and reconsider.');
    lines.push('</tool_results>');
    lines.push('');

    // === Environment (sanitize paths to prevent control-character injection) ===
    const safeCwd = sanitizePath(options.cwd);
    lines.push('<environment>');
    lines.push(`Working directory: ${safeCwd}`);

    if (options.projectSnapshot) {
        const { stack, git, root } = options.projectSnapshot;
        if (root !== options.cwd) {
            lines.push(`Project root: ${sanitizePath(root)}`);
        }
        if (stack.length > 0) {
            lines.push(`Stack: ${stack.join(', ')}`);
        }
        if (git) {
            lines.push(`Git: branch=${git.branch}, ${git.status}${git.staged ? ', staged changes' : ''}`);
        }
    }
    lines.push('</environment>');
    lines.push('');

    // === Tool reference ===
    if (options.toolNames.length > 0) {
        lines.push('<tool_reference>');
        lines.push(`Available tools (${options.toolNames.length}): ${options.toolNames.join(', ')}`);
        lines.push('');
        lines.push('Full tool schemas with parameter details are provided separately via the API tool-use interface. Read each schema carefully before calling — verify required parameters, value types, and any documented constraints.');
        lines.push('</tool_reference>');
        lines.push('');
    }

    // === Few-shot example ===
    // Source: Cline + Aider consensus — concrete examples outperform abstract
    // rules. The INCORRECT branch shows the exact stall text observed in the
    // M10.2 Kimi session, making the rule impossible to misinterpret.
    lines.push('<example>');
    lines.push('Example task: "Use the available tools to gather evidence, complete the task, and summarize the result"');
    lines.push('');
    lines.push('CORRECT behavior:');
    lines.push('');
    lines.push('Turn 1 — gather context (parallel):');
    if (toolSet.has('read_file')) {
        lines.push('  → read_file("src/utils.ts")');
    }
    if (toolSet.has('search_text')) {
        lines.push('  → search_text("target symbol or phrase")');
    }
    if (toolSet.has('fetch_url')) {
        lines.push('  → fetch_url("https://example.com/docs")');
    }
    if (!toolSet.has('read_file') && !toolSet.has('search_text') && !toolSet.has('fetch_url')) {
        lines.push('  → [use the context already provided; no context tool is available]');
    }
    if (changeTools.length > 0 || verificationTools.length > 0) {
        lines.push('');
        lines.push('Turn 2 — act and verify with available tools:');
        if (toolSet.has('edit_file')) {
            lines.push('  → edit_file("src/utils.ts", [{oldText: "...", newText: "..."}])');
        } else if (toolSet.has('write_file')) {
            lines.push('  → write_file("path/to/file", "new file contents")');
        }
        if (toolSet.has('exec_command')) {
            lines.push('  → exec_command("verification command")');
        }
    }
    lines.push('');
    lines.push('Final turn — final summary (ends the turn):');
    lines.push('  "Completed the requested work using the available tools. Evidence checked: [...]. Verification: [...]"');
    lines.push('');
    lines.push('INCORRECT behavior that would cause task failure:');
    lines.push('');
    lines.push('Turn 1:');
    if (toolSet.has('read_file')) {
        lines.push('  → read_file("src/utils.ts")');
    } else if (toolSet.has('fetch_url')) {
        lines.push('  → fetch_url("https://example.com/docs")');
    } else {
        lines.push('  → [no tool call available]');
    }
    lines.push('');
    lines.push('Turn 2:');
    lines.push('  "Now I have all the context I need. Let me make the modifications: 1. Add the helper to utils.ts 2. Update the test..."');
    lines.push('  [no tool calls — TURN ENDS, TASK FAILS, NO FILES WERE CHANGED]');
    lines.push('</example>');
    lines.push('');

    // === Closing anchor (triple-repeat: this is the 3rd statement of the load-bearing rule) ===
    // Source: Cline pattern of putting operational drive LAST + Aider pattern
    // of repeating the critical rule multiple times. The rule has now appeared
    // in <mode>, <tool_preambles>, and here.
    lines.push('Remember: a response without tool calls ENDS the conversation. Call tools to do work; only produce a final text summary when every change is made and verified. The plan lives in tool calls, not in prose.');

    return [{ role: 'system' as const, content: lines.join('\n') }];
}
