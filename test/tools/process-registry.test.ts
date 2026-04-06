import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { ProcessRegistry, isPidRunning, killProcessTree } from '../../src/tools/process-registry.js';
import type { ProcessRecord } from '../../src/tools/process-registry.js';

// Helper to build a minimal ProcessRecord for registry tests.
function makeRecord(
    handle: string,
    sessionId: string,
    pid: number,
    process: ReturnType<typeof spawn>,
): ProcessRecord {
    return {
        handle,
        sessionId,
        pid,
        process,
        startTime: Date.now(),
        lastActivity: Date.now(),
        exited: false,
        exitCode: null,
        exitSignal: null,
        outputBuffer: [],
        outputBufferBytes: 0,
        dataListeners: [],
        closeListeners: [],
    };
}

describe('ProcessRegistry', () => {
    let registry: ProcessRegistry;
    const SESSION = 'ses_reg_test';

    beforeEach(() => {
        registry = new ProcessRegistry();
    });

    describe('register and lookup', () => {
        it('registers a process and retrieves it by handle', () => {
            const child = spawn('sleep', ['60'], { detached: true });
            const record = makeRecord('psh_1', SESSION, child.pid!, child);
            registry.register(SESSION, record);

            const found = registry.lookup(SESSION, 'psh_1');
            expect(found).toBeDefined();
            expect(found!.pid).toBe(child.pid);

            // Cleanup
            killProcessTree(child.pid!);
            child.unref();
        });

        it('returns undefined for unknown handle', () => {
            expect(registry.lookup(SESSION, 'psh_unknown')).toBeUndefined();
        });

        it('returns undefined for unknown session', () => {
            expect(registry.lookup('ses_nobody', 'psh_1')).toBeUndefined();
        });
    });

    describe('listSession', () => {
        it('lists all processes for a session', () => {
            const c1 = spawn('sleep', ['60'], { detached: true });
            const c2 = spawn('sleep', ['60'], { detached: true });
            registry.register(SESSION, makeRecord('psh_a', SESSION, c1.pid!, c1));
            registry.register(SESSION, makeRecord('psh_b', SESSION, c2.pid!, c2));

            const list = registry.listSession(SESSION);
            expect(list).toHaveLength(2);
            const handles = list.map(r => r.handle);
            expect(handles).toContain('psh_a');
            expect(handles).toContain('psh_b');

            killProcessTree(c1.pid!);
            killProcessTree(c2.pid!);
            c1.unref();
            c2.unref();
        });

        it('returns empty array for empty session', () => {
            expect(registry.listSession('ses_empty')).toHaveLength(0);
        });
    });

    describe('remove', () => {
        it('removes a registered process', () => {
            const child = spawn('sleep', ['60'], { detached: true });
            registry.register(SESSION, makeRecord('psh_rm', SESSION, child.pid!, child));
            expect(registry.remove(SESSION, 'psh_rm')).toBe(true);
            expect(registry.lookup(SESSION, 'psh_rm')).toBeUndefined();

            killProcessTree(child.pid!);
            child.unref();
        });

        it('returns false when handle does not exist', () => {
            expect(registry.remove(SESSION, 'psh_ghost')).toBe(false);
        });
    });

    describe('reap — orphan detection', () => {
        it('removes a process whose PID no longer exists', async () => {
            // Start a process, wait for it to exit naturally, then check reap.
            const child = spawn('/bin/sh', ['-c', 'exit 0'], { detached: true });
            child.unref();
            const pid = child.pid!;
            const record = makeRecord('psh_orphan', SESSION, pid, child);
            registry.register(SESSION, record);

            // Wait for the process to exit.
            await new Promise<void>(resolve => child.on('close', resolve));

            const reaped = registry.reap(SESSION);
            expect(reaped).toContain('psh_orphan');
            expect(registry.lookup(SESSION, 'psh_orphan')).toBeUndefined();
        });
    });

    describe('reap — already-exited record', () => {
        it('removes a record that is already marked as exited', () => {
            const child = spawn('sleep', ['60'], { detached: true });
            const record = makeRecord('psh_exited', SESSION, child.pid!, child);
            record.exited = true;
            registry.register(SESSION, record);

            const reaped = registry.reap(SESSION);
            expect(reaped).toContain('psh_exited');
            expect(registry.lookup(SESSION, 'psh_exited')).toBeUndefined();

            killProcessTree(child.pid!);
            child.unref();
        });
    });

    describe('reap — idle TTL', () => {
        it('reaps a process whose lastActivity exceeds the idle TTL', async () => {
            // Use a very short TTL for the test registry.
            const shortRegistry = new ProcessRegistry(50 /* 50ms TTL */, 60_000);
            const child = spawn('sleep', ['60'], { detached: true });
            const record = makeRecord('psh_idle', SESSION, child.pid!, child);
            shortRegistry.register(SESSION, record);

            // Wait longer than the TTL.
            await new Promise(resolve => setTimeout(resolve, 100));

            const reaped = shortRegistry.reap(SESSION);
            expect(reaped).toContain('psh_idle');
            expect(shortRegistry.lookup(SESSION, 'psh_idle')).toBeUndefined();

            // Process already killed by reap; unref to avoid zombie.
            child.unref();
        });
    });
});

describe('isPidRunning', () => {
    it('returns true for a running process', () => {
        const child = spawn('sleep', ['60'], { detached: true });
        child.unref();
        expect(isPidRunning(child.pid!)).toBe(true);
        killProcessTree(child.pid!);
    });

    it('returns false for a non-existent PID', () => {
        // PID 0 is the process group, kill(0, 0) always succeeds — use a
        // very large PID that almost certainly doesn't exist.
        // We cannot guarantee this, but in practice PID 9999999 is unused.
        // If this is flaky, skip instead of breaking CI.
        const fakePid = 9_999_999;
        expect(isPidRunning(fakePid)).toBe(false);
    });
});

describe('killProcessTree', () => {
    it('kills the process group of a spawned process', async () => {
        const child = spawn('sleep', ['60'], { detached: true });
        child.unref();
        const pid = child.pid!;

        expect(isPidRunning(pid)).toBe(true);
        killProcessTree(pid, 'SIGKILL');

        // Give OS a moment to clean up.
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(isPidRunning(pid)).toBe(false);
    });

    it('does not throw when the PID is already gone', () => {
        expect(() => killProcessTree(9_999_999, 'SIGTERM')).not.toThrow();
    });
});
