/**
 * Secrets Scrubbing Pipeline — two-strategy redaction.
 *
 * Scrubs sensitive values from text at 4 pipeline integration points:
 *   1. Tool output — before storing in ToolResultItem
 *   2. LLM context — before assembling messages for the provider
 *   3. Persistence — before writing to conversation.jsonl / events.jsonl
 *   4. Terminal — before calling onTextDelta callbacks
 *
 * Strategy 1: Exact-value replacement for known API keys loaded from secrets.
 * Strategy 2: Baseline pattern matching for common secret formats.
 *
 * Both strategies maintain a per-session counter so the same secret text
 * always maps to the same <redacted:type:N> placeholder (stable IDs).
 *
 * Depends on: ResolvedConfig (M2.5) for scrubbing.enabled + scrubbing.allowPatterns
 */

// --- SecretPattern ---

export interface SecretPattern {
    name: string;           // Pattern identifier (e.g., "bearer_token")
    pattern: RegExp;        // Detection regex — do NOT include 'g' flag; scrub() adds it
    type: string;           // Redaction type label used in placeholder (e.g., "api_key", "bearer")
    contextRequired?: string; // Optional: adjacent context hint (informational only)
}

// --- Default baseline patterns (Strategy 2) ---

const DEFAULT_PATTERNS: SecretPattern[] = [
    // OpenAI / generic sk- API keys: require 20+ chars after "sk-" to avoid false positives
    // e.g., "sk-" + a short word like "skeleton" (sk-e...) won't match; needs 20+ alphanumeric
    {
        name: 'openai_sk_prefix',
        pattern: /sk-[A-Za-z0-9]{20,}/,
        type: 'api_key',
    },
    // Stripe test publishable key
    {
        name: 'stripe_pk_test',
        pattern: /pk_test_[A-Za-z0-9_]{20,}/,
        type: 'api_key',
    },
    // AWS IAM access key ID: exactly AKIA + 16 uppercase alphanumeric chars
    {
        name: 'aws_access_key',
        pattern: /\bAKIA[A-Z0-9]{16}\b/,
        type: 'api_key',
    },
    // GitHub personal access token (classic)
    {
        name: 'github_pat',
        pattern: /ghp_[A-Za-z0-9]{36,}/,
        type: 'api_key',
    },
    // GitHub Actions / OAuth service token
    {
        name: 'github_service_token',
        pattern: /ghs_[A-Za-z0-9]{36,}/,
        type: 'api_key',
    },
    // GitLab personal access token
    {
        name: 'gitlab_pat',
        pattern: /glpat-[A-Za-z0-9_-]{20,}/,
        type: 'api_key',
    },
    // HTTP Authorization: Bearer <token> (10+ chars of token).
    // Case-insensitive (i flag) because HTTP headers are case-insensitive.
    {
        name: 'bearer_token',
        pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9._\-+=/]{10,}/i,
        type: 'bearer',
        contextRequired: 'Authorization',
    },
    // PEM-encoded private key block (any key type).
    // [\s\S]+? is lazy so multiple PEM blocks in the same text are each scrubbed separately.
    {
        name: 'pem_private_key',
        pattern: /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+ PRIVATE KEY-----/,
        type: 'pem_key',
    },
    // .env-style assignments: KEY=value where KEY is SCREAMING_CASE with a secret keyword.
    // Matches common env var names containing SECRET, KEY, TOKEN, PASSWORD, etc.
    // No `i` flag — only uppercase env var names (standard .env convention).
    // Value uses [^\s<]+ to avoid swallowing earlier redaction placeholders.
    {
        name: 'env_assignment',
        pattern: /\b[A-Z_]*(?:SECRET|KEY|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z_]*\s*=\s*[^\s<]+/,
        type: 'env_secret',
    },
    // Connection strings with embedded credentials: scheme://user:password@host/...
    // Covers postgres://, mysql://, mongodb://, redis://, amqp://, etc.
    // Trailing [^\s"']+ stops before quotes to avoid consuming JSON/code delimiters.
    {
        name: 'connection_string',
        pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:]+:[^\s@]+@[^\s"']+/,
        type: 'connection_string',
    },
    // JWT tokens: three base64url-encoded segments separated by dots.
    // Must start with eyJ (base64 of '{"') to avoid matching arbitrary dotted strings.
    {
        name: 'jwt_token',
        pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
        type: 'jwt',
    },
];

