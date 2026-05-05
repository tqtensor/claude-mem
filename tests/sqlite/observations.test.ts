
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  storeObservation,
  getObservationById,
  getRecentObservations,
  getFirstObservationCreatedAt,
} from '../../src/services/sqlite/Observations.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';
import type { DbAdapter } from '../../src/services/database/DbAdapter.js';

describe('Observations Module', () => {
  let claudeMemDb: ClaudeMemDatabase;
  let adapter: DbAdapter;

  beforeEach(() => {
    claudeMemDb = new ClaudeMemDatabase(':memory:');
    adapter = claudeMemDb.adapter;
  });

  afterEach(() => {
    claudeMemDb.db.close();
  });

  function createObservationInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
    return {
      type: 'discovery',
      title: 'Test Observation',
      subtitle: 'Test Subtitle',
      facts: ['fact1', 'fact2'],
      narrative: 'Test narrative content',
      concepts: ['concept1', 'concept2'],
      files_read: ['/path/to/file1.ts'],
      files_modified: ['/path/to/file2.ts'],
      ...overrides,
    };
  }

  async function createSessionWithMemoryId(contentSessionId: string, memorySessionId: string, project: string = 'test-project'): Promise<string> {
    const sessionId = await createSDKSession(adapter, contentSessionId, project, 'initial prompt');
    await updateMemorySessionId(adapter, sessionId, memorySessionId);
    return memorySessionId;
  }

  describe('storeObservation', () => {
    it('should store observation and return id and createdAtEpoch', async () => {
      const memorySessionId = await createSessionWithMemoryId('content-123', 'mem-session-123');
      const project = 'test-project';
      const observation = createObservationInput();

      const result = await storeObservation(adapter, memorySessionId, project, observation);

      expect(typeof result.id).toBe('number');
      expect(result.id).toBeGreaterThan(0);
      expect(typeof result.createdAtEpoch).toBe('number');
      expect(result.createdAtEpoch).toBeGreaterThan(0);
    });

    it('should store all observation fields correctly', async () => {
      const memorySessionId = await createSessionWithMemoryId('content-456', 'mem-session-456');
      const project = 'test-project';
      const observation = createObservationInput({
        type: 'bugfix',
        title: 'Fixed critical bug',
        subtitle: 'Memory leak',
        facts: ['leak found', 'patched'],
        narrative: 'Fixed memory leak in parser',
        concepts: ['memory', 'gc'],
        files_read: ['/src/parser.ts'],
        files_modified: ['/src/parser.ts', '/tests/parser.test.ts'],
      });

      const result = await storeObservation(adapter, memorySessionId, project, observation, 1, 100);

      const stored = await getObservationById(adapter, result.id);
      expect(stored).not.toBeNull();
      expect(stored?.type).toBe('bugfix');
      expect(stored?.title).toBe('Fixed critical bug');
      expect(stored?.memory_session_id).toBe(memorySessionId);
      expect(stored?.project).toBe(project);
    });

    it('should respect overrideTimestampEpoch', async () => {
      const memorySessionId = await createSessionWithMemoryId('content-789', 'mem-session-789');
      const project = 'test-project';
      const observation = createObservationInput();
      const pastTimestamp = 1600000000000;

      const result = await storeObservation(
        adapter,
        memorySessionId,
        project,
        observation,
        1,
        0,
        pastTimestamp
      );

      expect(result.createdAtEpoch).toBe(pastTimestamp);

      const stored = await getObservationById(adapter, result.id);
      expect(stored?.created_at_epoch).toBe(pastTimestamp);
      expect(new Date(stored!.created_at).getTime()).toBe(pastTimestamp);
    });

    it('should use current time when overrideTimestampEpoch not provided', async () => {
      const memorySessionId = await createSessionWithMemoryId('content-now', 'session-now');
      const before = Date.now();
      const result = await storeObservation(
        adapter,
        memorySessionId,
        'project',
        createObservationInput()
      );
      const after = Date.now();

      expect(result.createdAtEpoch).toBeGreaterThanOrEqual(before);
      expect(result.createdAtEpoch).toBeLessThanOrEqual(after);
    });

    it('should handle null subtitle and narrative', async () => {
      const memorySessionId = await createSessionWithMemoryId('content-null', 'session-null');
      const observation = createObservationInput({
        subtitle: null,
        narrative: null,
      });

      const result = await storeObservation(adapter, memorySessionId, 'project', observation);
      const stored = await getObservationById(adapter, result.id);

      expect(stored).not.toBeNull();
      expect(stored?.id).toBe(result.id);
    });
  });

  describe('getObservationById', () => {
    it('should retrieve observation by ID', async () => {
      const memorySessionId = await createSessionWithMemoryId('content-get', 'session-get');
      const observation = createObservationInput({ title: 'Unique Title' });
      const result = await storeObservation(adapter, memorySessionId, 'project', observation);

      const retrieved = await getObservationById(adapter, result.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(result.id);
      expect(retrieved?.title).toBe('Unique Title');
    });

    it('should return null for non-existent observation', async () => {
      const retrieved = await getObservationById(adapter, 99999);

      expect(retrieved).toBeNull();
    });
  });

  describe('getRecentObservations', () => {
    it('should return observations ordered by date DESC', async () => {
      const project = 'test-project';

      const mem1 = await createSessionWithMemoryId('content-1', 'session1', project);
      const mem2 = await createSessionWithMemoryId('content-2', 'session2', project);
      const mem3 = await createSessionWithMemoryId('content-3', 'session3', project);

      await storeObservation(adapter, mem1, project, createObservationInput(), 1, 0, 1000000000000);
      await storeObservation(adapter, mem2, project, createObservationInput(), 2, 0, 2000000000000);
      await storeObservation(adapter, mem3, project, createObservationInput(), 3, 0, 3000000000000);

      const recent = await getRecentObservations(adapter, project, 10);

      expect(recent.length).toBe(3);
      expect(recent[0].prompt_number).toBe(3);
      expect(recent[1].prompt_number).toBe(2);
      expect(recent[2].prompt_number).toBe(1);
    });

    it('should respect limit parameter', async () => {
      const project = 'test-project';

      const mem1 = await createSessionWithMemoryId('content-lim1', 'session-lim1', project);
      const mem2 = await createSessionWithMemoryId('content-lim2', 'session-lim2', project);
      const mem3 = await createSessionWithMemoryId('content-lim3', 'session-lim3', project);

      await storeObservation(adapter, mem1, project, createObservationInput(), 1, 0, 1000000000000);
      await storeObservation(adapter, mem2, project, createObservationInput(), 2, 0, 2000000000000);
      await storeObservation(adapter, mem3, project, createObservationInput(), 3, 0, 3000000000000);

      const recent = await getRecentObservations(adapter, project, 2);

      expect(recent.length).toBe(2);
    });

    it('should filter by project', async () => {
      const memA1 = await createSessionWithMemoryId('content-a1', 'session-a1', 'project-a');
      const memB1 = await createSessionWithMemoryId('content-b1', 'session-b1', 'project-b');
      const memA2 = await createSessionWithMemoryId('content-a2', 'session-a2', 'project-a');

      await storeObservation(adapter, memA1, 'project-a', createObservationInput());
      await storeObservation(adapter, memB1, 'project-b', createObservationInput());
      await storeObservation(adapter, memA2, 'project-a', createObservationInput());

      const recentA = await getRecentObservations(adapter, 'project-a', 10);
      const recentB = await getRecentObservations(adapter, 'project-b', 10);

      expect(recentA.length).toBe(2);
      expect(recentB.length).toBe(1);
    });

    it('should return empty array for project with no observations', async () => {
      const recent = await getRecentObservations(adapter, 'nonexistent-project', 10);

      expect(recent).toEqual([]);
    });
  });

  describe('getFirstObservationCreatedAt', () => {
    it('should return null when there are no observations', async () => {
      const result = await getFirstObservationCreatedAt(adapter);

      expect(result).toBeNull();
    });

    it('should return the earliest observation created_at as ISO string', async () => {
      const project = 'test-project';

      const memEarly = await createSessionWithMemoryId('content-early', 'session-early', project);
      const memMid = await createSessionWithMemoryId('content-mid', 'session-mid', project);
      const memLate = await createSessionWithMemoryId('content-late', 'session-late', project);

      const earliestEpoch = 1000000000000;
      const midEpoch = 2000000000000;
      const latestEpoch = 3000000000000;

      await storeObservation(adapter, memMid, project, createObservationInput(), 2, 0, midEpoch);
      await storeObservation(adapter, memLate, project, createObservationInput(), 3, 0, latestEpoch);
      await storeObservation(adapter, memEarly, project, createObservationInput(), 1, 0, earliestEpoch);

      const result = await getFirstObservationCreatedAt(adapter);

      expect(result).not.toBeNull();
      expect(new Date(result!).getTime()).toBe(earliestEpoch);
    });
  });
});
