# Known Issues

## Real-LLM CLI Coverage

**Status:** `test/cli/first-run.test.ts` and `test/cli/tool-execution.test.ts` are excluded from the default Vitest surface.
**Behavior:** Both files depend on a live NanoGPT key and real model behavior. Run `npm run test:live` for those files only, or `npm run test:full` to combine the default suite with the live CLI coverage.
**Residual risk:** Failures here are still likely to be model-behavior or availability issues rather than deterministic local regressions, so investigate any red run with the captured session artifacts before changing the assertions.
