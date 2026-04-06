import { describe, it, expect } from 'vitest';
import {
    resolveApproval,
    formatApprovalPrompt,
    parseApprovalResponse,
} from '../../src/permissions/approval.js';
import type { ApprovalRequest, ApprovalOptions } from '../../src/permissions/approval.js';
import { SessionGrantStore } from '../../src/permissions/session-grants.js';
import { CONFIG_DEFAULTS } from '../../src/config/schema.js';
import type { ResolvedConfig } from '../../src/config/schema.js';
import type { CommandRiskAssessment } from '../../src/tools/command-risk-analyzer.js';

// --- Helpers ---

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
    return { ...CONFIG_DEFAULTS, ...overrides } as ResolvedConfig;
}

function makeConfigWithPermissions(
    perms: Partial<ResolvedConfig['permissions']>,
): ResolvedConfig {
    return {
        ...CONFIG_DEFAULTS,
        permissions: { ...CONFIG_DEFAULTS.permissions, ...perms },
    } as ResolvedConfig;
}

function makeOptions(overrides: Partial<ApprovalOptions> = {}): ApprovalOptions {
    return {
        config: makeConfig(),
        sessionGrants: new SessionGrantStore(),
        noConfirm: false,
        ...overrides,
    };
}

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
    return {
        toolName: 'read_file',
        toolArgs: {},
        approvalClass: 'read-only',
        ...overrides,
    };
}

const normalRisk: CommandRiskAssessment = {
    tier: 'normal',
    facets: [],
    reason: 'command appears safe',
};

const highRisk: CommandRiskAssessment = {
    tier: 'high',
    facets: ['privilege_escalation'],
    reason: 'privilege escalation via sudo',
};

const forbiddenRisk: CommandRiskAssessment = {
    tier: 'forbidden',
    facets: ['filesystem_delete', 'filesystem_recursive'],
    reason: 'rm -r targets dangerous path: /',
};

// ---------------------------------------------------------------------------
// Step 1: Profile check
// ---------------------------------------------------------------------------

describe('step 1: profile check', () => {
    it('tool not in profile → denied', () => {
        const result = resolveApproval(
            makeRequest({ toolName: 'exec_command', approvalClass: 'external-effect' }),
            makeOptions({ allowedTools: ['read_file', 'write_file'] }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('not permitted by agent profile');
        expect(result.step).toBe(1);
    });

    it('tool in profile → proceeds past step 1', () => {
        const result = resolveApproval(
            makeRequest(),
            makeOptions({ allowedTools: ['read_file'] }),
        );
        expect(result.decision).toBe('allow');
    });

    it('allowedTools null → all tools allowed', () => {
        const result = resolveApproval(
            makeRequest({ toolName: 'exec_command', approvalClass: 'external-effect' }),
            makeOptions({ allowedTools: null }),
        );
        expect(result.decision).not.toBe('deny');
    });

    it('allowedTools undefined → all tools allowed', () => {
        const result = resolveApproval(
            makeRequest({ toolName: 'exec_command', approvalClass: 'external-effect' }),
            makeOptions(),
        );
        expect(result.decision).not.toBe('deny');
    });

    it('tool in blockedTools → denied at step 1', () => {
        const config = makeConfigWithPermissions({
            blockedTools: ['exec_command'],
        });
        const result = resolveApproval(
            makeRequest({ toolName: 'exec_command', approvalClass: 'external-effect' }),
            makeOptions({ config }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('blocked');
        expect(result.step).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Step 2: Sandbox check
// ---------------------------------------------------------------------------

describe('step 2: sandbox check', () => {
    it('sandbox violation → denied at step 2 regardless of other rules', () => {
        const result = resolveApproval(
            makeRequest(),
            makeOptions({ sandboxViolation: true }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('workspace boundary');
        expect(result.step).toBe(2);
    });

    it('no sandbox violation → proceeds', () => {
        const result = resolveApproval(
            makeRequest(),
            makeOptions({ sandboxViolation: false }),
        );
        expect(result.decision).toBe('allow');
    });
});

// ---------------------------------------------------------------------------
// Step 3: Risk analysis
// ---------------------------------------------------------------------------

describe('step 3: risk analysis', () => {
    it('forbidden command → denied at step 3', () => {
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'rm -rf /' },
                approvalClass: 'external-effect',
                riskAssessment: forbiddenRisk,
            }),
            makeOptions(),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toContain('forbidden');
        expect(result.step).toBe(3);
    });

    it('forbidden command with --no-confirm → still denied', () => {
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'rm -rf /' },
                approvalClass: 'external-effect',
                riskAssessment: forbiddenRisk,
            }),
            makeOptions({ noConfirm: true }),
        );
        expect(result.decision).toBe('deny');
        expect(result.step).toBe(3);
    });

    it('high risk command → requires confirmation', () => {
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'sudo apt-get install foo' },
                approvalClass: 'external-effect',
                riskAssessment: highRisk,
            }),
            makeOptions(),
        );
        expect(result.decision).toBe('confirm');
    });

    it('high risk + --no-confirm alone → still confirm (not auto-approved)', () => {
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'sudo apt-get install foo' },
                approvalClass: 'external-effect',
                riskAssessment: highRisk,
            }),
            makeOptions({ noConfirm: true }),
        );
        expect(result.decision).toBe('confirm');
    });
});

