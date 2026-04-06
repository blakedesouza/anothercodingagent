/**
 * M7.10 — Network Egress Integration tests.
 *
 * Tests extended shell detection (scp, rsync, docker pull, pip install, cargo install),
 * browser navigation policy checks, fetch_url integration, localhost exception
 * asymmetry, and network.checked event payload.
 */
import { describe, it, expect } from 'vitest';
import {
    evaluateNetworkAccess,
    evaluateBrowserNavigation,
    evaluateShellNetworkAccess,
    detectShellNetworkCommand,
} from '../../src/permissions/network-policy.js';
import type {
    NetworkPolicy,
    NetworkPolicyResult,
} from '../../src/permissions/network-policy.js';
import type { NetworkCheckedPayload } from '../../src/types/events.js';

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

/** Build a NetworkCheckedPayload from a policy result (mirrors what the tool runner would do). */
function buildCheckedPayload(
    result: NetworkPolicyResult,
    policy: NetworkPolicy,
    domain: string,
    source: 'url' | 'shell' | 'browser',
): NetworkCheckedPayload {
    return {
        domain,
        mode: policy.mode,
        decision: result.decision,
        reason: result.reason,
        source,
    };
}

// =============================================================================
// Shell network detection — 6 commands (parameterized)
// =============================================================================

describe('shell network detection — extended commands', () => {
    const offPolicy = makePolicy({ mode: 'off' });

    it.each([
        { cmd: 'ssh user@host', facet: 'network_access', domain: 'host' },
        { cmd: 'scp file host:', facet: 'network_access', domain: 'host' },
        { cmd: 'rsync -a dir host:', facet: 'network_access', domain: 'host' },
        { cmd: 'docker pull image', facet: 'package_install', domain: undefined },
        { cmd: 'pip install package', facet: 'package_install', domain: undefined },
        { cmd: 'cargo install crate', facet: 'package_install', domain: undefined },
    ])('$cmd with mode=off → denied', ({ cmd, facet, domain }) => {
        const result = evaluateShellNetworkAccess(cmd, offPolicy);
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('deny');
        expect(result!.reason).toContain('mode: off');
        expect(result!.facet).toBe(facet);

        // Also verify detection extracts the expected domain
        const detection = detectShellNetworkCommand(cmd);
        expect(detection.detected).toBe(true);
        expect(detection.domain).toBe(domain);
    });
});

// =============================================================================
// New shell pattern detection — individual tests
// =============================================================================

describe('detectShellNetworkCommand — new patterns', () => {
    it('detects scp with user@host:path', () => {
        const result = detectShellNetworkCommand('scp -r dir user@myhost.com:path');
        expect(result.detected).toBe(true);
        expect(result.facet).toBe('network_access');
        expect(result.domain).toBe('myhost.com');
    });

    it('detects scp with bare host: (no user@)', () => {
        const result = detectShellNetworkCommand('scp file host:');
        expect(result.detected).toBe(true);
        expect(result.domain).toBe('host');
    });

    it('detects rsync with remote spec', () => {
        const result = detectShellNetworkCommand('rsync -avz dir user@backup.io:/data');
        expect(result.detected).toBe(true);
        expect(result.facet).toBe('network_access');
        expect(result.domain).toBe('backup.io');
    });

    it('detects rsync with URL', () => {
        const result = detectShellNetworkCommand('rsync https://mirror.example.com/repo .');
        expect(result.detected).toBe(true);
        expect(result.domain).toBe('mirror.example.com');
    });

    it('detects docker pull', () => {
        const result = detectShellNetworkCommand('docker pull nginx:latest');
        expect(result.detected).toBe(true);
        expect(result.facet).toBe('package_install');
    });

    it('does not false-positive on docker build', () => {
        const result = detectShellNetworkCommand('docker build -t myapp .');
        expect(result.detected).toBe(false);
    });

    it('detects pip install', () => {
        const result = detectShellNetworkCommand('pip install requests');
        expect(result.detected).toBe(true);
        expect(result.facet).toBe('package_install');
    });

    it('detects pip3 install', () => {
        const result = detectShellNetworkCommand('pip3 install flask');
        expect(result.detected).toBe(true);
        expect(result.facet).toBe('package_install');
    });

    it('does not false-positive on pip list', () => {
        const result = detectShellNetworkCommand('pip list');
        expect(result.detected).toBe(false);
    });

    it('detects cargo install', () => {
        const result = detectShellNetworkCommand('cargo install ripgrep');
        expect(result.detected).toBe(true);
        expect(result.facet).toBe('package_install');
    });

    it('does not false-positive on cargo build', () => {
        const result = detectShellNetworkCommand('cargo build --release');
        expect(result.detected).toBe(false);
    });

    it('scp with -o ProxyJump=host:port → extracts correct target, not option value', () => {
        const result = detectShellNetworkCommand('scp -o ProxyJump=bastion.example.com:22 file target.com:');
        expect(result.detected).toBe(true);
        expect(result.domain).toBe('target.com');
    });

    it('rsync with -e flag argument → extracts correct remote host', () => {
        const result = detectShellNetworkCommand('rsync -avz -e ssh dir user@backup.io:/data');
        expect(result.detected).toBe(true);
        expect(result.domain).toBe('backup.io');
    });
});

