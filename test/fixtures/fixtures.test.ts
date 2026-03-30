import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = __dirname;

describe('Test fixtures', () => {
    it('small.txt exists and has content', () => {
        const content = readFileSync(join(fixtureDir, 'small.txt'), 'utf-8');
        expect(content.length).toBeGreaterThan(0);
        expect(content.length).toBeLessThan(1000);
    });

    it('large.txt exists and has >2000 lines', () => {
        const content = readFileSync(join(fixtureDir, 'large.txt'), 'utf-8');
        const lines = content.split('\n').filter((l) => l.length > 0);
        expect(lines.length).toBeGreaterThan(2000);
    });

    it('binary.bin exists and contains null bytes', () => {
        const content = readFileSync(join(fixtureDir, 'binary.bin'));
        expect(content.includes(0x00)).toBe(true);
    });

    it('empty.txt exists and is empty', () => {
        const stat = statSync(join(fixtureDir, 'empty.txt'));
        expect(stat.size).toBe(0);
    });

    it('multibyte.txt contains UTF-8 multibyte characters', () => {
        const content = readFileSync(join(fixtureDir, 'multibyte.txt'), 'utf-8');
        expect(content).toContain('こんにちは');
        expect(content).toContain('🎉');
        expect(content).toContain('café');
        expect(content).toContain('عربي');
        expect(content).toContain('中文测试');
    });
});