// ---------------------------------------------------------------------------
// Step 4: Class-level policy (default decisions)
// ---------------------------------------------------------------------------

describe('step 4: class-level policy', () => {
    it('read_file → auto-approved (read-only class)', () => {
        const result = resolveApproval(
            makeRequest({ toolName: 'read_file', approvalClass: 'read-only' }),
            makeOptions(),
        );
        expect(result.decision).toBe('allow');
    });

    it('write_file → requires confirmation (workspace-write)', () => {
        const result = resolveApproval(
            makeRequest({ toolName: 'write_file', approvalClass: 'workspace-write' }),
            makeOptions(),
        );
        expect(result.decision).toBe('confirm');
    });

    it('exec_command → requires confirmation (external-effect)', () => {
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'npm test' },
                approvalClass: 'external-effect',
            }),
            makeOptions(),
        );
        expect(result.decision).toBe('confirm');
    });

    it('ask_user → auto-approved (user-facing)', () => {
        const result = resolveApproval(
            makeRequest({ toolName: 'ask_user', approvalClass: 'user-facing' }),
            makeOptions(),
        );
        expect(result.decision).toBe('allow');
    });

    it('exec_command with --no-confirm → auto-approved (normal risk)', () => {
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'npm test' },
                approvalClass: 'external-effect',
                riskAssessment: normalRisk,
            }),
            makeOptions({ noConfirm: true }),
        );
        expect(result.decision).toBe('allow');
    });
});

// ---------------------------------------------------------------------------
// confirm_always: delete_path / move_path escalation
// ---------------------------------------------------------------------------

describe('confirm_always escalation', () => {
    it('delete_path → confirm_always', () => {
        const result = resolveApproval(
            makeRequest({ toolName: 'delete_path', approvalClass: 'workspace-write' }),
            makeOptions(),
        );
        expect(result.decision).toBe('confirm_always');
    });

    it('move_path → confirm_always', () => {
        const result = resolveApproval(
            makeRequest({ toolName: 'move_path', approvalClass: 'workspace-write' }),
            makeOptions(),
        );
        expect(result.decision).toBe('confirm_always');
    });

    it('delete_path with --no-confirm → still confirm_always', () => {
        const result = resolveApproval(
            makeRequest({ toolName: 'delete_path', approvalClass: 'workspace-write' }),
            makeOptions({ noConfirm: true }),
        );
        expect(result.decision).toBe('confirm_always');
    });

    it('move_path with --no-confirm → still confirm_always', () => {
        const result = resolveApproval(
            makeRequest({ toolName: 'move_path', approvalClass: 'workspace-write' }),
            makeOptions({ noConfirm: true }),
        );
        expect(result.decision).toBe('confirm_always');
    });

    it('confirm_always is not deny — user can approve with [y]', () => {
        const result = resolveApproval(
            makeRequest({ toolName: 'delete_path', approvalClass: 'workspace-write' }),
            makeOptions(),
        );
        // confirm_always is a confirm variant, not deny
        expect(result.decision).not.toBe('deny');
        expect(result.decision).toBe('confirm_always');
    });

    it('delete_path with explicit toolOverride=allow → no escalation', () => {
        const config = makeConfigWithPermissions({
            toolOverrides: { delete_path: 'allow' },
        });
        const result = resolveApproval(
            makeRequest({ toolName: 'delete_path', approvalClass: 'workspace-write' }),
            makeOptions({ config }),
        );
        expect(result.decision).toBe('allow');
    });

    it('workspace-write classOverride=allow still escalates delete_path', () => {
        const config = makeConfigWithPermissions({
            classOverrides: { 'workspace-write': 'allow' },
        });
        const result = resolveApproval(
            makeRequest({ toolName: 'delete_path', approvalClass: 'workspace-write' }),
            makeOptions({ config }),
        );
        expect(result.decision).toBe('confirm_always');
    });
});

