import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import {
    DEFAULT_RP_INVOKE_DEADLINE_MS,
    RP_AUTHORING_CONTRACT_SUMMARY_LINES,
    RP_CHARACTER_PORTRAYAL_RULE_LINES,
    RP_FINAL_FILE_FORBIDDEN_GUIDANCE_LINES,
    extractPseudoWriteFileCall,
    parseDiscoveryManifest,
    resolveRpInvokeDeadlineMs,
    resolveRpProjectRoot,
    slugifySeriesTitle,
    shouldFreshRetryRpInvokeResponse,
    validateDiscoveryArtifacts,
    validateCharacterMarkdown,
} from '../../src/cli/rp-research.js';

describe('rp-research helpers', () => {
    it('slugifies series titles into kebab-case', () => {
        expect(slugifySeriesTitle('Trinity Seven')).toBe('trinity-seven');
        expect(slugifySeriesTitle('The Quintessential Quintuplets')).toBe('the-quintessential-quintuplets');
        expect(slugifySeriesTitle('Fate/stay night')).toBe('fate-stay-night');
    });

    it('prefers explicit project root override over env', () => {
        const resolved = resolveRpProjectRoot('/tmp/rp-root', {
            ACA_RP_PROJECT_ROOT: '/tmp/ignored',
        });
        expect(resolved).toBe('/tmp/rp-root');
    });

    it('falls back to ACA_RP_PROJECT_ROOT when provided', () => {
        const resolved = resolveRpProjectRoot(undefined, {
            ACA_RP_PROJECT_ROOT: '/tmp/rp-env',
        });
        expect(resolved).toBe('/tmp/rp-env');
    });

    it('uses explicit RP invoke deadline override when present', () => {
        expect(resolveRpInvokeDeadlineMs(120000, {})).toBe(120000);
    });

    it('falls back to the default RP invoke deadline for invalid env overrides', () => {
        expect(resolveRpInvokeDeadlineMs(undefined, {
            ACA_RP_INVOKE_DEADLINE_MS: 'not-a-number',
        })).toBe(DEFAULT_RP_INVOKE_DEADLINE_MS);
    });

    it('parses a valid discovery manifest', () => {
        const manifest = parseDiscoveryManifest(JSON.stringify({
            schema_version: 1,
            series: {
                title: 'The Quintessential Quintuplets',
                slug: 'the-quintessential-quintuplets',
                source_scope: 'anime',
            },
            timeline_options: [
                {
                    id: 'blank',
                    label: 'Blank / neutral timeline',
                    summary: 'Keep the sisters broadly neutral for RP.',
                    recommended: true,
                },
            ],
            world_files: [
                { path: 'world/world.md', kind: 'world', topic: 'Greater setting overview' },
                { path: 'world/world-rules.md', kind: 'world_rules', topic: 'Social and setting constraints' },
            ],
            location_files: [
                { path: 'world/locations/asahiyama-high-school.md', name: 'Asahiyama High School', topic: 'School grounds and notable areas' },
            ],
            character_files: [
                { path: 'world/characters/nino-nakano.md', name: 'Nino Nakano', tier: 'main', topic: 'RP-facing portrayal profile' },
            ],
            notes: ['Keep timeline blank unless the user selects an arc.'],
        }));

        expect(manifest.series.title).toBe('The Quintessential Quintuplets');
        expect(manifest.world_files).toHaveLength(2);
        expect(manifest.character_files[0].path).toBe('world/characters/nino-nakano.md');
    });

    it('keeps the C6 authoring contract embedded in the runtime prompts', () => {
        expect(RP_AUTHORING_CONTRACT_SUMMARY_LINES).toContain('Final RP files must provide shape, not guidance.');
        expect(RP_FINAL_FILE_FORBIDDEN_GUIDANCE_LINES.some(line => line.includes('narrator guidance'))).toBe(true);
        expect(RP_CHARACTER_PORTRAYAL_RULE_LINES.some(line => line.includes('Faithful portrayal'))).toBe(true);
        expect(RP_CHARACTER_PORTRAYAL_RULE_LINES.some(line => line.includes('adjective stacks'))).toBe(true);
    });

    it('rejects discovery manifests that escape the series root', () => {
        expect(() => parseDiscoveryManifest(JSON.stringify({
            schema_version: 1,
            series: {
                title: 'Bad Series',
                slug: 'bad-series',
                source_scope: 'anime',
            },
            timeline_options: [],
            world_files: [
                { path: '../world.md', kind: 'world', topic: 'bad path' },
            ],
            location_files: [],
            character_files: [],
        }))).toThrow(/within the series folder/i);
    });

    it('accepts valid character files with only approved headings', () => {
        const validation = validateCharacterMarkdown([
            '# Nino Nakano',
            '',
            '## Basic Info',
            'Concise profile.',
            '',
            '## Appearance',
            'Detailed appearance.',
            '',
            '## Personality',
            'Detailed personality.',
            '',
            '## Relationships',
            'Short dynamics.',
            '',
            '## Speaking Style',
            'Target voice.',
        ].join('\n'));

        expect(validation.valid).toBe(true);
        expect(validation.issues).toEqual([]);
    });

    it('rejects character files with extra headings', () => {
        const validation = validateCharacterMarkdown([
            '# Nino Nakano',
            '',
            '## Basic Info',
            'Concise profile.',
            '',
            '## Backstory',
            'Not allowed.',
        ].join('\n'));

        expect(validation.valid).toBe(false);
        expect(validation.issues.some(issue => issue.includes('Backstory'))).toBe(true);
    });

    it('flags discovery outputs that drift into spoiler labels or size targets', () => {
        const validation = validateDiscoveryArtifacts([
            '# Discovery Plan',
            '',
            '### Main Characters (Tier: main, 16-20 KB target)',
            '',
            '**world/characters/yotsuba-nakano.md**',
            '- **Spoiler note**: Bride in canon ending',
        ].join('\n'), JSON.stringify({
            schema_version: 1,
            series: {
                title: 'The Quintessential Quintuplets',
                slug: 'the-quintessential-quintuplets',
                source_scope: 'anime',
            },
            timeline_options: [
                {
                    id: 'blank',
                    label: 'Blank / neutral timeline',
                    summary: 'Early tutoring phase.',
                    recommended: true,
                },
            ],
            world_files: [
                { path: 'world/world.md', kind: 'world', topic: 'World overview' },
                { path: 'world/world-rules.md', kind: 'world_rules', topic: 'Rules overview' },
            ],
            location_files: [],
            character_files: [],
            notes: ['The bride identity (Yotsuba) is a major spoiler.'],
        }));

        expect(validation.valid).toBe(false);
        expect(validation.issues.length).toBeGreaterThan(0);
    });

    it('fresh-retries retryable RP invoke errors like llm.malformed', () => {
        expect(shouldFreshRetryRpInvokeResponse({
            contract_version: '1.0.0',
            schema_version: '1.0.0',
            status: 'error',
            errors: [{ code: 'llm.malformed', message: 'Model returned an empty response', retryable: true }],
        })).toBe(true);
    });

    it('does not fresh-retry unrelated retryable invoke errors', () => {
        expect(shouldFreshRetryRpInvokeResponse({
            contract_version: '1.0.0',
            schema_version: '1.0.0',
            status: 'error',
            errors: [{ code: 'turn.rejected_tool_calls', message: 'workflow degraded', retryable: true }],
        })).toBe(false);
    });

    it('extracts pseudo write_file payloads for workflow salvage', () => {
        expect(extractPseudoWriteFileCall(
            '<tool_call>write_file<arg_key>path</arg_key><arg_value>/tmp/world.md</arg_value><arg_key>content</arg_key><arg_value># World\\n\\nBody</arg_value></tool_call>',
        )).toEqual({
            path: '/tmp/world.md',
            content: '# World\\n\\nBody',
        });
    });

    it('extracts invoke-style pseudo write_file payloads for workflow salvage', () => {
        expect(extractPseudoWriteFileCall(
            '<minimax:tool_call><invoke name="write_file"><parameter name="path">/tmp/world.md</parameter><parameter name="content"># World</parameter></invoke></minimax:tool_call>',
        )).toEqual({
            path: '/tmp/world.md',
            content: '# World',
        });
    });

    it('keeps rp-research subcommand --model local despite the root --model option', async () => {
        let capturedModel: string | undefined;
        const program = new Command();
        program.enablePositionalOptions();
        program.option('--model <model>', 'Root model', 'qwen/qwen3-coder-next');
        program
            .command('rp-research <series...>')
            .option('--model <model>', 'Model override for the RP research workflow', 'zai-org/glm-5')
            .action((_seriesParts: string[], options: { model: string }) => {
                capturedModel = options.model;
            });

        await program.parseAsync([
            'rp-research',
            'The',
            'Quintessential',
            'Quintuplets',
            '--model',
            'not-real/test',
        ], { from: 'user' });

        expect(capturedModel).toBe('not-real/test');
    });
});
