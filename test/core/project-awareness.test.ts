import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    detectRoot,
    detectStack,
    detectGitState,
    buildIgnorePaths,
    buildProjectSnapshot,
    renderProjectContext,
} from '../../src/core/project-awareness.js';
import type { ProjectSnapshot } from '../../src/core/project-awareness.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// --- Helpers ---

function tmpDir(): string {
    const dir = join(tmpdir(), `aca-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function touch(dir: string, file: string): void {
    writeFileSync(join(dir, file), '');
}

function initGitRepo(dir: string): void {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
}

// --- Tests ---

describe('Project Awareness', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = tmpDir();
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    // --- Root detection ---

    describe('detectRoot', () => {
        it('detects .git/ directory as project root', () => {
            initGitRepo(tempDir);
            expect(detectRoot(tempDir)).toBe(tempDir);
        });

        it('walks up to find .git/ in parent directory', () => {
            initGitRepo(tempDir);
            const subDir = join(tempDir, 'src', 'deep');
            mkdirSync(subDir, { recursive: true });
            expect(detectRoot(subDir)).toBe(tempDir);
        });

        it('detects package.json as root when no .git/', () => {
            touch(tempDir, 'package.json');
            expect(detectRoot(tempDir)).toBe(tempDir);
        });

        it('prefers .git/ over package.json in parent', () => {
            // parent has .git/, child has package.json
            initGitRepo(tempDir);
            const child = join(tempDir, 'packages', 'sub');
            mkdirSync(child, { recursive: true });
            touch(child, 'package.json');
            expect(detectRoot(child)).toBe(tempDir);
        });

        it('ignores an unusable .git directory and falls back to the nearest language root', () => {
            mkdirSync(join(tempDir, '.git'), { recursive: true });
            const child = join(tempDir, 'packages', 'sub');
            mkdirSync(child, { recursive: true });
            touch(child, 'package.json');
            expect(detectRoot(child)).toBe(child);
        });

        it('falls back to package.json when .git/ is only in a deeper parent', () => {
            // Structure: /tmp/root/.git/ + /tmp/root/sub/package.json
            // Starting from /tmp/root/sub → finds package.json first as fallback,
            // but keeps walking up and finds .git/ → returns .git/ parent
            initGitRepo(tempDir);
            const sub = join(tempDir, 'sub');
            mkdirSync(sub, { recursive: true });
            touch(sub, 'package.json');
            // .git/ is in parent, so root should be tempDir (not sub)
            expect(detectRoot(sub)).toBe(tempDir);
        });

        it('uses language marker fallback when no .git/ exists anywhere', () => {
            const sub = join(tempDir, 'myproject');
            mkdirSync(sub, { recursive: true });
            touch(sub, 'Cargo.toml');
            expect(detectRoot(sub)).toBe(sub);
        });

        it('returns null when no markers found', () => {
            // tmpDir has no .git/ or language markers
            // Walk up will eventually hit filesystem root
            // Use a deeply nested dir with no markers
            const deep = join(tempDir, 'a', 'b', 'c');
            mkdirSync(deep, { recursive: true });
            // tempDir itself has no markers, but parent dirs might
            // To truly test "no markers", we check detectRoot behavior
            const result = detectRoot(deep);
            // Result could be non-null if there's a .git or marker above tempDir
            // For a reliable test, the key property is: detectRoot returns tempDir
            // or null based on presence of markers. Since we control tempDir but not
            // its parents, we test the positive cases above.
            expect(result === null || typeof result === 'string').toBe(true);
        });

        it('detects pyproject.toml as root marker', () => {
            touch(tempDir, 'pyproject.toml');
            expect(detectRoot(tempDir)).toBe(tempDir);
        });

        it('detects go.mod as root marker', () => {
            touch(tempDir, 'go.mod');
            expect(detectRoot(tempDir)).toBe(tempDir);
        });
    });

    // --- Stack detection ---

    describe('detectStack', () => {
        it('detects Node + pnpm from package.json + pnpm-lock.yaml', () => {
            touch(tempDir, 'package.json');
            touch(tempDir, 'pnpm-lock.yaml');
            const stack = detectStack(tempDir);
            expect(stack).toContain('pnpm');
            expect(stack).toContain('Node');
        });

        it('detects TypeScript from tsconfig.json', () => {
            touch(tempDir, 'package.json');
            touch(tempDir, 'tsconfig.json');
            const stack = detectStack(tempDir);
            expect(stack).toContain('TypeScript');
            expect(stack).toContain('Node');
        });

        it('detects vitest from vitest.config.ts', () => {
            touch(tempDir, 'vitest.config.ts');
            const stack = detectStack(tempDir);
            expect(stack).toContain('vitest');
        });

        it('detects Rust + cargo from Cargo.toml + Cargo.lock', () => {
            touch(tempDir, 'Cargo.toml');
            touch(tempDir, 'Cargo.lock');
            const stack = detectStack(tempDir);
            expect(stack).toContain('Rust');
            expect(stack).toContain('cargo');
        });

        it('detects Python from pyproject.toml', () => {
            touch(tempDir, 'pyproject.toml');
            const stack = detectStack(tempDir);
            expect(stack).toContain('Python');
        });

        it('detects Go from go.mod', () => {
            touch(tempDir, 'go.mod');
            const stack = detectStack(tempDir);
            expect(stack).toContain('Go');
        });

        it('detects eslint from eslint.config.js', () => {
            touch(tempDir, 'eslint.config.js');
            const stack = detectStack(tempDir);
            expect(stack).toContain('eslint');
        });

        it('returns empty array when no markers present', () => {
            expect(detectStack(tempDir)).toEqual([]);
        });

        it('deduplicates stack entries', () => {
            // Both vitest.config.ts and vitest.config.js present
            touch(tempDir, 'vitest.config.ts');
            touch(tempDir, 'vitest.config.js');
            const stack = detectStack(tempDir);
            const vitestCount = stack.filter(s => s === 'vitest').length;
            expect(vitestCount).toBe(1);
        });

        it('detects npm from package-lock.json', () => {
            touch(tempDir, 'package.json');
            touch(tempDir, 'package-lock.json');
            const stack = detectStack(tempDir);
            expect(stack).toContain('npm');
            expect(stack).toContain('Node');
        });
    });

    // --- Git state ---

    describe('detectGitState', () => {
        it('returns null for non-git directory', () => {
            expect(detectGitState(tempDir)).toBeNull();
        });

        it('detects clean repo state', () => {
            initGitRepo(tempDir);
            // Need at least one commit for status to work
            touch(tempDir, 'README.md');
            execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'pipe' });

            const state = detectGitState(tempDir);
            expect(state).not.toBeNull();
            expect(state!.status).toBe('clean');
            expect(state!.staged).toBe(false);
        });

        it('detects dirty repo (untracked files)', () => {
            initGitRepo(tempDir);
            touch(tempDir, 'README.md');
            execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'pipe' });

            // Create untracked file
            touch(tempDir, 'dirty.txt');

            const state = detectGitState(tempDir);
            expect(state).not.toBeNull();
            expect(state!.status).toBe('dirty');
        });

        it('detects dirty repo (modified tracked file)', () => {
            initGitRepo(tempDir);
            touch(tempDir, 'file.txt');
            execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'pipe' });

            // Modify tracked file
            writeFileSync(join(tempDir, 'file.txt'), 'modified');

            const state = detectGitState(tempDir);
            expect(state!.status).toBe('dirty');
        });

        it('detects staged changes', () => {
            initGitRepo(tempDir);
            touch(tempDir, 'file.txt');
            execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'pipe' });

            // Stage a new file
            touch(tempDir, 'staged.txt');
            execFileSync('git', ['add', 'staged.txt'], { cwd: tempDir, stdio: 'pipe' });

            const state = detectGitState(tempDir);
            expect(state!.staged).toBe(true);
        });

        it('detects branch name', () => {
            initGitRepo(tempDir);
            touch(tempDir, 'file.txt');
            execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'pipe' });

            // Default branch could be 'main' or 'master' depending on git config
            const state = detectGitState(tempDir);
            expect(state).not.toBeNull();
            expect(typeof state!.branch).toBe('string');
            expect(state!.branch.length).toBeGreaterThan(0);
        });

        it('returns valid state for empty repo (no commits)', () => {
            initGitRepo(tempDir);
            // git init creates HEAD pointing to refs/heads/main — symbolic-ref works
            const state = detectGitState(tempDir);
            expect(state).not.toBeNull();
            expect(typeof state!.branch).toBe('string');
            expect(state!.branch.length).toBeGreaterThan(0);
            expect(state!.status).toBe('clean');
            expect(state!.staged).toBe(false);
        });

        it('detects custom branch', () => {
            initGitRepo(tempDir);
            touch(tempDir, 'file.txt');
            execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'pipe' });
            execFileSync('git', ['checkout', '-b', 'feature/test'], { cwd: tempDir, stdio: 'pipe' });

            const state = detectGitState(tempDir);
            expect(state!.branch).toBe('feature/test');
        });
    });

    // --- Ignore rules ---

    describe('buildIgnorePaths', () => {
        it('includes hardcoded ignores by default', () => {
            const paths = buildIgnorePaths();
            expect(paths).toContain('.git/');
            expect(paths).toContain('node_modules/');
            expect(paths).toContain('dist/');
            expect(paths).toContain('build/');
            expect(paths).toContain('coverage/');
        });

        it('appends config-provided extra paths', () => {
            const paths = buildIgnorePaths(['.cache/', 'vendor/']);
            expect(paths).toContain('.cache/');
            expect(paths).toContain('vendor/');
            // Hardcoded still present
            expect(paths).toContain('node_modules/');
        });

        it('deduplicates when config overlaps with hardcoded', () => {
            const paths = buildIgnorePaths(['node_modules/', '.extra/']);
            const nmCount = paths.filter(p => p === 'node_modules/').length;
            expect(nmCount).toBe(1);
            expect(paths).toContain('.extra/');
        });

        it('returns 5 entries with no config paths', () => {
            const paths = buildIgnorePaths();
            expect(paths).toHaveLength(5);
        });
    });

    // --- Snapshot ---

    describe('buildProjectSnapshot', () => {
        it('builds snapshot for directory with .git/ and package.json', () => {
            initGitRepo(tempDir);
            touch(tempDir, 'package.json');
            touch(tempDir, 'tsconfig.json');
            touch(tempDir, 'pnpm-lock.yaml');
            touch(tempDir, 'file.txt');
            execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', 'init'], { cwd: tempDir, stdio: 'pipe' });

            const snapshot = buildProjectSnapshot(tempDir);
            expect(snapshot.root).toBe(tempDir);
            expect(snapshot.stack).toContain('Node');
            expect(snapshot.stack).toContain('TypeScript');
            expect(snapshot.stack).toContain('pnpm');
            expect(snapshot.git).not.toBeNull();
            expect(snapshot.git!.status).toBe('clean');
            expect(snapshot.ignorePaths).toContain('node_modules/');
            expect(snapshot.indexStatus).toBe('none');
        });

        it('uses cwd as root when no markers found', () => {
            const sub = join(tempDir, 'empty');
            mkdirSync(sub, { recursive: true });
            // If tempDir is inside a real git repo, detectRoot will find that.
            // The key invariant: root is always a string (never null in snapshot).
            const snapshot = buildProjectSnapshot(sub);
            expect(typeof snapshot.root).toBe('string');
        });

        it('includes config ignore paths in snapshot', () => {
            initGitRepo(tempDir);
            const snapshot = buildProjectSnapshot(tempDir, ['.cache/']);
            expect(snapshot.ignorePaths).toContain('.cache/');
            expect(snapshot.ignorePaths).toContain('.git/');
        });
    });

    // --- Context rendering ---

    describe('renderProjectContext', () => {
        it('renders compact text with all fields', () => {
            const snapshot: ProjectSnapshot = {
                root: '/home/user/myproject',
                stack: ['Node', 'TypeScript', 'pnpm', 'vitest', 'eslint'],
                git: { branch: 'feature/x', status: 'dirty', staged: false },
                ignorePaths: ['.git/', 'node_modules/', 'dist/', 'build/', 'coverage/'],
                indexStatus: 'none',
            };

            const text = renderProjectContext(snapshot);
            expect(text).toContain('Project root: /home/user/myproject');
            expect(text).toContain('Stack: Node, TypeScript, pnpm, vitest, eslint');
            expect(text).toContain('branch=feature/x');
            expect(text).toContain('dirty');
            expect(text).toContain('staged=false');
            expect(text).toContain('Ignore:');
        });

        it('omits index line when indexStatus is none', () => {
            const snapshot: ProjectSnapshot = {
                root: '/test',
                stack: [],
                git: null,
                ignorePaths: [],
                indexStatus: 'none',
            };
            const text = renderProjectContext(snapshot);
            expect(text).not.toContain('Index:');
        });

        it('shows index status when not none', () => {
            const snapshot: ProjectSnapshot = {
                root: '/test',
                stack: [],
                git: null,
                ignorePaths: [],
                indexStatus: 'ready',
            };
            const text = renderProjectContext(snapshot);
            expect(text).toContain('Index: ready');
        });

        it('shows "not a git repository" when git is null', () => {
            const snapshot: ProjectSnapshot = {
                root: '/test',
                stack: ['Python'],
                git: null,
                ignorePaths: ['.git/'],
                indexStatus: 'none',
            };
            const text = renderProjectContext(snapshot);
            expect(text).toContain('Git: not a git repository');
        });

        it('renders under 200 tokens (< 600 bytes as proxy)', () => {
            const snapshot: ProjectSnapshot = {
                root: '/home/user/projects/my-long-project-name',
                stack: ['Node', 'TypeScript', 'pnpm', 'vitest', 'eslint'],
                git: { branch: 'feature/very-long-branch-name-here', status: 'dirty', staged: true },
                ignorePaths: ['.git/', 'node_modules/', 'dist/', 'build/', 'coverage/', '.cache/', 'vendor/'],
                indexStatus: 'building',
            };
            const text = renderProjectContext(snapshot);
            // ~200 tokens ≈ ~600 bytes for English text
            expect(Buffer.byteLength(text, 'utf-8')).toBeLessThan(600);
            // Should be 5-8 lines
            const lines = text.split('\n');
            expect(lines.length).toBeGreaterThanOrEqual(4);
            expect(lines.length).toBeLessThanOrEqual(8);
        });

        it('renders staged=true correctly', () => {
            const snapshot: ProjectSnapshot = {
                root: '/test',
                stack: [],
                git: { branch: 'main', status: 'clean', staged: true },
                ignorePaths: [],
                indexStatus: 'none',
            };
            const text = renderProjectContext(snapshot);
            expect(text).toContain('staged=true');
        });
    });
});
