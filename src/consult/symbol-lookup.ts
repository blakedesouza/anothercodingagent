import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative, win32 } from 'node:path';

const execFileAsync = promisify(execFile);

export interface SymbolLocation {
    identifier: string;
    file: string;    // relative path from project root, e.g. "src/cli/invoke-output-validation.ts"
    line: number;    // 1-indexed definition line
    snippet: string; // the definition line itself, trimmed
}

// Words that look camelCase/PascalCase due to capitalisation but are common English.
const COMMON_ENGLISH_WORDS = new Set([
    'JavaScript', 'TypeScript', 'NodeJs', 'GitHub', 'CamelCase', 'PascalCase',
]);

function escapeRegexLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWindowsPath(value: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function toPortableRelativePath(projectDir: string, absoluteFile: string): string {
    const rel = (isWindowsPath(projectDir) || isWindowsPath(absoluteFile))
        ? win32.relative(projectDir, absoluteFile)
        : relative(projectDir, absoluteFile);
    return rel.split(/[\\/]+/).join('/');
}

export interface ParsedSymbolMatch {
    file: string;
    line: number;
    snippet: string;
}

/**
 * Parse an rg/grep match line of the form "{absolutePath}:{line}:{source line}".
 * Uses the first valid ":<digits>:" separator so Windows drive-letter paths keep working.
 */
export function _parseSearchResultLine(
    line: string,
    projectDir: string,
): ParsedSymbolMatch | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const match = /^(.+?):(\d+):(.*)$/.exec(trimmed);
    if (!match) return null;

    const [, absFile, lineStr, snippetRaw] = match;
    const lineNum = parseInt(lineStr, 10);
    if (!Number.isFinite(lineNum) || lineNum < 1) return null;

    return {
        file: toPortableRelativePath(projectDir, absFile),
        line: lineNum,
        snippet: snippetRaw.trim(),
    };
}

/**
 * Extracts camelCase and PascalCase identifiers from question text.
 * Filters out words shorter than 6 chars and common English words to avoid noise.
 * Examples: "countHardRejectedToolCalls" → extracted; "invoke" → filtered out.
 */
export function extractCodeIdentifiers(question: string): string[] {
    // camelCase: starts lowercase, contains at least one uppercase letter
    const camelCaseRe = /\b[a-z][a-zA-Z0-9]+[A-Z][a-zA-Z0-9]*\b/g;
    // PascalCase: starts uppercase, has lowercase then more uppercase (rules out "What", "The")
    const pascalCaseRe = /\b[A-Z][a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g;

    const found = new Set<string>();
    for (const match of question.matchAll(camelCaseRe)) {
        found.add(match[0]);
    }
    for (const match of question.matchAll(pascalCaseRe)) {
        found.add(match[0]);
    }

    return [...found]
        .filter(id => id.length >= 6 && !COMMON_ENGLISH_WORDS.has(id))
        .slice(0, 5);
}

/**
 * Greps src/ inside projectDir for export/function definition lines matching each identifier.
 * Uses child_process.execFile with rg or grep — no shell injection risk (args passed directly).
 * Returns at most one location per identifier (the first definition match).
 * Returns [] for identifiers with no match.
 */
export async function resolveSymbolLocations(
    identifiers: string[],
    projectDir: string,
): Promise<SymbolLocation[]> {
    const srcDir = join(projectDir, 'src');
    const results: SymbolLocation[] = [];

    for (const identifier of identifiers.slice(0, 5)) {
        if (results.length >= 5) break;

        // Regex covers all standard TypeScript export forms.
        // Escape defensively so direct callers cannot widen the search pattern.
        const escapedIdentifier = escapeRegexLiteral(identifier);
        const pattern =
            `export\\s+(async\\s+)?function\\s+${escapedIdentifier}\\b` +
            `|export\\s+(const|class|interface|type)\\s+${escapedIdentifier}\\b`;

        let stdout: string | null = null;

        // Try rg first (faster, always available in this project's dev env).
        try {
            const result = await execFileAsync('rg', ['-n', '--no-heading', '--color=never', '-e', pattern, srcDir]);
            stdout = result.stdout;
        } catch (err: unknown) {
            const e = err as { code?: number | string; stdout?: string };
            if (e.code === 1) {
                // rg exit 1 = no matches, which is normal
                continue;
            }
            if (e.code !== 'ENOENT') {
                // Unexpected rg error (e.g. bad flag) — skip this identifier
                continue;
            }
            // rg not available — fall back to grep
            try {
                const result = await execFileAsync('grep', ['-rn', '-E', pattern, srcDir]);
                stdout = result.stdout;
            } catch (grepErr: unknown) {
                const ge = grepErr as { code?: number | string };
                if (ge.code === 1) continue; // no matches
                continue; // unexpected grep error
            }
        }

        if (!stdout) continue;

        // Parse first match line: "/abs/path/file.ts:77:export function ..."
        const firstLine = stdout.split('\n').find(l => l.trim() !== '');
        if (!firstLine) continue;

        const parsed = _parseSearchResultLine(firstLine, projectDir);
        if (!parsed) continue;

        results.push({ identifier, ...parsed });
    }

    return results;
}
