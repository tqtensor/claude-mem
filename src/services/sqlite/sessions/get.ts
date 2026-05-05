
import type { DbAdapter } from '../../database/DbAdapter.js';
import type {
  SessionBasic,
  SessionFull,
  SessionWithStatus,
  SessionSummaryDetail,
} from './types.js';

export async function getSessionById(adapter: DbAdapter, id: number): Promise<SessionBasic | null> {
  const row = await adapter.get<SessionBasic>(`
    SELECT id, content_session_id, memory_session_id, project,
           COALESCE(platform_source, 'claude') as platform_source,
           user_prompt, custom_title
    FROM sdk_sessions
    WHERE id = ?
    LIMIT 1
  `, [id]);

  return row ?? null;
}

export async function getSdkSessionsBySessionIds(
  adapter: DbAdapter,
  memorySessionIds: string[]
): Promise<SessionFull[]> {
  if (memorySessionIds.length === 0) return [];

  const placeholders = memorySessionIds.map(() => '?').join(',');
  return await adapter.all<SessionFull>(`
    SELECT id, content_session_id, memory_session_id, project,
           COALESCE(platform_source, 'claude') as platform_source,
           user_prompt, custom_title,
           started_at, started_at_epoch, completed_at, completed_at_epoch, status
    FROM sdk_sessions
    WHERE memory_session_id IN (${placeholders})
    ORDER BY started_at_epoch DESC
  `, [...memorySessionIds]);
}

export async function getRecentSessionsWithStatus(
  adapter: DbAdapter,
  project: string,
  limit: number = 3
): Promise<SessionWithStatus[]> {
  return await adapter.all<SessionWithStatus>(`
    SELECT * FROM (
      SELECT
        s.memory_session_id,
        s.status,
        s.started_at,
        s.started_at_epoch,
        s.user_prompt,
        CASE WHEN sum.memory_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
      FROM sdk_sessions s
      LEFT JOIN session_summaries sum ON s.memory_session_id = sum.memory_session_id
      WHERE s.project = ? AND s.memory_session_id IS NOT NULL
      GROUP BY s.memory_session_id
      ORDER BY s.started_at_epoch DESC
      LIMIT ?
    )
    ORDER BY started_at_epoch ASC
  `, [project, limit]);
}

export async function getSessionSummaryById(
  adapter: DbAdapter,
  id: number
): Promise<SessionSummaryDetail | null> {
  const row = await adapter.get<SessionSummaryDetail>(`
    SELECT
      id,
      memory_session_id,
      content_session_id,
      project,
      user_prompt,
      request_summary,
      learned_summary,
      status,
      created_at,
      created_at_epoch
    FROM sdk_sessions
    WHERE id = ?
    LIMIT 1
  `, [id]);

  return row ?? null;
}
