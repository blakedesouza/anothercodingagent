import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import { execSync } from 'node:child_process';
import { truncateUtf8 } from './context-request.js';

export interface EvidencePackOptions {
    projectDir: string;
    paths?: string[];
    packRepo?: boolean;
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
}

export interface EvidencePackSummary {
    project_dir: string;
    candidate_files: number;
    included_files: number;
    truncated_files: string[];
    omitted: string[];
    pack_bytes: number;
    max_files: number;
    absolute_max_files: number;
    max_file_bytes: number;
    max_total_bytes: number;
}

export interface EvidencePack {
    text: string;
    summary: EvidencePackSummary;
}

const ABSOLUTE_MAX_FILES = 10;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_FILE_BYTES = 8_000;
const DEFAULT_MAX_TOTAL_BYTES = 240_000;
const IGNORE_DIRS = new Set([
    '.git',
    'node_modules',
    'dist',
    'coverage',
    '.aca',
    '.claude',
    '.codex',
]);

function isInside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`));
}

function normalizeRel(root: string, path: string): string | null {
    const resolved = resolve(root, path);
    if (!isInside(root, resolved)) return null;
    return relative(root, resolved).split(sep).join('/');
}

function isIgnoredRel(relPath: string): boolean {
    return relPath.split('/').some(part => IGNORE_DIRS.has(part) || part.startsWith('bug-report-'));
}

function looksBinary(path: string): boolean {
    try {
        const buffer = readFileSync(path);
        return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
    } catch {
        return true;
    }
}

function walkFiles(root: string, startRel: string, out: string[]): void {
    if (isIgnoredRel(startRel)) return;
    const absolute = resolve(root, startRel);
    const stats = statSync(absolute);
    if (stats.isFile()) {
        out.push(startRel);
        return;
    }
    if (!stats.isDirectory()) return;
    for (const entry of readdirSync(absolute).sort()) {
        const rel = startRel ? `${startRel}/${entry}` : entry;
        if (IGNORE_DIRS.has(basename(rel)) || isIgnoredRel(rel)) continue;
        walkFiles(root, rel, out);
    }
}

function changedFiles(root: string): string[] {
    try {
        const output = execSync('git diff --name-only --diff-filter=ACMRTUXB HEAD --', {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

function rankFiles(root: string, files: string[], changed: Set<string>): string[] {
    return [...new Set(files)]
        .filter(file => !isIgnoredRel(file))
        .filter(file => {
            try {
                return statSync(resolve(root, file)).isFile() && !looksBinary(resolve(root, file));
            } catch {
                return false;
            }
        })
        .sort((a, b) => {
            const changedDelta = Number(changed.has(b)) - Number(changed.has(a));
            if (changedDelta !== 0) return changedDelta;
            const srcDelta = Number(b.startsWith('src/')) - Number(a.startsWith('src/'));
            if (srcDelta !== 0) return srcDelta;
            const testDelta = Number(b.startsWith('test/')) - Number(a.startsWith('test/'));
            if (testDelta !== 0) return testDelta;
            return a.localeCompare(b);
        });
}

export function buildEvidencePack(options: EvidencePackOptions): EvidencePack {
    const root = resolve(options.projectDir);
    const maxFiles = Math.min(options.maxFiles ?? DEFAULT_MAX_FILES, ABSOLUTE_MAX_FILES);
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const candidates: string[] = [];

    if (options.paths && options.paths.length > 0) {
        for (const rawPath of options.paths) {
            const rel = normalizeRel(root, rawPath);
            if (!rel || isIgnoredRel(rel)) continue;
            try {
                const stats = statSync(resolve(root, rel));
                if (stats.isDirectory()) walkFiles(root, rel, candidates);
                if (stats.isFile()) candidates.push(rel);
            } catch {
                continue;
            }
        }
    } else if (options.packRepo) {
        walkFiles(root, '', candidates);
    }

    const changed = new Set(changedFiles(root));
    const ranked = rankFiles(root, candidates, changed);
    const sections: string[] = ['# ACA Evidence Pack', '', `Project: ${root}`, ''];
    const truncatedFiles: string[] = [];
    const omitted: string[] = [];
    let included = 0;

    for (const rel of ranked) {
        if (included >= maxFiles) {
            omitted.push(`${rel}: max files reached`);
            continue;
        }
        const absolute = resolve(root, rel);
        let raw: string;
        try {
            raw = readFileSync(absolute, 'utf8');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            omitted.push(`${rel}: ${message}`);
            continue;
        }
        const text = truncateUtf8(raw, maxFileBytes);
        const truncated = text !== raw;
        const section = `## ${rel}\n\n\`\`\`text\n${text}\n\`\`\`${truncated ? `\n\n[TRUNCATED — file exceeds the ${maxFileBytes}-byte pack limit. Use needs_context to request specific line ranges from this file if more context is needed.]` : ''}\n`;
        const nextBytes = Buffer.byteLength(`${sections.join('\n')}\n${section}`, 'utf8');
        if (nextBytes > maxTotalBytes) {
            omitted.push(`${rel}: total pack cap reached`);
            continue;
        }
        sections.push(section);
        included++;
        if (truncated) truncatedFiles.push(rel);
    }

    const text = sections.join('\n');
    return {
        text,
        summary: {
            project_dir: root,
            candidate_files: ranked.length,
            included_files: included,
            truncated_files: truncatedFiles,
            omitted,
            pack_bytes: Buffer.byteLength(text, 'utf8'),
            max_files: maxFiles,
            absolute_max_files: ABSOLUTE_MAX_FILES,
            max_file_bytes: maxFileBytes,
            max_total_bytes: maxTotalBytes,
        },
    };
}

export function appendEvidencePack(prompt: string, pack: EvidencePack): string {
    return `${prompt.trimEnd()}

## Deterministic Evidence Pack

The following repo context was read by ACA before witness invocation.
These pre-read files do not consume witness or triage tool steps. They still consume prompt input tokens.
The packed file contents count as evidence the witness has already read.

${pack.text}
`;
}
