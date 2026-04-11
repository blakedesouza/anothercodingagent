/**
 * Network Egress Policy — domain-level network access control.
 *
 * Evaluates network requests against a configurable policy:
 * - Three modes: off (all denied), approved-only (allowlist + confirmation), open
 * - Domain glob matching for allow/deny lists (denyDomains takes precedence)
 * - HTTPS-only by default (allowHttp flag)
 * - Localhost auto-allowed in all modes except off
 * - DNS-based SSRF protection: resolved IPs are checked against blocked CIDR ranges
 *   to prevent DNS rebinding attacks (evaluateNetworkAccess / evaluateBrowserNavigation
 *   are async for this reason)
 * - Best-effort shell command network detection (curl, wget, ssh, scp, rsync,
 *   git clone, npm install, docker pull, pip install, cargo install)
 * - Browser/Playwright pre-navigation check (evaluateBrowserNavigation)
 *
 * Depends on: ResolvedConfig (M2.5) for network.* settings
 */

import dns from 'node:dns';

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

// --- SSRF: blocked CIDR ranges ---

/**
 * IPv4 CIDR ranges that must never be reached via policy-approved network access.
 * Covers: loopback, private (RFC 1918), link-local, CGNAT (RFC 6598),
 * documentation (RFC 5737), multicast, and broadcast.
 *
 * Each entry: [networkInt, maskInt] where both are 32-bit unsigned integers.
 */
const BLOCKED_V4_CIDRS: Array<[number, number]> = [
    // 0.0.0.0/8 — "this" network (unspecified source)
    [0x00000000, 0xff000000],
    // 10.0.0.0/8 — private (RFC 1918)
    [0x0a000000, 0xff000000],
    // 100.64.0.0/10 — shared address space / CGNAT (RFC 6598)
    [0x64400000, 0xffc00000],
    // 127.0.0.0/8 — loopback
    [0x7f000000, 0xff000000],
    // 169.254.0.0/16 — link-local / cloud metadata (AWS, GCP, Azure all use this)
    [0xa9fe0000, 0xffff0000],
    // 172.16.0.0/12 — private (RFC 1918)
    [0xac100000, 0xfff00000],
    // 192.0.0.0/24 — IETF protocol assignments
    [0xc0000000, 0xffffff00],
    // 192.0.2.0/24 — TEST-NET-1 documentation (RFC 5737)
    [0xc0000200, 0xffffff00],
    // 192.168.0.0/16 — private (RFC 1918)
    [0xc0a80000, 0xffff0000],
    // 198.18.0.0/15 — benchmarking (RFC 2544)
    [0xc6120000, 0xfffe0000],
    // 198.51.100.0/24 — TEST-NET-2 documentation (RFC 5737)
    [0xc6336400, 0xffffff00],
    // 203.0.113.0/24 — TEST-NET-3 documentation (RFC 5737)
    [0xcb007100, 0xffffff00],
    // 224.0.0.0/4 — multicast
    [0xe0000000, 0xf0000000],
    // 240.0.0.0/4 — reserved / future use (includes 255.255.255.255)
    [0xf0000000, 0xf0000000],
];

/**
 * Convert a dotted-decimal IPv4 string to a 32-bit unsigned integer.
 * Returns NaN if the string is not a valid IPv4 address.
 */
function ipv4ToInt(ip: string): number {
    const parts = ip.split('.');
    if (parts.length !== 4) return NaN;
    let result = 0;
    for (const part of parts) {
        // Reject empty parts, leading zeros (octal ambiguity), and non-numeric input
        if (!/^\d+$/.test(part)) return NaN;
        const n = Number(part);
        if (n < 0 || n > 255) return NaN;
        result = (result * 256 + n) >>> 0;
    }
    return result;
}

/**
 * Returns true if the given dotted-decimal IPv4 string falls within any of the
 * BLOCKED_V4_CIDRS ranges.
 */
export function isBlockedV4(ip: string): boolean {
    const ipInt = ipv4ToInt(ip);
    if (isNaN(ipInt)) return false;
    // Use >>> 0 to normalize the bitwise AND result to an unsigned 32-bit value
    // before comparing — JS bitwise ops return signed int32, but our CIDR network
    // constants are stored as positive float64 (e.g. 0xC0A80000 = 3232235520).
    // Without the coercion, addresses in the 128.0.0.0–255.255.255.255 range
    // produce negative signed results from &, which never equal the positive constant.
    return BLOCKED_V4_CIDRS.some(([network, mask]) => ((ipInt & mask) >>> 0) === network);
}

/**
 * Returns true if the given IPv6 address string should be blocked.
 *
 * Blocked IPv6 ranges:
 * - ::1/128         — loopback
 * - fc00::/7        — Unique Local Address (ULA, RFC 4193; covers fc00:: and fd00::)
 * - fe80::/10       — link-local (RFC 4291)
 * - ::ffff:0:0/96   — IPv4-mapped; the embedded IPv4 portion is checked via isBlockedV4
 *
 * Note: This function uses Node's dns.promises.lookup with { family: 4 } for IPv4
 * checks, so in practice most IPv4-mapped cases are handled at the IPv4 layer.
 * The ::ffff: check here is a defence-in-depth guard for raw address input.
 */
