# Codex Fixing

This folder is the durable workspace for the second-pass ACA audit.

The first pass was mainly a milestone + blast-radius review. It found real bugs, but it still missed dead live paths and incomplete runtime implementations. This pass is stricter.

Use these files in this order:

1. [RESUME.md](./RESUME.md)
2. [LIVING_PROGRESS.md](./LIVING_PROGRESS.md)
3. [AUDIT_FRAMEWORK.md](./AUDIT_FRAMEWORK.md)
4. [AUDIT_STATUS.md](./AUDIT_STATUS.md)
5. [POST_M11_TRACKS_PLAN.md](./POST_M11_TRACKS_PLAN.md) for post-M11 follow-on work
6. [MILESTONE_AUDIT_TEMPLATE.md](./MILESTONE_AUDIT_TEMPLATE.md)
7. [README.md](./README.md) for the dependency / connection map below

## Current Audit Rule

Every milestone from Phase 0 through Milestone 11 is being re-audited from the top using multiple axes, not just blast radius:

- blast radius / dependency map
- live runtime topology
- persistence and resume / replay
- negative-path and degraded behavior
- mode parity
- docs / tests / contract parity
- dead-code / fake-completion checks

The earlier blast-radius audit is still useful evidence, but it is not closure.

The operative rule is:

- each pass starts from a milestone
- then expands to the full blast zone of everything that milestone touches
- then applies every audit axis across that expanded scope
- and no milestone closes without bounded live NanoGPT validation recorded in `LIVE_VALIDATION.md`

Post-M11 follow-on tracks use the same rule set. They should be named explicitly and tracked on the same board instead of being left as loose residual notes.

## Working Agreement For The Re-Audit

- Start again at Phase 0 and walk forward through Milestone 11.
- If a milestone touches code owned by another milestone, fix the real bug where it lives, but keep audit bookkeeping anchored to the current milestone.
- Do not call a milestone done until all audit axes required by [AUDIT_FRAMEWORK.md](./AUDIT_FRAMEWORK.md) are satisfied.
- If a subsystem is found to be structurally incomplete, record that explicitly and widen the audit instead of papering over it with a local patch.

## Files In This Folder

- [RESUME.md](./RESUME.md): short restart instructions for future Codex sessions
- [LIVING_PROGRESS.md](./LIVING_PROGRESS.md): living record of what this audit is doing and where it currently stands
- [AUDIT_FRAMEWORK.md](./AUDIT_FRAMEWORK.md): the concrete audit method for the second pass
- [AUDIT_STATUS.md](./AUDIT_STATUS.md): status board for the re-audit from Phase 0 through Milestone 11
- [POST_M11_TRACKS_PLAN.md](./POST_M11_TRACKS_PLAN.md): planned post-M11 follow-on tracks `C1` through `C7`
- [MILESTONE_AUDIT_TEMPLATE.md](./MILESTONE_AUDIT_TEMPLATE.md): reusable per-milestone worksheet
- [README.md](./README.md): dependency and blast-radius connection map

## Connection Map

### Milestone Connection Map

This is not a bug hunt.

This is a dependency and blast-radius map for ACA from Phase 0 through Milestone 11, based on the step files under [`docs/steps/`](../docs/steps/README.md).

Use it when deciding:

- where a change likely propagates
- which earlier contracts a feature silently depends on
- which later milestones inherit a bad assumption if an earlier step is wrong

## How To Use This

1. Find the substep you are about to touch.
2. Read `Depends On` backward to see which earlier contracts it assumes.
3. Read `Likely Downstream Impact` forward to see what else may need updates.
4. If a row touches persistence, prompts, tool schemas, executor mode, or delegation, assume cross-milestone blast radius.

## Biggest Hubs

These are the steps most likely to cause system-wide drift if they are wrong:

