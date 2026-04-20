import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEvidencePack } from '../../src/consult/evidence-pack.js';

describe('consult evidence pack', () => {
    it('packs explicit files with caps', () => {
        const dir = mkdtempSync(join(tmpdir(), 'aca-pack-'));
        mkdirSync(join(dir, 'src'));
        writeFileSync(join(dir, 'src', 'a.ts'), 'abcdef');
        writeFileSync(join(dir, 'src', 'b.ts'), 'ghijkl');

        const pack = buildEvidencePack({
            projectDir: dir,
            paths: ['src/a.ts', 'src/b.ts'],
            maxFiles: 1,
            maxFileBytes: 3,
            maxTotalBytes: 10_000,
        });

        expect(pack.summary.included_files).toBe(1);
        expect(pack.summary.truncated_files).toEqual(['src/a.ts']);
        expect(pack.summary.omitted).toContain('src/b.ts: max files reached');
        expect(pack.text).toContain('abc');
        expect(pack.text).not.toContain('ghijkl');
    });

    it('rejects paths outside the project', () => {
        const dir = mkdtempSync(join(tmpdir(), 'aca-pack-'));
        const pack = buildEvidencePack({
            projectDir: dir,
            paths: ['../outside.ts'],
        });

        expect(pack.summary.candidate_files).toBe(0);
        expect(pack.summary.included_files).toBe(0);
    });

    it('falls back to safe defaults when numeric caps are non-finite', () => {
        const dir = mkdtempSync(join(tmpdir(), 'aca-pack-'));
        mkdirSync(join(dir, 'src'));
        writeFileSync(join(dir, 'src', 'a.ts'), 'a');
        writeFileSync(join(dir, 'src', 'b.ts'), 'b');
        writeFileSync(join(dir, 'src', 'c.ts'), 'c');
        writeFileSync(join(dir, 'src', 'd.ts'), 'd');
        writeFileSync(join(dir, 'src', 'e.ts'), 'e');
        writeFileSync(join(dir, 'src', 'f.ts'), 'f');

        const pack = buildEvidencePack({
            projectDir: dir,
            packRepo: true,
            maxFiles: Number.NaN,
            maxFileBytes: Number.NaN,
            maxTotalBytes: Number.NaN,
        });

        expect(pack.summary.max_files).toBe(5);
        expect(pack.summary.max_file_bytes).toBe(8_000);
        expect(pack.summary.max_total_bytes).toBe(240_000);
        expect(pack.summary.included_files).toBe(5);
        expect(pack.summary.omitted).toContain('src/f.ts: max files reached');
    });
});
