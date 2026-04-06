import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { checkZone, resolvePathSafely, isWithin, computeZones } from '../../src/tools/workspace-sandbox.js';
import type { ToolContext } from '../../src/tools/tool-registry.js';

// --- Test fixtures ---

let workspaceDir: string;
let outsideDir: string;
let trustedRoot: string;
const SESSION_ID = 'ses_01HTEST000000000000000000';

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        sessionId: SESSION_ID,
        workspaceRoot: workspaceDir,
        signal: AbortSignal.timeout(5000),
        ...overrides,
    };
}

beforeAll(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'aca-sandbox-ws-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'aca-sandbox-outside-'));
    trustedRoot = await mkdtemp(join(tmpdir(), 'aca-sandbox-trusted-'));

    // Create fixture files
    await mkdir(join(workspaceDir, 'src'));
    await writeFile(join(workspaceDir, 'src', 'index.ts'), 'export {};');
    await writeFile(join(workspaceDir, 'README.md'), '# Test');

    // Create file outside workspace
    await writeFile(join(outsideDir, 'secret.txt'), 'sensitive data');

    // Create file in trusted root
    await writeFile(join(trustedRoot, 'allowed.txt'), 'ok');

    // Create scoped tmp directory
    await mkdir(`/tmp/aca-${SESSION_ID}`, { recursive: true });
    await writeFile(`/tmp/aca-${SESSION_ID}/temp.txt`, 'temp data');

    // Create symlinks
    // Symlink within workspace pointing to workspace subdir → should be allowed
    await symlink(join(workspaceDir, 'src'), join(workspaceDir, 'link-to-src'));
    // Symlink within workspace pointing outside → should be denied
    await symlink(join(outsideDir, 'secret.txt'), join(workspaceDir, 'link-to-outside'));
});

afterAll(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
    await rm(trustedRoot, { recursive: true, force: true });
    await rm(`/tmp/aca-${SESSION_ID}`, { recursive: true, force: true });
});

// --- Helper unit tests ---

describe('isWithin', () => {
    it('exact match', () => {
        expect(isWithin('/a/b', '/a/b')).toBe(true);
    });

    it('child path', () => {
        expect(isWithin('/a/b/c', '/a/b')).toBe(true);
    });

    it('not a child (prefix collision)', () => {
        expect(isWithin('/a/bc', '/a/b')).toBe(false);
    });

    it('parent is not within child', () => {
        expect(isWithin('/a', '/a/b')).toBe(false);
    });

    it('unrelated paths', () => {
        expect(isWithin('/x/y', '/a/b')).toBe(false);
    });
});

describe('computeZones', () => {
    it('returns workspace, session dir, scoped tmp', () => {
        const ctx = makeContext();
        const zones = computeZones(ctx);
        expect(zones).toContain(workspaceDir);
        expect(zones).toContain(join(homedir(), '.aca', 'sessions', SESSION_ID));
        expect(zones).toContain(`/tmp/aca-${SESSION_ID}`);
    });

    it('includes extraTrustedRoots when provided', () => {
        const ctx = makeContext({ extraTrustedRoots: ['/opt/extra', '/data/shared'] });
        const zones = computeZones(ctx);
        expect(zones).toContain('/opt/extra');
        expect(zones).toContain('/data/shared');
    });

    it('filters empty strings from extraTrustedRoots', () => {
        const ctx = makeContext({ extraTrustedRoots: ['', '/opt/extra', ''] });
        const zones = computeZones(ctx);
        expect(zones).not.toContain('');
        expect(zones).toContain('/opt/extra');
    });

    it('rejects / as extraTrustedRoot (would allow entire filesystem)', () => {
        const ctx = makeContext({ extraTrustedRoots: ['/', '/opt/extra'] });
        const zones = computeZones(ctx);
        expect(zones).not.toContain('/');
        expect(zones).toContain('/opt/extra');
    });

    it('rejects relative paths in extraTrustedRoots', () => {
        const ctx = makeContext({ extraTrustedRoots: ['relative/path', '/opt/extra'] });
        const zones = computeZones(ctx);
        expect(zones).not.toContain('relative/path');
        expect(zones).toContain('/opt/extra');
    });

    it('rejects extraTrustedRoots containing null bytes', () => {
        const ctx = makeContext({ extraTrustedRoots: ['/opt/evil\0/path', '/opt/extra'] });
        const zones = computeZones(ctx);
        expect(zones).toHaveLength(4); // workspace + session + tmp + /opt/extra
        expect(zones).toContain('/opt/extra');
    });

    it('omits session zones when sessionId contains path separators', () => {
        const ctx = makeContext({ sessionId: '../../../etc' });
        const zones = computeZones(ctx);
        expect(zones).toHaveLength(1); // only workspace
        expect(zones).toContain(workspaceDir);
    });
});

