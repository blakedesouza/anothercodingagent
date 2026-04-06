/**
 * Tests for symbol-extractor (Block 20, M6.4).
 */

import { describe, it, expect } from 'vitest';
import { extractSymbols, detectLanguage } from '../../src/indexing/symbol-extractor.js';

describe('detectLanguage', () => {
    it('maps known extensions', () => {
        expect(detectLanguage('.ts')).toBe('typescript');
        expect(detectLanguage('.py')).toBe('python');
        expect(detectLanguage('.rs')).toBe('rust');
        expect(detectLanguage('.go')).toBe('go');
        expect(detectLanguage('.java')).toBe('java');
    });

    it('returns null for unknown extensions', () => {
        expect(detectLanguage('.xyz')).toBeNull();
        expect(detectLanguage('.md')).toBeNull();
    });
});

describe('extractSymbols', () => {
    describe('TypeScript', () => {
        it('extracts function and class', () => {
            const code = `
function foo() {
    return 1;
}

class Bar {
    method() {}
}
`;
            const symbols = extractSymbols(code, 'typescript');
            const names = symbols.map(s => ({ name: s.name, kind: s.kind }));
            expect(names).toContainEqual({ name: 'foo', kind: 'function' });
            expect(names).toContainEqual({ name: 'Bar', kind: 'class' });
        });

        it('extracts export async function', () => {
            const code = `export async function fetchData() {\n    return null;\n}\n`;
            const symbols = extractSymbols(code, 'typescript');
            expect(symbols).toHaveLength(1);
            expect(symbols[0].name).toBe('fetchData');
            expect(symbols[0].kind).toBe('function');
        });

        it('extracts interface and type alias', () => {
            const code = `interface Foo {\n    bar: string;\n}\n\ntype Baz = string | number;\n`;
            const symbols = extractSymbols(code, 'typescript');
            const names = symbols.map(s => s.name);
            expect(names).toContain('Foo');
            expect(names).toContain('Baz');
        });

        it('extracts enum and const', () => {
            const code = `enum Color {\n    Red,\n    Blue\n}\n\nconst MAX = 100;\n`;
            const symbols = extractSymbols(code, 'typescript');
            const names = symbols.map(s => ({ name: s.name, kind: s.kind }));
            expect(names).toContainEqual({ name: 'Color', kind: 'enum' });
            expect(names).toContainEqual({ name: 'MAX', kind: 'const' });
        });

        it('promotes function to method inside class', () => {
            const code = `class Foo {\n    function bar() {\n        return 1;\n    }\n}\n`;
            const symbols = extractSymbols(code, 'typescript');
            const bar = symbols.find(s => s.name === 'bar');
            expect(bar).toBeDefined();
            expect(bar!.kind).toBe('method');
            expect(bar!.parentName).toBe('Foo');
        });
    });

    describe('Python', () => {
        it('extracts def and class', () => {
            const code = `def foo():\n    pass\n\nclass Bar:\n    def method(self):\n        pass\n`;
            const symbols = extractSymbols(code, 'python');
            const names = symbols.map(s => ({ name: s.name, kind: s.kind }));
            expect(names).toContainEqual({ name: 'foo', kind: 'function' });
            expect(names).toContainEqual({ name: 'Bar', kind: 'class' });
        });

        it('links method to parent class', () => {
            const code = `class Bar:\n    def method(self):\n        pass\n`;
            const symbols = extractSymbols(code, 'python');
            const method = symbols.find(s => s.name === 'method');
            expect(method).toBeDefined();
            expect(method!.kind).toBe('method');
            expect(method!.parentName).toBe('Bar');
        });
    });

    describe('Go', () => {
        it('extracts func and type struct', () => {
            const code = `func Foo() {\n}\n\ntype Bar struct {\n    Name string\n}\n`;
            const symbols = extractSymbols(code, 'go');
            const names = symbols.map(s => ({ name: s.name, kind: s.kind }));
            expect(names).toContainEqual({ name: 'Foo', kind: 'function' });
            expect(names).toContainEqual({ name: 'Bar', kind: 'struct' });
        });
    });

    describe('Rust', () => {
        it('extracts fn, struct, and impl', () => {
            const code = `fn foo() {\n}\n\nstruct Bar {\n    x: i32,\n}\n\nimpl Bar {\n    fn method(&self) {}\n}\n`;
            const symbols = extractSymbols(code, 'rust');
            const names = symbols.map(s => ({ name: s.name, kind: s.kind }));
            expect(names).toContainEqual({ name: 'foo', kind: 'function' });
            expect(names).toContainEqual({ name: 'Bar', kind: 'struct' });
            expect(names).toContainEqual({ name: 'Bar', kind: 'impl' });
        });
    });

    describe('Java', () => {
        it('extracts class and method', () => {
            const code = `public class Bar {\n    public void foo() {\n    }\n}\n`;
            const symbols = extractSymbols(code, 'java');
            const names = symbols.map(s => ({ name: s.name, kind: s.kind }));
            expect(names).toContainEqual({ name: 'Bar', kind: 'class' });
            // foo should be detected as method inside Bar
            const foo = symbols.find(s => s.name === 'foo');
            expect(foo).toBeDefined();
            expect(foo!.kind).toBe('method');
        });
    });

    describe('Unknown language', () => {
        it('returns empty array', () => {
            const code = 'some unknown code\n';
            expect(extractSymbols(code, 'brainfuck')).toEqual([]);
        });
    });

    describe('symbol hierarchy', () => {
        it('method linked to parent class', () => {
            const code = `class Foo {\n    function bar() {\n        return 1;\n    }\n    function baz() {\n        return 2;\n    }\n}\n`;
            const symbols = extractSymbols(code, 'typescript');
            const methods = symbols.filter(s => s.parentName === 'Foo');
            expect(methods.length).toBeGreaterThanOrEqual(2);
            for (const m of methods) {
                expect(m.kind).toBe('method');
            }
        });
    });
});
