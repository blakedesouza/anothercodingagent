import { describe, it, expect } from 'vitest';
import { obfuscateIdentifiers } from '../../src/consult/identifier-obfuscation.js';

describe('obfuscateIdentifiers', () => {
    it('replaces camelCase identifiers', () => {
        const { obfuscated, legend } = obfuscateIdentifiers('What does execCommand do?');
        expect(obfuscated).toBe('What does A do?');
        expect(legend).toContain('A = execCommand');
    });

    it('replaces PascalCase identifiers with internal uppercase', () => {
        const { obfuscated, legend } = obfuscateIdentifiers('What is InvokeRequest?');
        expect(obfuscated).toBe('What is A?');
        expect(legend).toContain('A = InvokeRequest');
    });

    it('replaces multi-part snake_case identifiers', () => {
        const { obfuscated, legend } = obfuscateIdentifiers('What does exec_command do?');
        expect(obfuscated).toBe('What does A do?');
        expect(legend).toContain('A = exec_command');
    });

    it('assigns sequential labels to multiple identifiers', () => {
        const { obfuscated, legend } = obfuscateIdentifiers(
            'What does execCommand do and how does spawnAgent use it?'
        );
        expect(obfuscated).toBe('What does A do and how does B use it?');
        expect(legend).toContain('A = execCommand');
        expect(legend).toContain('B = spawnAgent');
    });

    it('replaces all occurrences of the same identifier', () => {
        const { obfuscated } = obfuscateIdentifiers(
            'execCommand calls execCommand internally'
        );
        expect(obfuscated).toBe('A calls A internally');
    });

    it('leaves bare lowercase words unchanged', () => {
        const { obfuscated, legend } = obfuscateIdentifiers(
            'What does exec do and what is tool?'
        );
        expect(obfuscated).toBe('What does exec do and what is tool?');
        expect(legend).toBe('');
    });

    it('leaves ALL_CAPS acronyms unchanged', () => {
        const { obfuscated, legend } = obfuscateIdentifiers('See the README and HTTP docs.');
        expect(obfuscated).toBe('See the README and HTTP docs.');
        expect(legend).toBe('');
    });

    it('leaves single-word PascalCase (no internal uppercase) unchanged', () => {
        // "Command", "The", "Request" alone — no second uppercase
        const { legend } = obfuscateIdentifiers('The Command is missing.');
        expect(legend).toBe('');
    });

    it('returns unchanged text and empty legend when no identifiers found', () => {
        const { obfuscated, legend } = obfuscateIdentifiers('what does this do?');
        expect(obfuscated).toBe('what does this do?');
        expect(legend).toBe('');
    });

    it('handles long compound camelCase identifiers', () => {
        const { obfuscated, legend } = obfuscateIdentifiers(
            'What does wrapStreamWithToolEmulation emit?'
        );
        expect(obfuscated).toBe('What does A emit?');
        expect(legend).toContain('A = wrapStreamWithToolEmulation');
    });

    // Loaded hyphenated terms
    it('replaces tool-call with a label', () => {
        const { obfuscated, legend } = obfuscateIdentifiers('How is a tool-call detected?');
        expect(obfuscated).toBe('How is a A detected?');
        expect(legend).toContain('A = tool-call');
    });

    it('replaces pseudo-tool-call as a whole unit', () => {
        const { obfuscated, legend } = obfuscateIdentifiers(
            'What happens when a pseudo-tool-call is emitted?'
        );
        expect(obfuscated).toBe('What happens when a A is emitted?');
        expect(legend).toContain('A = pseudo-tool-call');
        expect(obfuscated).not.toContain('tool-call');
    });

    it('assigns pseudo-tool-call before tool-call when both appear', () => {
        const { obfuscated, legend } = obfuscateIdentifiers(
            'A pseudo-tool-call is different from a plain tool-call.'
        );
        expect(legend).toContain('A = pseudo-tool-call');
        expect(legend).toContain('B = tool-call');
        expect(obfuscated).toBe('A A is different from a plain B.');
    });

    it('replaces loaded terms case-insensitively', () => {
        const { obfuscated } = obfuscateIdentifiers('What about Tool-Call handling?');
        expect(obfuscated).toBe('What about A handling?');
    });

    it('assigns labels to both camelCase identifiers and loaded terms in sequence', () => {
        const { obfuscated, legend } = obfuscateIdentifiers(
            'What does execCommand do with a tool-call?'
        );
        expect(obfuscated).toBe('What does A do with a B?');
        expect(legend).toContain('A = execCommand');
        expect(legend).toContain('B = tool-call');
    });

    it('replaces api-call with a label', () => {
        const { obfuscated, legend } = obfuscateIdentifiers('Each api-call returns JSON.');
        expect(obfuscated).toBe('Each A returns JSON.');
        expect(legend).toContain('A = api-call');
    });
});
