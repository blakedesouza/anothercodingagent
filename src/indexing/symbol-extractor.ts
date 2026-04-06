/**
 * Regex-based symbol extraction (Block 20, M6.4).
 *
 * Extracts top-level declarations (functions, classes, interfaces, etc.)
 * from source files using language-specific regex patterns. This is a
 * lightweight heuristic — not a full AST parser — that powers semantic
 * chunking and the symbol index.
 */

// --- Types ---

export type SymbolKind =
    | 'function'
    | 'class'
    | 'interface'
    | 'type'
    | 'enum'
    | 'const'
    | 'method'
    | 'struct'
    | 'impl'
    | 'module'
    | 'trait';

export interface ExtractedSymbol {
    name: string;
    kind: SymbolKind;
    startLine: number; // 1-based
    endLine: number;   // 1-based, inclusive
    signature: string | null;
    parentName: string | null; // name of containing class/struct/impl
}

// --- Language detection ---

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.scala': 'scala',
};

export function detectLanguage(ext: string): string | null {
    return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

// --- Pattern definitions ---

interface SymbolPattern {
    regex: RegExp;
    kind: SymbolKind;
    nameGroup: number; // capture group index for the symbol name
}

function tsPatterns(): SymbolPattern[] {
    return [
        { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m, kind: 'function', nameGroup: 1 },
        { regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m, kind: 'class', nameGroup: 1 },
        { regex: /^(?:export\s+)?interface\s+(\w+)/m, kind: 'interface', nameGroup: 1 },
        { regex: /^(?:export\s+)?type\s+(\w+)\s*=/m, kind: 'type', nameGroup: 1 },
        { regex: /^(?:export\s+)?enum\s+(\w+)/m, kind: 'enum', nameGroup: 1 },
        { regex: /^(?:export\s+)?(?:const|let)\s+(\w+)\s*[=:]/m, kind: 'const', nameGroup: 1 },
    ];
}

function pythonPatterns(): SymbolPattern[] {
    return [
        { regex: /^(?:async\s+)?def\s+(\w+)/m, kind: 'function', nameGroup: 1 },
        { regex: /^class\s+(\w+)/m, kind: 'class', nameGroup: 1 },
    ];
}

function rustPatterns(): SymbolPattern[] {
    return [
        { regex: /^(?:pub(?:\([\w:]+\))?\s+)?(?:async\s+)?fn\s+(\w+)/m, kind: 'function', nameGroup: 1 },
        { regex: /^(?:pub(?:\([\w:]+\))?\s+)?struct\s+(\w+)/m, kind: 'struct', nameGroup: 1 },
        { regex: /^(?:pub(?:\([\w:]+\))?\s+)?enum\s+(\w+)/m, kind: 'enum', nameGroup: 1 },
        { regex: /^impl(?:<[^>]*>)?\s+(\w+)/m, kind: 'impl', nameGroup: 1 },
        { regex: /^(?:pub(?:\([\w:]+\))?\s+)?trait\s+(\w+)/m, kind: 'trait', nameGroup: 1 },
        { regex: /^(?:pub(?:\([\w:]+\))?\s+)?mod\s+(\w+)/m, kind: 'module', nameGroup: 1 },
    ];
}

function goPatterns(): SymbolPattern[] {
    return [
        { regex: /^func\s+(\w+)/m, kind: 'function', nameGroup: 1 },
        { regex: /^func\s+\([^)]+\)\s+(\w+)/m, kind: 'method', nameGroup: 1 },
        { regex: /^type\s+(\w+)\s+struct/m, kind: 'struct', nameGroup: 1 },
        { regex: /^type\s+(\w+)\s+interface/m, kind: 'interface', nameGroup: 1 },
    ];
}

