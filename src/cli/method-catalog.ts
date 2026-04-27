import { TOOL_NAMES } from './tool-names.js';

export interface MethodCatalogArgument {
    name: string;
    kind: 'flag' | 'stdin' | 'context_field';
    required: boolean;
    description: string;
    value_type?: 'string' | 'number' | 'boolean' | 'string_array' | 'json' | 'enum';
    choices?: string[];
    default?: string | number | boolean;
}

export interface MethodCatalogSelector {
    input_mode: 'cli_args' | 'stdin_json' | 'none';
    task_kinds: string[];
    profile?: string;
    preferred_for: string[];
    avoid_for?: string[];
}

export interface MethodCatalogEntry {
    id: string;
    invocation: string;
    surface: 'subcommand' | 'invoke_profile';
    summary: string;
    selector: MethodCatalogSelector;
    when_to_use: string[];
    key_arguments: MethodCatalogArgument[];
    examples: string[];
}

export interface MethodCatalogIntentRoute {
    intent: string;
    preferred_methods: string[];
    notes?: string;
}

export interface MethodCatalogLanguageGuidance {
    trigger_examples: string[];
    interpretation: string;
    route_kind: 'method' | 'repo_work' | 'clarify';
    preferred_method?: string;
}

export interface MethodCatalog {
    version: 1;
    generated_by: 'aca';
    intents: MethodCatalogIntentRoute[];
    methods: MethodCatalogEntry[];
    language_guidance: MethodCatalogLanguageGuidance[];
}