export function isBlockedV6(ip: string): boolean {
    const normalized = ip.replace(/^\[|\]$/g, '').toLowerCase();

    if (normalized === '::1') return true;

    // ULA: fc00::/7 — first byte is 0xfc or 0xfd
    if (/^f[cd]/i.test(normalized)) return true;

    // Link-local: fe80::/10 — starts with fe8, fe9, fea, or feb
    if (/^fe[89ab]/i.test(normalized)) return true;

    // IPv4-mapped: ::ffff:<ipv4> — extract and check the IPv4 portion
    const v4MappedMatch = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (v4MappedMatch) {
        return isBlockedV4(v4MappedMatch[1]);
    }

    // IPv4-mapped hex form: ::ffff:aabb:ccdd
    const v4MappedHexMatch = normalized.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i);
    if (v4MappedHexMatch) {
        const hi = parseInt(v4MappedHexMatch[1], 16);
        const lo = parseInt(v4MappedHexMatch[2], 16);
        const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isBlockedV4(dotted);
    }

    return false;
}

/**
 * Resolves all addresses for a hostname (both IPv4 and IPv6) and returns true
 * if any resolved address falls within a blocked range.
 *
 * This is the DNS rebinding mitigation: even if the hostname passes the domain
 * allowlist check, we verify the resolved IP is not in a private/reserved range.
 *
 * If DNS resolution fails (NXDOMAIN, timeout, etc.) the function returns false
 * so that the policy layer can still deny on other grounds (mode, denyDomains).
 * Allowing DNS failures to pass through here is intentional: the network request
 * itself will fail if the host doesn't resolve.
 *
 * @param hostname - bare hostname (no brackets, no port)
 * @param resolveFn - injectable DNS resolver for testing (defaults to dns.promises.lookup)
 */
export async function hostnameResolvesToBlockedIp(
    hostname: string,
    resolveFn: (host: string, options: dns.LookupAllOptions) => Promise<dns.LookupAddress[]> = dns.promises.lookup,
): Promise<boolean> {
    let addresses: dns.LookupAddress[];
    try {
        addresses = await resolveFn(hostname, { all: true });
    } catch {
        // DNS failure (NXDOMAIN, ENOTFOUND, timeout) — not our concern here
        return false;
    }

    return addresses.some(({ address, family }) => {
        if (family === 4) return isBlockedV4(address);
        if (family === 6) return isBlockedV6(address);
        return false;
    });
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
 *
 * Async because DNS resolution is performed for approved hostnames to guard
 * against DNS rebinding attacks. The resolved IPs are checked against
 * BLOCKED_V4_CIDRS and the blocked IPv6 ranges before a final 'allow' is issued.
 */
export async function evaluateNetworkAccess(
    url: string,
    policy: NetworkPolicy,
    resolveFn?: (host: string, options: dns.LookupAllOptions) => Promise<dns.LookupAddress[]>,
): Promise<NetworkPolicyResult> {
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

    // Localhost auto-allowed in all modes except off (already handled above).
    // Loopback literals skip the DNS check — they ARE the resolved address.
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

    // Determine the preliminary decision from mode/allowDomains before the DNS check
    let preliminary: NetworkPolicyResult;

    if (matchesDomainList(host, policy.allowDomains)) {
        preliminary = { decision: 'allow', reason: `domain "${host}" is in allowDomains` };
    } else if (policy.mode === 'open') {
        preliminary = { decision: 'allow', reason: 'network mode is open' };
    } else {
        // Mode: approved-only → confirmation for unknown domains.
        // No DNS check needed for 'confirm' decisions — the request won't proceed
        // without explicit user approval, which resets the evaluation at that point.
        return { decision: 'confirm', reason: `domain "${host}" requires approval (mode: approved-only)` };
    }

    // DNS rebinding guard: resolve the hostname and reject if any address is
    // in a private/reserved range. Only runs when we would otherwise allow.
    if (preliminary.decision === 'allow') {
        const blocked = await hostnameResolvesToBlockedIp(host, resolveFn);
        if (blocked) {
            return {
                decision: 'deny',
                reason: `"${host}" resolves to a private or reserved IP address (SSRF protection)`,
            };
        }
    }

    return preliminary;
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
 *
 * Async because evaluateNetworkAccess performs DNS resolution for SSRF protection.
 */
export async function evaluateBrowserNavigation(
    url: string,
    policy: NetworkPolicy,
    resolveFn?: (host: string, options: dns.LookupAllOptions) => Promise<dns.LookupAddress[]>,
): Promise<NetworkPolicyResult> {
    return evaluateNetworkAccess(url, policy, resolveFn);
}

/**
 * Evaluate a shell command against the network policy.
 * Combines detection with policy evaluation.
 *
 * Returns null if the command is not a detected network command.
 * Localhost exception does NOT apply to shell commands (they can do anything once running).
 *
 * Note: shell command evaluation is intentionally synchronous — the domain is
 * extracted from the command string itself, not resolved via DNS. DNS rebinding
 * is not a meaningful attack vector for shell commands because the OS resolver
 * is invoked by the shell at execution time, not by us.
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
