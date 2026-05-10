import { platform } from 'node:os';

export function detectRuntimeShell(env: NodeJS.ProcessEnv = process.env): string {
    if (env.SHELL) return env.SHELL;
    if (platform() === 'win32') return env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
    return 'unknown';
}
