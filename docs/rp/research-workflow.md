# RP Research Workflow

This is the durable workflow note for ACA-native RP lore research.

## Current Direction

Use the `rp-researcher` profile in `src/delegation/agent-registry.ts` for anime, manga, VN, and related canon research. Choose the model explicitly for the corpus and trust level you need.

The core rule is:

```text
Discovery first. Then one deep research/write invocation per character or world file.
Do not write one compact global research brief and then ask the model to synthesize everything from that.
```

The formal authoring source of truth for the generated pack now lives in [authoring-contract.md](authoring-contract.md).

Working implications:

- final files should provide shape, not guidance
- character profiles carry the main portrayal burden
- `world.md` and `world-rules.md` are support layers, not overflow bins for characterization or narrator coaching
- final RP files should stay factual and declarative rather than telling the model how to roleplay

## Workflow

1. Run a discovery pass.
   - Crawl MediaWiki/Fandom categories and important index pages.
   - Produce the cast/topic list and exact output file plan.
   - Do not write final character files in this pass.

2. Assign tiers.
   - Main characters: depth ceiling around 16-20 KB.
   - Side characters: depth ceiling around 8-12 KB.
   - Very minor/supporting characters: depth ceiling around 4-8 KB.
   - These are ceilings, not floors. Do not pad sparse characters when canon material is thin.

3. Generate one file per invocation.
   - Give each agent one exact output target, such as `world/characters/arata-kasuga.md`.
   - Keep output paths disjoint.
   - Use `ACA_NETWORK_MODE=open` only for trusted research runs where broad network access is intentional.
   - The current wrapper does not auto-save the final assistant Markdown into the assigned file for you. Keep `write_file` available and require exact output paths so ACA must create the file itself before the run can pass.

4. Keep relationships compact.
   - Include only relationships that materially affect how the character behaves.
   - Use 1-2 sentences per relationship.
   - Normal cap: 3-6 important dynamics.
   - Main-character exception: up to about 8 dynamics.
   - Put complex group dynamics in a world/group file instead of expanding every character file.

5. Keep the files RP-useful without over-templating.
   - Avoid mandatory headings like `RP Use`, `RP Notes`, `Knowledge and Secrets`, `Spoiler Notes`, and `Current Status`.
   - Do not write narrator guidance, tone guidance, spoiler/timeline constraints, or `normal/unusual/forbidden` taxonomies into the final RP-facing files.
   - Do not let `world.md` or `world-rules.md` absorb material that belongs in character or location files.
   - Do not create `instructions.md` files for general compendium research.
   - Avoid Japanese script or unnecessary Japanese terminology by default. Only include original-language text when needed to disambiguate an ability, skill, magic name, title, or user-requested term.

6. Verify after each batch.
   - Required file exists and is non-empty.
   - File is within its tier ceiling or intentionally short due to sparse material.
   - No banned headings.
   - No unnecessary Japanese script.
   - Relationships are compact.
   - No accidental `instructions.md`.

7. Use small repair passes.
   - If a file is too short and canon material exists, expand once.
   - If a file exceeds the ceiling, compress once.
   - Stop after one repair pass unless the user asks to keep iterating.

## Tool Availability Notes

- `web_search` is optional enhancement, not a hard dependency. If Tavily or another search provider is not configured, switch immediately to direct `fetch_mediawiki_page` / `fetch_mediawiki_category` calls against the relevant `api.php`.
- `fetch_url` is also optional for Fandom-heavy runs. Prefer MediaWiki API fetches first; use `fetch_url` only when you specifically need rendered HTML or a non-MediaWiki source.
- When using `fetch_mediawiki_category`, pass numeric limits such as `25` or `50`, not quoted strings.
- Discovery runs should stop once they can name the candidate files, best source pages, and exact output paths. Do not burn the whole budget crawling every linked character page in the franchise.

## Concurrency

Sequential generation is safest. Once the workflow is stable, run 2-3 agents at a time with disjoint output paths:

```text
Batch 1: character A, character B
Batch 2: character C, character D
```

Start with concurrency 2. Use concurrency 3 only when network/tool behavior is stable for the target series.

## Empirical Notes

Long-context research models can handle larger source-gathering budgets, but they still should not be treated as uncapped. Give them a larger bounded leash instead.

The mixed prompt shape "research for a long time, then call `write_file`" can be unreliable: models may research well and then finalize without writing the required file. Required-output validation catches this. Saving the final answer to the exact output path from the orchestrator is a better shape for deep per-file generation.

Consult/witness/triage code does not need a separate RP path. Use the existing consult path to review generated docs after the files exist.

## Future Product Work

Turn this into a first-class ACA command, likely:

```bash
aca rp-research "<series>" --project-dir <rp-project>
```

The command should own discovery, dynamic batch planning, per-file generation, concurrency caps, size/style validation, repair passes, and result artifacts. Local Claude/Codex skills should remain thin adapters only.
