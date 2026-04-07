import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateRequiredOutputPaths } from '../../src/cli/invoke-output-validation.js';

describe('validateRequiredOutputPaths', () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, { recursive: true, force: true });
        }
    });

    function makeRoot(): string {
        const root = mkdtempSync(join(tmpdir(), 'aca-required-output-'));
        roots.push(root);
        return root;
    }

    it('accepts existing non-empty relative files', () => {
        const root = makeRoot();
        mkdirSync(join(root, 'world'), { recursive: true });
        writeFileSync(join(root, 'world', 'setting.md'), '# Setting\n');

        expect(validateRequiredOutputPaths(root, ['world/setting.md'])).toEqual([]);
    });

    it('reports missing, empty, directory, and out-of-root paths', () => {
        const root = makeRoot();
        mkdirSync(join(root, 'world'), { recursive: true });
        writeFileSync(join(root, 'world', 'empty.md'), '');

        expect(validateRequiredOutputPaths(root, [
            'world/missing.md',
            'world/empty.md',
            'world',
            '../outside.md',
        ])).toEqual([
            'world/missing.md',
            'world/empty.md',
            'world',
            '../outside.md',
        ]);
    });
});
