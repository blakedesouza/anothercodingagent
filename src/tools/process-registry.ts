import type { ChildProcess } from 'node:child_process';

const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_HARD_MAX_MS = 4 * 60 * 60 * 1000; // 4 hours

// --- Types ---

export interface ProcessRecord {
    /** Unique handle for this session (returned to the LLM as session_id). */
    handle: string;
    /** ACA session ID that owns this process. */
    sessionId: string;
    /** OS process ID (PGID = pid when spawned with detached: true). */
    pid: number;
    /** The underlying ChildProcess object for direct event/stdin access. */
    process: ChildProcess;
    /** Unix timestamp (ms) when the process was started. */
    startTime: number;
    /** Unix timestamp (ms) of the last stdin write or stdout/stderr read. */
    lastActivity: number;
    /** True once the process has exited. */
    exited: boolean;
    /** Exit code (null if killed by signal or not yet exited). */
    exitCode: number | null;
    /** Exit signal name (null if exited cleanly or not yet exited). */
    exitSignal: string | null;
    /**
     * Buffered output chunks (merged stdout+stderr) not yet consumed by session_io.
     * Each element is a UTF-8 decoded string chunk.
     */
    outputBuffer: string[];
    /** Running byte total of all strings currently in outputBuffer. Reset to 0 when session_io drains. */
    outputBufferBytes: number;
    /** Callbacks notified when new output is appended to outputBuffer. */
    dataListeners: Array<() => void>;
    /** Callbacks notified when the process exits. */
    closeListeners: Array<(code: number | null, signal: string | null) => void>;
}

type SessionProcessMap = Map<string, ProcessRecord>;

export interface TerminatedProcessRecord {
    handle: string;
    sessionId: string;
    reason: string;
    exitCode: number | null;
    exitSignal: string | null;
}

type SessionTerminatedMap = Map<string, TerminatedProcessRecord>;

// --- Registry class ---

export class ProcessRegistry {
    private readonly sessions = new Map<string, SessionProcessMap>();
    private readonly terminated = new Map<string, SessionTerminatedMap>();

    constructor(
        private readonly idleTtlMs: number = DEFAULT_IDLE_TTL_MS,
        private readonly hardMaxMs: number = DEFAULT_HARD_MAX_MS,
    ) {}

    /** Get or create the process map for a session. */
    private getSessionMap(sessionId: string): SessionProcessMap {
        let map = this.sessions.get(sessionId);
        if (!map) {
            map = new Map();
            this.sessions.set(sessionId, map);
        }
        return map;
    }

    private getTerminatedMap(sessionId: string): SessionTerminatedMap {
        let map = this.terminated.get(sessionId);
        if (!map) {
            map = new Map();
            this.terminated.set(sessionId, map);
        }
        return map;
    }

    /** Register a process record. The handle must be unique within the session. */
    register(sessionId: string, record: ProcessRecord): void {
        this.getSessionMap(sessionId).set(record.handle, record);
        this.getTerminatedMap(sessionId).delete(record.handle);
    }

    /** Look up a process by session and handle. Returns undefined if not found. */
    lookup(sessionId: string, handle: string): ProcessRecord | undefined {
        return this.getSessionMap(sessionId).get(handle);
    }

    /** Look up a terminated/tombstoned process handle by session. */
    lookupTerminated(sessionId: string, handle: string): TerminatedProcessRecord | undefined {
        return this.getTerminatedMap(sessionId).get(handle);
    }

    /** List all process records for a session. */
    listSession(sessionId: string): ProcessRecord[] {
        return Array.from(this.getSessionMap(sessionId).values());
    }

    /** Remove a process record. Returns true if it was present. */
    remove(sessionId: string, handle: string): boolean {
        return this.getSessionMap(sessionId).delete(handle);
    }

    /** Mark a historical handle as terminated/unavailable in this ACA process. */
    markTerminated(
        sessionId: string,
        handle: string,
        reason: string,
        exitCode: number | null = null,
        exitSignal: string | null = null,
    ): void {
        this.getSessionMap(sessionId).delete(handle);
        this.getTerminatedMap(sessionId).set(handle, {
            handle,
            sessionId,
            reason,
            exitCode,
            exitSignal,
        });
    }

    /**
     * Scan the session's process list and remove orphans or processes that exceed
     * their TTL / hard max age. Returns handles that were reaped.
     */
    reap(sessionId: string): string[] {
        const reaped: string[] = [];
        const now = Date.now();
        const map = this.getSessionMap(sessionId);

        for (const [handle, record] of map.entries()) {
            // Already exited — clean up.
            if (record.exited) {
                map.delete(handle);
                reaped.push(handle);
                continue;
            }

            // Orphan check: PID no longer exists.
            if (!isPidRunning(record.pid)) {
                record.exited = true;
                map.delete(handle);
                reaped.push(handle);
                continue;
            }

            // Idle TTL exceeded.
            if (now - record.lastActivity > this.idleTtlMs) {
                killProcessTree(record.pid);
                record.exited = true;
                this.markTerminated(
                    sessionId,
                    handle,
                    'Session expired after idle timeout',
                    record.exitCode,
                    record.exitSignal,
                );
                map.delete(handle);
                reaped.push(handle);
                continue;
            }

            // Hard max age exceeded.
            if (now - record.startTime > this.hardMaxMs) {
                killProcessTree(record.pid);
                record.exited = true;
                this.markTerminated(
                    sessionId,
                    handle,
                    'Session expired after maximum lifetime',
                    record.exitCode,
                    record.exitSignal,
                );
                map.delete(handle);
                reaped.push(handle);
                continue;
            }
        }

        return reaped;
    }
}

// --- Helpers ---

/**
 * Check whether a process ID is still running.
 * Uses kill(pid, 0) which sends no signal but checks existence.
 */
export function isPidRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Kill all processes in the process group identified by `pid`.
 * Requires the target process to have been spawned with detached: true so
 * its PGID equals its PID (making it the group leader).
 * Falls back to a direct kill if the group kill fails.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
    try {
        process.kill(-pid, signal);
    } catch {
        // Group kill failed (e.g., process already gone) — try direct kill.
        try {
            process.kill(pid, signal);
        } catch {
            // Process already gone — nothing to do.
        }
    }
}

// --- Module-level singleton used by the shell session tools ---

export const processRegistry = new ProcessRegistry();
