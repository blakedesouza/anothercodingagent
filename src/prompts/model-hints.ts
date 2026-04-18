/**
 * Per-model system prompt hints (C11.2 infrastructure; C11.3 populates the registry).
 *
 * Hints are injected as a <model_hints> section in every prompt builder when the
 * caller supplies a model ID. Prefix matching lets a single entry cover an entire
 * model family (e.g. 'qwen/' matches all Qwen variants).
 *
 * Budget: max 2 sentences / 50–100 tokens per model family (C11.3 constraint).
 */

/** Registry: key is a model ID prefix, value is an array of hint strings. */
export const MODEL_HINTS: Record<string, string[]> = {
    // Populated in C11.3 based on C11.1 failure catalog.

    // Fix A (C11.8): kimi anchors on conceptual similarity instead of literal function names.
    // When a function is named in the task, find the file that literally defines it.
    'moonshotai/kimi': [
        'When the task names a specific function, type, or constant, locate the file that literally defines it — do not substitute a different file that handles a conceptually related feature. Use the exact name as your search anchor in the directory tree.',
    ],

    // Fix B (C11.8): qwen3.5 externalizes chain-of-thought as blockquoted deliberation prose,
    // which prevents structured output from being extracted correctly.
    'qwen/qwen3': [
        'Do not wrap your output in blockquote syntax (lines starting with `>`). Do not show your reasoning process or deliberation steps in the response. Output only: the `needs_context` JSON object if you need more context, or final Markdown findings if you are ready to finalize. Nothing else.',
        'Start with the final answer immediately. Do not restate the task, constraints, checks, or plan before answering, and do not include internal self-review after the answer.',
    ],

    'deepseek/': [
        'Answer in English only. If you need context, return valid JSON only: `line_start` and `line_end` must be numeric JSON values, never prose, placeholders, or quoted strings.',
    ],

    // Fix C: GLM-5 is a thinking model that leaks intent as visible narration — it writes
    // "I'll now fetch..." or "Let me..." in the response text instead of making the tool call.
    // This narration-without-action pattern causes the turn engine to yield `assistant_final`
    // with no tool calls and no output written. The fix: forbid intent narration; require
    // immediate tool calls.
    'zai-org/glm': [
        'Make tool calls directly — do not narrate your intent. If you need to fetch a page, read a file, or write output, call that tool now in this same response. Never write "I\'ll now fetch", "I will fetch", "Let me fetch", "Next I\'ll", or similar intent phrases and then stop without a tool call. Act immediately.',
        'If you have already read reference files and still need external data, make the fetch or search tool call in this response right now. Do not announce what you plan to do — do it.',
        'CRITICAL: When you invoke a tool, your ENTIRE response must be ONLY the JSON object: {"tool_calls":[...]}. Do not write ANY text before or after the JSON. The first character of your response must be `{`.',
    ],
};

/**
 * Returns hints for the given model ID by prefix matching.
 * All matching prefixes contribute; hints are returned in definition order.
 * Returns an empty array when no hints apply or modelId is empty.
 */
export function getModelHints(modelId: string): string[] {
    if (!modelId) return [];
    const hints: string[] = [];
    for (const [prefix, prefixHints] of Object.entries(MODEL_HINTS)) {
        if (modelId.startsWith(prefix)) {
            hints.push(...prefixHints);
        }
    }
    return hints;
}
