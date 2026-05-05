import type { DbAdapter } from '../../database/DbAdapter.js';
import type { SessionSummaryRecord } from '../../../types/database.js';
import type { SessionSummary, GetByIdsOptions } from './types.js';

export async function getSummaryForSession(
  adapter: DbAdapter,
  memorySessionId: string
): Promise<SessionSummary | null> {
  const row = await adapter.get<SessionSummary>(`
    SELECT
      request, investigated, learned, completed, next_steps,
      files_read, files_edited, notes, prompt_number, created_at,
      created_at_epoch
    FROM session_summaries
    WHERE memory_session_id = ?
    ORDER BY created_at_epoch DESC
    LIMIT 1
  `, [memorySessionId]);

  return row ?? null;
}

export async function getSummaryById(
  adapter: DbAdapter,
  id: number
): Promise<SessionSummaryRecord | null> {
  const row = await adapter.get<SessionSummaryRecord>(`
    SELECT * FROM session_summaries WHERE id = ?
  `, [id]);

  return row ?? null;
}

export async function getSummariesByIds(
  adapter: DbAdapter,
  ids: number[],
  options: GetByIdsOptions = {}
): Promise<SessionSummaryRecord[]> {
  if (ids.length === 0) return [];

  const { orderBy = 'date_desc', limit, project } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const placeholders = ids.map(() => '?').join(',');
  const params: (number | string)[] = [...ids];

  const whereClause = project
    ? `WHERE id IN (${placeholders}) AND project = ?`
    : `WHERE id IN (${placeholders})`;
  if (project) params.push(project);

  return await adapter.all<SessionSummaryRecord>(`
    SELECT * FROM session_summaries
    ${whereClause}
    ORDER BY created_at_epoch ${orderClause}
    ${limitClause}
  `, params);
}
