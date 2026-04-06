import { describe, it, expect } from 'vitest';
import { SessionGrantStore } from '../../src/permissions/session-grants.js';

describe('SessionGrantStore', () => {
    it('starts empty', () => {
        const store = new SessionGrantStore();
        expect(store.list()).toHaveLength(0);
    });

    it('addGrant creates a grant and hasGrant finds it', () => {
        const store = new SessionGrantStore();
        store.addGrant('write_file');
        expect(store.hasGrant('write_file')).toBe(true);
    });

    it('hasGrant returns false for unknown tools', () => {
        const store = new SessionGrantStore();
        store.addGrant('write_file');
        expect(store.hasGrant('read_file')).toBe(false);
    });

    it('deduplicates identical grants', () => {
        const store = new SessionGrantStore();
        store.addGrant('write_file');
        store.addGrant('write_file');
        expect(store.list()).toHaveLength(1);
    });

    it('command-scoped grant for exec_command', () => {
        const store = new SessionGrantStore();
        store.addGrant('exec_command', 'npm test');
        expect(store.hasGrant('exec_command', 'npm test')).toBe(true);
    });

    it('grant for npm test does not approve npm install', () => {
        const store = new SessionGrantStore();
        store.addGrant('exec_command', 'npm test');
        expect(store.hasGrant('exec_command', 'npm install')).toBe(false);
    });

    it('tool-level grant does not match command-scoped queries', () => {
        const store = new SessionGrantStore();
        store.addGrant('exec_command');
        // A tool-level grant (no command) should not match a command-scoped query
        expect(store.hasGrant('exec_command', 'npm test')).toBe(false);
    });

    it('command-scoped grant does not match tool-level queries', () => {
        const store = new SessionGrantStore();
        store.addGrant('exec_command', 'npm test');
        // A command-scoped grant should not match a bare tool-level query
        expect(store.hasGrant('exec_command')).toBe(false);
    });

    it('multiple grants for different commands', () => {
        const store = new SessionGrantStore();
        store.addGrant('exec_command', 'npm test');
        store.addGrant('exec_command', 'npm run build');
        expect(store.hasGrant('exec_command', 'npm test')).toBe(true);
        expect(store.hasGrant('exec_command', 'npm run build')).toBe(true);
        expect(store.hasGrant('exec_command', 'npm install')).toBe(false);
        expect(store.list()).toHaveLength(2);
    });

    it('clear removes all grants', () => {
        const store = new SessionGrantStore();
        store.addGrant('write_file');
        store.addGrant('exec_command', 'npm test');
        store.clear();
        expect(store.list()).toHaveLength(0);
        expect(store.hasGrant('write_file')).toBe(false);
        expect(store.hasGrant('exec_command', 'npm test')).toBe(false);
    });

    it('deduplicates command-scoped grants', () => {
        const store = new SessionGrantStore();
        store.addGrant('exec_command', 'npm test');
        store.addGrant('exec_command', 'npm test');
        expect(store.list()).toHaveLength(1);
    });

    it('list returns readonly snapshot', () => {
        const store = new SessionGrantStore();
        store.addGrant('write_file');
        const list = store.list();
        expect(list).toHaveLength(1);
        expect(list[0].toolName).toBe('write_file');
        expect(list[0].createdAt).toBeGreaterThan(0);
    });
});