| Hub | Why it is a hub | Typical downstream blast radius |
|---|---|---|
| `M1.1` Core Data Types | Defines IDs, turn/session records, items, errors, sequence model | Logs, manifests, events, stats, resume, checkpoints, delegation lineage |
| `M1.3` Session Manager | Owns manifest schema and session projection | Resume, retention, stats, observability backfill, executor sessions |
| `M1.5` Tool Runtime Contract | All tools pass through it | Validation, retries, output caps, tool error semantics, executor behavior |
| `M1.7` Turn Engine | Central runtime state machine | Prompts, tool flow, error handling, checkpoints, one-shot, invoke, delegation |
| `M2.5` Configuration System | All resolved policy and provider selection flows through here | Approval, network, telemetry, providers, trusted workspaces, startup wiring |
| `M2.6` Approval Flow | Governs execution permission semantics | Interactive tools, invoke auto-approve, delegated approval routing, write/exec behavior |
| `M3.0b` System Prompt Assembly | Shapes what every model sees | Context assembly, health lines, invoke prompt, witness/researcher behavior |
| `M3.2` Context Assembly Algorithm | Controls packing, digests, compression | Token budgeting, summarization, prompt truthfulness, resume consistency |
| `M3.5` Durable Task State | Persists task memory into manifest and prompt | Working set, resume, prompt state, loop tracking |
| `M3.7` Session Resume | Reconstructs runtime from disk | Manifest integrity, coverage maps, file activity, replay, config drift warnings |
| `M5.1` Full Provider Abstraction | Replaces single-driver assumptions with shared provider contracts | Cost tracking, fallback, tool emulation, model selection, live catalogs |
| `M5.2` Provider Features | Adds tool emulation and fallback chains | Non-native tool models, witness/delegation stability, malformed tool parsing |
| `M5.8` CLI Wiring | Retroactively integrates M1-M5 into `index.ts` | Real runtime behavior, all later milestones build on this wiring |
| `M7.7a` Error Taxonomy + Retry | Standardizes error semantics and retry rules | Health tracking, tool masking, delegation chains, executor responses |
| `M7.13` Capability Health | Injects degraded/unavailable states | Prompt context, tool masking, capability routing |
| `M7.11` Executor Mode | `aca invoke` contract becomes the bridge surface | MCP, witnesses, delegation, RP workflows, no-tools flows |
| `M7.15` M7 CLI Wiring | Integrates delegation/web/browser/checkpoints into runtime | All later live features use this plumbing |
| `M9.1` MCP Server | Turns `aca invoke` into an external tool | Claude bridge, subprocess lifecycle, timeout/deadline behavior |
| `M10.1c` TurnEngine Recovery + Executor Model Selection | Alters delegated tool-error behavior and executor model defaults | All delegated coding, witness ACA mode, no-tools stability |
| `M11.1` Model Catalog | Makes model limits live instead of static | Driver caps, witness limits, startup defaults, invoke budgets |
| `M11.6` Invoke Prompt Assembly | Delegated agents stop using a bare prompt | All invoke-based workflows: coder, witness, reviewer, RP researcher |
| `M11.7` Peer Agent Profiles | Expands tool access model-wide | Witness scope, researcher scope, delegated safety posture, consult behavior |

## Core Chains

These are the major dependency spines across the repo:

- Persistence spine:
  `M1.1 -> M1.2 -> M1.3 -> M1.9 -> M3.4 -> M3.5 -> M3.6 -> M3.7 -> M5.3 -> M5.6 -> M7.6`
- Prompt/context spine:
  `M3.0a -> M3.0b -> M3.1 -> M3.2 -> M3.3 -> M3.4 -> M7.13 -> M7.7c -> M11.6`
- Tool/safety spine:
  `M1.5 -> M2.1/M2.2 -> M2.3/M2.4/M2.5/M2.6/M2.7/M2.8 -> M7.7a/M7.7b/M7.10/M7.8 -> M11.7`
- Delegation/invoke spine:
  `M7.1a -> M7.1b -> M7.1c -> M7.2 -> M7.11 -> M9.1 -> M9.3b -> M10.1/M10.1b/M10.1c -> M11.3/M11.6/M11.7`
