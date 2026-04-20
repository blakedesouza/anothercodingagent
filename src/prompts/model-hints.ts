/**
 * Per-model prompt hints keyed by runtime surface.
 *
 * Some hint text is only valid on certain prompt surfaces. For example, a
 * tool-emulation-only instruction such as "your entire response must be only
 * the tool-call JSON object" is correct inside the emulated tool protocol but
 * wrong for a no-tools consult witness or a synthesis pass.
 */
export type ModelHintSurface =
    | 'invoke_agentic'
    | 'invoke_analytical'
    | 'invoke_synthesis'
    | 'tool_emulation'
    | 'consult_system'
    | 'consult_context_request'
    | 'consult_finalization';

export interface ModelHintEntry {
    text: string;
    surfaces?: readonly ModelHintSurface[];
}

/** Registry: key is a model ID prefix, value is an array of surface-scoped hints. */
export const MODEL_HINTS: Record<string, ModelHintEntry[]> = {
    // Populated in C11.3 based on C11.1 failure catalog.

    // Fix D: MiniMax sometimes jumps straight to obvious root config files
    // (for example package.json) without first grounding the path via a tree listing.
    'minimax/': [
        {
            text: 'In witness context-request mode, do not jump straight to a guessed file path just because it is a common convention. If ACA has not already exposed that exact path via the prompt, a prior snippet, or a tree listing, request a narrow `type: "tree"` listing first and only then open the discovered file.',
            surfaces: ['consult_context_request'],
        },
    ],

    // Fix A (C11.8): kimi anchors on conceptual similarity instead of literal function names.
    // When a function is named in the task, find the file that literally defines it.
    'moonshotai/kimi': [
        {
            text: 'When the task names a specific function, type, or constant, locate the file that literally defines it — do not substitute a different file that handles a conceptually related feature. Use the exact name as your search anchor in the directory tree.',
            surfaces: ['invoke_analytical', 'consult_system', 'consult_context_request', 'consult_finalization'],
        },
    ],

    // Fix B (C11.8): qwen3.5 externalizes chain-of-thought as blockquoted deliberation prose,
    // which prevents structured output from being extracted correctly.
    'qwen/qwen3': [
        {
            text: 'Do not wrap your output in blockquote syntax (lines starting with `>`). Do not show your reasoning process or deliberation steps in the response.',
            surfaces: ['invoke_agentic', 'invoke_analytical', 'invoke_synthesis', 'tool_emulation', 'consult_system', 'consult_context_request', 'consult_finalization'],
        },
        {
            text: 'Start with the final answer immediately. Do not restate the task, constraints, checks, or plan before answering, and do not include internal self-review after the answer.',
            surfaces: ['invoke_agentic', 'invoke_analytical', 'invoke_synthesis', 'consult_system', 'consult_context_request', 'consult_finalization'],
        },
        {
            text: 'Output only: the `needs_context` JSON object if you need more context, or final Markdown findings if you are ready to finalize. Nothing else.',
            surfaces: ['consult_context_request', 'consult_finalization'],
        },
    ],

    // Fix C: GLM-5 is a thinking model that leaks intent as visible narration — it writes
    // "I'll now fetch..." or "Let me..." in the response text instead of making the tool call.
    // This narration-without-action pattern causes the turn engine to yield `assistant_final`
    // with no tool calls and no output written. The fix: forbid intent narration; require
    // immediate tool calls.
    'zai-org/glm': [
        {
            text: 'Make tool calls directly — do not narrate your intent. If you need to fetch a page, read a file, or write output, call that tool now in this same response. Never write "I\'ll now fetch", "I will fetch", "Let me fetch", "Next I\'ll", or similar intent phrases and then stop without a tool call. Act immediately.',
            surfaces: ['invoke_agentic', 'invoke_analytical', 'tool_emulation'],
        },
        {
            text: 'If you have already read reference files and still need external data, make the fetch or search tool call in this response right now. Do not announce what you plan to do — do it.',
            surfaces: ['invoke_agentic', 'invoke_analytical', 'tool_emulation'],
        },
        {
            text: 'CRITICAL: When you invoke a tool, your ENTIRE response must be ONLY the JSON object: {"tool_calls":[...]}. Do not write ANY text before or after the JSON. The first character of your response must be `{`.',
            surfaces: ['tool_emulation'],
        },
    ],
};

/**
 * Returns hints for the given model ID by prefix matching and prompt surface.
 * All matching prefixes contribute; hints are returned in definition order.
 * Returns an empty array when no hints apply or modelId is empty.
 */
export function getModelHints(modelId: string, surface?: ModelHintSurface): string[] {
    if (!modelId) return [];
    const hints: string[] = [];
    for (const [prefix, prefixHints] of Object.entries(MODEL_HINTS)) {
        if (modelId.startsWith(prefix)) {
            for (const hint of prefixHints) {
                if (surface && hint.surfaces && !hint.surfaces.includes(surface)) {
                    continue;
                }
                hints.push(hint.text);
            }
        }
    }
    return hints;
}
