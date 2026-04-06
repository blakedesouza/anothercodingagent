import { describe, it, expect } from 'vitest';
import {
    evaluateNetworkAccess,
    evaluateShellNetworkAccess,
    detectShellNetworkCommand,
} from '../../src/permissions/network-policy.js';
import type { NetworkPolicy } from '../../src/permissions/network-policy.js';

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

// =============================================================================
// evaluateNetworkAccess — URL-based policy evaluation
// =============================================================================

describe('evaluateNetworkAccess', () => {
    // --- Mode: off ---

    it('mode=off → denies all network access', () => {
        const result = evaluateNetworkAccess(
            'https://example.com',
            makePolicy({ mode: 'off' }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('mode: off');
    });

    it('mode=off → denies even localhost', () => {
        const result = evaluateNetworkAccess(
            'https://localhost:3000/api',
            makePolicy({ mode: 'off' }),
        );
        expect(result.decision).toBe('deny');
    });

    // --- Mode: approved-only ---

    it('approved-only, domain in allowDomains → auto-allowed', () => {
        const result = evaluateNetworkAccess(
            'https://api.github.com/repos',
            makePolicy({ mode: 'approved-only', allowDomains: ['api.github.com'] }),
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('allowDomains');
    });

    it('approved-only, domain in denyDomains → denied', () => {
        const result = evaluateNetworkAccess(
            'https://evil.com/payload',
            makePolicy({ mode: 'approved-only', denyDomains: ['evil.com'] }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('denyDomains');
    });

    it('approved-only, unknown domain → requires confirmation', () => {
        const result = evaluateNetworkAccess(
            'https://unknown-site.com/page',
            makePolicy({ mode: 'approved-only' }),
        );
        expect(result.decision).toBe('confirm');
        expect(result.reason).toContain('requires approval');
    });

    it('approved-only, wildcard allowDomains → matches subdomain', () => {
        const result = evaluateNetworkAccess(
            'https://api.github.com/repos',
            makePolicy({ mode: 'approved-only', allowDomains: ['*.github.com'] }),
        );
        expect(result.decision).toBe('allow');
    });

    // --- Mode: open ---

    it('mode=open → allows all domains', () => {
        const result = evaluateNetworkAccess(
            'https://anything.com/path',
            makePolicy({ mode: 'open' }),
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('open');
    });

    it('mode=open, domain in denyDomains → still denied', () => {
        const result = evaluateNetworkAccess(
            'https://evil.com/exfil',
            makePolicy({ mode: 'open', denyDomains: ['evil.com'] }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('denyDomains');
    });

    // --- denyDomains precedence ---

    it('domain in both allow and deny → denied (denyDomains precedence)', () => {
        const result = evaluateNetworkAccess(
            'https://overlap.com/data',
            makePolicy({
                mode: 'approved-only',
                allowDomains: ['overlap.com'],
                denyDomains: ['overlap.com'],
            }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('denyDomains');
    });

    // --- Localhost exception ---

    it('localhost → auto-allowed in approved-only mode', () => {
        const result = evaluateNetworkAccess(
            'https://localhost:3000/api',
            makePolicy({ mode: 'approved-only' }),
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('localhost');
    });

    it('127.0.0.1 → auto-allowed in approved-only mode', () => {
        const result = evaluateNetworkAccess(
            'https://127.0.0.1:8080/health',
            makePolicy({ mode: 'approved-only' }),
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('localhost');
    });

    it('::1 → auto-allowed in open mode', () => {
        const result = evaluateNetworkAccess(
            'https://[::1]:5432/db',
            makePolicy({ mode: 'open' }),
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('localhost');
    });

    it('localhost → auto-allowed even with empty allowDomains', () => {
        const result = evaluateNetworkAccess(
            'https://localhost/api',
            makePolicy({ mode: 'approved-only', allowDomains: [] }),
        );
        expect(result.decision).toBe('allow');
    });

    // --- HTTPS-only ---

    it('HTTP URL with allowHttp=false → denied', () => {
        const result = evaluateNetworkAccess(
            'http://example.com/data',
            makePolicy({ mode: 'open', allowHttp: false }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('HTTP is not allowed');
    });

    it('HTTP URL with allowHttp=true → allowed', () => {
        const result = evaluateNetworkAccess(
            'http://example.com/data',
            makePolicy({ mode: 'open', allowHttp: true }),
        );
        expect(result.decision).toBe('allow');
    });

    it('HTTP localhost → allowed regardless of allowHttp', () => {
        const result = evaluateNetworkAccess(
            'http://localhost:3000/api',
            makePolicy({ mode: 'approved-only', allowHttp: false }),
        );
        expect(result.decision).toBe('allow');
    });

    // --- Invalid URL ---

    it('invalid URL → denied', () => {
        const result = evaluateNetworkAccess(
            'not-a-url',
            makePolicy({ mode: 'open' }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('invalid URL');
    });

    // --- Domain glob matching ---

    it('wildcard pattern does not match base domain', () => {
        const result = evaluateNetworkAccess(
            'https://github.com/path',
            makePolicy({ mode: 'approved-only', allowDomains: ['*.github.com'] }),
        );
        // *.github.com should NOT match github.com (only subdomains)
        expect(result.decision).toBe('confirm');
    });

    it('wildcard pattern matches one subdomain level', () => {
        const result = evaluateNetworkAccess(
            'https://api.github.com/repos',
            makePolicy({ mode: 'approved-only', allowDomains: ['*.github.com'] }),
        );
        expect(result.decision).toBe('allow');
    });

    it('case-insensitive domain matching', () => {
        const result = evaluateNetworkAccess(
            'https://API.GitHub.COM/repos',
            makePolicy({ mode: 'approved-only', allowDomains: ['api.github.com'] }),
        );
        expect(result.decision).toBe('allow');
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

    it('ftp: protocol → denied', () => {
        const result = evaluateNetworkAccess(
            'ftp://evil.com/file',
            makePolicy({ mode: 'open' }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('protocol');
    });

    it('file: protocol → denied', () => {
        const result = evaluateNetworkAccess(
            'file:///etc/passwd',
            makePolicy({ mode: 'open' }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('protocol');
    });

    it('data: protocol → denied', () => {
        const result = evaluateNetworkAccess(
            'data:text/html,<h1>test</h1>',
            makePolicy({ mode: 'open' }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('protocol');
    });

    // --- Expanded localhost detection ---

    it('127.0.0.2 → auto-allowed (loopback range)', () => {
        const result = evaluateNetworkAccess(
            'https://127.0.0.2:8080/api',
            makePolicy({ mode: 'approved-only' }),
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('localhost');
    });

    it('::ffff:127.0.0.1 → auto-allowed (IPv4-mapped IPv6)', () => {
        const result = evaluateNetworkAccess(
            'https://[::ffff:127.0.0.1]:8080/api',
            makePolicy({ mode: 'approved-only' }),
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
