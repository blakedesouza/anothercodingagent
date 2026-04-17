import { spawn, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const DEFAULT_DEBUG_UI_HOST = '127.0.0.1';
export const DEFAULT_DEBUG_UI_PORT = 4777;
export const DEBUG_UI_METADATA_FILE = 'debug-ui.json';

function resolveDebugUiServerScriptPath(): string {
    const candidates = [
        resolve(__dirname, '..', 'scripts', 'aca-debug-ui-server.mjs'),
        resolve(__dirname, '..', '..', 'scripts', 'aca-debug-ui-server.mjs'),
        resolve(process.cwd(), 'scripts', 'aca-debug-ui-server.mjs'),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }
    return candidates[0];
}

export const DEBUG_UI_SERVER_SCRIPT = resolveDebugUiServerScriptPath();

const WINDOWS_CMD = '/mnt/c/Windows/System32/cmd.exe';
const WINDOWS_BRAVE_WSL_PATH = '/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const WINDOWS_BRAVE_EXE = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const KNOWN_SUBCOMMANDS = new Set([
    'serve',
    'describe',
    'witnesses',
    'consult',
    'rp-research',
    'invoke',
    'stats',
    'init',
    'configure',
    'trust',
    'untrust',
    'debug-ui',
    'help',
]);

const AUTO_START_SKIP_COMMANDS = new Set([
    'describe',
    'witnesses',
    'invoke',
    'debug-ui',
    'help',
]);

export interface DebugUiMetadata {
    version: 1;
    host: string;
    port: number;
    token: string;
    pid: number | null;
    url: string;
    acaHome: string;
    metadataPath: string;
    startedAt: string;
}

export interface BrowserLaunchCommand {
    command: string;
    args: string[];
}

interface AutoStartOptions {
    env?: NodeJS.ProcessEnv;
    stdoutIsTTY?: boolean;
}

interface EnsureDebugUiOptions {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    spawnImpl?: typeof spawn;
    waitMs?: number;
    pollMs?: number;
}

export interface EnsureDebugUiResult {
    metadata: DebugUiMetadata | null;
    started: boolean;
    browserOpened: boolean;
}

function resolveAcaHome(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.ACA_HOME?.trim();
    if (configured) return resolve(configured);
    return resolve(join(homedir(), '.aca'));
}

export function resolveDebugUiMetadataPath(env: NodeJS.ProcessEnv = process.env): string {
    return resolve(resolveAcaHome(env), DEBUG_UI_METADATA_FILE);
}

export function detectTopLevelSubcommand(argv: string[] = process.argv): string | null {
    for (const token of argv.slice(2)) {
        if (!token || token.startsWith('-')) continue;
        return KNOWN_SUBCOMMANDS.has(token) ? token : null;
    }
    return null;
}

export function shouldAutoStartDebugUi(
    argv: string[] = process.argv,
    options: AutoStartOptions = {},
): boolean {
    const env = options.env ?? process.env;
    const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY ?? false;

    if (!stdoutIsTTY) return false;
    if (env.CI === '1' || env.CI === 'true') return false;
    if (env.VITEST) return false;
    if (env.NODE_ENV === 'test') return false;
    if (env.ACA_DEBUG_UI_AUTO === '0') return false;
    if (!existsSync(DEBUG_UI_SERVER_SCRIPT)) return false;

    const subcommand = detectTopLevelSubcommand(argv);
    return subcommand === null || !AUTO_START_SKIP_COMMANDS.has(subcommand);
}

