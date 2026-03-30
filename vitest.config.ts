import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        passWithNoTests: true,
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
