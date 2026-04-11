/**
 * Obfuscates programming identifiers in question text before sending to witnesses.
 * Prevents models (particularly qwen3.5) from being semantically primed by
 * identifier names containing loaded terms (tool, invoke, spawn, exec, etc.),
 * which causes them to emit pseudo-tool-call JSON in no-tools context-request passes.
 *
 * Strategy: replace camelCase, PascalCase, and multi-part snake_case tokens with
 * neutral single-letter labels (A, B, C ...), and prepend a legend mapping labels
 * back to real names. Symbol-lookup runs on the full prompt which includes the
 * legend, so <symbol_locations> is populated correctly despite the obfuscation.
 */

/**
 * Matches programming identifiers:
 *   camelCase:   execCommand, buildContextRequestPrompt
 *   PascalCase:  InvokeRequest, ModelCatalog (requires internal uppercase — excludes HTTP, README, The)
 *   snake_case:  exec_command, spawn_agent (2+ parts — excludes bare exec, tool)
 */
const PROGRAMMING_IDENTIFIER =
    /\b(?:[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|[A-Z][a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+)\b/g;

/**
 * Hyphenated compound terms that semantically prime qwen3.5 into emitting
 * pseudo-tool-call JSON, even when no tool schema is present. These bypass
 * the PROGRAMMING_IDENTIFIER regex (which targets camelCase/snake_case) but
 * are just as contaminating.
 *
 * Listed longest-first so that compound supersets (e.g. pseudo-tool-call)
 * are detected and replaced before their sub-phrases (e.g. tool-call),
 * preventing the sub-phrase from spuriously appearing in the legend.
 */
const LOADED_TERMS: readonly string[] = [
    'pseudo-tool-call',
    'pseudo-tool-use',
    'function-call',
    'tool-call',
    'api-call',
    'tool-use',
];

function indexToLabel(i: number): string {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (i < 26) return letters[i];
    return letters[Math.floor(i / 26) - 1] + letters[i % 26];
}

export interface ObfuscationResult {
    /** Question text with identifiers replaced by neutral labels. */
    obfuscated: string;
    /**
     * Legend block to prepend to the question, e.g.:
     *   "Identifier legend (real names for codebase navigation):\n  A = execCommand\n  B = spawnAgent"
     * Empty string if no identifiers were found.
     */
    legend: string;
}

export function obfuscateIdentifiers(text: string): ObfuscationResult {
    const identifiers = [...new Set(text.match(PROGRAMMING_IDENTIFIER) ?? [])];

    // Detect loaded hyphenated terms. Use longest-first order (as declared in
    // LOADED_TERMS) so pseudo-tool-call is detected before tool-call, preventing
    // the sub-phrase from receiving a spurious legend entry.
    const loadedMatches: string[] = [];
    for (const term of LOADED_TERMS) {
        if (new RegExp(`\\b${term}\\b`, 'i').test(text)) loadedMatches.push(term);
    }

    const allTokens = [...new Set([...identifiers, ...loadedMatches])];
    if (allTokens.length === 0) return { obfuscated: text, legend: '' };

    const mapping = new Map<string, string>(
        allTokens.map((token, i) => [token, indexToLabel(i)])
    );

    let obfuscated = text;
    for (const [original, label] of mapping) {
        // Identifiers are alphanumeric+underscore; loaded terms may contain hyphens
        // (literal in regex outside character classes — no escaping needed).
        obfuscated = obfuscated.replace(new RegExp(`\\b${original}\\b`, 'gi'), label);
    }

    const legendLines = [...mapping.entries()].map(([orig, label]) => `  ${label} = ${orig}`);
    const legend = `Identifier legend (real names for codebase navigation):\n${legendLines.join('\n')}`;

    return { obfuscated, legend };
}
