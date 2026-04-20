#!/usr/bin/env node

import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSecrets } from '../src/config/secrets.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_INDEX = join(ROOT, 'dist', 'index.js');
const DEFAULT_MODELS = [
    'zai-org/glm-5',
    'zai-org/glm-4.7',
    'qwen/qwen3-coder-next',
    'moonshotai/kimi-k2.5',
];
const DEFAULT_ALLOWED_TOOLS = [
    'read_file',
    'write_file',
    'edit_file',
    'find_paths',
    'search_text',
    'stat_path',
    'exec_command',
];
const DEFAULT_OUT_DIR = `/tmp/aca-live-workflow-bakeoff-${Date.now()}`;

interface FixtureTask {
    id: string;
    prompt: string;
    files: Record<string, string>;
}

interface BakeoffCase {
    model: string;
    task: FixtureTask;
}

interface ParsedArgs {
    models: string[];
    suite: 'basic' | 'aca-native' | 'aca-hard' | 'all';
    outDir: string;
    concurrency: number;
}

interface InvokeResponse {
    status: 'success' | 'error';
    result?: string;
    errors?: Array<{ code: string; message: string; retryable: boolean }>;
    safety?: {
        accepted_tool_calls?: number;
        rejected_tool_calls?: number;
    };
}

interface CaseResult {
    model: string;
    taskId: string;
    success: boolean;
    testsPassed: boolean;
    changedTests: boolean;
    acceptedToolCalls: number | null;
    rejectedToolCalls: number | null;
    elapsedMs: number;
    invokeExitCode: number;
    validationExitCode: number;
    parseError: string | null;
    result: string;
    errorCodes: string[];
    changedFiles: string[];
    diffStat: string;
    diffPatch: string;
    stderr: string;
    validationStderr: string;
    overallPass: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
    const options: ParsedArgs = {
        models: [...DEFAULT_MODELS],
        suite: 'aca-native',
        outDir: DEFAULT_OUT_DIR,
        concurrency: 3,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--models') {
            options.models = String(argv[index + 1] ?? '')
                .split(',')
                .map(item => item.trim())
                .filter(Boolean);
            index += 1;
        } else if (arg === '--suite') {
            const value = argv[index + 1];
            if (value === 'basic' || value === 'aca-native' || value === 'aca-hard' || value === 'all') {
                options.suite = value;
            }
            index += 1;
        } else if (arg === '--out-dir') {
            options.outDir = resolve(argv[index + 1] ?? options.outDir);
            index += 1;
        } else if (arg === '--concurrency') {
            const parsed = Number.parseInt(argv[index + 1] ?? '3', 10);
            if (Number.isFinite(parsed)) {
                options.concurrency = Math.max(1, Math.min(3, parsed));
            }
            index += 1;
        } else if (arg === '--help') {
            process.stdout.write(`Usage: node --import tsx scripts/live-workflow-bakeoff.ts [options]

Options:
  --models <list>       Comma-separated model IDs
  --suite <name>        basic | aca-native | aca-hard | all (default: aca-native)
  --out-dir <path>      Output directory for JSON results
  --concurrency <n>     Parallel invoke slots (default: 3, max: 3)
`);
            process.exit(0);
        }
    }

    return options;
}