const METHOD_CATALOG_ENTRIES: readonly MethodCatalogEntry[] = Object.freeze([
    {
        id: 'describe',
        invocation: 'aca describe --json',
        surface: 'subcommand',
        summary: 'Machine-readable low-level ACA executor contract.',
        selector: {
            input_mode: 'cli_args',
            task_kinds: ['machine_capability_discovery'],
            preferred_for: ['Reading ACA invoke request/response schema and supported tools/profiles.'],
            avoid_for: ['Choosing the best ACA workflow only from low-level contract details.'],
        },
        when_to_use: [
            'You need the invoke request/response schema.',
            'You are integrating ACA as a structured callee.',
        ],
        key_arguments: [
            { name: '--json', kind: 'flag', required: false, description: 'Output JSON capability descriptor.', value_type: 'boolean', default: true },
        ],
        examples: [
            'aca describe --json',
        ],
    },
    {
        id: 'methods',
        invocation: 'aca methods [--json]',
        surface: 'subcommand',
        summary: 'Task-oriented ACA workflow catalog with preferred entrypoints and examples.',
        selector: {
            input_mode: 'cli_args',
            task_kinds: ['machine_workflow_discovery', 'human_workflow_discovery'],
            preferred_for: ['Choosing the right ACA subcommand or invoke profile from task intent.'],
        },
        when_to_use: [
            'You know ACA exists but need to choose the right subcommand or invoke profile.',
            'You want a stable workflow catalog without scraping --help.',
        ],
        key_arguments: [
            { name: '--json', kind: 'flag', required: false, description: 'Emit the machine-readable method catalog.', value_type: 'boolean', default: false },
        ],
        examples: [
            'aca methods',
            'aca methods --json',
        ],
    },
    {
        id: 'invoke',
        invocation: 'aca invoke < stdin-json',
        surface: 'subcommand',
        summary: 'Run a bounded structured ACA task through the executor contract.',
        selector: {
            input_mode: 'stdin_json',
            task_kinds: ['structured_execution', 'bounded_task', 'automation'],
            preferred_for: ['Programmatic ACA calls that need explicit constraints, deadlines, or required output paths.'],
            avoid_for: ['Operator-facing multi-witness consultation where aca consult is the better workflow.'],
        },
        when_to_use: [
            'You need explicit tool budgets, deadlines, or required output paths.',
            'You are calling ACA from another script, wrapper, or agent.',
        ],
        key_arguments: [
            { name: 'stdin', kind: 'stdin', required: true, description: 'InvokeRequest JSON envelope containing task, optional context, and constraints.', value_type: 'json' },
            { name: 'context.model', kind: 'context_field', required: false, description: 'Model override for this invocation.', value_type: 'string' },
            { name: 'context.profile', kind: 'context_field', required: false, description: 'Built-in profile such as coder, reviewer, witness, triage, or rp-researcher.', value_type: 'enum', choices: ['general', 'researcher', 'rp-researcher', 'coder', 'reviewer', 'witness', 'triage'] },
            { name: 'constraints.allowed_tools', kind: 'context_field', required: false, description: `Explicit allowed tool list; known tools include ${TOOL_NAMES.slice(0, 6).join(', ')} and more.`, value_type: 'string_array' },
            { name: 'constraints.required_output_paths', kind: 'context_field', required: false, description: 'Files that must exist and be non-empty when the turn completes.', value_type: 'string_array' },
        ],
        examples: [
            "printf '%s' '{\"contract_version\":\"1.0.0\",\"schema_version\":\"1.1.0\",\"task\":\"Reply with exactly ACA_OK\"}' | aca invoke",
        ],
    },
    {
        id: 'invoke.coder',
        invocation: 'aca invoke with context.profile=\"coder\"',
        surface: 'invoke_profile',
        summary: 'General coding and debugging profile with broad workspace tools.',
        selector: {
            input_mode: 'stdin_json',
            task_kinds: ['code_modification', 'debugging', 'test_fixing'],
            profile: 'coder',
            preferred_for: ['Bounded coding tasks that should read, modify, and verify files in one invoke turn.'],
        },
        when_to_use: [
            'You want ACA to modify code, run tests, and iterate within one bounded invoke task.',
            'You need stronger tool access than consult or reviewer-style flows.',
        ],
        key_arguments: [
            { name: 'context.profile', kind: 'context_field', required: true, description: 'Set to `coder`.', value_type: 'enum', choices: ['coder'] },
            { name: 'context.cwd', kind: 'context_field', required: false, description: 'Workspace root for the task.', value_type: 'string' },
            { name: 'constraints.allowed_tools', kind: 'context_field', required: false, description: 'Optionally narrow the coder tool surface to specific tools.', value_type: 'string_array' },
        ],
        examples: [
            "printf '%s' '{\"contract_version\":\"1.0.0\",\"schema_version\":\"1.1.0\",\"task\":\"Fix the failing test and rerun it.\",\"context\":{\"profile\":\"coder\",\"cwd\":\"/path/to/repo\"}}' | aca invoke",
        ],
    },
    {
        id: 'invoke.rp-researcher',
        invocation: 'aca invoke with context.profile=\"rp-researcher\"',
        surface: 'invoke_profile',
        summary: 'Bounded RP lore research/writing profile for exact output paths.',
        selector: {
            input_mode: 'stdin_json',
            task_kinds: ['rp_research', 'lore_writing', 'bounded_markdown_generation'],
            profile: 'rp-researcher',
            preferred_for: ['Single bounded RP research or lore-writing turns with exact required outputs.'],
            avoid_for: ['Full discovery-and-generation orchestration across a series; use aca rp-research for that.'],
        },
        when_to_use: [
            'You need one structured RP research or lore-writing turn driven through invoke.',
            'You want the rp-researcher profile without running the higher-level rp-research workflow.',
        ],
        key_arguments: [
            { name: 'context.profile', kind: 'context_field', required: true, description: 'Set to `rp-researcher`.', value_type: 'enum', choices: ['rp-researcher'] },
            { name: 'context.model', kind: 'context_field', required: false, description: 'Optional model override; GLM-5 is the common default.', value_type: 'string' },
            { name: 'constraints.required_output_paths', kind: 'context_field', required: true, description: 'Exact RP markdown files that must be produced by the turn.', value_type: 'string_array' },
        ],
        examples: [
            "printf '%s' '{\"contract_version\":\"1.0.0\",\"schema_version\":\"1.1.0\",\"task\":\"Research the assigned canon topic and write the markdown file.\",\"context\":{\"profile\":\"rp-researcher\",\"cwd\":\"/path/to/rp-project\"},\"constraints\":{\"required_output_paths\":[\"world/academy.md\"]}}' | aca invoke",
        ],
    },
    {
        id: 'consult',
        invocation: 'aca consult --question <text> [options]',
        surface: 'subcommand',
        summary: 'Run ACA-native bounded witness consultation with multiple witness models and optional triage.',
        selector: {
            input_mode: 'cli_args',
            task_kinds: ['consultation', 'witness_review', 'second_opinion'],
            preferred_for: ['Multi-witness review, advisory consultation, or bounded second-opinion tasks.'],
            avoid_for: ['General coding execution with file mutation; use aca invoke with coder instead.'],
        },
        when_to_use: [
            'You want a second opinion, witness review, or bounded multi-model consultation.',
            'You want ACA to manage witness routing, evidence packs, and triage for you.',
        ],
        key_arguments: [
            { name: '--question', kind: 'flag', required: false, description: 'Inline consult task; use exactly one of --question or --prompt-file.', value_type: 'string' },
            { name: '--prompt-file', kind: 'flag', required: false, description: 'Markdown prompt file; use exactly one of --question or --prompt-file.', value_type: 'string' },
            { name: '--witnesses', kind: 'flag', required: false, description: 'Comma-separated witness list.', value_type: 'string_array', default: 'minimax,gemma' },
            { name: '--triage', kind: 'flag', required: false, description: 'Triage mode: auto, always, or never.', value_type: 'enum', choices: ['auto', 'always', 'never'], default: 'auto' },
            { name: '--pack-path', kind: 'flag', required: false, description: 'File or directory to include in the deterministic evidence pack.', value_type: 'string_array' },
        ],
        examples: [
            'aca consult --question "Review src/cli/consult.ts for grounded correctness risks only." --pack-path src/cli/consult.ts',
        ],
    },
    {
        id: 'rp-research',
        invocation: 'aca rp-research <series...> [options]',
        surface: 'subcommand',
        summary: 'Higher-level end-to-end RP knowledge-pack workflow with discovery and generation stages.',
        selector: {
            input_mode: 'cli_args',
            task_kinds: ['rp_workflow', 'franchise_discovery', 'knowledge_pack_generation'],
            preferred_for: ['End-to-end RP knowledge-pack generation across discovery and final file creation.'],
            avoid_for: ['Single bounded RP write tasks with explicit required outputs; use invoke.rp-researcher then.'],
        },
        when_to_use: [
            'You want ACA to orchestrate RP discovery plus markdown generation for a series.',
            'You want the full RP workflow rather than a single bounded invoke turn.',
        ],
        key_arguments: [
            { name: '--model', kind: 'flag', required: false, description: 'Workflow model override.', value_type: 'string', default: 'zai-org/glm-5' },
            { name: '--network-mode', kind: 'flag', required: false, description: 'Network mode for the generated invoke runs.', value_type: 'string' },
            { name: '--discover-only', kind: 'flag', required: false, description: 'Stop after discovery and manifest generation.', value_type: 'boolean', default: false },
            { name: '--blank-timeline', kind: 'flag', required: false, description: 'Generate a timeline-neutral pack after discovery.', value_type: 'boolean', default: false },
        ],
        examples: [
            'aca rp-research "The Quintessential Quintuplets" --blank-timeline --network-mode open',
        ],
    },
    {
        id: 'witnesses',
        invocation: 'aca witnesses --json',
        surface: 'subcommand',
        summary: 'Output the current witness seat configuration and model IDs.',
        selector: {
            input_mode: 'cli_args',
            task_kinds: ['witness_inventory', 'model_seat_discovery'],
            preferred_for: ['Reading the canonical witness names and model mapping.'],
        },
        when_to_use: [
            'You need the canonical witness names and model mapping.',
            'You want tooling to stay aligned with ACA witness seat configuration.',
        ],
        key_arguments: [
            { name: '--json', kind: 'flag', required: false, description: 'Output JSON witness config.', value_type: 'boolean', default: true },
        ],
        examples: [
            'aca witnesses --json',
        ],
    },
    {
        id: 'debug-ui',
        invocation: 'aca debug-ui',
        surface: 'subcommand',
        summary: 'Start the local ACA debug dashboard for sessions, consult runs, and observability data.',
        selector: {
            input_mode: 'cli_args',
            task_kinds: ['local_dashboard', 'runtime_inspection'],
            preferred_for: ['Inspecting ACA sessions, consults, and observability state in a browser.'],
        },
        when_to_use: [
            'You want to inspect local ACA sessions and consult runs in a browser.',
            'You are debugging runtime behavior rather than calling ACA as a worker.',
        ],
        key_arguments: [],
        examples: [
            'aca debug-ui',
        ],
    },
]);

