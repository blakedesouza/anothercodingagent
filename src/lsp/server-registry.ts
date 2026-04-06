/**
 * LSP Server Registry — static mapping of file extensions to language server configurations.
 *
 * Each entry specifies:
 * - command/args to start the server (stdio transport)
 * - rootMarkers for workspace root detection
 * - fileGlobs for which files this server handles
 * - installHint shown when the server binary is missing
 *
 * typescript-language-server is bundled (the agent's own ecosystem).
 * All other servers are expected pre-installed on PATH.
 */

// --- Types ---

export interface LspServerConfig {
    /** Unique server identifier (e.g., 'typescript', 'pyright'). */
    readonly serverId: string;
    /** Human-readable language name. */
    readonly language: string;
    /** Command to start the server. */
    readonly command: string;
    /** Arguments passed to the command. */
    readonly args: readonly string[];
    /** Files that indicate the workspace root (e.g., tsconfig.json, pyproject.toml). */
    readonly rootMarkers: readonly string[];
    /** Glob patterns for files this server handles (e.g., '*.ts', '*.tsx'). */
    readonly fileGlobs: readonly string[];
    /** Hint shown to the user when the server is not found on PATH. */
    readonly installHint: string;
}

// --- Built-in server configs ---

export const BUILTIN_SERVERS: readonly LspServerConfig[] = [
    {
        serverId: 'typescript',
        language: 'TypeScript',
        command: 'typescript-language-server',
        args: ['--stdio'],
        rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
        fileGlobs: ['*.ts', '*.tsx', '*.js', '*.jsx'],
        installHint: 'npm install -g typescript-language-server typescript',
    },
    {
        serverId: 'pyright',
        language: 'Python',
        command: 'pyright-langserver',
        args: ['--stdio'],
        rootMarkers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'],
        fileGlobs: ['*.py', '*.pyi'],
        installHint: 'pip install pyright',
    },
    {
        serverId: 'rust-analyzer',
        language: 'Rust',
        command: 'rust-analyzer',
        args: [],
        rootMarkers: ['Cargo.toml'],
        fileGlobs: ['*.rs'],
        installHint: 'rustup component add rust-analyzer',
    },
    {
        serverId: 'gopls',
        language: 'Go',
        command: 'gopls',
        args: ['serve'],
        rootMarkers: ['go.mod'],
        fileGlobs: ['*.go'],
        installHint: 'go install golang.org/x/tools/gopls@latest',
    },
    {
        serverId: 'clangd',
        language: 'C/C++',
        command: 'clangd',
        args: [],
        rootMarkers: ['compile_commands.json', 'CMakeLists.txt', '.clangd'],
        fileGlobs: ['*.c', '*.cc', '*.cpp', '*.cxx', '*.h', '*.hh', '*.hpp', '*.hxx'],
        installHint: 'Install clangd via your system package manager (e.g., apt install clangd)',
    },
    {
        serverId: 'lua-language-server',
        language: 'Lua',
        command: 'lua-language-server',
        args: [],
        rootMarkers: ['.luarc.json', '.luarc.jsonc'],
        fileGlobs: ['*.lua'],
        installHint: 'Install lua-language-server from https://github.com/LuaLS/lua-language-server',
    },
    {
        serverId: 'zls',
        language: 'Zig',
        command: 'zls',
        args: [],
        rootMarkers: ['build.zig'],
        fileGlobs: ['*.zig'],
        installHint: 'Install zls from https://github.com/zigtools/zls',
    },
];

// --- Extension-to-server mapping ---

/** Maps file extensions (without dot) to server IDs. Built once from BUILTIN_SERVERS. */
const EXT_TO_SERVER_ID = new Map<string, string>();

for (const server of BUILTIN_SERVERS) {
    for (const glob of server.fileGlobs) {
        // Extract extension from simple *.ext globs
        const match = glob.match(/^\*\.(\w+)$/);
        if (match) {
            EXT_TO_SERVER_ID.set(match[1], server.serverId);
        }
    }
}

/** Look up the server config for a file extension (without dot). Returns undefined if no server is registered. */
export function getServerForExtension(ext: string): LspServerConfig | undefined {
    const serverId = EXT_TO_SERVER_ID.get(ext);
    if (!serverId) return undefined;
    return BUILTIN_SERVERS.find(s => s.serverId === serverId);
}

/** Look up a server config by its ID. */
export function getServerById(serverId: string): LspServerConfig | undefined {
    return BUILTIN_SERVERS.find(s => s.serverId === serverId);
}

/** Get the capability ID for a given server. Used for health tracking (e.g., 'lsp:typescript'). */
export function lspCapabilityId(serverId: string): string {
    return `lsp:${serverId}`;
}