describe('resolvePathSafely', () => {
    it('resolves existing path via realpath', async () => {
        const resolved = await resolvePathSafely(join(workspaceDir, 'src', 'index.ts'));
        expect(resolved).toContain('index.ts');
    });

    it('resolves non-existent path via nearest ancestor', async () => {
        const resolved = await resolvePathSafely(join(workspaceDir, 'src', 'nonexistent.ts'));
        expect(resolved).toContain('nonexistent.ts');
        expect(resolved).toContain('src');
    });

    it('collapses .. before resolution', async () => {
        const resolved = await resolvePathSafely(join(workspaceDir, 'src', '..', 'README.md'));
        // Should resolve to workspaceDir/README.md, not escape
        expect(resolved).toContain('README.md');
        expect(resolved).not.toContain('..');
    });
});

// --- Main checkZone tests ---

describe('checkZone', () => {
    describe('allowed zones', () => {
        it('path within workspace → allowed', async () => {
            const result = await checkZone(join(workspaceDir, 'src', 'index.ts'), makeContext());
            expect(result).toBeNull();
        });

        it('workspace root itself → allowed', async () => {
            const result = await checkZone(workspaceDir, makeContext());
            expect(result).toBeNull();
        });

        it('path in session dir → allowed', async () => {
            const sessionDir = join(homedir(), '.aca', 'sessions', SESSION_ID);
            // Session dir may not exist — checkZone handles non-existent paths
            const result = await checkZone(join(sessionDir, 'manifest.json'), makeContext());
            expect(result).toBeNull();
        });

        it('path in scoped tmp → allowed', async () => {
            const result = await checkZone(`/tmp/aca-${SESSION_ID}/temp.txt`, makeContext());
            expect(result).toBeNull();
        });

        it('path in extraTrustedRoots → allowed', async () => {
            const ctx = makeContext({ extraTrustedRoots: [trustedRoot] });
            const result = await checkZone(join(trustedRoot, 'allowed.txt'), ctx);
            expect(result).toBeNull();
        });

        it('new file in workspace (non-existent) → allowed', async () => {
            const result = await checkZone(join(workspaceDir, 'new-file.txt'), makeContext());
            expect(result).toBeNull();
        });

        it('new nested path in workspace (non-existent) → allowed', async () => {
            const result = await checkZone(join(workspaceDir, 'deep', 'nested', 'file.ts'), makeContext());
            expect(result).toBeNull();
        });
    });

    describe('denied paths', () => {
        it('/etc/passwd → denied with tool.sandbox', async () => {
            const result = await checkZone('/etc/passwd', makeContext());
            expect(result).not.toBeNull();
            expect(result!.status).toBe('error');
            expect(result!.error!.code).toBe('tool.sandbox');
            expect(result!.error!.message).toContain('/etc/passwd');
        });

        it('~/.ssh/id_rsa → denied', async () => {
            const sshKey = join(homedir(), '.ssh', 'id_rsa');
            const result = await checkZone(sshKey, makeContext());
            expect(result).not.toBeNull();
            expect(result!.error!.code).toBe('tool.sandbox');
        });

        it('/tmp/random-dir (not scoped) → denied', async () => {
            const result = await checkZone('/tmp/random-dir/file.txt', makeContext());
            expect(result).not.toBeNull();
            expect(result!.error!.code).toBe('tool.sandbox');
        });

        it('different session dir → denied', async () => {
            const otherSession = join(homedir(), '.aca', 'sessions', 'ses_OTHER00000000000000000');
            const result = await checkZone(join(otherSession, 'manifest.json'), makeContext());
            expect(result).not.toBeNull();
            expect(result!.error!.code).toBe('tool.sandbox');
        });

        it('/tmp/aca-<wrong_session>/file → denied', async () => {
            const result = await checkZone('/tmp/aca-ses_WRONG/file.txt', makeContext());
            expect(result).not.toBeNull();
            expect(result!.error!.code).toBe('tool.sandbox');
        });
    });

    describe('path traversal', () => {
        it('../../etc/passwd from workspace → denied', async () => {
            const result = await checkZone(join(workspaceDir, '..', '..', 'etc', 'passwd'), makeContext());
            expect(result).not.toBeNull();
            expect(result!.error!.code).toBe('tool.sandbox');
        });

        it('../ from workspace root → denied', async () => {
            const result = await checkZone(join(workspaceDir, '..', 'other'), makeContext());
            expect(result).not.toBeNull();
            expect(result!.error!.code).toBe('tool.sandbox');
        });

        it('traversal that stays within workspace → allowed', async () => {
            // workspace/src/../README.md = workspace/README.md → still in workspace
            const result = await checkZone(join(workspaceDir, 'src', '..', 'README.md'), makeContext());
            expect(result).toBeNull();
        });
    });

    describe('symlink handling', () => {
        it('symlink within workspace pointing to workspace subdirectory → allowed', async () => {
            const result = await checkZone(join(workspaceDir, 'link-to-src', 'index.ts'), makeContext());
            expect(result).toBeNull();
        });

        it('symlink within workspace pointing outside → denied, message shows resolved target', async () => {
            const result = await checkZone(join(workspaceDir, 'link-to-outside'), makeContext());
            expect(result).not.toBeNull();
            expect(result!.error!.code).toBe('tool.sandbox');
            // Error message should show the resolved path (outside dir)
            expect(result!.error!.message).toContain('resolves to');
        });
    });

    describe('relative paths', () => {
        it('relative path resolved against workspaceRoot', async () => {
            // The test CWD might not be the workspace, but checkZone resolves
            // relative paths against context.workspaceRoot
            const ctx = makeContext();
            // A relative path should be resolved against workspaceRoot
            const result = await checkZone('src/index.ts', ctx);
            // Should succeed because workspaceDir/src/index.ts is in the workspace
            expect(result).toBeNull();
        });
    });

    describe('TOCTOU (symlink resolution at check time)', () => {
        it('resolves symlinks at check time to canonical path', async () => {
            // The link-to-outside symlink resolves to outsideDir/secret.txt via realpath
            // Even though the symlink itself is inside the workspace, the resolved target is not
            const result = await checkZone(join(workspaceDir, 'link-to-outside'), makeContext());
            expect(result).not.toBeNull();
            expect(result!.error!.code).toBe('tool.sandbox');
        });

        it('link-to-src resolves to workspace dir via realpath → allowed', async () => {
            // link-to-src → workspaceDir/src (still in workspace after resolution)
            const result = await checkZone(join(workspaceDir, 'link-to-src'), makeContext());
            expect(result).toBeNull();
        });
    });

    describe('mount point traversal', () => {
        it('path within workspace on different mount → still allowed (uses resolved path)', async () => {
            // On standard Linux, /tmp is usually the same filesystem. The key is that
            // zone check uses resolved paths, not device checks. A file at
            // workspaceDir/file.txt is allowed regardless of which mount it's on.
            const result = await checkZone(join(workspaceDir, 'README.md'), makeContext());
            expect(result).toBeNull();
        });
    });

    describe('null byte injection', () => {
        it('path with null byte → denied immediately', async () => {
            const result = await checkZone('/workspace/file\0/../../../etc/passwd', makeContext());
            expect(result).not.toBeNull();
            expect(result!.error!.code).toBe('tool.sandbox');
        });

        it('null byte in middle of path → denied', async () => {
            const result = await checkZone(join(workspaceDir, 'safe\0evil'), makeContext());
            expect(result).not.toBeNull();
            expect(result!.error!.code).toBe('tool.sandbox');
        });

        it('null byte at start of path → denied', async () => {
            const result = await checkZone('\0/etc/passwd', makeContext());
            expect(result).not.toBeNull();
            expect(result!.error!.code).toBe('tool.sandbox');
        });
    });

    describe('edge cases', () => {
        it('empty extraTrustedRoots → no extra zones', async () => {
            const ctx = makeContext({ extraTrustedRoots: [] });
            const result = await checkZone('/opt/somewhere/file', ctx);
            expect(result).not.toBeNull();
        });

        it('scoped tmp with correct session → allowed', async () => {
            const result = await checkZone(`/tmp/aca-${SESSION_ID}/new-file.txt`, makeContext());
            expect(result).toBeNull();
        });

        it('bare /tmp → denied', async () => {
            const result = await checkZone('/tmp/some-random-file', makeContext());
            expect(result).not.toBeNull();
            expect(result!.error!.code).toBe('tool.sandbox');
        });
    });
});