function javaPatterns(): SymbolPattern[] {
    return [
        { regex: /^(?:(?:public|private|protected|static|final|abstract)\s+)*class\s+(\w+)/m, kind: 'class', nameGroup: 1 },
        { regex: /^(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)*(?:\w+(?:<[^>]*>)?)\s+(\w+)\s*\(/m, kind: 'method', nameGroup: 1 },
        { regex: /^(?:(?:public|private|protected|static|final|abstract)\s+)*interface\s+(\w+)/m, kind: 'interface', nameGroup: 1 },
        { regex: /^(?:(?:public|private|protected|static|final)\s+)*enum\s+(\w+)/m, kind: 'enum', nameGroup: 1 },
    ];
}

function cPatterns(): SymbolPattern[] {
    return [
        // C function: optional qualifiers, return type, name, opening paren
        // Avoids nested quantifiers by matching qualifier words then a single type+name pair
        { regex: /^(?:(?:static|inline|const|unsigned|signed|long|short|void|extern)\s+)*(\w+)\s*\(/m, kind: 'function', nameGroup: 1 },
        { regex: /^(?:typedef\s+)?struct\s+(\w+)/m, kind: 'struct', nameGroup: 1 },
        { regex: /^(?:typedef\s+)?enum\s+(\w+)/m, kind: 'enum', nameGroup: 1 },
    ];
}

function csharpPatterns(): SymbolPattern[] {
    return [
        { regex: /^(?:(?:public|private|protected|internal|static|abstract|sealed|partial)\s+)*class\s+(\w+)/m, kind: 'class', nameGroup: 1 },
        { regex: /^(?:(?:public|private|protected|internal|static|abstract|sealed|partial)\s+)*interface\s+(\w+)/m, kind: 'interface', nameGroup: 1 },
        { regex: /^(?:(?:public|private|protected|internal|static|abstract|sealed|partial)\s+)*enum\s+(\w+)/m, kind: 'enum', nameGroup: 1 },
    ];
}

function rubyPatterns(): SymbolPattern[] {
    return [
        { regex: /^(?:\s*)def\s+(\w+)/m, kind: 'function', nameGroup: 1 },
        { regex: /^(?:\s*)class\s+(\w+)/m, kind: 'class', nameGroup: 1 },
        { regex: /^(?:\s*)module\s+(\w+)/m, kind: 'module', nameGroup: 1 },
    ];
}

function phpPatterns(): SymbolPattern[] {
    return [
        { regex: /^(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)/m, kind: 'function', nameGroup: 1 },
        { regex: /^(?:(?:abstract|final)\s+)?class\s+(\w+)/m, kind: 'class', nameGroup: 1 },
        { regex: /^interface\s+(\w+)/m, kind: 'interface', nameGroup: 1 },
        { regex: /^trait\s+(\w+)/m, kind: 'trait', nameGroup: 1 },
    ];
}

function swiftPatterns(): SymbolPattern[] {
    return [
        { regex: /^(?:(?:public|private|internal|open|fileprivate|static)\s+)*func\s+(\w+)/m, kind: 'function', nameGroup: 1 },
        { regex: /^(?:(?:public|private|internal|open|fileprivate|final)\s+)*class\s+(\w+)/m, kind: 'class', nameGroup: 1 },
        { regex: /^(?:(?:public|private|internal)\s+)*struct\s+(\w+)/m, kind: 'struct', nameGroup: 1 },
        { regex: /^(?:(?:public|private|internal)\s+)*enum\s+(\w+)/m, kind: 'enum', nameGroup: 1 },
        { regex: /^(?:(?:public|private|internal)\s+)*protocol\s+(\w+)/m, kind: 'interface', nameGroup: 1 },
    ];
}

function kotlinPatterns(): SymbolPattern[] {
    return [
        { regex: /^(?:(?:public|private|protected|internal|abstract|open|sealed|data)\s+)*fun\s+(\w+)/m, kind: 'function', nameGroup: 1 },
        { regex: /^(?:(?:public|private|protected|internal|abstract|open|sealed|data|enum)\s+)*class\s+(\w+)/m, kind: 'class', nameGroup: 1 },
        { regex: /^(?:(?:public|private|protected|internal)\s+)*interface\s+(\w+)/m, kind: 'interface', nameGroup: 1 },
        { regex: /^(?:(?:public|private|protected|internal)\s+)*object\s+(\w+)/m, kind: 'module', nameGroup: 1 },
    ];
}

function scalaPatterns(): SymbolPattern[] {
    return [
        { regex: /^(?:\s*)def\s+(\w+)/m, kind: 'function', nameGroup: 1 },
        { regex: /^(?:\s*)(?:case\s+)?class\s+(\w+)/m, kind: 'class', nameGroup: 1 },
        { regex: /^(?:\s*)trait\s+(\w+)/m, kind: 'trait', nameGroup: 1 },
        { regex: /^(?:\s*)object\s+(\w+)/m, kind: 'module', nameGroup: 1 },
    ];
}

const LANGUAGE_PATTERNS: Record<string, () => SymbolPattern[]> = {
    typescript: tsPatterns,
    javascript: tsPatterns, // JS uses same patterns (minus TS-only like interface/type)
    python: pythonPatterns,
    rust: rustPatterns,
    go: goPatterns,
    java: javaPatterns,
    c: cPatterns,
    cpp: cPatterns, // C++ reuses C patterns (simplified — no template extraction)
    csharp: csharpPatterns,
    ruby: rubyPatterns,
    php: phpPatterns,
    swift: swiftPatterns,
    kotlin: kotlinPatterns,
    scala: scalaPatterns,
};

// --- Brace/indent scope tracking ---

/**
 * Find the end line of a brace-delimited block starting at `startLine`.
 * Counts `{` and `}` to find the matching close brace.
 * Returns `startLine` if no opening brace is found on or after startLine.
 */
function findBraceEnd(lines: string[], startLineIdx: number): number {
    let depth = 0;
    let foundOpen = false;

    for (let i = startLineIdx; i < lines.length; i++) {
        const line = lines[i];
        for (const ch of line) {
            if (ch === '{') {
                depth++;
                foundOpen = true;
            } else if (ch === '}') {
                depth--;
                if (foundOpen && depth === 0) {
                    return i;
                }
            }
        }
    }
    // No matching brace found — return last line
    return foundOpen ? lines.length - 1 : startLineIdx;
}

/**
 * Find the end line of an indent-delimited block (Python).
 * The block ends when a non-empty line has <= the indentation of the start line.
 */
function findIndentEnd(lines: string[], startLineIdx: number): number {
    const startIndent = getIndent(lines[startLineIdx]);
    let lastContentLine = startLineIdx;

    for (let i = startLineIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        // Skip blank lines
        if (line.trim().length === 0) continue;

        const indent = getIndent(line);
        if (indent <= startIndent) {
            break;
        }
        lastContentLine = i;
    }

    return lastContentLine;
}

function getIndent(line: string): number {
    let count = 0;
    for (const ch of line) {
        if (ch === ' ') count++;
        else if (ch === '\t') count += 4;
        else break;
    }
    return count;
}

// --- Main extraction ---

/**
 * Extract symbols from source code.
 *
 * @param content - File content as a string
 * @param language - Language identifier (e.g. 'typescript', 'python')
 * @returns Array of extracted symbols with line ranges and parent info
 */
export function extractSymbols(content: string, language: string): ExtractedSymbol[] {
    const patternFactory = LANGUAGE_PATTERNS[language];
    if (!patternFactory) return [];

    const patterns = patternFactory();
    const lines = content.split('\n');
    const symbols: ExtractedSymbol[] = [];
    const useIndent = language === 'python' || language === 'ruby';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip empty lines and comments
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

        for (const pattern of patterns) {
            const match = trimmed.match(pattern.regex);
            if (!match) continue;

            const name = match[pattern.nameGroup];
            if (!name) continue;

            const startLine = i + 1; // 1-based
            const endLineIdx = useIndent
                ? findIndentEnd(lines, i)
                : findBraceEnd(lines, i);
            const endLine = endLineIdx + 1; // 1-based

            // Extract signature (the matched line, trimmed)
            const signature = trimmed;

            symbols.push({
                name,
                kind: pattern.kind,
                startLine,
                endLine,
                signature,
                parentName: null, // filled in below
            });

            break; // Only match first pattern per line
        }
    }

    // Assign parent relationships: methods inside classes
    assignParents(symbols);

    return symbols;
}

/**
 * Assign parentName for symbols nested inside class/struct/impl blocks.
 * A symbol B is a child of symbol A if B's line range is fully contained
 * within A's line range and A is a container kind (class, struct, impl, module, trait).
 */
function assignParents(symbols: ExtractedSymbol[]): void {
    const containerKinds = new Set<SymbolKind>(['class', 'struct', 'impl', 'module', 'trait']);

    for (const sym of symbols) {
        if (containerKinds.has(sym.kind)) continue;

        // Find the tightest container
        let bestParent: ExtractedSymbol | null = null;
        let bestSize = Infinity;

        for (const candidate of symbols) {
            if (candidate === sym) continue;
            if (!containerKinds.has(candidate.kind)) continue;
            if (candidate.startLine <= sym.startLine && candidate.endLine >= sym.endLine) {
                const size = candidate.endLine - candidate.startLine;
                if (size < bestSize) {
                    bestSize = size;
                    bestParent = candidate;
                }
            }
        }

        if (bestParent) {
            sym.parentName = bestParent.name;
            // Promote to method if inside a class
            if (sym.kind === 'function') {
                sym.kind = 'method';
            }
        }
    }
}
