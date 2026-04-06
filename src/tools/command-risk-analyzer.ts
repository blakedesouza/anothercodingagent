export type RiskTier = 'forbidden' | 'high' | 'normal';

export type RiskFacet =
    | 'filesystem_delete'
    | 'filesystem_recursive'
    | 'network_download'
    | 'pipe_to_shell'
    | 'privilege_escalation'
    | 'credential_touch'
    | 'global_config_write'
    | 'history_rewrite'
    | 'package_install';

export interface CommandRiskAssessment {
    tier: RiskTier;
    facets: RiskFacet[];
    reason: string;
}

// --- Pattern constants ---
// Named for reuse: M7.8 secrets scrubbing extends this pattern registry.

/** :(){ :|:& };: and variants */
const FORK_BOMB_RE = /:\s*\(\s*\)\s*\{/;

/** dd writing to a block device: dd ... of=/dev/... */
const DD_DISK_WRITE_RE = /\bdd\b.*\bof=\/dev\//;

/** mkfs destroys a filesystem */
const MKFS_RE = /\bmkfs\b/;

/** Shell redirect directly to a block device: > /dev/sda */
const DEV_BLOCK_WRITE_RE = />\s*\/dev\/[sh]d[a-z]/;

/** curl or wget piped directly to a shell interpreter */
const PIPE_TO_SHELL_RE = /\b(?:curl|wget)\b[^|]*\|[^|]*\b(?:ba)?sh\b/;

/** sudo privilege escalation */
const SUDO_RE = /\bsudo\b/;

/** git push --force or git push -f */
const GIT_FORCE_PUSH_RE = /\bgit\b.*\bpush\b.*(?:--force\b|-f\b)/;

/** git reset --hard */
const GIT_RESET_HARD_RE = /\bgit\b.*\breset\b.*--hard\b/;

/** chmod recursive with permissive mode (chmod -R 777 or chmod 777 -R) */
const CHMOD_R_777_RE =
    /\bchmod\b.*-[A-Za-z]*[Rr][A-Za-z]*.*\b7{3}\b|\bchmod\b.*\b7{3}\b.*-[A-Za-z]*[Rr]/;

/** Any command referencing ~/.ssh/ (credential directory) */
const SSH_DIR_WRITE_RE = /~\/\.ssh\//;

/** npm install (or i) with -g / --global flag */
const NPM_INSTALL_GLOBAL_RE = /\bnpm\b\s+(?:i\b|install\b).*(?:\s-g\b|\s--global\b)/;

/**
 * Unresolvable shell variable ($VAR or ${VAR}) appearing in command position
 * before recursive flags. Indicates unknown command with destructive-style args.
 */
const VAR_DESTRUCTIVE_FLAGS_RE =
    /(?:^|[;&|`]\s*)\$(?:[A-Za-z_]\w*|\{[^}]+\})\s+(?:-\S+\s+)*-[a-zA-Z]*[rR]/;

// --- Internal helpers ---

function tierOrdinal(t: RiskTier): number {
    return t === 'forbidden' ? 2 : t === 'high' ? 1 : 0;
}

/**
 * Return true when cwd is considered "inside" the workspace.
 * Used to decide whether a relative-path rm is safe.
 */
function isInWorkspace(cwd: string, workspaceRoot?: string): boolean {
    if (workspaceRoot) {
        return cwd === workspaceRoot || cwd.startsWith(workspaceRoot + '/');
    }
    // Heuristic: treat any non-root directory as workspace context when no
    // explicit root is provided.
    return cwd !== '/' && cwd.length > 1;
}

/**
 * Strip quotes used for shell obfuscation between word characters.
 * Example: r'm' → rm.  Does not remove quotes wrapping full argument strings.
 */
function stripObfuscationQuotes(command: string): string {
    let result = command
        .replace(/(\w)'(\w)/g, '$1$2')
        .replace(/(\w)"(\w)/g, '$1$2');
    // Remove lone quotes left over before whitespace or end-of-string.
    result = result.replace(/'(?=\s|$)/g, '').replace(/"(?=\s|$)/g, '');
    return result;
}

/**
 * Extract the argument to a shell -c flag: bash -c 'CMD' → CMD.
 * Returns null when no -c argument is present.
 */
function extractShellCArg(command: string): string | null {
    const m = command.match(
        /\b(?:ba|z|k|c)?sh\b\s+(?:-[^c\s]\S*\s+)*-c\s+(?:'([^']*)'|"([^"]*)"|(\S+))/,
    );
    if (!m) return null;
    return m[1] ?? m[2] ?? m[3] ?? null;
}

// --- rm command analysis ---

interface RmAnalysis {
    tier: RiskTier;
    facets: RiskFacet[];
    reason: string;
}

function analyzeRmCommand(
    normalized: string,
    cwd: string,
    workspaceRoot?: string,
): RmAnalysis | null {
    // Require rm at the start of the command or after a shell separator.
    if (!/(?:^|[;&|`]\s*)rm\b/.test(normalized)) {
        return null;
    }

    const hasRecursive =
        /\brm\b.*-[a-zA-Z]*[rR]/.test(normalized) ||
        /\brm\b.*--recursive\b/.test(normalized);

    if (!hasRecursive) {
        return {
            tier: 'normal',
            facets: ['filesystem_delete'],
            reason: 'non-recursive file deletion',
        };
    }

    // Extract everything after "rm" and its leading flags.
    const rmMatch = normalized.match(/(?:^|[;&|`]\s*)rm\b((?:\s+-\S+)*)((?:\s+\S+)*)/);
    if (!rmMatch) {
        return {
            tier: 'high',
            facets: ['filesystem_delete', 'filesystem_recursive'],
            reason: 'rm -r without discernible target',
        };
    }

    const rawTargets = rmMatch[2]
        .trim()
        .split(/\s+/)
        .filter(t => t.length > 0 && !t.startsWith('-'));

    if (rawTargets.length === 0) {
        return {
            tier: 'normal',
            facets: ['filesystem_delete', 'filesystem_recursive'],
            reason: 'rm -r with no target specified',
        };
    }

    const target = rawTargets[0];

    // Dangerous absolute paths: /, /*, ~, ~/…, $HOME
    if (
        target === '/' ||
        target === '/*' ||
        /^~/.test(target) ||
        target === '$HOME' ||
        /^\$HOME\//.test(target)
    ) {
        return {
            tier: 'forbidden',
            facets: ['filesystem_delete', 'filesystem_recursive'],
            reason: `rm -r targets dangerous path: ${target}`,
        };
    }

    // Relative path (doesn't start with /, ~, or $)
    if (!target.startsWith('/') && !target.startsWith('~') && !target.startsWith('$')) {
        const inWs = isInWorkspace(cwd, workspaceRoot);
        return {
            tier: inWs ? 'normal' : 'high',
            facets: ['filesystem_delete', 'filesystem_recursive'],
            reason: inWs
                ? 'rm -r targets workspace-relative path'
                : 'rm -r on relative path outside workspace context',
        };
    }

    // Absolute path but not the dangerous root/home targets
    return {
        tier: 'high',
        facets: ['filesystem_delete', 'filesystem_recursive'],
        reason: `rm -r on absolute path: ${target}`,
    };
}

// --- Main export ---

/**
 * Analyze a shell command string for risk.
 *
 * Pure function — no side effects, no I/O.
 *
 * @param command       - The command string to analyze.
 * @param cwd           - Working directory the command will run in.
 * @param env           - Environment overrides (reserved for future use).
 * @param workspaceRoot - Session workspace root used for context-aware checks.
 *                        When omitted, a non-root cwd heuristic is used instead.
 */
export function analyzeCommand(
    command: string,
    cwd: string,
    env?: Record<string, string>,
    workspaceRoot?: string,
): CommandRiskAssessment {
    // Suppress unused-variable warning until env is consumed in a future extension.
    void env;

    const facets = new Set<RiskFacet>();
    let tier: RiskTier = 'normal';
    let reason = 'command appears safe';

    function escalate(newTier: RiskTier, newReason: string, newFacets: RiskFacet[]): void {
        if (tierOrdinal(newTier) > tierOrdinal(tier)) {
            tier = newTier;
            reason = newReason;
        }
        for (const f of newFacets) facets.add(f);
    }

    // --- Shell -c subcommand: analyze the inner command recursively ---
    const shellArg = extractShellCArg(command);
    if (shellArg) {
        const inner = analyzeCommand(shellArg, cwd, env, workspaceRoot);
        escalate(inner.tier, `shell -c: ${inner.reason}`, inner.facets);
    }

    // --- Normalize: strip obfuscation quotes, collapse whitespace ---
    const normalized = stripObfuscationQuotes(command).replace(/\s+/g, ' ').trim();

    // --- Fork bomb ---
    if (FORK_BOMB_RE.test(normalized)) {
        return { tier: 'forbidden', facets: [], reason: 'fork bomb detected' };
    }

    // --- Forbidden: direct disk / filesystem destruction ---
    if (DD_DISK_WRITE_RE.test(normalized)) {
        return {
            tier: 'forbidden',
            facets: ['filesystem_delete'],
            reason: 'dd writing directly to a block device',
        };
    }

    if (MKFS_RE.test(normalized)) {
        return { tier: 'forbidden', facets: [], reason: 'mkfs destroys filesystem' };
    }

    if (DEV_BLOCK_WRITE_RE.test(normalized)) {
        return { tier: 'forbidden', facets: [], reason: 'direct write to block device' };
    }

    // --- Subshell evasion: $(cmd) in destructive command position ---
    // Replace all $(...) substitutions with a placeholder and check whether
    // the resulting string matches a destructive pattern.
    // Replace both $(...) and `...` command substitutions with a placeholder.
    const withSubshellsReplaced = normalized
        .replace(/\$\([^)]+\)/g, '__CMD__')
        .replace(/`[^`]+`/g, '__CMD__');
    if (
        /(?:^|[;&|`]\s*)__CMD__\s+(?:-\S+\s+)*-[a-zA-Z]*[rR]\S*\s+(?:\/|~|\$HOME)/.test(
            withSubshellsReplaced,
        )
    ) {
        return {
            tier: 'forbidden',
            facets: ['filesystem_delete', 'filesystem_recursive'],
            reason: 'command substitution with destructive payload',
        };
    }

    // --- Variable expansion in destructive position → minimum high ---
    // Unresolvable $VAR or ${VAR} before recursive flags cannot be safely classified.
    if (VAR_DESTRUCTIVE_FLAGS_RE.test(normalized)) {
        escalate('high', 'unresolvable variable in destructive command position', [
            'filesystem_delete',
        ]);
    }

    // --- rm analysis (context-aware) ---
    const rmResult = analyzeRmCommand(normalized, cwd, workspaceRoot);
    if (rmResult) {
        escalate(rmResult.tier, rmResult.reason, rmResult.facets);
    }

    // --- High-risk patterns ---

    if (PIPE_TO_SHELL_RE.test(normalized)) {
        escalate('high', 'network content piped to shell interpreter', [
            'pipe_to_shell',
            'network_download',
        ]);
    }

    if (SUDO_RE.test(normalized)) {
        escalate('high', 'privilege escalation via sudo', ['privilege_escalation']);
    }

    if (GIT_FORCE_PUSH_RE.test(normalized)) {
        escalate('high', 'git force push rewrites remote history', ['history_rewrite']);
    }

    if (GIT_RESET_HARD_RE.test(normalized)) {
        escalate('high', 'git reset --hard discards committed history', ['history_rewrite']);
    }

    if (CHMOD_R_777_RE.test(normalized)) {
        escalate('high', 'chmod -R 777 grants excessive permissions', ['global_config_write']);
    }

    if (SSH_DIR_WRITE_RE.test(normalized)) {
        escalate('high', 'writing to SSH credentials directory', ['credential_touch']);
    }

    if (NPM_INSTALL_GLOBAL_RE.test(normalized)) {
        escalate('high', 'global npm package installation', ['package_install']);
    }

    return { tier, facets: [...facets], reason };
}
