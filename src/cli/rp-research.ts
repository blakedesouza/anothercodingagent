import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InvokeResponse } from './executor.js';
import { parseInvokeOutput, runAcaInvoke } from '../mcp/server.js';
import { parseEmulatedToolCalls, sanitizeModelJson } from '../providers/tool-emulation.js';

export const DEFAULT_RP_INVOKE_DEADLINE_MS = 5 * 60 * 1000;

export const RP_CHARACTER_SECTION_HEADINGS = [
    'Basic Info',
    'Role',
    'Affiliation',
    'Appearance',
    'Personality',
    'Powers',
    'Weapons',
    'Relationships',
    'Speaking Style',
] as const;

export const RP_AUTHORING_CONTRACT_SUMMARY_LINES = [
    'Final RP files must provide shape, not guidance.',
    'Write declarative facts and portrayal, not narrator coaching, tone coaching, or roleplay instructions.',
    'Put facts where they belong: person-specific facts in character files, place-specific facts in location files, broader setting facts in world.md, and only truly cross-cutting rules in world-rules.md.',
] as const;

export const RP_FINAL_FILE_FORBIDDEN_GUIDANCE_LINES = [
    'Do not add narrator guidance, tone guidance, roleplay advice, spoiler/timeline constraints, `normal/unusual/forbidden` taxonomies, or generic genre explanation.',
] as const;

export const RP_CHARACTER_PORTRAYAL_RULE_LINES = [
    'Faithful portrayal matters more than "easy RP usability".',
    'Do not reduce Personality to adjective stacks, trope labels, or behavior scripts.',
    'Write Personality as a behavioral portrait with context, tension, and range.',
    'Show how the character presents at first, what sits underneath that surface, what pressures or embarrasses them, where they are rigid, where they soften, and how they vary by situation or person when canon supports it.',
    'Write Speaking Style as observed voice and conversational habits, not as instructions to the model.',
] as const;

export type RpCharacterSectionHeading = typeof RP_CHARACTER_SECTION_HEADINGS[number];
export type RpSourceScope = 'auto' | 'anime' | 'manga' | 'light-novel' | 'visual-novel';
export type RpNetworkMode = 'off' | 'approved-only' | 'open';
export type RpCharacterTier = 'main' | 'side' | 'minor';

export interface RpTimelineOption {
    id: string;
    label: string;
    summary: string;
    recommended?: boolean;
}

export interface RpWorldFilePlan {
    path: string;
    kind: 'world' | 'world_rules';
    topic: string;
}

export interface RpLocationFilePlan {
    path: string;
    name: string;
    topic: string;
}

export interface RpCharacterFilePlan {
    path: string;
    name: string;
    tier: RpCharacterTier;
    topic: string;
}

export interface RpDiscoveryManifest {
    schema_version: 1;
    series: {
        title: string;
        slug: string;
        source_scope: Exclude<RpSourceScope, 'auto'> | 'mixed' | 'auto';
    };
    timeline_options: RpTimelineOption[];
    world_files: RpWorldFilePlan[];
    location_files: RpLocationFilePlan[];
    character_files: RpCharacterFilePlan[];
    notes?: string[];
}

export interface RpResearchPaths {
    projectRoot: string;
    seriesSlug: string;
    seriesDir: string;
    researchDir: string;
    worldDir: string;
    charactersDir: string;
    locationsDir: string;
    discoveryPlanPath: string;
    discoveryManifestPath: string;
}

export interface RunRpResearchOptions {
    series: string;
    projectRoot?: string;
    slug?: string;
    sourceScope?: RpSourceScope;
    timeline?: string;
    blankTimeline?: boolean;
    discoverOnly?: boolean;
    refreshDiscovery?: boolean;
    model?: string;
    networkMode?: RpNetworkMode;
    invokeDeadlineMs?: number;
    maxSteps?: number;
    maxToolCalls?: number;
    /** Max parallel invoke tasks per phase (world/locations/characters). Clamped 1-8. Default: 4. */
    concurrency?: number;
}

export interface RpResearchSummary {
    status: 'timeline_required' | 'discovery_complete' | 'generated';
    seriesTitle: string;
    seriesSlug: string;
    projectRoot: string;
    seriesDir: string;
    discoveryPlanPath: string;
    discoveryManifestPath: string;
    timelineOptions: RpTimelineOption[];
    selectedTimeline?: RpTimelineOption;
    generatedFiles: string[];
}

export function resolveRpResearchConcurrency(value: number | undefined): number {
    if (value === undefined) return 4;
    if (!Number.isFinite(value)) return 4;
    return Math.max(1, Math.min(Math.trunc(value), 8));
}

export interface CharacterSchemaValidation {
    valid: boolean;
    issues: string[];
    headings: string[];
}

export interface DiscoveryArtifactValidation {
    valid: boolean;
    issues: string[];
}

interface PseudoWriteFileCall {
    path: string;
    content: string;
}

export const RP_FRESH_RETRYABLE_INVOKE_ERROR_CODES = new Set([
    'llm.server_error',
    'llm.timeout',
    'llm.rate_limit',
    'llm.rate_limited',
    'llm.malformed',
]);

function isWithinDirectory(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function normalizeManifestRelativePath(rawPath: string): string {
    const normalized = rawPath.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!normalized) throw new Error('path must be non-empty');
    if (normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') {
        throw new Error(`path must stay within the series folder: ${rawPath}`);
    }
    if (/^[a-zA-Z]:[\\/]/.test(rawPath)) {
        throw new Error(`absolute Windows path is not allowed in manifest: ${rawPath}`);
    }
    return normalized;
}

function workspaceRelativeOutputPath(seriesSlug: string, manifestRelativePath: string): string {
    return `${seriesSlug}/${normalizeManifestRelativePath(manifestRelativePath)}`;
}

function resolveSeriesFilePath(seriesDir: string, manifestRelativePath: string): string {
    return resolve(seriesDir, ...normalizeManifestRelativePath(manifestRelativePath).split('/'));
}

function ensureString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value.trim();
}

function ensureArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value;
}

function validateTimelineOptions(value: unknown): RpTimelineOption[] {
    const arr = ensureArray(value, 'timeline_options');
    return arr.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new Error(`timeline_options[${index}] must be an object`);
        }
        const record = entry as Record<string, unknown>;
        return {
            id: ensureString(record.id, `timeline_options[${index}].id`),
            label: ensureString(record.label, `timeline_options[${index}].label`),
            summary: ensureString(record.summary, `timeline_options[${index}].summary`),
            ...(typeof record.recommended === 'boolean' ? { recommended: record.recommended } : {}),
        };
    });
}

