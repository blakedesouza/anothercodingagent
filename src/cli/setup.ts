/**
 * CLI setup commands: init, configure, trust, untrust.
 *
 * These are standalone subcommands that do not require a running session.
 */

import { mkdir, writeFile, readFile, chmod, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { CONFIG_DEFAULTS, CURRENT_SCHEMA_VERSION } from '../config/schema.js';

// --- Types ---

/** Minimal user config shape (subset of ResolvedConfig for reading/writing). */
interface UserConfigFile {
    schemaVersion: number;
    trustedWorkspaces?: Record<string, 'trusted' | 'untrusted'>;
    [key: string]: unknown;
}

export interface SetupResult {
    success: boolean;
    message: string;
}

// --- aca init ---

/**
 * Create ~/.aca/ directory structure with config.json and secrets.json.
 *
 * - secrets.json gets POSIX 0600 or Windows owner-only ACL
 * - Existing files are preserved (no overwrite)
 *
 * @param acaDir - Override for testing (defaults to ~/.aca)
 */
export async function runInit(acaDir?: string): Promise<SetupResult> {
    const dir = acaDir ?? join(homedir(), '.aca');
    const lines: string[] = [];

    // Create directory structure
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, 'sessions'), { recursive: true });
    await mkdir(join(dir, 'indexes'), { recursive: true });
    lines.push(`Directory: ${dir}`);

    // Create config.json (preserve existing via exclusive create)
    const configPath = join(dir, 'config.json');
    const configCreated = await writeIfAbsent(configPath, JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        model: { default: CONFIG_DEFAULTS.model.default },
        network: { mode: CONFIG_DEFAULTS.network.mode },
    }, null, 2) + '\n');
    lines.push(configCreated ? 'Created config.json' : 'config.json already exists (preserved)');

    // Create secrets.json with restricted permissions (preserve existing)
    const secretsPath = join(dir, 'secrets.json');
    const secretsCreated = await writeIfAbsent(secretsPath, '{}\n');
    if (secretsCreated) {
        await setRestrictedPermissions(secretsPath);
        lines.push('Created secrets.json (restricted permissions)');
    } else {
        lines.push('secrets.json already exists (preserved)');
    }

    return { success: true, message: lines.join('\n') };
}

// --- aca configure ---

/**
 * Interactive configuration wizard.
 *
 * Uses @inquirer/prompts for structured prompts. Reads existing config,
 * presents choices, and writes back. All file writes happen at the end
 * so cancellation mid-wizard leaves no partial state.
 *
 * @param acaDir - Override for testing (defaults to ~/.aca)
 */
export async function runConfigure(acaDir?: string): Promise<SetupResult> {
    const { input, select, confirm, password } = await import('@inquirer/prompts');

    const dir = acaDir ?? join(homedir(), '.aca');
    const configPath = join(dir, 'config.json');

    // Ensure directory exists
    await mkdir(dir, { recursive: true });

    // Load existing config
    const existing = await readUserConfig(configPath);

    // Model selection
    const modelDefault = await input({
        message: 'Default model',
        default: (existing.model as Record<string, unknown>)?.default as string
            ?? CONFIG_DEFAULTS.model.default,
    });

    // Provider
    const defaultProvider = await select({
        message: 'Default provider',
        choices: [
            { name: 'NanoGPT', value: 'nanogpt' },
            { name: 'Anthropic', value: 'anthropic' },
            { name: 'OpenAI', value: 'openai' },
        ],
        default: existing.defaultProvider as string ?? CONFIG_DEFAULTS.defaultProvider,
    });

    // Network mode
    const networkMode = await select({
        message: 'Network mode',
        choices: [
            { name: 'Approved only (default)', value: 'approved-only' },
            { name: 'Open (allow all)', value: 'open' },
            { name: 'Off (no network)', value: 'off' },
        ],
        default: (existing.network as Record<string, unknown>)?.mode as string
            ?? CONFIG_DEFAULTS.network.mode,
    });

    // API key (optional) — collected but not written yet
    let pendingApiKey: { provider: string; key: string } | null = null;
    const setApiKey = await confirm({
        message: `Set ${defaultProvider} API key?`,
        default: false,
    });

    if (setApiKey) {
        const apiKey = await password({
            message: `Enter ${defaultProvider} API key`,
            mask: '*',
        });

        if (apiKey.trim()) {
            pendingApiKey = { provider: defaultProvider, key: apiKey.trim() };
        }
    }

    // --- All prompts complete; write all files atomically ---

    // Write config
    const newConfig: UserConfigFile = {
        ...existing,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        model: {
            ...(existing.model as Record<string, unknown> ?? {}),
            default: modelDefault,
        },
        defaultProvider,
        network: {
            ...(existing.network as Record<string, unknown> ?? {}),
            mode: networkMode,
        },
    };

    await atomicWriteJson(configPath, newConfig);

    // Write secrets (if API key was entered)
    if (pendingApiKey) {
        const secretsPath = join(dir, 'secrets.json');
        const secrets = await readJsonFile(secretsPath);
        secrets[pendingApiKey.provider] = pendingApiKey.key;
        await atomicWriteJson(secretsPath, secrets);
        await setRestrictedPermissions(secretsPath);
    }

    return {
        success: true,
        message: `Configuration saved to ${configPath}`,
    };
}

