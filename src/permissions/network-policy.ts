/**
 * Network Egress Policy — domain-level network access control.
 *
 * Evaluates network requests against a configurable policy:
 * - Three modes: off (all denied), approved-only (allowlist + confirmation), open
 * - Domain glob matching for allow/deny lists (denyDomains takes precedence)
 * - HTTPS-only by default (allowHttp flag)
 * - Localhost auto-allowed in all modes except off
 * - Best-effort shell command network detection (curl, wget, ssh, scp, rsync,
 *   git clone, npm install, docker pull, pip install, cargo install)
 * - Browser/Playwright pre-navigation check (evaluateBrowserNavigation)
 *
 * Depends on: ResolvedConfig (M2.5) for network.* settings
 */

// --- Types ---

export interface NetworkPolicy {
    mode: 'off' | 'approved-only' | 'open';
    allowDomains: string[];
    denyDomains: string[];
    allowHttp: boolean;
}

export type NetworkFacet = 'network_download' | 'network_access' | 'package_install';

export type NetworkDecision = 'allow' | 'confirm' | 'deny';

export interface NetworkPolicyResult {
    decision: NetworkDecision;
    reason: string;
    facet?: NetworkFacet;
}

export interface ShellNetworkDetection {
    detected: boolean;
    domain?: string;
    facet?: NetworkFacet;
}

// --- Localhost ---

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Matches any IP in the 127.0.0.0/8 loopback range. */
const LOOPBACK_V4_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Matches IPv4-mapped IPv6 loopback in hex form: ::ffff:7fXX:XXXX (URL parser converts 127.x.x.x to hex) */
const LOOPBACK_V4_MAPPED_RE = /^::ffff:7f[\da-f]{0,2}:[\da-f]{1,4}$/i;

function isLocalhost(host: string): boolean {
    // URL.hostname wraps IPv6 in brackets: [::1] → strip before checking
    const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (LOCALHOST_HOSTS.has(normalized)) return true;
    if (LOOPBACK_V4_RE.test(normalized)) return true;
    if (LOOPBACK_V4_MAPPED_RE.test(normalized)) return true;
    return false;
}

// --- Domain glob matching ---

/**
 * Convert a domain glob pattern to a RegExp.
 * `*` matches one or more characters within a single domain label (no dots).
 */
function domainGlobToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^.]+');
    return new RegExp(`^${escaped}$`, 'i');
}

function matchesDomainList(domain: string, patterns: string[]): boolean {
    return patterns.some(p => domainGlobToRegex(p).test(domain));
}

// --- Protocol whitelist ---

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// --- URL-based evaluation ---

/**
 * Evaluate a URL against the network policy.
 * Used by built-in network tools (fetch_url, web_search, lookup_docs).
 */
export function evaluateNetworkAccess(
    url: string,
    policy: NetworkPolicy,
): NetworkPolicyResult {
    if (policy.mode === 'off') {
        return { decision: 'deny', reason: 'network access is disabled (mode: off)' };
    }

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { decision: 'deny', reason: `invalid URL: ${url}` };
    }

    // Only HTTP and HTTPS are allowed; reject file:, ftp:, data:, etc.
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        return { decision: 'deny', reason: `protocol "${parsed.protocol}" is not allowed` };
    }

    const host = parsed.hostname;
    const isHttp = parsed.protocol === 'http:';

    // Localhost auto-allowed in all modes except off (already handled above)
    if (isLocalhost(host)) {
        return { decision: 'allow', reason: 'localhost is auto-allowed' };
    }

    // HTTPS-only check
    if (isHttp && !policy.allowHttp) {
        return { decision: 'deny', reason: 'HTTP is not allowed (set allowHttp: true to permit)' };
    }

    // denyDomains takes precedence over allowDomains
    if (matchesDomainList(host, policy.denyDomains)) {
        return { decision: 'deny', reason: `domain "${host}" is in denyDomains` };
    }

    if (matchesDomainList(host, policy.allowDomains)) {
        return { decision: 'allow', reason: `domain "${host}" is in allowDomains` };
    }

    // Mode: open → allow everything not denied
    if (policy.mode === 'open') {
        return { decision: 'allow', reason: 'network mode is open' };
    }

    // Mode: approved-only → confirmation for unknown domains
    return { decision: 'confirm', reason: `domain "${host}" requires approval (mode: approved-only)` };
}