function validateWorldFiles(value: unknown): RpWorldFilePlan[] {
    const arr = ensureArray(value, 'world_files');
    return arr.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new Error(`world_files[${index}] must be an object`);
        }
        const record = entry as Record<string, unknown>;
        const path = normalizeManifestRelativePath(ensureString(record.path, `world_files[${index}].path`));
        const kind = ensureString(record.kind, `world_files[${index}].kind`);
        if (kind !== 'world' && kind !== 'world_rules') {
            throw new Error(`world_files[${index}].kind must be "world" or "world_rules"`);
        }
        return {
            path,
            kind,
            topic: ensureString(record.topic, `world_files[${index}].topic`),
        };
    });
}

function validateLocationFiles(value: unknown): RpLocationFilePlan[] {
    const arr = ensureArray(value, 'location_files');
    return arr.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new Error(`location_files[${index}] must be an object`);
        }
        const record = entry as Record<string, unknown>;
        return {
            path: normalizeManifestRelativePath(ensureString(record.path, `location_files[${index}].path`)),
            name: ensureString(record.name, `location_files[${index}].name`),
            topic: ensureString(record.topic, `location_files[${index}].topic`),
        };
    });
}

function validateCharacterFiles(value: unknown): RpCharacterFilePlan[] {
    const arr = ensureArray(value, 'character_files');
    return arr.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new Error(`character_files[${index}] must be an object`);
        }
        const record = entry as Record<string, unknown>;
        const tier = ensureString(record.tier, `character_files[${index}].tier`);
        if (tier !== 'main' && tier !== 'side' && tier !== 'minor') {
            throw new Error(`character_files[${index}].tier must be "main", "side", or "minor"`);
        }
        return {
            path: normalizeManifestRelativePath(ensureString(record.path, `character_files[${index}].path`)),
            name: ensureString(record.name, `character_files[${index}].name`),
            tier,
            topic: ensureString(record.topic, `character_files[${index}].topic`),
        };
    });
}

export function parseDiscoveryManifest(jsonText: string): RpDiscoveryManifest {
    const parsed = JSON.parse(jsonText) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('discovery manifest must be a JSON object');
    }
    const record = parsed as Record<string, unknown>;
    const schemaVersion = record.schema_version;
    if (schemaVersion !== 1) {
        throw new Error(`discovery manifest schema_version must be 1 (got ${String(schemaVersion)})`);
    }
    const series = record.series;
    if (typeof series !== 'object' || series === null || Array.isArray(series)) {
        throw new Error('series must be an object');
    }
    const seriesRecord = series as Record<string, unknown>;
    const sourceScope = ensureString(seriesRecord.source_scope, 'series.source_scope');
    return {
        schema_version: 1,
        series: {
            title: ensureString(seriesRecord.title, 'series.title'),
            slug: ensureString(seriesRecord.slug, 'series.slug'),
            source_scope: sourceScope as RpDiscoveryManifest['series']['source_scope'],
        },
        timeline_options: validateTimelineOptions(record.timeline_options),
        world_files: validateWorldFiles(record.world_files),
        location_files: validateLocationFiles(record.location_files),
        character_files: validateCharacterFiles(record.character_files),
        ...(Array.isArray(record.notes)
            ? {
                notes: record.notes
                    .filter((value): value is string => typeof value === 'string')
                    .map(value => value.trim())
                    .filter(Boolean),
            }
            : {}),
    };
}

export function slugifySeriesTitle(series: string): string {
    const normalized = series
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/['’]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
    if (!normalized) {
        throw new Error(`could not derive a series slug from "${series}"`);
    }
    return normalized;
}

export function resolveRpProjectRoot(projectRootOverride?: string, env: NodeJS.ProcessEnv = process.env): string {
    const explicit = projectRootOverride?.trim() || env.ACA_RP_PROJECT_ROOT?.trim();
    if (explicit) return resolve(explicit);
    throw new Error(
        'RP project root is not configured. Pass --project-root or set ACA_RP_PROJECT_ROOT.',
    );
}

export function resolveRpInvokeDeadlineMs(
    explicitOverride?: number,
    env: NodeJS.ProcessEnv = process.env,
): number {
    if (Number.isFinite(explicitOverride) && (explicitOverride ?? 0) > 0) {
        return Math.trunc(explicitOverride as number);
    }
    const raw = env.ACA_RP_INVOKE_DEADLINE_MS?.trim();
    if (!raw) return DEFAULT_RP_INVOKE_DEADLINE_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_RP_INVOKE_DEADLINE_MS;
    }
    return Math.trunc(parsed);
}

export function ensureRpSeriesSkeleton(projectRoot: string, seriesSlug: string): RpResearchPaths {
    const root = resolve(projectRoot);
    const seriesDir = resolve(root, seriesSlug);
    if (!isWithinDirectory(root, seriesDir)) {
        throw new Error(`series slug resolved outside project root: ${seriesSlug}`);
    }
    const researchDir = resolve(seriesDir, 'research');
    const worldDir = resolve(seriesDir, 'world');
    const charactersDir = resolve(worldDir, 'characters');
    const locationsDir = resolve(worldDir, 'locations');
    mkdirSync(researchDir, { recursive: true });
    mkdirSync(charactersDir, { recursive: true });
    mkdirSync(locationsDir, { recursive: true });
    return {
        projectRoot: root,
        seriesSlug,
        seriesDir,
        researchDir,
        worldDir,
        charactersDir,
        locationsDir,
        discoveryPlanPath: resolve(researchDir, 'discovery-plan.md'),
        discoveryManifestPath: resolve(researchDir, 'discovery-manifest.json'),
    };
}

function maybeReferencePath(projectRoot: string, relativePath: string): string | null {
    const fullPath = resolve(projectRoot, relativePath);
    return existsSync(fullPath) ? fullPath : null;
}

function formatReferenceBlock(
    referencePaths: Array<string | null>,
    intro: string,
    fallback: string,
): string {
    const references = referencePaths.filter((value): value is string => Boolean(value && existsSync(value)));
    if (references.length === 0) return fallback;
    return [
        intro,
        ...references.map(path => `- ${path}`),
    ].join('\n');
}

function formatTimelineChoiceList(options: RpTimelineOption[]): string {
    return options
        .map((option) => `- ${option.id}: ${option.label} — ${option.summary}${option.recommended ? ' [recommended]' : ''}`)
        .join('\n');
}

