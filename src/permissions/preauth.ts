/**
 * Pre-authorization rule matching.
 *
 * Pre-auth rules come from user config only (never project config).
 * Each rule specifies a tool name, optional command regex, optional cwd
 * pattern, and a decision (allow/deny).
 */

import type { PreauthRule } from '../config/schema.js';
import { isAbsolute, relative, resolve } from 'node:path';

export interface PreauthMatchInput {
    toolName: string;
    /** For exec_command/open_session: the command string. For session_io: stdin. */
    command?: string;
    /** Working directory for the tool call. */
    cwd?: string;
}

/**
 * Find the first matching pre-authorization rule for a tool call.
 *
 * Rules are evaluated in order — first match wins.
 * Returns null if no rule matches.
 */
export function matchPreauthRules(
    rules: PreauthRule[],
    input: PreauthMatchInput,
): PreauthRule | null {
    for (const rule of rules) {
        if (rule.tool !== input.toolName) continue;

        // Check commandRegex if specified (length-limited to mitigate ReDoS)
        if (rule.match.commandRegex !== undefined) {
            if (input.command === undefined) continue;
            if (rule.match.commandRegex.length > 500) continue;
            try {
                const re = new RegExp(rule.match.commandRegex);
                if (!re.test(input.command)) continue;
            } catch {
                // Invalid regex — skip this rule
                continue;
            }
        }

        // Check cwdPattern if specified (directory-boundary match on resolved path)
        if (rule.match.cwdPattern !== undefined) {
            if (input.cwd === undefined) continue;
            if (!matchesCwdPattern(input.cwd, rule.match.cwdPattern)) continue;
        }

        return rule;
    }
    return null;
}

function matchesCwdPattern(inputCwd: string, cwdPattern: string): boolean {
    const resolvedInput = resolve(inputCwd);
    const resolvedPattern = resolve(cwdPattern);
    const rel = relative(resolvedPattern, resolvedInput);
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}
