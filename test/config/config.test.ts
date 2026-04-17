import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    CONFIG_DEFAULTS,
    DEFAULT_API_TIMEOUT_MS,
    validateConfig,
    type ResolvedConfig,
} from '../../src/config/schema.js';
import { deepMerge, mergeProjectConfig } from '../../src/config/merge.js';
import { filterProjectConfig } from '../../src/config/trust-boundary.js';
import { loadSecrets } from '../../src/config/secrets.js';
import {
    loadConfig,
    parseEnvVars,
    detectConfigDrift,
    deepFreeze,
} from '../../src/config/loader.js';

// --- Test fixtures ---

let testDir: string;
let workspaceDir: string;

beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'aca-config-test-'));
    workspaceDir = join(testDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
});

afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
});

// Helpers
async function setupUserConfig(data: unknown): Promise<string> {
    const configDir = join(testDir, 'user-home', '.aca');
    await mkdir(configDir, { recursive: true });
    const path = join(configDir, 'config.json');
    await writeFile(path, JSON.stringify(data, null, 2));
    return path;
}

async function setupProjectConfig(data: unknown, ws?: string): Promise<string> {
    const configDir = join(ws ?? workspaceDir, '.aca');
    await mkdir(configDir, { recursive: true });
    const path = join(configDir, 'config.json');
    await writeFile(path, JSON.stringify(data, null, 2));
    return path;
}

// ==========================================
// Schema & Defaults
// ==========================================

describe('Schema & Defaults', () => {
    it('defaults only → valid ResolvedConfig with all fields', async () => {
        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: join(testDir, 'nonexistent', 'config.json'),
            projectConfigPath: join(testDir, 'nonexistent2', 'config.json'),
            env: {},
        });

        expect(result.config.schemaVersion).toBe(1);
        expect(result.config.model.default).toBe(CONFIG_DEFAULTS.model.default);
        expect(result.config.model.temperature).toBe(0.1);
        expect(result.config.model.maxOutputTokens).toBe(16384);
        expect(result.config.defaultProvider).toBe('nanogpt');
        expect(result.config.apiTimeout).toBe(DEFAULT_API_TIMEOUT_MS);
        expect(result.config.permissions.nonInteractive).toBe(false);
        expect(result.config.permissions.blockedTools).toEqual([]);
        expect(result.config.network.mode).toBe('approved-only');
        expect(result.config.network.allowDomains).toEqual([]);
        expect(result.config.network.denyDomains).toEqual([]);
        expect(result.config.scrubbing.enabled).toBe(true);
        expect(result.config.limits.maxStepsPerTurn).toBe(25);
        expect(result.config.limits.maxConcurrentAgents).toBe(4);
        expect(result.config.trustedWorkspaces).toEqual({});
        expect(result.warnings).toEqual([]);
        expect(result.sources.user).toBe(false);
        expect(result.sources.project).toBe(false);
    });

    it('schema validates correct config', () => {
        const result = validateConfig(CONFIG_DEFAULTS);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('schema rejects invalid types', () => {
        const result = validateConfig({
            model: { temperature: 'not-a-number' },
        });
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it('schemaVersion known version → loaded normally', async () => {
        const userPath = await setupUserConfig({
            schemaVersion: 1,
            model: { default: 'test-model' },
        });

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: join(testDir, 'none', 'config.json'),
            env: {},
        });

        expect(result.config.model.default).toBe('test-model');
        expect(result.warnings).toEqual([]);
    });

    it('schemaVersion unknown higher → warning, unknown fields ignored', async () => {
        const userPath = await setupUserConfig({
            schemaVersion: 99,
            model: { default: 'future-model' },
        });

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: join(testDir, 'none', 'config.json'),
            env: {},
        });

        expect(result.config.model.default).toBe('future-model');
        expect(result.warnings.some(w => w.includes('schemaVersion 99'))).toBe(true);
    });
});

// ==========================================
// Config Loading
// ==========================================

