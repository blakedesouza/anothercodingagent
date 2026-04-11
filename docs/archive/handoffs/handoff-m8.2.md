# M8.2 Handoff — First Real Run

**Date:** 2026-04-04
**Status:** M8.1 complete. Ready for M8.2.

## What's Done (M8.1)

| Deliverable | Status | Tests |
|-------------|--------|-------|
| tsup build (422KB ESM) | Complete | 2 |
| Shebang in dist/index.js | Complete | 1 |
| --version / --help | Complete | 2 |
| describe --json | Complete | 1 |
| models.json static import fix | Complete | 1 |
| Dev mode (tsx) | Complete | 1 |
| Native module resolution | Complete | 1 |
| **Total** | **M8.1 complete** | **9 new, 2147 total** |

## What to Do Next (M8.2)

From `docs/steps/08-milestone8-standalone.md`:

- [ ] `aca "what is 2+2"` with real NanoGPT key → streams a text response to stdout, exits 0
- [ ] NanoGptDriver SSE parsing works with actual NanoGPT API responses (not mocked)
- [ ] Model resolution: `qwen/qwen3-coder` (default) resolves and responds
- [ ] Error handling: invalid API key → clear error message on stderr, exit 4
- [ ] Error handling: model not found → clear error on stderr
- [ ] Session created: `~/.aca/sessions/` contains a new session dir with manifest.json and conversation.jsonl
- [ ] Fix any runtime issues (import paths, missing polyfills, env detection)

**Tests (manual verification + scripted):**
- One-shot run with real NanoGPT produces non-empty stdout
- Session manifest exists after run
- conversation.jsonl contains at least 2 items (user message + assistant response)
- Bad API key → stderr contains "API key" and exit code is non-zero

## Dependencies

- NanoGPT API key in `~/.api_keys` (verified present)
- Built output at `dist/index.js` (from M8.1)
- Real network access to NanoGPT API

## File Locations

- Entry point: `src/index.ts` (dev) / `dist/index.js` (prod)
- NanoGPT driver: `src/providers/nanogpt-driver.ts`
- Model registry: `src/providers/model-registry.ts`
- Session manager: `src/core/session-manager.ts`
- Config/secrets: `src/config/loader.ts`, `src/config/secrets.ts`
- New tests: `test/cli/` directory
