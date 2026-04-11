# C6 Handoff — Quintessential Quintuplets RP Pack Regen

Date: 2026-04-10

## State

C7 is closed. C6 is the active track.

The previous Quints draft was reviewed by the operator, found to be over-padded and full of narrator guidance, and archived. The live folder was cleared. Regeneration starts from scratch under the authoring contract.

## Key Paths

| Item | Path |
|---|---|
| Output root | `/home/blake/projects/rpproject/the-quintessential-quintuplets/` |
| Archived draft | `/home/blake/projects/rpproject/_archive/the-quintessential-quintuplets-c6-pre-regen-2026-04-09/` |
| Authoring contract | `/home/blake/projects/anothercodingagent/RP_AUTHORING_CONTRACT.md` |
| Workflow doc | `/home/blake/projects/anothercodingagent/RP_RESEARCH_WORKFLOW.md` |
| ACA binary | `/home/blake/projects/anothercodingagent/dist/index.js` |
| Example pack | `/home/blake/projects/rpproject/EXAMPLE/` |

## What Changed From The Previous Draft

The archived `world/review.txt` documents the operator's full feedback. Summary:

- `world.md` absorbed character family info, tutor arrangement mechanics, backstory — all wrong. Should be lean setting backdrop only.
- `world-rules.md` had narrator guidance, genre explanation, `normal/unusual/forbidden` taxonomy, spoiler constraints — all forbidden by the authoring contract.
- Characters were not written yet — that was the next step.
- The core rule: if it can be derived from doing the character profiles correctly and in depth, it does not go anywhere else.

## Authoring Contract — Key Rules

Read `RP_AUTHORING_CONTRACT.md` in full before generating anything. Short version:

**world.md:** Setting backdrop, stable background, pre-arc history that shapes the world as a whole. Not a plot synopsis, not a character overflow bin.

**world-rules.md:** Cross-cutting factual rules only — institutional constraints, school structure, household autonomy context. Nothing that belongs in a character file. No narrator guidance, no tone guidance, no taxonomies.

**Characters:** Every significant character gets a profile in `world/characters/`. Approved sections only: `Basic Info`, `Role`, `Affiliation`, `Appearance`, `Personality`, `Powers`, `Weapons`, `Relationships`, `Speaking Style`. Omit non-applicable sections. Do not invent extra headings. Personality is a behavioral portrait, not an adjective stack. Relationships: 1–2 sentences each, 3 max for major ones.

**Locations:** What it is, why it matters, notable sub-areas. No daily routine, no filler.

**Forbidden in all final files:** narrator guidance, tone guidance, RP hooks, spoiler/timeline constraints, `normal/unusual/forbidden` taxonomies, genre explanation, encyclopedia padding.

## Timeline

Blank/neutral: Futaro has just begun tutoring. No major romantic developments. Operator may change this — ask before generating character files if unclear.

## Model

`zai-org/glm-5` — pinned for all rp-researcher invocations.

## File Plan (from archived discovery manifest + operator review)

Based on the archived `research/discovery-manifest.json`:

**World files:**
- `world/world.md`
- `world/world-rules.md`

**Location files:**
- `world/locations/asahiyama-high-school.md`
- `world/locations/nakano-penthouse.md`

**Character files (main — 16–20 KB ceiling):**
- `world/characters/futaro-uesugi.md`
- `world/characters/ichika-nakano.md`
- `world/characters/nino-nakano.md`
- `world/characters/miku-nakano.md`
- `world/characters/yotsuba-nakano.md`
- `world/characters/itsuki-nakano.md`

**Character files (side — 8–12 KB ceiling):**
- `world/characters/raiha-uesugi.md`
- `world/characters/maruo-nakano.md`

**Character files (minor — 4–8 KB ceiling):**
- `world/characters/isanari-uesugi.md`
- `world/characters/rena-nakano.md`

**Research support:**
- `research/discovery-manifest.json`
- `research/discovery-plan.md`

Total: 14 final files.

## Invoke Command Shape

Run from `cwd = /home/blake/projects/rpproject/the-quintessential-quintuplets/`.

