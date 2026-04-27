import { describe, it, expect } from 'vitest';
import {
    isFilesystemRootPath,
    isAbsolutePath,
    isPathWithin,
    normalizePathForComparison,
    pathsReferToSameLocation,
    relativePathWithInputStyle,
} from '../../src/core/path-comparison.js';

describe('path-comparison', () => {
    it('normalizes Windows paths case-insensitively for comparisons', () => {
        expect(normalizePathForComparison('C:/Users/Blake/Project')).toBe(
            normalizePathForComparison('c:\\users\\blake\\project\\'),
        );
    });

    it('keeps POSIX comparisons case-sensitive', () => {
        expect(pathsReferToSameLocation('/Repo', '/repo')).toBe(false);
    });

    it('treats Windows descendants with mixed separators as within the workspace', () => {
        expect(isPathWithin('C:/Repo', 'c:\\repo\\src\\index.ts')).toBe(true);
    });

    it('rejects Windows sibling paths that only share a prefix', () => {
        expect(isPathWithin('C:\\repo', 'C:\\repo-tools\\index.ts')).toBe(false);
    });

    it('detects POSIX and Windows filesystem roots', () => {
        expect(isFilesystemRootPath('/')).toBe(true);
        expect(isFilesystemRootPath('C:\\')).toBe(true);
        expect(isFilesystemRootPath('\\\\server\\share\\')).toBe(true);
        expect(isFilesystemRootPath('C:\\repo')).toBe(false);
    });

    it('detects POSIX and Windows absolute paths', () => {
        expect(isAbsolutePath('/tmp/project')).toBe(true);
        expect(isAbsolutePath('C:\\Users\\Blake\\Project')).toBe(true);
        expect(isAbsolutePath('node_modules')).toBe(false);
    });

    it('computes relative paths with the selected path style', () => {
        expect(relativePathWithInputStyle('C:\\Repo', 'c:\\repo\\src\\index.ts')).toBe('src\\index.ts');
        expect(relativePathWithInputStyle('/repo', '/repo/src/index.ts')).toBe('src/index.ts');
    });
});
