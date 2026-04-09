# M8.1 Handoff — Build & Package

**Date:** 2026-04-04
**Status:** M7 review complete. Ready for M8.1.

## What's Done (M7 Review)

All 7 milestones implemented and reviewed. 2138 tests passing. 4 Critical/High findings fixed in M7 review (fetchWithLimits URL loss, delegation tool widening, LSP health report, browser policy bypass).

## What to Do Next (M8.1)

Build and package ACA into a runnable CLI.

### Requirements (from step file)
- `npm run build` completes without errors (tsup → dist/)
- `dist/index.js` is a valid ESM entry point with shebang
- `node dist/index.js --version` prints version and exits
- `node dist/index.js --help` prints help and exits
- `aca describe --json` outputs valid capability descriptor
- Fix any build-time issues (missing exports, circular deps, native module bundling for better-sqlite3/shiki)
- Verify `node --import tsx src/index.ts --version` also works (dev mode)

### Known Risks
- **Native modules:** better-sqlite3 and shiki WASM may not bundle correctly with tsup. May need `external` config in tsup.config.ts.
- **ESM imports:** All source uses `.js` extensions in imports (ESM convention). tsup should handle this, but verify.
- **Shebang:** dist/index.js needs `#!/usr/bin/env node` for `aca` bin to work.

## Dependencies
- tsup 8.5.1 available
- TypeScript compiles clean (`tsc --noEmit` passes)
- Node 20+ required

## File Locations
- `tsup.config.ts` — build config (entry: src/index.ts, ESM, node20)
- `package.json` — scripts.build = "tsup", bin.aca = "dist/index.js"
- `src/index.ts` — CLI entry point (commander-based)