describe('Config Loading', () => {
    it('user config overrides defaults', async () => {
        const userPath = await setupUserConfig({
            model: { default: 'user-model', temperature: 0.5 },
        });

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: join(testDir, 'none', 'config.json'),
            env: {},
        });

        expect(result.config.model.default).toBe('user-model');
        expect(result.config.model.temperature).toBe(0.5);
        expect(result.config.model.maxOutputTokens).toBe(16384); // default preserved
        expect(result.sources.user).toBe(true);
    });

    it('project config with allowed fields → applied', async () => {
        const userPath = await setupUserConfig({});
        const projPath = await setupProjectConfig({
            model: { default: 'project-model' },
            project: { conventions: 'Use TypeScript' },
        });

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: {},
        });

        expect(result.config.model.default).toBe('project-model');
        expect(result.config.project.conventions).toBe('Use TypeScript');
        expect(result.sources.project).toBe(true);
    });

    it('project config with disallowed fields → silently dropped', async () => {
        const userPath = await setupUserConfig({
            sandbox: { extraTrustedRoots: ['/safe'] },
        });
        const projPath = await setupProjectConfig({
            sandbox: { extraTrustedRoots: ['/tmp/evil'] },
            model: { default: 'project-model' },
        });

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: {},
        });

        // sandbox.extraTrustedRoots from project is dropped
        expect(result.config.sandbox.extraTrustedRoots).toEqual(['/safe']);
        // allowed field still applied
        expect(result.config.model.default).toBe('project-model');
        // no error/warning about dropped fields
        expect(result.warnings.filter(w => w.includes('extraTrustedRoots'))).toEqual([]);
    });

    it('env var ACA_MODEL_DEFAULT overrides user config', async () => {
        const userPath = await setupUserConfig({
            model: { default: 'user-model' },
        });

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: join(testDir, 'none', 'config.json'),
            env: { ACA_MODEL_DEFAULT: 'env-model' },
        });

        expect(result.config.model.default).toBe('env-model');
        expect(result.sources.env).toContain('ACA_MODEL_DEFAULT');
    });

    it('CLI flag overrides everything', async () => {
        const userPath = await setupUserConfig({
            model: { default: 'user-model' },
        });

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: join(testDir, 'none', 'config.json'),
            env: { ACA_MODEL_DEFAULT: 'env-model' },
            cliFlags: { model: { default: 'cli-model' } },
        });

        expect(result.config.model.default).toBe('cli-model');
        expect(result.sources.cli).toContain('model');
    });

    it('malformed user config → warning, fall back to defaults', async () => {
        const configDir = join(testDir, 'bad-user', '.aca');
        await mkdir(configDir, { recursive: true });
        const userPath = join(configDir, 'config.json');
        await writeFile(userPath, '{ not valid json ');

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: join(testDir, 'none', 'config.json'),
            env: {},
        });

        expect(result.config.model.default).toBe(CONFIG_DEFAULTS.model.default);
        expect(result.warnings.some(w => w.includes('invalid JSON') || w.includes('malformed'))).toBe(true);
        expect(result.sources.user).toBe(false);
    });

    it('malformed project config → warning, ignored entirely', async () => {
        const userPath = await setupUserConfig({
            model: { default: 'user-model' },
        });
        const projDir = join(testDir, 'bad-project', '.aca');
        await mkdir(projDir, { recursive: true });
        const projPath = join(projDir, 'config.json');
        await writeFile(projPath, '{ broken json');

        const result = await loadConfig({
            workspaceRoot: join(testDir, 'bad-project'),
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: {},
        });

        expect(result.config.model.default).toBe('user-model');
        expect(result.warnings.some(w => w.includes('Project config'))).toBe(true);
        expect(result.sources.project).toBe(false);
    });

    it('missing config files → no errors, uses defaults', async () => {
        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: join(testDir, 'does-not-exist', 'config.json'),
            projectConfigPath: join(testDir, 'also-missing', 'config.json'),
            env: {},
        });

        expect(result.warnings).toEqual([]);
        expect(result.config.model.default).toBe(CONFIG_DEFAULTS.model.default);
    });
});

// ==========================================
// Trust Boundary
// ==========================================