function basicTasks(): FixtureTask[] {
    return [
        {
            id: 'resume-workspace-fix',
            prompt: [
                'Fix the bug in this small Node project so resumed sessions use the stored workspace root instead of the launch directory.',
                'Keep the patch minimal.',
                'Do not modify the tests.',
                'Run `node --test` before finishing.',
                'Reply with a short summary of what you changed.',
            ].join(' '),
            files: {
                'package.json': JSON.stringify({
                    name: 'resume-workspace-fixture',
                    type: 'module',
                    private: true,
                    scripts: { test: 'node --test' },
                }, null, 2) + '\n',
                'src/runtime.js': `export function resolveRuntimeWorkspaceRoot({ launchWorkspaceRoot, wantsResume, resumeManifest }) {
    const storedWorkspaceRoot = resumeManifest?.workspaceRoot;
    if (!wantsResume) {
        return launchWorkspaceRoot;
    }

    // BUG: this ignores the resumed session workspace.
    return launchWorkspaceRoot;
}
`,
                'test/runtime.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntimeWorkspaceRoot } from '../src/runtime.js';

test('uses stored workspace root when resuming a specific session', () => {
    const workspaceRoot = resolveRuntimeWorkspaceRoot({
        launchWorkspaceRoot: '/launch/dir',
        wantsResume: true,
        resumeManifest: { workspaceRoot: '/stored/workspace' },
    });

    assert.equal(workspaceRoot, '/stored/workspace');
});

test('falls back to launch workspace when not resuming', () => {
    const workspaceRoot = resolveRuntimeWorkspaceRoot({
        launchWorkspaceRoot: '/launch/dir',
        wantsResume: false,
        resumeManifest: { workspaceRoot: '/stored/workspace' },
    });

    assert.equal(workspaceRoot, '/launch/dir');
});

test('falls back to launch workspace if no stored workspace is available', () => {
    const workspaceRoot = resolveRuntimeWorkspaceRoot({
        launchWorkspaceRoot: '/launch/dir',
        wantsResume: true,
        resumeManifest: {},
    });

    assert.equal(workspaceRoot, '/launch/dir');
});
`,
            },
        },
        {
            id: 'optional-capability-fix',
            prompt: [
                'Fix the optional capability loading bug in this small Node project.',
                'Core startup must work when the optional fetch_url stack is broken, but enabling fetch_url should still surface a clear error.',
                'Keep the patch minimal.',
                'Do not modify the tests.',
                'Run `node --test` before finishing.',
                'Reply with a short summary of what you changed.',
            ].join(' '),
            files: {
                'package.json': JSON.stringify({
                    name: 'optional-capability-fixture',
                    type: 'module',
                    private: true,
                    scripts: { test: 'node --test' },
                }, null, 2) + '\n',
                'src/runtime.js': `import { coreTools } from './tools/core.js';
import { createFetchUrlTool } from './tools/fetch-url.js';

export async function buildToolRegistry({ enableFetchUrl = false } = {}) {
    const registry = [...coreTools];
    if (enableFetchUrl) {
        registry.push(createFetchUrlTool());
    }
    return registry;
}
`,
                'src/tools/core.js': `export const coreTools = [{ name: 'read_file' }, { name: 'search_text' }];
`,
                'src/tools/fetch-url.js': `import './optional-dep.js';

export function createFetchUrlTool() {
    return { name: 'fetch_url' };
}
`,
                'src/tools/optional-dep.js': `throw new Error('jsdom unavailable');
`,
                'test/runtime.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';

test('core tool registry loads without optional fetch_url stack', async () => {
    const { buildToolRegistry } = await import('../src/runtime.js');
    const tools = await buildToolRegistry({ enableFetchUrl: false });
    assert.deepEqual(tools.map(tool => tool.name), ['read_file', 'search_text']);
});

test('enabling fetch_url still surfaces a clear error when optional dependency is broken', async () => {
    const { buildToolRegistry } = await import('../src/runtime.js');
    await assert.rejects(
        () => buildToolRegistry({ enableFetchUrl: true }),
        /fetch_url|jsdom unavailable/i,
    );
});
`,
            },
        },
        {
            id: 'resume-handle-fix',
            prompt: [
                'Fix the resumed handle behavior in this small Node project.',
                'Historical handles that existed before a restart should report a session-exited style error instead of a generic not-found error.',
                'Keep the patch minimal.',
                'Do not modify the tests.',
                'Run `node --test` before finishing.',
                'Reply with a short summary of what you changed.',
            ].join(' '),
            files: {
                'package.json': JSON.stringify({
                    name: 'resume-handle-fixture',
                    type: 'module',
                    private: true,
                    scripts: { test: 'node --test' },
                }, null, 2) + '\n',
                'src/session-io.js': `export function restoreHistoricalHandles(events = []) {
    return new Set(
        events
            .filter(event => event.type === 'open_handle')
            .map(event => event.handleId),
    );
}

export function readFromSession({ registry, handleId, historicalHandles = new Set() }) {
    const handle = registry.get(handleId);
    if (!handle) {
        return {
            status: 'error',
            error: {
                code: 'tool.not_found',
                message: 'Handle not found',
            },
        };
    }

    if (handle.status === 'exited') {
        return {
            status: 'error',
            error: {
                code: 'tool.session_exited',
                message: 'Session exited',
            },
        };
    }

    return {
        status: 'success',
        data: handle.buffer ?? '',
    };
}
`,
                'test/session-io.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFromSession, restoreHistoricalHandles } from '../src/session-io.js';

test('active handle returns buffered data', () => {
    const registry = new Map([['h1', { status: 'running', buffer: 'hello' }]]);
    const result = readFromSession({ registry, handleId: 'h1' });
    assert.equal(result.status, 'success');
    assert.equal(result.data, 'hello');
});

test('exited live handle returns tool.session_exited', () => {
    const registry = new Map([['h1', { status: 'exited' }]]);
    const result = readFromSession({ registry, handleId: 'h1' });
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'tool.session_exited');
});

test('unknown handle still returns tool.not_found', () => {
    const result = readFromSession({ registry: new Map(), handleId: 'missing' });
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'tool.not_found');
});

test('historical handle missing after resume returns tool.session_exited', () => {
    const historicalHandles = restoreHistoricalHandles([{ type: 'open_handle', handleId: 'h1' }]);
    const result = readFromSession({ registry: new Map(), handleId: 'h1', historicalHandles });
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'tool.session_exited');
    assert.match(result.error.message, /resume|terminated|exited/i);
});
`,
            },
        },
    ];
}

function acaNativeTasks(): FixtureTask[] {
    return [
        {
            id: 'resume-config-drift',
            prompt: [
                'Fix the resume config-drift warning behavior in this small Node project.',
                'If the saved session snapshot contains a drift baseline, resuming should warn about changed security-relevant fields.',
                'Legacy snapshots without a baseline should stay quiet.',
                'Keep the patch minimal, do not modify the tests, run `node --test`, and reply with a short summary.',
            ].join(' '),
            files: {
                'package.json': JSON.stringify({
                    name: 'resume-config-drift-fixture',
                    type: 'module',
                    private: true,
                    scripts: { test: 'node --test' },
                }, null, 2) + '\n',
                'src/loader.js': `function getNested(obj, path) {
    let current = obj;
    for (const key of path) {
        if (typeof current !== 'object' || current === null) return undefined;
        current = current[key];
    }
    return current;
}

export function detectConfigDrift(current, snapshot) {
    const fields = ['permissions.nonInteractive', 'network.mode'];
    const drifts = [];
    for (const field of fields) {
        const currentValue = getNested(current, field.split('.'));
        const previousValue = getNested(snapshot, field.split('.'));
        if (JSON.stringify(currentValue) !== JSON.stringify(previousValue)) {
            drifts.push({
                field,
                previous: previousValue,
                current: currentValue,
                securityRelevant: true,
            });
        }
    }
    return drifts;
}
`,
                'src/session-snapshot.js': `const DRIFT_BASELINE_KEYS = ['permissions', 'network', 'scrubbing'];

export function hasConfigDriftBaseline(snapshot) {
    return DRIFT_BASELINE_KEYS.some((key) => typeof snapshot[key] === 'object' && snapshot[key] !== null);
}
`,
                'src/runtime.js': `import { detectConfigDrift } from './loader.js';
import { hasConfigDriftBaseline } from './session-snapshot.js';

export function resumeSession({ currentConfig, manifest }) {
    const warnings = [];
    return {
        sessionId: manifest.sessionId,
        warnings,
    };
}
`,
                'test/runtime.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeSession } from '../src/runtime.js';

test('warns on security-relevant drift when a baseline snapshot exists', () => {
    const resumed = resumeSession({
        currentConfig: {
            permissions: { nonInteractive: true },
            network: { mode: 'open' },
        },
        manifest: {
            sessionId: 'ses_123',
            configSnapshot: {
                permissions: { nonInteractive: false },
                network: { mode: 'approved-only' },
                scrubbing: { enabled: true },
            },
        },
    });

    assert.equal(resumed.sessionId, 'ses_123');
    assert.equal(resumed.warnings.length, 2);
    assert.match(resumed.warnings[0], /permissions\\.nonInteractive/);
    assert.match(resumed.warnings[1], /network\\.mode/);
});

test('does not warn for legacy snapshots without a drift baseline', () => {
    const resumed = resumeSession({
        currentConfig: {
            permissions: { nonInteractive: true },
            network: { mode: 'open' },
        },
        manifest: {
            sessionId: 'ses_legacy',
            configSnapshot: {
                model: 'legacy-only',
                workspaceRoot: '/repo',
            },
        },
    });

    assert.deepEqual(resumed.warnings, []);
});
`,
            },
        },
        {
            id: 'invoke-child-snapshot',
            prompt: [
                'Fix the invoke child-session snapshot behavior in this small Node project.',
                'Child sessions spawned from invoke should capture the hardened config snapshot baseline when resolved config and provider name are available.',
                'Keep the patch minimal, do not modify the tests, run `node --test`, and reply with a short summary.',
            ].join(' '),
            files: {
                'package.json': JSON.stringify({
                    name: 'invoke-child-snapshot-fixture',
                    type: 'module',
                    private: true,
                    scripts: { test: 'node --test' },
                }, null, 2) + '\n',
                'src/session-manager.js': `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let counter = 0;

export class SessionManager {
    constructor(sessionsDir) {
        this.sessionsDir = sessionsDir;
    }

    create(workspaceRoot, configSnapshot = {}, lineage = {}) {
        counter += 1;
        const sessionId = 'ses_' + String(counter).padStart(6, '0');
        const sessionDir = join(this.sessionsDir, sessionId);
        mkdirSync(sessionDir, { recursive: true });
        const manifest = {
            sessionId,
            ...lineage,
            configSnapshot: {
                ...configSnapshot,
                workspaceRoot,
            },
        };
        writeFileSync(join(sessionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        return manifest;
    }

    readManifest(sessionId) {
        return JSON.parse(readFileSync(join(this.sessionsDir, sessionId, 'manifest.json'), 'utf8'));
    }
}
`,
                'src/session-snapshot.js': `export function buildSessionConfigSnapshot(config, { workspaceRoot, model, provider, mode }) {
    return {
        ...structuredClone(config),
        workspaceRoot,
        mode,
        defaultProvider: provider,
        model: {
            ...config.model,
            default: model,
        },
    };
}
`,
                'src/invoke-tooling.js': `export function registerInvokeRuntimeTools({
    cwd,
    model,
    sessionManager,
    parentSessionId,
    rootSessionId,
    resolvedConfig,
    providerName,
}) {
    return {
        createChildSession() {
            return sessionManager.create(
                cwd,
                {
                    model,
                    mode: 'sub-agent',
                },
                {
                    parentSessionId,
                    rootSessionId,
                },
            );
        },
    };
}
`,
                'test/invoke-tooling.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerInvokeRuntimeTools } from '../src/invoke-tooling.js';
import { SessionManager } from '../src/session-manager.js';

test('child sessions capture the hardened snapshot baseline when config is available', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'invoke-child-snapshot-'));
    const manager = new SessionManager(sessionsDir);

    try {
        const runtime = registerInvokeRuntimeTools({
            cwd: '/repo',
            model: 'zai-org/glm-5',
            sessionManager: manager,
            parentSessionId: 'ses_parent',
            rootSessionId: 'ses_root',
            providerName: 'nanogpt',
            resolvedConfig: {
                model: { default: 'placeholder' },
                permissions: { nonInteractive: false },
                network: { mode: 'approved-only' },
                scrubbing: { enabled: true },
            },
        });

        const child = runtime.createChildSession();
        const manifest = manager.readManifest(child.sessionId);

        assert.equal(manifest.parentSessionId, 'ses_parent');
        assert.equal(manifest.rootSessionId, 'ses_root');
        assert.equal(manifest.configSnapshot.defaultProvider, 'nanogpt');
        assert.deepEqual(manifest.configSnapshot.permissions, { nonInteractive: false });
        assert.deepEqual(manifest.configSnapshot.network, { mode: 'approved-only' });
        assert.deepEqual(manifest.configSnapshot.scrubbing, { enabled: true });
        assert.equal(manifest.configSnapshot.model.default, 'zai-org/glm-5');
    } finally {
        rmSync(sessionsDir, { recursive: true, force: true });
    }
});

