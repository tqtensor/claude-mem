
import type { DbAdapter } from '../../database/DbAdapter.js';
import { logger } from '../../../utils/logger.js';
import type { RecentObservationRow, AllRecentObservationRow } from './types.js';

export async function getRecentObservations(
  adapter: DbAdapter,
  project: string,
  limit: number = 20
): Promise<RecentObservationRow[]> {
  return await adapter.all<RecentObservationRow>(`
    SELECT type, text, prompt_number, created_at
    FROM observations
    WHERE project = ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `, [project, limit]);
}

export async function getAllRecentObservations(
  adapter: DbAdapter,
  limit: number = 100
): Promise<AllRecentObservationRow[]> {
  return await adapter.all<AllRecentObservationRow>(`
    SELECT id, type, title, subtitle, text, project, prompt_number, created_at, created_at_epoch
    FROM observations
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `, [limit]);
}

export async function getFirstObservationCreatedAt(adapter: DbAdapter): Promise<string | null> {
  const row = await adapter.get<{ created_at: string }>(`
    SELECT created_at
    FROM observations
    ORDER BY created_at_epoch ASC
    LIMIT 1
  `);

  return row ? row.created_at : null;
}