- Provider/runtime spine:
  `M1.4 -> M5.1 -> M5.2 -> M10.1c -> M11.1 -> M11.2 -> M11.3 -> M11.4 -> M11.8`

## Cross-Cutting Notes

- [`docs/steps/08-cross-cutting.md`](../docs/steps/08-cross-cutting.md) is not a feature milestone, but it affects all implementation:
  - test infrastructure was moved into Phase `0.3`
  - CI, strict typing, and buildability were intended to apply across all milestones
- `M7` is split into `07a`, `07a5`, `07b`, and `07c`; later M7 parts explicitly depend on earlier M7 parts.
- `M10.3` is still incomplete in the step file, so treat it as an open workflow milestone rather than a stable contract.

## Phase 0
Source: [`00-phase0-setup.md`](../docs/steps/00-phase0-setup.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `0.1` Spec Cross-Reference Updates | Spec-level additions for `budget_exceeded`, `providers[]`, `aca stats`, `/reindex`, `indexStatus` | Planning cleanup only | Shapes later milestone expectations for budgets, multi-provider config, indexing, stats, and project awareness |
| `0.2` Project Scaffolding | Repo layout, TypeScript config, CLI stub, scripts, package/build skeleton | None | Every source/test path, build target, runtime entrypoint, and import/layout assumption |
| `0.3` Test Infrastructure | Mock NanoGPT server, fixtures, session factory, snapshots, path aliases | `0.2` | Provider tests, rendering snapshots, session/replay tests, path-resolution consistency across build/test/runtime |

## Milestone 1
Source: [`01-milestone1-agent-loop.md`](../docs/steps/01-milestone1-agent-loop.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M1.1` Core Data Types | Session/turn/step/item schemas, IDs, `AcaError`, sequence model | `0.2`, `0.3` | Logs, manifests, events, stats, resume, delegation lineage, checkpoint metadata |
| `M1.2` JSONL Conversation Log | `conversation.jsonl` record model, append/read semantics, crash tolerance | `M1.1` | Session load, summarization coverage, resume, retention, observability backfill |
| `M1.3` Session Manager | Session directory layout, manifest schema, workspace ID, in-memory projection | `M1.1`, `M1.2` | Resume, config snapshots, durable state, file activity persistence, retention, executor/one-shot sessions |
| `M1.4` Provider Interface + NanoGPT Driver | Canonical driver contract, SSE parsing, model capabilities, base error mapping | `M1.1`, `0.3` | TurnEngine LLM calls, token estimation, provider registry, fallback, live model catalogs |
| `M1.5` Tool Runtime Contract | Tool registry, schema validation, timeouts, retries, output caps | `M1.1`, `M1.4` | Every tool implementation, tool error semantics, executor tool behavior, delegated tool flow |
| `M1.6` `read_file` Tool | First file tool, line-range contract, binary/truncation metadata | `M1.5` | File tool conventions, context digests, witness/reviewer evidence gathering, RP/doc workflows |
| `M1.6b` User Interaction Tools | `ask_user`, `confirm_action`, yield outcomes for interaction | `M1.5` | Approval UX, one-shot interaction rules, delegated approval routing, headless invoke behavior |
| `M1.7` Agent Loop / Turn Engine | 12-phase runtime, step/tool loop, yield rules, tool batching | `M1.3`, `M1.4`, `M1.5`, `M1.6` | All runtime behavior: prompts, errors, tool execution, event emission, invoke, one-shot, delegation |
| `M1.8` Basic REPL | Interactive CLI loop, startup path, SIGINT handling | `M1.3`, `M1.4`, `M1.7` | Output routing, slash commands, one-shot evolution, standalone runtime |
| `M1.9` Event System | Typed `events.jsonl`, causal envelopes, event types | `M1.1`, `M1.2`, `M1.7` | SQLite observability, stats, telemetry, cost tracking, debugging |
| `M1.10` Integration Smoke Test | First end-to-end acceptance for M1 | `M1.1-M1.9` | Serves as the baseline contract for later milestone integrations and regressions |

## Milestone 2
Source: [`02-milestone2-tools-perms.md`](../docs/steps/02-milestone2-tools-perms.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M2.1` File System Tools | `write_file`, `edit_file`, `delete_path`, `move_path`, `make_directory`, `stat_path`, `find_paths`, `search_text` | `M1.5`, `M1.6` | Sandbox enforcement, approval classes, context digests, indexing triggers, checkpointing, witness evidence |
| `M2.2` Shell Execution Tools | `exec_command`, persistent shell sessions, process registry | `M1.5` | Risk analysis, approval flow, network shell detection, browser process lifecycle, delegated command execution |
| `M2.3` Command Risk Analyzer | Command classification and risky facet detection | `M2.2` | Approval routing, no-confirm behavior, shell denial semantics, delegated tool approvals |
| `M2.4` Workspace Sandbox | Path-zone boundary, symlink handling, create/open safety | `M2.1` | All mutating file tools, delegated safety posture, browser file output, agent profile trust model |
| `M2.5` Configuration System | 5-source precedence, trusted-workspace filtering, secrets loading, resolved config | `0.2` | Approval, network, telemetry, provider selection, startup defaults, config drift on resume |
| `M2.6` Approval Flow | 7-step tool approval algorithm, session grants, `confirm_always`, `--no-confirm` semantics | `M2.3`, `M2.4`, `M2.5`, `M1.6b` | Interactive writes/exec, invoke auto-approve, delegated approval routing, one-shot execution policy |
| `M2.7` Network Egress Policy Foundation | Core network modes, allow/deny rules, shell network detection | `M2.3`, `M2.5` | Web tools, browser navigation, fetch fallback, shell command gating, telemetry endpoints |
| `M2.8` Secrets Scrubbing Pipeline | Exact-value + baseline pattern scrubbing across tool/output/persistence/render/provider | `M1.2`, `M1.7`, `M1.9`, `M2.5` | Terminal output, conversation/event logs, telemetry, witness reports, web/browser output safety |

## Milestone 3
Source: [`03-milestone3-context-state.md`](../docs/steps/03-milestone3-context-state.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M3.0a` Project Awareness | Root/stack/git detection, ignore rules, project snapshot | `M1.3`, `M2.5` | Prompt context, indexing ignore reuse, invoke prompt, project-level diagnostics |
| `M3.0b` System Prompt Assembly | Shared system/tool/context/history prompt structure and precedence | `M3.0a`, `M1.7`, `M2.x` | Every LLM call, capability health lines, invoke prompt, witness/reviewer/researcher behavior |
| `M3.1` Token Estimation + `estimate_tokens` | Estimator heuristics, calibration in manifest, safe input budget | `M1.4`, `M3.0b` | Context assembly, compression thresholds, invoke sizing, model-capability use |
| `M3.2` Context Assembly Algorithm | Pinned sections, compression tiers, tool digests, newest-first packing | `M3.0a`, `M3.0b`, `M3.1`, `M2.1` | All prompt packing, summary visibility, digest truthfulness, emergency behavior, no-tools flows |
| `M3.3` Compression Tier Actions | Tier-specific prompt trimming rules | `M3.2` | Prompt size, system/tool detail retained, emergency warnings, delegated context quality |
| `M3.4` Summarization | Summary items, coverage map, visible-history replacement | `M1.2`, `M1.4`, `M3.2` | Resume replay, prompt history, coverage-map rebuild, state compression |
| `M3.5` Durable Task State | Manifest-backed task memory and deterministic/LLM updates | `M1.3`, `M1.7`, `M3.4` | Prompt pinned state, working-set exemptions, resume accuracy, loop/blocker tracking |
| `M3.6` FileActivityIndex | Working-set scores, decay, manifest persistence, rebuild-from-log | `M2.1`, `M3.5`, `M1.2` | Prompt working set, resume reconstruction, file-interest ranking, later indexing/research context |
| `M3.7` Session Resume | Rebuild runtime state from log + manifest, config drift warnings | `M1.2`, `M1.3`, `M3.4`, `M3.5`, `M3.6`, `M2.5` | Resume correctness, one-shot resume, stats continuity, observability backfill, checkpoint metadata trust |

## Milestone 4
Source: [`04-milestone4-rendering.md`](../docs/steps/04-milestone4-rendering.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M4.0` Output Channel Contract | stdout/stderr split and output abstractions | `M1.8` | Renderer, one-shot behavior, executor silence guarantees, approval prompt placement |
| `M4.1` Terminal Capabilities | TTY/color/unicode detection and startup freeze | `M4.0` | Renderer formatting, syntax highlight, progress indicators, markdown display |
| `M4.2` Renderer Module | Centralized tool/status/error output | `M4.0`, `M4.1` | Interactive UX, verbose output, later CLI integrations, manual smoke tests |
| `M4.3` Syntax Highlighting | Shiki-backed code rendering | `M4.2` | Markdown rendering, diff display readability, bundled build dependencies |
| `M4.4` Diff Display | Unified diff rendering for file mutations | `M2.1`, `M4.2` | Write/edit UX, checkpoint previews, manual approval trust |
| `M4.5` Progress Indicators | Status line, spinners, progress bars | `M4.0`, `M4.1` | Long-running tool UX, interactive responsiveness, non-TTY fallback behavior |
| `M4.6` Markdown Rendering | Assistant-text formatting pipeline | `M4.2`, `M4.3` | Final assistant output, witness/report readability, one-shot/stdout rendering |

## Milestone 5
Source: [`05-milestone5-provider-obs.md`](../docs/steps/05-milestone5-provider-obs.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M5.1` Full Provider Abstraction | Anthropic/OpenAI drivers, `models.json`, provider registry, `providers[]` selection | `M1.4`, `M2.5` | Fallback chains, cost tracking, live catalogs, executor model selection, witness/provider behavior |
| `M5.2` Provider Features | Extensions, tool emulation, provider fallback chains, `toolReliability` | `M5.1`, `M3.0b` | Non-native tool calls, witness/coder stability, malformed tool parsing, model fallback events |
| `M5.3` SQLite Observability Store | `observability.db`, background writer, JSONL backfill | `M1.3`, `M1.9` | Stats, daily budgets, telemetry, retention, cross-session analytics |
| `M5.4` Cost Tracking + Budget | Cost math, budget enforcement, `/budget extend` | `M5.1`, `M5.3`, `M1.9` | Turn outcomes, stats, one-shot exit semantics, long delegated runs |
| `M5.5` `aca stats` | Analytics CLI over SQLite + session data | `M5.3`, `M5.4` | Operator visibility, budget monitoring, release readiness, performance comparisons |
| `M5.6` Log Retention | Session compression/prune lifecycle with SQLite preservation | `M1.2`, `M1.3`, `M5.3` | Resume availability, disk footprint, pruned analytics behavior |
| `M5.7` Remote Telemetry | Aggregate OTLP metrics export with scrubbed payloads | `M2.8`, `M5.3`, `M5.4` | Public release posture, privacy boundary, observability failure isolation |
| `M5.8` CLI Wiring + Integration Test | First real wiring of M1-M5 into `index.ts` | `M1-M5` | All later runtime work: standalone, invoke, bridge, delegation, witnesses, model catalog startup |

## Milestone 6
Source: [`06-milestone6-indexing.md`](../docs/steps/06-milestone6-indexing.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M6.2` Embedding Model | Local embedding runtime and cache | `0.2` | Semantic search availability, model-cache lifecycle, offline behavior |
| `M6.3` Index Storage | Per-workspace SQLite semantic index | `M1.3`, `M6.2` | Search latency, index persistence, workspace identity sensitivity |
| `M6.4` Indexer | Chunking, symbol extraction, ignore reuse, update triggers, `/reindex` behavior | `M3.0a`, `M2.1`, `M6.2`, `M6.3` | Search quality, startup indexing, write/exec triggers, profile tool usefulness |
| `M6.5` `search_semantic` | Semantic search tool contract and result shape | `M1.5`, `M6.2`, `M6.3`, `M6.4` | Witness/reviewer/researcher tool access, delegated code search, RP research depth |
| `M6.6` CLI Wiring + Integration Test | Index startup wiring and `/reindex` registration | `M5.8`, `M6.2-M6.5` | Runtime index availability, agent prompt access to semantic search |

## Milestone 7A
Source: [`07a-milestone7-error-health.md`](../docs/steps/07a-milestone7-error-health.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M7.7a` Error Taxonomy + LLM Retry Policies | Standardized error codes, retry tables, health state updates, mode-specific formatting | `M1.4`, `M1.7`, `M5.1` | Tool masking, health tracking, delegation error chains, executor JSON errors, timeout semantics |
| `M7.7b` Confusion Limits | Invalid-tool-call counters and `llm.confused` handling | `M1.7`, `M7.7a` | Turn recovery, witness/coder robustness, delegated tool loops, consult stability |
| `M7.13` Capability Health Tracking | Per-session health map and cooldown/circuit-breaker semantics | `M7.7a` | Prompt health lines, tool masking, capability availability decisions, degraded-state UX |
| `M7.7c` Degraded Capability Handling + Tool Masking | Remove unavailable tools from prompts, nested cause chains | `M7.13`, `M7.7a`, `M3.0b` | What models believe is callable, masked-tool validation, delegation root-cause visibility |
| `M7.10` Network Egress Integration | Browser/web policy integration and `network.checked` events | `M2.7`, `M2.3` | Browser/web tools, shell network semantics, network observability |
| `M7.8` Secrets Scrubbing Pattern Detection | Extended secret pattern recognition and allow-list escape hatch | `M2.8` | Web/browser output safety, telemetry, witness/report artifacts, public release safety |

## Milestone 7A.5
Source: [`07a5-milestone7-review-aggregation.md`](../docs/steps/07a5-milestone7-review-aggregation.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M7A.5.1` Structured Witness Finding Schema | Review finding schema and raw-review retention | None explicit; conceptually uses M7A error/report discipline | Aggregation, auditability, evidence links, later consult/report formats |
| `M7A.5.2` Review Aggregator / Watchdog Agent | Dedupe/rank/dissent-preserving aggregation layer | `M7A.5.1` | Claude-facing review compression, consult triage behavior, witness pipeline design |
| `M7A.5.3` Watchdog Model Benchmark Harness | Model-selection harness for aggregation quality | `M7A.5.1`, `M7A.5.2` | Default watchdog/triage model choice, reproducibility of review tooling |
| `M7A.5.4` Claude-Facing Review Report Contract | Stable condensed-report format with raw evidence pointers | `M7A.5.1`, `M7A.5.2` | Human review workflow, later consult markdown output, residual-risk reporting |

## Milestone 7B
Source: [`07b-milestone7-delegation.md`](../docs/steps/07b-milestone7-delegation.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M7.1a` Agent Registry + Profiles | Built-in profiles, narrowing rules, agent identity model | `M2.5` | Delegation permissions, invoke profiles, witness/researcher defaults, M11 peer-profile expansion |
| `M7.1b` `spawn_agent` + Child Sessions | Child session lineage, narrowing intersection, spawn limits, inherited pre-auth | `M7.1a`, `M1.3`, `M2.6` | Sub-agent execution, session lineage, subtree authority, later orchestration |
| `M7.1c` `message_agent` + `await_agent` + Lifecycle | Child progress snapshots and agent communication | `M7.1b` | Multi-agent orchestration, routed user input, progress monitoring, parent-child coordination |
| `M7.2` Sub-Agent Approval Routing | Approval bubbling and subtree/whole-tree grants | `M7.1b`, `M7.1c`, `M2.6` | Delegated writes/exec, headless invoke approvals, parallel agent behavior |

## Milestone 7C
Source: [`07c-milestone7-capabilities.md`](../docs/steps/07c-milestone7-capabilities.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M7.3` LSP Integration | `lsp_query`, lifecycle, routing, health integration | `M7.13`, `M7.7c`, `M3.0a` | Code intelligence, prompt health lines, witness/researcher tool usefulness, digest expectations |
| `M7.4` Browser Automation | Playwright tools, browser process lifecycle, hardened context, external-effects semantics | `M2.2`, `M2.4`, `M2.7`, `M7.13` | Web fallback, network policy, checkpoint warnings, RP/browser workflows |
| `M7.5` Web Capabilities | `web_search`, `fetch_url`, `lookup_docs`, network-aware extraction | `M2.7`, `M7.10`, `M7.4`, `M1.5` | Researcher/witness profiles, consult/web evidence, RP research, docs lookup |
| `M7.6` Checkpointing / Undo | Git shadow refs, per-turn checkpoints, `/undo`, `/restore`, divergence checks | `M1.1`, `M1.3`, `M2.1` | Turn-number correctness, file mutation recovery, browser/exec external-effects warnings |
| `M7.10b` CLI Setup Commands | `aca init/configure/trust/untrust` | `M2.5` | Trusted-workspace flow, config discoverability, setup UX |
| `M7.11` Executor Mode | `aca describe`, `aca invoke`, JSON contracts, ephemeral sessions, authority propagation | `M1.7`, `M2.5`, `M7.1x`, `M5.8` | MCP bridge, witnesses, delegation, RP research, no-tools flows, external orchestration |
| `M7.12` One-Shot Mode | Non-interactive task execution, exit-code mapping, resume+one-shot | `M1.8`, `M2.6`, `M7.11` | Standalone runtime, smoke tests, scripting UX, invoke/CLI parity |
| `M7.14` OpenTelemetry Export | Native OTLP export implementation | `M5.7` | Public observability surface, telemetry cost/latency reporting |
| `M7.15` CLI Wiring + Integration Test | Integrates all M7 systems into runtime | `M7A`, `M7A.5`, `M7B`, `M7C` | Real delegation, browser, web, checkpoint, executor, and one-shot behavior |

## Milestone 8
Source: [`08-milestone8-standalone.md`](../docs/steps/08-milestone8-standalone.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M8.1` Build & Package | Runnable bundled CLI, dist entrypoint, bundled native deps | `M5.8`, `M7.15` | Distribution, `aca serve`, `aca invoke`, smoke-test realism |
| `M8.2` First Real Run | Real NanoGPT runtime verification | `M8.1` | Validates assumptions behind later bridge/delegation milestones |
| `M8.3` Real Tool Execution | Real file/write/exec behavior with live model | `M2.x`, `M5.8`, `M8.2` | Confirms approval, sandbox, scrubbing, and tool/output contracts under live conditions |

## Milestone 9
Source: [`09-milestone9-bridge.md`](../docs/steps/09-milestone9-bridge.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M9.1` MCP Server for ACA | `aca serve`, `aca_run`, subprocess bridge to `aca invoke` | `M7.11`, `M8.1` | Claude/Codex bridge, deadline semantics, subprocess env/cwd/bin resolution |
| `M9.2` Claude Code Integration | External MCP config and delegation skill usage | `M9.1` | Real-world bridge usage, operator ergonomics, but mostly outside tracked ACA runtime |
| `M9.2b` Runtime Bug Hunt & Fix | Fixes invoke/one-shot shared runtime path discovered under MCP use | `M9.1`, `M7.11`, `M1.7` | All invoke consumers, one-shot, session logging correctness, bridge reliability |
| `M9.3` Multi-Agent Orchestration | Parallel `aca_run` usage and synthesis workflow | `M9.1`, `M7.1x` | Sets up M10 delegation and parallel witness/research patterns |
| `M9.3b` Delegated Tool Approval Bug Fix | Headless invoke auto-approval inside allowed tool bounds | `M9.1`, `M2.6`, `M7.11` | Delegated writes/exec, witness ACA mode, self-build viability, RP invoke workflows |

## Milestone 10
Source: [`10-milestone10-payoff.md`](../docs/steps/10-milestone10-payoff.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M10.1` Witness Agents with Tool Access | ACA-mode witnesses, witness profile integration, consult bridge fallback | `M7.1a`, `M7.11`, `M7A.5` | Review quality, grounded evidence, consult workflow shape, witness tool scope |
| `M10.1b` Harden ACA Invoke Pipeline (MCP Spawn Path) | Diagnoses and fixes MCP spawn-path failures | `M9.1` | All `aca_run`-backed delegation, bridge reliability, environment propagation |
| `M10.1c` TurnEngine Error Recovery + Executor Model Selection | Makes non-fatal tool errors recoverable, filters tool defs by allowed set, changes executor model assumptions | `M1.7`, `M5.2`, `M7.11` | Delegated coding stability, witness invoke behavior, model selection, catalog endpoint assumptions |
| `M10.2` First Real Delegated Coding Task | First real coder/witness review workflow | `M10.1c` | Validates delegation end-to-end and exposes practical prompt/tool issues |
| `M10.3` Self-Building: ACA Builds ACA | Open workflow milestone for full delegated implementation/review loop | `M10.1`, `M10.2` | Future process design, milestone execution pattern, review/repair loops |

## Milestone 11
Source: [`11-milestone11-model-utilization.md`](../docs/steps/11-milestone11-model-utilization.md)

| Substep | Introduces / touches | Depends On | Likely downstream impact |
|---|---|---|---|
| `M11.1` Provider-Agnostic Model Catalog | Live model-capability discovery and static fallback | `M5.1`, `M2.5` | Driver limits, startup behavior, witness ceilings, catalog staleness/fallback logic |
| `M11.2` Driver Integration | NanoGPT driver consumes live catalog for caps and request max tokens | `M11.1`, `M1.4` | Actual output ceilings for invoke, witnesses, coder/researcher runs |
| `M11.3` Remove Artificial Ceilings | Changes step-limit/deadline/default-output/api-timeout assumptions | `M7.11`, `M9.1`, `M1.7`, config defaults | Long-running invoke flows, MCP time budgets, runtime safety/cost posture |
| `M11.4` Idle Timeout Formalization | Idle-reset streaming behavior across all drivers | `M1.4`, `M5.1` | Long-running streams, delegated reliability, timeout diagnosis |
| `M11.5` Witness Limit Uplift | Single source of truth for witness configs and real max-token ceilings | `M10.1`, `M11.1`, `M11.2` | ACA consult/witness output depth, config drift between ACA and adapters |
| `M11.6` Invoke Prompt Assembly | Invoke mode starts using real project/tool context instead of a bare prompt | `M3.0a`, `M3.0b`, `M7.11` | Delegated coding, witness/reviewer no-tools behavior, RP researcher reliability |
| `M11.7` Peer Agent Profiles | Fuller coder/witness/reviewer/researcher tool sets, sandbox-over-blocklist philosophy | `M7.1a`, `M6.5`, `M7.3`, `M7.5`, `M2.4`, `M7.11` | Consult scope, researcher scope, safety boundary assumptions, delegated autonomy |
| `M11.8` CLI Wiring + Integration Test | Startup wires live catalogs, prompt assembly, profile changes | `M11.1-M11.7` | Current runtime behavior for invoke, witnesses, startup diagnostics, model-capability use |

## Practical Read For Deep Audits

If you want to audit for rot without starting from scratch, start in this order:

1. `M1.1`, `M1.3`, `M1.7`
2. `M2.5`, `M2.6`
3. `M3.0b`, `M3.2`, `M3.5`, `M3.7`
4. `M5.1`, `M5.2`, `M5.8`
5. `M7.7a`, `M7.13`, `M7.11`, `M7.15`
6. `M9.1`, `M9.3b`
7. `M10.1c`
8. `M11.1`, `M11.3`, `M11.6`, `M11.7`

That order walks the major contracts in the same order the later workflow bugs would have inherited them.
