
import type { DbAdapter } from '../../database/DbAdapter.js';
import type { UserPromptRecord, LatestPromptResult } from '../../../types/database.js';
import type { RecentUserPromptResult, PromptWithProject, GetPromptsByIdsOptions } from './types.js';

export async function getUserPrompt(
  adapter: DbAdapter,
  contentSessionId: string,
  promptNumber: number
): Promise<string | null> {
  const result = await adapter.get<{ prompt_text: string }>(`
    SELECT prompt_text
    FROM user_prompts
    WHERE content_session_id = ? AND prompt_number = ?
    LIMIT 1
  `, [contentSessionId, promptNumber]);

  return result?.prompt_text ?? null;
}

export async function getPromptNumberFromUserPrompts(adapter: DbAdapter, contentSessionId: string): Promise<number> {
  const result = await adapter.get<{ count: number }>(`
    SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
  `, [contentSessionId]);
  return result!.count;
}

export async function getLatestUserPrompt(
  adapter: DbAdapter,
  contentSessionId: string
): Promise<LatestPromptResult | undefined> {
  return await adapter.get<LatestPromptResult>(`
    SELECT
      up.*,
      s.memory_session_id,
      s.project
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.content_session_id = ?
    ORDER BY up.created_at_epoch DESC
    LIMIT 1
  `, [contentSessionId]);
}

export async function getAllRecentUserPrompts(
  adapter: DbAdapter,
  limit: number = 100
): Promise<RecentUserPromptResult[]> {
  return await adapter.all<RecentUserPromptResult>(`
    SELECT
      up.id,
      up.content_session_id,
      s.project,
      up.prompt_number,
      up.prompt_text,
      up.created_at,
      up.created_at_epoch
    FROM user_prompts up
    LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    ORDER BY up.created_at_epoch DESC
    LIMIT ?
  `, [limit]);
}

export async function getPromptById(adapter: DbAdapter, id: number): Promise<PromptWithProject | null> {
  const row = await adapter.get<PromptWithProject>(`
    SELECT
      p.id,
      p.content_session_id,
      p.prompt_number,
      p.prompt_text,
      s.project,
      p.created_at,
      p.created_at_epoch
    FROM user_prompts p
    LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
    WHERE p.id = ?
    LIMIT 1
  `, [id]);

  return row ?? null;
}

export async function getPromptsByIds(adapter: DbAdapter, ids: number[]): Promise<PromptWithProject[]> {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  return await adapter.all<PromptWithProject>(`
    SELECT
      p.id,
      p.content_session_id,
      p.prompt_number,
      p.prompt_text,
      s.project,
      p.created_at,
      p.created_at_epoch
    FROM user_prompts p
    LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
    WHERE p.id IN (${placeholders})
    ORDER BY p.created_at_epoch DESC
  `, ids);
}

export async function getUserPromptsByIds(
  adapter: DbAdapter,
  ids: number[],
  options: GetPromptsByIdsOptions = {}
): Promise<UserPromptRecord[]> {
  if (ids.length === 0) return [];

  const { orderBy = 'date_desc', limit, project } = options;
  const orderClause = orderBy === 'date_asc' ? 'ASC' : 'DESC';
  const limitClause = limit ? `LIMIT ${limit}` : '';
  const placeholders = ids.map(() => '?').join(',');
  const params: (number | string)[] = [...ids];

  const projectFilter = project ? 'AND s.project = ?' : '';
  if (project) params.push(project);

  return await adapter.all<UserPromptRecord>(`
    SELECT
      up.*,
      s.project,
      s.memory_session_id
    FROM user_prompts up
    JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
    WHERE up.id IN (${placeholders}) ${projectFilter}
    ORDER BY up.created_at_epoch ${orderClause}
    ${limitClause}
  `, params);
}