function buildDiscoveryTask(
    series: string,
    paths: RpResearchPaths,
    sourceScope: RpSourceScope,
): string {
    const referenceLines = formatReferenceBlock([
        maybeReferencePath(paths.projectRoot, 'EXAMPLE/world/world.txt'),
        maybeReferencePath(paths.projectRoot, 'EXAMPLE/world/world-rules.txt'),
        maybeReferencePath(paths.projectRoot, 'EXAMPLE/world/characters/arata_kasuga.txt'),
        maybeReferencePath(paths.projectRoot, 'EXAMPLE/world/locations/royal_biblia_academy.txt'),
    ], 'Inspect these local reference surfaces before you write the discovery files:', 'Inspect any existing local RP project guidance in the workspace before you write the discovery files.');

    return [
        `You are running the discovery phase of ACA's RP knowledge-pack import workflow for the series "${series}".`,
        `Target source scope: ${sourceScope}.`,
        'This is an LLM-facing RP knowledge pack for OC roleplay, not a fandom encyclopedia.',
        ...RP_AUTHORING_CONTRACT_SUMMARY_LINES,
        ...RP_FINAL_FILE_FORBIDDEN_GUIDANCE_LINES,
        `The target series folder already exists at "${paths.seriesDir}".`,
        referenceLines,
        'Use tools immediately. Do not write final world, location, or character docs in this pass.',
        'Do not call read_file on directories; read only concrete reference files.',
        'Do not try to read the required output files before they exist.',
        'For this discovery pass, keep local reference reads narrow and use them only to match the target format.',
        'Do not include file-size targets, byte targets, or completionist coverage goals in the discovery output.',
        'Do not reveal resolved spoiler identities, endgame pairings, or mystery answers in the discovery files. If a spoiler caution matters, describe it generically without naming the answer.',
        'For a blank or neutral recommendation, bias toward the earliest stable anime state and only propose files that are safe for that neutral pack.',
        'Character profiles are the primary vehicle of the pack. Plan character coverage broadly enough that the first pass does not stop at a tiny core cast.',
        'Do not plan to dump recurring side-character detail, family dynamics, or individualized portrayal into world/world-rules when those facts belong in character files.',
        'The pack can still widen later through iteration, but the first pass should already include significant recurring characters discovered in the chosen source scope.',
        'For Fandom or MediaWiki-backed sources, go directly to fetch_mediawiki_page and fetch_mediawiki_category instead of starting with web_search.',
        'If you call fetch_mediawiki_category, pass a numeric limit value such as 12, not a quoted string.',
        'Do not call web_search unless the direct MediaWiki path is clearly insufficient.',
        'Keep discovery bounded: identify the major arcs, main cast, meaningful side cast, and important locations without chasing every linked page in the franchise.',
        'Write exactly these two files and stop:',
        `- ${paths.seriesSlug}/research/discovery-plan.md`,
        `- ${paths.seriesSlug}/research/discovery-manifest.json`,
        'The Markdown discovery plan must briefly cover:',
        '- source notes',
        '- major arcs or timeline states relevant to RP',
        '- proposed world files',
        '- proposed location files',
        '- proposed character coverage, including meaningful side characters',
        '- any scope cautions that matter for a timeline-neutral pack',
        'The JSON manifest must be valid JSON with exactly this shape:',
        '```json',
        '{',
        '  "schema_version": 1,',
        '  "series": { "title": "CANONICAL_TITLE", "slug": "SERIES_SLUG", "source_scope": "anime|manga|light-novel|visual-novel|mixed|auto" },',
        '  "timeline_options": [',
        '    { "id": "blank", "label": "Blank / neutral timeline", "summary": "BRIEF_SUMMARY", "recommended": true }',
        '  ],',
        '  "world_files": [',
        '    { "path": "world/world.md", "kind": "world", "topic": "WORLD_TOPIC" },',
        '    { "path": "world/world-rules.md", "kind": "world_rules", "topic": "RULES_TOPIC" }',
        '  ],',
        '  "location_files": [',
        '    { "path": "world/locations/SLUG.md", "name": "LOCATION_NAME", "topic": "LOCATION_TOPIC" }',
        '  ],',
        '  "character_files": [',
        '    { "path": "world/characters/SLUG.md", "name": "CHARACTER_NAME", "tier": "main|side|minor", "topic": "CHARACTER_TOPIC" }',
        '  ],',
        '  "notes": ["OPTIONAL_NOTE"]',
        '}',
        '```',
        'Manifest path values must be relative to the series folder and must use `.md` for all final RP-facing files.',
        'The final RP-facing pack will later use:',
        '- world/world.md',
        '- world/world-rules.md',
        '- world/locations/*.md',
        '- world/characters/*.md',
        'Character files later may use only these headings when applicable:',
        RP_CHARACTER_SECTION_HEADINGS.map(heading => `- ${heading}`).join('\n'),
        'Do not create any other final-character headings during discovery.',
        'Timeline rule: blank timeline is allowed, but do not plan a pack that mixes incompatible arc states as if they coexist cleanly.',
    ].join('\n');
}

function buildTimelineContext(selectedTimeline: RpTimelineOption | undefined): string {
    if (!selectedTimeline || selectedTimeline.id === 'blank') {
        return [
            'Timeline mode: blank / neutral.',
            'Keep the file broadly RP-useful without mixing incompatible late-story states together.',
            'If a fact changes materially by arc, either phrase it in a stable pre-divergence way or leave it out.',
            'Do not resolve hidden identities, endgame pairings, confession outcomes, or late-story mystery answers.',
        ].join(' ');
    }
    return `Timeline mode: ${selectedTimeline.label}. ${selectedTimeline.summary} Keep this file scoped to that timeline and exclude incompatible later-state drift.`;
}

