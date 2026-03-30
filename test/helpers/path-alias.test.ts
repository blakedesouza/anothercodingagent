import { describe, it, expect } from 'vitest';

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
});
