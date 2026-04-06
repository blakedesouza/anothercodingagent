import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        passWithNoTests: true,
        testTimeout: 30_000,
        hookTimeout: 30_000,
        // Flaky real-LLM test excluded — depends on NanoGPT availability and model behavior.
        // TODO: Fix and re-enable (see docs/known-issues.md)
        exclude: ['test/cli/tool-execution.test.ts', '**/node_modules/**'],
        alias: {
            '@/': new URL('./src/', import.meta.url).pathname,
        },
        resolveSnapshotPath: (testPath, snapExtension) => {
            return testPath
                .replace('/test/', '/test/__snapshots__/')
                .concat(snapExtension);
        },
    },
});