function buildWorldTask(
    series: string,
    paths: RpResearchPaths,
    entry: RpWorldFilePlan,
    selectedTimeline: RpTimelineOption | undefined,
): string {
    const referenceLines = formatReferenceBlock([
        existsSync(paths.discoveryPlanPath) ? paths.discoveryPlanPath : null,
        existsSync(paths.discoveryManifestPath) ? paths.discoveryManifestPath : null,
        entry.kind === 'world_rules' ? maybeReferencePath(paths.seriesDir, 'world/world.md') : null,
        maybeReferencePath(
            paths.projectRoot,
            entry.kind === 'world' ? 'EXAMPLE/world/world.txt' : 'EXAMPLE/world/world-rules.txt',
        ),
    ], 'Inspect these local references before you write the file:', 'Inspect the discovery files first if you need format guidance.');

    const workspacePath = workspaceRelativeOutputPath(paths.seriesSlug, entry.path);
    return [
        `Research "${series}" and write the ${entry.kind === 'world' ? 'greater-world' : 'world-rules'} file for the assigned topic: ${entry.topic}.`,
        referenceLines,
        `Write exactly one Markdown file at "${workspacePath}".`,
        'This is an RP-facing knowledge file for an LLM, not a fandom encyclopedia entry.',
        ...RP_AUTHORING_CONTRACT_SUMMARY_LINES,
        ...RP_FINAL_FILE_FORBIDDEN_GUIDANCE_LINES,
        buildTimelineContext(selectedTimeline),
        'Start with the local discovery files and any already-written pack files. Prefer those over broad new browsing.',
        'If you need outside evidence, keep it bounded and targeted. Use no more than 4 external lookups before you write.',
        'Make one real tool call at a time. Do not combine tool names or tool arguments into a single malformed call.',
        'Use tools immediately, inspect only what is needed, and write the file as soon as you have enough evidence.',
        'Never emit literal pseudo-tool markup such as `<tool_call>` or quoted function-call text. If you need a tool, make the real tool call instead.',
        'If one page lookup fails or a source title is missing, correct the next tool call or continue from the evidence already gathered. Do not stop and do not narrate fake tool calls.',
        'Do not add scene hooks, RP hooks, or creeping plot lines.',
        'Do not write about the series as a series. Do not use phrases like "The series focuses on", "The story explores", or "The anime depicts". Describe what is true in-world as if the world is real.',
        'Do not include spoilers: no resolved mysteries, no endgame outcomes, no future-timeline events. If a fact is spoiler-sensitive, omit it entirely.',
        'Keep the file targeted and useful for actual roleplay.',
        ...(entry.kind === 'world'
            ? [
            'This file is the broad setting overview: what the world is, what exists in it, stable background, and relevant shaping history.',
            'Keep it factual and declarative.',
            'Do not turn it into a timeline dump, a beat-by-beat plot synopsis, or a side-character overflow file.',
            'Character-specific motivations, family dynamics, and recurring side-character details belong in character files unless they truly shape the setting as a whole.',
            'Do not pad it with daily-life filler.',
        ]
            : [
                'This file is mandatory, but it may be brief.',
                'Use it only for factual cross-cutting rules, mechanics, constraints, or conditions that materially affect RP and do not fit more naturally in a character or location file.',
                'Keep it separate from the broader world synopsis.',
                'Do not use it for narrator guidance, tone guidance, spoiler or timeline constraints, taxonomy like `normal/unusual/forbidden`, or generic genre explanation.',
            ]),
    ].join('\n');
}

function buildLocationTask(
    series: string,
    paths: RpResearchPaths,
    entry: RpLocationFilePlan,
    selectedTimeline: RpTimelineOption | undefined,
): string {
    const referenceLines = formatReferenceBlock([
        existsSync(paths.discoveryPlanPath) ? paths.discoveryPlanPath : null,
        existsSync(paths.discoveryManifestPath) ? paths.discoveryManifestPath : null,
        maybeReferencePath(paths.seriesDir, 'world/world.md'),
        maybeReferencePath(paths.seriesDir, 'world/world-rules.md'),
        maybeReferencePath(paths.projectRoot, 'EXAMPLE/world/locations/royal_biblia_academy.txt'),
    ], 'Inspect these local references before you write the file:', 'Inspect the discovery files first if you need format guidance.');

    return [
        `Research "${series}" and write the location file for "${entry.name}" at "${workspaceRelativeOutputPath(paths.seriesSlug, entry.path)}".`,
        `Assigned topic: ${entry.topic}.`,
        referenceLines,
        'This is an RP-facing location doc, not a wiki article.',
        ...RP_AUTHORING_CONTRACT_SUMMARY_LINES,
        ...RP_FINAL_FILE_FORBIDDEN_GUIDANCE_LINES,
        buildTimelineContext(selectedTimeline),
        'The file should cover the location itself, a concise factual description, relevant background only when it materially explains why the place matters, and notable sublocations or points of interest.',
        'Start with the local discovery files and the existing world files. Prefer those over broad new browsing.',
        'If you need outside evidence, keep it bounded and targeted. Use no more than 3 external lookups before you write.',
        'Make one real tool call at a time. Do not combine tool names or tool arguments into a single malformed call.',
        'Never emit literal pseudo-tool markup such as `<tool_call>` or quoted function-call text. If you need a tool, make the real tool call instead.',
        'If one page lookup fails or a source title is missing, correct the next tool call or continue from the evidence already gathered. Do not stop and do not narrate fake tool calls.',
        'Describe factual location shape only. Do not add daily routine, beat-by-beat usage, or ambient fluff for its own sake.',
        'Use tools immediately, inspect only what is still needed, and write the assigned file.',
    ].join('\n');
}

function buildCharacterTask(
    series: string,
    paths: RpResearchPaths,
    entry: RpCharacterFilePlan,
    selectedTimeline: RpTimelineOption | undefined,
): string {
    const referenceLines = formatReferenceBlock([
        existsSync(paths.discoveryPlanPath) ? paths.discoveryPlanPath : null,
        existsSync(paths.discoveryManifestPath) ? paths.discoveryManifestPath : null,
        maybeReferencePath(paths.seriesDir, 'world/world.md'),
        maybeReferencePath(paths.seriesDir, 'world/world-rules.md'),
        maybeReferencePath(paths.projectRoot, 'EXAMPLE/world/characters/arata_kasuga.txt'),
    ], 'Inspect these local references before you write the file:', 'Inspect the discovery files first if you need format guidance.');

    return [
        `Research "${series}" and write the character file for "${entry.name}" at "${workspaceRelativeOutputPath(paths.seriesSlug, entry.path)}".`,
        `Assigned character topic: ${entry.topic}. Tier: ${entry.tier}.`,
        referenceLines,
        'This is an RP-facing portrayal document for an LLM, not a fandom encyclopedia profile.',
        ...RP_AUTHORING_CONTRACT_SUMMARY_LINES,
        ...RP_CHARACTER_PORTRAYAL_RULE_LINES,
        ...RP_FINAL_FILE_FORBIDDEN_GUIDANCE_LINES,
        buildTimelineContext(selectedTimeline),
        'Use Markdown. Start with a single `# <Character Name>` title line.',
        `After the title, only use applicable \`##\` headings chosen from this list: ${RP_CHARACTER_SECTION_HEADINGS.join(', ')}.`,
        'Basic Info must be a bullet list of key-value facts (e.g. `- Name: ...`, `- Age: ...`, `- Height: ...`). Do not write it as prose.',
        'Do not add any other headings.',
        'If a section is not applicable, omit it entirely and deepen the remaining valid sections instead of inventing replacements.',
        'When Powers or Weapons are not applicable, omit them and deepen the remaining sections instead.',
        'Only include Role or Affiliation when the information is non-inferrable; a reader could not deduce it from the character\'s name, their position in the cast, or the series premise. If it would not surprise or meaningfully inform, omit it.',
        'Relationships must stay compact: usually 1-2 sentences each, 3 only for a major relationship.',
        'No RP hooks, no creeping plot lines, no backstory section, no current-status section, no trivia, and no encyclopedia padding.',
        'Do not write about the series as a series. Do not use phrases like "The series focuses on", "The story explores", or "The manga portrays". Describe what is true in-world as if the world is real.',
        'Do not include spoilers: no resolved identity reveals, no endgame pairings, no future-timeline events, no deaths or departures that occur after the chosen timeline. If a fact is spoiler-sensitive, omit it entirely; no disclaimers, no vague hints.',
        'Keep shared cross-character facts brief in world-rules and do the real differentiation work here in the character file.',
        'Start with the local discovery files and the existing world files. Prefer those over broad new browsing.',
        'If you need outside evidence, keep it bounded and targeted. Use no more than 4 external lookups before you write.',
        'Make one real tool call at a time. Do not combine tool names or tool arguments into a single malformed call.',
        'Never emit literal pseudo-tool markup such as `<tool_call>` or quoted function-call text. If you need a tool, make the real tool call instead.',
        'If one page lookup fails or a source title is missing, correct the next tool call or continue from the evidence already gathered. Do not stop and do not narrate fake tool calls.',
        'Use tools immediately, inspect only the sources needed, and write the assigned file.',
    ].join('\n');
}