// =============================================================================
// Browser navigation — evaluateBrowserNavigation
// =============================================================================

describe('evaluateBrowserNavigation', () => {
    it('denied domain → blocked before page load', () => {
        const result = evaluateBrowserNavigation(
            'https://evil.com/page',
            makePolicy({ denyDomains: ['evil.com'] }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('denyDomains');
    });

    it('mode=off → all navigation blocked', () => {
        const result = evaluateBrowserNavigation(
            'https://example.com',
            makePolicy({ mode: 'off' }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('mode: off');
    });

    it('allowed domain → navigation permitted', () => {
        const result = evaluateBrowserNavigation(
            'https://docs.example.com/page',
            makePolicy({ allowDomains: ['docs.example.com'] }),
        );
        expect(result.decision).toBe('allow');
    });

    it('localhost → auto-allowed for browser', () => {
        const result = evaluateBrowserNavigation(
            'http://localhost:3000/app',
            makePolicy({ mode: 'approved-only', allowHttp: true }),
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('localhost');
    });
});

// =============================================================================
// fetch_url integration
// =============================================================================

describe('fetch_url network policy integration', () => {
    it('fetch_url with mode=off → denied (network_disabled)', () => {
        // fetch_url uses evaluateNetworkAccess for HTTP tier
        const result = evaluateNetworkAccess(
            'https://example.com/api',
            makePolicy({ mode: 'off' }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('disabled');
    });

    it('fetch_url HTTP fallback to Playwright → both check policy', () => {
        const policy = makePolicy({ denyDomains: ['evil.com'] });
        const url = 'https://evil.com/page';

        // HTTP tier check (evaluateNetworkAccess)
        const httpResult = evaluateNetworkAccess(url, policy);
        expect(httpResult.decision).toBe('deny');

        // Playwright fallback also checks (evaluateBrowserNavigation)
        const playwrightResult = evaluateBrowserNavigation(url, policy);
        expect(playwrightResult.decision).toBe('deny');

        // Both agree
        expect(httpResult.decision).toBe(playwrightResult.decision);
    });

    it('fetch_url allowed domain passes both tiers', () => {
        const policy = makePolicy({ allowDomains: ['api.example.com'] });
        const url = 'https://api.example.com/data';

        const httpResult = evaluateNetworkAccess(url, policy);
        const playwrightResult = evaluateBrowserNavigation(url, policy);

        expect(httpResult.decision).toBe('allow');
        expect(playwrightResult.decision).toBe('allow');
    });
});

// =============================================================================
// Localhost exception — asymmetric (URL vs shell)
// =============================================================================

describe('localhost exception refinement', () => {
    it('fetch_url http://localhost:3000 → allowed (URL-based, localhost auto-allowed)', () => {
        const result = evaluateNetworkAccess(
            'http://localhost:3000',
            makePolicy({ mode: 'approved-only', allowHttp: true }),
        );
        expect(result.decision).toBe('allow');
        expect(result.reason).toContain('localhost');
    });

    it('exec_command "curl localhost" → best-effort detection, not auto-allowed', () => {
        const result = evaluateShellNetworkAccess(
            'curl http://localhost:3000/api',
            makePolicy({ mode: 'approved-only' }),
        );
        expect(result).not.toBeNull();
        // Shell commands do NOT get the localhost exception
        expect(result!.decision).toBe('confirm');
        expect(result!.decision).not.toBe('allow');
    });

    it('browser localhost → auto-allowed (URL-based semantics)', () => {
        const result = evaluateBrowserNavigation(
            'http://localhost:8080',
            makePolicy({ mode: 'approved-only', allowHttp: true }),
        );
        expect(result.decision).toBe('allow');
    });

    it('shell ssh to localhost → not auto-allowed', () => {
        // ssh localhost should still require confirmation in approved-only mode
        const result = evaluateShellNetworkAccess(
            'ssh localhost',
            makePolicy({ mode: 'approved-only' }),
        );
        expect(result).not.toBeNull();
        expect(result!.decision).toBe('confirm');
    });
});

// =============================================================================
// Network event payload construction
// =============================================================================

describe('network.checked event payload', () => {
    it('URL check emits correct payload shape', () => {
        const policy = makePolicy({ mode: 'approved-only', allowDomains: ['api.github.com'] });
        const result = evaluateNetworkAccess('https://api.github.com/repos', policy);

        const payload = buildCheckedPayload(result, policy, 'api.github.com', 'url');

        expect(payload).toEqual({
            domain: 'api.github.com',
            mode: 'approved-only',
            decision: 'allow',
            reason: expect.stringContaining('allowDomains'),
            source: 'url',
        });
    });

    it('shell check emits correct payload with deny decision', () => {
        const policy = makePolicy({ mode: 'off' });
        const result = evaluateShellNetworkAccess('curl https://evil.com', policy)!;
        const detection = detectShellNetworkCommand('curl https://evil.com');

        const payload = buildCheckedPayload(
            result,
            policy,
            detection.domain ?? 'unknown',
            'shell',
        );

        expect(payload).toEqual({
            domain: 'evil.com',
            mode: 'off',
            decision: 'deny',
            reason: expect.stringContaining('disabled'),
            source: 'shell',
        });
    });

    it('browser check emits correct payload', () => {
        const policy = makePolicy({ denyDomains: ['blocked.com'] });
        const result = evaluateBrowserNavigation('https://blocked.com/page', policy);

        const payload = buildCheckedPayload(result, policy, 'blocked.com', 'browser');

        expect(payload).toEqual({
            domain: 'blocked.com',
            mode: 'approved-only',
            decision: 'deny',
            reason: expect.stringContaining('denyDomains'),
            source: 'browser',
        });
    });

    it('payload satisfies NetworkCheckedPayload type contract', () => {
        const policy = makePolicy({ mode: 'open' });
        const result = evaluateNetworkAccess('https://example.com', policy);
        const payload: NetworkCheckedPayload = buildCheckedPayload(
            result,
            policy,
            'example.com',
            'url',
        );

        // Type assertion: all required fields are present and correctly typed
        expect(typeof payload.domain).toBe('string');
        expect(['off', 'approved-only', 'open']).toContain(payload.mode);
        expect(['allow', 'confirm', 'deny']).toContain(payload.decision);
        expect(typeof payload.reason).toBe('string');
        expect(['url', 'shell', 'browser']).toContain(payload.source);
    });
});
