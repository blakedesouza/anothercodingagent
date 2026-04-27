function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeToolArguments(toolName: string, args: unknown): Record<string, unknown> {
    if (!isRecord(args)) return {};

    if (toolName !== 'edit_file' || !Array.isArray(args.edits)) {
        return args;
    }

    return {
        ...args,
        edits: args.edits.map(edit => {
            if (!isRecord(edit)) return edit;
            const { oldText, newText, ...rest } = edit;
            if (typeof rest.search === 'string' && typeof rest.replace === 'string') {
                return rest;
            }
            if (typeof oldText === 'string' && typeof newText === 'string') {
                return {
                    ...rest,
                    search: oldText,
                    replace: newText,
                };
            }
            return rest;
        }),
    };
}
