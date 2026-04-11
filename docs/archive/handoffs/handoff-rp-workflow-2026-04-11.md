# Handoff — RP Workflow Improvements + Trinity Seven Rerun

## Context

Session date: 2026-04-11. All work is on `main`. Several commits were made but NOT pushed (push manually when ready).

---

## What Was Done This Session

### Commits (not yet pushed)
| Commit | Description |
|--------|-------------|
| `9a5c7e7` | `rpProjectRoot` added to config schema — set in `.aca/config.json`, picked up by `aca rp-research` without `--project-root` flag |
| `79237fa` | rp-research invoke deadline bumped from 5 → 15 min |
| `474bc47` | rp-research invoke deadline bumped again to 20 min |
| `be51e18` | Removed all hardcoded `maxToolCalls` caps from rp-research — deadline is the only constraint now |

### Commits (already pushed)
| Commit | Description |
|--------|-------------|
| `7ff9b09` | README rewritten to reflect M1–M11 complete state |
| `a9c3e8a` | `aca rp-research --help` description explains the full two-phase workflow and timeline pause |
| `e2784d8` | `aca init` now defaults model to `zai-org/glm-5` in generated config |

### Local config (gitignored, not committed)
- `/home/blake/projects/anothercodingagent/.aca/config.json` — has `rpProjectRoot: "/home/blake/projects/rpproject"` set

### RP packs generated
- **Oshi no Ko** — complete, 17 files at `/home/blake/projects/rpproject/oshi-no-ko/`
- **Trinity Seven** — complete but INCOMPLETE character coverage (see below)

---

## Open Task: Redo Trinity Seven

### Problem
Trinity Seven generated 14 character files but missed notable characters including **Sora** (Arata's grimoire, present in nearly every scene), Cain Kamiyama, Ilias Fragment, and others. Root cause: the discovery agent hit the `maxToolCalls` cap (32 at the time) before fully enumerating the character category.

### Fix already applied
`maxToolCalls` caps are now removed (`be51e18`). Discovery can browse as many wiki pages as it needs within the 20-minute deadline.

### What to do
1. **Delete** the existing Trinity Seven folder:
   ```bash
   rm -rf /home/blake/projects/rpproject/trinity-seven
   ```
2. **Rerun** with blank timeline:
   ```bash
   node /home/blake/projects/anothercodingagent/dist/index.js rp-research "Trinity Seven" --network-mode open
   ```
3. Wait for timeline options, choose **blank**, then run full generation:
   ```bash
   node /home/blake/projects/anothercodingagent/dist/index.js rp-research "Trinity Seven" --network-mode open --blank-timeline
   ```

---

## Open Task: Strengthen Discovery for Full Character + Location Coverage

### Problem
The discovery prompt doesn't explicitly tell the agent to exhaust the wiki character category before writing the manifest. It says to use `fetch_mediawiki_category` but doesn't enforce "get ALL characters listed before deciding coverage."

### What to change
In `src/cli/rp-research.ts`, `buildDiscoveryTask()` — add explicit instruction after the `fetch_mediawiki_category` guidance line (around line 425):

> "Before writing the manifest, fetch the series character category page and enumerate every named character listed. Do not stop at the first page — if the category has more entries, fetch additional pages. Only after you have a complete character list should you decide which tier (main/side/minor) each belongs to."

Similarly for locations:
> "Fetch the locations category if one exists and enumerate all named locations before deciding which to include."

The goal: discovery always produces an exhaustive manifest, not a best-effort one that stops when it runs out of tool calls.

### File
`src/cli/rp-research.ts` — `buildDiscoveryTask()` function, around line 395–470.

---

## How to Run RP Research Going Forward

```bash
# From the ACA project dir (rpProjectRoot is set in .aca/config.json — no --project-root needed)
node dist/index.js rp-research "Series Name" --network-mode open
# → pauses after discovery for timeline selection
# → rerun with --blank-timeline or --timeline <id>
node dist/index.js rp-research "Series Name" --network-mode open --blank-timeline
```

Default model: `zai-org/glm-5` (set in `.aca/config.json`).
Default deadline: 20 minutes per invoke (discovery + each generation task).
No tool call cap — deadline is the only constraint.
