/**
 * Tests for M7.1a: Agent Registry + Profiles
 *
 * Covers:
 * - Registry loads built-in profiles at session start
 * - Project config adds custom profile → registered alongside built-ins
 * - Profile lookup by name → correct tools, delegation permissions
 * - Narrowing validation: attempt to add tool not in profile → rejected
 * - Non-delegating enforcement: researcher calls spawn_agent → rejected
 * - Non-delegating enforcement: reviewer calls spawn_agent → rejected
 * - Witness profile: read-only tools, no delegation (M10.1)
 */
import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '../../src/delegation/agent-registry.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolSpec, ToolImplementation } from '../../src/tools/tool-registry.js';
import type { AgentProfile } from '../../src/types/agent.js';

// --- Test helpers ---

const noopImpl: ToolImplementation = async () => ({
    status: 'success' as const,
    data: '',
    truncated: false,
    bytesReturned: 0,
    bytesOmitted: 0,
    retryable: false,
    timedOut: false,
    mutationState: 'none' as const,
});

function makeToolSpec(name: string, approvalClass: ToolSpec['approvalClass'] = 'read-only'): ToolSpec {
    return {
        name,
        description: `Test tool: ${name}`,
        inputSchema: {},
        approvalClass,
        idempotent: true,
        timeoutCategory: 'file',
    };
}