// --- SecretScrubber ---

export class SecretScrubber {
    private readonly enabled: boolean;
    private readonly patterns: SecretPattern[];
    private readonly knownSecretValues: string[];
    /** Compiled allowPatterns regexes — matched text is exempt from pattern redaction. */
    private readonly allowRegexes: RegExp[];
    /** Maps raw secret text → stable <redacted:type:N> placeholder. */
    private readonly redactionMap = new Map<string, string>();
    private counter = 0;

    /**
     * @param knownSecretValues - Known API key / secret values (from LoadedSecrets).
     *   Empty strings are filtered out.
     * @param config - Scrubbing config from ResolvedConfig. Set enabled=false for no-op.
     *   allowPatterns: regex strings — any pattern-matched text that also matches
     *   an allowPattern is exempt from redaction (false-positive recovery).
     * @param additionalPatterns - Extra patterns appended after the baseline set.
     */
    constructor(
        knownSecretValues: string[],
        config: { enabled: boolean; allowPatterns?: string[] },
        additionalPatterns?: SecretPattern[],
    ) {
        this.enabled = config.enabled;
        this.knownSecretValues = knownSecretValues.filter(s => s.length > 0);
        this.patterns = [...DEFAULT_PATTERNS, ...(additionalPatterns ?? [])];
        this.allowRegexes = (config.allowPatterns ?? [])
            .map(p => {
                // Guard against ReDoS: reject overly long or nested-quantifier patterns
                if (p.length > 200) return null;
                if (/([+*])\)?[+*]/.test(p)) return null; // nested quantifiers like (a+)+
                try { return new RegExp(p); }
                catch { return null; }
            })
            .filter((r): r is RegExp => r !== null);
    }

    /**
     * Scrub secrets from `text`. Returns `text` unchanged when disabled or empty.
     *
     * Strategy 1 (known values) runs before Strategy 2 (patterns) so that known
     * secrets are assigned stable IDs even if they also match a baseline pattern.
     */
    scrub(text: string): string {
        if (!this.enabled || text.length === 0) return text;

        let result = text;

        // --- Strategy 1: exact-value replacement ---
        // Sort longest-first so a longer known secret is replaced before any shorter
        // secret that shares a prefix with it.
        const sorted = [...this.knownSecretValues].sort((a, b) => b.length - a.length);
        // LIMITATION: Matching is case-sensitive and literal. A secret that appears
        // in output with different casing will not be redacted.
        for (const secret of sorted) {
            if (!result.includes(secret)) continue;
            const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(escaped, 'g');
            const placeholder = this.getOrAssignRedactionId(secret, 'api_key');
            result = result.replace(re, placeholder);
        }

        // --- Strategy 2: pattern-based replacement ---
        // LIMITATION: Pattern matching covers known formats but cannot catch secrets
        // referenced via shell variable expansion ($VAR or ${VAR}).
        for (const { pattern, type } of this.patterns) {
            // Build a fresh global regex each call — never reuse a global RegExp
            // instance across calls because `lastIndex` is shared state.
            const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
            const re = new RegExp(pattern.source, flags);
            result = result.replace(re, (matched) => {
                // allowPatterns exemption: if the matched text passes any allow
                // regex, skip redaction (false-positive recovery).
                if (this.allowRegexes.length > 0 && this.allowRegexes.some(ar => ar.test(matched))) {
                    return matched;
                }
                return this.getOrAssignRedactionId(matched, type);
            });
        }

        return result;
    }

    private getOrAssignRedactionId(key: string, type: string): string {
        const existing = this.redactionMap.get(key);
        if (existing) return existing;
        const id = `<redacted:${type}:${++this.counter}>`;
        this.redactionMap.set(key, id);
        return id;
    }
}
