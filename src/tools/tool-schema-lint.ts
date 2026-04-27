import type { ToolRegistry, ToolSpec } from './tool-registry.js';

export type ToolSchemaLintSeverity = 'error' | 'warning';

export interface ToolSchemaLintIssue {
    toolName: string;
    severity: ToolSchemaLintSeverity;
    code: string;
    path: string;
    message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredSet(schema: Record<string, unknown>): Set<string> {
    return new Set(
        Array.isArray(schema.required)
            ? schema.required.filter((item): item is string => typeof item === 'string')
            : [],
    );
}

function addIssue(
    issues: ToolSchemaLintIssue[],
    toolName: string,
    severity: ToolSchemaLintSeverity,
    code: string,
    path: string,
    message: string,
): void {
    issues.push({ toolName, severity, code, path, message });
}

function lintSchemaObject(
    issues: ToolSchemaLintIssue[],
    toolName: string,
    schema: Record<string, unknown>,
    path: string,
    isTopLevel: boolean,
): void {
    if (schema.type !== 'object') return;

    if (schema.additionalProperties !== false) {
        addIssue(
            issues,
            toolName,
            isTopLevel ? 'error' : 'warning',
            'tool_schema.additional_properties',
            path,
            'Object schemas should set additionalProperties: false for strict tool-call compatibility.',
        );
    }

    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = requiredSet(schema);
    for (const propertyName of Object.keys(properties)) {
        const propertyPath = `${path}.${propertyName}`;
        if (!required.has(propertyName)) {
            addIssue(
                issues,
                toolName,
                'warning',
                'tool_schema.optional_property',
                propertyPath,
                'Strict-mode providers often require every object property to be listed in required; represent optional fields with nullable schemas when strict mode is enabled.',
            );
        }
        const propertySchema = properties[propertyName];
        if (isRecord(propertySchema)) {
            lintAnySchema(issues, toolName, propertySchema, propertyPath, false);
        }
    }
}

function lintAnySchema(
    issues: ToolSchemaLintIssue[],
    toolName: string,
    schema: Record<string, unknown>,
    path: string,
    isTopLevel: boolean,
): void {
    lintSchemaObject(issues, toolName, schema, path, isTopLevel);

    if (schema.type === 'array' && isRecord(schema.items)) {
        lintAnySchema(issues, toolName, schema.items, `${path}[]`, false);
    }

    if (Array.isArray(schema.anyOf)) {
        schema.anyOf.forEach((entry, index) => {
            if (isRecord(entry)) {
                lintAnySchema(issues, toolName, entry, `${path}.anyOf[${index}]`, false);
            }
        });
    }
}

export function lintToolSchema(tool: ToolSpec): ToolSchemaLintIssue[] {
    const issues: ToolSchemaLintIssue[] = [];

    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
        addIssue(
            issues,
            tool.name,
            'error',
            'tool_schema.invalid_name',
            '$.name',
            'Tool names should be portable lowercase snake_case with no spaces, dots, or dashes.',
        );
    }

    if (tool.description.trim().length === 0) {
        addIssue(
            issues,
            tool.name,
            'error',
            'tool_schema.missing_description',
            '$.description',
            'Tool descriptions must be non-empty so models can choose tools reliably.',
        );
    }

    if (!isRecord(tool.inputSchema) || tool.inputSchema.type !== 'object') {
        addIssue(
            issues,
            tool.name,
            'error',
            'tool_schema.top_level_object',
            '$',
            'Tool input schemas must be top-level JSON objects.',
        );
        return issues;
    }

    lintAnySchema(issues, tool.name, tool.inputSchema, '$', true);
    return issues;
}

export function lintToolRegistry(registry: ToolRegistry): ToolSchemaLintIssue[] {
    return registry.list().flatMap(tool => lintToolSchema(tool.spec));
}
