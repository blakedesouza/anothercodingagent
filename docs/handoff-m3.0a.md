# M3.0a Handoff — Project Awareness

**Date:** 2026-03-30
**Status:** M2.8 complete. Ready for M3.0a.

## What's Done (M2.8)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| SecretPattern interface | Complete | — |
| SecretScrubber class (Strategy 1: exact-value) | Complete | 8 |
| Strategy 2 baseline: sk-, pk_test_, AKIA, ghp_, ghs_, glpat- | Complete | 6 |
| Strategy 2 baseline: Bearer tokens (case-insensitive) | Complete | 2 |
| Strategy 2 baseline: PEM private keys | Complete | 1 |
| Stable redaction IDs (same secret → same placeholder) | Complete | 2 |
| scrubbing.enabled: false → passthrough | Complete | 3 |
| Point 1: tool output (data + error.message) | Complete | 2 |
| Point 2: LLM context (user messages + tool results) | Complete | 1 |
| Point 3: JSONL persistence (ConversationWriter) | Complete | 2 |
| Point 4: terminal delta (with known-limitation TODO) | Complete | 1 |

**Total tests: 573 passing** (547 prior + 26 new).

**Consultation:** 4/4 witnesses, 2 fixes applied (Bearer `i` flag, error-path scrubbing).

**Known limitation:** Streaming terminal (Point 4) doesn't catch secrets split across chunk boundaries. Deferred to M7.8 (sliding-window buffer).

## What to Do Next (M3.0a)

Implement Project Awareness (Block 12). This is a prerequisite for M3.0b (System Prompt Assembly) which needs the project snapshot.

### What to Build

- Root detection: walk up from cwd, find `.git/` or language-specific root files (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`)
- Language/toolchain detection: root markers + lockfiles → stack summary
- Git state: branch, dirty/clean, staged changes
- `ProjectSnapshot` type: root, stack, git, ignorePaths, indexStatus
- Context injection: ~5-8 line compact text block for LLM
- Ignore rules: `.gitignore` + hardcoded (`.git/`, `node_modules/`, `dist/`, `build/`, `coverage/`)

### Key Test Cases

- Directory with `.git/` → root detected correctly
- Directory with `package.json` but no `.git/` → root at package.json
- Stack detection: `pnpm-lock.yaml` present → "pnpm" in stack
- Git state: dirty repo → `dirty` in snapshot. Clean → `clean`
- Ignore rules: `node_modules/` always ignored by find/search defaults
- Context rendering: snapshot → compact text < 200 tokens

## Dependencies

- No new source dependencies. Uses Node.js `fs`, `child_process` (for `git` commands).
- M2.5 config (`project.ignorePaths`) can supplement ignore rules.

## File Locations

| File | Purpose |
|------|---------|
| `src/core/project-awareness.ts` | Root detection, stack detection, git state, ProjectSnapshot |
| `test/core/project-awareness.test.ts` | All project awareness tests |
