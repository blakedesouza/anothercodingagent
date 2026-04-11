/**
 * Shared prompt guardrails injected into no-tools and bounded-pass prompts
 * across tool-emulation, consult witness/triage, and synthesis surfaces.
 */

/**
 * Injected wherever a model must not attempt native API-level function calling.
 * Targets models that try native tool_calls even when the protocol requires
 * JSON-in-text emulation or no tools at all.
 */
export const NO_NATIVE_FUNCTION_CALLING =
    'Native/API-level function calling is NOT available in this session.\n' +
    'Attempting a native API function call will produce no result — it will not execute and your task will fail silently.';

/**
 * Injected wherever a model tends to spend its token budget deliberating over
 * protocol rules or output format choices instead of producing an answer.
 * Targets extended chain-of-thought reasoning about which JSON shape to use,
 * whether instructions conflict, etc.
 */
export const NO_PROTOCOL_DELIBERATION =
    'Do not deliberate over the protocol or output format in your response.\n' +
    'Read the instructions once, decide, and produce your answer.';
