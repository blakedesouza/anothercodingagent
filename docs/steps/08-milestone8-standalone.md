# ACA Implementation Steps — Milestone 8: Ship It (ACA Standalone)

Get ACA from "all tests pass" to "actually runs and completes real tasks." This is the first milestone where testing involves real LLM calls and real file operations — not mocks.

**Test framework:** vitest (unit/integration) + manual verification (real runs)
**Test location:** `test/` mirroring `src/` structure
**Prerequisite:** NanoGPT API key in `~/.api_keys`

---

## Milestone 8: ACA Standalone

### M8.1 — Build & Package

- [x] `npm run build` completes without errors (tsup → dist/)
- [x] `dist/index.js` is a valid ESM entry point with shebang
- [x] `node dist/index.js --version` prints version and exits
- [x] `node dist/index.js --help` prints help and exits
- [x] `aca describe --json` outputs valid capability descriptor (fast path, no config loading)
- [x] Fix any build-time issues (missing exports, circular deps, native module bundling for better-sqlite3/shiki)
- [x] Verify `npx tsx src/index.ts --version` also works (dev mode)

**Tests:**
- Build output exists at `dist/index.js` and is non-empty
- `aca --version` exits 0 with semver string
- `aca --help` exits 0 with usage text
- `aca describe --json` outputs valid JSON matching CapabilityDescriptor schema
- Native modules (better-sqlite3, shiki WASM) load correctly in bundled output

### M8.2 — First Real Run

- [x] `aca "what is 2+2"` with real NanoGPT key → streams a text response to stdout, exits 0
- [x] NanoGptDriver SSE parsing works with actual NanoGPT API responses (not mocked)
- [x] Model resolution: `qwen/qwen3-coder` (default) resolves and responds
- [x] Error handling: invalid API key → clear error message on stderr, exit 4
- [x] Error handling: model not found → clear error on stderr
- [x] Session created: `~/.aca/sessions/` contains a new session dir with manifest.json and conversation.jsonl
- [x] Fix any runtime issues (import paths, missing polyfills, env detection)

**Tests (manual verification + scripted):**
- One-shot run with real NanoGPT produces non-empty stdout
- Session manifest exists after run
- conversation.jsonl contains at least 2 items (user message + assistant response)
- Bad API key → stderr contains "API key" and exit code is non-zero

### M8.3 — Real Tool Execution

- [x] `aca "read the file package.json and tell me the project name"` → uses read_file tool, returns "anothercodingagent"
- [x] `aca "create a file /tmp/aca-test-output.txt with the content 'hello from aca'"` → uses write_file, file exists after
- [x] `aca "run the command 'echo hello world'"` → uses exec_command, output contains "hello world"
- [x] Tool approval flow works: workspace-write tools prompt for confirmation (unless --no-confirm)
- [x] `aca --no-confirm "create /tmp/aca-smoke.txt with 'smoke test'"` → auto-approves, file created
- [x] Sandbox enforcement: write outside workspace → blocked with clear error
- [x] SecretScrubber: API key doesn't appear in conversation.jsonl or stdout

**Tests (scripted integration):**
- read_file tool returns correct file content via real LLM
- write_file creates file at expected path
- exec_command runs and returns output
- conversation.jsonl contains tool_call and tool_result items
- Grep conversation.jsonl for NanoGPT API key → zero matches

---

## Post-Milestone Review (M8)
<!-- risk: medium — first real execution, runtime issues likely -->
<!-- final-substep: M8.3 -->
- [x] Architecture review (4 witnesses): build output, runtime deps, error paths
- [x] Bug hunt (4 witnesses): real-world edge cases, env detection, graceful degradation
- [x] Critical findings fixed and verified
- [x] Review summary appended to changelog