test('falls back to a minimal snapshot when resolved config is unavailable', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'invoke-child-snapshot-'));
    const manager = new SessionManager(sessionsDir);

    try {
        const runtime = registerInvokeRuntimeTools({
            cwd: '/repo',
            model: 'zai-org/glm-5',
            sessionManager: manager,
            parentSessionId: 'ses_parent',
            rootSessionId: 'ses_root',
        });

        const child = runtime.createChildSession();
        const manifest = manager.readManifest(child.sessionId);
        assert.equal(manifest.configSnapshot.model, 'zai-org/glm-5');
        assert.equal(manifest.configSnapshot.mode, 'sub-agent');
        assert.equal(manifest.configSnapshot.workspaceRoot, '/repo');
    } finally {
        rmSync(sessionsDir, { recursive: true, force: true });
    }
});
`,
            },
        },
        {
            id: 'scope-aware-narrowing',
            prompt: [
                'Fix the delegation narrowing logic in this small Node project.',
                'A permanent parent rule should cover a session-scoped child rule, but a session-scoped parent must not cover a permanent child rule.',
                'Keep the patch minimal, do not modify the tests, run `node --test`, and reply with a short summary.',
            ].join(' '),
            files: {
                'package.json': JSON.stringify({
                    name: 'scope-aware-narrowing-fixture',
                    type: 'module',
                    private: true,
                    scripts: { test: 'node --test' },
                }, null, 2) + '\n',
                'src/spawn-agent.js': `function matchFieldsEqual(parentMatch, childMatch) {
    const parentKeys = Object.keys(parentMatch).sort();
    const childKeys = Object.keys(childMatch).sort();
    if (parentKeys.length !== childKeys.length) return false;
    for (let index = 0; index < parentKeys.length; index += 1) {
        if (parentKeys[index] !== childKeys[index]) return false;
        if (parentMatch[parentKeys[index]] !== childMatch[childKeys[index]]) return false;
    }
    return true;
}