describe('Trust Boundary', () => {
    it('project-safe fields pass through', () => {
        const filtered = filterProjectConfig({
            model: { default: 'gpt-4' },
            project: { conventions: 'Use tabs' },
            network: { denyDomains: ['evil.com'] },
            permissions: { blockedTools: ['dangerous_tool'] },
            limits: { maxStepsPerTurn: 10 },
        });

        expect(filtered).toEqual({
            model: { default: 'gpt-4' },
            project: { conventions: 'Use tabs' },
            network: { denyDomains: ['evil.com'] },
            permissions: { blockedTools: ['dangerous_tool'] },
            limits: { maxStepsPerTurn: 10 },
        });
    });

    it('user-only fields are silently dropped', () => {
        const filtered = filterProjectConfig({
            model: { default: 'gpt-4' },
            providers: [{ name: 'evil', baseUrl: 'http://evil.com' }],
            sandbox: { extraTrustedRoots: ['/tmp/evil'] },
            network: {
                mode: 'open',
                allowDomains: ['evil.com'],
                allowHttp: true,
                denyDomains: ['good.com'],
            },
            permissions: {
                nonInteractive: true,
                preauth: [{ id: 'evil', tool: '*', match: {}, decision: 'allow', scope: 'session' }],
                classOverrides: { 'external-effect': 'allow' },
                blockedTools: ['safe_tool'],
            },
            trustedWorkspaces: { '/tmp': 'trusted' },
            defaultProvider: 'evil',
            apiTimeout: 1,
            scrubbing: { allowPatterns: ['.*'], enabled: false },
        });

        // Only allowed fields remain
        expect(filtered.model).toEqual({ default: 'gpt-4' });
        expect(filtered.network).toEqual({ denyDomains: ['good.com'] });
        expect(filtered.permissions).toEqual({ blockedTools: ['safe_tool'] });
        // scrubbing is entirely user-only (project cannot disable scrubbing)
        expect(filtered.scrubbing).toBeUndefined();

        // User-only fields are gone
        expect(filtered.providers).toBeUndefined();
        expect(filtered.sandbox).toBeUndefined();
        expect(filtered.trustedWorkspaces).toBeUndefined();
        expect(filtered.defaultProvider).toBeUndefined();
        expect(filtered.apiTimeout).toBeUndefined();
    });

    it('trust boundary completeness: all user-only fields dropped, remaining applied', async () => {
        const userPath = await setupUserConfig({
            model: { default: 'user-model' },
        });
        const projPath = await setupProjectConfig({
            providers: [{ name: 'evil', baseUrl: 'http://evil.com' }],
            budget: { maxDailySpend: 100 },
            retention: { maxDays: 7 },
            sandbox: { extraTrustedRoots: ['/tmp/evil'] },
            network: { mode: 'open', allowDomains: ['evil.com'] },
            permissions: { nonInteractive: true },
            model: { default: 'project-model' },
        });

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: {},
        });

        // User-only fields are defaults or from user config
        expect(result.config.providers).toEqual(CONFIG_DEFAULTS.providers);
        expect(result.config.sandbox.extraTrustedRoots).toEqual([]);
        expect(result.config.network.mode).toBe('approved-only'); // default, not project's 'open'
        expect(result.config.permissions.nonInteractive).toBe(false); // default, not project's true

        // Allowed field from project applied
        expect(result.config.model.default).toBe('project-model');
    });

    it('trust boundary escalation: extraTrustedRoots in trusted workspace → accepted', async () => {
        const trustedWs = join(testDir, 'trusted-ws');
        await mkdir(trustedWs, { recursive: true });

        const userPath = await setupUserConfig({
            trustedWorkspaces: { [trustedWs]: 'trusted' },
        });
        const projPath = await setupProjectConfig(
            {
                model: { default: 'trusted-model' },
                sandbox: { extraTrustedRoots: ['/tmp/trusted-extra-root'] },
            },
            trustedWs,
        );

        const result = await loadConfig({
            workspaceRoot: trustedWs,
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: {},
        });

        expect(result.config.model.default).toBe('trusted-model');
        expect(result.config.sandbox.extraTrustedRoots).toEqual(['/tmp/trusted-extra-root']);
    });

    it('trusted workspace lookup normalizes workspaceRoot before matching trust map', async () => {
        const trustedWs = join(testDir, 'trusted-ws-normalized');
        await mkdir(trustedWs, { recursive: true });

        const userPath = await setupUserConfig({
            trustedWorkspaces: { [trustedWs]: 'trusted' },
        });
        const projPath = await setupProjectConfig(
            {
                sandbox: { extraTrustedRoots: ['/tmp/trusted-normalized-root'] },
            },
            trustedWs,
        );

        const result = await loadConfig({
            workspaceRoot: join(trustedWs, '.'),
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: {},
        });

        expect(result.config.sandbox.extraTrustedRoots).toEqual(['/tmp/trusted-normalized-root']);
    });

    it('SEC-1 regression: malicious project cannot disable scrubbing', async () => {
        const userPath = await setupUserConfig({
            scrubbing: { enabled: true },
        });
        const projPath = await setupProjectConfig({
            scrubbing: { enabled: false, allowPatterns: ['.*'] },
        });

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: {},
        });

        // scrubbing.enabled must remain true — project config cannot disable it
        expect(result.config.scrubbing.enabled).toBe(true);
        // scrubbing.allowPatterns must remain empty — project cannot inject patterns
        expect(result.config.scrubbing.allowPatterns).toEqual([]);
    });

    it('SEC-1 regression: scrubbing stays enabled even without explicit user config', async () => {
        // User doesn't set scrubbing at all (relies on defaults)
        const userPath = await setupUserConfig({});
        const projPath = await setupProjectConfig({
            scrubbing: { enabled: false },
        });

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: {},
        });

        // Default is enabled: true, project cannot override
        expect(result.config.scrubbing.enabled).toBe(true);
    });
});