// ---------------------------------------------------------------------------
// Step 5: Pre-auth rules
// ---------------------------------------------------------------------------

describe('step 5: pre-auth rules', () => {
    it('matching preauth allow rule → auto-approved at step 5', () => {
        const config = makeConfigWithPermissions({
            preauth: [{
                id: 'r1',
                tool: 'exec_command',
                match: { commandRegex: '^npm (test|build)$' },
                decision: 'allow',
                scope: 'permanent',
            }],
        });
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'npm test' },
                approvalClass: 'external-effect',
            }),
            makeOptions({ config }),
        );
        expect(result.decision).toBe('allow');
        expect(result.step).toBe(5);
        expect(result.reason).toContain('preauth rule');
    });

    it('preauth regex does not match → proceeds to later steps', () => {
        const config = makeConfigWithPermissions({
            preauth: [{
                id: 'r1',
                tool: 'exec_command',
                match: { commandRegex: '^npm (test|build)$' },
                decision: 'allow',
                scope: 'permanent',
            }],
        });
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'npm install' },
                approvalClass: 'external-effect',
            }),
            makeOptions({ config }),
        );
        expect(result.decision).toBe('confirm');
        expect(result.step).toBe(7);
    });

    it('preauth deny rule → denied at step 5', () => {
        const config = makeConfigWithPermissions({
            preauth: [{
                id: 'r1',
                tool: 'exec_command',
                match: { commandRegex: '^npm install' },
                decision: 'deny',
                scope: 'permanent',
            }],
        });
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'npm install lodash' },
                approvalClass: 'external-effect',
            }),
            makeOptions({ config }),
        );
        expect(result.decision).toBe('deny');
        expect(result.step).toBe(5);
    });

    it('preauth allow overrides high risk', () => {
        const config = makeConfigWithPermissions({
            preauth: [{
                id: 'r1',
                tool: 'exec_command',
                match: { commandRegex: '^sudo make install$' },
                decision: 'allow',
                scope: 'permanent',
            }],
        });
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'sudo make install' },
                approvalClass: 'external-effect',
                riskAssessment: highRisk,
            }),
            makeOptions({ config }),
        );
        expect(result.decision).toBe('allow');
        expect(result.step).toBe(5);
    });
});

// ---------------------------------------------------------------------------
// Step 6: Session grants
// ---------------------------------------------------------------------------

describe('step 6: session grants', () => {
    it('session grant for npm test → auto-approved', () => {
        const grants = new SessionGrantStore();
        grants.addGrant('exec_command', 'npm test');
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'npm test' },
                approvalClass: 'external-effect',
            }),
            makeOptions({ sessionGrants: grants }),
        );
        expect(result.decision).toBe('allow');
        expect(result.step).toBe(6);
        expect(result.reason).toBe('session grant');
    });

    it('session grant scoping: grant for npm test does not approve npm install', () => {
        const grants = new SessionGrantStore();
        grants.addGrant('exec_command', 'npm test');
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'npm install' },
                approvalClass: 'external-effect',
            }),
            makeOptions({ sessionGrants: grants }),
        );
        expect(result.decision).toBe('confirm');
    });

    it('session grant overrides high risk', () => {
        const grants = new SessionGrantStore();
        grants.addGrant('exec_command', 'sudo make install');
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'sudo make install' },
                approvalClass: 'external-effect',
                riskAssessment: highRisk,
            }),
            makeOptions({ sessionGrants: grants }),
        );
        expect(result.decision).toBe('allow');
        expect(result.step).toBe(6);
    });

    it('tool-level session grant for write_file', () => {
        const grants = new SessionGrantStore();
        grants.addGrant('write_file');
        const result = resolveApproval(
            makeRequest({ toolName: 'write_file', approvalClass: 'workspace-write' }),
            makeOptions({ sessionGrants: grants }),
        );
        expect(result.decision).toBe('allow');
        expect(result.step).toBe(6);
    });
});

// ---------------------------------------------------------------------------
// Risk analysis covers open_session and session_io
// ---------------------------------------------------------------------------

