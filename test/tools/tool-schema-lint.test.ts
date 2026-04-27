import { describe, expect, it } from 'vitest';
import { lintToolSchema } from '../../src/tools/tool-schema-lint.js';
import type { ToolSpec } from '../../src/tools/tool-registry.js';

function makeTool(overrides: Partial<ToolSpec> = {}): ToolSpec {
    return {
        name: 'read_file',
        description: 'Read a file from the workspace.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Workspace-relative or absolute path.' },
            },
            required: ['path'],
            additionalProperties: false,
        },
        approvalClass: 'read-only',
        idempotent: true,
        timeoutCategory: 'file',
        ...overrides,
    };
}

describe('lintToolSchema', () => {
    it('accepts a strict-ready top-level object schema', () => {
        expect(lintToolSchema(makeTool())).toEqual([]);
    });

    it('fails invalid portable tool names', () => {
        const issues = lintToolSchema(makeTool({ name: 'read-file' }));
        expect(issues).toContainEqual(expect.objectContaining({
            severity: 'error',
            code: 'tool_schema.invalid_name',
        }));
    });

    it('fails missing tool descriptions', () => {
        const issues = lintToolSchema(makeTool({ description: '' }));
        expect(issues).toContainEqual(expect.objectContaining({
            severity: 'error',
            code: 'tool_schema.missing_description',
        }));
    });

    it('fails schemas without top-level additionalProperties false', () => {
        const issues = lintToolSchema(makeTool({
            inputSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
            },
        }));
        expect(issues).toContainEqual(expect.objectContaining({
            severity: 'error',
            code: 'tool_schema.additional_properties',
            path: '$',
        }));
    });

    it('warns when an object property is not required', () => {
        const issues = lintToolSchema(makeTool({
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    line_start: { type: 'integer' },
                },
                required: ['path'],
                additionalProperties: false,
            },
        }));
        expect(issues).toContainEqual(expect.objectContaining({
            severity: 'warning',
            code: 'tool_schema.optional_property',
            path: '$.line_start',
        }));
    });

    it('warns about nested objects without additionalProperties false', () => {
        const issues = lintToolSchema(makeTool({
            inputSchema: {
                type: 'object',
                properties: {
                    filter: {
                        type: 'object',
                        properties: { pattern: { type: 'string' } },
                        required: ['pattern'],
                    },
                },
                required: ['filter'],
                additionalProperties: false,
            },
        }));
        expect(issues).toContainEqual(expect.objectContaining({
            severity: 'warning',
            code: 'tool_schema.additional_properties',
            path: '$.filter',
        }));
    });
});
