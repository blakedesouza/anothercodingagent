import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { estimateTokensSpec, estimateTokensImpl } from '../../src/tools/estimate-tokens.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolRunner } from '../../src/tools/tool-runner.js';

// --- Test fixtures ---

let tmpDir: string;
let registry: ToolRegistry;
let runner: ToolRunner;
let baseContext: { sessionId: string; workspaceRoot: string };

beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'aca-estimate-tokens-'));
    baseContext = { sessionId: 'ses_test', workspaceRoot: tmpDir };

    registry = new ToolRegistry();
    registry.register(estimateTokensSpec, estimateTokensImpl);
    runner = new ToolRunner(registry);

    // Create fixture files
    await writeFile(join(tmpDir, 'hello.txt'), 'Hello, world!');
    await writeFile(join(tmpDir, 'unicode.txt'), 'Hello 世界\nCafé\n');
    await writeFile(join(tmpDir, 'empty.txt'), '');
    await mkdir(join(tmpDir, 'subdir'));
});

afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
});

function parseData(result: { data: string }): Record<string, unknown> {
    return JSON.parse(result.data) as Record<string, unknown>;
}

// --- Tool spec ---

describe('estimate_tokens spec', () => {
    it('approval class is read-only', () => {
        expect(estimateTokensSpec.approvalClass).toBe('read-only');
    });

    it('is idempotent', () => {
        expect(estimateTokensSpec.idempotent).toBe(true);
    });
});

// --- Text input ---

describe('estimate_tokens: text input', () => {
    it('returns token count for text', async () => {
        const result = await runner.execute('estimate_tokens', { text: 'hello' }, baseContext);
        expect(result.status).toBe('success');
        const data = parseData(result);
        expect(data.totalTokens).toBe(2); // ceil(5/3)
        expect(data.bytesPerToken).toBe(3.0);
    });

    it('empty text → 0 tokens', async () => {
        const result = await runner.execute('estimate_tokens', { text: '' }, baseContext);
        expect(result.status).toBe('success');
        const data = parseData(result);
        expect(data.totalTokens).toBe(0);
    });

    it('fitsInContext is null when no model specified', async () => {
        const result = await runner.execute('estimate_tokens', { text: 'hello' }, baseContext);
        const data = parseData(result);
        expect(data.fitsInContext).toBeNull();
    });

    it('fitsInContext is true for small text with known model', async () => {
        const result = await runner.execute(
            'estimate_tokens',
            { text: 'hello', model: 'gpt-4o' },
            baseContext,
        );
        const data = parseData(result);
        expect(data.fitsInContext).toBe(true);
        expect(data.safeBudget).toBeDefined();
    });

    it('uses per-model bytesPerToken', async () => {
        // deepseek-chat has bytesPerToken=2.5
        const result = await runner.execute(
            'estimate_tokens',
            { text: 'hello world', model: 'deepseek-chat' },
            baseContext,
        );
        const data = parseData(result);
        expect(data.bytesPerToken).toBe(2.5);
        // "hello world" = 11 bytes, ceil(11/2.5) = 5
        expect(data.totalTokens).toBe(5);
    });

    it('unknown model falls back to default bytesPerToken', async () => {
        const result = await runner.execute(
            'estimate_tokens',
            { text: 'hello', model: 'unknown-model-xyz' },
            baseContext,
        );
        const data = parseData(result);
        expect(data.bytesPerToken).toBe(3.0);
        expect(data.fitsInContext).toBeNull(); // no caps available
    });
});

// --- File input ---

describe('estimate_tokens: file paths', () => {
    it('reads file and returns token count', async () => {
        const result = await runner.execute(
            'estimate_tokens',
            { file_paths: [join(tmpDir, 'hello.txt')] },
            baseContext,
        );
        expect(result.status).toBe('success');
        const data = parseData(result);
        const files = data.files as Array<{ path: string; tokens: number }>;
        expect(files).toHaveLength(1);
        expect(files[0].tokens).toBeGreaterThan(0);
        expect(data.totalTokens).toBe(files[0].tokens);
    });

    it('handles multiple files', async () => {
        const result = await runner.execute(
            'estimate_tokens',
            { file_paths: [join(tmpDir, 'hello.txt'), join(tmpDir, 'unicode.txt')] },
            baseContext,
        );
        const data = parseData(result);
        const files = data.files as Array<{ path: string; tokens: number }>;
        expect(files).toHaveLength(2);
        expect(data.totalTokens).toBe(files[0].tokens + files[1].tokens);
    });

    it('empty file → 0 tokens', async () => {
        const result = await runner.execute(
            'estimate_tokens',
            { file_paths: [join(tmpDir, 'empty.txt')] },
            baseContext,
        );
        const data = parseData(result);
        const files = data.files as Array<{ path: string; tokens: number }>;
        expect(files[0].tokens).toBe(0);
    });

    it('nonexistent file → error in file result', async () => {
        const result = await runner.execute(
            'estimate_tokens',
            { file_paths: [join(tmpDir, 'nope.txt')] },
            baseContext,
        );
        expect(result.status).toBe('success'); // tool succeeds, individual file has error
        const data = parseData(result);
        const files = data.files as Array<{ path: string; tokens: number; error?: string }>;
        expect(files[0].error).toBeDefined();
        expect(files[0].tokens).toBe(0);
    });

    it('directory path → error in file result', async () => {
        const result = await runner.execute(
            'estimate_tokens',
            { file_paths: [join(tmpDir, 'subdir')] },
            baseContext,
        );
        const data = parseData(result);
        const files = data.files as Array<{ path: string; tokens: number; error?: string }>;
        expect(files[0].error).toBe('not a regular file');
    });

    it('combines text + file tokens', async () => {
        const result = await runner.execute(
            'estimate_tokens',
            { text: 'extra text', file_paths: [join(tmpDir, 'hello.txt')] },
            baseContext,
        );
        const data = parseData(result);
        const files = data.files as Array<{ path: string; tokens: number }>;
        const textTokens = Math.ceil(Buffer.byteLength('extra text', 'utf8') / 3);
        expect(data.totalTokens).toBe(textTokens + files[0].tokens);
    });
});

// --- Validation ---

describe('estimate_tokens: validation', () => {
    it('no text and no file_paths → error', async () => {
        const result = await runner.execute('estimate_tokens', {}, baseContext);
        expect(result.status).toBe('error');
    });
});