describe('risk analysis: open_session and session_io', () => {
    it('open_session with forbidden command → denied', () => {
        const result = resolveApproval(
            makeRequest({
                toolName: 'open_session',
                toolArgs: { command: 'bash -c \'rm -rf /\'' },
                approvalClass: 'external-effect',
                riskAssessment: forbiddenRisk,
            }),
            makeOptions(),
        );
        expect(result.decision).toBe('deny');
        expect(result.step).toBe(3);
    });

    it('session_io with forbidden stdin → denied', () => {
        const result = resolveApproval(
            makeRequest({
                toolName: 'session_io',
                toolArgs: { stdin: 'rm -rf /', session_id: 's1' },
                approvalClass: 'external-effect',
                riskAssessment: forbiddenRisk,
            }),
            makeOptions(),
        );
        expect(result.decision).toBe('deny');
        expect(result.step).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// Config overrides
// ---------------------------------------------------------------------------

describe('config overrides', () => {
    it('toolOverride to allow bypasses default confirm', () => {
        const config = makeConfigWithPermissions({
            toolOverrides: { write_file: 'allow' },
        });
        const result = resolveApproval(
            makeRequest({ toolName: 'write_file', approvalClass: 'workspace-write' }),
            makeOptions({ config }),
        );
        expect(result.decision).toBe('allow');
    });

    it('classOverride to allow for workspace-write', () => {
        const config = makeConfigWithPermissions({
            classOverrides: { 'workspace-write': 'allow' },
        });
        const result = resolveApproval(
            makeRequest({ toolName: 'write_file', approvalClass: 'workspace-write' }),
            makeOptions({ config }),
        );
        expect(result.decision).toBe('allow');
    });

    it('toolOverride takes precedence over classOverride', () => {
        const config = makeConfigWithPermissions({
            classOverrides: { 'workspace-write': 'allow' },
            toolOverrides: { write_file: 'confirm' },
        });
        const result = resolveApproval(
            makeRequest({ toolName: 'write_file', approvalClass: 'workspace-write' }),
            makeOptions({ config }),
        );
        expect(result.decision).toBe('confirm');
    });
});

// ---------------------------------------------------------------------------
// formatApprovalPrompt
// ---------------------------------------------------------------------------

describe('formatApprovalPrompt', () => {
    it('includes tool name and choices', () => {
        const prompt = formatApprovalPrompt(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'npm install', cwd: '/home/user/project' },
                approvalClass: 'external-effect',
            }),
        );
        expect(prompt).toContain('exec_command');
        expect(prompt).toContain('npm install');
        expect(prompt).toContain('/home/user/project');
        expect(prompt).toContain('[y] approve');
        expect(prompt).toContain('[n] deny');
        expect(prompt).toContain('[a] always');
        expect(prompt).toContain('[e] edit');
    });

    it('includes risk facets when provided', () => {
        const risk: CommandRiskAssessment = {
            tier: 'high',
            facets: ['network_download', 'package_install'],
            reason: 'test',
        };
        const prompt = formatApprovalPrompt(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'npm install lodash' },
                approvalClass: 'external-effect',
            }),
            risk,
        );
        expect(prompt).toContain('network_download');
        expect(prompt).toContain('package_install');
    });

    it('omits risk line when no facets', () => {
        const prompt = formatApprovalPrompt(
            makeRequest({
                toolName: 'write_file',
                toolArgs: { path: '/tmp/file.txt' },
                approvalClass: 'workspace-write',
            }),
        );
        expect(prompt).not.toContain('Risk:');
    });
});

// ---------------------------------------------------------------------------
// parseApprovalResponse
// ---------------------------------------------------------------------------

describe('parseApprovalResponse', () => {
    it('y → approve', () => {
        expect(parseApprovalResponse('y').choice).toBe('approve');
    });

    it('Y → approve (case insensitive)', () => {
        expect(parseApprovalResponse('Y').choice).toBe('approve');
    });

    it('n → deny', () => {
        expect(parseApprovalResponse('n').choice).toBe('deny');
    });

    it('a → always', () => {
        expect(parseApprovalResponse('a').choice).toBe('always');
    });

    it('e → edit', () => {
        expect(parseApprovalResponse('e').choice).toBe('edit');
    });

    it('empty string → deny (default)', () => {
        expect(parseApprovalResponse('').choice).toBe('deny');
    });

    it('unknown input → deny (default)', () => {
        expect(parseApprovalResponse('x').choice).toBe('deny');
    });

    it('handles whitespace', () => {
        expect(parseApprovalResponse('  y  ').choice).toBe('approve');
    });
});

// ---------------------------------------------------------------------------
// Consultation fixes: confirm_always protection
// ---------------------------------------------------------------------------