function isRuleCoveredByParent(child, parentRules) {
    return parentRules.some(parent =>
        parent.tool === child.tool
        && parent.decision === child.decision
        && matchFieldsEqual(parent.match, child.match),
    );
}

export function validatePreauthNarrowing(parentRules, childRules) {
    return childRules.filter(rule => !isRuleCoveredByParent(rule, parentRules));
}

export function validateAuthorityNarrowing(parentRules, childRules) {
    return childRules.filter(rule => !isRuleCoveredByParent(rule, parentRules));
}
`,
                'test/spawn-agent.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthorityNarrowing, validatePreauthNarrowing } from '../src/spawn-agent.js';

test('permanent parent preauth covers session child rule', () => {
    const rejected = validatePreauthNarrowing(
        [{ tool: 'exec_command', decision: 'allow', scope: 'permanent', match: {} }],
        [{ tool: 'exec_command', decision: 'allow', scope: 'session', match: {} }],
    );
    assert.deepEqual(rejected, []);
});

test('session parent authority does not cover permanent child rule', () => {
    const rejected = validateAuthorityNarrowing(
        [{ tool: 'exec_command', decision: 'allow', scope: 'session', match: {} }],
        [{ tool: 'exec_command', decision: 'allow', scope: 'permanent', match: {} }],
    );
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].scope, 'permanent');
});

test('different match fields are still rejected', () => {
    const rejected = validateAuthorityNarrowing(
        [{ tool: 'exec_command', decision: 'allow', scope: 'permanent', match: { commandRegex: '^npm test$' } }],
        [{ tool: 'exec_command', decision: 'allow', scope: 'session', match: { commandRegex: '^npm run lint$' } }],
    );
    assert.equal(rejected.length, 1);
});
`,
            },
        },
    ];
}

