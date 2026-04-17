import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        passWithNoTests: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
        include: ['test/cli/first-run.test.ts', 'test/cli/tool-execution.test.ts'],
        exclude: ['**/node_modules/**', '**/.claude/**', '**/.local/**', '**/dist/**'],
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