```bash
ACA_NETWORK_MODE=open node /home/blake/projects/anothercodingagent/dist/index.js invoke <<'ENDJSON'
{
  "contract_version": "1.0.0",
  "schema_version": "1.1.0",
  "task": "<task text here>",
  "context": {
    "model": "zai-org/glm-5",
    "profile": "rp-researcher"
  },
  "constraints": {
    "max_steps": 50,
    "max_tool_calls": 80,
    "required_output_paths": ["<relative output path>"],
    "fail_on_rejected_tool_calls": true
  },
  "authority": [
    {"tool": "read_file", "decision": "approve"},
    {"tool": "find_paths", "decision": "approve"},
    {"tool": "search_text", "decision": "approve"},
    {"tool": "make_directory", "decision": "approve"},
    {"tool": "write_file", "decision": "approve"},
    {"tool": "web_search", "decision": "approve"},
    {"tool": "fetch_url", "decision": "approve"},
    {"tool": "fetch_mediawiki_page", "decision": "approve"},
    {"tool": "fetch_mediawiki_category", "decision": "approve"}
  ],
  "deadline": 900000
}
ENDJSON
```

For the **discovery pass**, omit `required_output_paths` or set it to `["research/discovery-manifest.json", "research/discovery-plan.md"]`. No character or world files are written in the discovery pass.

For **character/world file passes**, set `required_output_paths` to the single target file. Run 2 at a time with disjoint paths.

## Batch Execution Order

1. Discovery pass (single invoke) — writes `research/`
2. `world/world.md` + `world/world-rules.md`
3. `world/characters/ichika-nakano.md` + `world/characters/nino-nakano.md`
4. `world/characters/miku-nakano.md` + `world/characters/yotsuba-nakano.md`
5. `world/characters/itsuki-nakano.md` + `world/characters/futaro-uesugi.md`
6. `world/characters/raiha-uesugi.md` + `world/characters/maruo-nakano.md`
7. `world/characters/isanari-uesugi.md` + `world/characters/rena-nakano.md`
8. `world/locations/asahiyama-high-school.md` + `world/locations/nakano-penthouse.md`

After each batch: verify files exist, are non-empty, are within tier ceiling, contain no banned headings.

## Verification Checklist Per File

- [ ] File exists and is non-empty
- [ ] Within tier size ceiling (or intentionally short due to sparse material)
- [ ] No banned headings: `RP Use`, `RP Notes`, `Knowledge and Secrets`, `Spoiler Notes`, `Current Status`, `Narrator Guidance`, `Narrator Constraints`
- [ ] No narrator guidance prose anywhere in the file
- [ ] No `normal/unusual/forbidden` taxonomy
- [ ] Relationships are compact (1–2 sentences each)
- [ ] No accidental `instructions.md`
- [ ] Character files: only approved section concepts used

---

## Inline Prompt (Copy-Paste)

The block below is a self-contained prompt for a new session to execute the C6 Quints regen.

---