/** Create a ToolRegistry with representative tools from each approval class. */
function buildTestToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();

    // read-only tools
    registry.register(makeToolSpec('read_file', 'read-only'), noopImpl);
    registry.register(makeToolSpec('find_paths', 'read-only'), noopImpl);
    registry.register(makeToolSpec('search_text', 'read-only'), noopImpl);
    registry.register(makeToolSpec('stat_path', 'read-only'), noopImpl);
    registry.register(makeToolSpec('search_semantic', 'read-only'), noopImpl);
    registry.register(makeToolSpec('estimate_tokens', 'read-only'), noopImpl);
    registry.register(makeToolSpec('lsp_query', 'read-only'), noopImpl);

    // workspace-write tools
    registry.register(makeToolSpec('write_file', 'workspace-write'), noopImpl);
    registry.register(makeToolSpec('edit_file', 'workspace-write'), noopImpl);
    registry.register(makeToolSpec('delete_path', 'workspace-write'), noopImpl);
    registry.register(makeToolSpec('move_path', 'workspace-write'), noopImpl);
    registry.register(makeToolSpec('make_directory', 'workspace-write'), noopImpl);

    // external-effect tools
    registry.register(makeToolSpec('exec_command', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('fetch_url', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('fetch_mediawiki_page', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('fetch_mediawiki_category', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('web_search', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('lookup_docs', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('open_session', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('session_io', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('close_session', 'external-effect'), noopImpl);

    // browser tools (external-effect)
    registry.register(makeToolSpec('browser_navigate', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('browser_click', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('browser_type', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('browser_press', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('browser_snapshot', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('browser_screenshot', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('browser_evaluate', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('browser_extract', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('browser_wait', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('browser_close', 'external-effect'), noopImpl);

    // delegation tools (external-effect / read-only)
    registry.register(makeToolSpec('spawn_agent', 'external-effect'), noopImpl);
    registry.register(makeToolSpec('message_agent', 'read-only'), noopImpl);
    registry.register(makeToolSpec('await_agent', 'read-only'), noopImpl);

    // user-facing tools
    registry.register(makeToolSpec('ask_user', 'user-facing'), noopImpl);
    registry.register(makeToolSpec('confirm_action', 'user-facing'), noopImpl);

    return registry;
}

// --- Tests ---

describe('AgentRegistry', () => {
    describe('built-in profiles', () => {
        it('loads 7 built-in profiles at session start', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const names = registry.getProfileNames();
            expect(names).toHaveLength(7);
            expect(names).toContain('general');
            expect(names).toContain('researcher');
            expect(names).toContain('rp-researcher');
            expect(names).toContain('coder');
            expect(names).toContain('reviewer');
            expect(names).toContain('witness');
            expect(names).toContain('triage');
        });

        it('general profile gets all read-only + workspace-write tools', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const profile = registry.getProfile('general');
            expect(profile).toBeDefined();
            expect(profile!.canDelegate).toBe(true);

            const tools = [...profile!.defaultTools];
            // Should include read-only tools
            expect(tools).toContain('read_file');
            expect(tools).toContain('find_paths');
            expect(tools).toContain('search_text');
            expect(tools).toContain('stat_path');
            expect(tools).toContain('search_semantic');
            expect(tools).toContain('estimate_tokens');
            expect(tools).toContain('lsp_query');
            // message_agent and await_agent are read-only but are delegation tools
            // general profile includes all delegation tools for recursive delegation
            expect(tools).toContain('spawn_agent');
            expect(tools).toContain('message_agent');
            expect(tools).toContain('await_agent');

            // Should include workspace-write tools
            expect(tools).toContain('write_file');
            expect(tools).toContain('edit_file');
            expect(tools).toContain('delete_path');
            expect(tools).toContain('move_path');
            expect(tools).toContain('make_directory');

            // Should NOT include external-effect or user-facing
            expect(tools).not.toContain('exec_command');
            expect(tools).not.toContain('fetch_url');
            expect(tools).not.toContain('ask_user');
            expect(tools).not.toContain('confirm_action');
        });

        it('researcher profile has expanded research tools and cannot delegate', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const profile = registry.getProfile('researcher');
            expect(profile).toBeDefined();
            expect(profile!.canDelegate).toBe(false);
            const tools = [...profile!.defaultTools];
            // Core research tools
            expect(tools).toContain('read_file');
            expect(tools).toContain('find_paths');
            expect(tools).toContain('search_text');
            expect(tools).toContain('search_semantic');
            expect(tools).toContain('lsp_query');
            expect(tools).toContain('stat_path');
            expect(tools).toContain('estimate_tokens');
            // Web research tools
            expect(tools).toContain('fetch_url');
            expect(tools).toContain('web_search');
            expect(tools).toContain('lookup_docs');
            // Execution (for running analysis commands)
            expect(tools).toContain('exec_command');
            // Should NOT include delegation or user-facing
            expect(tools).not.toContain('spawn_agent');
            expect(tools).not.toContain('ask_user');
        });

        it('rp-researcher profile has bounded lore writing tools and cannot delegate', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const profile = registry.getProfile('rp-researcher');
            expect(profile).toBeDefined();
            expect(profile!.canDelegate).toBe(false);
            expect([...profile!.defaultTools].sort()).toEqual([
                'fetch_mediawiki_category',
                'fetch_mediawiki_page',
                'fetch_url',
                'find_paths',
                'make_directory',
                'read_file',
                'search_text',
                'web_search',
                'write_file',
            ]);
            expect(profile!.systemPrompt).toContain('RP lore research writer');
            expect(profile!.systemPrompt).toContain('When web_search is configured and available');
            expect(profile!.systemPrompt).toContain('prefer fetch_mediawiki_page and fetch_mediawiki_category');
            expect(profile!.systemPrompt).toContain('pass numeric limits such as limit: 25 or limit: 50');
            expect(profile!.systemPrompt).toContain('Write Markdown only');
            expect(profile!.systemPrompt).toContain('world/character/<character>.md');
            expect(profile!.systemPrompt).toContain('world/characters/<character>.md');
            expect(profile!.systemPrompt).toContain('character research notes');
            expect(profile!.systemPrompt).toContain('dynamic sequential workflow');
            expect(profile!.systemPrompt).toContain('one deep research/write invocation per character');
            expect(profile!.systemPrompt).toContain('stop once you have enough source-grounded evidence');
            expect(profile!.systemPrompt).toContain('write exactly that character Markdown file');
            expect(profile!.systemPrompt).toContain('up to 16-20 KB for main characters');
            expect(profile!.systemPrompt).toContain('8-12 KB for side characters');
            expect(profile!.systemPrompt).toContain('4-8 KB for minor/supporting characters');
            expect(profile!.systemPrompt).toContain('ceilings, not floors');
            expect(profile!.systemPrompt).toContain('do not pad sparse characters');
            expect(profile!.systemPrompt).toContain('Keep Relationships compact');
            expect(profile!.systemPrompt).toContain('1-2 sentences per relationship');
            expect(profile!.systemPrompt).toContain('world/trinity-seven.md');
            expect(profile!.systemPrompt).toContain('discover the cast/topic list');
            expect(profile!.systemPrompt).toContain('FIRST assistant message must include actual tool calls');
            expect(profile!.systemPrompt).toContain('plan-only/intention-only text');
            expect(profile!.systemPrompt).toContain("I'll start by reading the local reference files");
            expect(profile!.systemPrompt).toContain('need to try subcategories');
            expect(profile!.systemPrompt).toContain('switch to the next viable source/tool path');
            expect(profile!.systemPrompt).toContain('source-grounded Markdown brief');
            expect(profile!.systemPrompt).toContain('do not stop at a promise to research later');
            expect(profile!.systemPrompt).toContain('stay on the assigned character or world topic');
            expect(profile!.systemPrompt).toContain('trusted long-context research models');
            expect(profile!.systemPrompt).toContain('required-output validation');
            expect(profile!.systemPrompt).toContain('Do not create per-character instructions.md files');
            expect(profile!.systemPrompt).toContain('Do not include Japanese script');
            expect(profile!.systemPrompt).toContain('ability/skill/magic name');
            expect(profile!.systemPrompt).toContain('Knowledge and Secrets');
            expect(profile!.systemPrompt).toContain('Avoid over-exposing hidden traits');
        });

        it('coder profile gets all tools except user-facing', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const profile = registry.getProfile('coder');
            expect(profile).toBeDefined();
            expect(profile!.canDelegate).toBe(true);
            const tools = [...profile!.defaultTools];
            // Read tools
            expect(tools).toContain('read_file');
            expect(tools).toContain('find_paths');
            expect(tools).toContain('search_text');
            expect(tools).toContain('search_semantic');
            expect(tools).toContain('stat_path');
            expect(tools).toContain('estimate_tokens');
            expect(tools).toContain('lsp_query');
            // Write tools
            expect(tools).toContain('write_file');
            expect(tools).toContain('edit_file');
            expect(tools).toContain('delete_path');
            expect(tools).toContain('move_path');
            expect(tools).toContain('make_directory');
            // Execution tools
            expect(tools).toContain('exec_command');
            expect(tools).toContain('open_session');
            expect(tools).toContain('session_io');
            expect(tools).toContain('close_session');
            // Web tools
            expect(tools).toContain('fetch_url');
            expect(tools).toContain('web_search');
            expect(tools).toContain('lookup_docs');
            // Browser tools
            expect(tools).toContain('browser_navigate');
            expect(tools).toContain('browser_click');
            expect(tools).toContain('browser_type');
            expect(tools).toContain('browser_snapshot');
            expect(tools).toContain('browser_screenshot');
            // Delegation tools stay available so coder can spawn depth-2 children
            expect(tools).toContain('spawn_agent');
            expect(tools).toContain('message_agent');
            expect(tools).toContain('await_agent');
            // Must NOT include user-facing tools
            expect(tools).not.toContain('ask_user');
            expect(tools).not.toContain('confirm_action');
        });

        it('coder profile is dynamically resolved from registry', () => {
            // Adding a new tool to the registry should automatically appear in coder profile
            const toolReg = buildTestToolRegistry();
            toolReg.register(makeToolSpec('custom_analysis', 'external-effect'), noopImpl);
            const { registry } = AgentRegistry.resolve(toolReg);

            const profile = registry.getProfile('coder');
            expect([...profile!.defaultTools]).toContain('custom_analysis');
        });

        it('reviewer profile has review tools including exec_command for running checks', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const profile = registry.getProfile('reviewer');
            expect(profile).toBeDefined();
            expect(profile!.canDelegate).toBe(false);
            const tools = [...profile!.defaultTools];
            expect(tools).toContain('read_file');
            expect(tools).toContain('find_paths');
            expect(tools).toContain('search_text');
            expect(tools).toContain('search_semantic');
            expect(tools).toContain('stat_path');
            expect(tools).toContain('estimate_tokens');
            expect(tools).toContain('lsp_query');
            expect(tools).toContain('fetch_url');
            expect(tools).toContain('web_search');
            expect(tools).toContain('lookup_docs');
            expect(tools).toContain('exec_command');
            // Should NOT include write/delete or delegation tools
            expect(tools).not.toContain('write_file');
            expect(tools).not.toContain('edit_file');
            expect(tools).not.toContain('delete_path');
            expect(tools).not.toContain('spawn_agent');
        });

        it('witness profile has review tools including exec_command for grounded verification', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const profile = registry.getProfile('witness');
            expect(profile).toBeDefined();
            expect(profile!.canDelegate).toBe(false);
            const tools = [...profile!.defaultTools];
            expect(tools).toContain('read_file');
            expect(tools).toContain('find_paths');
            expect(tools).toContain('search_text');
            expect(tools).toContain('search_semantic');
            expect(tools).toContain('stat_path');
            expect(tools).toContain('estimate_tokens');
            expect(tools).toContain('lsp_query');
            expect(tools).toContain('fetch_url');
            expect(tools).toContain('web_search');
            expect(tools).toContain('lookup_docs');
            expect(tools).toContain('exec_command');
            // Should NOT include write/delete or delegation tools
            expect(tools).not.toContain('write_file');
            expect(tools).not.toContain('edit_file');
            expect(tools).not.toContain('delete_path');
            expect(tools).not.toContain('spawn_agent');
        });

        it('witness profile has exactly 11 tools', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const profile = registry.getProfile('witness');
            expect(profile!.defaultTools).toHaveLength(11);
        });

        it('witness and reviewer profiles have identical tool sets', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const witness = registry.getProfile('witness');
            const reviewer = registry.getProfile('reviewer');
            expect([...witness!.defaultTools].sort()).toEqual([...reviewer!.defaultTools].sort());
        });

        it('witness profile system prompt mentions grounded review', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const profile = registry.getProfile('witness');
            expect(profile!.systemPrompt).toContain('witness');
            expect(profile!.systemPrompt).toContain('Do not modify files');
        });

        it('triage profile has narrow aggregation tools', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const triage = registry.getProfile('triage');
            expect(triage).toBeDefined();
            expect(triage!.canDelegate).toBe(false);
            const tools = [...triage!.defaultTools];
            expect(tools).toHaveLength(7);
            expect(tools).toContain('read_file');
            expect(tools).toContain('find_paths');
            expect(tools).toContain('search_text');
            expect(tools).toContain('stat_path');
            expect(tools).toContain('fetch_url');
            expect(tools).toContain('web_search');
            expect(tools).toContain('lookup_docs');
            expect(tools).not.toContain('search_semantic');
            expect(tools).not.toContain('estimate_tokens');
            expect(tools).not.toContain('lsp_query');
            expect(tools).not.toContain('exec_command');
            expect(tools).not.toContain('write_file');
            expect(tools).not.toContain('edit_file');
            expect(tools).not.toContain('delete_path');
            expect(tools).not.toContain('spawn_agent');
        });

        it('triage profile system prompt frames the aggregation role', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const profile = registry.getProfile('triage');
            expect(profile!.systemPrompt).toContain('triage');
            expect(profile!.systemPrompt).toContain('dedupe');
            expect(profile!.systemPrompt).toContain('Do not modify files');
            // Must make clear triage is NOT supposed to re-review from scratch
            expect(profile!.systemPrompt.toLowerCase()).toContain('not to re-review');
        });

        it('delegation tools are excluded from non-delegating profiles', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const delegationTools = ['spawn_agent', 'message_agent', 'await_agent'];
            for (const profileName of ['researcher', 'rp-researcher', 'reviewer', 'witness', 'triage']) {
                const profile = registry.getProfile(profileName);
                for (const tool of delegationTools) {
                    expect([...profile!.defaultTools]).not.toContain(tool);
                }
            }
        });

        it('profiles are frozen (immutable object and defaultTools array)', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const profile = registry.getProfile('general');
            expect(profile).toBeDefined();
            // Object is frozen
            expect(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing runtime immutability
                (profile as any).name = 'hacked';
            }).toThrow();
            // defaultTools array is also frozen
            expect(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing runtime immutability
                (profile!.defaultTools as any).push('evil_tool');
            }).toThrow();
        });
    });

    describe('project-config profiles', () => {
        it('adds custom profile alongside built-ins', () => {
            const toolReg = buildTestToolRegistry();
            const customProfile: AgentProfile = {
                name: 'data-analyst',
                systemPrompt: 'Analyze data and produce reports.',
                defaultTools: ['read_file', 'search_text', 'exec_command'],
                canDelegate: false,
            };
            const { registry } = AgentRegistry.resolve(toolReg, [customProfile]);

            const names = registry.getProfileNames();
            expect(names).toHaveLength(8);
            expect(names).toContain('data-analyst');

            const profile = registry.getProfile('data-analyst');
            expect(profile).toBeDefined();
            expect(profile!.defaultTools).toEqual(
                expect.arrayContaining(['read_file', 'search_text', 'exec_command']),
            );
        });

        it('project profile cannot shadow a built-in profile', () => {
            const toolReg = buildTestToolRegistry();
            const shadowProfile: AgentProfile = {
                name: 'researcher',
                systemPrompt: 'Override!',
                defaultTools: ['read_file', 'write_file', 'delete_path'],
                canDelegate: true,
            };
            const { registry, warnings } = AgentRegistry.resolve(toolReg, [shadowProfile]);

            // Should warn about shadowing
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain('researcher');
            expect(warnings[0]).toContain('shadows');

            // Built-in researcher should be preserved
            const profile = registry.getProfile('researcher');
            expect(profile).toBeDefined();
            expect(profile!.canDelegate).toBe(false); // built-in: no delegation
            expect(profile!.systemPrompt).not.toBe('Override!');
        });

        it('custom profiles are also frozen', () => {
            const toolReg = buildTestToolRegistry();
            const customProfile: AgentProfile = {
                name: 'custom',
                systemPrompt: 'Custom agent.',
                defaultTools: ['read_file'],
                canDelegate: false,
            };
            const { registry } = AgentRegistry.resolve(toolReg, [customProfile]);

            const profile = registry.getProfile('custom');
            expect(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing runtime immutability
(profile as any).name = 'hacked';
            }).toThrow();
        });

        it('defaultTools arrays are deep-frozen (cannot push)', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const profile = registry.getProfile('researcher');
            expect(profile).toBeDefined();
            expect(() => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing runtime immutability
                (profile!.defaultTools as any).push('evil_tool');
            }).toThrow();
        });

        it('invalid project profile is skipped with warning', () => {
            const toolReg = buildTestToolRegistry();
            const invalidProfile = {
                name: 'broken',
                systemPrompt: '',
                defaultTools: ['read_file'],
                canDelegate: false,
            };
            const { registry, warnings } = AgentRegistry.resolve(toolReg, [invalidProfile]);

            expect(registry.getProfile('broken')).toBeUndefined();
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain('broken');
            expect(warnings[0]).toContain('systemPrompt');
        });

        it('project profile with empty tools is skipped with warning', () => {
            const toolReg = buildTestToolRegistry();
            const emptyToolsProfile: AgentProfile = {
                name: 'empty-tools',
                systemPrompt: 'Has no tools.',
                defaultTools: [],
                canDelegate: false,
            };
            const { registry, warnings } = AgentRegistry.resolve(toolReg, [emptyToolsProfile]);

            expect(registry.getProfile('empty-tools')).toBeUndefined();
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain('defaultTools');
        });

        it('no warnings when no project profiles provided', () => {
            const toolReg = buildTestToolRegistry();
            const { warnings } = AgentRegistry.resolve(toolReg);
            expect(warnings).toHaveLength(0);
        });
    });

    describe('profile lookup', () => {
        it('getProfile returns correct profile by name', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const coder = registry.getProfile('coder');
            expect(coder).toBeDefined();
            expect(coder!.name).toBe('coder');
            expect(coder!.canDelegate).toBe(true);
            expect(coder!.systemPrompt).toBeTruthy();
        });

        it('getProfile returns undefined for unknown name', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            expect(registry.getProfile('nonexistent')).toBeUndefined();
        });

        it('listProfiles returns all profiles', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const profiles = registry.listProfiles();
            expect(profiles).toHaveLength(7);
            const names = profiles.map(p => p.name);
            expect(names).toEqual(['general', 'researcher', 'rp-researcher', 'coder', 'reviewer', 'witness', 'triage']);
        });
    });

    describe('narrowing validation', () => {
        it('accepts tools that are in the profile', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const result = registry.validateToolNarrowing('coder', [
                'read_file', 'write_file', 'exec_command',
            ]);
            expect(result.valid).toBe(true);
            expect(result.rejected).toHaveLength(0);
        });

        it('rejects tools not in the profile', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const result = registry.validateToolNarrowing('reviewer', [
                'read_file', 'write_file', 'delete_path',
            ]);
            expect(result.valid).toBe(false);
            expect(result.rejected).toEqual(
                expect.arrayContaining(['write_file', 'delete_path']),
            );
        });

        it('rejects all tools for unknown profile', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const result = registry.validateToolNarrowing('nonexistent', ['read_file']);
            expect(result.valid).toBe(false);
            expect(result.rejected).toEqual(['read_file']);
        });

        it('empty override list is valid narrowing', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            const result = registry.validateToolNarrowing('coder', []);
            expect(result.valid).toBe(true);
            expect(result.rejected).toHaveLength(0);
        });
    });

    describe('delegation permission enforcement', () => {
        it('researcher profile cannot delegate (spawn_agent rejected)', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            expect(registry.canDelegate('researcher')).toBe(false);
        });

        it('reviewer profile cannot delegate (spawn_agent rejected)', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            expect(registry.canDelegate('reviewer')).toBe(false);
        });

        it('general profile can delegate', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            expect(registry.canDelegate('general')).toBe(true);
        });

        it('coder profile can delegate', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            expect(registry.canDelegate('coder')).toBe(true);
        });

        it('witness profile cannot delegate', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            expect(registry.canDelegate('witness')).toBe(false);
        });

        it('unknown profile cannot delegate', () => {
            const toolReg = buildTestToolRegistry();
            const { registry } = AgentRegistry.resolve(toolReg);

            expect(registry.canDelegate('nonexistent')).toBe(false);
        });
    });
});