function acaHardTasks(): FixtureTask[] {
    return [
        {
            id: 'resume-startup-hard',
            prompt: [
                'Fix the resume startup bug in this small Node project.',
                'When resuming a specific session or the latest session for a workspace, runtime config must be rebuilt from the stored workspace root, not the launch directory.',
                'If the resumed snapshot contains a drift baseline, emit warnings for security-relevant drift fields; legacy snapshots should stay quiet.',
                'Keep the patch minimal, do not modify the tests, run `node --test`, and reply with a short summary.',
            ].join(' '),
            files: {
                'package.json': JSON.stringify({
                    name: 'resume-startup-hard-fixture',
                    type: 'module',
                    private: true,
                    scripts: { test: 'node --test' },
                }, null, 2) + '\n',
                'src/session-manager.js': `export class SessionManager {
    constructor(manifests) {
        this.manifests = manifests;
    }

    findLatestForWorkspace(launchWorkspaceRoot) {
        const matches = this.manifests
            .filter((manifest) => manifest.launchWorkspaceRoot === launchWorkspaceRoot)
            .sort((left, right) => right.lastActivity.localeCompare(left.lastActivity));
        return matches[0]?.sessionId ?? null;
    }

    readManifest(sessionId) {
        return this.manifests.find((manifest) => manifest.sessionId === sessionId) ?? null;
    }
}
`,
                'src/config-loader.js': `export function loadConfig(workspaceRoot) {
    return {
        workspaceRoot,
        policyTag: workspaceRoot.includes('stored') ? 'stored-policy' : 'launch-policy',
        permissions: {
            nonInteractive: workspaceRoot.includes('stored'),
        },
        network: {
            mode: workspaceRoot.includes('stored') ? 'approved-only' : 'open',
        },
    };
}

function getNested(obj, path) {
    let current = obj;
    for (const key of path) {
        if (typeof current !== 'object' || current === null) return undefined;
        current = current[key];
    }
    return current;
}

export function detectConfigDrift(current, snapshot) {
    const fields = ['permissions.nonInteractive', 'network.mode'];
    return fields.flatMap((field) => {
        const currentValue = getNested(current, field.split('.'));
        const previousValue = getNested(snapshot, field.split('.'));
        if (JSON.stringify(currentValue) === JSON.stringify(previousValue)) {
            return [];
        }
        return [{
            field,
            previous: previousValue,
            current: currentValue,
            securityRelevant: true,
        }];
    });
}
`,
                'src/session-snapshot.js': `const DRIFT_BASELINE_KEYS = ['permissions', 'network', 'scrubbing'];

export function hasConfigDriftBaseline(snapshot) {
    return DRIFT_BASELINE_KEYS.some((key) => typeof snapshot?.[key] === 'object' && snapshot[key] !== null);
}
`,
                'src/runtime.js': `import { loadConfig, detectConfigDrift } from './config-loader.js';
import { hasConfigDriftBaseline } from './session-snapshot.js';

export function createRuntime({
    launchWorkspaceRoot,
    wantsResume,
    explicitSessionId,
    sessionManager,
}) {
    const config = loadConfig(launchWorkspaceRoot);
    const sessionId = wantsResume
        ? explicitSessionId ?? sessionManager.findLatestForWorkspace(launchWorkspaceRoot)
        : null;
    const manifest = sessionId ? sessionManager.readManifest(sessionId) : null;
    const warnings = [];

    return {
        sessionId,
        workspaceRoot: config.workspaceRoot,
        policyTag: config.policyTag,
        warnings,
        manifest,
    };
}
`,
                'test/runtime.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/session-manager.js';
import { createRuntime } from '../src/runtime.js';

const manifests = [
    {
        sessionId: 'ses_old',
        launchWorkspaceRoot: '/launch/workspace',
        lastActivity: '2026-04-18T00:00:00.000Z',
        configSnapshot: {
            workspaceRoot: '/stored/workspace-a',
            permissions: { nonInteractive: false },
            network: { mode: 'open' },
            scrubbing: { enabled: true },
        },
    },
    {
        sessionId: 'ses_new',
        launchWorkspaceRoot: '/launch/workspace',
        lastActivity: '2026-04-19T00:00:00.000Z',
        configSnapshot: {
            workspaceRoot: '/stored/workspace-b',
            permissions: { nonInteractive: false },
            network: { mode: 'open' },
            scrubbing: { enabled: true },
        },
    },
    {
        sessionId: 'ses_legacy',
        launchWorkspaceRoot: '/launch/workspace',
        lastActivity: '2026-04-17T00:00:00.000Z',
        configSnapshot: {
            workspaceRoot: '/stored/workspace-legacy',
            model: 'legacy-only',
        },
    },
];

test('specific-session resume rebuilds runtime from the stored workspace root and warns on drift', () => {
    const runtime = createRuntime({
        launchWorkspaceRoot: '/launch/workspace',
        wantsResume: true,
        explicitSessionId: 'ses_old',
        sessionManager: new SessionManager(manifests),
    });

    assert.equal(runtime.sessionId, 'ses_old');
    assert.equal(runtime.workspaceRoot, '/stored/workspace-a');
    assert.equal(runtime.policyTag, 'stored-policy');
    assert.equal(runtime.warnings.length, 2);
    assert.match(runtime.warnings[0], /permissions\\.nonInteractive/);
    assert.match(runtime.warnings[1], /network\\.mode/);
});

test('latest-session resume uses the latest stored workspace root', () => {
    const runtime = createRuntime({
        launchWorkspaceRoot: '/launch/workspace',
        wantsResume: true,
        sessionManager: new SessionManager(manifests),
    });

    assert.equal(runtime.sessionId, 'ses_new');
    assert.equal(runtime.workspaceRoot, '/stored/workspace-b');
    assert.equal(runtime.policyTag, 'stored-policy');
});

test('legacy snapshots without a drift baseline stay quiet', () => {
    const runtime = createRuntime({
        launchWorkspaceRoot: '/launch/workspace',
        wantsResume: true,
        explicitSessionId: 'ses_legacy',
        sessionManager: new SessionManager(manifests),
    });

    assert.equal(runtime.workspaceRoot, '/stored/workspace-legacy');
    assert.deepEqual(runtime.warnings, []);
});
`,
            },
        },
        {
            id: 'invoke-runtime-hard',
            prompt: [
                'Fix the invoke runtime bug in this small Node project.',
                'Importing the invoke runtime must not fail when optional fetch_url dependencies are broken unless fetch_url is actually enabled.',
                'Child sessions created from invoke must capture the hardened config snapshot baseline when resolved config and provider name are available.',
                'Keep the patch minimal, do not modify the tests, run `node --test`, and reply with a short summary.',
            ].join(' '),
            files: {
                'package.json': JSON.stringify({
                    name: 'invoke-runtime-hard-fixture',
                    type: 'module',
                    private: true,
                    scripts: { test: 'node --test' },
                }, null, 2) + '\n',
                'src/session-manager.js': `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let counter = 0;

export class SessionManager {
    constructor(sessionsDir) {
        this.sessionsDir = sessionsDir;
    }

    create(workspaceRoot, configSnapshot = {}, lineage = {}) {
        counter += 1;
        const sessionId = 'ses_' + String(counter).padStart(6, '0');
        const sessionDir = join(this.sessionsDir, sessionId);
        mkdirSync(sessionDir, { recursive: true });
        const manifest = {
            sessionId,
            ...lineage,
            configSnapshot: {
                ...configSnapshot,
                workspaceRoot,
            },
        };
        writeFileSync(join(sessionDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        return manifest;
    }

    readManifest(sessionId) {
        return JSON.parse(readFileSync(join(this.sessionsDir, sessionId, 'manifest.json'), 'utf8'));
    }
}
`,
                'src/session-snapshot.js': `export function buildSessionConfigSnapshot(config, { workspaceRoot, model, provider, mode }) {
    return {
        ...structuredClone(config),
        workspaceRoot,
        mode,
        defaultProvider: provider,
        model: {
            ...config.model,
            default: model,
        },
    };
}
`,
                'src/tools/fetch-url.js': `import './optional-dep.js';

export function createFetchUrlTool() {
    return { name: 'fetch_url' };
}
`,
                'src/tools/optional-dep.js': `throw new Error('jsdom unavailable');
`,
                'src/invoke-runtime.js': `import { createFetchUrlTool } from './tools/fetch-url.js';

export async function registerInvokeRuntime({
    enableFetchUrl = false,
    cwd,
    model,
    sessionManager,
    parentSessionId,
    rootSessionId,
    resolvedConfig,
    providerName,
}) {
    const tools = ['read_file', 'search_text'];
    if (enableFetchUrl) {
        tools.push(createFetchUrlTool().name);
    }

    return {
        tools,
        createChildSession() {
            return sessionManager.create(
                cwd,
                {
                    model,
                    mode: 'sub-agent',
                },
                {
                    parentSessionId,
                    rootSessionId,
                },
            );
        },
    };
}
`,
                'test/invoke-runtime.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../src/session-manager.js';

test('importing the runtime succeeds when fetch_url is not enabled', async () => {
    const { registerInvokeRuntime } = await import('../src/invoke-runtime.js');
    const sessionsDir = mkdtempSync(join(tmpdir(), 'invoke-runtime-hard-'));
    const manager = new SessionManager(sessionsDir);

    try {
        const runtime = await registerInvokeRuntime({
            enableFetchUrl: false,
            cwd: '/repo',
            model: 'zai-org/glm-4.7',
            sessionManager: manager,
        });
        assert.deepEqual(runtime.tools, ['read_file', 'search_text']);
    } finally {
        rmSync(sessionsDir, { recursive: true, force: true });
    }
});

test('enabling fetch_url still surfaces the broken optional dependency', async () => {
    const { registerInvokeRuntime } = await import('../src/invoke-runtime.js');
    const sessionsDir = mkdtempSync(join(tmpdir(), 'invoke-runtime-hard-'));
    const manager = new SessionManager(sessionsDir);

    try {
        await assert.rejects(
            () => registerInvokeRuntime({
                enableFetchUrl: true,
                cwd: '/repo',
                model: 'zai-org/glm-4.7',
                sessionManager: manager,
            }),
            /fetch_url|jsdom unavailable/i,
        );
    } finally {
        rmSync(sessionsDir, { recursive: true, force: true });
    }
});

test('child sessions capture the hardened config baseline when config is available', async () => {
    const { registerInvokeRuntime } = await import('../src/invoke-runtime.js');
    const sessionsDir = mkdtempSync(join(tmpdir(), 'invoke-runtime-hard-'));
    const manager = new SessionManager(sessionsDir);

    try {
        const runtime = await registerInvokeRuntime({
            cwd: '/repo',
            model: 'zai-org/glm-4.7',
            sessionManager: manager,
            parentSessionId: 'ses_parent',
            rootSessionId: 'ses_root',
            providerName: 'nanogpt',
            resolvedConfig: {
                model: { default: 'placeholder' },
                permissions: { nonInteractive: false },
                network: { mode: 'approved-only' },
                scrubbing: { enabled: true },
            },
        });

        const child = runtime.createChildSession();
        const manifest = manager.readManifest(child.sessionId);
        assert.equal(manifest.configSnapshot.defaultProvider, 'nanogpt');
        assert.equal(manifest.configSnapshot.model.default, 'zai-org/glm-4.7');
        assert.deepEqual(manifest.configSnapshot.permissions, { nonInteractive: false });
        assert.deepEqual(manifest.configSnapshot.network, { mode: 'approved-only' });
        assert.deepEqual(manifest.configSnapshot.scrubbing, { enabled: true });
    } finally {
        rmSync(sessionsDir, { recursive: true, force: true });
    }
});
`,
            },
        },
        {
            id: 'resume-registry-hard',
            prompt: [
                'Fix the resumed-session handle behavior in this small Node project.',
                'Historical handles reconstructed from prior events should be tombstoned on resume so session I/O returns tool.session_exited instead of tool.not_found.',
                'Unknown handles should still return tool.not_found.',
                'Keep the patch minimal, do not modify the tests, run `node --test`, and reply with a short summary.',
            ].join(' '),
            files: {
                'package.json': JSON.stringify({
                    name: 'resume-registry-hard-fixture',
                    type: 'module',
                    private: true,
                    scripts: { test: 'node --test' },
                }, null, 2) + '\n',
                'src/process-registry.js': `export class ProcessRegistry {
    constructor() {
        this.liveHandles = new Map();
    }

    register(handleId, entry) {
        this.liveHandles.set(handleId, entry);
    }

    get(handleId) {
        return this.liveHandles.get(handleId);
    }
}
`,
                'src/resume.js': `export function markHistoricalHandlesTerminated(events, registry) {
    for (const event of events) {
        if (event.type === 'open_handle' && event.handleId) {
            registry.register(event.handleId, { status: 'terminated-on-resume' });
        }
    }
}
`,
                'src/session-io.js': `export function readFromSession({ registry, handleId }) {
    const handle = registry.get(handleId);
    if (!handle) {
        return {
            status: 'error',
            error: {
                code: 'tool.not_found',
                message: 'Handle not found',
            },
        };
    }

    if (handle.status === 'exited') {
        return {
            status: 'error',
            error: {
                code: 'tool.session_exited',
                message: 'Session exited',
            },
        };
    }

    return {
        status: 'success',
        data: handle.buffer ?? '',
    };
}
`,
                'test/session-io.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessRegistry } from '../src/process-registry.js';
import { markHistoricalHandlesTerminated } from '../src/resume.js';
import { readFromSession } from '../src/session-io.js';

test('live running handles still return their buffered data', () => {
    const registry = new ProcessRegistry();
    registry.register('h-live', { status: 'running', buffer: 'hello' });

    const result = readFromSession({ registry, handleId: 'h-live' });
    assert.equal(result.status, 'success');
    assert.equal(result.data, 'hello');
});

test('historical handles are tombstoned on resume and report tool.session_exited', () => {
    const registry = new ProcessRegistry();
    markHistoricalHandlesTerminated([
        { type: 'open_handle', handleId: 'h-old' },
    ], registry);

    const result = readFromSession({ registry, handleId: 'h-old' });
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'tool.session_exited');
    assert.match(result.error.message, /resume|terminated|exited/i);
});

test('unknown handles still return tool.not_found', () => {
    const registry = new ProcessRegistry();
    const result = readFromSession({ registry, handleId: 'missing' });
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'tool.not_found');
});
`,
            },
        },
    ];
}

function buildTasks(suite: ParsedArgs['suite']): FixtureTask[] {
    switch (suite) {
        case 'basic':
            return basicTasks();
        case 'aca-hard':
            return acaHardTasks();
        case 'all':
            return [...basicTasks(), ...acaNativeTasks(), ...acaHardTasks()];
        case 'aca-native':
        default:
            return acaNativeTasks();
    }
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
    for (const [relativePath, content] of Object.entries(files)) {
        const targetPath = join(root, relativePath);
        await fs.mkdir(dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, content, 'utf8');
    }
}

function runCommand(
    command: string,
    args: string[],
    options: {
        cwd: string;
        env?: NodeJS.ProcessEnv;
        timeoutMs?: number;
        stdin?: string;
    },
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: { ...process.env, ...(options.env ?? {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            finish(124);
        }, options.timeoutMs ?? 120_000);

        function finish(code: number): void {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolvePromise({ code, stdout, stderr });
        }

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        child.stdin.on('error', error => {
            if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
                stderr += error.message;
            }
        });
        child.on('error', error => {
            stderr += error.message;
            finish(1);
        });
        child.on('close', code => finish(code ?? 1));
        try {
            child.stdin.end(options.stdin ?? '');
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code !== 'EPIPE') {
                stderr += err.message;
                finish(1);
            }
        }
    });
}

async function setupCase(task: FixtureTask): Promise<{ caseRoot: string; workspace: string; home: string }> {
    const caseRoot = await fs.mkdtemp(join(tmpdir(), `aca-bakeoff-${task.id}-`));
    const workspace = join(caseRoot, 'workspace');
    const home = join(caseRoot, 'home');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(join(home, '.aca'), { recursive: true });
    await fs.writeFile(
        join(home, '.aca', 'config.json'),
        JSON.stringify({ model: { default: DEFAULT_MODELS[0] } }, null, 2) + '\n',
        'utf8',
    );
    await writeFiles(workspace, task.files);

    await runCommand('git', ['init'], { cwd: workspace, timeoutMs: 30_000 });
    await runCommand('git', ['config', 'user.email', 'bakeoff@example.com'], { cwd: workspace, timeoutMs: 30_000 });
    await runCommand('git', ['config', 'user.name', 'Bakeoff'], { cwd: workspace, timeoutMs: 30_000 });
    await runCommand('git', ['add', '.'], { cwd: workspace, timeoutMs: 30_000 });
    await runCommand('git', ['commit', '-m', 'baseline'], { cwd: workspace, timeoutMs: 30_000 });

    return { caseRoot, workspace, home };
}

function sanitizeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

async function runCase(
    outDir: string,
    apiKey: string,
    model: string,
    task: FixtureTask,
): Promise<CaseResult> {
    const startedAt = Date.now();
    const { caseRoot, workspace, home } = await setupCase(task);
    const request = {
        contract_version: '1.0.0',
        schema_version: '1.1.0',
        task: task.prompt,
        context: {
            cwd: workspace,
            model,
        },
        constraints: {
            allowed_tools: DEFAULT_ALLOWED_TOOLS,
            max_steps: 24,
            max_tool_calls: 20,
            fail_on_rejected_tool_calls: true,
        },
    };

    const invoke = await runCommand('node', [DIST_INDEX, 'invoke'], {
        cwd: ROOT,
        env: {
            HOME: home,
            NODE_NO_WARNINGS: '1',
            NANOGPT_API_KEY: apiKey,
        },
        timeoutMs: 240_000,
        stdin: JSON.stringify(request),
    });

    let response: InvokeResponse | null = null;
    let parseError: string | null = null;
    try {
        response = JSON.parse(invoke.stdout.trim()) as InvokeResponse;
    } catch (error: unknown) {
        parseError = error instanceof Error ? error.message : String(error);
    }

    const validation = await runCommand('node', ['--test'], {
        cwd: workspace,
        timeoutMs: 60_000,
    });
    const diffFilesResult = await runCommand('git', ['diff', '--name-only'], {
        cwd: workspace,
        timeoutMs: 30_000,
    });
    const diffStatResult = await runCommand('git', ['diff', '--stat'], {
        cwd: workspace,
        timeoutMs: 30_000,
    });
    const diffPatchResult = await runCommand('git', ['diff', '--unified=0'], {
        cwd: workspace,
        timeoutMs: 30_000,
    });

    const changedFiles = diffFilesResult.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    const changedTests = changedFiles.some(file => file.startsWith('test/'));
    const acceptedToolCalls = response?.safety?.accepted_tool_calls ?? null;
    const rejectedToolCalls = response?.safety?.rejected_tool_calls ?? null;
    const success = response?.status === 'success';
    const testsPassed = validation.code === 0;
    const elapsedMs = Date.now() - startedAt;

    const result: CaseResult = {
        model,
        taskId: task.id,
        success,
        testsPassed,
        changedTests,
        acceptedToolCalls,
        rejectedToolCalls,
        elapsedMs,
        invokeExitCode: invoke.code,
        validationExitCode: validation.code,
        parseError,
        result: typeof response?.result === 'string' ? response.result.trim() : '',
        errorCodes: Array.isArray(response?.errors) ? response.errors.map(error => error.code) : [],
        changedFiles,
        diffStat: diffStatResult.stdout.trim(),
        diffPatch: diffPatchResult.stdout,
        stderr: invoke.stderr.trim(),
        validationStderr: validation.stderr.trim(),
        overallPass: Boolean(success && testsPassed && !changedTests),
    };

    const caseFile = join(outDir, `${sanitizeName(model)}--${sanitizeName(task.id)}.json`);
    await fs.writeFile(caseFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
    await fs.rm(caseRoot, { recursive: true, force: true });

    return result;
}

async function runPool<T, TResult>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
    const results = new Array<TResult>(items.length);
    let nextIndex = 0;

    async function runNext(): Promise<void> {
        while (true) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            if (currentIndex >= items.length) return;
            results[currentIndex] = await worker(items[currentIndex], currentIndex);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
    return results;
}

function buildSummary(models: string[], results: CaseResult[]): Record<string, unknown> {
    const summary = Object.fromEntries(models.map(model => [model, {
        cases: 0,
        pass: 0,
        success: 0,
        testsPassed: 0,
        changedTests: 0,
        totalAcceptedToolCalls: 0,
        totalRejectedToolCalls: 0,
        totalElapsedMs: 0,
    }])) as Record<string, {
        cases: number;
        pass: number;
        success: number;
        testsPassed: number;
        changedTests: number;
        totalAcceptedToolCalls: number;
        totalRejectedToolCalls: number;
        totalElapsedMs: number;
    }>;

    for (const result of results) {
        const bucket = summary[result.model];
        bucket.cases += 1;
        if (result.overallPass) bucket.pass += 1;
        if (result.success) bucket.success += 1;
        if (result.testsPassed) bucket.testsPassed += 1;
        if (result.changedTests) bucket.changedTests += 1;
        bucket.totalAcceptedToolCalls += result.acceptedToolCalls ?? 0;
        bucket.totalRejectedToolCalls += result.rejectedToolCalls ?? 0;
        bucket.totalElapsedMs += result.elapsedMs;
    }

    return summary;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const tasks = buildTasks(args.suite);
    const secretsResult = await loadSecrets();
    const apiKey = secretsResult.secrets.nanogpt?.trim();
    if (!apiKey) {
        throw new Error('Missing NanoGPT API key');
    }

    await fs.mkdir(args.outDir, { recursive: true });
    const cases: BakeoffCase[] = [];
    for (const model of args.models) {
        for (const task of tasks) {
            cases.push({ model, task });
        }
    }

    process.stdout.write(
        `Running ${cases.length} live bakeoff cases from suite "${args.suite}" with concurrency ${args.concurrency}...\n`,
    );
    const results = await runPool(cases, args.concurrency, async ({ model, task }) => {
        const result = await runCase(args.outDir, apiKey, model, task);
        const status = result.overallPass ? 'PASS' : 'FAIL';
        process.stdout.write(
            `${status} ${model} :: ${task.id} :: success=${result.success} ` +
            `tests=${result.testsPassed} changedTests=${result.changedTests} ` +
            `tools=${result.acceptedToolCalls}/${result.rejectedToolCalls} ` +
            `time=${Math.round(result.elapsedMs / 1000)}s\n`,
        );
        return result;
    });

    const summary = buildSummary(args.models, results);
    await fs.writeFile(join(args.outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    await fs.writeFile(join(args.outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n', 'utf8');

    process.stdout.write(`Output written to ${args.outDir}\n`);
    process.stdout.write('===MODEL_SUMMARY===\n');
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write('===CASE_RESULTS===\n');
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
