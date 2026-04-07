import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ToolOutput } from '../types/conversation.js';
import type { ToolSpec, ToolImplementation, ToolContext } from './tool-registry.js';
import { checkZone, resolveToolPath } from './workspace-sandbox.js';

// --- Constants ---

const MAX_LINES = 2_000;
const MAX_BYTES = 64 * 1024; // 64 KiB
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MiB — prevents OOM on huge files

/** Extensions treated as binary regardless of content. */
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
    '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mkv', '.mov',
    '.zip', '.gz', '.tar', '.bz2', '.xz', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.wasm', '.pdf', '.ttf', '.otf', '.woff', '.woff2',
    '.class', '.pyc', '.o', '.a', '.lib',
]);

/** Extension → MIME type (subset for common binary types). */
const MIME_MAP: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.webm': 'video/webm',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.pdf': 'application/pdf',
    '.wasm': 'application/wasm',
    '.exe': 'application/x-executable',
    '.dll': 'application/x-msdownload',
};

// --- Tool spec ---

export const readFileSpec: ToolSpec = {
    name: 'read_file',
    description: 'Read the contents of a file at the given path. Supports optional line range selection.',
    inputSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', minLength: 1 },
            line_start: { type: 'integer', minimum: 1 },
            line_end: { type: 'integer', minimum: 1 },
        },
        required: ['path'],
        additionalProperties: false,
    },
    approvalClass: 'read-only',
    idempotent: true,
    timeoutCategory: 'file',
};

// --- Helpers ---

function errorOutput(code: string, message: string): ToolOutput {
    return {
        status: 'error',
        data: '',
        error: { code, message, retryable: false },
        truncated: false,
        bytesReturned: 0,
        bytesOmitted: 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    };
}

