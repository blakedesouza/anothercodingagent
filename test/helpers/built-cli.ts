import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BUILD_INPUT_DIRS = ['src'];
const BUILD_INPUT_FILES = ['package.json', 'tsup.config.ts', 'tsconfig.json'];

function latestMtimeMs(path: string): number {
    const stats = statSync(path);
    if (stats.isFile()) return stats.mtimeMs;
    if (!stats.isDirectory()) return 0;

    let latest = stats.mtimeMs;
    for (const entry of readdirSync(path)) {
        latest = Math.max(latest, latestMtimeMs(join(path, entry)));
    }
    return latest;
}

export function ensureBuiltCliFresh(root: string, distIndex: string): void {
    const distExists = existsSync(distIndex);
    const distMtime = distExists ? statSync(distIndex).mtimeMs : 0;

    const inputMtimes = [
        ...BUILD_INPUT_DIRS.map(dir => latestMtimeMs(join(root, dir))),
        ...BUILD_INPUT_FILES
            .map(file => join(root, file))
            .filter(path => existsSync(path))
            .map(path => statSync(path).mtimeMs),
    ];
    const newestInput = Math.max(...inputMtimes, 0);

    if (!distExists || newestInput > distMtime) {
        runNpmBuild(root);
    }
}

function runNpmBuild(root: string): void {
    const options = {
        cwd: root,
        encoding: 'utf-8' as const,
        timeout: 60_000,
    };

    if (process.platform !== 'win32') {
        execFileSync('npm', ['run', 'build'], options);
        return;
    }

    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(npmCli)) {
        execFileSync(process.execPath, [npmCli, 'run', 'build'], options);
        return;
    }

    execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd run build'], options);
}
