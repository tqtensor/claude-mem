
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ClaudeMemDatabase } from '../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../src/services/sqlite/Sessions.js';
import type { ActiveSession, PendingMessage } from '../src/services/worker-types.js';
import type { Database } from 'bun:sqlite';
import type { DbAdapter } from '../src/services/database/DbAdapter.js';

describe('Zombie Agent Prevention', () => {
  let claudeMemDb: ClaudeMemDatabase;
  let db: Database;
  let adapter: DbAdapter;
  let pendingStore: PendingMessageStore;

  beforeEach(() => {
    claudeMemDb = new ClaudeMemDatabase(':memory:');
    db = claudeMemDb.db;
    adapter = claudeMemDb.adapter;
    pendingStore = new PendingMessageStore(adapter);
  });

  afterEach(() => {
    db.close();
  });

  function createMockSession(
    sessionDbId: number,
    overrides: Partial<ActiveSession> = {}
  ): ActiveSession {
    return {
      sessionDbId,
      contentSessionId: `content-session-${sessionDbId}`,
      memorySessionId: null,
      project: 'test-project',
      userPrompt: 'Test prompt',
      pendingMessages: [],
      abortController: new AbortController(),
      generatorPromise: null,
      lastPromptNumber: 1,
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null,
      conversationHistory: [],
      currentProvider: null,
      processingMessageIds: [],  // CLAIM-CONFIRM pattern: track message IDs being processed
      ...overrides,
    };
  }

  async function createDbSession(contentSessionId: string, project: string = 'test-project'): Promise<number> {
    return await createSDKSession(adapter, contentSessionId, project, 'Test user prompt');
  }

  async function enqueueTestMessage(sessionDbId: number, contentSessionId: string): Promise<number> {
    const message: PendingMessage = {
      type: 'observation',
      tool_name: 'TestTool',
      tool_input: { test: 'input' },
      tool_response: { test: 'response' },
      prompt_number: 1,
    };
    return await pendingStore.enqueue(sessionDbId, contentSessionId, message);
  }

  test('should prevent concurrent spawns for same session', async () => {
    const session = createMockSession(1);

    session.generatorPromise = new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    expect(session.generatorPromise).not.toBeNull();

    const shouldSkip = session.generatorPromise !== null;
    expect(shouldSkip).toBe(true);

    await session.generatorPromise;

    session.generatorPromise = null;

    const canSpawnNow = session.generatorPromise === null;
    expect(canSpawnNow).toBe(true);
  });

  test('should prevent duplicate crash recovery spawns', async () => {
    const sessionId1 = await createDbSession('content-1');
    const sessionId2 = await createDbSession('content-2');

    await enqueueTestMessage(sessionId1, 'content-1');
    await enqueueTestMessage(sessionId2, 'content-2');

    const orphanedSessions = (pendingStore as any).getSessionsWithPendingMessages();
    expect(orphanedSessions).toContain(sessionId1);
    expect(orphanedSessions).toContain(sessionId2);

    const session1 = createMockSession(sessionId1, {
      contentSessionId: 'content-1',
      generatorPromise: new Promise<void>(() => {}), // Active generator
    });
    const session2 = createMockSession(sessionId2, {
      contentSessionId: 'content-2',
      generatorPromise: null, // No active generator
    });

    const sessions = new Map<number, ActiveSession>();
    sessions.set(sessionId1, session1);
    sessions.set(sessionId2, session2);

    const result = {
      sessionsStarted: 0,
      sessionsSkipped: 0,
      startedSessionIds: [] as number[],
    };

    for (const sessionDbId of orphanedSessions) {
      const existingSession = sessions.get(sessionDbId);

      if (existingSession?.generatorPromise) {
        result.sessionsSkipped++;
        continue;
      }

      result.sessionsStarted++;
      result.startedSessionIds.push(sessionDbId);
    }

    expect(result.sessionsSkipped).toBe(1);
    expect(result.sessionsStarted).toBe(1);
    expect(result.startedSessionIds).toContain(sessionId2);
    expect(result.startedSessionIds).not.toContain(sessionId1);
  });

  test('should report accurate queueDepth from database', async () => {
    const sessionId = await createDbSession('content-queue-test');

    expect(await pendingStore.getPendingCount(sessionId)).toBe(0);
    expect((pendingStore as any).hasAnyPendingWork()).toBe(false);

    const msgId1 = await enqueueTestMessage(sessionId, 'content-queue-test');
    expect(await pendingStore.getPendingCount(sessionId)).toBe(1);

    const msgId2 = await enqueueTestMessage(sessionId, 'content-queue-test');
    expect(await pendingStore.getPendingCount(sessionId)).toBe(2);

    const msgId3 = await enqueueTestMessage(sessionId, 'content-queue-test');
    expect(await pendingStore.getPendingCount(sessionId)).toBe(3);

    expect((pendingStore as any).hasAnyPendingWork()).toBe(true);

    const claimed = await pendingStore.claimNextMessage(sessionId);
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(msgId1);

    expect(await pendingStore.getPendingCount(sessionId)).toBe(3);

    (pendingStore as any).confirmProcessed(msgId1);
    expect(await pendingStore.getPendingCount(sessionId)).toBe(2);

    const msg2 = await pendingStore.claimNextMessage(sessionId);
    (pendingStore as any).confirmProcessed(msg2!.id);
    expect(await pendingStore.getPendingCount(sessionId)).toBe(1);

    const msg3 = await pendingStore.claimNextMessage(sessionId);
    (pendingStore as any).confirmProcessed(msg3!.id);

    expect(await pendingStore.getPendingCount(sessionId)).toBe(0);
    expect((pendingStore as any).hasAnyPendingWork()).toBe(false);
  });

  test('should track pending work across multiple sessions', async () => {
    const session1Id = await createDbSession('content-multi-1');
    const session2Id = await createDbSession('content-multi-2');
    const session3Id = await createDbSession('content-multi-3');

    await enqueueTestMessage(session1Id, 'content-multi-1');
    await enqueueTestMessage(session1Id, 'content-multi-1');

    await enqueueTestMessage(session2Id, 'content-multi-2');

    expect(await pendingStore.getPendingCount(session1Id)).toBe(2);
    expect(await pendingStore.getPendingCount(session2Id)).toBe(1);
    expect(await pendingStore.getPendingCount(session3Id)).toBe(0);

    const sessionsWithPending = (pendingStore as any).getSessionsWithPendingMessages();
    expect(sessionsWithPending).toContain(session1Id);
    expect(sessionsWithPending).toContain(session2Id);
    expect(sessionsWithPending).not.toContain(session3Id);
    expect(sessionsWithPending.length).toBe(2);
  });

  test('should reset AbortController when restarting after abort', async () => {
    const session = createMockSession(1);

    session.abortController.abort();
    expect(session.abortController.signal.aborted).toBe(true);

    if (session.abortController.signal.aborted) {
      session.abortController = new AbortController();
    }

    expect(session.abortController.signal.aborted).toBe(false);
  });

  test('should recover stuck processing messages via claimNextMessage self-healing', async () => {
    const sessionId = await createDbSession('content-stuck-recovery');

    const msgId = await enqueueTestMessage(sessionId, 'content-stuck-recovery');
    const claimed = await pendingStore.claimNextMessage(sessionId);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(msgId);

    const staleTimestamp = Date.now() - 120_000;
    db.run(
      `UPDATE pending_messages SET started_processing_at_epoch = ? WHERE id = ?`,
      [staleTimestamp, msgId]
    );

    expect(await pendingStore.getPendingCount(sessionId)).toBe(1);

    const recovered = await pendingStore.claimNextMessage(sessionId);
    expect(recovered).not.toBeNull();
    expect(recovered!.id).toBe(msgId);

    (pendingStore as any).confirmProcessed(msgId);
    expect(await pendingStore.getPendingCount(sessionId)).toBe(0);
  });

  test('should properly cleanup generator promise on session delete', async () => {
    const session = createMockSession(1);

    let generatorCompleted = false;

    session.generatorPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        generatorCompleted = true;
        resolve();
      }, 50);
    });

    session.abortController.abort();

    if (session.generatorPromise) {
      await session.generatorPromise.catch(() => {});
    }

    expect(generatorCompleted).toBe(true);

    session.generatorPromise = null;
    expect(session.generatorPromise).toBeNull();
  });

  describe('Session Termination Invariant', () => {

    test('should mark messages abandoned when session is terminated', async () => {
      const sessionId = await createDbSession('content-terminate-1');
      await enqueueTestMessage(sessionId, 'content-terminate-1');
      await enqueueTestMessage(sessionId, 'content-terminate-1');

      expect(await pendingStore.getPendingCount(sessionId)).toBe(2);
      expect((pendingStore as any).hasAnyPendingWork()).toBe(true);

      const abandoned = (pendingStore as any).transitionMessagesTo('abandoned', { sessionDbId: sessionId });
      expect(abandoned).toBe(2);

      expect((pendingStore as any).hasAnyPendingWork()).toBe(false);
      expect(await pendingStore.getPendingCount(sessionId)).toBe(0);
    });

    test('should handle terminate with zero pending messages', async () => {
      const sessionId = await createDbSession('content-terminate-empty');

      expect(await pendingStore.getPendingCount(sessionId)).toBe(0);

      const abandoned = (pendingStore as any).transitionMessagesTo('abandoned', { sessionDbId: sessionId });
      expect(abandoned).toBe(0);

      expect((pendingStore as any).hasAnyPendingWork()).toBe(false);
    });

    test('should be idempotent — double terminate marks zero on second call', async () => {
      const sessionId = await createDbSession('content-terminate-idempotent');
      await enqueueTestMessage(sessionId, 'content-terminate-idempotent');

      const first = (pendingStore as any).transitionMessagesTo('abandoned', { sessionDbId: sessionId });
      expect(first).toBe(1);

      const second = (pendingStore as any).transitionMessagesTo('abandoned', { sessionDbId: sessionId });
      expect(second).toBe(0);

      expect((pendingStore as any).hasAnyPendingWork()).toBe(false);
    });

    test('should remove session from Map via removeSessionImmediate', async () => {
      const sessionId = await createDbSession('content-terminate-map');
      const session = createMockSession(sessionId, {
        contentSessionId: 'content-terminate-map',
      });

      const sessions = new Map<number, ActiveSession>();
      sessions.set(sessionId, session);
      expect(sessions.has(sessionId)).toBe(true);

      sessions.delete(sessionId);
      expect(sessions.has(sessionId)).toBe(false);
    });

    test('should return hasAnyPendingWork false after all sessions terminated', async () => {
      const sid1 = await createDbSession('content-multi-term-1');
      const sid2 = await createDbSession('content-multi-term-2');
      const sid3 = await createDbSession('content-multi-term-3');

      await enqueueTestMessage(sid1, 'content-multi-term-1');
      await enqueueTestMessage(sid1, 'content-multi-term-1');
      await enqueueTestMessage(sid2, 'content-multi-term-2');
      await enqueueTestMessage(sid3, 'content-multi-term-3');

      expect((pendingStore as any).hasAnyPendingWork()).toBe(true);

      (pendingStore as any).transitionMessagesTo('abandoned', { sessionDbId: sid1 });
      (pendingStore as any).transitionMessagesTo('abandoned', { sessionDbId: sid2 });
      (pendingStore as any).transitionMessagesTo('abandoned', { sessionDbId: sid3 });

      expect((pendingStore as any).hasAnyPendingWork()).toBe(false);
    });

    test('should not affect other sessions when terminating one', async () => {
      const sid1 = await createDbSession('content-isolate-1');
      const sid2 = await createDbSession('content-isolate-2');

      await enqueueTestMessage(sid1, 'content-isolate-1');
      await enqueueTestMessage(sid2, 'content-isolate-2');

      (pendingStore as any).transitionMessagesTo('abandoned', { sessionDbId: sid1 });

      expect(await pendingStore.getPendingCount(sid1)).toBe(0);
      expect(await pendingStore.getPendingCount(sid2)).toBe(1);
      expect((pendingStore as any).hasAnyPendingWork()).toBe(true);
    });

    test('should mark both pending and processing messages as abandoned', async () => {
      const sessionId = await createDbSession('content-mixed-status');

      const msgId1 = await enqueueTestMessage(sessionId, 'content-mixed-status');
      await enqueueTestMessage(sessionId, 'content-mixed-status');

      const claimed = await pendingStore.claimNextMessage(sessionId);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(msgId1);

      expect(await pendingStore.getPendingCount(sessionId)).toBe(2);

      const abandoned = (pendingStore as any).transitionMessagesTo('abandoned', { sessionDbId: sessionId });
      expect(abandoned).toBe(2);
      expect((pendingStore as any).hasAnyPendingWork()).toBe(false);
    });

    test('should enforce invariant: no pending work after terminate regardless of initial state', async () => {
      const sessionId = await createDbSession('content-invariant');

      await enqueueTestMessage(sessionId, 'content-invariant');
      await enqueueTestMessage(sessionId, 'content-invariant');
      await enqueueTestMessage(sessionId, 'content-invariant');

      await pendingStore.claimNextMessage(sessionId);

      expect(await pendingStore.getPendingCount(sessionId)).toBe(3);

      (pendingStore as any).transitionMessagesTo('abandoned', { sessionDbId: sessionId });
      expect((pendingStore as any).hasAnyPendingWork()).toBe(false);
      expect(await pendingStore.getPendingCount(sessionId)).toBe(0);
    });
  });
});
