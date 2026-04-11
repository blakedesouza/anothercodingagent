# Handoff — Rent-A-Girlfriend Run

## Context

Session date: 2026-04-11. All work is on `main`. Commits from this session are NOT yet pushed — push manually when ready.

---

## What Was Done This Session

### Commits (not yet pushed)
| Commit | Description |
|--------|-------------|
| `6e53463` | Skip-if-exists at world/location/character dispatch; forced-write retry preamble; protocol error language in all task prompts |
| `84cbb35` | Fixed the retry logic: `required_outputs_missing` and `profile_validation_failed` now actually trigger the forced-write retry (previously only LLM infra errors did) |

### Trinity Seven — COMPLETE
Full pack at `/home/blake/projects/rpproject/trinity-seven/`:
- 2 world files, 3 location files, 15 character files
- All 20 files generated and validated
- Canon spelling fixes applied manually: `Impero` → `Imperium`, `Exspecto` → `Expectatio`

### Why these fixes matter
GLM-5 has a pattern of announcing intent ("Writing the file now.") as text and stopping without calling `write_file`. Three fixes now address this:
1. **Skip-if-exists** — reruns only retry missing files, not everything
2. **Forced-write retry** — when a file fails, attempt 2 starts with "your FIRST tool call MUST be `write_file`"
3. **Protocol error language** — every task prompt now explicitly labels text-only announcements as protocol errors

In the Trinity Seven run: 5 of 16 files needed the retry; all succeeded. Zero manual reruns required.

---

## Next Task: Run Rent-A-Girlfriend

### Command
```bash
# From the ACA project dir (rpProjectRoot set in .aca/config.json — no --project-root needed)
node dist/index.js rp-research "Rent-A-Girlfriend" --network-mode open --blank-timeline
```

Default model: `zai-org/glm-5`
Default deadline: 20 minutes per invoke
No tool call cap — deadline is the only constraint
Skip-if-exists is active — safe to rerun if anything fails

### What to watch for
- If any character or location files fail after 2 attempts, just rerun the command — skip-if-exists means only the missing files will be retried
- The series has a large cast; expect 15-25 character files
- Main characters: Kazuya Kinoshita, Chizuru Mizuhara, Ruka Sarashina, Sumi Sakurasawa, Mami Nanami
- Discovery will enumerate the wiki character category — with no tool call cap it should get full coverage this time

### If discovery finds no wiki
If the Trinity Seven wiki (`trinityseven.fandom.com`) was used as the source, Rent-A-Girlfriend's wiki is at `rentakanojo.fandom.com`. The discovery agent should find it automatically with `--network-mode open`.

---

## How Reruns Work (for reference)

If the run fails partway:
1. **Do not delete the series folder** — skip-if-exists will handle it
2. Just rerun the same command
3. Only missing files will be generated; existing valid files are skipped

---

## Unpushed Commits (full list from both sessions)

| Commit | Description |
|--------|-------------|
| `84cbb35` | fix: required_outputs_missing and profile_validation_failed trigger forced-write retry |
| `6e53463` | fix: skip-if-exists dispatch, forced-write retry, protocol error in task prompts |
| `79da43a` | docs: handoff — rp workflow session 2026-04-11 |
| `be51e18` | fix: remove hardcoded maxToolCalls caps from rp-research |
| `474bc47` | fix: increase rp-research invoke deadline to 20 minutes |
| `79237fa` | fix: increase rp-research invoke deadline from 5 to 15 minutes |
| `9a5c7e7` | feat: add rpProjectRoot to config schema |

Push all of these when ready: `git push`
