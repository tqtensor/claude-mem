
import type { DbAdapter } from '../../database/DbAdapter.js';
import type { ObservationRecord, SessionSummaryRecord, UserPromptRecord } from '../../../types/database.js';
import { logger } from '../../../utils/logger.js';
import { OBSERVER_SESSIONS_PROJECT } from '../../../shared/paths.js';

export interface TimelineResult {
  observations: ObservationRecord[];
  sessions: Array<{
    id: number;
    memory_session_id: string;
    project: string;
    request: string | null;
    completed: string | null;
    next_steps: string | null;
    created_at: string;
    created_at_epoch: number;
  }>;
  prompts: Array<{
    id: number;
    content_session_id: string;
    prompt_number: number;
    prompt_text: string;
    project: string | undefined;
    created_at: string;
    created_at_epoch: number;
  }>;
}

export async function getTimelineAroundTimestamp(
  adapter: DbAdapter,
  anchorEpoch: number,
  depthBefore: number = 10,
  depthAfter: number = 10,
  project?: string
): Promise<TimelineResult> {
  return getTimelineAroundObservation(adapter, null, anchorEpoch, depthBefore, depthAfter, project);
}

export async function getTimelineAroundObservation(
  adapter: DbAdapter,
  anchorObservationId: number | null,
  anchorEpoch: number,
  depthBefore: number = 10,
  depthAfter: number = 10,
  project?: string
): Promise<TimelineResult> {
  const projectFilter = project ? 'AND project = ?' : '';
  const projectParams = project ? [project] : [];

  let startEpoch: number;
  let endEpoch: number;

  if (anchorObservationId !== null) {
    const beforeQuery = `
      SELECT id, created_at_epoch
      FROM observations
      WHERE id <= ? ${projectFilter}
      ORDER BY id DESC
      LIMIT ?
    `;
    const afterQuery = `
      SELECT id, created_at_epoch
      FROM observations
      WHERE id >= ? ${projectFilter}
      ORDER BY id ASC
      LIMIT ?
    `;

    try {
      const beforeRecords = await adapter.all<{id: number; created_at_epoch: number}>(beforeQuery, [anchorObservationId, ...projectParams, depthBefore + 1]);
      const afterRecords = await adapter.all<{id: number; created_at_epoch: number}>(afterQuery, [anchorObservationId, ...projectParams, depthAfter + 1]);

      if (beforeRecords.length === 0 && afterRecords.length === 0) {
        return { observations: [], sessions: [], prompts: [] };
      }

      startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
      endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
    } catch (err) {
      const normalizedError = err instanceof Error ? err : new Error(String(err));
      logger.error('DB', 'Error getting boundary observations', { project }, normalizedError);
      return { observations: [], sessions: [], prompts: [] };
    }
  } else {
    const beforeQuery = `
      SELECT created_at_epoch
      FROM observations
      WHERE created_at_epoch <= ? ${projectFilter}
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `;
    const afterQuery = `
      SELECT created_at_epoch
      FROM observations
      WHERE created_at_epoch >= ? ${projectFilter}
      ORDER BY created_at_epoch ASC
      LIMIT ?
    `;

    try {
      const beforeRecords = await adapter.all<{created_at_epoch: number}>(beforeQuery, [anchorEpoch, ...projectParams, depthBefore]);
      const afterRecords = await adapter.all<{created_at_epoch: number}>(afterQuery, [anchorEpoch, ...projectParams, depthAfter + 1]);

      if (beforeRecords.length === 0 && afterRecords.length === 0) {
        return { observations: [], sessions: [], prompts: [] };
      }

      startEpoch = beforeRecords.length > 0 ? beforeRecords[beforeRecords.length - 1].created_at_epoch : anchorEpoch;
      endEpoch = afterRecords.length > 0 ? afterRecords[afterRecords.length - 1].created_at_epoch : anchorEpoch;
    } catch (err) {
      const normalizedError = err instanceof Error ? err : new Error(String(err));
      logger.error('DB', 'Error getting boundary timestamps', { project }, normalizedError);
      return { observations: [], sessions: [], prompts: [] };
    }
  }

  const obsQuery = `
    SELECT *
    FROM observations
    WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
    ORDER BY created_at_epoch ASC
  `;

  const sessQuery = `
    SELECT *
    FROM session_summaries
    WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${projectFilter}
    ORDER BY created_at_epoch ASC
  `;

  const promptQuery = `
    SELECT up.*, s.project, s.memory_session_id
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${projectFilter.replace('project', 's.project')}
    ORDER BY up.created_at_epoch ASC
  `;

  const observations = await adapter.all<ObservationRecord>(obsQuery, [startEpoch, endEpoch, ...projectParams]);
  const sessions = await adapter.all<SessionSummaryRecord>(sessQuery, [startEpoch, endEpoch, ...projectParams]);
  const prompts = await adapter.all<UserPromptRecord>(promptQuery, [startEpoch, endEpoch, ...projectParams]);

  return {
    observations,
    sessions: sessions.map(s => ({
      id: s.id,
      memory_session_id: s.memory_session_id,
      project: s.project,
      request: s.request,
      completed: s.completed,
      next_steps: s.next_steps,
      created_at: s.created_at,
      created_at_epoch: s.created_at_epoch
    })),
    prompts: prompts.map(p => ({
      id: p.id,
      content_session_id: p.content_session_id,
      prompt_number: p.prompt_number,
      prompt_text: p.prompt_text,
      project: p.project,
      created_at: p.created_at,
      created_at_epoch: p.created_at_epoch
    }))
  };
}

export async function getAllProjects(adapter: DbAdapter): Promise<string[]> {
  const rows = await adapter.all<{ project: string }>(`
    SELECT DISTINCT project
    FROM sdk_sessions
    WHERE project IS NOT NULL AND project != ''
      AND project != ?
    ORDER BY project ASC
  `, [OBSERVER_SESSIONS_PROJECT]);

  return rows.map(row => row.project);
}
