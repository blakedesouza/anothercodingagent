/**
 * Secrets loading — env vars (primary) + ~/.aca/secrets.json (fallback).
 *
 * API keys are NEVER stored in config files or passed on the command line.
 * The secrets file must have 0600 permissions (owner read/write only).
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface LoadedSecrets {
    [provider: string]: string;
}

export interface SecretsResult {
    secrets: LoadedSecrets;
    warnings: string[];
}

/** Maps provider names to their environment variable names. */
const PROVIDER_ENV_VARS: Record<string, string> = {
    nanogpt: 'NANOGPT_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    tavily: 'TAVILY_API_KEY',
};

/**
 * Load API keys from environment variables, ~/.aca/secrets.json, and ~/.api_keys.
 *
 * Resolution order per provider:
 * 1. Environment variable (e.g., NANOGPT_API_KEY)
 * 2. secrets.json entry (if file exists with correct permissions)
 * 3. ~/.api_keys shell export file (e.g., `export NANOGPT_API_KEY="sk-..."`)
 *
 * @param env - Environment variables (defaults to process.env)
 * @param secretsPath - Override path for testing (defaults to ~/.aca/secrets.json)
 */
export async function loadSecrets(
    env: Record<string, string | undefined> = process.env,
    secretsPath?: string,
    apiKeysPathOverride?: string,
): Promise<SecretsResult> {
    const secrets: LoadedSecrets = {};
    const warnings: string[] = [];

    // Step 1: Load from env vars (primary)
    for (const [provider, envVar] of Object.entries(PROVIDER_ENV_VARS)) {
        const value = env[envVar];
        if (value) {
            secrets[provider] = value;
        }
    }

    // Step 2: Fallback to secrets.json
    const filePath = secretsPath ?? join(homedir(), '.aca', 'secrets.json');
    try {
        const stats = await stat(filePath);
        const mode = stats.mode & 0o777;
        if (mode !== 0o600) {
            warnings.push(
                `secrets.json has permissions 0${mode.toString(8)}, expected 0600. Refusing to load.`,
            );
        } else {
            const content = await readFile(filePath, 'utf-8');
            let parsed: unknown;
            try {
                parsed = JSON.parse(content);
            } catch {
                warnings.push('secrets.json contains invalid JSON');
                return { secrets, warnings };
            }

            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                warnings.push('secrets.json must be a JSON object');
                return { secrets, warnings };
            }

            // Only fill in providers not already set from env vars
            for (const [provider, key] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof key === 'string' && !secrets[provider]) {
                    secrets[provider] = key;
                }
            }
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            warnings.push(`Failed to load secrets.json: ${(err as Error).message}`);
        }
        // ENOENT is not an error — file is optional
    }

    // Step 3: Fallback to ~/.api_keys (shell export format)
    // Parses lines like: export NANOGPT_API_KEY="sk-nano-..."
    const apiKeysPath = apiKeysPathOverride ?? join(homedir(), '.api_keys');
    try {
        const content = await readFile(apiKeysPath, 'utf-8');
        for (const [provider, envVar] of Object.entries(PROVIDER_ENV_VARS)) {
            if (secrets[provider]) continue; // Already set from env or secrets.json
            const pattern = new RegExp(
                `(?:export\\s+)?${envVar}\\s*=\\s*["']?([^"'\\s]+)["']?`,
            );
            const match = content.match(pattern);
            if (match?.[1]) {
                secrets[provider] = match[1];
            }
        }
    } catch {
        // ~/.api_keys not found or unreadable — not an error
    }

    return { secrets, warnings };
}
