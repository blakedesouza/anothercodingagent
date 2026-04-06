/**
 * Approval Flow — 7-step permission resolution for each tool call.
 *
 * Composes agent profile, sandbox, risk analysis, class-level policy,
 * pre-authorization rules, and session grants into a single decision.
 *
 * Depends on:
 * - ResolvedConfig (M2.5) for policy settings
 * - CommandRiskAnalyzer (M2.3) for exec_command risk assessment
 * - WorkspaceSandbox (M2.4) for zone enforcement
 * - ToolSpec (M1.5) for approval class
 */

import type { ApprovalClass } from '../tools/tool-registry.js';
import type { ResolvedConfig } from '../config/schema.js';
import type { CommandRiskAssessment } from '../tools/command-risk-analyzer.js';
import { matchPreauthRules } from './preauth.js';
import type { SessionGrantStore } from './session-grants.js';

// --- Types ---

/**
 * Approval decisions:
 * - allow: proceed without prompting
 * - confirm: prompt user (auto-approved by --no-confirm)
 * - confirm_always: prompt user (NOT auto-approved by --no-confirm)
 * - deny: refuse unconditionally
 */
export type ApprovalDecision = 'allow' | 'confirm' | 'confirm_always' | 'deny';

export interface ApprovalResult {
    decision: ApprovalDecision;
    reason: string;
    /** Which algorithm step produced the decision (1-7). */
    step: number;
}

export interface ApprovalRequest {
    toolName: string;
    toolArgs: Record<string, unknown>;
    approvalClass: ApprovalClass;
    /** Pre-computed risk assessment for exec_command/open_session/session_io. */
    riskAssessment?: CommandRiskAssessment;
}

export interface ApprovalOptions {
    config: ResolvedConfig;
    sessionGrants: SessionGrantStore;
    /** CLI --no-confirm flag: auto-approve 'confirm' (not 'confirm_always' or 'deny'). */
    noConfirm: boolean;
    /** Agent profile allowed tools. null = all tools allowed. */
    allowedTools?: string[] | null;
    /** true if sandbox check (checkZone) already failed for this call. */
    sandboxViolation?: boolean;
}

/** User's response to a confirmation prompt. */
export interface ApprovalPromptResult {
    choice: 'approve' | 'deny' | 'always' | 'edit';
}

// --- Tools that escalate to confirm_always ---

const CONFIRM_ALWAYS_TOOLS = new Set(['delete_path', 'move_path']);

const VALID_DECISIONS = new Set<ApprovalDecision>(['allow', 'confirm', 'confirm_always', 'deny']);

function isValidDecision(value: unknown): value is ApprovalDecision {
    return typeof value === 'string' && VALID_DECISIONS.has(value as ApprovalDecision);
}

// --- Helpers ---

/** Extract command string from tool args (for exec/session tools). Empty strings normalize to undefined. */
function extractCommand(toolName: string, args: Record<string, unknown>): string | undefined {
    if (toolName === 'exec_command' || toolName === 'open_session') {
        const cmd = typeof args.command === 'string' ? args.command : undefined;
        return cmd && cmd.length > 0 ? cmd : undefined;
    }
    if (toolName === 'session_io') {
        const stdin = typeof args.stdin === 'string' ? args.stdin : undefined;
        return stdin && stdin.length > 0 ? stdin : undefined;
    }
    return undefined;
}

/** Extract cwd from tool args. */
function extractCwd(args: Record<string, unknown>): string | undefined {
    return typeof args.cwd === 'string' ? args.cwd : undefined;
}

/**
 * Determine the base approval decision from class + config overrides.
 *
 * Priority: toolOverrides > classOverrides > class defaults.
 * delete_path/move_path escalate to confirm_always unless the tool
 * has an explicit toolOverride.
 */
function getBaseDecision(
    toolName: string,
    approvalClass: ApprovalClass,
    config: ResolvedConfig,
): ApprovalDecision {
    // Tool-level override is most specific — honored for all tools including delete/move
    const toolOverride = config.permissions.toolOverrides[toolName];
    if (isValidDecision(toolOverride)) {
        return toolOverride;
    }

    // Class-level override (ignored if not a valid ApprovalDecision)
    const classOverride = config.permissions.classOverrides[approvalClass];
    const validClassOverride = isValidDecision(classOverride) ? classOverride : undefined;

    // Default decision by class
    let decision: ApprovalDecision;
    switch (approvalClass) {
        case 'read-only':
            decision = validClassOverride ?? 'allow';
            break;
        case 'workspace-write':
            decision = validClassOverride ?? 'confirm';
            break;
        case 'external-effect':
            decision = validClassOverride ?? 'confirm';
            break;
        case 'user-facing':
            // User-facing tools (ask_user, confirm_action) handle their own
            // interaction — they are always allowed at the approval layer
            decision = validClassOverride ?? 'allow';
            break;
    }

    // Escalation: delete_path/move_path → confirm_always even if class is 'allow',
    // unless there was a specific toolOverride (already returned above)
    if (CONFIRM_ALWAYS_TOOLS.has(toolName) && decision !== 'deny') {
        if (decision === 'allow' || decision === 'confirm') {
            decision = 'confirm_always';
        }
    }

    return decision;
}

