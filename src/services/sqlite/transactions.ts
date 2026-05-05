
import type { DbAdapter } from '../database/DbAdapter.js';
import type { ObservationInput } from './observations/types.js';
import type { SummaryInput } from './summaries/types.js';
import { computeObservationContentHash } from './observations/store.js';

export interface StoreObservationsResult {
  observationIds: number[];
  summaryId: number | null;
  createdAtEpoch: number;
}

export type StoreAndMarkCompleteResult = StoreObservationsResult;

const OBS_INSERT_SQL = `
  INSERT INTO observations
  (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
   files_read, files_modified, prompt_number, discovery_tokens, agent_type, agent_id, content_hash, created_at, created_at_epoch)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(memory_session_id, content_hash) DO NOTHING
  RETURNING id
`;

const OBS_LOOKUP_SQL = 'SELECT id FROM observations WHERE memory_session_id = ? AND content_hash = ?';

const SUMMARY_INSERT_SQL = `
  INSERT INTO session_summaries
  (memory_session_id, project, request, investigated, learned, completed,
   next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const PENDING_UPDATE_SQL = `
  UPDATE pending_messages
  SET
    status = 'processed',
    completed_at_epoch = ?,
    tool_input = NULL,
    tool_response = NULL
  WHERE id = ? AND status = 'processing'
`;

async function insertObservations(
  adapter: DbAdapter,
  memorySessionId: string,
  project: string,
  observations: ObservationInput[],
  promptNumber: number | undefined,
  discoveryTokens: number,
  timestampIso: string,
  timestampEpoch: number,
): Promise<number[]> {
  const observationIds: number[] = [];
  for (const observation of observations) {
    const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
    const inserted = await adapter.get<{ id: number }>(OBS_INSERT_SQL, [
      memorySessionId,
      project,
      observation.type,
      observation.title,
      observation.subtitle,
      JSON.stringify(observation.facts),
      observation.narrative,
      JSON.stringify(observation.concepts),
      JSON.stringify(observation.files_read),
      JSON.stringify(observation.files_modified),
      promptNumber || null,
      discoveryTokens,
      observation.agent_type ?? null,
      observation.agent_id ?? null,
      contentHash,
      timestampIso,
      timestampEpoch,
    ]);

    if (inserted) {
      observationIds.push(inserted.id);
      continue;
    }

    const existing = await adapter.get<{ id: number }>(OBS_LOOKUP_SQL, [memorySessionId, contentHash]);
    if (!existing) {
      throw new Error(
        `storeObservations: ON CONFLICT without existing row for content_hash=${contentHash}`,
      );
    }
    observationIds.push(existing.id);
  }
  return observationIds;
}

async function insertSummary(
  adapter: DbAdapter,
  memorySessionId: string,
  project: string,
  summary: SummaryInput,
  promptNumber: number | undefined,
  discoveryTokens: number,
  timestampIso: string,
  timestampEpoch: number,
): Promise<number> {
  const result = await adapter.run(SUMMARY_INSERT_SQL, [
    memorySessionId,
    project,
    summary.request,
    summary.investigated,
    summary.learned,
    summary.completed,
    summary.next_steps,
    summary.notes,
    promptNumber || null,
    discoveryTokens,
    timestampIso,
    timestampEpoch,
  ]);
  return Number(result.lastInsertRowid);
}

export async function storeObservationsAndMarkComplete(
  adapter: DbAdapter,
  memorySessionId: string,
  project: string,
  observations: ObservationInput[],
  summary: SummaryInput | null,
  messageId: number,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number,
): Promise<StoreAndMarkCompleteResult> {
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  return adapter.transaction(async () => {
    const observationIds = await insertObservations(
      adapter,
      memorySessionId,
      project,
      observations,
      promptNumber,
      discoveryTokens,
      timestampIso,
      timestampEpoch,
    );

    let summaryId: number | null = null;
    if (summary) {
      summaryId = await insertSummary(
        adapter,
        memorySessionId,
        project,
        summary,
        promptNumber,
        discoveryTokens,
        timestampIso,
        timestampEpoch,
      );
    }

    await adapter.run(PENDING_UPDATE_SQL, [timestampEpoch, messageId]);

    return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
  });
}

export async function storeObservations(
  adapter: DbAdapter,
  memorySessionId: string,
  project: string,
  observations: ObservationInput[],
  summary: SummaryInput | null,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number,
): Promise<StoreObservationsResult> {
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  return adapter.transaction(async () => {
    const observationIds = await insertObservations(
      adapter,
      memorySessionId,
      project,
      observations,
      promptNumber,
      discoveryTokens,
      timestampIso,
      timestampEpoch,
    );

    let summaryId: number | null = null;
    if (summary) {
      summaryId = await insertSummary(
        adapter,
        memorySessionId,
        project,
        summary,
        promptNumber,
        discoveryTokens,
        timestampIso,
        timestampEpoch,
      );
    }

    return { observationIds, summaryId, createdAtEpoch: timestampEpoch };
  });
}