function buildCharacterSchemaRepairTask(
    paths: RpResearchPaths,
    entry: RpCharacterFilePlan,
    issues: readonly string[],
): string {
    return [
        `The file "${workspaceRelativeOutputPath(paths.seriesSlug, entry.path)}" is invalid for ACA's RP character schema.`,
        `Issues: ${issues.join('; ')}.`,
        'Rewrite the existing file in place.',
        'Keep the title line, but after that use only applicable `##` headings from this exact list:',
        RP_CHARACTER_SECTION_HEADINGS.map(heading => `- ${heading}`).join('\n'),
        'Do not add any other headings.',
        'If a section is not applicable, remove it and deepen the remaining valid sections instead.',
        ...RP_CHARACTER_PORTRAYAL_RULE_LINES,
        'Keep relationships compact and keep the file RP-facing rather than encyclopedic.',
        ...RP_FINAL_FILE_FORBIDDEN_GUIDANCE_LINES,
        'Use tools immediately and stop once the file is valid.',
    ].join('\n');
}

function buildDiscoveryManifestRepairTask(
    series: string,
    paths: RpResearchPaths,
    issues: readonly string[],
): string {
    return [
        `The discovery manifest for "${series}" needs a repair pass before ACA can continue.`,
        `Rewrite only "${paths.seriesSlug}/research/discovery-manifest.json" in place.`,
        `Issues: ${issues.join('; ')}.`,
        'Do not do broad new research unless it is strictly necessary to correct a bad proposal.',
        'Keep the JSON manifest schema exactly the same.',
        'Keep the workflow RP-facing rather than encyclopedic.',
        'Remove file-size targets, byte targets, and completionist coverage language.',
        'Do not reveal resolved spoiler identities, endgame pairings, or mystery answers. If a caution matters, describe it generically without naming the answer.',
        'For the blank or neutral recommendation, keep only the first-pass file proposals that are safe for that neutral pack.',
        'Do not create final world, location, or character docs in this repair pass.',
        'Read the discovery plan if it helps keep the two files aligned, but only rewrite the manifest.',
        'Rewrite exactly this file and stop:',
        `- ${paths.seriesSlug}/research/discovery-manifest.json`,
    ].join('\n');
}

function buildDiscoveryPlanRepairTask(
    series: string,
    paths: RpResearchPaths,
    issues: readonly string[],
): string {
    return [
        `The discovery plan for "${series}" needs a repair pass before ACA can continue.`,
        `Rewrite only "${paths.seriesSlug}/research/discovery-plan.md" in place.`,
        `Issues: ${issues.join('; ')}.`,
        'Do not do broad new research unless it is strictly necessary to correct a bad proposal.',
        'Keep the workflow RP-facing rather than encyclopedic.',
        'Remove file-size targets, byte targets, and completionist coverage language.',
        'Do not reveal resolved spoiler identities, endgame pairings, or mystery answers. If a caution matters, describe it generically without naming the answer.',
        'For the blank or neutral recommendation, keep only the first-pass file proposals that are safe for that neutral pack.',
        'Keep the plan aligned with the current manifest paths, names, and coverage.',
        'Do not create final world, location, or character docs in this repair pass.',
        'Rewrite exactly this file and stop:',
        `- ${paths.seriesSlug}/research/discovery-plan.md`,
    ].join('\n');
}

export function validateCharacterMarkdown(markdown: string): CharacterSchemaValidation {
    const lines = markdown.split(/\r?\n/);
    const headings = lines
        .map(line => line.match(/^##\s+(.+?)\s*$/)?.[1]?.trim())
        .filter((heading): heading is string => Boolean(heading));
    const allowed = new Set<string>(RP_CHARACTER_SECTION_HEADINGS);
    const issues: string[] = [];
    const titleLine = lines.find(line => line.trim().length > 0);
    if (!titleLine || !/^#\s+\S/.test(titleLine)) {
        issues.push('file must start with a single `# <Character Name>` title line');
    }
    for (const heading of headings) {
        if (!allowed.has(heading)) {
            issues.push(`disallowed heading: ${heading}`);
        }
    }
    const duplicates = headings.filter((heading, index) => headings.indexOf(heading) !== index);
    for (const duplicate of [...new Set(duplicates)]) {
        issues.push(`duplicate heading: ${duplicate}`);
    }
    if (headings.length === 0) {
        issues.push('file must contain at least one applicable `##` section heading');
    }
    return {
        valid: issues.length === 0,
        issues,
        headings,
    };
}

export function validateDiscoveryArtifacts(planMarkdown: string, manifestJsonText: string): DiscoveryArtifactValidation {
    const checks: Array<[RegExp, string]> = [
        [/\b\d+\s*(?:-\s*\d+)?\s*(?:kb|mb|bytes?)\b/i, 'discovery output must not contain file-size targets or byte targets'],
        [/\*\*Spoiler note\*\*:/i, 'discovery output must not contain explicit spoiler-note labels'],
        [/(?:bride|groom|identity)[^.\n]{0,80}\([A-Z][a-z]{1,}[^)]*\)/i, 'discovery output must not name spoiler answers inside cautions or notes'],
        [/(?:bride|groom)[^.\n]{0,60}canon ending/i, 'discovery output must not reveal endgame identity in caution text'],
    ];
    const combined = `${planMarkdown}\n${manifestJsonText}`;
    const issues = checks
        .filter(([pattern]) => pattern.test(combined))
        .map(([, message]) => message);
    return {
        valid: issues.length === 0,
        issues,
    };
}

async function withEnvOverride<T>(
    envOverride: Partial<Record<string, string | undefined>>,
    fn: () => Promise<T>,
): Promise<T> {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(envOverride)) {
        previous.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return await fn();
    } finally {
        for (const [key, value] of previous.entries()) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function formatInvokeErrorMessage(stdout: string, stderr: string, exitCode: number): string {
    const response = parseInvokeOutput(stdout, stderr, exitCode);
    if (response.status === 'success') {
        return 'expected invoke error but received success';
    }
    return response.errors?.map(error => `${error.code}: ${error.message}`).join('; ')
        ?? `aca invoke exited with code ${exitCode}`;
}

export function shouldFreshRetryRpInvokeResponse(response: InvokeResponse): boolean {
    return response.status === 'error'
        && Array.isArray(response.errors)
        && response.errors.length > 0
        && response.errors.every(error =>
            error.retryable
            && RP_FRESH_RETRYABLE_INVOKE_ERROR_CODES.has(error.code),
        );
}

/**
 * Returns an async function that runs tasks with at most `concurrency` running at a time.
 * Uses a queue-based semaphore so slow tasks don't stall later ones (pool, not batch).
 */
function createLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
    let active = 0;
    const queue: Array<() => void> = [];
    const next = () => {
        if (active >= concurrency || queue.length === 0) return;
        active += 1;
        const run = queue.shift()!;
        run();
    };
    return <T>(fn: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolvePromise, rejectPromise) => {
            queue.push(() => {
                fn().then(resolvePromise, rejectPromise).finally(() => {
                    active -= 1;
                    next();
                });
            });
            next();
        });
}