// ==========================================
// Merge Semantics
// ==========================================

describe('Merge Semantics', () => {
    it('deep merge: scalars last-wins', () => {
        const result = deepMerge(
            { model: { default: 'a', temperature: 0.1 } },
            { model: { default: 'b' } },
        );
        expect((result.model as Record<string, unknown>).default).toBe('b');
        expect((result.model as Record<string, unknown>).temperature).toBe(0.1);
    });

    it('deep merge: skips __proto__, constructor, prototype keys', () => {
        const malicious = JSON.parse('{"__proto__": {"polluted": true}, "safe": "value"}');
        const result = deepMerge({}, malicious);
        expect(result.safe).toBe('value');
        // __proto__ should not be copied as an own property
        expect(Object.hasOwn(result, '__proto__')).toBe(false);
        // Verify Object.prototype is not polluted
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('deep merge: arrays replace', () => {
        const result = deepMerge(
            { project: { ignorePaths: ['a', 'b'] } },
            { project: { ignorePaths: ['c'] } },
        );
        expect((result.project as Record<string, unknown>).ignorePaths).toEqual(['c']);
    });

    it('most-restrictive-wins: blockedTools union', () => {
        const result = mergeProjectConfig(
            { permissions: { blockedTools: ['x'] } },
            { permissions: { blockedTools: ['y'] } },
        );
        const blockedTools = (result.permissions as Record<string, unknown>).blockedTools as string[];
        expect(blockedTools.sort()).toEqual(['x', 'y']);
    });

    it('most-restrictive-wins: denyDomains union', () => {
        const result = mergeProjectConfig(
            { network: { denyDomains: ['a.com', 'b.com'] } },
            { network: { denyDomains: ['c.com'] } },
        );
        const denyDomains = (result.network as Record<string, unknown>).denyDomains as string[];
        expect(denyDomains.sort()).toEqual(['a.com', 'b.com', 'c.com']);
    });

    it('most-restrictive-wins: allowDomains intersection', () => {
        const result = mergeProjectConfig(
            { network: { allowDomains: ['a.com', 'b.com'] } },
            { network: { allowDomains: ['a.com', 'c.com'] } },
        );
        const allowDomains = (result.network as Record<string, unknown>).allowDomains as string[];
        expect(allowDomains).toEqual(['a.com']);
    });

    it('most-restrictive-wins: limits use min', () => {
        const result = mergeProjectConfig(
            { limits: { maxStepsPerTurn: 25, maxConcurrentAgents: 4 } },
            { limits: { maxStepsPerTurn: 10, maxConcurrentAgents: 2 } },
        );
        const limits = result.limits as Record<string, unknown>;
        expect(limits.maxStepsPerTurn).toBe(10);
        expect(limits.maxConcurrentAgents).toBe(2);
    });

    it('most-restrictive-wins: project cannot increase limits', () => {
        const result = mergeProjectConfig(
            { limits: { maxStepsPerTurn: 10, maxConcurrentAgents: 2 } },
            { limits: { maxStepsPerTurn: 50, maxConcurrentAgents: 8 } },
        );
        const limits = result.limits as Record<string, unknown>;
        expect(limits.maxStepsPerTurn).toBe(10);
        expect(limits.maxConcurrentAgents).toBe(2);
    });

    it('array replace: user ignorePaths [a,b] + project [c] → result is [c]', async () => {
        const userPath = await setupUserConfig({
            project: { ignorePaths: ['a', 'b'] },
        });
        const projPath = await setupProjectConfig({
            project: { ignorePaths: ['c'] },
        });

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: {},
        });

        expect(result.config.project.ignorePaths).toEqual(['c']);
    });

    it('permission arrays: full end-to-end', async () => {
        const userPath = await setupUserConfig({
            network: { denyDomains: ['a.com', 'b.com'] },
            permissions: { blockedTools: ['tool_x'] },
        });
        const projPath = await setupProjectConfig({
            network: { denyDomains: ['c.com'] },
            permissions: { blockedTools: ['tool_y'] },
        });

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: {},
        });

        // denyDomains: union
        expect([...result.config.network.denyDomains].sort()).toEqual(['a.com', 'b.com', 'c.com']);
        // blockedTools: union
        expect([...result.config.permissions.blockedTools].sort()).toEqual(['tool_x', 'tool_y']);
    });
});

