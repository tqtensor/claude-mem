
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  saveUserPrompt,
  getPromptNumberFromUserPrompts,
} from '../../src/services/sqlite/Prompts.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import type { DbAdapter } from '../../src/services/database/DbAdapter.js';

describe('Prompts Module', () => {
  let claudeMemDb: ClaudeMemDatabase;
  let adapter: DbAdapter;

  beforeEach(() => {
    claudeMemDb = new ClaudeMemDatabase(':memory:');
    adapter = claudeMemDb.adapter;
  });

  afterEach(() => {
    claudeMemDb.db.close();
  });

  async function createSession(contentSessionId: string, project: string = 'test-project'): Promise<string> {
    await createSDKSession(adapter, contentSessionId, project, 'initial prompt');
    return contentSessionId;
  }

  describe('saveUserPrompt', () => {
    it('should store prompt and return numeric ID', async () => {
      const contentSessionId = await createSession('content-session-prompt-1');
      const promptNumber = 1;
      const promptText = 'First user prompt';

      const id = await saveUserPrompt(adapter, contentSessionId, promptNumber, promptText);

      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    it('should store multiple prompts with incrementing IDs', async () => {
      const contentSessionId = await createSession('content-session-prompt-2');

      const id1 = await saveUserPrompt(adapter, contentSessionId, 1, 'First prompt');
      const id2 = await saveUserPrompt(adapter, contentSessionId, 2, 'Second prompt');
      const id3 = await saveUserPrompt(adapter, contentSessionId, 3, 'Third prompt');

      expect(id1).toBeGreaterThan(0);
      expect(id2).toBeGreaterThan(id1);
      expect(id3).toBeGreaterThan(id2);
    });

    it('should allow prompts from different sessions', async () => {
      const sessionA = await createSession('session-a');
      const sessionB = await createSession('session-b');

      const id1 = await saveUserPrompt(adapter, sessionA, 1, 'Prompt A1');
      const id2 = await saveUserPrompt(adapter, sessionB, 1, 'Prompt B1');

      expect(id1).not.toBe(id2);
    });
  });

  describe('getPromptNumberFromUserPrompts', () => {
    it('should return 0 when no prompts exist', async () => {
      const count = await getPromptNumberFromUserPrompts(adapter, 'nonexistent-session');

      expect(count).toBe(0);
    });

    it('should return count of prompts for session', async () => {
      const contentSessionId = await createSession('count-test-session');

      expect(await getPromptNumberFromUserPrompts(adapter, contentSessionId)).toBe(0);

      await saveUserPrompt(adapter, contentSessionId, 1, 'First prompt');
      expect(await getPromptNumberFromUserPrompts(adapter, contentSessionId)).toBe(1);

      await saveUserPrompt(adapter, contentSessionId, 2, 'Second prompt');
      expect(await getPromptNumberFromUserPrompts(adapter, contentSessionId)).toBe(2);

      await saveUserPrompt(adapter, contentSessionId, 3, 'Third prompt');
      expect(await getPromptNumberFromUserPrompts(adapter, contentSessionId)).toBe(3);
    });

    it('should maintain session isolation', async () => {
      const sessionA = await createSession('isolation-session-a');
      const sessionB = await createSession('isolation-session-b');

      await saveUserPrompt(adapter, sessionA, 1, 'A1');
      await saveUserPrompt(adapter, sessionA, 2, 'A2');

      await saveUserPrompt(adapter, sessionB, 1, 'B1');

      expect(await getPromptNumberFromUserPrompts(adapter, sessionA)).toBe(2);

      expect(await getPromptNumberFromUserPrompts(adapter, sessionB)).toBe(1);

      await saveUserPrompt(adapter, sessionB, 2, 'B2');
      await saveUserPrompt(adapter, sessionB, 3, 'B3');

      expect(await getPromptNumberFromUserPrompts(adapter, sessionA)).toBe(2);
      expect(await getPromptNumberFromUserPrompts(adapter, sessionB)).toBe(3);
    });

    it('should handle edge case of many prompts', async () => {
      const contentSessionId = await createSession('many-prompts-session');

      for (let i = 1; i <= 100; i++) {
        await saveUserPrompt(adapter, contentSessionId, i, `Prompt ${i}`);
      }

      expect(await getPromptNumberFromUserPrompts(adapter, contentSessionId)).toBe(100);
    });
  });
});
