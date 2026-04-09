import { describe, it, expect } from 'vitest';
import { matchPreauthRules } from '../../src/permissions/preauth.js';
import type { PreauthRule } from '../../src/config/schema.js';

const makeRule = (overrides: Partial<PreauthRule> & Pick<PreauthRule, 'id' | 'tool'>): PreauthRule => ({
    match: {},
    decision: 'allow',
    scope: 'session',
    ...overrides,
});

describe('matchPreauthRules', () => {
    it('returns null when rules list is empty', () => {
        const result = matchPreauthRules([], { toolName: 'exec_command' });
        expect(result).toBeNull();
    });

    it('matches by tool name alone', () => {
        const rules = [makeRule({ id: 'r1', tool: 'exec_command' })];
        const result = matchPreauthRules(rules, { toolName: 'exec_command' });
        expect(result).not.toBeNull();
        expect(result!.id).toBe('r1');
    });

    it('does not match different tool', () => {
        const rules = [makeRule({ id: 'r1', tool: 'exec_command' })];
        const result = matchPreauthRules(rules, { toolName: 'write_file' });
        expect(result).toBeNull();
    });

    it('matches commandRegex: ^npm (test|build)$ matches npm test', () => {
        const rules = [makeRule({
            id: 'r1',
            tool: 'exec_command',
            match: { commandRegex: '^npm (test|build)$' },
        })];
        expect(matchPreauthRules(rules, {
            toolName: 'exec_command',
            command: 'npm test',
        })).not.toBeNull();
    });

    it('commandRegex ^npm (test|build)$ does not match npm install', () => {
        const rules = [makeRule({
            id: 'r1',
            tool: 'exec_command',
            match: { commandRegex: '^npm (test|build)$' },
        })];
        expect(matchPreauthRules(rules, {
            toolName: 'exec_command',
            command: 'npm install',
        })).toBeNull();
    });

    it('skips rule when commandRegex specified but no command in input', () => {
        const rules = [makeRule({
            id: 'r1',
            tool: 'exec_command',
            match: { commandRegex: '^npm test$' },
        })];
        expect(matchPreauthRules(rules, {
            toolName: 'exec_command',
            // no command
        })).toBeNull();
    });

    it('matches cwdPattern as prefix', () => {
        const rules = [makeRule({
            id: 'r1',
            tool: 'exec_command',
            match: { cwdPattern: '/home/user/project' },
        })];
        expect(matchPreauthRules(rules, {
            toolName: 'exec_command',
            cwd: '/home/user/project/src',
        })).not.toBeNull();
    });

    it('cwdPattern does not match outside prefix', () => {
        const rules = [makeRule({
            id: 'r1',
            tool: 'exec_command',
            match: { cwdPattern: '/home/user/project' },
        })];
        expect(matchPreauthRules(rules, {
            toolName: 'exec_command',
            cwd: '/home/other/project',
        })).toBeNull();
    });

    it('cwdPattern does not match sibling paths that share a string prefix', () => {
        const rules = [makeRule({
            id: 'r1',
            tool: 'exec_command',
            match: { cwdPattern: '/home/user/project' },
        })];
        expect(matchPreauthRules(rules, {
            toolName: 'exec_command',
            cwd: '/home/user/project-evil',
        })).toBeNull();
    });

    it('skips rule when cwdPattern specified but no cwd in input', () => {
        const rules = [makeRule({
            id: 'r1',
            tool: 'exec_command',
            match: { cwdPattern: '/home/user/project' },
        })];
        expect(matchPreauthRules(rules, {
            toolName: 'exec_command',
        })).toBeNull();
    });

    it('matches both commandRegex and cwdPattern together', () => {
        const rules = [makeRule({
            id: 'r1',
            tool: 'exec_command',
            match: {
                commandRegex: '^npm test$',
                cwdPattern: '/home/user/project',
            },
        })];
        expect(matchPreauthRules(rules, {
            toolName: 'exec_command',
            command: 'npm test',
            cwd: '/home/user/project/src',
        })).not.toBeNull();
    });

    it('fails when commandRegex matches but cwdPattern does not', () => {
        const rules = [makeRule({
            id: 'r1',
            tool: 'exec_command',
            match: {
                commandRegex: '^npm test$',
                cwdPattern: '/home/user/project',
            },
        })];
        expect(matchPreauthRules(rules, {
            toolName: 'exec_command',
            command: 'npm test',
            cwd: '/other/path',
        })).toBeNull();
    });

    it('first match wins among multiple rules', () => {
        const rules = [
            makeRule({ id: 'r1', tool: 'exec_command', decision: 'allow' }),
            makeRule({ id: 'r2', tool: 'exec_command', decision: 'deny' }),
        ];
        const result = matchPreauthRules(rules, { toolName: 'exec_command' });
        expect(result!.id).toBe('r1');
        expect(result!.decision).toBe('allow');
    });

    it('skips rule with invalid regex and matches subsequent', () => {
        const rules = [
            makeRule({
                id: 'r1',
                tool: 'exec_command',
                match: { commandRegex: '[invalid(' },
                decision: 'deny',
            }),
            makeRule({
                id: 'r2',
                tool: 'exec_command',
                decision: 'allow',
            }),
        ];
        const result = matchPreauthRules(rules, {
            toolName: 'exec_command',
            command: 'npm test',
        });
        expect(result!.id).toBe('r2');
    });

    it('returns deny decision when rule says deny', () => {
        const rules = [makeRule({
            id: 'r1',
            tool: 'exec_command',
            decision: 'deny',
        })];
        const result = matchPreauthRules(rules, { toolName: 'exec_command' });
        expect(result!.decision).toBe('deny');
    });

    it('skips regex longer than 500 characters', () => {
        const rules = [makeRule({
            id: 'r1',
            tool: 'exec_command',
            match: { commandRegex: 'a'.repeat(501) },
            decision: 'allow',
        })];
        const result = matchPreauthRules(rules, {
            toolName: 'exec_command',
            command: 'a'.repeat(501),
        });
        expect(result).toBeNull();
    });

    it('allows regex up to 500 characters', () => {
        const rules = [makeRule({
            id: 'r1',
            tool: 'exec_command',
            match: { commandRegex: '^' + 'a'.repeat(498) + '$' },
            decision: 'allow',
        })];
        const result = matchPreauthRules(rules, {
            toolName: 'exec_command',
            command: 'a'.repeat(498),
        });
        expect(result).not.toBeNull();
    });
});
