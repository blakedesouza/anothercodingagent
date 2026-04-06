/**
 * M2.8 — Secrets Scrubbing Pipeline Tests
 *
 * Tests SecretScrubber class (both strategies) plus integration with
 * ConversationWriter (JSONL persistence) and TurnEngine (LLM context + tool output).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SecretScrubber } from '../../src/permissions/secret-scrubber.js';
import type { SecretPattern } from '../../src/permissions/secret-scrubber.js';
import { ConversationWriter } from '../../src/core/conversation-writer.js';
import type { ToolResultItem } from '../../src/types/conversation.js';
import type { ItemId, ToolCallId } from '../../src/types/ids.js';
import { MockNanoGPTServer } from '../helpers/mock-nanogpt-server.js';
import { TurnEngine } from '../../src/core/turn-engine.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { NanoGptDriver } from '../../src/providers/nanogpt-driver.js';
import { SequenceGenerator } from '../../src/types/sequence.js';

// =============================================================================
// Helpers
// =============================================================================

function makeScrubber(secrets: string[] = [], enabled = true): SecretScrubber {
    return new SecretScrubber(secrets, { enabled });
}

// =============================================================================
// Construction and disabled state
// =============================================================================

describe('SecretScrubber — construction and disabled state', () => {
    it('disabled → passthrough (text returned unchanged)', () => {
        const scrubber = makeScrubber(['sk-abc123def456ghi789jklmnop'], false);
        const text = 'API key: sk-abc123def456ghi789jklmnop';
        expect(scrubber.scrub(text)).toBe(text);
    });

    it('empty text → passthrough', () => {
        const scrubber = makeScrubber(['some-secret12345678901234']);
        expect(scrubber.scrub('')).toBe('');
    });

    it('empty scrubber (no known secrets, disabled patterns) → text unchanged', () => {
        const scrubber = makeScrubber([]);
        // Plain text that doesn't match any pattern
        const text = 'Hello world, nothing secret here.';
        expect(scrubber.scrub(text)).toBe(text);
    });

    it('non-secret strings → not modified', () => {
        const scrubber = makeScrubber(['sk-myrealkey123456789012345']);
        expect(scrubber.scrub('Hello, no secrets here!')).toBe('Hello, no secrets here!');
    });
});

// =============================================================================
// Strategy 1 — exact-value redaction
// =============================================================================

describe('SecretScrubber — Strategy 1 (exact-value)', () => {
    it('known API key in text → redacted to <redacted:api_key:1>', () => {
        const secret = 'sk-myrealkey123456789012345';
        const scrubber = makeScrubber([secret]);
        const result = scrubber.scrub(`Tool output: ${secret} — end`);
        expect(result).not.toContain(secret);
        expect(result).toBe('Tool output: <redacted:api_key:1> — end');
    });

    it('same key appears twice → same redaction ID', () => {
        const secret = 'mysecretapikey123456789012';
        const scrubber = makeScrubber([secret]);
        const result = scrubber.scrub(`First: ${secret} Second: ${secret}`);
        expect(result).toBe('First: <redacted:api_key:1> Second: <redacted:api_key:1>');
    });

    it('multiple distinct known secrets → different redaction IDs', () => {
        const s1 = 'firstsecretvalue12345678901';
        const s2 = 'secondsecretvalue1234567890';
        const scrubber = makeScrubber([s1, s2]);
        const result = scrubber.scrub(`${s1} and ${s2}`);
        expect(result).not.toContain(s1);
        expect(result).not.toContain(s2);
        expect(result).toContain('<redacted:api_key:1>');
        expect(result).toContain('<redacted:api_key:2>');
    });

    it('longer secret takes precedence over shorter prefix (longest-first)', () => {
        const short = 'secretshort12345678901234';
        const long = 'secretshort1234567890123456789'; // extends the short one
        const scrubber = makeScrubber([short, long]);
        const result = scrubber.scrub(`key=${long}`);
        // The longer secret should be fully replaced, not partially
        expect(result).not.toContain(long);
        expect(result).not.toContain(short);
    });
});

// =============================================================================
// Strategy 2 — baseline pattern detection
// =============================================================================

describe('SecretScrubber — Strategy 2 (baseline patterns)', () => {
    it('sk- prefix with 20+ chars → redacted as api_key', () => {
        const scrubber = makeScrubber([]);
        const result = scrubber.scrub('Found key: sk-abc123def456ghi789jkl in config');
        expect(result).not.toContain('sk-abc123def456ghi789jkl');
        expect(result).toContain('<redacted:api_key:');
    });

    it('Authorization: Bearer token → bearer type redacted', () => {
        const scrubber = makeScrubber([]);
        const result = scrubber.scrub('Header: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9');
        expect(result).not.toContain('Bearer eyJhbGciOiJIUzI1NiJ9');
        expect(result).toContain('<redacted:bearer:');
    });

    it('PEM private key block → pem_key type redacted', () => {
        const scrubber = makeScrubber([]);
        const pemBlock = [
            '-----BEGIN RSA PRIVATE KEY-----',
            'MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4w==',
            '-----END RSA PRIVATE KEY-----',
        ].join('\n');
        const result = scrubber.scrub(`Config contains:\n${pemBlock}\nEnd config`);
        expect(result).not.toContain('MIIEowIBAAKCAQEA');
        expect(result).toContain('<redacted:pem_key:');
    });

    it('ghp_ GitHub PAT (36+ chars) → redacted', () => {
        const pat = 'ghp_' + 'A'.repeat(36);
        const scrubber = makeScrubber([]);
        const result = scrubber.scrub(`token=${pat}`);
        expect(result).not.toContain(pat);
        expect(result).toContain('<redacted:api_key:');
    });

    it('glpat- GitLab PAT (20+ chars) → redacted', () => {
        const pat = 'glpat-' + 'x'.repeat(20);
        const scrubber = makeScrubber([]);
        const result = scrubber.scrub(`GITLAB_TOKEN=${pat}`);
        expect(result).not.toContain(pat);
        expect(result).toContain('<redacted:api_key:');
    });

    it('AKIA AWS access key (AKIA + 16 uppercase alphanum) → redacted', () => {
        const scrubber = makeScrubber([]);
        // Standard AWS test key: AKIA + 16 chars = 20 chars total
        const result = scrubber.scrub('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE extra');
        expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
        expect(result).toContain('<redacted:api_key:');
    });

    it('regular string "skeleton" → NOT redacted (false positive guard: sk- requires 20+ chars)', () => {
        const scrubber = makeScrubber([]);
        // "skeleton" contains "sk" but NOT "sk-", so no pattern matches
        expect(scrubber.scrub('skeleton key pattern')).toBe('skeleton key pattern');
    });

    it('sk- with only 5 chars → NOT redacted (below 20-char minimum)', () => {
        const scrubber = makeScrubber([]);
        // "sk-short" has only 5 chars after "sk-", below the 20-char minimum
        expect(scrubber.scrub('value sk-short end')).toBe('value sk-short end');
    });

    it('same pattern-matched secret twice → same redaction ID', () => {
        const secret = 'sk-duplicatedkey1234567890abc';
        const scrubber = makeScrubber([]);
        const result = scrubber.scrub(`${secret} and ${secret}`);
        // Both occurrences should produce the same placeholder
        const count = (result.match(/<redacted:api_key:1>/g) ?? []).length;
        expect(count).toBe(2);
        expect(result).not.toContain(secret);
    });

    it('strategy 1 assigns stable ID before strategy 2 can create a different one', () => {
        // Known secret that also matches the sk- pattern
        const secret = 'sk-knownsecret12345678901234';
        const scrubber = makeScrubber([secret]);
        const result = scrubber.scrub(`key1=${secret} key2=${secret}`);
        // Both should use the same ID from strategy 1
        expect((result.match(/<redacted:api_key:1>/g) ?? []).length).toBe(2);
        expect(result).not.toContain('<redacted:api_key:2>');
    });

    it('custom additional pattern → applied after baseline', () => {
        const custom: SecretPattern = {
            name: 'custom_test',
            pattern: /CUSTOM-[0-9]{8}/,
            type: 'custom',
        };
        const scrubber = new SecretScrubber([], { enabled: true }, [custom]);
        const result = scrubber.scrub('token=CUSTOM-12345678 end');
        expect(result).not.toContain('CUSTOM-12345678');
        expect(result).toContain('<redacted:custom:');
    });
});

// =============================================================================
// Pipeline integration — 4 points
// =============================================================================

describe('SecretScrubber — Pipeline integration (4 points)', () => {
    const KNOWN_SECRET = 'sk-integrationtest1234567890abc';

    it('all 4 pipeline points: inject known secret → verify redacted at each point', () => {
        const scrubber = makeScrubber([KNOWN_SECRET]);

        // Point 1: tool output
        const toolOutput = `File contents include: ${KNOWN_SECRET}`;
        expect(scrubber.scrub(toolOutput)).not.toContain(KNOWN_SECRET);

        // Point 2: LLM context (assembled message content)
        const llmContext = JSON.stringify({ role: 'tool', content: KNOWN_SECRET });
        expect(scrubber.scrub(llmContext)).not.toContain(KNOWN_SECRET);

        // Point 3: persistence (JSONL line)
        const jsonlLine = `{"recordType":"tool_result","data":"${KNOWN_SECRET}"}`;
        expect(scrubber.scrub(jsonlLine)).not.toContain(KNOWN_SECRET);

        // Point 4: terminal delta text
        const terminalText = `Here is your API key: ${KNOWN_SECRET}`;
        expect(scrubber.scrub(terminalText)).not.toContain(KNOWN_SECRET);
    });

    // --- Point 3: ConversationWriter persistence integration ---

    it('Secret in JSONL write → redacted in persisted file', () => {
        const secret = 'sk-persistencetest123456789012';
        const scrubber = makeScrubber([secret]);

        const tmpDir = mkdtempSync(join(tmpdir(), 'aca-scrub-'));
        try {
            const filePath = join(tmpDir, 'conversation.jsonl');
            const writer = new ConversationWriter(filePath, scrubber);

            const item: ToolResultItem = {
                kind: 'tool_result',
                id: 'itm_01' as ItemId,
                seq: 1,
                toolCallId: 'call_01' as ToolCallId,
                toolName: 'read_file',
                output: {
                    status: 'success',
                    data: `The file contained: ${secret}`,
                    truncated: false,
                    bytesReturned: 100,
                    bytesOmitted: 0,
                    retryable: false,
                    timedOut: false,
                    mutationState: 'none',
                },
                timestamp: new Date().toISOString(),
            };

            writer.writeItem(item);

            const content = readFileSync(filePath, 'utf-8');
            expect(content).not.toContain(secret);
            expect(content).toContain('<redacted:api_key:');
            // Verify the line is still valid JSON
            const parsed = JSON.parse(content.trim());
            expect(parsed.recordType).toBe('tool_result');
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('ConversationWriter without scrubber → secret preserved verbatim', () => {
        const secret = 'sk-noscrubbertest123456789012';

        const tmpDir = mkdtempSync(join(tmpdir(), 'aca-noscrub-'));
        try {
            const filePath = join(tmpDir, 'conversation.jsonl');
            const writer = new ConversationWriter(filePath); // no scrubber

            const item: ToolResultItem = {
                kind: 'tool_result',
                id: 'itm_02' as ItemId,
                seq: 1,
                toolCallId: 'call_02' as ToolCallId,
                toolName: 'read_file',
                output: {
                    status: 'success',
                    data: secret,
                    truncated: false,
                    bytesReturned: secret.length,
                    bytesOmitted: 0,
                    retryable: false,
                    timedOut: false,
                    mutationState: 'none',
                },
                timestamp: new Date().toISOString(),
            };

            writer.writeItem(item);

            const content = readFileSync(filePath, 'utf-8');
            expect(content).toContain(secret);
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // --- Point 2: LLM context integration via TurnEngine ---

    describe('Secret in LLM request → redacted before sending', () => {
        let mockServer: MockNanoGPTServer;
        let tmpDir: string;

        beforeAll(async () => {
            mockServer = new MockNanoGPTServer();
            await mockServer.start();
            tmpDir = mkdtempSync(join(tmpdir(), 'aca-scrub-llm-'));
        });

        afterAll(async () => {
            await mockServer.stop();
            rmSync(tmpDir, { recursive: true, force: true });
        });

        it('known secret in user input → scrubbed before LLM receives it', async () => {
            mockServer.reset();
            mockServer.addTextResponse('Got your message, no secrets visible.');

            const secret = 'sk-llmcontexttest12345678901234';
            const scrubber = makeScrubber([secret]);

            const filePath = join(tmpDir, 'conv-llm.jsonl');
            writeFileSync(filePath, '');
            const writer = new ConversationWriter(filePath);

            const driver = new NanoGptDriver({
                apiKey: 'test-key',
                baseUrl: mockServer.baseUrl,
            });
            const registry = new ToolRegistry();
            const engine = new TurnEngine(
                driver,
                registry,
                writer,
                new SequenceGenerator(),
                scrubber,
            );

            await engine.executeTurn(
                {
                    sessionId: 'ses_testllm' as `ses_${string}`,
                    model: 'gpt-4',
                    provider: 'nanogpt',
                    interactive: false,
                    autoConfirm: true,
                    isSubAgent: false,
                    workspaceRoot: process.cwd(),
                },
                `Here is my API key: ${secret}`,
                [],
            );

            expect(mockServer.receivedRequests).toHaveLength(1);
            const requestBody = JSON.stringify(mockServer.receivedRequests[0].body);
            expect(requestBody).not.toContain(secret);
            expect(requestBody).toContain('<redacted:api_key:');
        }, 10_000);
    });
});

// =============================================================================
// M7.8 — New pattern detection (.env, connection strings, JWTs)
// =============================================================================

describe('SecretScrubber — M7.8 pattern detection', () => {
    it('.env assignment API_KEY=abc123 → redacted as env_secret', () => {
        const scrubber = makeScrubber([]);
        const result = scrubber.scrub('Output: API_KEY=abc123secret end');
        expect(result).not.toContain('abc123secret');
        expect(result).toContain('<redacted:env_secret:');
    });

    it('.env assignment DB_PASSWORD=hunter2 → redacted', () => {
        const scrubber = makeScrubber([]);
        const result = scrubber.scrub('DB_PASSWORD=hunter2 in config');
        expect(result).not.toContain('hunter2');
        expect(result).toContain('<redacted:env_secret:');
    });

    it('.env assignment MY_SECRET_VALUE=xyz → redacted (compound key name)', () => {
        const scrubber = makeScrubber([]);
        const result = scrubber.scrub('export MY_SECRET_VALUE=xyz123');
        expect(result).not.toContain('xyz123');
        expect(result).toContain('<redacted:env_secret:');
    });

    it('.env assignment AUTH_TOKEN=tok_abc → redacted', () => {
        const scrubber = makeScrubber([]);
        const result = scrubber.scrub('AUTH_TOKEN=tok_abc_12345');
        expect(result).not.toContain('tok_abc_12345');
        expect(result).toContain('<redacted:env_secret:');
    });

    it('connection string postgres://user:password@host/db → redacted', () => {
        const scrubber = makeScrubber([]);
        const result = scrubber.scrub('DSN: postgres://admin:s3cret@db.example.com/mydb');
        expect(result).not.toContain('s3cret');
        expect(result).toContain('<redacted:connection_string:');
    });

    it('connection string mysql://... → redacted', () => {
        const scrubber = makeScrubber([]);
        const result = scrubber.scrub('mysql://root:pass123@localhost:3306/app');
        expect(result).not.toContain('pass123');
        expect(result).toContain('<redacted:connection_string:');
    });

    it('connection string mongodb+srv://... → redacted', () => {
        const scrubber = makeScrubber([]);
        const result = scrubber.scrub('mongodb+srv://user:pwd@cluster0.abc.net/test');
        expect(result).not.toContain('pwd');
        expect(result).toContain('<redacted:connection_string:');
    });

    it('connection string in quotes → stops before closing quote', () => {
        const scrubber = makeScrubber([]);
        const result = scrubber.scrub('"postgres://admin:s3cret@db.example.com/mydb"');
        expect(result).not.toContain('s3cret');
        expect(result).toContain('<redacted:connection_string:');
        // Should not consume the trailing quote
        expect(result).toMatch(/"$/);
    });

    it('JWT token eyJ...header.payload.signature → redacted as jwt', () => {
        const scrubber = makeScrubber([]);
        const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
        const result = scrubber.scrub(`Token: ${jwt} end`);
        expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
        expect(result).toContain('<redacted:jwt:');
    });

    it('standalone JWT (Bearer without Authorization header) → still redacted', () => {
        const scrubber = makeScrubber([]);
        const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhY2EifQ.c2lnbmF0dXJlX2hlcmU';
        const result = scrubber.scrub(`bearer ${jwt}`);
        expect(result).not.toContain(jwt);
        expect(result).toContain('<redacted:jwt:');
    });
});

// =============================================================================
// M7.8 — NOT scrubbed (false negatives by design)
// =============================================================================

describe('SecretScrubber — M7.8 non-secrets NOT redacted', () => {
    it('SHA-256 hash → NOT redacted', () => {
        const scrubber = makeScrubber([]);
        const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
        const text = `Hash: ${sha}`;
        expect(scrubber.scrub(text)).toBe(text);
    });

    it('UUID → NOT redacted', () => {
        const scrubber = makeScrubber([]);
        const uuid = '550e8400-e29b-41d4-a716-446655440000';
        const text = `ID: ${uuid}`;
        expect(scrubber.scrub(text)).toBe(text);
    });

    it('hex string without secret label → NOT redacted', () => {
        const scrubber = makeScrubber([]);
        const hex = 'deadbeef1234567890abcdef';
        const text = `commit ${hex}`;
        expect(scrubber.scrub(text)).toBe(text);
    });

    it('base64 non-secret (no eyJ prefix) → NOT redacted', () => {
        const scrubber = makeScrubber([]);
        const b64 = 'SGVsbG8gV29ybGQ=';
        const text = `data: ${b64}`;
        expect(scrubber.scrub(text)).toBe(text);
    });

    it('URL without credentials → NOT redacted', () => {
        const scrubber = makeScrubber([]);
        const text = 'Visit https://example.com/api/v1/users for docs';
        expect(scrubber.scrub(text)).toBe(text);
    });

    it('plain variable assignment without secret keyword → NOT redacted', () => {
        const scrubber = makeScrubber([]);
        const text = 'PORT=3000';
        expect(scrubber.scrub(text)).toBe(text);
    });
});

// =============================================================================
// M7.8 — allowPatterns false-positive recovery
// =============================================================================

describe('SecretScrubber — M7.8 allowPatterns', () => {
    it('allowPatterns exempts matching pattern-detected text', () => {
        const scrubber = new SecretScrubber(
            [],
            { enabled: true, allowPatterns: ['MY_AUTH_TOKEN=safe_value'] },
        );
        const text = 'MY_AUTH_TOKEN=safe_value in config';
        // The env_assignment pattern would match, but allowPatterns exempts it
        expect(scrubber.scrub(text)).toBe(text);
    });

    it('allowPatterns with regex: exempt specific key prefix', () => {
        const scrubber = new SecretScrubber(
            [],
            { enabled: true, allowPatterns: ['TEST_SECRET_KEY'] },
        );
        const text = 'TEST_SECRET_KEY=not-really-secret';
        expect(scrubber.scrub(text)).toBe(text);
    });

    it('allowPatterns does NOT exempt exact-value (Strategy 1) redaction', () => {
        const secret = 'sk-exactvaluetest12345678901234';
        const scrubber = new SecretScrubber(
            [secret],
            { enabled: true, allowPatterns: [secret] },
        );
        // Strategy 1 runs before Strategy 2 and is not affected by allowPatterns
        const result = scrubber.scrub(`key=${secret}`);
        expect(result).not.toContain(secret);
        expect(result).toContain('<redacted:api_key:');
    });

    it('allowPatterns: non-matching allow pattern → still redacted', () => {
        const scrubber = new SecretScrubber(
            [],
            { enabled: true, allowPatterns: ['SOME_OTHER_THING'] },
        );
        const result = scrubber.scrub('DB_PASSWORD=hunter2');
        expect(result).not.toContain('hunter2');
        expect(result).toContain('<redacted:env_secret:');
    });

    it('allowPatterns: invalid regex string → silently ignored', () => {
        const scrubber = new SecretScrubber(
            [],
            { enabled: true, allowPatterns: ['[invalid(regex'] },
        );
        // Should still redact normally despite invalid allowPattern
        const result = scrubber.scrub('API_KEY=secret123');
        expect(result).not.toContain('secret123');
        expect(result).toContain('<redacted:env_secret:');
    });

    it('allowPatterns: nested quantifier pattern rejected (ReDoS guard)', () => {
        const scrubber = new SecretScrubber(
            [],
            { enabled: true, allowPatterns: ['(a+)+$'] },
        );
        // Dangerous pattern should be silently dropped — secret still redacted
        const result = scrubber.scrub('API_KEY=aaaaaaaaaaaaaaab');
        expect(result).not.toContain('aaaaaaaaaaaaaaab');
        expect(result).toContain('<redacted:env_secret:');
    });

    it('allowPatterns: pattern over 200 chars rejected', () => {
        const longPattern = 'a'.repeat(201);
        const scrubber = new SecretScrubber(
            [],
            { enabled: true, allowPatterns: [longPattern] },
        );
        const result = scrubber.scrub('API_KEY=secret123');
        expect(result).not.toContain('secret123');
        expect(result).toContain('<redacted:env_secret:');
    });
});

// =============================================================================
// M7.8 — Combined pipeline: exact-value + pattern detection active simultaneously
// =============================================================================

describe('SecretScrubber — M7.8 combined pipeline', () => {
    it('exact-value secret AND pattern-detected secret both redacted in same text', () => {
        const knownSecret = 'my-exact-known-secret-value-12345';
        const scrubber = makeScrubber([knownSecret]);
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP_mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
        const text = `Known: ${knownSecret} JWT: ${jwt}`;
        const result = scrubber.scrub(text);

        // Strategy 1 catches the known secret
        expect(result).not.toContain(knownSecret);
        expect(result).toContain('<redacted:api_key:');

        // Strategy 2 catches the JWT
        expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
        expect(result).toContain('<redacted:jwt:');
    });

    it('connection string + .env assignment + Bearer token all redacted together', () => {
        const scrubber = makeScrubber([]);
        const text = [
            'DATABASE_URL=postgres://u:p@host/db',
            'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9token',
            'SECRET_KEY=supersecretvalue',
        ].join('\n');
        const result = scrubber.scrub(text);

        expect(result).not.toContain('postgres://u:p@host/db');
        expect(result).not.toContain('supersecretvalue');
        expect(result).toContain('<redacted:env_secret:');
        expect(result).toContain('<redacted:bearer:');
    });
});

// =============================================================================
// Scrubbing disabled → passthrough everywhere
// =============================================================================

describe('SecretScrubber — disabled passthrough', () => {
    it('known secret in text → unchanged when disabled', () => {
        const secret = 'sk-disabledtest1234567890123456';
        const scrubber = new SecretScrubber([secret], { enabled: false });
        const text = `My key is ${secret}`;
        expect(scrubber.scrub(text)).toBe(text);
    });

    it('sk- pattern in text → unchanged when disabled', () => {
        const scrubber = new SecretScrubber([], { enabled: false });
        const text = 'sk-abc123def456ghi789jklmnopqrst';
        expect(scrubber.scrub(text)).toBe(text);
    });

    it('Bearer token in text → unchanged when disabled', () => {
        const scrubber = new SecretScrubber([], { enabled: false });
        const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature';
        expect(scrubber.scrub(text)).toBe(text);
    });
});