// --- Shell command network detection ---

/** Extract hostname from a URL string. Returns undefined if not parseable. */
function extractHostFromUrl(urlStr: string): string | undefined {
    const cleaned = urlStr.replace(/^['"]|['"]$/g, '');
    try {
        return new URL(cleaned).hostname;
    } catch {
        return undefined;
    }
}

/**
 * Extract host from scp/rsync-style `[user@]host:path` remote spec.
 * Skips flags (tokens starting with `-`) and finds the first token with `:`.
 */
function extractHostFromRemoteSpec(cmd: string, cmdName: string): string | undefined {
    const tokens = cmd.split(/\s+/);
    const cmdIdx = tokens.findIndex(t => t === cmdName);
    if (cmdIdx < 0) return undefined;
    for (let i = cmdIdx + 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.startsWith('-')) continue;
        const eqIdx = token.indexOf('=');
        const colonIdx = token.indexOf(':');
        // Skip option assignment tokens like ProxyJump=proxy:22
        if (eqIdx >= 0 && (colonIdx < 0 || eqIdx < colonIdx)) continue;
        if (colonIdx <= 0) continue;
        const hostPart = token.slice(0, colonIdx);
        const atIdx = hostPart.indexOf('@');
        return atIdx >= 0 ? hostPart.slice(atIdx + 1) : hostPart;
    }
    return undefined;
}

/**
 * Patterns for detecting network commands in shell strings (best-effort).
 * Covers: curl, wget, ssh, scp, rsync, git clone, npm install, docker pull,
 * pip/pip3 install, cargo install.
 */
const SHELL_NETWORK_PATTERNS: Array<{
    test: RegExp;
    facet: NetworkFacet;
    extractDomain: (command: string) => string | undefined;
}> = [
    {
        test: /\bcurl\s/,
        facet: 'network_download',
        extractDomain: (cmd) => {
            const m = cmd.match(/https?:\/\/\S+/);
            return m ? extractHostFromUrl(m[0]) : undefined;
        },
    },
    {
        test: /\bwget\s/,
        facet: 'network_download',
        extractDomain: (cmd) => {
            const m = cmd.match(/https?:\/\/\S+/);
            return m ? extractHostFromUrl(m[0]) : undefined;
        },
    },
    // scp and rsync checked BEFORE ssh: both commonly use `-e ssh` as a flag
    // argument, and `/\bssh\s/` would false-match the inner `ssh` token.
    {
        test: /\bscp\s/,
        facet: 'network_access',
        extractDomain: (cmd) => extractHostFromRemoteSpec(cmd, 'scp'),
    },
    {
        test: /\brsync\s/,
        facet: 'network_access',
        extractDomain: (cmd) => {
            // rsync can use URLs for HTTP-based transfer
            const urlMatch = cmd.match(/https?:\/\/\S+/);
            if (urlMatch) return extractHostFromUrl(urlMatch[0]);
            return extractHostFromRemoteSpec(cmd, 'rsync');
        },
    },
    {
        test: /\bssh\s/,
        facet: 'network_access',
        extractDomain: (cmd) => {
            // Tokenize to avoid ReDoS from nested quantifiers.
            // SSH flags with separate arguments: -b, -c, -D, -E, -e, -F, -I, -i, -J, -L, -l, -m, -O, -o, -p, -Q, -R, -S, -W, -w
            const flagsWithArgs = new Set(['-b','-c','-D','-E','-e','-F','-I','-i','-J','-L','-l','-m','-O','-o','-p','-Q','-R','-S','-W','-w']);
            const tokens = cmd.split(/\s+/);
            const sshIdx = tokens.findIndex(t => t === 'ssh');
            if (sshIdx < 0) return undefined;
            // First pass: look for user@host pattern (most reliable)
            for (let i = sshIdx + 1; i < tokens.length; i++) {
                const atIdx = tokens[i].indexOf('@');
                if (atIdx > 0) return tokens[i].slice(atIdx + 1);
            }
            // Second pass: skip flags and their arguments, take first positional
            let skipNext = false;
            for (let i = sshIdx + 1; i < tokens.length; i++) {
                if (skipNext) { skipNext = false; continue; }
                const token = tokens[i];
                if (flagsWithArgs.has(token)) { skipNext = true; continue; }
                if (token.startsWith('-')) continue;
                return token;
            }
            return undefined;
        },
    },
    {
        test: /\bgit\s+clone\b/,
        facet: 'network_download',
        extractDomain: (cmd) => {
            const m = cmd.match(/https?:\/\/\S+/);
            return m ? extractHostFromUrl(m[0]) : undefined;
        },
    },
    {
        test: /\bnpm\s+(?:install|i)\b/,
        facet: 'package_install',
        extractDomain: () => undefined,
    },
    {
        test: /\bdocker\s+pull\b/,
        facet: 'package_install',
        extractDomain: () => undefined,
    },
    {
        test: /\bpip3?\s+install\b/,
        facet: 'package_install',
        extractDomain: () => undefined,
    },
    {
        test: /\bcargo\s+install\b/,
        facet: 'package_install',
        extractDomain: () => undefined,
    },
];

/**
 * Detect network commands in a shell command string.
 * Best-effort: catches curl, wget, ssh, scp, rsync, git clone,
 * npm install, docker pull, pip/pip3 install, cargo install.
 */
export function detectShellNetworkCommand(command: string): ShellNetworkDetection {
    for (const { test, facet, extractDomain } of SHELL_NETWORK_PATTERNS) {
        if (test.test(command)) {
            return { detected: true, domain: extractDomain(command), facet };
        }
    }
    return { detected: false };
}

/**
 * Evaluate a URL for browser/Playwright navigation against the network policy.
 * Same policy logic as evaluateNetworkAccess — browser tools call this before
 * navigating to ensure the target domain is permitted.
 */
export function evaluateBrowserNavigation(
    url: string,
    policy: NetworkPolicy,
): NetworkPolicyResult {
    return evaluateNetworkAccess(url, policy);
}

/**
 * Evaluate a shell command against the network policy.
 * Combines detection with policy evaluation.
 *
 * Returns null if the command is not a detected network command.
 * Localhost exception does NOT apply to shell commands (they can do anything once running).
 */
export function evaluateShellNetworkAccess(
    command: string,
    policy: NetworkPolicy,
): NetworkPolicyResult | null {
    const detection = detectShellNetworkCommand(command);
    if (!detection.detected) {
        return null;
    }

    // Mode: off → deny all detected network commands
    if (policy.mode === 'off') {
        return {
            decision: 'deny',
            reason: 'network access is disabled (mode: off)',
            facet: detection.facet,
        };
    }

    // Mode: approved-only
    if (policy.mode === 'approved-only') {
        if (detection.domain) {
            if (matchesDomainList(detection.domain, policy.denyDomains)) {
                return {
                    decision: 'deny',
                    reason: `domain "${detection.domain}" is in denyDomains`,
                    facet: detection.facet,
                };
            }
            if (matchesDomainList(detection.domain, policy.allowDomains)) {
                return {
                    decision: 'allow',
                    reason: `domain "${detection.domain}" is in allowDomains`,
                    facet: detection.facet,
                };
            }
        }
        return {
            decision: 'confirm',
            reason: 'network command requires approval (mode: approved-only)',
            facet: detection.facet,
        };
    }

    // Mode: open → allow (still subject to denyDomains)
    if (detection.domain && matchesDomainList(detection.domain, policy.denyDomains)) {
        return {
            decision: 'deny',
            reason: `domain "${detection.domain}" is in denyDomains`,
            facet: detection.facet,
        };
    }

    return {
        decision: 'allow',
        reason: 'network mode is open',
        facet: detection.facet,
    };
}
