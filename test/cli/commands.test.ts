import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSlashCommand, type SlashCommandContext } from '../../src/cli/commands.js';
import type { SessionProjection } from '../../src/core/session-manager.js';

// Mock data for testing
const mockProjection: SessionProjection = {
  manifest: {
    sessionId: 'test-session-id',
    workspaceId: 'test-workspace-id',
    status: 'active',
    lastActivityTimestamp: '2023-01-01T00:00:00.000Z',
  },
  sessionDir: '/tmp/test-session',
} as unknown as SessionProjection;

const mockContext: SlashCommandContext = {
  projection: mockProjection,
  model: 'test-model',
  turnCount: 5,
  totalInputTokens: 1000,
  totalOutputTokens: 500,
  exit: vi.fn(),
  costTracker: undefined,
  indexer: undefined,
  checkpointManager: undefined,
  promptUser: undefined,
} as unknown as SlashCommandContext;

describe('slash commands', () => {
  describe('/version', () => {
    it('should return version information', async () => {
      const result = handleSlashCommand('/version', mockContext);
      if (result) {
        if ('then' in result) {
          // Handle promise result
          const resolved = await result;
          expect(resolved.output).toContain('aca v');
          expect(resolved.shouldExit).toBe(false);
        } else {
          // Handle synchronous result
          expect(result.output).toContain('aca v');
          expect(result.shouldExit).toBe(false);
        }
      }
    });
  });

  describe('/session', () => {
    it('should return session information', async () => {
      const result = handleSlashCommand('/session', mockContext);
      if (result) {
        if ('then' in result) {
          // Handle promise result
          const resolved = await result;
          expect(resolved.output).toContain('Session:');
          expect(resolved.output).toContain('Workspace:');
          expect(resolved.output).toContain('Directory:');
          expect(resolved.output).toContain('Status:');
          expect(resolved.output).toContain('Last active:');
          expect(resolved.shouldExit).toBe(false);
        } else {
          // Handle synchronous result
          expect(result.output).toContain('Session:');
          expect(result.output).toContain('Workspace:');
          expect(result.output).toContain('Directory:');
          expect(result.output).toContain('Status:');
          expect(result.output).toContain('Last active:');
          expect(result.shouldExit).toBe(false);
        }
      }
    });
  });

  describe('/model', () => {
    it('should return the current model name', async () => {
      const result = handleSlashCommand('/model', mockContext);
      if (result) {
        if ('then' in result) {
          const resolved = await result;
          expect(resolved.output).toBe('Model: test-model');
          expect(resolved.shouldExit).toBe(false);
        } else {
          expect(result.output).toBe('Model: test-model');
          expect(result.shouldExit).toBe(false);
        }
      }
    });
  });
});
