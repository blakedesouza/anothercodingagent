# Known Issues

## Flaky: test/cli/tool-execution.test.ts (7 tests)

**Excluded in:** `vitest.config.ts` exclude list
**Since:** 2026-04-05 (M9.3b)
**Symptoms:** `auto-approves workspace-write tools without prompting` fails with exit code 1 instead of 0. Other tests in the file also intermittently fail.
**Root cause:** Tests depend on real NanoGPT LLM responses. The LLM may choose different tools (exec_command vs write_file), timeout, or produce unexpected output. Exit code 1 indicates the one-shot turn ended with a non-success outcome (e.g., tool_error, aborted, max_steps).
**To re-enable:** Fix or make tests resilient to LLM non-determinism, then remove the exclude entry from `vitest.config.ts`.