function snapshotSessionIds(sessionsDir: string): Set<string> {
    if (!existsSync(sessionsDir)) return new Set();
    return new Set(
        readdirSync(sessionsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name.startsWith('ses_'))
            .map(entry => entry.name),
    );
}

function findFreshSessionDir(
    sessionsDir: string,
    priorSessionIds: ReadonlySet<string>,
    workspaceRoot: string,
    expectedTag?: string,
): string | null {
    if (!existsSync(sessionsDir)) return null;
    const candidates = readdirSync(sessionsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith('ses_') && !priorSessionIds.has(entry.name))
        .map(entry => entry.name)
        .sort()
        .reverse();
    for (const sessionId of candidates) {
        const sessionDir = join(sessionsDir, sessionId);
        const manifestPath = join(sessionDir, 'manifest.json');
        if (!existsSync(manifestPath)) continue;
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
            const configSnapshot = manifest.configSnapshot as Record<string, unknown> | undefined;
            if (typeof configSnapshot?.workspaceRoot !== 'string') continue;
            if (resolve(configSnapshot.workspaceRoot) !== resolve(workspaceRoot)) continue;
            if (expectedTag !== undefined && configSnapshot.sessionTag !== expectedTag) continue;
            return sessionDir;
        } catch {
            continue;
        }
    }
    return null;
}

export function extractPseudoWriteFileCall(text: string): PseudoWriteFileCall | null {
    const parsed = parseEmulatedToolCalls(text);
    if (!parsed) return null;

    for (const call of parsed.calls) {
        if (call.name !== 'write_file') continue;
        try {
            const args = JSON.parse(sanitizeModelJson(call.arguments)) as { path?: unknown; content?: unknown };
            const path = typeof args.path === 'string' ? args.path.trim() : '';
            const content = typeof args.content === 'string' ? args.content : '';
            if (!path) continue;
            return { path, content };
        } catch (err) {
            process.stderr.write(
                `[rp-research] salvage: JSON.parse failed on write_file arguments (${err instanceof Error ? err.message : String(err)}); trying regex fallback\n`,
            );
            // Regex fallback: extract path and content from technically-invalid JSON.
            // Use a proper JSON-string-aware pattern for content so the match terminates
            // at the correct closing quote rather than greedily swallowing later keys.
            const pathMatch = call.arguments.match(/"path"\s*:\s*"([^"]+)"/);
            const contentMatch = call.arguments.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
            const fallbackPath = pathMatch?.[1]?.trim() ?? '';
            const fallbackContent = contentMatch?.[1] ?? '';
            if (fallbackPath) {
                process.stderr.write(`[rp-research] salvage: regex fallback extracted path="${fallbackPath}"\n`);
                return { path: fallbackPath, content: fallbackContent };
            }
            continue;
        }
    }
    return null;
}

function salvagePseudoWriteFromSession(
    sessionDir: string,
    projectRoot: string,
    requiredOutputPaths: readonly string[],
): string | null {
    const conversationPath = join(sessionDir, 'conversation.jsonl');
    if (!existsSync(conversationPath)) return null;
    const requiredResolved = new Set(
        requiredOutputPaths.map(path => resolve(projectRoot, path)),
    );
    const lines = readFileSync(conversationPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .reverse();
    for (const line of lines) {
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
            continue;
        }
        if (parsed.recordType !== 'message' || parsed.role !== 'assistant' || !Array.isArray(parsed.parts)) {
            continue;
        }
        for (const part of [...parsed.parts].reverse()) {
            if (typeof part !== 'object' || part === null) continue;
            const text = (part as Record<string, unknown>).text;
            if (typeof text !== 'string') continue;
            const pseudoWrite = extractPseudoWriteFileCall(text);
            if (!pseudoWrite) continue;
            const resolvedPath = isAbsolute(pseudoWrite.path)
                ? resolve(pseudoWrite.path)
                : resolve(projectRoot, pseudoWrite.path);
            if (!requiredResolved.has(resolvedPath)) continue;
            mkdirSync(dirname(resolvedPath), { recursive: true });
            writeFileSync(resolvedPath, pseudoWrite.content, 'utf8');
            return resolvedPath;
        }
    }
    return null;
}

