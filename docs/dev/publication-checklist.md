# Publication Checklist

Use this before pushing ACA as a public GitHub repository or linking it from a website.

## Required

- [ ] Review `git status --short` and commit only intended files.
- [ ] Confirm no local runtime folders are tracked: `.aca/`, `.claude/`, `.codex`, `.mcp.json`.
- [ ] Confirm no generated RP artifacts are tracked under the ACA repo.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `npm test`.
- [ ] Run `npm run lint` or document any pre-existing lint failures.
- [ ] Search for secrets and local paths before publishing.
- [ ] Read the root `README.md` as a first-time user.
- [ ] Make the GitHub description explicit: "Experimental local-first coding agent CLI."
- [ ] Mark the release/status as WIP or experimental in any website link text.

## Recommended

- [ ] Make a clean checkpoint commit before larger doc rewrites.
- [ ] Keep internal handoff docs, but do not present them as the user guide.
- [ ] Add a GitHub repository URL to `package.json` after the remote exists.
- [x] Add a license before inviting outside use.
- [ ] Add screenshots or examples only after the command surfaces stabilize.
