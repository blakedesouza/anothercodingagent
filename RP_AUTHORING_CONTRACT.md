# RP Knowledge Pack Authoring Contract

Status: active `C6` contract for ACA-native RP imports

This contract defines how ACA should author canon-derived RP knowledge packs when the user says to research a series for RP.

The target output is an LLM-facing RP substrate for OC sessions. It is not a fandom encyclopedia, not narrator coaching, and not a prompt full of roleplay instructions.

## Core Rule

Final RP files must provide shape, not guidance.

They should describe what is true about the people, places, and setting so the model can infer how to roleplay from that shape. They should not tell the model how to narrate, what tone to adopt, or how the world should be interpreted.

Working split:

- the hidden workflow may constrain generation
- the review rubric may reject bad output
- the final RP pack itself should describe facts and portrayal only

## Output Contract

Per imported series, ACA should create:

- `research/`
- `world/world.md`
- `world/world-rules.md`
- `world/characters/*.md`
- `world/locations/*.md`

`research/` is support material. The RP-facing payload is the `world/` tree.

## Placement Rules

Put facts where they belong.

- If a fact primarily belongs to one person, put it in that character profile.
- If a fact primarily belongs to one place, put it in that location file.
- Put something in `world/world.md` only when it is broad setting context, stable background, or pre-arc context that materially shapes the setting as a whole.
- Put something in `world/world-rules.md` only when it is a cross-cutting factual rule, mechanic, constraint, or condition that does not fit more naturally in a character or location file.

Character profiles are the primary vehicle of the RP pack. `world.md` and `world-rules.md` are support layers, not dumping grounds for characterization, narrator steering, or padding.

## Truth Rules

Final RP files should be declarative and factual.

- State what is true.
- State how the setting works.
- State who the character is.
- Omit speculation, hedging, and advice unless the canon itself is genuinely unresolved.

If a fact is unresolved or timeline-dependent:

- prefer timeline scoping in the workflow layer
- otherwise leave it out of the final file
- do not paper over it with soft guidance language

Bad pattern:

- "The world treats this as unusual."

Preferred pattern:

- describe the actual taboo, rule, institution, or social consequence as a fact, or omit it if it does not materially belong in the pack

## Character Contract

Character files carry the real weight of the RP pack.

The contract locks the section concepts. The current runtime heading spellings are:

- `Basic Info`
- `Role`
- `Affiliation`
- `Appearance`
- `Personality`
- `Powers`
- `Weapons`
- `Relationships`
- `Speaking Style`

Those heading names may evolve later, but only with synchronized schema, example, and workflow updates.

Rules:

- Use only the approved section concepts.
- Do not add extra sections to compensate for weak writing.
- If a section is not applicable, omit it and deepen the remaining valid sections instead.
- Main and recurring side characters belong in the same `world/characters/` directory.
- Significant recurring characters should receive profiles, with depth scaled by importance rather than by invented extra headings.

### Character Writing Rules

Faithful portrayal comes before "easy RP usability."

- Do not reduce personality to adjective stacks.
- Do not reduce personality to trope labels with extra padding.
- Do not turn the character into a behavior script.
- Write `Personality` as a behavioral portrait with context, tension, and range.
- Show how the character comes across at first, what sits underneath that surface, what pressures or embarrasses them, where they are rigid, where they soften, and how they vary by situation or person.
- Write `Relationships` compactly: usually 1-2 sentences each, 3 only for a major relationship.
- Write `Speaking Style` as observed voice and conversational habits that help distinguish the character, not as instructions to the model.

The goal is to preserve a recognizable person with shape, not to hand the model a permanent emotional setting.

## World Contract

`world/world.md` is the greater world.

It should cover:

- what the setting is
- what broadly exists in it
- stable background
- relevant pre-arc history when that history materially shapes the setting
- chosen-arc context only when the pack is explicitly scoped to that arc

It should not become:

- a plot synopsis
- a timeline dump
- a side-character overflow file
- a location collection
- a narrator-guidance document

## World-Rules Contract

`world/world-rules.md` is mandatory, but it may be brief.

It should contain only factual cross-cutting rules that matter to roleplay and do not fit more naturally elsewhere.

Valid examples:

- power-system mechanics
- institutional constraints
- public rules or taboos
- special conditions that govern how the setting works
- a brief shared fact that affects multiple characters, when that fact is also individualized inside the character files

It should not contain:

- narrator guidance
- tone guidance
- spoiler or timeline constraints
- "what the world treats as normal / unusual / forbidden" taxonomies
- genre explanation that strong files already imply
- redundant character interpretation that belongs in the profiles

## Location Contract

Location files should stay factual and tight.

Each `world/locations/*.md` file should contain:

- the location itself
- a concise description of what it is
- relevant background only when that background materially explains why the place matters
- notable sublocations or points of interest

It should not contain:

- daily routine
- beat-by-beat usage
- ambient filler for its own sake
- generic scene advice

## Timeline Contract

Timeline controls belong in the workflow, not in the final RP files.

The workflow should research major arcs before generation, then either:

- ask the operator to choose a timeline
- or keep the pack timeline-neutral

Timeline-neutral does not mean incompatible arc states may be merged together freely. If a fact materially changes by arc, the workflow should scope it or leave it out.

Final files should not contain spoiler-management notes or timeline-guardrail prose.

## Forbidden Patterns In Final Files

Do not include any of the following in the RP-facing pack unless a user explicitly requests them for a special case:

- narrator guidance
- tone guidance
- roleplay advice to the model
- spoiler or timeline constraints
- `normal / unusual / forbidden` style taxonomies
- genre explanation that is not itself a factual part of the setting
- RP hooks
- creeping plot lines
- encyclopedia padding
- trait-stack characterization

## Review Rubric

Every generated RP-facing file should be reviewable against these questions:

1. Is this written as fact rather than guidance?
2. Is this fact in the right file?
3. Does the file add shape instead of steering?
4. Is the character still a person with range, not a trait loop?
5. Did `world.md` or `world-rules.md` absorb material that should have become a character or location file?
6. Did the file stay inside the approved section concepts without inventing extra headings?

If the answer to any of those is "no," regenerate or repair the file instead of accepting drift.
