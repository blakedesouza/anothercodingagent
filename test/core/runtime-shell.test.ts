import { describe, expect, it } from 'vitest';
import { platform } from 'node:os';
import { detectRuntimeShell } from '../../src/core/runtime-shell.js';

describe('detectRuntimeShell', () => {
    it('uses SHELL when present', () => {
        expect(detectRuntimeShell({ SHELL: '/bin/zsh' })).toBe('/bin/zsh');
    });

    it('uses ComSpec on Windows when SHELL is absent', () => {
        const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
        const expected = platform() === 'win32'
            ? 'C:\\Windows\\System32\\cmd.exe'
            : 'unknown';
        expect(detectRuntimeShell(env)).toBe(expected);
    });
});
