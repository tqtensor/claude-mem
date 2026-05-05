import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../../../src/services/sqlite/Database.js';
import { storeObservation } from '../../../../src/services/sqlite/Observations.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../../../src/services/sqlite/Sessions.js';
import type { ObservationInput } from '../../../../src/services/sqlite/observations/types.js';
import type { Database } from 'bun:sqlite';
import type { DbAdapter } from '../../../../src/services/database/DbAdapter.js';

describe('storeObservation — subagent labeling', () => {
  let claudeMemDb: ClaudeMemDatabase;
  let db: Database;
  let adapter: DbAdapter;

  beforeEach(() => {
    claudeMemDb = new ClaudeMemDatabase(':memory:');
    db = claudeMemDb.db;
    adapter = claudeMemDb.adapter;
  });

  afterEach(() => {
    db.close();
  });

  function createObservationInput(overrides: Partial<ObservationInput> = {}): ObservationInput {
    return {
      type: 'discovery',
      title: 'Test Observation',
      subtitle: 'Subtitle',
      facts: ['fact1'],
      narrative: 'Narrative body',
      concepts: ['concept1'],
      files_read: ['/path/to/file1.ts'],
      files_modified: [],
      ...overrides,
    };
  }

  async function createSessionWithMemoryId(
    contentSessionId: string,
    memorySessionId: string,
    project = 'test-project'
  ): Promise<string> {
    const sessionId = await createSDKSession(adapter, contentSessionId, project, 'initial prompt');
    await updateMemorySessionId(adapter, sessionId, memorySessionId);
    return memorySessionId;
  }

  it('stores agent_type and agent_id when provided', async () => {
    const memorySessionId = await createSessionWithMemoryId('content-sub-1', 'mem-sub-1');
    const input = createObservationInput({
      agent_type: 'Explore',
      agent_id: 'agent-abc',
    });

    const result = await storeObservation(adapter, memorySessionId, 'test-project', input);

    const row = db
      .prepare('SELECT agent_type, agent_id FROM observations WHERE id = ?')
      .get(result.id) as { agent_type: string | null; agent_id: string | null };

    expect(row).not.toBeNull();
    expect(row.agent_type).toBe('Explore');
    expect(row.agent_id).toBe('agent-abc');
  });

  it('stores NULL for agent_type and agent_id when fields are omitted (main-session row)', async () => {
    const memorySessionId = await createSessionWithMemoryId('content-main-1', 'mem-main-1');
    const input = createObservationInput();

    const result = await storeObservation(adapter, memorySessionId, 'test-project', input);

    const row = db
      .prepare('SELECT agent_type, agent_id FROM observations WHERE id = ?')
      .get(result.id) as { agent_type: string | null; agent_id: string | null };

    expect(row).not.toBeNull();
    expect(row.agent_type).toBeNull();
    expect(row.agent_id).toBeNull();
  });

  it('stores agent_type only when agent_id is absent', async () => {
    const memorySessionId = await createSessionWithMemoryId('content-partial-1', 'mem-partial-1');
    const input = createObservationInput({
      agent_type: 'Plan',
      // agent_id intentionally omitted
    });

    const result = await storeObservation(adapter, memorySessionId, 'test-project', input);

    const row = db
      .prepare('SELECT agent_type, agent_id FROM observations WHERE id = ?')
      .get(result.id) as { agent_type: string | null; agent_id: string | null };

    expect(row.agent_type).toBe('Plan');
    expect(row.agent_id).toBeNull();
  });

  it('dedup is NOT affected by agent fields — second insert with different agent_type returns existing id', async () => {
    const memorySessionId = await createSessionWithMemoryId('content-dedup-1', 'mem-dedup-1');

    const first = await storeObservation(
      adapter,
      memorySessionId,
      'test-project',
      createObservationInput({
        title: 'Identical Title',
        narrative: 'Identical narrative body.',
        agent_type: 'Explore',
        agent_id: 'agent-first',
      })
    );

    const second = await storeObservation(
      adapter,
      memorySessionId,
      'test-project',
      createObservationInput({
        title: 'Identical Title',
        narrative: 'Identical narrative body.',
        agent_type: 'Plan',
        agent_id: 'agent-second',
      })
    );

    expect(second.id).toBe(first.id);

    const rowCount = db
      .prepare('SELECT COUNT(*) as n FROM observations WHERE memory_session_id = ?')
      .get(memorySessionId) as { n: number };
    expect(rowCount.n).toBe(1);

    const row = db
      .prepare('SELECT agent_type, agent_id FROM observations WHERE id = ?')
      .get(first.id) as { agent_type: string | null; agent_id: string | null };
    expect(row.agent_type).toBe('Explore');
    expect(row.agent_id).toBe('agent-first');
  });
});
