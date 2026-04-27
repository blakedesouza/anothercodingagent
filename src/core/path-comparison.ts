import { posix, win32 } from 'node:path';

type PathModule = typeof posix;

function looksLikeWindowsAbsolutePath(value: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function selectPathModule(...values: string[]): PathModule {
    return values.some(looksLikeWindowsAbsolutePath) ? win32 : posix;
}

function normalizeForComparison(pathModule: PathModule, value: string): string {
    const normalized = pathModule.resolve(pathModule.normalize(value));
    return pathModule === win32 ? normalized.toLowerCase() : normalized;
}

export function normalizePathForComparison(value: string): string {
    return normalizeForComparison(selectPathModule(value), value);
}

export function resolvePathWithInputStyle(...values: [string, ...string[]]): string {
    const pathModule = selectPathModule(...values);
    return pathModule.resolve(...values);
}

export function relativePathWithInputStyle(from: string, to: string): string {
    const pathModule = selectPathModule(from, to);
    return pathModule.relative(
        normalizeForComparison(pathModule, from),
        normalizeForComparison(pathModule, to),
    );
}

export function isAbsolutePath(value: string): boolean {
    return selectPathModule(value).isAbsolute(value);
}

export function pathsReferToSameLocation(left: string, right: string): boolean {
    const pathModule = selectPathModule(left, right);
    return normalizeForComparison(pathModule, left) === normalizeForComparison(pathModule, right);
}

export function isPathWithin(parent: string, child: string): boolean {
    const pathModule = selectPathModule(parent, child);
    const normalizedParent = normalizeForComparison(pathModule, parent);
    const normalizedChild = normalizeForComparison(pathModule, child);
    const rel = pathModule.relative(normalizedParent, normalizedChild);
    return rel === '' || (!!rel && !rel.startsWith('..') && !pathModule.isAbsolute(rel));
}

export function isFilesystemRootPath(value: string): boolean {
    const pathModule = selectPathModule(value);
    const normalized = normalizeForComparison(pathModule, value);
    const root = normalizeForComparison(pathModule, pathModule.parse(normalized).root);
    return normalized === root;
}
