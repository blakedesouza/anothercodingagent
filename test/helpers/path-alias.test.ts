import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

describe('Path alias resolution', () => {
    it('resolves @/ to src/ in tests', async () => {
        // Import via path alias — this verifies vitest alias config works
        const types = await import('@/types/index.js');

        expect(types.generateId).toBeDefined();
        expect(typeof types.generateId).toBe('function');
    });

    it('generates valid prefixed IDs via path alias import', async () => {
        const { generateId } = await import('@/types/ids.js');

        const sessionId = generateId('session');
        expect(sessionId).toMatch(/^ses_/);

        const turnId = generateId('turn');
        expect(turnId).toMatch(/^trn_/);

        const stepId = generateId('step');
        expect(stepId).toMatch(/^stp_/);

        const itemId = generateId('item');
        expect(itemId).toMatch(/^itm_/);

        const toolCallId = generateId('toolCall');
        expect(toolCallId).toMatch(/^call_/);
    });

    it('resolves @/ to src/ in the tsx dev runtime', () => {
        const root = join(import.meta.dirname, '..', '..');
        const stdout = execFileSync(
            'node',
            [
                '--import',
                'tsx',
                '--input-type=module',
                '-e',
                "const mod = await import('@/types/index.js'); console.log(typeof mod.generateId);",
            ],
            {
                cwd: root,
                encoding: 'utf-8',
                env: { ...process.env, NODE_NO_WARNINGS: '1' },
            },
        );

        expect(stdout.trim()).toBe('function');
    });
});