describe('confirm_always cannot be bypassed by session grants', () => {
    it('session grant for delete_path → still confirm_always', () => {
        const grants = new SessionGrantStore();
        grants.addGrant('delete_path');
        const result = resolveApproval(
            makeRequest({ toolName: 'delete_path', approvalClass: 'workspace-write' }),
            makeOptions({ sessionGrants: grants }),
        );
        expect(result.decision).toBe('confirm_always');
        expect(result.step).toBe(7);
    });

    it('session grant for move_path → still confirm_always', () => {
        const grants = new SessionGrantStore();
        grants.addGrant('move_path');
        const result = resolveApproval(
            makeRequest({ toolName: 'move_path', approvalClass: 'workspace-write' }),
            makeOptions({ sessionGrants: grants }),
        );
        expect(result.decision).toBe('confirm_always');
    });
});

describe('invalid config override values ignored', () => {
    it('invalid toolOverride value → falls through to class default', () => {
        const config = makeConfigWithPermissions({
            toolOverrides: { write_file: 'maybe_allow' },
        });
        const result = resolveApproval(
            makeRequest({ toolName: 'write_file', approvalClass: 'workspace-write' }),
            makeOptions({ config }),
        );
        // Invalid value ignored, falls through to workspace-write default (confirm)
        expect(result.decision).toBe('confirm');
    });

    it('invalid classOverride value → falls through to class default', () => {
        const config = makeConfigWithPermissions({
            classOverrides: { 'workspace-write': 'yolo' },
        });
        const result = resolveApproval(
            makeRequest({ toolName: 'write_file', approvalClass: 'workspace-write' }),
            makeOptions({ config }),
        );
        expect(result.decision).toBe('confirm');
    });
});

describe('empty command normalization', () => {
    it('empty command string treated as no command', () => {
        const grants = new SessionGrantStore();
        grants.addGrant('exec_command', 'npm test');
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: '' },
                approvalClass: 'external-effect',
            }),
            makeOptions({ sessionGrants: grants }),
        );
        // Empty command should not match the 'npm test' grant
        expect(result.decision).toBe('confirm');
    });
});

// ---------------------------------------------------------------------------
// Integration: step ordering and composition
// ---------------------------------------------------------------------------

describe('step ordering', () => {
    it('step 1 (profile) blocks before step 2 (sandbox)', () => {
        const result = resolveApproval(
            makeRequest({ toolName: 'exec_command', approvalClass: 'external-effect' }),
            makeOptions({
                allowedTools: ['read_file'],
                sandboxViolation: true,
            }),
        );
        expect(result.step).toBe(1);
    });

    it('step 2 (sandbox) blocks before step 3 (risk)', () => {
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                approvalClass: 'external-effect',
                riskAssessment: forbiddenRisk,
            }),
            makeOptions({ sandboxViolation: true }),
        );
        expect(result.step).toBe(2);
    });

    it('step 3 (risk forbidden) blocks before step 5 (preauth)', () => {
        const config = makeConfigWithPermissions({
            preauth: [{
                id: 'r1',
                tool: 'exec_command',
                match: {},
                decision: 'allow',
                scope: 'permanent',
            }],
        });
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'rm -rf /' },
                approvalClass: 'external-effect',
                riskAssessment: forbiddenRisk,
            }),
            makeOptions({ config }),
        );
        expect(result.step).toBe(3);
        expect(result.decision).toBe('deny');
    });

    // --- M2 review regression: by-design behaviors confirmed ---

    it('toolOverride can bypass confirm_always (by design: "unless explicitly overridden per-tool")', () => {
        const config = makeConfigWithPermissions({
            toolOverrides: { delete_path: 'allow' },
        });
        const result = resolveApproval(
            makeRequest({
                toolName: 'delete_path',
                approvalClass: 'workspace-write',
            }),
            makeOptions({ config }),
        );
        // Per spec: toolOverrides is the "explicit override per-tool" escape hatch
        expect(result.decision).toBe('allow');
    });

    it('preauth allow overrides high-risk (by design: spec says preauth can auto-approve)', () => {
        const config = makeConfigWithPermissions({
            preauth: [{
                id: 'trusted-push',
                tool: 'exec_command',
                match: { commandRegex: '^git push' },
                decision: 'allow',
                scope: 'permanent',
            }],
        });
        const result = resolveApproval(
            makeRequest({
                toolName: 'exec_command',
                toolArgs: { command: 'git push --force' },
                approvalClass: 'external-effect',
                riskAssessment: highRisk,
            }),
            makeOptions({ config }),
        );
        // Per spec: "Pre-authorization rules can auto-approve specific patterns"
        expect(result.step).toBe(5);
        expect(result.decision).toBe('allow');
    });
});