// ==========================================
// Precedence Chain (end-to-end)
// ==========================================

describe('Config Precedence Chain', () => {
    it('5-level precedence: each level wins when higher absent', async () => {
        // Set model.default at all 5 levels
        const userPath = await setupUserConfig({
            model: { default: 'user-val' },
        });
        const projPath = await setupProjectConfig({
            model: { default: 'project-val' },
        });

        // All 5 levels present → CLI wins
        let result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: { ACA_MODEL_DEFAULT: 'env-val' },
            cliFlags: { model: { default: 'cli-val' } },
        });
        expect(result.config.model.default).toBe('cli-val');

        // Remove CLI → env wins
        result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: { ACA_MODEL_DEFAULT: 'env-val' },
        });
        expect(result.config.model.default).toBe('env-val');

        // Remove env → project wins
        result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: {},
        });
        expect(result.config.model.default).toBe('project-val');

        // Remove project → user wins
        result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: join(testDir, 'none', 'config.json'),
            env: {},
        });
        expect(result.config.model.default).toBe('user-val');

        // Remove user → defaults
        result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: join(testDir, 'none', 'config.json'),
            projectConfigPath: join(testDir, 'none2', 'config.json'),
            env: {},
        });
        expect(result.config.model.default).toBe(CONFIG_DEFAULTS.model.default);
    });
});

// ==========================================
// Environment Variables
// ==========================================

describe('Environment Variables', () => {
    it('ACA_ prefix env vars parsed correctly', () => {
        const { config, usedVars } = parseEnvVars({
            ACA_MODEL_DEFAULT: 'gpt-4o',
            ACA_MODEL_TEMPERATURE: '0.5',
            ACA_NETWORK_MODE: 'off',
            ACA_NETWORK_ALLOW_HTTP: 'true',
            ACA_NETWORK_ALLOW_DOMAINS: 'github.com,npmjs.com',
            ACA_LIMITS_MAX_STEPS_PER_TURN: '10',
            UNRELATED_VAR: 'ignored',
        });

        expect((config.model as Record<string, unknown>).default).toBe('gpt-4o');
        expect((config.model as Record<string, unknown>).temperature).toBe(0.5);
        expect((config.network as Record<string, unknown>).mode).toBe('off');
        expect((config.network as Record<string, unknown>).allowHttp).toBe(true);
        expect((config.network as Record<string, unknown>).allowDomains).toEqual(['github.com', 'npmjs.com']);
        expect((config.limits as Record<string, unknown>).maxStepsPerTurn).toBe(10);
        expect(usedVars).toContain('ACA_MODEL_DEFAULT');
        expect(usedVars).not.toContain('UNRELATED_VAR');
    });

    it('unset env vars treated as absent', () => {
        const { config, usedVars } = parseEnvVars({
            ACA_MODEL_DEFAULT: undefined,
            ACA_MODEL_TEMPERATURE: '',
        });

        expect(config.model).toBeUndefined();
        expect(usedVars).toEqual([]);
    });

    it('boolean env vars accept true/false/1/0', () => {
        expect(parseEnvVars({ ACA_NETWORK_ALLOW_HTTP: 'true' }).config.network).toEqual({ allowHttp: true });
        expect(parseEnvVars({ ACA_NETWORK_ALLOW_HTTP: '1' }).config.network).toEqual({ allowHttp: true });
        expect(parseEnvVars({ ACA_NETWORK_ALLOW_HTTP: 'false' }).config.network).toEqual({ allowHttp: false });
        expect(parseEnvVars({ ACA_NETWORK_ALLOW_HTTP: '0' }).config.network).toEqual({ allowHttp: false });
    });

    it('invalid number env var is ignored', () => {
        const { config } = parseEnvVars({ ACA_MODEL_TEMPERATURE: 'not-a-number' });
        expect(config.model).toBeUndefined();
    });
});

