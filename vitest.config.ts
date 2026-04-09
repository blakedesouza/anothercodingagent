import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        passWithNoTests: true,
        testTimeout: 30_000,
        hookTimeout: 30_000,
        exclude: ['**/node_modules/**'],
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
