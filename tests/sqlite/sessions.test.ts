
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  createSDKSession,
  getSessionById,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import type { DbAdapter } from '../../src/services/database/DbAdapter.js';

describe('Sessions Module', () => {
  let claudeMemDb: ClaudeMemDatabase;
  let adapter: DbAdapter;

  beforeEach(() => {
    claudeMemDb = new ClaudeMemDatabase(':memory:');
    adapter = claudeMemDb.adapter;
  });

  afterEach(() => {
    claudeMemDb.db.close();
  });

  describe('createSDKSession', () => {
    it('should create a new session and return numeric ID', async () => {
      const contentSessionId = 'content-session-123';
      const project = 'test-project';
      const userPrompt = 'Initial user prompt';

      const sessionId = await createSDKSession(adapter, contentSessionId, project, userPrompt);

      expect(typeof sessionId).toBe('number');
      expect(sessionId).toBeGreaterThan(0);
    });

    it('should be idempotent - return same ID for same content_session_id', async () => {
      const contentSessionId = 'content-session-456';
      const project = 'test-project';
      const userPrompt = 'Initial user prompt';

      const sessionId1 = await createSDKSession(adapter, contentSessionId, project, userPrompt);
      const sessionId2 = await createSDKSession(adapter, contentSessionId, project, 'Different prompt');

      expect(sessionId1).toBe(sessionId2);
    });

    it('should create different sessions for different content_session_ids', async () => {
      const sessionId1 = await createSDKSession(adapter, 'session-a', 'project', 'prompt');
      const sessionId2 = await createSDKSession(adapter, 'session-b', 'project', 'prompt');

      expect(sessionId1).not.toBe(sessionId2);
    });
  });

  describe('getSessionById', () => {
    it('should retrieve session by ID', async () => {
      const contentSessionId = 'content-session-get';
      const project = 'test-project';
      const userPrompt = 'Test prompt';

      const sessionId = await createSDKSession(adapter, contentSessionId, project, userPrompt);
      const session = await getSessionById(adapter, sessionId);

      expect(session).not.toBeNull();
      expect(session?.id).toBe(sessionId);
      expect(session?.content_session_id).toBe(contentSessionId);
      expect(session?.project).toBe(project);
      expect(session?.user_prompt).toBe(userPrompt);
      expect(session?.memory_session_id).toBeNull();
    });

    it('should return null for non-existent session', async () => {
      const session = await getSessionById(adapter, 99999);

      expect(session).toBeNull();
    });
  });

  describe('custom_title', () => {
    it('should store custom_title when provided at creation', async () => {
      const sessionId = await createSDKSession(adapter, 'session-title-1', 'project', 'prompt', 'My Agent');
      const session = await getSessionById(adapter, sessionId);

      expect(session?.custom_title).toBe('My Agent');
    });

    it('should default custom_title to null when not provided', async () => {
      const sessionId = await createSDKSession(adapter, 'session-title-2', 'project', 'prompt');
      const session = await getSessionById(adapter, sessionId);

      expect(session?.custom_title).toBeNull();
    });

    it('should backfill custom_title on idempotent call if not already set', async () => {
      const sessionId = await createSDKSession(adapter, 'session-title-3', 'project', 'prompt');
      let session = await getSessionById(adapter, sessionId);
      expect(session?.custom_title).toBeNull();

      await createSDKSession(adapter, 'session-title-3', 'project', 'prompt', 'Backfilled Title');
      session = await getSessionById(adapter, sessionId);
      expect(session?.custom_title).toBe('Backfilled Title');
    });

    it('should not overwrite existing custom_title on idempotent call', async () => {
      const sessionId = await createSDKSession(adapter, 'session-title-4', 'project', 'prompt', 'Original');
      let session = await getSessionById(adapter, sessionId);
      expect(session?.custom_title).toBe('Original');

      await createSDKSession(adapter, 'session-title-4', 'project', 'prompt', 'Attempted Override');
      session = await getSessionById(adapter, sessionId);
      expect(session?.custom_title).toBe('Original');
    });

    it('should handle empty string custom_title as no title', async () => {
      const sessionId = await createSDKSession(adapter, 'session-title-5', 'project', 'prompt', '');
      const session = await getSessionById(adapter, sessionId);

      expect(session?.custom_title).toBeNull();
    });
  });

  describe('platform_source', () => {
    it('should default new sessions to claude when platformSource is omitted', async () => {
      const sessionId = await createSDKSession(adapter, 'session-platform-1', 'project', 'prompt');
      const session = await getSessionById(adapter, sessionId);

      expect(session?.platform_source).toBe('claude');
    });

    it('should preserve a non-default platform_source for legacy callers that omit platformSource', async () => {
      const sessionId = await createSDKSession(adapter, 'session-platform-2', 'project', 'prompt', undefined, 'codex');
      let session = await getSessionById(adapter, sessionId);
      expect(session?.platform_source).toBe('codex');

      await createSDKSession(adapter, 'session-platform-2', 'project', 'prompt');
      session = await getSessionById(adapter, sessionId);
      expect(session?.platform_source).toBe('codex');
    });

    it('should reject explicit platform_source conflicts for the same session', async () => {
      await createSDKSession(adapter, 'session-platform-3', 'project', 'prompt', undefined, 'codex');

      await expect(createSDKSession(
        adapter,
        'session-platform-3',
        'project',
        'prompt',
        undefined,
        'claude'
      )).rejects.toThrow(/Platform source conflict/);
    });
  });

  describe('updateMemorySessionId', () => {
    it('should update memory_session_id for existing session', async () => {
      const contentSessionId = 'content-session-update';
      const project = 'test-project';
      const userPrompt = 'Test prompt';
      const memorySessionId = 'memory-session-abc123';

      const sessionId = await createSDKSession(adapter, contentSessionId, project, userPrompt);

      let session = await getSessionById(adapter, sessionId);
      expect(session?.memory_session_id).toBeNull();

      await updateMemorySessionId(adapter, sessionId, memorySessionId);

      session = await getSessionById(adapter, sessionId);
      expect(session?.memory_session_id).toBe(memorySessionId);
    });

    it('should allow updating to different memory_session_id', async () => {
      const sessionId = await createSDKSession(adapter, 'session-x', 'project', 'prompt');

      await updateMemorySessionId(adapter, sessionId, 'memory-1');
      let session = await getSessionById(adapter, sessionId);
      expect(session?.memory_session_id).toBe('memory-1');

      await updateMemorySessionId(adapter, sessionId, 'memory-2');
      session = await getSessionById(adapter, sessionId);
      expect(session?.memory_session_id).toBe('memory-2');
    });
  });
});