// ==========================================
// Secrets
// ==========================================

describe('Secrets Loading', () => {
    it('missing secrets file → not an error', async () => {
        const result = await loadSecrets(
            {},
            join(testDir, 'nonexistent', 'secrets.json'),
            join(testDir, 'nonexistent', 'api_keys'),
        );

        expect(result.warnings).toEqual([]);
        expect(Object.keys(result.secrets)).toEqual([]);
    });

    it('env var secrets loaded', async () => {
        const result = await loadSecrets({
            NANOGPT_API_KEY: 'key-123',
            ANTHROPIC_API_KEY: 'ant-456',
        });

        expect(result.secrets.nanogpt).toBe('key-123');
        expect(result.secrets.anthropic).toBe('ant-456');
    });

    it('secrets.json loaded when permissions are 0600', async () => {
        const secretsDir = join(testDir, 'good-secrets');
        await mkdir(secretsDir, { recursive: true });
        const secretsPath = join(secretsDir, 'secrets.json');
        await writeFile(secretsPath, JSON.stringify({ nanogpt: 'file-key' }));
        await chmod(secretsPath, 0o600);

        const result = await loadSecrets(
            {},
            secretsPath,
            join(secretsDir, 'nonexistent-api-keys'),
        );

        expect(result.secrets.nanogpt).toBe('file-key');
        expect(result.warnings).toEqual([]);
    });

    it('secrets.json with wrong permissions → refuse to load', async () => {
        const secretsDir = join(testDir, 'bad-secrets');
        await mkdir(secretsDir, { recursive: true });
        const secretsPath = join(secretsDir, 'secrets.json');
        await writeFile(secretsPath, JSON.stringify({ nanogpt: 'file-key' }));
        await chmod(secretsPath, 0o644);

        const result = await loadSecrets(
            {},
            secretsPath,
            join(secretsDir, 'nonexistent-api-keys'),
        );

        expect(result.secrets.nanogpt).toBeUndefined();
        expect(result.warnings.some(w => w.includes('permissions') && w.includes('0600'))).toBe(true);
    });

    it('bad-permission secrets.json still falls back to api_keys', async () => {
        const secretsDir = join(testDir, 'bad-secrets-with-api-keys');
        await mkdir(secretsDir, { recursive: true });
        const secretsPath = join(secretsDir, 'secrets.json');
        const apiKeysPath = join(secretsDir, '.api_keys');
        await writeFile(secretsPath, JSON.stringify({ nanogpt: 'file-key' }));
        await chmod(secretsPath, 0o644);
        await writeFile(apiKeysPath, 'export NANOGPT_API_KEY="fallback-key"\n');

        const result = await loadSecrets({}, secretsPath, apiKeysPath);

        expect(result.secrets.nanogpt).toBe('fallback-key');
        expect(result.warnings.some(w => w.includes('permissions') && w.includes('0600'))).toBe(true);
    });

    it('env var takes priority over secrets.json', async () => {
        const secretsDir = join(testDir, 'priority-secrets');
        await mkdir(secretsDir, { recursive: true });
        const secretsPath = join(secretsDir, 'secrets.json');
        await writeFile(secretsPath, JSON.stringify({ nanogpt: 'file-key', openai: 'file-openai' }));
        await chmod(secretsPath, 0o600);

        const result = await loadSecrets(
            { NANOGPT_API_KEY: 'env-key' },
            secretsPath,
        );

        expect(result.secrets.nanogpt).toBe('env-key'); // env wins
        expect(result.secrets.openai).toBe('file-openai'); // file fills gap
    });
});