function isBinaryExtension(filePath: string): boolean {
    return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function getMimeType(filePath: string): string {
    return MIME_MAP[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** Check if a buffer contains null bytes (binary indicator). */
function hasNullBytes(buf: Buffer): boolean {
    const checkLength = Math.min(buf.length, 1024);
    for (let i = 0; i < checkLength; i++) {
        if (buf[i] === 0) return true;
    }
    return false;
}

// --- Implementation ---

export const readFileImpl: ToolImplementation = async (
    args: Record<string, unknown>,
    context: ToolContext,
): Promise<ToolOutput> => {
    const filePath = args.path as string;
    const lineStart = args.line_start as number | undefined;
    const lineEnd = args.line_end as number | undefined;

    // Zone check — must be within allowed sandbox zones
    const denied = await checkZone(filePath, context);
    if (denied) return denied;
    const targetPath = resolveToolPath(filePath, context);

    // Validate line range
    if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
        return errorOutput('tool.invalid_input', `line_end (${lineEnd}) must be >= line_start (${lineStart})`);
    }

    // Check if file exists and get stats
    let fileStats;
    try {
        fileStats = await stat(targetPath);
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'ENOENT') {
            return errorOutput('tool.not_found', `File not found: ${filePath}`);
        }
        if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
            return errorOutput('tool.permission_denied', `Permission denied: ${filePath}`);
        }
        return errorOutput('tool.not_found', `Cannot access file: ${filePath} (${nodeErr.code})`);
    }

    // Must be a regular file
    if (!fileStats.isFile()) {
        if (fileStats.isDirectory()) {
            return errorOutput('tool.is_directory', `Path is a directory: ${filePath}`);
        }
        return errorOutput('tool.not_file', `Path is not a regular file: ${filePath}`);
    }

    // Prevent OOM on huge files
    if (fileStats.size > MAX_FILE_SIZE) {
        return errorOutput('tool.file_too_large',
            `File exceeds ${MAX_FILE_SIZE} byte limit (${fileStats.size} bytes). Use line_start/line_end to read a range.`);
    }

    // Binary detection: extension heuristic first
    if (isBinaryExtension(filePath)) {
        const data = JSON.stringify({
            isBinary: true,
            size: fileStats.size,
            mimeType: getMimeType(filePath),
        });
        return {
            status: 'success',
            data,
            truncated: false,
            bytesReturned: Buffer.byteLength(data, 'utf8'),
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        };
    }

    // Read the raw buffer for null-byte detection
    let rawBuf: Buffer;
    try {
        rawBuf = await readFile(targetPath);
    } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === 'ENOENT') {
            return errorOutput('tool.not_found', `File not found: ${filePath}`);
        }
        if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
            return errorOutput('tool.permission_denied', `Permission denied: ${filePath}`);
        }
        return errorOutput('tool.io_error', `Cannot read file: ${filePath} (${nodeErr.code})`);
    }

    // Binary detection: null-byte check on first 1 KiB
    if (hasNullBytes(rawBuf)) {
        const data = JSON.stringify({
            isBinary: true,
            size: fileStats.size,
            mimeType: getMimeType(filePath),
        });
        return {
            status: 'success',
            data,
            truncated: false,
            bytesReturned: Buffer.byteLength(data, 'utf8'),
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        };
    }

    // Decode as UTF-8
    const content = rawBuf.toString('utf8');
    const allLines = content.split('\n');
    // If file ends with \n, the split produces a trailing empty string — don't count it as a line
    const totalLines = content.length === 0
        ? 0
        : (content.endsWith('\n') ? allLines.length - 1 : allLines.length);
    const totalBytes = rawBuf.length;

    // Handle empty file
    if (totalLines === 0) {
        const data = JSON.stringify({
            content: '',
            encoding: 'utf-8',
            lineCount: 0,
            byteCount: totalBytes,
        });
        return {
            status: 'success',
            data,
            truncated: false,
            bytesReturned: Buffer.byteLength(data, 'utf8'),
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        };
    }

    // Apply line range if specified
    let startIdx = 0; // 0-based inclusive
    let endIdx = totalLines - 1; // 0-based inclusive
    let isRanged = false;

    if (lineStart !== undefined) {
        startIdx = lineStart - 1; // Convert 1-indexed to 0-indexed
        isRanged = true;
    }
    if (lineEnd !== undefined) {
        endIdx = Math.min(lineEnd - 1, totalLines - 1);
        isRanged = true;
    }

    // line_start > total lines → empty content with metadata
    if (startIdx >= totalLines) {
        const data = JSON.stringify({
            content: '',
            encoding: 'utf-8',
            lineCount: 0,
            byteCount: totalBytes,
            totalLines,
            totalBytes,
            nextStartLine: null,
        });
        return {
            status: 'success',
            data,
            truncated: false,
            bytesReturned: Buffer.byteLength(data, 'utf8'),
            bytesOmitted: 0,
            retryable: false,
            timedOut: false,
            mutationState: 'none',
        };
    }

    // Extract the target lines
    let selectedLines = allLines.slice(startIdx, endIdx + 1);
    let truncated = false;
    let truncationReason: 'lines' | 'bytes' | undefined;

    // Apply whichever-first truncation: 2,000 lines or 64 KiB
    // The 64 KiB limit applies to the final JSON `data` string (not just content),
    // so we must measure the serialized envelope, not raw text.
    if (selectedLines.length > MAX_LINES) {
        selectedLines = selectedLines.slice(0, MAX_LINES);
        truncated = true;
        truncationReason = 'lines';
    }

    // Helper to build the final JSON data string from current selectedLines
    const buildData = (lines: string[], isTruncated: boolean, reason?: 'lines' | 'bytes') => {
        const text = lines.join('\n');
        const textBytes = Buffer.byteLength(text, 'utf8');
        const lineCount = lines.length;
        const nextLine = startIdx + lineCount + 1; // 1-indexed

        const meta: Record<string, unknown> = {
            content: text,
            encoding: 'utf-8',
            lineCount,
            byteCount: textBytes,
        };

        if (isRanged || isTruncated) {
            meta.totalLines = totalLines;
            meta.totalBytes = totalBytes;
            meta.nextStartLine = nextLine <= totalLines ? nextLine : null;
        }
        if (isTruncated) {
            meta.truncationReason = reason;
        }

        return JSON.stringify(meta);
    };

    // Check if the serialized envelope exceeds 64 KiB
    let data = buildData(selectedLines, truncated, truncationReason);

    if (Buffer.byteLength(data, 'utf8') > MAX_BYTES) {
        // Trim lines from the end until the full JSON envelope fits
        truncated = true;
        truncationReason = 'bytes';
        while (selectedLines.length > 0 && Buffer.byteLength(data, 'utf8') > MAX_BYTES) {
            selectedLines.pop();
            data = buildData(selectedLines, true, 'bytes');
        }
    }

    const resultText = selectedLines.join('\n');
    const resultBytes = Buffer.byteLength(resultText, 'utf8');

    return {
        status: 'success',
        data,
        truncated,
        bytesReturned: Buffer.byteLength(data, 'utf8'),
        bytesOmitted: truncated ? (totalBytes - resultBytes) : 0,
        retryable: false,
        timedOut: false,
        mutationState: 'none',
    };
};
