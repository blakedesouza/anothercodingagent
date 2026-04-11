# M7.10b Handoff — CLI Setup Commands (Block 10)

**Date:** 2026-04-04
**Status:** M7.6 complete. Ready for M7.10b.

## What's Done (M7.6)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| CheckpointManager (git shadow refs, plumbing) | Complete | 20 |
| /undo, /restore, /checkpoints slash commands | Complete | 11 |
| TurnEngine checkpoint hooks | Complete | — (integration) |
| index.ts wiring | Complete | — |
| Temp index randomUUID fix (P0 consultation) | Complete | — |
| **Total** | **M7.6 complete** | **31 new, 2059 total** |

## What to Do Next (M7.10b)

From `docs/steps/07c-milestone7-capabilities.md`:

- `aca init`: create `~/.aca/` directory structure, `secrets.json` with restricted permissions (POSIX: `0600`; Windows: owner-only ACL via `icacls`), initial `config.json`
- `aca configure`: interactive configuration wizard (use `@inquirer/prompts` for structured prompts)
- `aca trust [path]`: mark workspace as trusted in `~/.aca/config.json` `trustedWorkspaces` map
- `aca untrust [path]`: remove workspace trust

## Dependencies

- M2.5: Configuration System (`src/config/loader.ts`, `src/config/schema.ts`)
- M2.5: Secrets loading (`src/config/secrets.ts`)
- Commander CLI framework (already in `src/index.ts`)

## File Locations

- CLI entry point: `src/index.ts` (add subcommands)
- Config loader: `src/config/loader.ts`
- Config schema: `src/config/schema.ts`
- Secrets: `src/config/secrets.ts`
- Suggested new: `src/cli/setup.ts` (init, configure, trust, untrust commands)
