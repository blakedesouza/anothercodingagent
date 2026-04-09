# Known Issues

## Real-LLM CLI Coverage

**Status:** `test/cli/tool-execution.test.ts` is included in the default Vitest surface again.
**Behavior:** The file still depends on a live NanoGPT key and real model behavior, but it self-skips when no API key is available instead of being globally excluded.
**Residual risk:** Failures here are still likely to be model-behavior or availability issues rather than deterministic local regressions, so investigate any red run with the captured session artifacts before changing the assertions.
