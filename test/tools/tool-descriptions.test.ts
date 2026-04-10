/**
 * C11.4 — Tool description quality assertions.
 *
 * Anthropic's guideline: 3–4 sentences minimum for tools the model uses
 * frequently. This file enforces that floor so future edits don't accidentally
 * thin out descriptions that models rely on for correct tool selection.
 */

import { describe, it, expect } from 'vitest';

import { readFileSpec } from '../../src/tools/read-file.js';
import { editFileSpec } from '../../src/tools/edit-file.js';
import { execCommandSpec } from '../../src/tools/exec-command.js';
import { searchTextSpec } from '../../src/tools/search-text.js';
import { writeFileSpec } from '../../src/tools/write-file.js';
import { statPathSpec } from '../../src/tools/stat-path.js';
import { movePathSpec } from '../../src/tools/move-path.js';
import { deletePathSpec } from '../../src/tools/delete-path.js';
import { makeDirectorySpec } from '../../src/tools/make-directory.js';
import { findPathsSpec } from '../../src/tools/find-paths.js';
import { askUserSpec } from '../../src/tools/ask-user.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Count sentences in a description string.
 * Counts mid-text sentence boundaries (". ") plus 1 if the string ends with
 * terminal punctuation. This is intentionally simple — descriptions should use
 * plain prose sentences, not abbreviations like "e.g." mid-text.
 */
function countSentences(text: string): number {
    const mid = (text.match(/\. /g) ?? []).length;
    const terminal = /[.!?]$/.test(text.trim()) ? 1 : 0;
    return mid + terminal;
}

// ---------------------------------------------------------------------------
// Priority tools — must have 3+ sentences (frequently used, high impact)
// ---------------------------------------------------------------------------

const PRIORITY_TOOLS = [
    { spec: readFileSpec, label: 'read_file' },
    { spec: editFileSpec, label: 'edit_file' },
    { spec: execCommandSpec, label: 'exec_command' },
    { spec: searchTextSpec, label: 'search_text' },
    { spec: writeFileSpec, label: 'write_file' },
];

describe('tool descriptions — priority tools (3+ sentences)', () => {
    for (const { spec, label } of PRIORITY_TOOLS) {
        it(`${label} has at least 3 sentences`, () => {
            const count = countSentences(spec.description);
            expect(count, `${label} description has ${count} sentence(s); expected >= 3`).toBeGreaterThanOrEqual(3);
        });
    }
});

// ---------------------------------------------------------------------------
// All tools — must have at least 2 sentences
// ---------------------------------------------------------------------------

const ALL_TOOLS = [
    ...PRIORITY_TOOLS,
    { spec: statPathSpec, label: 'stat_path' },
    { spec: movePathSpec, label: 'move_path' },
    { spec: deletePathSpec, label: 'delete_path' },
    { spec: makeDirectorySpec, label: 'make_directory' },
    { spec: findPathsSpec, label: 'find_paths' },
    { spec: askUserSpec, label: 'ask_user' },
];

describe('tool descriptions — all tools (2+ sentences)', () => {
    for (const { spec, label } of ALL_TOOLS) {
        it(`${label} has at least 2 sentences`, () => {
            const count = countSentences(spec.description);
            expect(count, `${label} description has ${count} sentence(s); expected >= 2`).toBeGreaterThanOrEqual(2);
        });
    }
});
