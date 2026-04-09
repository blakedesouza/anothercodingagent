import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildProfileCompletionRepairTask,
    buildRequiredOutputRepairTask,
    countHardRejectedToolCalls,
    validateProfileCompletion,
    validateRequiredOutputPaths,
} from '../../src/cli/invoke-output-validation.js';

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

    it('rejects zero-tool rp-researcher completions', () => {
        expect(validateProfileCompletion(
            'rp-researcher',
            0,
            "I'll research Trinity Seven across multiple sources and start with web searches.",
        )).toEqual({
            code: 'turn.profile_validation_failed',
            message: 'rp-researcher run ended without any accepted tool calls; plan-only or intention-only research text is not a valid completion',
        });
    });

    it('rejects no-tool rp-researcher completions that begin with live failure phrasing', () => {
        expect(validateProfileCompletion(
            'rp-researcher',
            0,
            "I'll start by reading the local reference files and querying the Trinity Seven wiki API in parallel.",
        )?.code).toBe('turn.profile_validation_failed');
    });

    it('allows rp-researcher completions after accepted tool calls', () => {
        expect(validateProfileCompletion(
            'rp-researcher',
            2,
            '# Discovery Brief\n\nSources inspected: ...',
        )).toBeNull();
    });

    it('does not apply rp validation to other profiles', () => {
        expect(validateProfileCompletion(
            'researcher',
            0,
            "I'll research Trinity Seven across multiple sources and start with web searches.",
        )).toBeNull();
    });

    it('builds a bounded repair prompt for missing required outputs', () => {
        const prompt = buildRequiredOutputRepairTask([
            'trinity-seven/research/discovery-plan.md',
            'world/setting.md',
        ]);
        expect(prompt).toContain('"trinity-seven/research/discovery-plan.md"');
        expect(prompt).toContain('"world/setting.md"');
        expect(prompt).toContain('Do not restate your plan');
        expect(prompt).toContain('write the required files now');
        expect(prompt).toContain('Do not quote literal pseudo-tool markup');
    });

    it('builds a profile-repair prompt that forces immediate tool use', () => {
        const prompt = buildProfileCompletionRepairTask(
            {
                code: 'turn.profile_validation_failed',
                message: 'rp-researcher run ended without any accepted tool calls; plan-only or intention-only research text is not a valid completion',
            },
            ['trinity-seven/research/discovery-plan.md'],
        );
        expect(prompt).toContain('actual tool calls');
        expect(prompt).toContain('"trinity-seven/research/discovery-plan.md"');
        expect(prompt).toContain('Do not restate your plan');
        expect(prompt).toContain('Do not quote literal pseudo-tool markup');
    });

    it('counts only hard rejected tool calls', () => {
        expect(countHardRejectedToolCalls([
            {
                kind: 'tool_result',
                id: 'itm_1',
                seq: 1,
                toolCallId: 'call_1',
                toolName: 'read_file',
                output: {
                    status: 'error',
                    data: '',
                    error: { code: 'tool.deferred', message: 'later', retryable: false },
                    truncated: false,
                    bytesReturned: 0,
                    bytesOmitted: 0,
                    retryable: false,
                    timedOut: false,
                    mutationState: 'none',
                },
                timestamp: new Date().toISOString(),
            },
            {
                kind: 'tool_result',
                id: 'itm_2',
                seq: 2,
                toolCallId: 'call_2',
                toolName: 'read_file',
                output: {
                    status: 'error',
                    data: '',
                    error: { code: 'tool.max_tool_calls', message: 'cap reached', retryable: false },
                    truncated: false,
                    bytesReturned: 0,
                    bytesOmitted: 0,
                    retryable: false,
                    timedOut: false,
                    mutationState: 'none',
                },
                timestamp: new Date().toISOString(),
            },
        ])).toBe(1);
    });
});