const METHOD_LANGUAGE_GUIDANCE: readonly MethodCatalogLanguageGuidance[] = Object.freeze([
    {
        trigger_examples: ['ACA consult', 'use ACA consult', 'consult with ACA', 'get an ACA second opinion'],
        interpretation: 'Use the bounded witness-consult workflow instead of modifying ACA source code.',
        route_kind: 'method',
        preferred_method: 'consult',
    },
    {
        trigger_examples: ['ACA invoke', 'use ACA invoke', 'run ACA as a worker'],
        interpretation: 'Use the structured invoke executor contract.',
        route_kind: 'method',
        preferred_method: 'invoke',
    },
    {
        trigger_examples: ['ACA rp-research', 'run ACA RP research', 'use ACA for RP pack generation'],
        interpretation: 'Use the RP workflow subcommand instead of a generic coding task.',
        route_kind: 'method',
        preferred_method: 'rp-research',
    },
    {
        trigger_examples: ['fix ACA', 'work on ACA', 'audit ACA', 'ACA CLI', 'fix ACA consult'],
        interpretation: 'Modify or review the ACA repository/codebase itself, not an ACA workflow subcommand. For audits, start with docs/dev/audit-workflow.md.',
        route_kind: 'repo_work',
    },
    {
        trigger_examples: ['ACA'],
        interpretation: 'Bare ACA is ambiguous. Clarify whether the user means an ACA workflow/subcommand or the ACA codebase itself before choosing a route.',
        route_kind: 'clarify',
    },
]);

