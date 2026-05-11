import { describe, expect, it, vi } from 'vitest';
import { runModelsJson, runModelsText } from '../../src/cli/model-catalog.js';

function makeNanoGptResponse(models: Record<string, unknown>[]) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: models }),
    } as unknown as Response;
}

describe('model catalog CLI output', () => {
    it('fetches NanoGPT subscription models and exposes machine-readable availability', async () => {
        const fetchFn = vi.fn().mockResolvedValueOnce(makeNanoGptResponse([
            {
                id: 'zai-org/glm-5.1',
                context_length: 200_000,
                max_output_tokens: 128_000,
                capabilities: {
                    vision: false,
                    tool_calling: true,
                    reasoning: true,
                    structured_output: true,
                },
                pricing: { input: '0.3', output: '2.55' },
            },
            {
                id: 'image/model',
                context_length: 64_000,
                max_output_tokens: 8_192,
                capabilities: {
                    vision: true,
                    tool_calling: false,
                    reasoning: false,
                    structured_output: false,
                },
            },
        ]));

        const json = await runModelsJson(
            { json: true, tools: true },
            {
                fetchFn,
                env: { NANOGPT_API_KEY: 'test-key' },
                apiKeysPath: 'C:\\missing-api-keys',
                secretsPath: 'C:\\missing-secrets.json',
            },
        );
        const parsed = JSON.parse(json);

        expect(fetchFn).toHaveBeenCalledWith(
            'https://nano-gpt.com/api/subscription/v1/models?detailed=true',
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
            }),
        );
        expect(parsed).toMatchObject({
            provider: 'nanogpt',
            status: 'ok',
            source: 'live',
            model_count: 1,
        });
        expect(parsed.models).toEqual([
            {
                id: 'zai-org/glm-5.1',
                context_length: 200000,
                max_output_tokens: 128000,
                capabilities: {
                    vision: false,
                    tool_calling: true,
                    reasoning: true,
                    structured_output: true,
                },
                pricing: { input: 0.3, output: 2.55 },
            },
        ]);
    });

    it('renders a readable filtered catalog table', async () => {
        const fetchFn = vi.fn().mockResolvedValueOnce(makeNanoGptResponse([
            {
                id: 'moonshotai/kimi-k2.6',
                context_length: 256_000,
                max_output_tokens: 65_536,
                capabilities: {
                    vision: false,
                    tool_calling: true,
                    reasoning: false,
                    structured_output: true,
                },
            },
        ]));

        const text = await runModelsText(
            { search: 'kimi' },
            {
                fetchFn,
                env: { NANOGPT_API_KEY: 'test-key' },
                apiKeysPath: 'C:\\missing-api-keys',
                secretsPath: 'C:\\missing-secrets.json',
            },
        );

        expect(text).toContain('NanoGPT Models');
        expect(text).toContain('source: live');
        expect(text).toContain('moonshotai/kimi-k2.6');
        expect(text).toContain('tools');
        expect(text).toContain('structured');
    });
});