async function runRpInvokeTask(
    task: string,
    projectRoot: string,
    options: {
        requiredOutputPaths: string[];
        model: string;
        deadlineMs?: number;
        maxSteps?: number;
        maxToolCalls?: number;
        networkMode?: RpNetworkMode;
    },
): Promise<void> {
    // Per-task session tag so parallel tasks can each find their own session during salvage.
    const sessionTag = randomUUID();
    const envOverride: Record<string, string> = { ACA_SESSION_TAG: sessionTag };
    if (options.networkMode) envOverride.ACA_NETWORK_MODE = options.networkMode;

    const execute = () => withEnvOverride(envOverride, () => runAcaInvoke(task, {
        cwd: projectRoot,
        profile: 'rp-researcher',
        model: options.model,
        deadlineMs: options.deadlineMs,
        maxSteps: options.maxSteps,
        maxToolCalls: options.maxToolCalls,
        failOnRejectedToolCalls: true,
        requiredOutputPaths: options.requiredOutputPaths,
    }));
    const sessionsDir = join(homedir(), '.aca', 'sessions');

    let priorErrorMessage: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const priorSessionIds = snapshotSessionIds(sessionsDir);
        const result = await execute();
        const response = parseInvokeOutput(result.stdout, result.stderr, result.exitCode);
        if (response.status !== 'error') {
            return;
        }

        if (response.errors?.some(error => error.code === 'turn.required_outputs_missing')) {
            const freshSessionDir = findFreshSessionDir(sessionsDir, priorSessionIds, projectRoot, sessionTag);
            if (freshSessionDir) {
                const salvagedPath = salvagePseudoWriteFromSession(
                    freshSessionDir,
                    projectRoot,
                    options.requiredOutputPaths,
                );
                if (salvagedPath && existsSync(salvagedPath)) {
                    return;
                }
            }
        }

        const errorMessage = formatInvokeErrorMessage(result.stdout, result.stderr, result.exitCode);
        if (attempt === 1 && shouldFreshRetryRpInvokeResponse(response)) {
            priorErrorMessage = errorMessage;
            continue;
        }

        if (priorErrorMessage) {
            throw new Error(`fresh retry did not recover: ${priorErrorMessage}; retry failed with ${errorMessage}`);
        }
        throw new Error(errorMessage);
    }

    throw new Error('fresh retry loop exited without a result');
}

function loadDiscoveryManifest(paths: RpResearchPaths): RpDiscoveryManifest {
    if (!existsSync(paths.discoveryManifestPath)) {
        throw new Error(`discovery manifest missing: ${paths.discoveryManifestPath}`);
    }
    const text = readFileSync(paths.discoveryManifestPath, 'utf8');
    const manifest = parseDiscoveryManifest(text);
    if (manifest.series.slug !== paths.seriesSlug) {
        throw new Error(
            `discovery manifest slug mismatch: expected "${paths.seriesSlug}", got "${manifest.series.slug}"`,
        );
    }
    return manifest;
}

function resolveSelectedTimeline(
    manifest: RpDiscoveryManifest,
    timeline: string | undefined,
    blankTimeline: boolean | undefined,
): RpTimelineOption | undefined {
    if (blankTimeline) {
        return manifest.timeline_options.find(option => option.id === 'blank')
            ?? { id: 'blank', label: 'Blank / neutral timeline', summary: 'Timeline-neutral RP pack.', recommended: true };
    }
    if (!timeline) return undefined;
    const trimmed = timeline.trim().toLowerCase();
    const match = manifest.timeline_options.find(option =>
        option.id.toLowerCase() === trimmed || option.label.toLowerCase() === trimmed,
    );
    if (!match) {
        throw new Error(
            `unknown timeline "${timeline}". Available options:\n${formatTimelineChoiceList(manifest.timeline_options)}`,
        );
    }
    return match;
}