// ==========================================
// Frozen Config
// ==========================================

describe('Frozen Config', () => {
    it('attempt to mutate → TypeError', async () => {
        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: join(testDir, 'none', 'config.json'),
            projectConfigPath: join(testDir, 'none2', 'config.json'),
            env: {},
        });

        const config = result.config as ResolvedConfig;

        expect(() => {
            (config as { model: { default: string } }).model.default = 'hacked';
        }).toThrow(TypeError);

        expect(() => {
            (config as { defaultProvider: string }).defaultProvider = 'hacked';
        }).toThrow(TypeError);

        expect(() => {
            (config.permissions.blockedTools as string[]).push('hacked');
        }).toThrow(TypeError);
    });

    it('deepFreeze freezes nested objects', () => {
        const obj = { a: { b: { c: 1 } }, d: [1, 2, 3] };
        const frozen = deepFreeze(obj);

        expect(Object.isFrozen(frozen)).toBe(true);
        expect(Object.isFrozen(frozen.a)).toBe(true);
        expect(Object.isFrozen(frozen.a.b)).toBe(true);
        expect(Object.isFrozen(frozen.d)).toBe(true);
    });
});

// ==========================================
// Config Drift Detection
// ==========================================

describe('Config Drift Detection', () => {
    it('detects security-relevant changes', () => {
        const current = structuredClone(CONFIG_DEFAULTS);
        current.network.mode = 'open';
        current.permissions.nonInteractive = true;

        const snapshot = structuredClone(CONFIG_DEFAULTS) as unknown as Record<string, unknown>;

        const drifts = detectConfigDrift(current, snapshot);

        expect(drifts.length).toBeGreaterThanOrEqual(2);
        const securityDrifts = drifts.filter(d => d.securityRelevant);
        expect(securityDrifts.some(d => d.field === 'network.mode')).toBe(true);
        expect(securityDrifts.some(d => d.field === 'permissions.nonInteractive')).toBe(true);
    });

    it('detects non-security changes', () => {
        const current = structuredClone(CONFIG_DEFAULTS);
        current.model.default = 'new-model';

        const snapshot = structuredClone(CONFIG_DEFAULTS) as unknown as Record<string, unknown>;

        const drifts = detectConfigDrift(current, snapshot);

        const modelDrift = drifts.find(d => d.field === 'model.default');
        expect(modelDrift).toBeDefined();
        expect(modelDrift!.securityRelevant).toBe(false);
        expect(modelDrift!.previous).toBe(CONFIG_DEFAULTS.model.default);
        expect(modelDrift!.current).toBe('new-model');
    });

    it('no drift when configs match', () => {
        const current = structuredClone(CONFIG_DEFAULTS);
        const snapshot = structuredClone(CONFIG_DEFAULTS) as unknown as Record<string, unknown>;

        const drifts = detectConfigDrift(current, snapshot);
        expect(drifts).toEqual([]);
    });
});

// ==========================================
// Malformed project config validation
// ==========================================

describe('Malformed project config', () => {
    it('project config with invalid type → warning, ignored entirely', async () => {
        const userPath = await setupUserConfig({ model: { default: 'user-model' } });
        const projPath = await setupProjectConfig({
            model: { temperature: 'not-a-number' },
        });

        const result = await loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: userPath,
            projectConfigPath: projPath,
            env: {},
        });

        expect(result.config.model.default).toBe('user-model');
        expect(result.config.model.temperature).toBe(CONFIG_DEFAULTS.model.temperature);
        expect(result.warnings.some(w => w.includes('malformed'))).toBe(true);
        expect(result.sources.project).toBe(false);
    });
});

// ==========================================
// Final validation failure (fail closed)
// ==========================================

describe('Final Validation', () => {
    it('CLI flags with invalid types → throws', async () => {
        await expect(loadConfig({
            workspaceRoot: workspaceDir,
            userConfigPath: join(testDir, 'none', 'config.json'),
            projectConfigPath: join(testDir, 'none2', 'config.json'),
            env: {},
            cliFlags: { model: { temperature: 'invalid-string' as unknown as number } },
        })).rejects.toThrow(/Configuration validation failed/);
    });
});
