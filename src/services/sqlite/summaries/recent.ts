import type { DbAdapter } from '../../database/DbAdapter.js';
import type { RecentSummary, SummaryWithSessionInfo, FullSummary } from './types.js';

export async function getRecentSummaries(
  adapter: DbAdapter,
  project: string,
  limit: number = 10
): Promise<RecentSummary[]> {
  return await adapter.all<RecentSummary>(`
    SELECT
      request, investigated, learned, completed, next_steps,
      files_read, files_edited, notes, prompt_number, created_at
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `, [project, limit]);
}

export async function getRecentSummariesWithSessionInfo(
  adapter: DbAdapter,
  project: string,
  limit: number = 3
): Promise<SummaryWithSessionInfo[]> {
  return await adapter.all<SummaryWithSessionInfo>(`
    SELECT
      memory_session_id, request, learned, completed, next_steps,
      prompt_number, created_at
    FROM session_summaries
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `, [project, limit]);
}

export async function getAllRecentSummaries(
  adapter: DbAdapter,
  limit: number = 50
): Promise<FullSummary[]> {
  return await adapter.all<FullSummary>(`
    SELECT id, request, investigated, learned, completed, next_steps,
           files_read, files_edited, notes, project, prompt_number,
           created_at, created_at_epoch
    FROM session_summaries
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `, [limit]);
}