export async function runRpResearchWorkflow(options: RunRpResearchOptions): Promise<RpResearchSummary> {
    if (options.timeline && options.blankTimeline) {
        throw new Error('Pass either --timeline or --blank-timeline, not both.');
    }
    const series = ensureString(options.series, 'series');
    const projectRoot = resolveRpProjectRoot(options.projectRoot);
    const seriesSlug = options.slug?.trim()
        ? normalizeManifestRelativePath(options.slug.trim()).replace(/\//g, '-')
        : slugifySeriesTitle(series);
    const paths = ensureRpSeriesSkeleton(projectRoot, seriesSlug);
    const model = options.model?.trim() || 'zai-org/glm-5';
    const sourceScope = options.sourceScope ?? 'auto';
    const invokeDeadlineMs = resolveRpInvokeDeadlineMs(options.invokeDeadlineMs);
    const concurrency = resolveRpResearchConcurrency(options.concurrency);
    const limit = createLimiter(concurrency);

    const shouldRunDiscovery = options.refreshDiscovery
        || !existsSync(paths.discoveryManifestPath)
        || !existsSync(paths.discoveryPlanPath);

    if (shouldRunDiscovery) {
        await runRpInvokeTask(
            buildDiscoveryTask(series, paths, sourceScope),
            projectRoot,
            {
                requiredOutputPaths: [
                    `${paths.seriesSlug}/research/discovery-plan.md`,
                    `${paths.seriesSlug}/research/discovery-manifest.json`,
                ],
                model,
                deadlineMs: invokeDeadlineMs,
                maxSteps: options.maxSteps ?? 22,
                maxToolCalls: options.maxToolCalls ?? 32,
                networkMode: options.networkMode,
            },
        );
        const discoveryValidation = validateDiscoveryArtifacts(
            readFileSync(paths.discoveryPlanPath, 'utf8'),
            readFileSync(paths.discoveryManifestPath, 'utf8'),
        );
        if (!discoveryValidation.valid) {
            await runRpInvokeTask(
                buildDiscoveryManifestRepairTask(series, paths, discoveryValidation.issues),
                projectRoot,
                {
                    requiredOutputPaths: [`${paths.seriesSlug}/research/discovery-manifest.json`],
                    model,
                    deadlineMs: invokeDeadlineMs,
                    maxSteps: Math.max(10, Math.min(options.maxSteps ?? 14, 20)),
                    maxToolCalls: Math.max(10, Math.min(options.maxToolCalls ?? 18, 24)),
                    networkMode: options.networkMode,
                },
            );
            await runRpInvokeTask(
                buildDiscoveryPlanRepairTask(series, paths, discoveryValidation.issues),
                projectRoot,
                {
                    requiredOutputPaths: [`${paths.seriesSlug}/research/discovery-plan.md`],
                    model,
                    deadlineMs: invokeDeadlineMs,
                    maxSteps: Math.max(10, Math.min(options.maxSteps ?? 14, 20)),
                    maxToolCalls: Math.max(10, Math.min(options.maxToolCalls ?? 18, 24)),
                    networkMode: options.networkMode,
                },
            );
            const repairedValidation = validateDiscoveryArtifacts(
                readFileSync(paths.discoveryPlanPath, 'utf8'),
                readFileSync(paths.discoveryManifestPath, 'utf8'),
            );
            if (!repairedValidation.valid) {
                throw new Error(`discovery repair did not converge: ${repairedValidation.issues.join('; ')}`);
            }
        }
    }

    const manifest = loadDiscoveryManifest(paths);
    const selectedTimeline = resolveSelectedTimeline(manifest, options.timeline, options.blankTimeline);
    const generatedFiles: string[] = [];

    if (options.discoverOnly || (!selectedTimeline && !options.blankTimeline)) {
        return {
            status: manifest.timeline_options.length > 0 && !selectedTimeline ? 'timeline_required' : 'discovery_complete',
            seriesTitle: manifest.series.title,
            seriesSlug,
            projectRoot,
            seriesDir: paths.seriesDir,
            discoveryPlanPath: paths.discoveryPlanPath,
            discoveryManifestPath: paths.discoveryManifestPath,
            timelineOptions: manifest.timeline_options,
            generatedFiles,
        };
    }

    // World files phase: parallel up to `concurrency`.
    {
        const results = await Promise.allSettled(
            manifest.world_files.map(entry => limit(async () => {
                const workspaceOutputPath = workspaceRelativeOutputPath(seriesSlug, entry.path);
                await runRpInvokeTask(
                    buildWorldTask(series, paths, entry, selectedTimeline),
                    projectRoot,
                    {
                        requiredOutputPaths: [workspaceOutputPath],
                        model,
                        deadlineMs: invokeDeadlineMs,
                        maxSteps: options.maxSteps ?? 22,
                        maxToolCalls: options.maxToolCalls ?? 28,
                        networkMode: options.networkMode,
                    },
                );
                return resolveSeriesFilePath(paths.seriesDir, entry.path);
            })),
        );
        const failures = results
            .map((r, i) => r.status === 'rejected' ? `${manifest.world_files[i].path}: ${String((r as PromiseRejectedResult).reason)}` : null)
            .filter((msg): msg is string => msg !== null);
        if (failures.length > 0) throw new Error(`world phase failures:\n${failures.join('\n')}`);
        for (const r of results) {
            if (r.status === 'fulfilled') generatedFiles.push(r.value);
        }
    }

    // Location files phase: parallel up to `concurrency`.
    {
        const results = await Promise.allSettled(
            manifest.location_files.map(entry => limit(async () => {
                const workspaceOutputPath = workspaceRelativeOutputPath(seriesSlug, entry.path);
                await runRpInvokeTask(
                    buildLocationTask(series, paths, entry, selectedTimeline),
                    projectRoot,
                    {
                        requiredOutputPaths: [workspaceOutputPath],
                        model,
                        deadlineMs: invokeDeadlineMs,
                        maxSteps: options.maxSteps ?? 18,
                        maxToolCalls: options.maxToolCalls ?? 22,
                        networkMode: options.networkMode,
                    },
                );
                return resolveSeriesFilePath(paths.seriesDir, entry.path);
            })),
        );
        const failures = results
            .map((r, i) => r.status === 'rejected' ? `${manifest.location_files[i].path}: ${String((r as PromiseRejectedResult).reason)}` : null)
            .filter((msg): msg is string => msg !== null);
        if (failures.length > 0) throw new Error(`location phase failures:\n${failures.join('\n')}`);
        for (const r of results) {
            if (r.status === 'fulfilled') generatedFiles.push(r.value);
        }
    }

    // Character files phase: parallel up to `concurrency`; each task owns its own repair pass.
    {
        const results = await Promise.allSettled(
            manifest.character_files.map(entry => limit(async () => {
                const workspaceOutputPath = workspaceRelativeOutputPath(seriesSlug, entry.path);
                await runRpInvokeTask(
                    buildCharacterTask(series, paths, entry, selectedTimeline),
                    projectRoot,
                    {
                        requiredOutputPaths: [workspaceOutputPath],
                        model,
                        deadlineMs: invokeDeadlineMs,
                        maxSteps: options.maxSteps ?? 22,
                        maxToolCalls: options.maxToolCalls ?? 30,
                        networkMode: options.networkMode,
                    },
                );
                const fullPath = resolveSeriesFilePath(paths.seriesDir, entry.path);
                const validation = validateCharacterMarkdown(readFileSync(fullPath, 'utf8'));
                if (!validation.valid) {
                    await runRpInvokeTask(
                        buildCharacterSchemaRepairTask(paths, entry, validation.issues),
                        projectRoot,
                        {
                            requiredOutputPaths: [workspaceOutputPath],
                            model,
                            deadlineMs: invokeDeadlineMs,
                            maxSteps: Math.max(10, Math.min(options.maxSteps ?? 14, 20)),
                            maxToolCalls: Math.max(10, Math.min(options.maxToolCalls ?? 18, 24)),
                            networkMode: options.networkMode,
                        },
                    );
                }
                return fullPath;
            })),
        );
        const failures = results
            .map((r, i) => r.status === 'rejected' ? `${manifest.character_files[i].path}: ${String((r as PromiseRejectedResult).reason)}` : null)
            .filter((msg): msg is string => msg !== null);
        if (failures.length > 0) throw new Error(`character phase failures:\n${failures.join('\n')}`);
        for (const r of results) {
            if (r.status === 'fulfilled') generatedFiles.push(r.value);
        }
    }

    return {
        status: 'generated',
        seriesTitle: manifest.series.title,
        seriesSlug,
        projectRoot,
        seriesDir: paths.seriesDir,
        discoveryPlanPath: paths.discoveryPlanPath,
        discoveryManifestPath: paths.discoveryManifestPath,
        timelineOptions: manifest.timeline_options,
        ...(selectedTimeline ? { selectedTimeline } : {}),
        generatedFiles,
    };
}

export function formatRpResearchSummary(summary: RpResearchSummary): string {
    const lines = [
        `Series: ${summary.seriesTitle}`,
        `Slug: ${summary.seriesSlug}`,
        `Project root: ${summary.projectRoot}`,
        `Series dir: ${summary.seriesDir}`,
        `Discovery plan: ${summary.discoveryPlanPath}`,
        `Discovery manifest: ${summary.discoveryManifestPath}`,
    ];
    if (summary.selectedTimeline) {
        lines.push(`Timeline: ${summary.selectedTimeline.label}`);
    }
    if (summary.status === 'timeline_required') {
        lines.push('');
        lines.push('Timeline choice required before final generation:');
        lines.push(formatTimelineChoiceList(summary.timelineOptions));
        lines.push('');
        lines.push('Rerun with --timeline <id> or --blank-timeline.');
    } else if (summary.status === 'generated') {
        lines.push(`Generated files: ${summary.generatedFiles.length}`);
        if (summary.generatedFiles.length > 0) {
            lines.push(...summary.generatedFiles.map(file => `- ${file}`));
        }
    } else {
        lines.push('Discovery complete.');
    }
    return lines.join('\n');
}