```
You are picking up C6 — the Quintessential Quintuplets RP knowledge pack regen.

C7 (forced tool emulation hardening) is closed. C6 is the active track.

## Your job

Generate a complete RP knowledge pack for the anime version of The Quintessential Quintuplets using ACA's rp-researcher profile via `aca invoke`. The pack goes into:

  /home/blake/projects/rpproject/the-quintessential-quintuplets/

The previous draft was archived and the live folder was cleared. You are starting from scratch.

## Authoring contract

Read this first before generating anything:

  /home/blake/projects/anothercodingagent/RP_AUTHORING_CONTRACT.md

Also read:

  /home/blake/projects/anothercodingagent/RP_RESEARCH_WORKFLOW.md
  /home/blake/projects/rpproject/_archive/the-quintessential-quintuplets-c6-pre-regen-2026-04-09/world/review.txt
  /home/blake/projects/rpproject/EXAMPLE/

The EXAMPLE folder shows the target shape. The review.txt shows exactly what went wrong in the previous draft.

## Core rules (summary)

- world.md = lean setting backdrop only. Not characters, not locations, not narrator guidance.
- world-rules.md = cross-cutting factual rules only. No narrator guidance, no tone guidance, no taxonomies.
- Characters = every significant character in world/characters/. Approved sections: Basic Info, Role, Affiliation, Appearance, Personality, Powers, Weapons, Relationships, Speaking Style. Omit non-applicable sections. No extra headings.
- Personality = behavioral portrait with range and tension. Not an adjective stack.
- Relationships = 1–2 sentences each, 3 max for major ones.
- Locations = what it is, why it matters, notable sub-areas. No filler.
- FORBIDDEN in all final files: narrator guidance, tone guidance, RP hooks, spoiler/timeline constraints, normal/unusual/forbidden taxonomies, genre explanation.

## Model and settings

- Model: zai-org/glm-5 (pinned)
- ACA binary: /home/blake/projects/anothercodingagent/dist/index.js
- Network mode: ACA_NETWORK_MODE=open
- Run invoke from cwd: /home/blake/projects/rpproject/the-quintessential-quintuplets/
- Source: anime version only (not manga)
- Timeline: blank/neutral (tutor just arrived, no romance yet) — confirm with operator before generating character files if there's any doubt

## File plan

world/world.md
world/world-rules.md
world/locations/asahiyama-high-school.md
world/locations/nakano-penthouse.md
world/characters/futaro-uesugi.md       (main — 16-20 KB ceiling)
world/characters/ichika-nakano.md       (main — 16-20 KB ceiling)
world/characters/nino-nakano.md         (main — 16-20 KB ceiling)
world/characters/miku-nakano.md         (main — 16-20 KB ceiling)
world/characters/yotsuba-nakano.md      (main — 16-20 KB ceiling)
world/characters/itsuki-nakano.md       (main — 16-20 KB ceiling)
world/characters/raiha-uesugi.md        (side — 8-12 KB ceiling)
world/characters/maruo-nakano.md        (side — 8-12 KB ceiling)
world/characters/isanari-uesugi.md      (minor — 4-8 KB ceiling)
world/characters/rena-nakano.md         (minor — 4-8 KB ceiling)
research/discovery-manifest.json
research/discovery-plan.md

## Invoke command shape

Run from cwd = /home/blake/projects/rpproject/the-quintessential-quintuplets/

ACA_NETWORK_MODE=open node /home/blake/projects/anothercodingagent/dist/index.js invoke <<'ENDJSON'
{
  "contract_version": "1.0.0",
  "schema_version": "1.1.0",
  "task": "<task text>",
  "context": {
    "model": "zai-org/glm-5",
    "profile": "rp-researcher"
  },
  "constraints": {
    "max_steps": 50,
    "max_tool_calls": 80,
    "required_output_paths": ["<relative path>"],
    "fail_on_rejected_tool_calls": true
  },
  "authority": [
    {"tool": "read_file", "decision": "approve"},
    {"tool": "find_paths", "decision": "approve"},
    {"tool": "search_text", "decision": "approve"},
    {"tool": "make_directory", "decision": "approve"},
    {"tool": "write_file", "decision": "approve"},
    {"tool": "web_search", "decision": "approve"},
    {"tool": "fetch_url", "decision": "approve"},
    {"tool": "fetch_mediawiki_page", "decision": "approve"},
    {"tool": "fetch_mediawiki_category", "decision": "approve"}
  ],
  "deadline": 900000
}
ENDJSON

## Execution order

1. Discovery pass — single invoke, writes research/discovery-manifest.json and research/discovery-plan.md. Required output: both research files. Do not write any character or world files yet.

2. Show the operator the discovery output and confirm timeline before proceeding.

3. Generate 2 files at a time with disjoint output paths:
   Batch 2: world/world.md + world/world-rules.md
   Batch 3: world/characters/ichika-nakano.md + world/characters/nino-nakano.md
   Batch 4: world/characters/miku-nakano.md + world/characters/yotsuba-nakano.md
   Batch 5: world/characters/itsuki-nakano.md + world/characters/futaro-uesugi.md
   Batch 6: world/characters/raiha-uesugi.md + world/characters/maruo-nakano.md
   Batch 7: world/characters/isanari-uesugi.md + world/characters/rena-nakano.md
   Batch 8: world/locations/asahiyama-high-school.md + world/locations/nakano-penthouse.md

## After each batch verify

- File exists and is non-empty
- Within tier size ceiling
- No banned headings (RP Use, RP Notes, Spoiler Notes, Current Status, Narrator Guidance, Narrator Constraints, normal/unusual/forbidden)
- Relationships are compact
- Character files use only approved section concepts

## C6 closes when

The operator reviews the full pack and approves depth and width. One repair pass is allowed per file if the operator requests it.
```