export function readDebugUiMetadata(metadataPath: string): DebugUiMetadata | null {
    if (!existsSync(metadataPath)) return null;
    try {
        const parsed = JSON.parse(readFileSync(metadataPath, 'utf-8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        const record = parsed as Record<string, unknown>;
        if (record.version !== 1) return null;
        if (typeof record.host !== 'string' || record.host.trim() === '') return null;
        if (typeof record.port !== 'number' || !Number.isInteger(record.port) || record.port <= 0) return null;
        if (typeof record.token !== 'string' || record.token.trim() === '') return null;
        if (record.pid !== null && (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0)) return null;
        if (typeof record.url !== 'string' || record.url.trim() === '') return null;
        if (typeof record.acaHome !== 'string' || record.acaHome.trim() === '') return null;
        if (typeof record.metadataPath !== 'string' || record.metadataPath.trim() === '') return null;
        if (typeof record.startedAt !== 'string' || record.startedAt.trim() === '') return null;
        return {
            version: 1,
            host: record.host,
            port: record.port,
            token: record.token,
            pid: record.pid,
            url: record.url,
            acaHome: record.acaHome,
            metadataPath: record.metadataPath,
            startedAt: record.startedAt,
        };
    } catch {
        return null;
    }
}

export async function isDebugUiHealthy(
    metadata: Pick<DebugUiMetadata, 'host' | 'port'>,
    fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
    try {
        const response = await fetchImpl(`http://${metadata.host}:${metadata.port}/healthz`, {
            signal: AbortSignal.timeout(1000),
        });
        if (!response.ok) return false;
        const payload = await response.json() as { ok?: unknown };
        return payload.ok === true;
    } catch {
        return false;
    }
}

function buildPassthroughExecArgv(execArgv: string[] = process.execArgv): string[] {
    const passthrough: string[] = [];
    for (let i = 0; i < execArgv.length; i++) {
        const arg = execArgv[i];
        if (arg === '--import' || arg === '--loader' || arg === '--require' || arg === '-r') {
            passthrough.push(arg);
            const value = execArgv[i + 1];
            if (value !== undefined) {
                passthrough.push(value);
                i++;
            }
            continue;
        }
        if (arg.startsWith('--import=') || arg.startsWith('--loader=') || arg.startsWith('--require=')) {
            passthrough.push(arg);
        }
    }
    return passthrough;
}

function parsePort(raw: string | undefined): number | null {
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) return null;
    return parsed;
}

function buildFallbackMetadata(env: NodeJS.ProcessEnv, token: string): DebugUiMetadata {
    const host = env.ACA_DEBUG_UI_HOST?.trim() || DEFAULT_DEBUG_UI_HOST;
    const port = parsePort(env.ACA_DEBUG_UI_PORT) ?? DEFAULT_DEBUG_UI_PORT;
    const acaHome = resolveAcaHome(env);
    const metadataPath = resolveDebugUiMetadataPath(env);
    const url = `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
    return {
        version: 1,
        host,
        port,
        token,
        pid: null,
        url,
        acaHome,
        metadataPath,
        startedAt: new Date().toISOString(),
    };
}

function buildChildSpawnEnv(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
    const metadata = buildFallbackMetadata(env, token);
    return {
        ...env,
        ACA_HOME: metadata.acaHome,
        ACA_DEBUG_UI_HOST: metadata.host,
        ACA_DEBUG_UI_PORT: String(metadata.port),
        ACA_DEBUG_UI_TOKEN: metadata.token,
        ACA_DEBUG_UI_METADATA_PATH: metadata.metadataPath,
    };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForDebugUiMetadata(
    metadataPath: string,
    fetchImpl: typeof fetch,
    waitMs: number,
    pollMs: number,
): Promise<DebugUiMetadata | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= waitMs) {
        const metadata = readDebugUiMetadata(metadataPath);
        if (metadata && await isDebugUiHealthy(metadata, fetchImpl)) {
            return metadata;
        }
        await delay(pollMs);
    }
    return null;
}

function findExecutableOnPath(
    commandName: string,
    env: NodeJS.ProcessEnv = process.env,
    exists: (path: string) => boolean = existsSync,
): string | null {
    const pathValue = env.PATH;
    if (!pathValue) return null;
    for (const entry of pathValue.split(':')) {
        if (!entry) continue;
        const candidate = join(entry, commandName);
        if (exists(candidate)) return candidate;
    }
    return null;
}

export function buildBraveLaunchCommand(
    url: string,
    env: NodeJS.ProcessEnv = process.env,
    exists: (path: string) => boolean = existsSync,
): BrowserLaunchCommand | null {
    if (exists(WINDOWS_CMD) && exists(WINDOWS_BRAVE_WSL_PATH)) {
        return {
            command: WINDOWS_CMD,
            args: ['/c', 'start', '', WINDOWS_BRAVE_EXE, '--new-tab', url],
        };
    }

    const braveBrowser = findExecutableOnPath('brave-browser', env, exists);
    if (braveBrowser) {
        return { command: braveBrowser, args: ['--new-tab', url] };
    }

    const brave = findExecutableOnPath('brave', env, exists);
    if (brave) {
        return { command: brave, args: ['--new-tab', url] };
    }

    return null;
}

function launchBrave(
    metadata: DebugUiMetadata,
    env: NodeJS.ProcessEnv,
    spawnImpl: typeof spawn,
): boolean {
    const launch = buildBraveLaunchCommand(metadata.url, env);
    if (!launch) return false;
    const options: SpawnOptions = {
        detached: true,
        stdio: 'ignore',
        env,
    };
    try {
        const child = spawnImpl(launch.command, launch.args, options);
        child.unref();
        return true;
    } catch {
        return false;
    }
}

export async function ensureDebugUiStarted(
    options: EnsureDebugUiOptions = {},
): Promise<EnsureDebugUiResult> {
    const env = options.env ?? process.env;
    const fetchImpl = options.fetchImpl ?? fetch;
    const spawnImpl = options.spawnImpl ?? spawn;
    const waitMs = options.waitMs ?? 5000;
    const pollMs = options.pollMs ?? 200;
    const metadataPath = resolveDebugUiMetadataPath(env);
    const existing = readDebugUiMetadata(metadataPath);

    if (existing && await isDebugUiHealthy(existing, fetchImpl)) {
        return { metadata: existing, started: false, browserOpened: false };
    }

    const token = env.ACA_DEBUG_UI_TOKEN?.trim() || randomBytes(18).toString('base64url');
    const childEnv = buildChildSpawnEnv(env, token);
    await mkdir(dirname(metadataPath), { recursive: true });

    const child = spawnImpl(
        process.execPath,
        [...buildPassthroughExecArgv(), DEBUG_UI_SERVER_SCRIPT],
        {
            cwd: dirname(dirname(DEBUG_UI_SERVER_SCRIPT)),
            env: childEnv,
            detached: true,
            stdio: 'ignore',
        },
    );
    child.unref();

    const metadata = await waitForDebugUiMetadata(metadataPath, fetchImpl, waitMs, pollMs);
    if (metadata) {
        return {
            metadata,
            started: true,
            browserOpened: launchBrave(metadata, env, spawnImpl),
        };
    }

    const fallback = buildFallbackMetadata(env, token);
    if (await isDebugUiHealthy(fallback, fetchImpl)) {
        return { metadata: fallback, started: false, browserOpened: false };
    }

    return { metadata: null, started: true, browserOpened: false };
}

export async function maybeAutoStartDebugUi(
    argv: string[] = process.argv,
    options: EnsureDebugUiOptions & AutoStartOptions = {},
): Promise<void> {
    if (!shouldAutoStartDebugUi(argv, options)) return;
    try {
        await ensureDebugUiStarted(options);
    } catch {
        // Best-effort local convenience feature: never block ACA startup.
    }
}