// --- aca trust ---

/**
 * Mark a workspace path as trusted in ~/.aca/config.json.
 *
 * @param targetPath - Workspace path (defaults to cwd)
 * @param acaDir - Override for testing (defaults to ~/.aca)
 */
export async function runTrust(targetPath?: string, acaDir?: string): Promise<SetupResult> {
    const absPath = resolve(targetPath ?? process.cwd());
    const dir = acaDir ?? join(homedir(), '.aca');
    const configPath = join(dir, 'config.json');

    // Ensure directory and config exist
    await mkdir(dir, { recursive: true });
    const config = await readUserConfig(configPath);

    // Update trustedWorkspaces
    if (!config.trustedWorkspaces || typeof config.trustedWorkspaces !== 'object') {
        config.trustedWorkspaces = {};
    }
    config.trustedWorkspaces[absPath] = 'trusted';

    await atomicWriteJson(configPath, config);

    return {
        success: true,
        message: `Trusted: ${absPath}`,
    };
}

// --- aca untrust ---

/**
 * Remove workspace trust from ~/.aca/config.json.
 *
 * @param targetPath - Workspace path (defaults to cwd)
 * @param acaDir - Override for testing (defaults to ~/.aca)
 */
export async function runUntrust(targetPath?: string, acaDir?: string): Promise<SetupResult> {
    const absPath = resolve(targetPath ?? process.cwd());
    const dir = acaDir ?? join(homedir(), '.aca');
    const configPath = join(dir, 'config.json');

    const config = await readUserConfig(configPath);

    if (!config.trustedWorkspaces || !(absPath in config.trustedWorkspaces)) {
        return {
            success: true,
            message: `Not trusted (no change): ${absPath}`,
        };
    }

    delete config.trustedWorkspaces[absPath];

    await atomicWriteJson(configPath, config);

    return {
        success: true,
        message: `Untrusted: ${absPath}`,
    };
}

// --- Internal helpers ---

/**
 * Write file only if it doesn't exist (atomic via 'wx' flag).
 * Returns true if created, false if already exists.
 */
async function writeIfAbsent(filePath: string, content: string): Promise<boolean> {
    try {
        await writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' });
        return true;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
            return false;
        }
        throw err; // Propagate unexpected errors
    }
}

/**
 * Atomic JSON write: write to temp file in same directory, then rename.
 * Rename is atomic on POSIX; on Windows it's close enough for config files.
 */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
    const dir = dirname(filePath);
    const tmpPath = join(dir, `.tmp-${randomUUID()}.json`);
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    await rename(tmpPath, filePath);
}

/**
 * Set restricted permissions on a file.
 * POSIX: chmod 0600. Windows: icacls owner-only via execFileSync (no shell injection).
 */
async function setRestrictedPermissions(filePath: string): Promise<void> {
    if (platform() === 'win32') {
        try {
            execFileSync('icacls', [
                filePath,
                '/inheritance:r',
                '/grant:r',
                `${process.env.USERNAME ?? ''}:F`,
            ], { stdio: 'ignore' });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[warn] Failed to set file permissions via icacls: ${msg}\n`);
        }
    } else {
        await chmod(filePath, 0o600);
    }
}

/**
 * Read a JSON file. Returns empty object for ENOENT (file not found).
 * Throws on parse errors or other I/O errors to surface corruption.
 */
async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
    let content: string;
    try {
        content = await readFile(filePath, 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        throw err;
    }

    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
    }
    throw new Error(`Expected JSON object in ${filePath}, got ${typeof parsed}`);
}

/** Read user config file, returning a valid UserConfigFile. */
async function readUserConfig(configPath: string): Promise<UserConfigFile> {
    const data = await readJsonFile(configPath);
    if (!data.schemaVersion) {
        data.schemaVersion = CURRENT_SCHEMA_VERSION;
    }
    return data as UserConfigFile;
}