export function buildMethodCatalog(): MethodCatalog {
    return {
        version: 1,
        generated_by: 'aca',
        intents: [
            {
                intent: 'discover_aca_workflows',
                preferred_methods: ['methods', 'describe'],
                notes: 'Use methods first for workflow choice; use describe for the low-level invoke contract.',
            },
            {
                intent: 'structured_bounded_task',
                preferred_methods: ['invoke'],
            },
            {
                intent: 'code_fix_or_code_generation',
                preferred_methods: ['invoke.coder', 'invoke'],
                notes: 'Prefer invoke.coder when the task should edit files or run tests inside one bounded turn.',
            },
            {
                intent: 'multi_model_second_opinion',
                preferred_methods: ['consult'],
            },
            {
                intent: 'rp_knowledge_pack_workflow',
                preferred_methods: ['rp-research', 'invoke.rp-researcher'],
                notes: 'Use rp-research for discovery plus generation; use invoke.rp-researcher for one bounded RP write task.',
            },
            {
                intent: 'witness_model_inventory',
                preferred_methods: ['witnesses'],
            },
            {
                intent: 'local_runtime_dashboard',
                preferred_methods: ['debug-ui'],
            },
        ],
        methods: [...METHOD_CATALOG_ENTRIES],
        language_guidance: [...METHOD_LANGUAGE_GUIDANCE],
    };
}

export function runMethodsJson(): string {
    return JSON.stringify(buildMethodCatalog(), null, 2);
}

export function runMethodsText(): string {
    const catalog = buildMethodCatalog();
    const languageSection = catalog.language_guidance.map((guidance) => {
        const examples = guidance.trigger_examples.map(example => `  - ${example}`).join('\n');
        const route = guidance.preferred_method
            ? `Preferred method: ${guidance.preferred_method}`
            : guidance.route_kind === 'repo_work'
                ? 'Preferred route: work on the ACA repository itself'
                : 'Preferred route: clarify before choosing a workflow';
        return `- ${guidance.interpretation}\n${examples}\n  - ${route}`;
    }).join('\n');
    const sections = catalog.methods.map((method) => {
        const args = method.key_arguments.length > 0
            ? method.key_arguments.map(argument => {
                const suffix = argument.default !== undefined ? ` (default: ${String(argument.default)})` : '';
                return `- ${argument.name}${argument.required ? ' [required]' : ''}: ${argument.description}${suffix}`;
            }).join('\n')
            : '- None.';
        const examples = method.examples.map(example => `- ${example}`).join('\n');
        const useCases = method.when_to_use.map(item => `- ${item}`).join('\n');
        return `## ${method.invocation}
${method.summary}

When to use:
${useCases}

Key arguments:
${args}

Examples:
${examples}`;
    });

    return `ACA Methods

Use \`aca methods --json\` for the machine-readable catalog.

Language Routing:
${languageSection}

${sections.join('\n\n')}`;
}