// --- Main resolver ---

/**
 * Resolve the approval decision for a tool call using the 7-step algorithm.
 *
 * Steps:
 * 1. Profile check — tool in allowed set?
 * 2. Sandbox check — path in zone? (pre-computed)
 * 3. Risk analysis — forbidden/high/normal?
 * 4. Class-level policy — base decision from approval class + config overrides
 * 5. Pre-authorization match — user-config preauth rules
 * 6. Session grants — runtime grants from earlier in session
 * 7. Final decision — apply --no-confirm, enforce risk minimums
 */
export function resolveApproval(
    request: ApprovalRequest,
    options: ApprovalOptions,
): ApprovalResult {
    const { toolName, toolArgs, approvalClass, riskAssessment } = request;
    const { config, sessionGrants, noConfirm, allowedTools, sandboxViolation } = options;

    // Step 1: Profile check
    if (allowedTools !== undefined && allowedTools !== null) {
        if (!allowedTools.includes(toolName)) {
            return { decision: 'deny', reason: 'not permitted by agent profile', step: 1 };
        }
    }
    if (config.permissions.blockedTools.includes(toolName)) {
        return { decision: 'deny', reason: 'tool is blocked by configuration', step: 1 };
    }

    // Step 2: Sandbox check (pre-computed by caller)
    if (sandboxViolation) {
        return { decision: 'deny', reason: 'outside workspace boundary', step: 2 };
    }

    // Step 3: Risk analysis (for exec_command, open_session, session_io)
    if (riskAssessment) {
        if (riskAssessment.tier === 'forbidden') {
            return {
                decision: 'deny',
                reason: `forbidden: ${riskAssessment.reason}`,
                step: 3,
            };
        }
    }
    const isHighRisk = riskAssessment?.tier === 'high';

    // Step 4: Class-level policy
    let decision = getBaseDecision(toolName, approvalClass, config);

    // Step 5: Pre-authorization match
    const command = extractCommand(toolName, toolArgs);
    const cwd = extractCwd(toolArgs);
    const preauthRule = matchPreauthRules(config.permissions.preauth, {
        toolName,
        command,
        cwd,
    });
    if (preauthRule) {
        if (preauthRule.decision === 'deny') {
            return {
                decision: 'deny',
                reason: `denied by preauth rule: ${preauthRule.id}`,
                step: 5,
            };
        }
        if (preauthRule.decision === 'allow') {
            return {
                decision: 'allow',
                reason: `allowed by preauth rule: ${preauthRule.id}`,
                step: 5,
            };
        }
    }

    // Step 6: Session grants — cannot bypass 'confirm_always' (destructive ops)
    if (decision !== 'deny' && decision !== 'confirm_always'
        && sessionGrants.hasGrant(toolName, command)) {
        return { decision: 'allow', reason: 'session grant', step: 6 };
    }

    // Step 7: Final decision
    // For high risk, enforce minimum 'confirm' — --no-confirm alone cannot override
    if (isHighRisk && (decision === 'allow')) {
        decision = 'confirm';
    }

    // --no-confirm: converts 'confirm' → 'allow' (but NOT for high risk, confirm_always, or deny)
    if (noConfirm && decision === 'confirm' && !isHighRisk) {
        decision = 'allow';
    }

    const reason = decisionReason(decision, approvalClass, isHighRisk);
    return { decision, reason, step: 7 };
}

function decisionReason(
    decision: ApprovalDecision,
    approvalClass: ApprovalClass,
    isHighRisk: boolean,
): string {
    switch (decision) {
        case 'allow':
            return `auto-approved (${approvalClass})`;
        case 'confirm':
            return isHighRisk
                ? 'high-risk command requires confirmation'
                : `${approvalClass} requires confirmation`;
        case 'confirm_always':
            return 'destructive operation requires confirmation (--no-confirm cannot override)';
        case 'deny':
            return 'denied by policy';
    }
}

// --- Confirmation prompt ---

/**
 * Format a human-readable confirmation prompt for a tool call.
 */
export function formatApprovalPrompt(
    request: ApprovalRequest,
    riskAssessment?: CommandRiskAssessment,
): string {
    const lines: string[] = [];
    lines.push(`⚠ ${request.toolName} requires confirmation`);

    const command = extractCommand(request.toolName, request.toolArgs);
    if (command) {
        lines.push(`  Command: ${command}`);
    }

    if (riskAssessment && riskAssessment.facets.length > 0) {
        lines.push(`  Risk: ${riskAssessment.facets.join(', ')}`);
    }

    const cwd = extractCwd(request.toolArgs);
    if (cwd) {
        lines.push(`  Working directory: ${cwd}`);
    }

    lines.push('');
    lines.push('  [y] approve    [n] deny    [a] always (this session)    [e] edit command');
    return lines.join('\n');
}

/**
 * Parse a user's response to a confirmation prompt.
 */
export function parseApprovalResponse(response: string): ApprovalPromptResult {
    const ch = response.trim().toLowerCase().charAt(0);
    switch (ch) {
        case 'y': return { choice: 'approve' };
        case 'a': return { choice: 'always' };
        case 'e': return { choice: 'edit' };
        default:  return { choice: 'deny' };
    }
}
