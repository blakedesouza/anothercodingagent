import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

// --- Types ---

export type IndexStatus = 'none' | 'building' | 'ready' | 'updating' | 'stale';
export type GitStatus = 'clean' | 'dirty';

export interface GitState {
    branch: string;
    status: GitStatus;
    staged: boolean;
}

export interface ProjectSnapshot {
    root: string;
    stack: string[];
    git: GitState | null;
    ignorePaths: string[];
    indexStatus: IndexStatus;
}

// --- Root marker files (ordered: .git first, then language-specific) ---

const LANGUAGE_ROOT_MARKERS = [
    'package.json',
    'Cargo.toml',
    'pyproject.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
] as const;

// --- Hardcoded ignore directories ---

const HARDCODED_IGNORES = [
    '.git/',
    'node_modules/',
    'dist/',
    'build/',
    'coverage/',
] as const;

// --- Stack detection: marker file → stack entry ---

const STACK_MARKERS: ReadonlyArray<{ file: string; stack: string }> = [
    // Package managers (check lockfiles first — more specific than root markers)
    { file: 'pnpm-lock.yaml', stack: 'pnpm' },
    { file: 'yarn.lock', stack: 'yarn' },
    { file: 'package-lock.json', stack: 'npm' },
    { file: 'bun.lockb', stack: 'bun' },
    // Language ecosystems (from root markers)
    { file: 'package.json', stack: 'Node' },
    { file: 'Cargo.toml', stack: 'Rust' },
    { file: 'Cargo.lock', stack: 'cargo' },
    { file: 'pyproject.toml', stack: 'Python' },
    { file: 'go.mod', stack: 'Go' },
    { file: 'pom.xml', stack: 'Java/Maven' },
    { file: 'build.gradle', stack: 'Java/Gradle' },
    // TypeScript/config detection
    { file: 'tsconfig.json', stack: 'TypeScript' },
    // Test frameworks
    { file: 'vitest.config.ts', stack: 'vitest' },
    { file: 'vitest.config.js', stack: 'vitest' },
    { file: 'jest.config.ts', stack: 'jest' },
    { file: 'jest.config.js', stack: 'jest' },
    // Linters
    { file: '.eslintrc.json', stack: 'eslint' },
    { file: '.eslintrc.js', stack: 'eslint' },
    { file: '.eslintrc.cjs', stack: 'eslint' },
    { file: 'eslint.config.js', stack: 'eslint' },
    { file: 'eslint.config.mjs', stack: 'eslint' },
];

// --- Root detection ---

/**
 * Walk up from `startDir` looking for project root markers.
 * Returns the first directory containing `.git/` (strongest).
 * Falls back to first directory containing a language root file.
 * Returns null if nothing found (filesystem root reached).
 */
export function detectRoot(startDir: string): string | null {
    let dir = resolve(startDir);
    let fallback: string | null = null;

    while (true) {
        // .git/ is the strongest marker — return immediately
        if (isDirectory(join(dir, '.git'))) {
            return dir;
        }

        // Track first language-specific root file as fallback
        if (fallback === null) {
            for (const marker of LANGUAGE_ROOT_MARKERS) {
                if (existsSync(join(dir, marker))) {
                    fallback = dir;
                    break;
                }
            }
        }

        const parent = dirname(dir);
        if (parent === dir) break; // filesystem root
        dir = parent;
    }

    return fallback;
}

// --- Stack detection ---

/**
 * Detect language/toolchain stack from files present in the project root.
 * Returns deduplicated array of stack identifiers (e.g. ['Node', 'TypeScript', 'pnpm', 'vitest', 'eslint']).
 */
export function detectStack(root: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const { file, stack } of STACK_MARKERS) {
        if (!seen.has(stack) && existsSync(join(root, file))) {
            seen.add(stack);
            result.push(stack);
        }
    }

    return result;
}

// --- Git state ---

/**
 * Get current git state: branch, dirty/clean, staged changes.
 * Returns null if not inside a git repo or git is not available.
 */
export function detectGitState(root: string): GitState | null {
    try {
        // Check if inside a git work tree
        const insideWorkTree = gitExec(root, ['rev-parse', '--is-inside-work-tree']);
        if (insideWorkTree.trim() !== 'true') return null;

        // Current branch
        let branch: string;
        try {
            branch = gitExec(root, ['symbolic-ref', '--short', 'HEAD']).trim();
        } catch {
            try {
                // Detached HEAD — use short SHA
                branch = gitExec(root, ['rev-parse', '--short', 'HEAD']).trim();
            } catch {
                // Empty repo (initialized, no commits)
                branch = '(unborn)';
            }
        }

        // Dirty/clean: `git status --porcelain` outputs nothing if clean
        const porcelain = gitExec(root, ['status', '--porcelain']);
        const status: GitStatus = porcelain.trim().length > 0 ? 'dirty' : 'clean';

        // Staged changes: `git diff --cached --quiet` exits non-zero if staged changes exist
        let staged: boolean;
        try {
            gitExec(root, ['diff', '--cached', '--quiet']);
            staged = false;
        } catch {
            staged = true;
        }

        return { branch, status, staged };
    } catch {
        return null;
    }
}

// --- Ignore rules ---

/**
 * Build the list of ignore paths: hardcoded + .gitignore patterns + config overrides.
 * For now, returns hardcoded ignores + any config-provided extra paths.
 * .gitignore parsing is handled by individual tools (find_paths, search_text).
 */
export function buildIgnorePaths(configIgnorePaths: string[] = []): string[] {
    const paths: string[] = [...HARDCODED_IGNORES];
    for (const p of configIgnorePaths) {
        if (!paths.includes(p)) {
            paths.push(p);
        }
    }
    return paths;
}

// --- Snapshot ---

/**
 * Build a complete ProjectSnapshot for the given working directory.
 */
export function buildProjectSnapshot(
    cwd: string,
    configIgnorePaths: string[] = [],
): ProjectSnapshot {
    const root = detectRoot(cwd) ?? cwd;
    const stack = detectStack(root);
    const git = detectGitState(root);
    const ignorePaths = buildIgnorePaths(configIgnorePaths);
    const indexStatus: IndexStatus = 'none';

    return { root, stack, git, ignorePaths, indexStatus };
}

// --- Context rendering ---

/**
 * Render a ProjectSnapshot as a compact text block for LLM context injection.
 * Target: ~5-8 lines, < 200 tokens.
 */
export function renderProjectContext(snapshot: ProjectSnapshot): string {
    const lines: string[] = [];

    lines.push(`Project root: ${snapshot.root}`);

    if (snapshot.stack.length > 0) {
        lines.push(`Stack: ${snapshot.stack.join(', ')}`);
    }

    if (snapshot.git) {
        const parts = [`branch=${snapshot.git.branch}`, snapshot.git.status];
        parts.push(`staged=${snapshot.git.staged}`);
        lines.push(`Git: ${parts.join(', ')}`);
    } else {
        lines.push('Git: not a git repository');
    }

    lines.push(`Ignore: ${snapshot.ignorePaths.join(', ')}`);

    if (snapshot.indexStatus !== 'none') {
        lines.push(`Index: ${snapshot.indexStatus}`);
    }

    return lines.join('\n');
}

// --- Helpers ---

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function gitExec(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}
